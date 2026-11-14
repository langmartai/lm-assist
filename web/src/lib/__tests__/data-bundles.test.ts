/**
 * Client helpers for the /data Backup tab (data export/import spec, "Surfaces > Web"): error
 * decoding, request bodies, chunked download/upload over the JSON chunk routes, takeover
 * gating and plan formatting. The API is a fake `JsonCall`, so nothing touches a Core.
 */
import { describe, it, expect } from 'vitest';
import {
  BundleApiError,
  DEFAULT_EXPORT_SELECTION,
  MAX_UPLOAD_CHUNK_B64,
  UPLOAD_CHUNK_BYTES,
  base64ToBytes,
  bundleContents,
  bundleFileName,
  bytesToBase64,
  canExport,
  confirmLines,
  createBundlesApi,
  defaultImportSelection,
  describeDetails,
  downloadBundleBytes,
  exportBody,
  formatBytes,
  formatInterval,
  importBody,
  isTransient,
  nextStep,
  nonZeroBuckets,
  originState,
  planKey,
  sectionsSummary,
  sha256Hex,
  summarizeCounts,
  takeoverState,
  toBundleApiError,
  uploadBundleFile,
  type ChunkResult,
  type CompactSection,
  type ImportResult,
  type InventoryDataset,
  type JsonCall,
  type PlanCounts,
  type UploadChunkInput,
  type UploadChunkResult,
} from '../data-bundles';

function counts(p: Partial<PlanCounts> = {}): PlanCounts {
  return {
    add: 0, update: 0, skipOlder: 0, skipIdentical: 0, skipExists: 0, tooLarge: 0, neutralized: 0,
    skipDiffers: 0, skipped: 0, importedDisabled: 0, ...p,
  };
}

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff; }
  return out;
}

/** A JsonCall that records every request and answers from `handler`. */
function fakeCall(handler: (path: string, opts?: { method?: string; body?: unknown }) => unknown) {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  const call: JsonCall = async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
    calls.push({ path, method: opts?.method, body: opts?.body });
    const r = handler(path, opts);
    if (r instanceof Error) throw r;
    return r as T;
  };
  return { call, calls };
}

// ─── errors ─────────────────────────────────────────────────────────────────

describe('toBundleApiError', () => {
  it('decodes the api-client "API <status>: <envelope>" message into code + message', () => {
    const body = JSON.stringify({ success: false, error: { code: 'ORIGIN_ONLINE', message: 'the origin is online' } });
    const e = toBundleApiError(new Error(`API 409: ${body}`));
    expect(e).toBeInstanceOf(BundleApiError);
    expect(e.code).toBe('ORIGIN_ONLINE');
    expect(e.message).toBe('the origin is online');
    expect(e.status).toBe(409);
  });

  it('keeps structured details (DISK_LOW numbers) from the envelope', () => {
    const body = JSON.stringify({ success: false, error: { code: 'DISK_LOW', message: 'low', details: { freeBytes: 1, requiredBytes: 2 } } });
    const e = toBundleApiError(new Error(`API 507: ${body}`));
    expect(e.code).toBe('DISK_LOW');
    expect(e.details).toEqual({ freeBytes: 1, requiredBytes: 2 });
  });

  it('a relay error with a string `error` gets HTTP_<status> as its code', () => {
    const e = toBundleApiError(new Error('API 503: {"error":"machine is offline"}'));
    expect(e.code).toBe('HTTP_503');
    expect(e.message).toBe('machine is offline');
  });

  it('a non-JSON body keeps the raw text', () => {
    const e = toBundleApiError(new Error('API 502: Bad Gateway'));
    expect(e.code).toBe('HTTP_502');
    expect(e.message).toBe('Bad Gateway');
  });

  it('a fetch TypeError is NETWORK; anything else is ERROR; a BundleApiError passes through', () => {
    expect(toBundleApiError(new TypeError('Failed to fetch')).code).toBe('NETWORK');
    expect(toBundleApiError(new Error('Hub mode requires machineId')).code).toBe('ERROR');
    const same = new BundleApiError('X', 'y');
    expect(toBundleApiError(same)).toBe(same);
  });

  it('isTransient: network, unknown and 5xx retry; coded refusals do not', () => {
    expect(isTransient(new BundleApiError('NETWORK', ''))).toBe(true);
    expect(isTransient(new BundleApiError('HTTP_502', ''))).toBe(true);
    expect(isTransient(new BundleApiError('ERROR', ''))).toBe(true);
    expect(isTransient(new BundleApiError('UPLOAD_CONFLICT', ''))).toBe(false);
    expect(isTransient(new BundleApiError('DISK_LOW', ''))).toBe(false);
    expect(isTransient(new BundleApiError('HTTP_400', ''))).toBe(false);
  });
});

// ─── api paths ──────────────────────────────────────────────────────────────

describe('createBundlesApi', () => {
  it('uses the spec routes, url-encodes ids and adds confirm:true only on apply', async () => {
    const { call, calls } = fakeCall(() => ({}));
    const api = createBundlesApi(call);
    const id = 'lmb-20260923-101010-abcdef';
    await api.inventory();
    await api.create({ sections: ['datasets'] });
    await api.inspect(id);
    await api.remove(id);
    await api.chunk(id, 1024, 512);
    await api.plan(id, { policy: 'merge' });
    await api.apply(id, { policy: 'replace' });
    await api.fetchFrom('node-a', id);
    await api.takeover('back log', true);
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.path}`)).toEqual([
      'GET /data/bundles/inventory',
      'POST /data/bundles',
      `GET /data/bundles/${id}`,
      `DELETE /data/bundles/${id}`,
      `GET /data/bundles/${id}/chunk?offset=1024&length=512`,
      `POST /data/bundles/${id}/plan`,
      `POST /data/bundles/${id}/apply`,
      'POST /data/bundles/fetch',
      'POST /data/datasets/back%20log/takeover',
    ]);
    expect(calls[5].body).toEqual({ policy: 'merge' });
    expect(calls[6].body).toEqual({ policy: 'replace', confirm: true });
    expect(calls[7].body).toEqual({ fromNode: 'node-a', bundleId: id });
    expect(calls[8].body).toEqual({ force: true });
  });

  it('reads and toggles the data-snapshot scheduled job through the scheduler routes', async () => {
    const job = { id: 'data-snapshot', enabled: false, intervalMinutes: 1440, config: {}, lastRunAt: null, lastResult: null, lastStatus: null };
    const { call, calls } = fakeCall(() => job);
    const api = createBundlesApi(call);
    expect(await api.snapshotJob()).toEqual(job);
    await api.setSnapshotEnabled(true);
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.path}`)).toEqual(['GET /scheduler/jobs/data-snapshot', 'PUT /scheduler/jobs/data-snapshot']);
    expect(calls[1].body).toEqual({ enabled: true });
  });

  it('an older Core without the job reads as null, not an error', async () => {
    const api = createBundlesApi(fakeCall(() => new Error('API 400: {"success":false,"error":{"code":"NOT_FOUND","message":"No job"}}')).call);
    expect(await api.snapshotJob()).toBeNull();
  });

  it('list accepts a bare array or a {bundles} wrapper', async () => {
    const rows = [{ bundleId: 'lmb-20260923-101010-abcdef', sizeBytes: 1, mtime: 'x' }];
    expect(await createBundlesApi(fakeCall(() => rows).call).list()).toEqual(rows);
    expect(await createBundlesApi(fakeCall(() => ({ bundles: rows })).call).list()).toEqual(rows);
    expect(await createBundlesApi(fakeCall(() => null).call).list()).toEqual([]);
  });

  it('inspect accepts the service shape or a bare manifest', async () => {
    const manifest = { t: 'manifest', bundleId: 'lmb-20260923-101010-abcdef', createdAt: 'c', sections: [], totals: { entries: 0, uncompressedBytes: 0 } };
    const a = await createBundlesApi(fakeCall(() => ({ bundleId: manifest.bundleId, sizeBytes: 9, manifest })).call).inspect(manifest.bundleId);
    expect(a.sizeBytes).toBe(9);
    expect(a.manifest.createdAt).toBe('c');
    const b = await createBundlesApi(fakeCall(() => manifest).call).inspect(manifest.bundleId);
    expect(b.bundleId).toBe(manifest.bundleId);
    expect(b.manifest.createdAt).toBe('c');
  });

  it('a 200 envelope with success:false is thrown as a coded error', async () => {
    const api = createBundlesApi(fakeCall(() => ({ success: false, error: { code: 'CONFIRM_REQUIRED', message: 'plan first' } })).call);
    await expect(api.plan('lmb-20260923-101010-abcdef', {})).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED', message: 'plan first' });
  });

  it('a thrown api-client error is decoded', async () => {
    const api = createBundlesApi(fakeCall(() => new Error('API 404: {"success":false,"error":{"code":"BUNDLE_NOT_FOUND","message":"gone"}}')).call);
    await expect(api.inspect('lmb-20260923-101010-abcdef')).rejects.toMatchObject({ code: 'BUNDLE_NOT_FOUND', status: 404 });
  });
});

// ─── base64 / hashing ───────────────────────────────────────────────────────

describe('base64', () => {
  it('round-trips arbitrary binary, including sizes past the apply() stride', () => {
    for (const n of [0, 1, 2, 3, 4, 100, 40_000, 70_001]) {
      const b = bytes(n, n + 1);
      const s = bytesToBase64(b);
      expect(s.length % 4).toBe(0);
      expect(Array.from(base64ToBytes(s))).toEqual(Array.from(b));
    }
  });

  it('matches Node Buffer encoding', () => {
    const b = bytes(1000);
    expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
  });

  it('an upload chunk of UPLOAD_CHUNK_BYTES stays under the route cap', () => {
    expect(bytesToBase64(bytes(UPLOAD_CHUNK_BYTES)).length).toBeLessThanOrEqual(MAX_UPLOAD_CHUNK_B64);
  });

  it('sha256Hex hashes with WebCrypto, or returns null without it', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new Uint8Array(0), null)).toBeNull();
  });
});

// ─── download ───────────────────────────────────────────────────────────────

describe('downloadBundleBytes', () => {
  const ID = 'lmb-20260923-101010-abcdef';

  function chunkServer(file: Uint8Array, mutate?: (c: ChunkResult, i: number) => ChunkResult) {
    let i = 0;
    return fakeCall((path) => {
      const m = /offset=(\d+)&length=(\d+)/.exec(path)!;
      const offset = Number(m[1]);
      const length = Math.min(Number(m[2]), file.length - offset);
      const part = file.subarray(offset, offset + length);
      const c: ChunkResult = { offset, length, total: file.length, dataB64: bytesToBase64(part), done: offset + length >= file.length };
      return mutate ? mutate(c, i++) : c;
    });
  }

  it('assembles every chunk in order and reports progress', async () => {
    const file = bytes(2500);
    const { call, calls } = chunkServer(file);
    const seen: number[] = [];
    const out = await downloadBundleBytes(createBundlesApi(call), ID, { chunkBytes: 1000, onProgress: (got) => seen.push(got) });
    expect(calls.length).toBe(3);
    expect(out.total).toBe(2500);
    const joined = new Uint8Array(out.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of out.parts) { joined.set(p, o); o += p.length; }
    expect(Array.from(joined)).toEqual(Array.from(file));
    expect(seen).toEqual([1000, 2000, 2500]);
  });

  it('refuses a chunk at the wrong offset', async () => {
    const { call } = chunkServer(bytes(2500), (c, i) => (i === 1 ? { ...c, offset: c.offset + 1 } : c));
    await expect(downloadBundleBytes(createBundlesApi(call), ID, { chunkBytes: 1000 })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('refuses an empty chunk before the end', async () => {
    const { call } = chunkServer(bytes(2500), (c, i) => (i === 1 ? { ...c, length: 0, dataB64: '', done: false } : c));
    await expect(downloadBundleBytes(createBundlesApi(call), ID, { chunkBytes: 1000 })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('refuses a transfer that ends short of total', async () => {
    const { call } = chunkServer(bytes(2500), (c, i) => (i === 1 ? { ...c, done: true } : c));
    await expect(downloadBundleBytes(createBundlesApi(call), ID, { chunkBytes: 1000 })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('bundleFileName is the stored id plus the bundle extension', () => {
    expect(bundleFileName(ID)).toBe(`${ID}.lmbundle.gz`);
  });
});

// ─── upload ─────────────────────────────────────────────────────────────────

describe('uploadBundleFile', () => {
  function uploadServer(opts: { failOnce?: Error; failAlways?: Error } = {}) {
    const got: UploadChunkInput[] = [];
    let failed = false;
    const { call, calls } = fakeCall((path, o) => {
      expect(path).toBe('/data/bundles/upload');
      expect(o?.method).toBe('POST');
      const input = o!.body as UploadChunkInput;
      if (opts.failAlways) return opts.failAlways;
      if (opts.failOnce && !failed && input.index === 1) { failed = true; return opts.failOnce; }
      got.push(input);
      const uploadId = input.uploadId ?? 'upl-0123456789abcdef';
      const done = new Set(got.map((g) => g.index)).size === input.total;
      const r: UploadChunkResult = { uploadId, received: new Set(got.map((g) => g.index)).size, total: input.total, done };
      if (done) Object.assign(r, { bundleId: 'lmb-20260923-101010-abcdef', sizeBytes: 1, sha256: 'x' });
      return r;
    });
    return { call, calls, got };
  }

  it('splits the file, carries the minted uploadId forward, and returns the stored bundle', async () => {
    const file = new Blob([bytes(2500) as Uint8Array<ArrayBuffer>]);
    const { call, got } = uploadServer();
    const progress: number[] = [];
    const r = await uploadBundleFile(createBundlesApi(call), file, { name: 'x.lmbundle.gz', chunkBytes: 1000, sha256: 'a'.repeat(64), onProgress: (sent) => progress.push(sent) });
    expect(r.bundleId).toBe('lmb-20260923-101010-abcdef');
    expect(got.map((g) => g.index)).toEqual([0, 1, 2]);
    expect(got.every((g) => g.total === 3)).toBe(true);
    // The id is minted client-side and sent from index 0 on, so every retry is idempotent.
    expect(got[0].uploadId).toMatch(/^upl-[0-9a-f]{16}$/);
    expect(got[1].uploadId).toBe(got[0].uploadId);
    expect(got[0].name).toBe('x.lmbundle.gz');
    expect(got[0].sha256).toBe('a'.repeat(64));
    const joined = got.map((g) => Array.from(base64ToBytes(g.dataB64))).flat();
    expect(joined).toEqual(Array.from(bytes(2500)));
    expect(progress).toEqual([1000, 2000, 2500]);
  });

  it('never sends a chunk over the route cap, whatever chunkBytes is asked for', async () => {
    const file = new Blob([bytes(600_000) as Uint8Array<ArrayBuffer>]);
    const { call, got } = uploadServer();
    await uploadBundleFile(createBundlesApi(call), file, { chunkBytes: 10 * 1024 * 1024 });
    expect(got.length).toBe(2);
    expect(Math.max(...got.map((g) => g.dataB64.length))).toBeLessThanOrEqual(MAX_UPLOAD_CHUNK_B64);
  });

  it('retries a chunk after a transient failure (chunks are idempotent per index)', async () => {
    const file = new Blob([bytes(2500) as Uint8Array<ArrayBuffer>]);
    const { call, calls, got } = uploadServer({ failOnce: new TypeError('Failed to fetch') });
    const r = await uploadBundleFile(createBundlesApi(call), file, { chunkBytes: 1000, retryDelayMs: 0 });
    expect(r.done).toBe(true);
    expect(calls.length).toBe(4);
    expect(got.map((g) => g.index)).toEqual([0, 1, 2]);
  });

  it('a retry of a one-chunk upload whose reply was lost re-sends the SAME uploadId (no duplicate bundle)', async () => {
    const file = new Blob([bytes(10) as Uint8Array<ArrayBuffer>]);
    const seen: UploadChunkInput[] = [];
    let n = 0;
    const { call } = fakeCall((_path, o) => {
      const input = o!.body as UploadChunkInput;
      seen.push(input);
      if (n++ === 0) return new TypeError('Failed to fetch'); // stored on the Core, reply lost
      return { uploadId: input.uploadId!, received: 1, total: 1, done: true, bundleId: 'lmb-20260923-101010-abcdef', sizeBytes: 1, sha256: 'x' };
    });
    const r = await uploadBundleFile(createBundlesApi(call), file, { retryDelayMs: 0 });
    expect(r.bundleId).toBe('lmb-20260923-101010-abcdef');
    expect(seen.length).toBe(2);
    expect(seen[0].uploadId).toMatch(/^upl-[0-9a-f]{16}$/);
    expect(seen[1].uploadId).toBe(seen[0].uploadId);
  });

  it('does not retry a coded refusal', async () => {
    const file = new Blob([bytes(10) as Uint8Array<ArrayBuffer>]);
    const err = new Error('API 422: {"success":false,"error":{"code":"BUNDLE_CORRUPT","message":"end-hash"}}');
    const { call, calls } = uploadServer({ failAlways: err });
    await expect(uploadBundleFile(createBundlesApi(call), file, { retryDelayMs: 0 })).rejects.toMatchObject({ code: 'BUNDLE_CORRUPT' });
    expect(calls.length).toBe(1);
  });

  it('refuses an empty file locally', async () => {
    const { call, calls } = uploadServer();
    await expect(uploadBundleFile(createBundlesApi(call), new Blob([]))).rejects.toMatchObject({ code: 'UPLOAD_INVALID' });
    expect(calls.length).toBe(0);
  });
});

// ─── request bodies ─────────────────────────────────────────────────────────

describe('exportBody', () => {
  it('defaults to datasets + config, nothing opt-in', () => {
    expect(exportBody(DEFAULT_EXPORT_SELECTION)).toEqual({ sections: ['datasets', 'config'] });
    expect(canExport(DEFAULT_EXPORT_SELECTION)).toBe(true);
  });

  it('adds the opt-ins, trims the note, and drops includeReplicas without datasets', () => {
    expect(exportBody({ ...DEFAULT_EXPORT_SELECTION, includeReplicas: true, includeKnowledge: true, includeClaudeMemory: true, note: '  before upgrade ' }))
      .toEqual({ sections: ['datasets', 'config'], includeReplicas: true, includeKnowledge: true, includeClaudeMemory: true, note: 'before upgrade' });
    expect(exportBody({ ...DEFAULT_EXPORT_SELECTION, datasets: false, includeReplicas: true })).toEqual({ sections: ['config'] });
  });

  it('nothing selected cannot export', () => {
    expect(canExport({ ...DEFAULT_EXPORT_SELECTION, datasets: false, config: false })).toBe(false);
    expect(canExport({ ...DEFAULT_EXPORT_SELECTION, datasets: false, config: false, includeKnowledge: true })).toBe(true);
  });
});

const SECTIONS: CompactSection[] = [
  { kind: 'dataset', id: 'backlog', title: 'backlog', count: 10, bytes: 1, warnings: [], owned: true },
  { kind: 'dataset', id: 'missions', title: 'missions', count: 3, bytes: 1, warnings: [], owned: false },
  { kind: 'config', id: 'scheduled-jobs', title: 'Scheduled jobs', count: 1, bytes: 1, warnings: [] },
  { kind: 'config', id: 'mcp-profile', title: 'MCP profile', count: 1, bytes: 1, warnings: [] },
  { kind: 'files', id: 'knowledge', title: 'Knowledge', count: 4, bytes: 1, warnings: [] },
];

describe('bundleContents / importBody', () => {
  it('lists the groups present in bundle order and the dataset sections', () => {
    const c = bundleContents(SECTIONS);
    expect(c.groups).toEqual(['datasets', 'config', 'knowledge']);
    expect(c.datasets.map((d) => d.id)).toEqual(['backlog', 'missions']);
  });

  it('the default selection imports everything under merge', () => {
    const c = bundleContents(SECTIONS);
    expect(importBody(defaultImportSelection(c), c)).toEqual({ policy: 'merge', sections: ['datasets', 'config', 'knowledge'] });
  });

  it('a dataset subset is sent; no datasets drops the datasets group', () => {
    const c = bundleContents(SECTIONS);
    const sel = defaultImportSelection(c);
    expect(importBody({ ...sel, datasets: { ...sel.datasets, missions: false } }, c).datasets).toEqual(['backlog']);
    const none = importBody({ ...sel, datasets: { backlog: false, missions: false } }, c);
    expect(none.sections).toEqual(['config', 'knowledge']);
    expect(none.datasets).toBeUndefined();
  });

  it('carries policy, takeOwnership and force only when set', () => {
    const c = bundleContents(SECTIONS);
    const sel = { ...defaultImportSelection(c), policy: 'replace' as const, takeOwnership: true, force: true, groups: { datasets: true, config: false, knowledge: false } };
    expect(importBody(sel, c)).toEqual({ policy: 'replace', sections: ['datasets'], takeOwnership: true, force: true });
  });

  it('planKey changes with the bundle or any option, and not otherwise', () => {
    const c = bundleContents(SECTIONS);
    const a = importBody(defaultImportSelection(c), c);
    expect(planKey('lmb-a', a)).toBe(planKey('lmb-a', { ...a }));
    expect(planKey('lmb-a', a)).not.toBe(planKey('lmb-b', a));
    expect(planKey('lmb-a', a)).not.toBe(planKey('lmb-a', { ...a, policy: 'replace' }));
  });
});

// ─── takeover / origin ──────────────────────────────────────────────────────

function ds(p: Partial<InventoryDataset>): InventoryDataset {
  return {
    id: 'x', backend: 'cache', owned: true, ownerNode: 'self', scope: 'fleet', syncMode: 'full', export: 'default',
    records: 1, tombstones: 0, approxBytes: 1, ...p,
  };
}

describe('takeoverState / originState', () => {
  it('owned datasets have no takeover and no origin dot', () => {
    expect(takeoverState(ds({}))).toEqual({ show: false, needsForce: false });
    expect(originState(ds({}))).toBeNull();
  });

  it('a replica with its origin online cannot be taken over', () => {
    const r = ds({ owned: false, origin: { machineId: 'm', hostname: 'h' }, originOnline: true });
    expect(takeoverState(r)).toEqual({ show: false, needsForce: false });
    expect(originState(r)).toBe('online');
  });

  it('a replica with its origin offline can be taken over without force', () => {
    const r = ds({ owned: false, origin: { machineId: 'm', hostname: 'h' }, originOnline: false });
    expect(takeoverState(r)).toEqual({ show: true, needsForce: false });
    expect(originState(r)).toBe('offline');
  });

  it('an unknown roster (null) means unknown, not offline: takeover needs force', () => {
    const r = ds({ owned: false, origin: { machineId: 'm', hostname: 'h' }, originOnline: null });
    expect(takeoverState(r)).toEqual({ show: true, needsForce: true });
    expect(originState(r)).toBe('unknown');
  });
});

// ─── plan formatting ────────────────────────────────────────────────────────

describe('plan formatting', () => {
  it('nonZeroBuckets keeps bucket order and drops zeros', () => {
    expect(nonZeroBuckets(counts({ skipIdentical: 4, add: 2 }))).toEqual([['add', 2], ['skipIdentical', 4]]);
  });

  it('summarizeCounts is a compact line, or "nothing" when empty', () => {
    expect(summarizeCounts(counts({ add: 2, update: 1, skipOlder: 3 }))).toBe('2 add · 1 update · 3 skip (local newer)');
    expect(summarizeCounts(counts())).toBe('nothing');
  });

  it('nextStep names a next step for every ownership refusal, and null for unknown codes', () => {
    for (const code of ['REPLICA_READ_ONLY', 'OWNER_ONLINE', 'ORIGIN_ONLINE', 'ROSTER_UNAVAILABLE', 'BAD_SECTION_DATA', 'DISK_LOW', 'BUNDLE_CORRUPT']) {
      expect(nextStep(code)).toBeTruthy();
    }
    expect(nextStep('SOMETHING_NEW')).toBeNull();
  });

  it('confirmLines restates policy, node, writes and refusals', () => {
    const result: ImportResult = {
      bundleId: 'lmb-20260923-101010-abcdef', policy: 'replace', dryRun: true,
      source: { nodeId: 'n', hostname: 'src-host', platform: 'linux', lmAssistVersion: '0', mode: 'prod' },
      createdAt: '2026-09-23T10:10:10.000Z',
      sections: [
        { kind: 'dataset', id: 'a', counts: counts({ add: 2 }), samples: {}, warnings: [] },
        { kind: 'dataset', id: 'b', counts: counts(), samples: {}, warnings: [], refused: { code: 'OWNER_ONLINE', reason: 'r' } },
      ],
      totals: counts({ add: 2, update: 5 }), refused: 1, warnings: [],
    };
    const lines = confirmLines(result, 'target-host').join('\n');
    expect(lines).toContain('replace');
    expect(lines).toContain('target-host');
    expect(lines).toContain('2 add');
    expect(lines).toContain('5 update');
    expect(lines).toContain('1 section refused');
  });

  it('sectionsSummary counts sections by kind', () => {
    expect(sectionsSummary(SECTIONS)).toBe('2 datasets · 2 config · 1 files');
    expect(sectionsSummary([])).toBe('empty');
  });

  it('describeDetails words the numbers a refusal carries', () => {
    expect(describeDetails(new BundleApiError('DISK_LOW', 'x', 507, { freeBytes: 1024, requiredBytes: 2048 }))).toBe('free 1.0 KB · needs 2.0 KB');
    expect(describeDetails(new BundleApiError('BUNDLE_CORRUPT', 'x', 422, { check: 'end-hash' }))).toBe('failed check: end-hash');
    expect(describeDetails(new BundleApiError('ORIGIN_ONLINE', 'x', 409, { machineId: 'm1', hostname: 'h1' }))).toBe('origin h1 · m1');
    expect(describeDetails(new BundleApiError('X', 'x'))).toBeNull();
  });

  it('formatInterval', () => {
    expect(formatInterval(1440)).toBe('24 h');
    expect(formatInterval(90)).toBe('90 min');
    expect(formatInterval(120)).toBe('2 h');
    expect(formatInterval(0)).toBe('paused');
  });

  it('formatBytes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});
