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

function confinedPath(dir: string, filename: string): string | null {
  const dest = path.join(dir, filename);
  if (path.dirname(path.resolve(dest)) !== path.resolve(dir)) return null; // defense-in-depth
  return dest;
}

export function writeMdFile(
  dir: string, filename: string, content: string,
  opts: { expectedHash?: string; mustNotExist?: boolean; protectedPatterns?: RegExp[] } = {},
): FileOpResult {
  const bad = filenameProblem(filename, opts.protectedPatterns || []);
  if (bad) return { ok: false, code: bad };
  const dest = confinedPath(dir, filename);
  if (!dest) return { ok: false, code: 'BAD_FILENAME' };
  const exists = fs.existsSync(dest);
  if (opts.mustNotExist && exists) return { ok: false, code: 'EXISTS' };
  if (opts.expectedHash) {
    if (!exists) return { ok: false, code: 'HASH_MISMATCH' };
    const current = sha256(fs.readFileSync(dest, 'utf-8'));
    if (current !== opts.expectedHash) return { ok: false, code: 'HASH_MISMATCH' };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, content);
  return { ok: true, hash: sha256(content) };
}

export function deleteMdFile(
  dir: string, filename: string,
  opts: { expectedHash?: string; protectedPatterns?: RegExp[] } = {},
): FileOpResult {
  const bad = filenameProblem(filename, opts.protectedPatterns || []);
  if (bad) return { ok: false, code: bad };
  const dest = confinedPath(dir, filename);
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
