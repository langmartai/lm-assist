/**
 * Client side of data export/import bundles (spec 2026-09-23 "Surfaces > Web"): the wire
 * types of the /data/bundles* and /data/datasets/:id/takeover routes, mirrored from
 * core/src/data/bundle, plus the helpers the /data Backup tab needs — coded-error decoding,
 * request bodies, chunked download/upload over the JSON chunk routes (JSON, so they pass the
 * hub relay the same way every other fetchPath call does), takeover gating, and plan
 * formatting. vitest-covered in __tests__/data-bundles.test.ts.
 *
 * The type block mirrors core/src/data/bundle/{format,store,service}.ts and
 * sections/{types,datasets}.ts. Change both or neither.
 */

// ─── Mirrored from core/src/data/bundle ──────────────────────────────────────

export type ImportPolicy = 'merge' | 'add-missing' | 'replace';
export const IMPORT_POLICIES: readonly ImportPolicy[] = ['merge', 'add-missing', 'replace'];

/** One line per policy — what it does to a record that is already here. */
export const POLICY_HELP: Record<ImportPolicy, string> = {
  merge: 'Add what is missing; overwrite a local record only when the bundle copy is newer. Never deletes.',
  'add-missing': 'Add only what is missing here; every record that already exists is left untouched.',
  replace: 'Bundle wins: differing records are rewritten as a new version, so the restore out-dates every replica. Never deletes.',
};

export type SectionGroup = 'datasets' | 'config' | 'knowledge' | 'claude-memory' | 'claude-rules';
export const SECTION_GROUPS: readonly SectionGroup[] = ['datasets', 'config', 'knowledge', 'claude-memory', 'claude-rules'];

export const GROUP_LABEL: Record<SectionGroup, string> = {
  datasets: 'Datasets',
  config: 'Config',
  knowledge: 'Knowledge base',
  'claude-memory': 'Claude project memory',
  'claude-rules': 'Claude rules',
};

export interface PlanCounts {
  add: number;
  update: number;
  skipOlder: number;
  skipIdentical: number;
  skipExists: number;
  tooLarge: number;
  neutralized: number;
  skipDiffers: number;
  skipped: number;
  importedDisabled: number;
}
export type PlanBucket = keyof PlanCounts;
export const PLAN_BUCKETS: readonly PlanBucket[] = [
  'add', 'update', 'skipOlder', 'skipIdentical', 'skipExists', 'tooLarge', 'neutralized',
  'skipDiffers', 'skipped', 'importedDisabled',
];

export const BUCKET_LABEL: Record<PlanBucket, string> = {
  add: 'add',
  update: 'update',
  skipOlder: 'skip (local newer)',
  skipIdentical: 'skip (identical)',
  skipExists: 'skip (exists)',
  tooLarge: 'too large',
  neutralized: 'paused on import',
  skipDiffers: 'differs (replace only)',
  skipped: 'skipped',
  importedDisabled: 'imported disabled',
};

/** Buckets that write; the rest are skips or annotations of a write (neutralized, importedDisabled). */
export const WRITE_BUCKETS: readonly PlanBucket[] = ['add', 'update'];

export type DatasetAction = 'import' | 'create' | 'takeover' | 'skip' | 'refuse';

export interface SectionPlan {
  kind: 'dataset' | 'config' | 'files';
  id: string;
  title?: string;
  counts: PlanCounts;
  samples: Partial<Record<PlanBucket, string[]>>;
  warnings: string[];
  refused?: { code: string; reason: string };
  applied?: PlanCounts;
  errors?: string[];
  /** Dataset sections only. */
  action?: DatasetAction;
}

export interface BundleSource {
  nodeId: string;
  hostname: string;
  platform: string;
  lmAssistVersion: string;
  mode: 'prod' | 'dev';
  cluster?: string;
}

export interface NodeOriginRef { machineId: string; hostname: string; os?: string }

/** A manifest section without its hash — what list/inspect/create return. */
export interface CompactSection {
  kind: 'dataset' | 'config' | 'files';
  id: string;
  title: string;
  count: number;
  bytes: number;
  warnings: string[];
  tombstones?: number;
  owned?: boolean;
  origin?: NodeOriginRef;
  scope?: string;
  syncMode?: string;
  backend?: string;
  redactedKeys?: string[];
}

export interface BundleTotals { entries: number; uncompressedBytes: number }

export interface CompactManifest {
  t?: 'manifest';
  format?: string;
  formatVersion?: number;
  bundleId: string;
  createdAt: string;
  source: BundleSource;
  options?: Record<string, unknown>;
  sections: CompactSection[];
  totals: BundleTotals;
  note?: string;
}

export interface ImportedMeta {
  importedFrom: string;
  via: 'upload' | 'received' | 'fetch';
  at: string;
  name?: string;
  fromNode?: string;
  sourceBundleId?: string;
}

export interface StoredBundleInfo {
  bundleId: string;
  sizeBytes: number;
  mtime: string;
  createdAt?: string;
  source?: BundleSource;
  note?: string;
  sections?: CompactSection[];
  totals?: BundleTotals;
  imported?: ImportedMeta;
  error?: { code: string; message: string };
}

export interface InspectResult {
  bundleId: string;
  sizeBytes: number | null;
  manifest: CompactManifest;
  imported?: ImportedMeta;
}

export interface ExportOptions {
  sections?: SectionGroup[];
  datasets?: string[];
  includeReplicas?: boolean;
  includeKnowledge?: boolean;
  includeClaudeMemory?: boolean;
  note?: string;
}

export interface ExportResult {
  bundleId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  note?: string;
  sections: CompactSection[];
  totals: BundleTotals;
  excluded: Array<{ id: string; reason: string }>;
  warnings: string[];
  pruned: string[];
  next: string;
}

export interface ImportOptions {
  policy?: ImportPolicy;
  sections?: SectionGroup[];
  datasets?: string[];
  takeOwnership?: boolean;
  force?: boolean;
}

export interface ImportResult {
  bundleId: string;
  policy: ImportPolicy;
  dryRun: boolean;
  source: BundleSource;
  createdAt: string;
  note?: string;
  sections: SectionPlan[];
  totals: PlanCounts;
  applied?: PlanCounts;
  refused: number;
  warnings: string[];
}

export interface TakeoverResult {
  dataset: string;
  records: number;
  tombstones: number;
  superseded: { machineId: string; hostname: string };
  ownerNode: string;
  visibility: string;
  forced: boolean;
  note: string;
}

export interface InventoryDataset {
  id: string;
  title?: string;
  backend: string;
  owned: boolean;
  ownerNode: string;
  origin?: { machineId: string; hostname: string };
  /** true/false per the fleet roster; null = the roster is unavailable (unknown, NOT offline). */
  originOnline?: boolean | null;
  supersedes?: { machineId: string; hostname: string; at: string };
  scope: string;
  syncMode: string;
  export: 'default' | 'opt-in' | 'never';
  reason?: string;
  records: number | null;
  tombstones: number | null;
  approxBytes: number | null;
  error?: string;
}

export interface OrphanStore { id: string; backend: 'cache' | 'sql'; bytes: number; lockOnly?: boolean }

export interface Inventory {
  node: { nodeId: string; hostname: string; cluster: string | null; mode: 'prod' | 'dev' };
  roster: { queried: boolean; available?: boolean; reason?: string; onlinePeers?: number };
  datasets: InventoryDataset[];
  orphans: OrphanStore[];
  sections: {
    config: Array<{ id: string; title: string; default: true }>;
    files: Array<{ id: string; title: string; default: false; option: 'includeKnowledge' | 'includeClaudeMemory' }>;
  };
  neverExported: string[];
  sync: { lastRun: string | null; peersChecked: number; datasetsReplicated: number; errors: string[] } | null;
  bundles: { count: number; newest?: string };
}

export interface ChunkResult { offset: number; length: number; total: number; dataB64: string; done: boolean }

/** The built-in scheduled job that writes a default export every 24 h (ships disabled). */
export const DATA_SNAPSHOT_JOB_ID = 'data-snapshot';

/** The fields of a /scheduler/jobs/:id entry the Backup tab shows (core/src/scheduler/scheduled-jobs.ts). */
export interface SnapshotJob {
  id: string;
  enabled: boolean;
  intervalMinutes: number;
  config: Record<string, unknown>;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: string | null;
}

export interface UploadChunkInput {
  uploadId?: string;
  index: number;
  total: number;
  name?: string;
  dataB64: string;
  sha256?: string;
}

export interface UploadChunkResult {
  uploadId: string;
  received: number;
  total: number;
  done: boolean;
  bundleId?: string;
  manifest?: CompactManifest;
  sizeBytes?: number;
  sha256?: string;
}

export interface FetchResult {
  bundleId: string;
  manifest: CompactManifest;
  sizeBytes: number;
  sha256: string;
  imported: ImportedMeta;
  fromNode: string;
  sourceBundleId: string;
  chunks: number;
}

// ─── Limits (mirrored from core/src/data/bundle/store.ts) ────────────────────

export const BUNDLE_EXT = '.lmbundle.gz';
/** The chunk route serves at most 512 KiB per call. */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** The upload route takes at most 700 KiB of base64 per chunk (the relay's body cap is 1,000,000 chars). */
export const MAX_UPLOAD_CHUNK_B64 = 700 * 1024;
/** Raw bytes per upload chunk: 512 KiB → 699,052 base64 chars. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
/** The largest raw chunk whose base64 still fits MAX_UPLOAD_CHUNK_B64. */
const MAX_UPLOAD_RAW = Math.floor(MAX_UPLOAD_CHUNK_B64 / 4) * 3;
export const NOTE_MAX = 500;

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A failed bundle call with the Core's code (ORIGIN_ONLINE, DISK_LOW, …) kept visible. */
export class BundleApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BundleApiError';
  }
}

interface ParsedError { code?: string; message?: string; details?: Record<string, unknown> }

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The error inside a response envelope: `{error:{code,message,details}}`, `{error:"…"}` or `{code,message}`. */
function envelopeError(j: unknown): ParsedError | null {
  const o = asRecord(j);
  if (!o) return null;
  const err = o.error;
  const e = asRecord(err);
  if (e) return { code: asString(e.code), message: asString(e.message), details: asRecord(e.details) ?? asRecord(o.details) };
  if (typeof err === 'string') return { code: asString(o.code), message: err };
  if (typeof o.code === 'string' || typeof o.message === 'string') return { code: asString(o.code), message: asString(o.message) };
  return null;
}

/**
 * Any thrown value → BundleApiError. The api-client throws `Error("API <status>: <body>")`
 * for a non-2xx response; the body is the Core's `{success:false, error:{code,message}}`
 * envelope, or a relay's own error text.
 */
export function toBundleApiError(e: unknown): BundleApiError {
  if (e instanceof BundleApiError) return e;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  const m = /^API (\d{3}):\s*([\s\S]*)$/.exec(raw);
  if (m) {
    const status = Number(m[1]);
    const body = m[2].trim();
    let parsed: ParsedError | null = null;
    try { parsed = envelopeError(JSON.parse(body)); } catch { /* not JSON — keep the text */ }
    return new BundleApiError(parsed?.code ?? `HTTP_${status}`, parsed?.message ?? (body || `HTTP ${status}`), status, parsed?.details);
  }
  // fetch() rejects with a TypeError when the request never got an answer.
  if (e instanceof TypeError) return new BundleApiError('NETWORK', raw || 'network error');
  return new BundleApiError('ERROR', raw || 'request failed');
}

/** Worth retrying: no answer, an unknown failure, a 5xx or 429. A coded refusal never is. */
export function isTransient(e: BundleApiError): boolean {
  return e.code === 'NETWORK' || e.code === 'ERROR' || /^HTTP_(5\d\d|429)$/.test(e.code);
}

// ─── API ────────────────────────────────────────────────────────────────────

/** `apiClient.fetchPath` bound to one node: JSON in, the unwrapped `data` out. */
export type JsonCall = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

export interface BundlesApi {
  inventory(): Promise<Inventory>;
  list(): Promise<StoredBundleInfo[]>;
  create(opts: ExportOptions): Promise<ExportResult>;
  inspect(bundleId: string): Promise<InspectResult>;
  remove(bundleId: string): Promise<{ bundleId: string; deleted: boolean }>;
  chunk(bundleId: string, offset: number, length?: number): Promise<ChunkResult>;
  upload(input: UploadChunkInput): Promise<UploadChunkResult>;
  /** Run on the TARGET: pull `bundleId` from `fromNode` through the hub, verify, store. */
  fetchFrom(fromNode: string, bundleId: string): Promise<FetchResult>;
  plan(bundleId: string, opts: ImportOptions): Promise<ImportResult>;
  /** Adds `confirm: true` — only call it after the user confirmed a plan. */
  apply(bundleId: string, opts: ImportOptions): Promise<ImportResult>;
  takeover(datasetId: string, force?: boolean): Promise<TakeoverResult>;
  /** The data-snapshot job, or null when this node's build has none. */
  snapshotJob(): Promise<SnapshotJob | null>;
  setSnapshotEnabled(enabled: boolean): Promise<SnapshotJob>;
}

export function createBundlesApi(raw: JsonCall): BundlesApi {
  async function call<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
    let r: unknown;
    try {
      r = await raw<unknown>(path, opts);
    } catch (e) {
      throw toBundleApiError(e);
    }
    // fetchPath unwraps `data`; a refusal served as 200 comes back as the whole envelope.
    const o = asRecord(r);
    if (o && o.success === false) {
      const pe = envelopeError(o);
      throw new BundleApiError(pe?.code ?? 'ERROR', pe?.message ?? 'request refused', undefined, pe?.details);
    }
    return r as T;
  }
  const b = (id: string) => `/data/bundles/${encodeURIComponent(id)}`;

  return {
    inventory: () => call<Inventory>('/data/bundles/inventory'),
    async list() {
      const r = await call<unknown>('/data/bundles');
      if (Array.isArray(r)) return r as StoredBundleInfo[];
      const list = asRecord(r)?.bundles;
      return Array.isArray(list) ? (list as StoredBundleInfo[]) : [];
    },
    create: (opts) => call<ExportResult>('/data/bundles', { method: 'POST', body: opts }),
    async inspect(bundleId) {
      const r = asRecord(await call<unknown>(b(bundleId))) ?? {};
      const manifest = (asRecord(r.manifest) ?? r) as unknown as CompactManifest;
      return {
        bundleId: asString(r.bundleId) ?? bundleId,
        sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : null,
        manifest: { ...manifest, sections: Array.isArray(manifest.sections) ? manifest.sections : [] },
        ...(asRecord(r.imported) ? { imported: r.imported as ImportedMeta } : {}),
      };
    },
    remove: (bundleId) => call(b(bundleId), { method: 'DELETE' }),
    chunk: (bundleId, offset, length = MAX_CHUNK_BYTES) =>
      call<ChunkResult>(`${b(bundleId)}/chunk?offset=${offset}&length=${length}`),
    upload: (input) => call<UploadChunkResult>('/data/bundles/upload', { method: 'POST', body: input }),
    fetchFrom: (fromNode, bundleId) => call<FetchResult>('/data/bundles/fetch', { method: 'POST', body: { fromNode, bundleId } }),
    plan: (bundleId, opts) => call<ImportResult>(`${b(bundleId)}/plan`, { method: 'POST', body: opts }),
    apply: (bundleId, opts) => call<ImportResult>(`${b(bundleId)}/apply`, { method: 'POST', body: { ...opts, confirm: true } }),
    takeover: (datasetId, force) =>
      call<TakeoverResult>(`/data/datasets/${encodeURIComponent(datasetId)}/takeover`, { method: 'POST', body: force ? { force: true } : {} }),
    async snapshotJob() {
      try {
        return await call<SnapshotJob>(`/scheduler/jobs/${DATA_SNAPSHOT_JOB_ID}`);
      } catch (e) {
        if (e instanceof BundleApiError && e.code === 'NOT_FOUND') return null;
        throw e;
      }
    },
    setSnapshotEnabled: (enabled) => call<SnapshotJob>(`/scheduler/jobs/${DATA_SNAPSHOT_JOB_ID}`, { method: 'PUT', body: { enabled } }),
  };
}

// ─── base64 / hashing ───────────────────────────────────────────────────────

/** Bytes → base64 without a call-stack blowup on large chunks (fromCharCode in strides). */
export function bytesToBase64(bytes: Uint8Array): string {
  const STRIDE = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += STRIDE) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + STRIDE)));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hex sha256 via WebCrypto, or null where it does not exist (a plain-http LAN page is not a
 * secure context, so `crypto.subtle` is undefined there). The whole-file hash is optional
 * to the upload route; the bundle's own end hash is verified either way.
 */
export async function sha256Hex(
  data: Uint8Array<ArrayBuffer> | ArrayBuffer,
  subtle: SubtleCrypto | null | undefined = globalThis.crypto?.subtle,
): Promise<string | null> {
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ─── download / upload ──────────────────────────────────────────────────────

export function bundleFileName(bundleId: string): string {
  return `${bundleId}${BUNDLE_EXT}`;
}

/**
 * Read a stored bundle through the chunk route (≤ 512 KiB per call, so it works relayed)
 * and return the parts in order, ready for `new Blob(parts)`. Every chunk is checked: its
 * offset, its decoded length, and a stable total; a transfer that ends short is refused.
 */
export async function downloadBundleBytes(
  api: Pick<BundlesApi, 'chunk'>,
  bundleId: string,
  opts: { chunkBytes?: number; onProgress?: (got: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<{ parts: Uint8Array<ArrayBuffer>[]; total: number }> {
  const want = Math.min(MAX_CHUNK_BYTES, Math.max(1, opts.chunkBytes ?? MAX_CHUNK_BYTES));
  const fail = (msg: string) => new BundleApiError('DOWNLOAD_FAILED', `${bundleId}: ${msg}`);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let total: number | null = null;
  for (;;) {
    if (opts.signal?.aborted) throw new BundleApiError('ABORTED', 'download cancelled');
    const c = await api.chunk(bundleId, offset, want);
    if (!c || typeof c.dataB64 !== 'string' || c.offset !== offset) {
      throw fail(`chunk at offset ${offset} came back for offset ${c?.offset}`);
    }
    const buf = base64ToBytes(c.dataB64);
    if (buf.length !== c.length) throw fail(`chunk at offset ${offset} decoded to ${buf.length} bytes, expected ${c.length}`);
    if (total === null) total = c.total;
    else if (c.total !== total) throw fail(`the bundle changed size mid-download (${total} → ${c.total})`);
    if (buf.length) parts.push(buf);
    offset += buf.length;
    opts.onProgress?.(offset, total);
    if (c.done || offset >= total) break;
    if (buf.length === 0) throw fail(`empty chunk at offset ${offset} of ${total}`);
  }
  if (offset !== total) throw fail(`transfer ended at ${offset} of ${total} bytes`);
  return { parts, total };
}

/**
 * Upload a local `.lmbundle.gz` in chunks. Index 0 mints the uploadId; each later chunk
 * carries it. A chunk is idempotent per index on the Core, so a transient failure is
 * retried in place; a coded refusal (UPLOAD_CONFLICT, BUNDLE_CORRUPT, DISK_LOW…) is not.
 * The last answer is the stored bundle (`done:true`, `bundleId`).
 */
export async function uploadBundleFile(
  api: Pick<BundlesApi, 'upload'>,
  file: Blob,
  opts: {
    name?: string;
    chunkBytes?: number;
    sha256?: string | null;
    retries?: number;
    retryDelayMs?: number;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<UploadChunkResult> {
  if (file.size === 0) throw new BundleApiError('UPLOAD_INVALID', 'the file is empty');
  const size = Math.min(MAX_UPLOAD_RAW, Math.max(1, opts.chunkBytes ?? UPLOAD_CHUNK_BYTES));
  const total = Math.ceil(file.size / size);
  const retries = opts.retries ?? 2;
  const delay = opts.retryDelayMs ?? 1000;
  let uploadId: string | undefined;
  let last: UploadChunkResult | null = null;
  for (let index = 0; index < total; index++) {
    const start = index * size;
    const end = Math.min(file.size, start + size);
    const dataB64 = bytesToBase64(new Uint8Array(await file.slice(start, end).arrayBuffer()));
    const input: UploadChunkInput = {
      ...(uploadId ? { uploadId } : {}),
      index,
      total,
      ...(opts.name ? { name: opts.name } : {}),
      dataB64,
      ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new BundleApiError('ABORTED', 'upload cancelled');
      try {
        last = await api.upload(input);
        break;
      } catch (e) {
        const err = toBundleApiError(e);
        if (attempt >= retries || !isTransient(err)) throw err;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
      }
    }
    uploadId = last.uploadId;
    opts.onProgress?.(end, file.size);
  }
  if (!last?.done || !last.bundleId) {
    throw new BundleApiError('UPLOAD_INCOMPLETE', `the Core acknowledged ${last?.received ?? 0} of ${total} chunks but stored no bundle`);
  }
  return last;
}

// ─── request bodies ─────────────────────────────────────────────────────────

export interface ExportSelection {
  datasets: boolean;
  config: boolean;
  includeReplicas: boolean;
  includeKnowledge: boolean;
  includeClaudeMemory: boolean;
  note: string;
}

/** Datasets + config on; replicas, knowledge and Claude memory are opt-in (spec). */
export const DEFAULT_EXPORT_SELECTION: ExportSelection = {
  datasets: true, config: true, includeReplicas: false, includeKnowledge: false, includeClaudeMemory: false, note: '',
};

export function canExport(sel: ExportSelection): boolean {
  return sel.datasets || sel.config || sel.includeKnowledge || sel.includeClaudeMemory;
}

export function exportBody(sel: ExportSelection): ExportOptions {
  const sections: SectionGroup[] = [];
  if (sel.datasets) sections.push('datasets');
  if (sel.config) sections.push('config');
  const body: ExportOptions = { sections };
  if (sel.datasets && sel.includeReplicas) body.includeReplicas = true;
  if (sel.includeKnowledge) body.includeKnowledge = true;
  if (sel.includeClaudeMemory) body.includeClaudeMemory = true;
  const note = sel.note.trim();
  if (note) body.note = note.slice(0, NOTE_MAX);
  return body;
}

/** The group a manifest section belongs to (a files section's group is its own id). */
export function sectionGroup(s: Pick<CompactSection, 'kind' | 'id'>): SectionGroup | null {
  if (s.kind === 'dataset') return 'datasets';
  if (s.kind === 'config') return 'config';
  return (SECTION_GROUPS as readonly string[]).includes(s.id) ? (s.id as SectionGroup) : null;
}

export interface BundleContents {
  /** Groups present in the bundle, in first-seen order. */
  groups: SectionGroup[];
  datasets: CompactSection[];
}

export function bundleContents(sections: readonly CompactSection[]): BundleContents {
  const groups: SectionGroup[] = [];
  for (const s of sections) {
    const g = sectionGroup(s);
    if (g && !groups.includes(g)) groups.push(g);
  }
  return { groups, datasets: sections.filter((s) => s.kind === 'dataset') };
}

export interface ImportSelection {
  policy: ImportPolicy;
  /** group → included (a missing key counts as included). */
  groups: Partial<Record<SectionGroup, boolean>>;
  /** dataset id → included (a missing key counts as included). */
  datasets: Record<string, boolean>;
  takeOwnership: boolean;
  force: boolean;
}

export function defaultImportSelection(c: BundleContents): ImportSelection {
  return {
    policy: 'merge',
    groups: Object.fromEntries(c.groups.map((g) => [g, true])),
    datasets: Object.fromEntries(c.datasets.map((d) => [d.id, true])),
    takeOwnership: false,
    force: false,
  };
}

/**
 * The plan/apply body. The datasets list is sent only when it is a strict subset, and a
 * datasets group with every dataset unticked is dropped rather than sent as `datasets: []`.
 */
export function importBody(sel: ImportSelection, c: BundleContents): ImportOptions {
  let sections = c.groups.filter((g) => sel.groups[g] !== false);
  let datasets: string[] | undefined;
  if (sections.includes('datasets')) {
    const all = c.datasets.map((d) => d.id);
    const on = all.filter((id) => sel.datasets[id] !== false);
    if (on.length === 0) sections = sections.filter((g) => g !== 'datasets');
    else if (on.length !== all.length) datasets = on;
  }
  const body: ImportOptions = { policy: sel.policy, sections };
  if (datasets) body.datasets = datasets;
  if (sel.takeOwnership) body.takeOwnership = true;
  if (sel.force) body.force = true;
  return body;
}

/** Identity of a plan request: Apply is offered only while the options still match the plan shown. */
export function planKey(bundleId: string, body: ImportOptions): string {
  return JSON.stringify([
    bundleId, body.policy ?? 'merge', body.sections ?? null, body.datasets ?? null, !!body.takeOwnership, !!body.force,
  ]);
}

// ─── inventory helpers ──────────────────────────────────────────────────────

/** The origin dot for a replica row; null for an owned dataset. */
export function originState(d: InventoryDataset): 'online' | 'offline' | 'unknown' | null {
  if (d.owned || !d.origin) return null;
  if (d.originOnline === true) return 'online';
  if (d.originOnline === false) return 'offline';
  return 'unknown';
}

/**
 * Take over is offered on a replica whose origin is not online. When the roster is
 * unavailable (null), "not online" is unknown, so the Core requires force — and so does the UI.
 */
export function takeoverState(d: InventoryDataset): { show: boolean; needsForce: boolean } {
  const o = originState(d);
  if (o === null || o === 'online') return { show: false, needsForce: false };
  return { show: true, needsForce: o === 'unknown' };
}

// ─── plan formatting ────────────────────────────────────────────────────────

export function nonZeroBuckets(c: PlanCounts | undefined): Array<[PlanBucket, number]> {
  if (!c) return [];
  return PLAN_BUCKETS.filter((b) => (c[b] ?? 0) > 0).map((b) => [b, c[b]]);
}

export function summarizeCounts(c: PlanCounts | undefined): string {
  const nz = nonZeroBuckets(c);
  return nz.length ? nz.map(([b, n]) => `${n} ${BUCKET_LABEL[b]}`).join(' · ') : 'nothing';
}

export function writeCount(c: PlanCounts | undefined): number {
  return c ? WRITE_BUCKETS.reduce((n, b) => n + (c[b] ?? 0), 0) : 0;
}

const NEXT_STEPS: Record<string, string> = {
  REPLICA_READ_ONLY: 'This node holds a read-only replica. Import on the origin node, or tick "Take ownership" (allowed only while the origin is offline).',
  OWNER_ONLINE: 'The owner is online, and a second owner would split the dataset. Import on the owner node, or let replication bring the data here.',
  ORIGIN_ONLINE: 'The origin is online. Write there; a takeover is only for an origin that is gone.',
  ROSTER_UNAVAILABLE: 'The hub roster could not be read, so nobody can tell whether the owner is online. Retry when the hub is reachable, or tick "force" only if you know the owner is gone.',
  NOT_A_REPLICA: 'This node already owns the dataset; nothing to take over.',
  BAD_SECTION_DATA: 'The section in the bundle is malformed. Re-export it on the source node.',
  BAD_DATASET_ID: 'The bundle names a dataset id this build does not accept; it is skipped.',
  FORBIDDEN: 'System or read-only datasets are never imported.',
  NOT_SUPPORTED: 'This backend is rebuilt from source data, not imported.',
  CONFIRM_REQUIRED: 'Run Plan first, then Apply and confirm.',
  DISK_LOW: 'Free disk space on the node (or delete old bundles), then retry.',
  BUNDLE_CORRUPT: 'The bundle failed its integrity check. Export it again on the source, or re-copy it.',
  BUNDLE_FORMAT: 'The file is not an lm-assist bundle this build can read.',
  BUNDLE_TOO_LARGE: 'The bundle is over the 1 GiB cap. Export fewer sections.',
  BUNDLE_NOT_FOUND: 'The bundle is gone (deleted or pruned by retention). Refresh the list.',
  EXPORT_INCOMPLETE: 'A dataset could not be read completely. Deselect it, or retry once the node is idle.',
  FETCH_FAILED: 'The other node could not be reached through the hub. Check that it is online, then retry.',
  UPLOAD_NOT_FOUND: 'The upload expired on the node (idle for an hour). Start the upload again.',
  UPLOAD_CONFLICT: 'The node already holds a different upload under this id. Start the upload again.',
};

/** A next step for a refusal code, or null when there is nothing to add to the Core's reason. */
export function nextStep(code: string): string | null {
  return NEXT_STEPS[code] ?? null;
}

/** What the Apply confirm dialog restates before anything is written. */
export function confirmLines(r: ImportResult, targetHost: string): string[] {
  const t = r.totals;
  const lines = [
    `Policy: ${r.policy} — ${POLICY_HELP[r.policy]}`,
    `Writes to: ${targetHost}`,
    `Bundle: ${r.bundleId} (exported on ${r.source?.hostname || r.source?.nodeId || 'unknown'} at ${r.createdAt})`,
    `Planned: ${t.add} add · ${t.update} update · ${writeCount(t) === 0 ? 'no writes' : `${writeCount(t)} writes in total`}`,
    `Skipped: ${t.skipOlder + t.skipIdentical + t.skipExists + t.skipDiffers + t.skipped + t.tooLarge}`,
  ];
  if (t.neutralized) lines.push(`${t.neutralized} active mission(s) will be paused on import`);
  if (t.importedDisabled) lines.push(`${t.importedDisabled} scheduled job(s) will be imported disabled`);
  if (r.refused) lines.push(`${r.refused} section${r.refused === 1 ? '' : 's'} refused — ${r.refused === 1 ? 'it is' : 'they are'} not written`);
  return lines;
}

export function sectionsSummary(sections: readonly Pick<CompactSection, 'kind'>[] | undefined): string {
  if (!sections || sections.length === 0) return 'empty';
  const n = { dataset: 0, config: 0, files: 0 };
  for (const s of sections) n[s.kind] = (n[s.kind] ?? 0) + 1;
  const out: string[] = [];
  if (n.dataset) out.push(`${n.dataset} dataset${n.dataset === 1 ? '' : 's'}`);
  if (n.config) out.push(`${n.config} config`);
  if (n.files) out.push(`${n.files} files`);
  return out.join(' · ');
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A scheduler cadence: 1440 → "24 h", 90 → "90 min", ≤ 0 → "paused". */
export function formatInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'paused';
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** DISK_LOW and friends carry numbers; show them in words. */
export function describeDetails(e: BundleApiError): string | null {
  const d = e.details;
  if (!d) return null;
  if (e.code === 'DISK_LOW') {
    const parts: string[] = [];
    if (typeof d.freeBytes === 'number') parts.push(`free ${formatBytes(d.freeBytes)}`);
    if (typeof d.requiredBytes === 'number') parts.push(`needs ${formatBytes(d.requiredBytes)}`);
    if (typeof d.estimatedBytes === 'number') parts.push(`bundle ≈ ${formatBytes(d.estimatedBytes)}`);
    if (parts.length) return parts.join(' · ');
  }
  if (typeof d.check === 'string') return `failed check: ${d.check}`;
  if (typeof d.hostname === 'string' || typeof d.machineId === 'string') {
    return `origin ${[d.hostname, d.machineId].filter(Boolean).join(' · ')}`;
  }
  try { return JSON.stringify(d); } catch { return null; }
}
