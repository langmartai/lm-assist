/** Payload checksum + manifest digest — contract §4.
 *
 *  The payload checksum algorithm is PUBLISHED to plugin authors, so this file and
 *  the reference implementation in docs/mcp-plugin-contract.md must stay identical.
 *  Any divergence means an author's pinned value never matches ours and every plugin
 *  is permanently un-enableable — so treat a mismatch as a bug on one of the sides,
 *  never as something to paper over. */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MANIFEST_FILENAME } from './model';

/** Recursively collect payload-relative file paths. Symlinks/sockets/FIFOs are
 *  REJECTED rather than skipped: a skipped symlink would let payload change without
 *  moving the hash. */
function collect(root: string, dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isSymbolicLink()) throw new Error(`symlink not allowed in a plugin payload: ${rel}`);
    if (e.isDirectory()) {
      if (rel === '.git' || rel.endsWith('/.git')) continue;   // VCS metadata is not payload
      collect(root, abs, out);
      continue;
    }
    if (!e.isFile()) throw new Error(`unsupported file type in a plugin payload: ${rel}`);
    if (rel === MANIFEST_FILENAME) continue;                    // carries the field; cannot hash itself
    out.push(rel);
  }
}

/**
 * SHA-256 over the canonical file list: for each file, in bytewise relative-path
 * order, `<relpath>\n<sha256-hex of contents>\n`.
 *
 * `node_modules/` IS included — vendored dependencies are executable payload and a
 * dependency swap must trip the pin. File modes are NOT covered: the entry point is
 * invoked through our own interpreter, so the executable bit is never load-bearing.
 */
export function payloadChecksum(dir: string): string {
  const files: string[] = [];
  collect(dir, dir, files);
  files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
    h.update(rel + '\n' + fileHash + '\n', 'utf8');
  }
  return 'sha256:' + h.digest('hex');
}

/** Deterministic JSON: object keys sorted at every depth, so a digest depends on
 *  content rather than on how the author happened to order their manifest. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/**
 * Digest of the manifest with `checksum` removed (it cannot cover itself). Pinned at
 * enable time alongside the payload checksum so that editing capabilities, tool
 * definitions or the entry point ALSO trips re-approval — a payload-only pin would
 * let an approved plugin silently widen its own declared access.
 */
export function manifestDigest(manifest: Record<string, unknown> | object): string {
  const { checksum, ...rest } = manifest as Record<string, unknown>;
  void checksum;
  return 'sha256:' + crypto.createHash('sha256').update(canonical(rest), 'utf8').digest('hex');
}
