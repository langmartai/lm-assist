/**
 * Bundle file format — a gzip of UTF-8 JSON Lines (spec: "Bundle format").
 *
 *   line 1   {"t":"manifest", ...}          sections[] carry per-section count + sha256
 *   line 2.. {"t":"dataset"|"record"|"config"|"file", ...}
 *   last     {"t":"end","entries":N,"sha256":<sha256 of every preceding line incl. its \n>}
 *
 * There is no tar, so there are no member paths to traverse, and a bundle reads line by
 * line: `zcat x.lmbundle.gz | head -1 | jq` shows the manifest.
 *
 * The manifest is the FIRST line but carries hashes of everything after it, so the writer
 * is two-pass over the entries it is handed: pass 1 serializes each entry to fold its
 * hash/count/bytes into the section summaries (and throws away the string), pass 2
 * serializes again and streams it through gzip. JSON.stringify is deterministic for an
 * unmutated object, so both passes produce the same bytes. Sizes are single-digit MB today
 * and the uncompressed cap is 1 GiB, so holding the entry OBJECTS in memory is fine; the
 * serialized form is never held whole.
 *
 * The reader verifies everything it can before handing anything back: the end line's
 * count and hash, the manifest totals, and every section's count and hash. A failure is a
 * coded BundleError — BUNDLE_CORRUPT names the check that failed, so "truncated" and
 * "flipped byte" are distinguishable in a support thread.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { DataRecord, DatasetDescriptor, NodeOrigin } from '../types';

// ─── Constants ──────────────────────────────────────────────────────────────

export const BUNDLE_FORMAT_NAME = 'lm-assist-bundle';
export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_EXT = '.lmbundle.gz';
/** A single JSON line may not exceed this (spec: 16 MiB). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** The whole decompressed stream may not exceed this (spec: 1 GiB). */
export const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** `lmb-<yyyymmdd>-<hhmmss>-<6 hex>` — the ONLY name accepted for a stored bundle. */
export const BUNDLE_ID_RE = /^lmb-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

export function isBundleId(x: unknown): x is string {
  return typeof x === 'string' && BUNDLE_ID_RE.test(x);
}

/** Mint a bundle id from a UTC timestamp plus 3 random bytes. */
export function newBundleId(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-09-23T10:15:00.000Z
  const ymd = iso.slice(0, 10).replace(/-/g, '');
  const hms = iso.slice(11, 19).replace(/:/g, '');
  return `lmb-${ymd}-${hms}-${crypto.randomBytes(3).toString('hex')}`;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type BundleErrorCode =
  | 'BUNDLE_CORRUPT'     // failed an integrity check — `check` names which
  | 'BUNDLE_TOO_LARGE'   // a line or the whole stream exceeds its cap
  | 'BUNDLE_FORMAT'      // not a bundle, or a formatVersion this build does not read
  | 'BUNDLE_NOT_FOUND'
  | 'BUNDLE_ID_INVALID'
  | 'DISK_LOW'
  | 'INVALID_RANGE'
  | 'UPLOAD_INVALID'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_CONFLICT'
  | 'UPLOAD_SHA_MISMATCH'
  | 'RECEIVED_NAME_INVALID'
  | 'RECEIVED_NOT_FOUND';

export class BundleError extends Error {
  constructor(
    public readonly code: BundleErrorCode,
    message: string,
    /** For BUNDLE_CORRUPT: the check that failed (e.g. `end-hash`, `section-hash:dataset:backlog`). */
    public readonly check?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

function corrupt(check: string, message: string, details?: Record<string, unknown>): BundleError {
  return new BundleError('BUNDLE_CORRUPT', `bundle corrupt (${check}): ${message}`, check, details);
}

// ─── Line types ─────────────────────────────────────────────────────────────

export type SectionKind = 'dataset' | 'config' | 'files';
export type FilesSectionId = 'knowledge' | 'claude-memory' | 'claude-rules';

export interface BundleSource {
  nodeId: string;
  hostname: string;
  platform: string;
  lmAssistVersion: string;
  mode: 'prod' | 'dev';
  cluster?: string;
}

export interface SectionSummary {
  kind: SectionKind;
  id: string;
  title: string;
  /** dataset: record lines · config: entries · files: files. The descriptor line is not counted. */
  count: number;
  /** Bytes of every line in the section, including the dataset descriptor line and each '\n'. */
  bytes: number;
  /** sha256 over the section's lines (each incl. its '\n'), in file order. */
  sha256: string;
  warnings: string[];
  // dataset sections only
  tombstones?: number;
  owned?: boolean;
  origin?: NodeOrigin;
  scope?: string;
  syncMode?: string;
  backend?: string;
  // config sections only: dotted paths of keys dropped as secret-named
  redactedKeys?: string[];
}

export interface BundleManifest {
  t: 'manifest';
  format: typeof BUNDLE_FORMAT_NAME;
  formatVersion: number;
  bundleId: string;
  createdAt: string;
  source: BundleSource;
  options: Record<string, unknown>;
  sections: SectionSummary[];
  /** entries = lines between manifest and end; uncompressedBytes = their bytes incl. '\n'. */
  totals: { entries: number; uncompressedBytes: number };
  note?: string;
}

export interface DatasetEntry {
  t: 'dataset';
  id: string;
  descriptor: DatasetDescriptor;
  replicaOf?: NodeOrigin;
}

export interface RecordEntry {
  t: 'record';
  ds: string;
  r: DataRecord;
}

export interface ConfigEntry {
  t: 'config';
  id: string;
  data: unknown;
}

/** One file of a files section, as carried in a `file` line (minus `t`/`section`). */
export interface BundleFile {
  /** Relative POSIX path under the section's root. */
  path: string;
  mtime: string;
  size: number;
  sha256: string;
  content: string;
}

export interface FileEntry extends BundleFile {
  t: 'file';
  section: FilesSectionId;
}

export interface EndLine {
  t: 'end';
  entries: number;
  sha256: string;
}

export type BundleEntry = DatasetEntry | RecordEntry | ConfigEntry | FileEntry;

/** The (kind, id) section a line belongs to. */
export function sectionOf(e: BundleEntry): { kind: SectionKind; id: string } {
  switch (e.t) {
    case 'dataset': return { kind: 'dataset', id: e.id };
    case 'record': return { kind: 'dataset', id: e.ds };
    case 'config': return { kind: 'config', id: e.id };
    case 'file': return { kind: 'files', id: e.section };
  }
}

const sectionKey = (kind: string, id: string): string => `${kind}:${id}`;

// ─── Writer ─────────────────────────────────────────────────────────────────

/** Caller-provided section metadata; the writer fills count/bytes/sha256/tombstones. */
export type SectionSummaryInput =
  Omit<SectionSummary, 'count' | 'bytes' | 'sha256' | 'warnings'> & { warnings?: string[] };

export interface BundleInput {
  bundleId: string;
  createdAt: string;
  source: BundleSource;
  options?: Record<string, unknown>;
  note?: string;
  /** Section order + metadata. A section that has entries but no summary here gets a bare one. */
  sections?: SectionSummaryInput[];
}

export interface BundleLimits {
  maxLineBytes?: number;
  maxUncompressedBytes?: number;
}

function serialize(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
}

function validateEntries(entries: readonly BundleEntry[]): void {
  const declared = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== 'object' || !['dataset', 'record', 'config', 'file'].includes((e as BundleEntry).t)) {
      throw new Error(`bundle writer: unknown entry type ${JSON.stringify((e as { t?: unknown })?.t)}`);
    }
    if (e.t === 'dataset') declared.add(e.id);
    if (e.t === 'record' && !declared.has(e.ds)) {
      throw new Error(`bundle writer: record for dataset "${e.ds}" precedes (or lacks) its dataset line`);
    }
  }
}

/**
 * Pass 1: compute the full manifest (section counts/bytes/hashes, totals) for these entries.
 * Throws BUNDLE_TOO_LARGE when a line or the total would exceed its cap, before any write.
 */
export function summarizeBundle(input: BundleInput, entries: readonly BundleEntry[], limits: BundleLimits = {}): BundleManifest {
  const maxLine = limits.maxLineBytes ?? MAX_LINE_BYTES;
  const maxTotal = limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;
  validateEntries(entries);

  const acc = new Map<string, { summary: SectionSummary; hash: crypto.Hash }>();
  const order: string[] = [];
  const ensure = (kind: SectionKind, id: string, base?: SectionSummaryInput) => {
    const key = sectionKey(kind, id);
    let s = acc.get(key);
    if (!s) {
      const summary: SectionSummary = {
        ...(base || { kind, id, title: id }),
        kind, id,
        title: base?.title ?? id,
        count: 0, bytes: 0, sha256: '',
        warnings: [...(base?.warnings ?? [])],
      };
      if (kind === 'dataset') summary.tombstones = 0;
      s = { summary, hash: crypto.createHash('sha256') };
      acc.set(key, s);
      order.push(key);
    }
    return s;
  };
  for (const s of input.sections ?? []) ensure(s.kind, s.id, s);

  let total = 0;
  for (const e of entries) {
    const buf = serialize(e);
    if (buf.length > maxLine) {
      throw new BundleError('BUNDLE_TOO_LARGE', `a ${e.t} line is ${buf.length} bytes; the cap is ${maxLine}`, 'line-cap', { bytes: buf.length, limit: maxLine });
    }
    total += buf.length;
    if (total > maxTotal) {
      throw new BundleError('BUNDLE_TOO_LARGE', `bundle exceeds ${maxTotal} uncompressed bytes`, 'total-cap', { limit: maxTotal });
    }
    const { kind, id } = sectionOf(e);
    const s = ensure(kind, id);
    s.hash.update(buf);
    s.summary.bytes += buf.length;
    if (e.t !== 'dataset') s.summary.count += 1;
    if (e.t === 'record' && e.r?.deleted === true) s.summary.tombstones = (s.summary.tombstones ?? 0) + 1;
  }

  const sections = order.map((k) => {
    const s = acc.get(k)!;
    return { ...s.summary, sha256: s.hash.digest('hex') };
  });
  const manifest: BundleManifest = {
    t: 'manifest',
    format: BUNDLE_FORMAT_NAME,
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId: input.bundleId,
    createdAt: input.createdAt,
    source: input.source,
    options: input.options ?? {},
    sections,
    totals: { entries: entries.length, uncompressedBytes: total },
  };
  if (input.note !== undefined) manifest.note = input.note;
  return manifest;
}

export interface WriteBundleResult {
  path: string;
  manifest: BundleManifest;
  /** Compressed file size. */
  sizeBytes: number;
  /** sha256 of the compressed file. */
  sha256: string;
}

/**
 * Write a bundle to `file` atomically (tmp + rename, mode 0600). `beforeWrite` sees the
 * computed manifest before a byte hits the disk — the store uses it for the free-space check.
 */
export async function writeBundleFile(
  file: string,
  input: BundleInput,
  entries: readonly BundleEntry[],
  opts: BundleLimits & { beforeWrite?: (m: BundleManifest) => void | Promise<void> } = {},
): Promise<WriteBundleResult> {
  const manifest = summarizeBundle(input, entries, opts);
  if (opts.beforeWrite) await opts.beforeWrite(manifest);

  function* lines(): Generator<Buffer> {
    const endHash = crypto.createHash('sha256');
    const m = serialize(manifest);
    endHash.update(m);
    yield m;
    for (const e of entries) {
      const b = serialize(e);
      endHash.update(b);
      yield b;
    }
    const end: EndLine = { t: 'end', entries: entries.length, sha256: endHash.digest('hex') };
    yield serialize(end);
  }

  const fileHash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) { fileHash.update(chunk); sizeBytes += chunk.length; cb(null, chunk); },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await pipeline(Readable.from(lines()), zlib.createGzip(), tap, fs.createWriteStream(tmp, { mode: 0o600 }));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return { path: file, manifest, sizeBytes, sha256: fileHash.digest('hex') };
}

// ─── Reader ─────────────────────────────────────────────────────────────────

function checkMagic(file: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BundleError('BUNDLE_NOT_FOUND', `no bundle at ${path.basename(file)}`);
    throw e;
  }
  try {
    const head = Buffer.alloc(2);
    const n = fs.readSync(fd, head, 0, 2, 0);
    if (n < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
      throw new BundleError('BUNDLE_FORMAT', 'not a gzip file — not an lm-assist bundle', 'gzip-magic');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateManifest(obj: unknown): BundleManifest {
  const m = obj as Partial<BundleManifest> | null;
  if (!m || typeof m !== 'object' || m.t !== 'manifest' || m.format !== BUNDLE_FORMAT_NAME) {
    throw new BundleError('BUNDLE_FORMAT', 'first line is not an lm-assist-bundle manifest', 'manifest');
  }
  if (m.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new BundleError('BUNDLE_FORMAT',
      `formatVersion ${JSON.stringify(m.formatVersion)} is not supported (this build reads ${BUNDLE_FORMAT_VERSION})`,
      'format-version', { formatVersion: m.formatVersion });
  }
  if (typeof m.bundleId !== 'string' || !Array.isArray(m.sections) || !m.totals || typeof m.totals !== 'object') {
    throw new BundleError('BUNDLE_FORMAT', 'manifest is missing bundleId/sections/totals', 'manifest-shape');
  }
  return m as BundleManifest;
}

/**
 * Yield the decompressed stream line by line as raw Buffers (without the '\n'), plus a flag
 * saying whether the line was newline-terminated. Enforces both caps while accumulating, so a
 * hostile line is refused before it is concatenated.
 */
async function* rawLines(file: string, limits: BundleLimits): AsyncGenerator<{ buf: Buffer; terminated: boolean }> {
  const maxLine = limits.maxLineBytes ?? MAX_LINE_BYTES;
  const maxTotal = limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;
  checkMagic(file);
  const rs = fs.createReadStream(file);
  const gz = zlib.createGunzip();
  rs.on('error', (e) => gz.destroy(e));
  rs.pipe(gz);
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let total = 0;
  try {
    for await (const chunk of gz as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxTotal) {
        throw new BundleError('BUNDLE_TOO_LARGE', `bundle exceeds ${maxTotal} uncompressed bytes`, 'total-cap', { limit: maxTotal });
      }
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        const segLen = (nl === -1 ? chunk.length : nl) - start;
        if (pendingLen + segLen > maxLine) {
          throw new BundleError('BUNDLE_TOO_LARGE', `a line exceeds ${maxLine} bytes`, 'line-cap', { limit: maxLine });
        }
        if (nl === -1) {
          if (segLen > 0) { pending.push(chunk.subarray(start)); pendingLen += segLen; }
          break;
        }
        const seg = chunk.subarray(start, nl);
        const line = pending.length ? Buffer.concat([...pending, seg]) : seg;
        pending = []; pendingLen = 0;
        yield { buf: line, terminated: true };
        start = nl + 1;
      }
    }
  } catch (e) {
    if (e instanceof BundleError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BundleError('BUNDLE_NOT_FOUND', `no bundle at ${path.basename(file)}`);
    // zlib: Z_BUF_ERROR "unexpected end of file" (truncated) / Z_DATA_ERROR (flipped byte).
    throw corrupt(code === 'Z_BUF_ERROR' ? 'gzip-truncated' : 'gzip', (e as Error).message);
  } finally {
    rs.destroy();
    gz.destroy();
  }
  if (pendingLen > 0) yield { buf: Buffer.concat(pending), terminated: false };
}

function parseLine(buf: Buffer, lineNo: number): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw corrupt('json', `line ${lineNo} is not valid JSON (truncated or damaged)`, { line: lineNo });
  }
}

const ENTRY_TYPES = new Set(['dataset', 'record', 'config', 'file']);

export interface ScanResult {
  manifest: BundleManifest;
  entries: number;
  uncompressedBytes: number;
}

/**
 * Stream a bundle and verify it end to end. `onEntry` sees each entry line as it is read —
 * it runs BEFORE the end/section checks, so a consumer must discard what it collected when
 * this throws (readBundle does).
 */
export async function scanBundle(
  file: string,
  opts: BundleLimits & { onEntry?: (e: BundleEntry) => void } = {},
): Promise<ScanResult> {
  let manifest: BundleManifest | null = null;
  let end: EndLine | null = null;
  let lineNo = 0;
  let entries = 0;
  let entryBytes = 0;
  const endHash = crypto.createHash('sha256');
  const seen = new Map<string, { hash: crypto.Hash; count: number; hasDescriptor: boolean }>();

  for await (const { buf, terminated } of rawLines(file, opts)) {
    lineNo++;
    if (end) {
      if (buf.length === 0) continue;
      throw corrupt('trailing-data', `data after the end line (line ${lineNo})`, { line: lineNo });
    }
    if (!manifest) {
      let obj: unknown;
      try { obj = JSON.parse(buf.toString('utf8')); } catch {
        throw new BundleError('BUNDLE_FORMAT', 'first line is not JSON — not an lm-assist bundle', 'manifest');
      }
      manifest = validateManifest(obj);
      endHash.update(buf); endHash.update('\n');
      continue;
    }
    const obj = parseLine(buf, lineNo) as { t?: unknown };
    if (obj && typeof obj === 'object' && obj.t === 'end') {
      end = obj as EndLine;
      continue;
    }
    if (!terminated) throw corrupt('truncated', `line ${lineNo} is not newline-terminated and is not the end line`);
    if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string' || !ENTRY_TYPES.has(obj.t)) {
      throw corrupt('entry-type', `line ${lineNo} has unknown type ${JSON.stringify(obj?.t)}`, { line: lineNo });
    }
    const e = obj as BundleEntry;
    const { kind, id } = sectionOf(e);
    if (typeof id !== 'string') throw corrupt('entry-shape', `line ${lineNo} (${e.t}) has no section id`, { line: lineNo });
    const key = sectionKey(kind, id);
    let s = seen.get(key);
    if (!s) { s = { hash: crypto.createHash('sha256'), count: 0, hasDescriptor: false }; seen.set(key, s); }
    s.hash.update(buf); s.hash.update('\n');
    if (e.t === 'dataset') s.hasDescriptor = true; else s.count++;
    if (e.t === 'record' && !s.hasDescriptor) {
      throw corrupt('record-without-dataset', `line ${lineNo}: record for "${id}" before its dataset line`, { line: lineNo });
    }
    endHash.update(buf); endHash.update('\n');
    entries++;
    entryBytes += buf.length + 1;
    opts.onEntry?.(e);
  }

  if (!manifest) throw new BundleError('BUNDLE_FORMAT', 'empty bundle — no manifest line', 'manifest');
  if (!end) throw corrupt('truncated', 'no end line — the bundle is truncated');
  if (end.entries !== entries) {
    throw corrupt('end-count', `end line says ${end.entries} entries, read ${entries}`, { expected: end.entries, actual: entries });
  }
  const digest = endHash.digest('hex');
  if (end.sha256 !== digest) throw corrupt('end-hash', 'sha256 over the bundle lines does not match the end line');
  if (manifest.totals.entries !== entries) {
    throw corrupt('manifest-count', `manifest says ${manifest.totals.entries} entries, read ${entries}`);
  }
  if (manifest.totals.uncompressedBytes !== entryBytes) {
    throw corrupt('manifest-bytes', `manifest says ${manifest.totals.uncompressedBytes} bytes, read ${entryBytes}`);
  }
  const declared = new Set<string>();
  for (const s of manifest.sections) {
    const key = sectionKey(s.kind, s.id);
    declared.add(key);
    const got = seen.get(key);
    const count = got?.count ?? 0;
    const hash = got ? got.hash.digest('hex') : crypto.createHash('sha256').digest('hex');
    if (s.count !== count) throw corrupt(`section-count:${key}`, `section ${key} declares ${s.count}, read ${count}`);
    if (s.sha256 !== hash) throw corrupt(`section-hash:${key}`, `section ${key} hash mismatch`);
  }
  for (const key of seen.keys()) {
    if (!declared.has(key)) throw corrupt(`section-unknown:${key}`, `lines for section ${key}, which the manifest does not declare`);
  }
  return { manifest, entries, uncompressedBytes: entryBytes };
}

/** Verify a bundle without keeping its entries. */
export async function verifyBundleFile(file: string, limits: BundleLimits = {}): Promise<ScanResult> {
  return scanBundle(file, limits);
}

/** One section's content, grouped by the reader. */
export interface ReadSection {
  kind: SectionKind;
  id: string;
  summary: SectionSummary;
  /** kind 'dataset': the descriptor line. */
  dataset?: DatasetEntry;
  /** kind 'dataset': the records, in file order (tombstones included). */
  records: DataRecord[];
  /** kind 'config': the config entry. */
  config?: ConfigEntry;
  /** kind 'files': the files. */
  files: BundleFile[];
}

export interface ReadBundleResult {
  manifest: BundleManifest;
  sections: ReadSection[];
}

/** Read + fully verify a bundle, returning its entries grouped by section (manifest order). */
export async function readBundle(file: string, limits: BundleLimits = {}): Promise<ReadBundleResult> {
  const groups = new Map<string, ReadSection>();
  const get = (kind: SectionKind, id: string): ReadSection => {
    const key = sectionKey(kind, id);
    let g = groups.get(key);
    if (!g) { g = { kind, id, summary: null as unknown as SectionSummary, records: [], files: [] }; groups.set(key, g); }
    return g;
  };
  const { manifest } = await scanBundle(file, {
    ...limits,
    onEntry: (e) => {
      const { kind, id } = sectionOf(e);
      const g = get(kind, id);
      if (e.t === 'dataset') g.dataset = e;
      else if (e.t === 'record') g.records.push(e.r);
      else if (e.t === 'config') g.config = e;
      else { const { t: _t, section: _s, ...f } = e; g.files.push(f); }
    },
  });
  // scanBundle guarantees every group is declared in the manifest.
  const sections = manifest.sections.map((s) => {
    const g = get(s.kind, s.id);
    g.summary = s;
    return g;
  });
  return { manifest, sections };
}

export function findSection(b: ReadBundleResult, kind: SectionKind, id: string): ReadSection | undefined {
  return b.sections.find((s) => s.kind === kind && s.id === id);
}

/**
 * Fast manifest-only read: decompresses up to the first '\n' and stops. Validates the format
 * but NOT integrity — use verifyBundleFile/readBundle before trusting the contents.
 */
export async function readBundleManifest(file: string, limits: BundleLimits = {}): Promise<BundleManifest> {
  for await (const { buf } of rawLines(file, limits)) {
    let obj: unknown;
    try { obj = JSON.parse(buf.toString('utf8')); } catch {
      throw new BundleError('BUNDLE_FORMAT', 'first line is not JSON — not an lm-assist bundle', 'manifest');
    }
    return validateManifest(obj);
  }
  throw new BundleError('BUNDLE_FORMAT', 'empty bundle — no manifest line', 'manifest');
}
