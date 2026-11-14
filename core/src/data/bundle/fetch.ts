/**
 * Pull a stored bundle from ANOTHER node through the hub machine-proxy (spec: POST
 * /data/bundles/fetch). The peer serves `GET /data/bundles/:id/chunk?offset=&length=` in the
 * standard envelope `{success, data:{offset,length,total,dataB64,done}}`; each chunk is at
 * most 512 KiB so every hop stays under the relay limits.
 *
 * Chunks are written to a tmp file inside the store directory (the store's sweeper removes a
 * crashed fetch's leftovers), then handed to BundleStore.importFile, which VERIFIES the whole
 * bundle (manifest, end hash, section hashes) before storing it under a NEW bundleId with an
 * `importedFrom` sidecar. A corrupt or truncated transfer therefore stores nothing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BundleError, isBundleId, MAX_UNCOMPRESSED_BYTES } from './format';
import { getBundleStore, MAX_CHUNK_BYTES, type BundleStore, type StoredImportResult } from './store';
import { BundleServiceError } from './service';

/** How a chunk request reaches the peer. Default: the hub machine-proxy GET. */
export interface FetchTransport {
  get(node: string, urlPath: string): Promise<unknown>;
}

export interface FetchResult extends StoredImportResult {
  fromNode: string;
  /** The bundleId the peer stored it under (the one requested). */
  sourceBundleId: string;
  chunks: number;
  /** True when this bundle had already been fetched from that node — nothing was re-fetched. */
  reused?: boolean;
}

/** Node ids are hub gatewayIds (or machine ids); nothing path-like reaches the proxy URL. */
const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function defaultTransport(): FetchTransport {
  return {
    get: async (node, urlPath) => {
      const { proxyGet } = require('../../hub-client/hub-proxy') as typeof import('../../hub-client/hub-proxy');
      return proxyGet(node, urlPath);
    },
  };
}

/** The remote's coded refusal, when a thrown proxy error carried its JSON body. */
function remoteCode(message: string): string | null {
  const m = /"code"\s*:\s*"([A-Z][A-Z0-9_]{2,63})"/.exec(message);
  return m ? m[1] : null;
}

interface Chunk { offset: number; length: number; total: number; dataB64: string; done: boolean }

function unwrapChunk(raw: unknown, node: string): Chunk {
  const env = raw as { success?: unknown; data?: unknown; error?: unknown } | null;
  if (env && typeof env === 'object' && env.success === false) {
    const err = env.error as { code?: unknown; message?: unknown } | string | undefined;
    const code = typeof err === 'object' && err && typeof err.code === 'string' ? err.code : 'FETCH_FAILED';
    const msg = typeof err === 'string' ? err : typeof err === 'object' && err && typeof err.message === 'string' ? err.message : 'refused';
    throw new BundleServiceError(code, `${node} refused the chunk: ${msg}`);
  }
  const d = (env && typeof env === 'object' && 'data' in env ? env.data : raw) as Partial<Chunk> | null;
  if (!d || typeof d !== 'object'
    || !Number.isInteger(d.offset) || !Number.isInteger(d.length) || !Number.isInteger(d.total)
    || typeof d.dataB64 !== 'string' || typeof d.done !== 'boolean') {
    throw new BundleServiceError('FETCH_FAILED', `${node} answered a chunk request with something that is not a chunk`);
  }
  return d as Chunk;
}

/**
 * Fetch `bundleId` from `fromNode`, verify it, and store it locally. Throws BUNDLE_ID_INVALID,
 * BAD_REQUEST, DISK_LOW, FETCH_FAILED (or the peer's own code, e.g. BUNDLE_NOT_FOUND),
 * BUNDLE_CORRUPT / BUNDLE_FORMAT from verification. Nothing is stored on any failure.
 */
export async function fetchFromPeer(
  fromNode: string,
  bundleId: string,
  deps: { store?: BundleStore; transport?: FetchTransport; chunkBytes?: number } = {},
): Promise<FetchResult> {
  if (typeof fromNode !== 'string' || !NODE_ID_RE.test(fromNode)) {
    throw new BundleServiceError('BAD_REQUEST', `fromNode must be a node id (got ${JSON.stringify(fromNode)})`);
  }
  if (!isBundleId(bundleId)) {
    throw new BundleError('BUNDLE_ID_INVALID', `invalid bundle id ${JSON.stringify(bundleId)} — expected lmb-<yyyymmdd>-<hhmmss>-<6 hex>`);
  }
  const store = deps.store ?? getBundleStore();
  const transport = deps.transport ?? defaultTransport();
  const chunkBytes = Math.min(MAX_CHUNK_BYTES, Math.max(1, deps.chunkBytes ?? MAX_CHUNK_BYTES));

  // Idempotent: a caller whose first reply was cut off by the relay's 25 s cap (the fetch
  // itself kept going and stored the bundle) retries — it gets THAT copy back instead of a
  // duplicate that retention then counts against the node's real restore points.
  const prior = store.findFetched(fromNode, bundleId);
  if (prior) {
    const manifest = await store.getManifest(prior.bundleId);
    return { ...prior, manifest, fromNode, sourceBundleId: bundleId, chunks: 0, reused: true };
  }

  const tmp = path.join(store.dir(), `.fetch-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    let offset = 0;
    let total: number | null = null;
    let chunks = 0;
    for (;;) {
      const urlPath = `/data/bundles/${bundleId}/chunk?offset=${offset}&length=${chunkBytes}`;
      let raw: unknown;
      try {
        raw = await transport.get(fromNode, urlPath);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        throw new BundleServiceError(remoteCode(msg) ?? 'FETCH_FAILED', `fetching ${bundleId} from ${fromNode} failed at offset ${offset}: ${msg}`);
      }
      const c = unwrapChunk(raw, fromNode);
      const buf = Buffer.from(c.dataB64, 'base64');
      if (c.offset !== offset || buf.length !== c.length || c.length > chunkBytes) {
        throw new BundleServiceError('FETCH_FAILED', `${fromNode} returned a malformed chunk at offset ${offset} (offset ${c.offset}, length ${c.length}, decoded ${buf.length})`);
      }
      if (total === null) {
        if (c.total < 0 || c.total > MAX_UNCOMPRESSED_BYTES) {
          throw new BundleError('BUNDLE_TOO_LARGE', `the bundle on ${fromNode} is ${c.total} bytes; the cap is ${MAX_UNCOMPRESSED_BYTES}`);
        }
        total = c.total;
        store.assertDiskSpace(total, 'import');
        fd = fs.openSync(tmp, 'w', 0o600);
      } else if (c.total !== total) {
        throw new BundleServiceError('FETCH_FAILED', `the bundle on ${fromNode} changed size mid-fetch (${total} → ${c.total})`);
      }
      if (buf.length) fs.writeSync(fd!, buf);
      offset += buf.length;
      chunks++;
      if (c.done || offset >= total) break;
      if (buf.length === 0) throw new BundleServiceError('FETCH_FAILED', `${fromNode} returned an empty chunk before the end (offset ${offset} of ${total})`);
    }
    if (offset !== total) {
      throw new BundleServiceError('FETCH_FAILED', `${fromNode} ended the transfer at ${offset} of ${total} bytes`);
    }
    fs.closeSync(fd!);
    fd = null;
    const stored = await store.importFile(tmp, { via: 'fetch', fromNode, sourceBundleId: bundleId });
    return { ...stored, fromNode, sourceBundleId: bundleId, chunks };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
  }
}
