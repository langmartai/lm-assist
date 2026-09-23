/**
 * Bundle store — the on-disk home of export bundles and uploaded/received imports.
 *
 *   <dataDir>/bundles{-dev}/            0700
 *     <bundleId>.lmbundle.gz            0600  the bundle, byte-for-byte as written/received
 *     <bundleId>.meta.json              0600  only for imported bundles: {importedFrom, via, at, name?}
 *     .uploads/<uploadId>/              0700  partial chunked uploads (swept after 1 h idle)
 *     .uploads/<uploadId>.done.json     0600  a finished upload's result, so a retried chunk is idempotent
 *
 * Paths are resolved ONLY from a validated bundleId — a caller never supplies a path. The one
 * exception is importReceived(name), which reads from the file-transfer inbox and is confined
 * to it (name regex + resolve-inside check + regular file, never a symlink).
 *
 * An imported bundle keeps its bytes verbatim (so its file sha256 still matches the source
 * node's) and is stored under a NEW bundleId; the id inside its manifest is recorded as
 * `importedFrom` in the sidecar. Every write is tmp + rename.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { getCacheDir, getDataDir } from '../../utils/path-utils';
import {
  BUNDLE_EXT, BundleError, isBundleId, newBundleId, readBundle, readBundleManifest, verifyBundleFile,
  writeBundleFile, MAX_UNCOMPRESSED_BYTES,
  type BundleEntry, type BundleInput, type BundleManifest, type ReadBundleResult, type WriteBundleResult,
} from './format';

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_BUNDLE_RETENTION = 20;
/** Max bytes per readChunk (spec: ≤ 512 KiB so relayed callers stay under relay limits). */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** Max base64 chars per upload chunk (spec: ≤ 700 KB, under the relay's 1,000,000-char body cap). */
export const MAX_UPLOAD_CHUNK_B64 = 700 * 1024;
/** Partial uploads (and finished-upload receipts) idle longer than this are swept. */
export const UPLOAD_STALE_MS = 60 * 60 * 1000;
/** Free-space floor for an export (spec: max(512 MB, 3 × estimated size)). */
export const DISK_FLOOR_BYTES = 512 * 1024 * 1024;
export const RECEIVED_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UPLOAD_ID_RE = /^upl-[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// ─── Default paths ──────────────────────────────────────────────────────────

/** `<dataDir>/bundles` (prod) / `<dataDir>/bundles-dev` (dev) — the house dev/prod split. */
export function defaultBundlesDir(): string {
  return getCacheDir('bundles');
}

/**
 * The file-transfer inbox. Mirrors file-transfer/receiver.ts `receiveRoot()` EXACTLY — it
 * hard-codes the home directory (not LM_ASSIST_DATA_DIR), and a transfer lands there.
 */
export function defaultReceivedDir(): string {
  return path.join(os.homedir(), '.lm-assist', 'received');
}

/** `bundleRetention` from project-settings.json (shared by dev and prod), else 20. */
export function readBundleRetention(settingsFile = path.join(getDataDir(), 'project-settings.json')): number {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    const n = raw?.bundleRetention;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return n;
  } catch { /* absent / unreadable → default */ }
  return DEFAULT_BUNDLE_RETENTION;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImportedMeta {
  /** bundleId inside the imported bundle's manifest (the source node's id). */
  importedFrom: string;
  via: 'upload' | 'received' | 'fetch';
  at: string;
  /** Upload/received file name, when there was one. */
  name?: string;
  /** e.g. the node a fetch came from. */
  fromNode?: string;
}

export interface StoredBundleInfo {
  bundleId: string;
  sizeBytes: number;
  mtime: string;
  createdAt?: string;
  source?: BundleManifest['source'];
  note?: string;
  sections?: BundleManifest['sections'];
  totals?: BundleManifest['totals'];
  imported?: ImportedMeta;
  /** Set when the file's manifest cannot be read; the bundle is still listed so it can be deleted. */
  error?: { code: string; message: string };
}

export interface ChunkResult {
  offset: number;
  length: number;
  total: number;
  dataB64: string;
  done: boolean;
}

export interface UploadChunkInput {
  uploadId?: string;
  index: number;
  total: number;
  name?: string;
  dataB64: string;
  /** Optional sha256 of the WHOLE file; checked when the upload assembles. */
  sha256?: string;
}

export interface UploadChunkResult {
  uploadId: string;
  received: number;
  total: number;
  done: boolean;
  /** Set once assembled + verified. */
  bundleId?: string;
  manifest?: BundleManifest;
  sizeBytes?: number;
  sha256?: string;
}

export interface StoredImportResult {
  bundleId: string;
  manifest: BundleManifest;
  sizeBytes: number;
  sha256: string;
  imported: ImportedMeta;
}

export interface DiskCheck {
  ok: boolean;
  freeBytes: number | null;
  requiredBytes: number;
  estimatedBytes: number;
}

export interface BundleStoreOptions {
  /** Store directory (default: `<dataDir>/bundles{-dev}`). */
  dir?: string;
  /** File-transfer inbox (default: mirrors receiver.ts). */
  receivedDir?: string;
  /** Retention count, or a getter read at prune time (default: project-settings `bundleRetention` ?? 20). */
  retention?: number | (() => number);
  /** Free bytes on the filesystem holding `p` (default: fs.statfsSync). null = unknown → check skipped. */
  freeBytes?: (p: string) => number | null;
  now?: () => number;
}

function defaultFreeBytes(p: string): number | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number | bigint; bsize: number | bigint } }).statfsSync;
  if (typeof statfs !== 'function') return null; // Node < 18.15 — cannot measure, do not block
  try {
    const s = statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class BundleStore {
  private readonly baseDir: string;
  private readonly inbox: string;
  private readonly retention: () => number;
  private readonly free: (p: string) => number | null;
  private readonly now: () => number;
  /** Per-uploadId serialization so two concurrent final chunks cannot both assemble. */
  private readonly uploadLocks = new Map<string, Promise<unknown>>();

  constructor(opts: BundleStoreOptions = {}) {
    this.baseDir = path.resolve(opts.dir ?? defaultBundlesDir());
    this.inbox = path.resolve(opts.receivedDir ?? defaultReceivedDir());
    const r = opts.retention;
    this.retention = typeof r === 'function' ? r : typeof r === 'number' ? () => r : () => readBundleRetention();
    this.free = opts.freeBytes ?? defaultFreeBytes;
    this.now = opts.now ?? Date.now;
  }

  /** The store directory, created 0700 on first use. */
  dir(): string {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.baseDir, 0o700); } catch { /* best effort */ }
    return this.baseDir;
  }

  private uploadsDir(): string {
    const d = path.join(this.dir(), '.uploads');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  /** Absolute path for a VALIDATED bundleId (the file need not exist). */
  pathFor(bundleId: string): string {
    if (!isBundleId(bundleId)) {
      throw new BundleError('BUNDLE_ID_INVALID', `invalid bundle id ${JSON.stringify(bundleId)} — expected lmb-<yyyymmdd>-<hhmmss>-<6 hex>`);
    }
    return path.join(this.baseDir, `${bundleId}${BUNDLE_EXT}`);
  }

  private metaPathFor(bundleId: string): string {
    return path.join(this.baseDir, `${bundleId}.meta.json`);
  }

  /** Path of an EXISTING bundle; BUNDLE_NOT_FOUND otherwise. */
  resolveExisting(bundleId: string): string {
    const p = this.pathFor(bundleId);
    if (!fs.existsSync(p)) throw new BundleError('BUNDLE_NOT_FOUND', `no stored bundle ${bundleId}`);
    return p;
  }

  exists(bundleId: string): boolean {
    return isBundleId(bundleId) && fs.existsSync(this.pathFor(bundleId));
  }

  /** Stored bundle ids, newest first (the id embeds its UTC creation time). */
  private ids(): string[] {
    let names: string[];
    try { names = fs.readdirSync(this.baseDir); } catch { return []; }
    return names
      .filter((n) => n.endsWith(BUNDLE_EXT))
      .map((n) => n.slice(0, -BUNDLE_EXT.length))
      .filter(isBundleId)
      .sort()
      .reverse();
  }

  /** Every stored bundle with its manifest summary. A corrupt file is listed with `error`. */
  async list(): Promise<StoredBundleInfo[]> {
    const out: StoredBundleInfo[] = [];
    for (const id of this.ids()) {
      const p = this.pathFor(id);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; } // deleted mid-listing
      const info: StoredBundleInfo = { bundleId: id, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      const meta = readJson<ImportedMeta>(this.metaPathFor(id));
      if (meta) info.imported = meta;
      try {
        const m = await readBundleManifest(p);
        info.createdAt = m.createdAt;
        info.source = m.source;
        if (m.note !== undefined) info.note = m.note;
        info.sections = m.sections;
        info.totals = m.totals;
      } catch (e) {
        info.error = { code: (e as BundleError).code ?? 'BUNDLE_CORRUPT', message: (e as Error).message };
      }
      out.push(info);
    }
    return out;
  }

  /** The manifest (fast read; NOT an integrity check — see verify). */
  async getManifest(bundleId: string): Promise<BundleManifest> {
    return readBundleManifest(this.resolveExisting(bundleId));
  }

  getImportedMeta(bundleId: string): ImportedMeta | null {
    this.pathFor(bundleId);
    return readJson<ImportedMeta>(this.metaPathFor(bundleId));
  }

  /** Full integrity check. */
  async verify(bundleId: string) {
    return verifyBundleFile(this.resolveExisting(bundleId));
  }

  /** Read + verify, entries grouped by section. */
  async read(bundleId: string): Promise<ReadBundleResult> {
    return readBundle(this.resolveExisting(bundleId));
  }

  /** Delete a stored bundle (and its sidecar). false when it did not exist. */
  delete(bundleId: string): boolean {
    const p = this.pathFor(bundleId);
    let removed = false;
    try { fs.unlinkSync(p); removed = true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try { fs.unlinkSync(this.metaPathFor(bundleId)); } catch { /* no sidecar */ }
    return removed;
  }

  /** Keep the newest `keep` bundles; delete the rest. Returns the deleted ids (oldest last). */
  prune(keep: number = this.retention()): string[] {
    const k = Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_BUNDLE_RETENTION;
    const doomed = this.ids().slice(k);
    for (const id of doomed) this.delete(id);
    return doomed;
  }

  // ─── disk ──────────────────────────────────────────────────────────────

  /** Free space vs `max(512 MB, 3 × estimatedBytes)` on the store's filesystem. */
  checkDiskSpace(estimatedBytes: number): DiskCheck {
    const requiredBytes = Math.max(DISK_FLOOR_BYTES, 3 * Math.max(0, estimatedBytes));
    const freeBytes = this.free(this.dir());
    return { ok: freeBytes === null || freeBytes >= requiredBytes, freeBytes, requiredBytes, estimatedBytes };
  }

  /** Throw DISK_LOW (with the numbers) when checkDiskSpace fails. */
  assertDiskSpace(estimatedBytes: number): DiskCheck {
    const c = this.checkDiskSpace(estimatedBytes);
    if (!c.ok) {
      throw new BundleError('DISK_LOW',
        `not enough free disk for a bundle: ${c.freeBytes} bytes free, ${c.requiredBytes} required ` +
        `(max(512 MB, 3 × ~${estimatedBytes} estimated))`,
        undefined, { freeBytes: c.freeBytes, requiredBytes: c.requiredBytes, estimatedBytes });
    }
    return c;
  }

  // ─── write ─────────────────────────────────────────────────────────────

  private freshId(): string {
    for (let i = 0; i < 16; i++) {
      const id = newBundleId(new Date(this.now()));
      if (!fs.existsSync(this.pathFor(id))) return id;
    }
    throw new Error('could not mint a free bundle id');
  }

  /**
   * Write a new bundle. `input.bundleId` is minted when absent. The free-disk check runs on the
   * computed manifest before any byte is written; retention prunes afterwards.
   */
  async writeBundle(
    input: Omit<BundleInput, 'bundleId' | 'createdAt'> & { bundleId?: string; createdAt?: string },
    entries: readonly BundleEntry[],
  ): Promise<WriteBundleResult & { bundleId: string; pruned: string[] }> {
    this.dir();
    const bundleId = input.bundleId ?? this.freshId();
    const file = this.pathFor(bundleId);
    if (fs.existsSync(file)) throw new Error(`bundle ${bundleId} already exists`);
    const full: BundleInput = { ...input, bundleId, createdAt: input.createdAt ?? new Date(this.now()).toISOString() };
    const res = await writeBundleFile(file, full, entries, {
      beforeWrite: (m) => { this.assertDiskSpace(m.totals.uncompressedBytes); },
    });
    const pruned = this.prune().filter((id) => id !== bundleId);
    return { ...res, bundleId, pruned };
  }

  // ─── chunked read ──────────────────────────────────────────────────────

  readChunk(bundleId: string, offset: number, length: number = MAX_CHUNK_BYTES): ChunkResult {
    const p = this.resolveExisting(bundleId);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BundleError('INVALID_RANGE', `offset must be an integer ≥ 0 (got ${offset})`);
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) {
      throw new BundleError('INVALID_RANGE', `length must be an integer 1..${MAX_CHUNK_BYTES} (got ${length})`);
    }
    const total = fs.statSync(p).size;
    if (offset > total) {
      throw new BundleError('INVALID_RANGE', `offset ${offset} is past the end (${total} bytes)`, undefined, { total });
    }
    const n = Math.min(length, total - offset);
    const buf = Buffer.alloc(n);
    if (n > 0) {
      const fd = fs.openSync(p, 'r');
      try { fs.readSync(fd, buf, 0, n, offset); } finally { fs.closeSync(fd); }
    }
    return { offset, length: n, total, dataB64: buf.toString('base64'), done: offset + n >= total };
  }

  // ─── store an externally produced file ─────────────────────────────────

  /**
   * Verify `src` (a candidate bundle file) and move/copy it into the store under a NEW
   * bundleId. `move` renames (src must be on the same filesystem — the store's own tmp files).
   */
  private async adopt(src: string, move: boolean, meta: Omit<ImportedMeta, 'importedFrom' | 'at'>): Promise<StoredImportResult> {
    const { manifest } = await verifyBundleFile(src);
    const bundleId = this.freshId();
    const dest = this.pathFor(bundleId);
    if (move) {
      fs.renameSync(src, dest);
    } else {
      const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
    }
    try { fs.chmodSync(dest, 0o600); } catch { /* best effort */ }
    const imported: ImportedMeta = { ...meta, importedFrom: manifest.bundleId, at: new Date(this.now()).toISOString() };
    writeJsonAtomic(this.metaPathFor(bundleId), imported);
    const sizeBytes = fs.statSync(dest).size;
    const sha256 = sha256File(dest);
    this.prune();
    return { bundleId, manifest, sizeBytes, sha256, imported };
  }

  /**
   * Store a bundle fetched from another node (already written to a local tmp file by the
   * caller). The file is verified first; `src` is left in place.
   */
  async importFile(src: string, meta: Omit<ImportedMeta, 'importedFrom' | 'at'>): Promise<StoredImportResult> {
    this.dir();
    return this.adopt(src, false, meta);
  }

  /**
   * Import ONE file from the file-transfer inbox into the store (verified first). The name must
   * match RECEIVED_NAME_RE, resolve directly inside the inbox, and be a regular file.
   */
  async importReceived(name: string): Promise<StoredImportResult> {
    if (typeof name !== 'string' || !RECEIVED_NAME_RE.test(name) || name === '.' || name === '..') {
      throw new BundleError('RECEIVED_NAME_INVALID', `received file name must match ${RECEIVED_NAME_RE} (got ${JSON.stringify(name)})`);
    }
    const root = this.inbox;
    const p = path.resolve(root, name);
    if (path.dirname(p) !== root) {
      throw new BundleError('RECEIVED_NAME_INVALID', `received file ${JSON.stringify(name)} does not resolve inside the inbox`);
    }
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch {
      throw new BundleError('RECEIVED_NOT_FOUND', `no received file ${JSON.stringify(name)}`);
    }
    if (!st.isFile()) {
      throw new BundleError('RECEIVED_NAME_INVALID', `received ${JSON.stringify(name)} is not a regular file`);
    }
    this.dir();
    this.assertDiskSpace(st.size);
    return this.adopt(p, false, { via: 'received', name });
  }

  // ─── chunked upload ────────────────────────────────────────────────────

  private withUploadLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.uploadLocks.get(uploadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.uploadLocks.set(uploadId, tail);
    void tail.then(() => { if (this.uploadLocks.get(uploadId) === tail) this.uploadLocks.delete(uploadId); });
    return next;
  }

  /**
   * Remove partial uploads and finished-upload receipts idle for longer than `maxAgeMs`, plus
   * tmp files a crashed write/assembly left in the store dir.
   */
  sweepUploads(maxAgeMs: number = UPLOAD_STALE_MS): string[] {
    const cutoff = this.now() - maxAgeMs;
    const swept: string[] = [];
    let top: string[] = [];
    try { top = fs.readdirSync(this.baseDir); } catch { /* no store yet */ }
    for (const n of top.filter((x) => /\.tmp(-|$)/.test(x))) {
      const p = path.join(this.baseDir, n);
      try {
        if (fs.statSync(p).mtimeMs >= cutoff) continue;
        fs.rmSync(p, { force: true });
        swept.push(n);
      } catch { /* raced */ }
    }
    const d = path.join(this.baseDir, '.uploads');
    let names: string[];
    try { names = fs.readdirSync(d); } catch { return swept; }
    for (const n of names) {
      const p = path.join(d, n);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) continue;
        fs.rmSync(p, { recursive: true, force: true });
        swept.push(n);
      } catch { /* raced */ }
    }
    return swept;
  }

  /**
   * Accept one chunk. Chunks are idempotent per (uploadId, index): a retry with the same bytes
   * is a no-op, different bytes are refused (UPLOAD_CONFLICT). When every index 0..total-1 is
   * present the file is assembled, verified (manifest, end hash, sections, optional whole-file
   * sha256) and stored under a NEW bundleId. A retry after completion returns the same result.
   */
  async uploadChunk(input: UploadChunkInput): Promise<UploadChunkResult> {
    const { index, total, dataB64 } = input;
    if (!Number.isInteger(total) || total < 1 || total > 100_000) {
      throw new BundleError('UPLOAD_INVALID', `total must be an integer 1..100000 (got ${total})`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new BundleError('UPLOAD_INVALID', `index must be an integer 0..${total - 1} (got ${index})`);
    }
    if (typeof dataB64 !== 'string' || dataB64.length === 0 || dataB64.length > MAX_UPLOAD_CHUNK_B64
      || dataB64.length % 4 !== 0 || !B64_RE.test(dataB64)) {
      throw new BundleError('UPLOAD_INVALID', `dataB64 must be non-empty base64 of at most ${MAX_UPLOAD_CHUNK_B64} chars`);
    }
    if (input.sha256 !== undefined && !(typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(input.sha256))) {
      throw new BundleError('UPLOAD_INVALID', 'sha256 must be 64 hex chars');
    }
    if (input.name !== undefined && !(typeof input.name === 'string' && input.name.length <= 256)) {
      throw new BundleError('UPLOAD_INVALID', 'name must be a string of at most 256 chars');
    }
    let uploadId = input.uploadId;
    if (uploadId === undefined) {
      if (index !== 0) throw new BundleError('UPLOAD_INVALID', 'uploadId is required after the first chunk (index 0 mints it)');
      uploadId = `upl-${crypto.randomBytes(8).toString('hex')}`;
    } else if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) {
      throw new BundleError('UPLOAD_INVALID', `uploadId must match ${UPLOAD_ID_RE}`);
    }
    const id = uploadId;
    this.sweepUploads();
    return this.withUploadLock(id, () => this.acceptChunk(id, input));
  }

  private async acceptChunk(uploadId: string, input: UploadChunkInput): Promise<UploadChunkResult> {
    const ups = this.uploadsDir();
    const receiptFile = path.join(ups, `${uploadId}.done.json`);
    const receipt = readJson<UploadChunkResult>(receiptFile);
    if (receipt) {
      if (receipt.total !== input.total) throw new BundleError('UPLOAD_CONFLICT', `upload ${uploadId} finished with total ${receipt.total}`);
      return receipt; // a retried chunk of a finished upload
    }

    const dir = path.join(ups, uploadId);
    const metaFile = path.join(dir, 'upload.json');
    type UploadMeta = { total: number; name?: string; sha256?: string; createdAt: string };
    let meta = readJson<UploadMeta>(metaFile);
    if (!meta) {
      if (input.uploadId !== undefined && input.index !== 0 && !fs.existsSync(dir)) {
        // A continuation of an upload we have never seen (or that was swept).
        throw new BundleError('UPLOAD_NOT_FOUND', `no upload ${uploadId} in progress (swept after 1 h idle?) — restart from index 0`);
      }
      const data = Buffer.from(input.dataB64, 'base64');
      this.assertDiskSpace(data.length * input.total);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      meta = { total: input.total, createdAt: new Date(this.now()).toISOString() };
    }
    if (meta.total !== input.total) {
      throw new BundleError('UPLOAD_CONFLICT', `upload ${uploadId} has total ${meta.total}, chunk says ${input.total}`);
    }
    if (input.name !== undefined) meta.name = input.name;
    if (input.sha256 !== undefined) {
      const s = input.sha256.toLowerCase();
      if (meta.sha256 && meta.sha256 !== s) throw new BundleError('UPLOAD_CONFLICT', `upload ${uploadId} already declared a different sha256`);
      meta.sha256 = s;
    }
    writeJsonAtomic(metaFile, meta); // also refreshes the idle clock the sweeper reads

    const data = Buffer.from(input.dataB64, 'base64');
    const part = path.join(dir, `${input.index}.part`);
    if (fs.existsSync(part)) {
      if (!fs.readFileSync(part).equals(data)) {
        throw new BundleError('UPLOAD_CONFLICT', `chunk ${input.index} of ${uploadId} was already received with different bytes`);
      }
    } else {
      const tmp = `${part}.tmp`;
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, part);
    }
    try { fs.utimesSync(dir, new Date(this.now()), new Date(this.now())); } catch { /* sweeper falls back to meta mtime */ }

    const have = fs.readdirSync(dir).filter((n) => /^\d+\.part$/.test(n)).length;
    if (have < meta.total) return { uploadId, received: have, total: meta.total, done: false };

    // Assemble in index order into a tmp file inside the store dir (same fs → rename into place).
    const assembled = path.join(this.dir(), `.upload-${uploadId}.tmp`);
    let bytes = 0;
    const fd = fs.openSync(assembled, 'w', 0o600);
    try {
      for (let i = 0; i < meta.total; i++) {
        const b = fs.readFileSync(path.join(dir, `${i}.part`));
        bytes += b.length;
        if (bytes > MAX_UNCOMPRESSED_BYTES) {
          throw new BundleError('BUNDLE_TOO_LARGE', `upload exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`);
        }
        fs.writeSync(fd, b);
      }
    } catch (e) {
      fs.closeSync(fd);
      try { fs.unlinkSync(assembled); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    fs.closeSync(fd);
    try {
      if (meta.sha256) {
        const got = sha256File(assembled);
        if (got !== meta.sha256) {
          throw new BundleError('UPLOAD_SHA_MISMATCH', `assembled upload sha256 ${got} does not match the declared ${meta.sha256}`,
            undefined, { expected: meta.sha256, actual: got });
        }
      }
      const stored = await this.adopt(assembled, true, { via: 'upload', ...(meta.name ? { name: meta.name } : {}) });
      const result: UploadChunkResult = {
        uploadId, received: meta.total, total: meta.total, done: true,
        bundleId: stored.bundleId, manifest: stored.manifest, sizeBytes: stored.sizeBytes, sha256: stored.sha256,
      };
      writeJsonAtomic(receiptFile, result);
      return result;
    } catch (e) {
      try { fs.unlinkSync(assembled); } catch { /* moved or gone */ }
      throw e;
    } finally {
      // Bad bytes do not get better on retry: drop the partial either way.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: BundleStore | null = null;

export function getBundleStore(): BundleStore {
  if (!instance) instance = new BundleStore();
  return instance;
}

/** Tests only: swap the singleton (null resets to the default on next get). */
export function _setBundleStoreForTests(s: BundleStore | null): void {
  instance = s;
}
