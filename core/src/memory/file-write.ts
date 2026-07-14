/**
 * Confined markdown file writes for the Memory/Rules web editor.
 * Mirrors the defense-in-depth idioms of memory/ingest.ts: bare `*.md`
 * basenames only, resolved path must stay inside the target dir, and
 * caller-supplied protected patterns (managed files, synced.* rules)
 * are rejected before any fs touch. `expectedHash` gives the editor
 * optimistic concurrency against the sync daemons that also write here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type FileWriteErrorCode = 'BAD_FILENAME' | 'PROTECTED' | 'EXISTS' | 'NOT_FOUND' | 'HASH_MISMATCH';
export interface FileOpResult { ok: boolean; code?: FileWriteErrorCode; hash?: string }

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function filenameProblem(filename: string, protectedPatterns: RegExp[] = []): FileWriteErrorCode | null {
  if (!filename || filename !== path.basename(filename)) return 'BAD_FILENAME';
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return 'BAD_FILENAME';
  if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) return 'BAD_FILENAME';
  if (filename.startsWith('.')) return 'BAD_FILENAME';
  if (protectedPatterns.some((re) => re.test(filename))) return 'PROTECTED';
  return null;
}

/** Control chars (incl. NUL, excluding none) — reject anywhere in a relpath. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/**
 * Nested-capable version of `filenameProblem`: accepts `a.md` or `sub/dir/a.md`.
 * Splits on '/' (never '\\' — backslash is rejected outright so a Windows-style
 * separator can never smuggle a segment past this POSIX-only split). Every
 * directory segment must be a safe bare name (`[A-Za-z0-9._-]+`, no leading '.'
 * — so no dot-segments and no hidden dirs); the final segment (the basename) is
 * validated by the existing `filenameProblem`, so protected patterns are always
 * tested against the basename only, exactly as they are for flat filenames.
 */
export function relPathProblem(relpath: string, protectedPatterns: RegExp[] = []): FileWriteErrorCode | null {
  if (!relpath || typeof relpath !== 'string') return 'BAD_FILENAME';
  if (relpath.includes('\\')) return 'BAD_FILENAME';
  if (relpath.includes('\0') || CONTROL_CHARS_RE.test(relpath)) return 'BAD_FILENAME';
  if (path.isAbsolute(relpath)) return 'BAD_FILENAME';
  const segments = relpath.split('/');
  if (segments.length === 0) return 'BAD_FILENAME';
  const basename = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);
  for (const seg of dirSegments) {
    if (!seg) return 'BAD_FILENAME';               // empty segment ('//' or leading/trailing '/')
    if (seg === '.' || seg === '..') return 'BAD_FILENAME';
    if (seg.startsWith('.')) return 'BAD_FILENAME'; // no hidden dirs
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return 'BAD_FILENAME';
  }
  return filenameProblem(basename, protectedPatterns);
}

function confinedPath(dir: string, filename: string): string | null {
  const dest = path.join(dir, filename);
  if (path.dirname(path.resolve(dest)) !== path.resolve(dir)) return null; // defense-in-depth
  return dest;
}

/**
 * Nested-capable confinement: resolves `dir/relpath` and verifies the RESOLVED
 * destination is still inside the RESOLVED root (any number of directory
 * levels deep, not just a direct child as `confinedPath` requires). Used for
 * relpath-based writes/deletes where `relPathProblem` already validated every
 * segment, but this remains defense-in-depth against symlink/resolution
 * surprises the string-level check can't see. Exported so read-only callers
 * (e.g. the rule-files GET route) can reuse the exact same confinement
 * semantics instead of re-deriving them.
 */
export function confinedRelPath(rootDir: string, relpath: string): string | null {
  const root = path.resolve(rootDir);
  const dest = path.resolve(root, relpath);
  const rel = path.relative(root, dest);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dest;
}

/**
 * Write a `*.md` file under `dir`. `filename` may be a bare basename (`a.md`,
 * unchanged/byte-identical legacy path) or, when the caller opts in via
 * `opts.allowNested`, a POSIX relpath (`sub/dir/a.md`, nested-capable path —
 * validated via `relPathProblem`, confined via the resolved-path check,
 * parent dirs created recursively). `allowNested` defaults to `false`: a
 * filename containing '/' (or '\\') is then refused with `BAD_FILENAME`
 * through the SAME flat validator used for every other bad filename, rather
 * than being silently treated as a nested path. This keeps write surfaces
 * that are flat-only by contract (e.g. the memory editor, whose read/list
 * pipeline never looks below the project's `memory/` dir) from creating
 * invisible orphans; rule-files.routes.ts (nested writes ARE intended there)
 * passes `allowNested: true` explicitly. Flat filenames NEVER touch the
 * relpath code path either way, so existing behavior (error codes,
 * confinement semantics) is unchanged for callers that only ever pass bare
 * basenames.
 */
export function writeMdFile(
  dir: string, filename: string, content: string,
  opts: { expectedHash?: string; mustNotExist?: boolean; protectedPatterns?: RegExp[]; allowNested?: boolean } = {},
): FileOpResult {
  const hasSep = typeof filename === 'string' && (filename.includes('/') || filename.includes('\\'));
  if (hasSep && !opts.allowNested) return { ok: false, code: 'BAD_FILENAME' };
  const nested = hasSep && opts.allowNested === true;
  const bad = nested
    ? relPathProblem(filename, opts.protectedPatterns || [])
    : filenameProblem(filename, opts.protectedPatterns || []);
  if (bad) return { ok: false, code: bad };
  const dest = nested ? confinedRelPath(dir, filename) : confinedPath(dir, filename);
  if (!dest) return { ok: false, code: 'BAD_FILENAME' };
  const exists = fs.existsSync(dest);
  if (opts.mustNotExist && exists) return { ok: false, code: 'EXISTS' };
  if (opts.expectedHash) {
    if (!exists) return { ok: false, code: 'HASH_MISMATCH' };
    const current = sha256(fs.readFileSync(dest, 'utf-8'));
    if (current !== opts.expectedHash) return { ok: false, code: 'HASH_MISMATCH' };
  }
  fs.mkdirSync(nested ? path.dirname(dest) : dir, { recursive: true });
  fs.writeFileSync(dest, content);
  return { ok: true, hash: sha256(content) };
}

/**
 * Delete a `*.md` file under `dir`. Same flat-vs-nested `filename` handling
 * as `writeMdFile`, gated by the same `opts.allowNested` (default `false`).
 */
export function deleteMdFile(
  dir: string, filename: string,
  opts: { expectedHash?: string; protectedPatterns?: RegExp[]; allowNested?: boolean } = {},
): FileOpResult {
  const hasSep = typeof filename === 'string' && (filename.includes('/') || filename.includes('\\'));
  if (hasSep && !opts.allowNested) return { ok: false, code: 'BAD_FILENAME' };
  const nested = hasSep && opts.allowNested === true;
  const bad = nested
    ? relPathProblem(filename, opts.protectedPatterns || [])
    : filenameProblem(filename, opts.protectedPatterns || []);
  if (bad) return { ok: false, code: bad };
  const dest = nested ? confinedRelPath(dir, filename) : confinedPath(dir, filename);
  if (!dest) return { ok: false, code: 'BAD_FILENAME' };
  if (!fs.existsSync(dest)) return { ok: false, code: 'NOT_FOUND' };
  if (opts.expectedHash) {
    const current = sha256(fs.readFileSync(dest, 'utf-8'));
    if (current !== opts.expectedHash) return { ok: false, code: 'HASH_MISMATCH' };
  }
  fs.unlinkSync(dest);
  return { ok: true };
}

/** Append one line to <memoryDir>/MEMORY.md (created if missing), keeping a trailing newline. */
export function appendIndexLine(memoryDir: string, line: string): void {
  const idx = path.join(memoryDir, 'MEMORY.md');
  let cur = '';
  try { cur = fs.readFileSync(idx, 'utf-8'); } catch { /* create below */ }
  if (cur && !cur.endsWith('\n')) cur += '\n';
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(idx, cur + line.trimEnd() + '\n');
}

/** Remove MEMORY.md lines whose markdown link targets the filename: `](<file>)` or `](./<file>)`. */
export function removeIndexLines(memoryDir: string, filename: string): number {
  const idx = path.join(memoryDir, 'MEMORY.md');
  let cur: string;
  try { cur = fs.readFileSync(idx, 'utf-8'); } catch { return 0; }
  const lines = cur.split('\n');
  const kept = lines.filter((l) => !l.includes(`](${filename})`) && !l.includes(`](./${filename})`));
  const removed = lines.length - kept.length;
  if (removed > 0) fs.writeFileSync(idx, kept.join('\n'));
  return removed;
}
