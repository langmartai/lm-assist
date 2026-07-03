/**
 * T4 remainder — RPC response auto-offload. When a route's response exceeds the
 * bulk threshold (8MB, the file-transfer RESUME_MIN_BYTES) the responder writes
 * it to an outbox, PUSHes it to the requester via the EXISTING durable job
 * manager (enqueueJob/waitForJob — NOT reimplemented here), and replies with a
 * small BulkHandle. Because the responder awaits delivery before replying, the
 * requester can read the landed file straight from its receive root and verify
 * size + sha256. Mixed-version safe: only used when both peers speak the fabric
 * RPC class; a legacy peer never reaches this path.
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import {
  RESUME_MIN_BYTES, enqueueJob, waitForJob, receiveRoot, safeJoin,
} from '../file-transfer';

export interface BulkHandle { transferId: string; size: number; sha256: string; sink: string; }

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest('hex');
}

export function shouldOffloadToBulk(len: number, threshold: number = RESUME_MIN_BYTES): boolean {
  return len > threshold;
}

export async function offloadResponse(
  bytes: Uint8Array,
  peerNode: string,
  deps: {
    enqueueJob: typeof enqueueJob;
    waitForJob: typeof waitForJob;
    writeOutbox: (transferId: string, bytes: Uint8Array) => Promise<string>;
    timeoutMs?: number;
    genId?: () => string;
  },
): Promise<BulkHandle> {
  const transferId = (deps.genId ?? crypto.randomUUID)();
  const sink = `fabric-bulk/${transferId}.bin`;
  const path = await deps.writeOutbox(transferId, bytes);
  const jobId = deps.enqueueJob({
    peer: peerNode,
    source: { kind: 'file', path },
    sink: { kind: 'file', path: sink },
    size: bytes.length,
  });
  await deps.waitForJob(jobId, deps.timeoutMs ?? 120_000);
  return { transferId, size: bytes.length, sha256: sha256Hex(bytes), sink };
}

export async function fetchBulk(
  handle: BulkHandle,
  deps: { readSink: (sink: string) => Promise<Uint8Array> },
): Promise<Uint8Array> {
  const bytes = await deps.readSink(handle.sink);
  if (bytes.length !== handle.size) throw new Error(`fabric bulk: size ${bytes.length} != ${handle.size}`);
  if (sha256Hex(bytes) !== handle.sha256) throw new Error('fabric bulk: sha256 checksum mismatch');
  return bytes;
}

/** Production: read the delivered bulk file from this node's receive root. */
export async function productionReadSink(sink: string): Promise<Uint8Array> {
  const buf = await fs.readFile(safeJoin(receiveRoot(), sink));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
