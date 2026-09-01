/**
 * Minimal streaming tar reader.
 *
 * The backup indexes snapshots by streaming them, never by unpacking: a 117
 * snapshot is ~2 GB / 90,414 entries and the collector must not need that much
 * scratch space to answer a search. Node ships zlib, so gunzip is free; this
 * file supplies the ~150 lines of tar framing that would otherwise be a
 * dependency.
 *
 * Handles ustar `prefix` and GNU `L` long-name records, which matter here
 * because Claude Code session paths are routinely past the 100-byte name field
 * (`projects/C--home-user-my-project/<uuid>.jsonl`). Dropping those would
 * silently lose exactly the entries the index exists to find.
 */

import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

const BLOCK = 512;

export interface TarEntry {
  name: string;
  size: number;
  mtime: number;
  /** '0' file · '5' directory · other tar typeflags passed through. */
  type: string;
}

/** Pull-based byte reader over an async chunk source. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private readonly iter: AsyncIterator<Buffer>) {}

  /** Read exactly `n` bytes, or null at a clean end of stream. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (this.done) return null;
      const next = await this.iter.next();
      if (next.done) { this.done = true; return null; }
      this.buf = this.buf.length ? Buffer.concat([this.buf, next.value]) : next.value;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Skip `n` bytes without materialising them. */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const take = Math.min(left, 1 << 20);
      const got = await this.read(take);
      if (!got) return;
      left -= take;
    }
  }

  /** Stream `n` bytes to a sink in bounded chunks. */
  async copyTo(n: number, sink: (b: Buffer) => Promise<void>): Promise<void> {
    let left = n;
    while (left > 0) {
      const take = Math.min(left, 1 << 20);
      const got = await this.read(take);
      if (!got) return;
      await sink(got);
      left -= take;
    }
  }
}

function cstr(b: Buffer): string {
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString('utf-8');
}

function octal(b: Buffer): number {
  const s = cstr(b).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** Round up to the next 512-byte block boundary. */
function pad(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/**
 * Iterate a tar stream.
 *
 * `wantContent(entry)` decides per entry whether its bytes are materialised —
 * returning false skips them without buffering, which is what keeps a 2 GB
 * archive walkable in constant memory. Content is capped at `maxContentBytes`
 * so one pathological member cannot blow the heap.
 */
export async function* readTar(
  source: AsyncIterable<Buffer>,
  wantContent: (e: TarEntry) => boolean = () => false,
  maxContentBytes = 2 * 1024 * 1024,
): AsyncGenerator<{ entry: TarEntry; content: Buffer | null }> {
  const r = new ByteReader(source[Symbol.asyncIterator]());
  let pendingLongName: string | null = null;
  let emptyBlocks = 0;

  for (;;) {
    const header = await r.read(BLOCK);
    if (!header) return;

    // Two consecutive zero blocks terminate the archive.
    if (header.every((b) => b === 0)) {
      if (++emptyBlocks >= 2) return;
      continue;
    }
    emptyBlocks = 0;

    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30) || '0';
    let name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    if (prefix && header.subarray(257, 262).toString() === 'ustar') name = `${prefix}/${name}`;

    // GNU long name: the NEXT header's name lives in this record's payload.
    if (type === 'L') {
      const payload = await r.read(size);
      pendingLongName = payload ? cstr(payload) : null;
      await r.skip(pad(size));
      continue;
    }
    // pax extended headers — skip the metadata record, keep the ustar name.
    if (type === 'x' || type === 'g') {
      await r.skip(size + pad(size));
      continue;
    }

    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }

    const entry: TarEntry = {
      name: name.replace(/^\.\//, ''),
      size,
      mtime: octal(header.subarray(136, 148)) * 1000,
      type: type === '\0' ? '0' : type,
    };

    let content: Buffer | null = null;
    if (size > 0) {
      if (wantContent(entry) && size <= maxContentBytes) {
        content = await r.read(size);
      } else {
        await r.skip(size);
      }
    }
    await r.skip(pad(size));
    yield { entry, content };
  }
}

/**
 * Normalise a tar member name, or null if it must not be trusted.
 *
 * TAR SLIP. A tar archive carries whatever member names its author chose, and
 * `path.join(dest, name)` happily walks out of `dest` when the name contains
 * `..`, is absolute, or carries a Windows drive letter. Every archive this
 * module reads arrives over ssh from another host, so "we control that host" is
 * the only thing standing between a poisoned name and a write anywhere the
 * collector's Core can reach — including, on 107, the live `.claude` it is
 * supposed to be protecting. That is one compromise away from a backup that
 * attacks its own fleet, so the name is validated rather than trusted.
 *
 * This also guards the INDEX, not just the extract: a member name is persisted
 * and later fed back to removal and read paths, so a name that should never
 * have been written should never have been recorded either.
 */
export function safeMemberPath(name: string): string | null {
  const rel = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.startsWith('/')) return null;          // absolute
  if (/^[a-zA-Z]:/.test(rel)) return null;               // C:\… drive-qualified
  const segs = rel.split('/');
  for (const seg of segs.slice(0, -1)) {
    if (seg === '..' || seg === '' || seg === '.') return null;
  }
  const last = segs[segs.length - 1];
  if (last === '..' || last === '.' || last === '') return null;
  return rel;
}

/**
 * Resolve `rel` under `root`, or null if it escapes.
 *
 * Belt to `safeMemberPath`'s braces: symlinked ancestors and platform path
 * quirks can still land outside even a name that looks clean, so containment is
 * verified against the resolved absolute path before anything is written.
 */
export function containedPath(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

/** Convenience: iterate a `.tar.gz` file on disk. */
export function readTarGz(
  file: string,
  wantContent?: (e: TarEntry) => boolean,
): AsyncGenerator<{ entry: TarEntry; content: Buffer | null }> {
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  return readTar(stream as unknown as AsyncIterable<Buffer>, wantContent);
}

/** Expose a Readable as an async iterable of Buffers (typing helper). */
export function chunks(s: Readable): AsyncIterable<Buffer> {
  return s as unknown as AsyncIterable<Buffer>;
}

/**
 * Copy a tar stream to `write`, omitting entries `drop()` selects.
 *
 * This is how `backup_remove` reaches inside a `.tar.gz`. Kept entries are
 * passed through as their ORIGINAL BYTES — header blocks, data and padding —
 * so no tar writer is needed and nothing about a retained entry can be altered
 * in transit: mode, mtime, ownership and long-name records all survive
 * verbatim. Memory stays bounded regardless of member size because data is
 * streamed in 1 MiB chunks rather than buffered.
 *
 * A GNU long-name (`L`) record belongs to the entry that follows it, so it is
 * held back and emitted or discarded WITH that entry — dropping one without
 * the other would corrupt the archive.
 */
export async function filterTar(
  source: AsyncIterable<Buffer>,
  drop: (e: TarEntry) => boolean,
  write: (b: Buffer) => Promise<void>,
): Promise<{ kept: number; dropped: number }> {
  const r = new ByteReader(source[Symbol.asyncIterator]());
  let pendingLongName: string | null = null;
  let pendingRaw: Buffer[] = [];
  let emptyBlocks = 0;
  let kept = 0, dropped = 0;

  for (;;) {
    const header = await r.read(BLOCK);
    if (!header) break;

    if (header.every((b) => b === 0)) {
      if (++emptyBlocks >= 2) break;
      continue;
    }
    emptyBlocks = 0;

    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30) || '0';
    let name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    if (prefix && header.subarray(257, 262).toString() === 'ustar') name = `${prefix}/${name}`;

    if (type === 'L' || type === 'x' || type === 'g') {
      const payload = (await r.read(size)) ?? Buffer.alloc(0);
      const padding = (await r.read(pad(size))) ?? Buffer.alloc(0);
      if (type === 'L') pendingLongName = cstr(payload);
      pendingRaw.push(header, payload, padding);
      continue;
    }

    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }
    const entry: TarEntry = {
      name: name.replace(/^\.\//, ''),
      size,
      mtime: octal(header.subarray(136, 148)) * 1000,
      type: type === '\0' ? '0' : type,
    };

    if (drop(entry)) {
      dropped++;
      pendingRaw = [];
      await r.skip(size + pad(size));
      continue;
    }

    kept++;
    for (const b of pendingRaw) await write(b);
    pendingRaw = [];
    await write(header);
    await r.copyTo(size, write);
    const padding = await r.read(pad(size));
    if (padding) await write(padding);
  }

  // Two zero blocks terminate a tar archive; without them GNU tar warns.
  await write(Buffer.alloc(BLOCK * 2));
  return { kept, dropped };
}
