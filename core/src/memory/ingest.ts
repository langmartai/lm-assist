import * as fs from 'fs';
import * as path from 'path';

export interface IngestRecord { file: string; content: string; contentHash: string; }

/** Write a peer's records into <projectDir>/memory/<sourceHost>/. Dedup via a .hashes.json sidecar.
 *  Returns the number actually written. Never writes outside the per-host mirror dir:
 *  - sourceHost must be a single safe path segment (no separators, not `.`/`..`),
 *  - each record file must be a bare `*.md` name (no path components, no dotfiles). */
export function ingestRecords(projectDir: string, sourceHost: string, records: IngestRecord[]): number {
  if (!/^[A-Za-z0-9._-]+$/.test(sourceHost)) return 0;
  if (sourceHost === '.' || sourceHost === '..' || sourceHost.includes('..')) return 0;

  const mirrorDir = path.join(projectDir, 'memory', sourceHost);
  fs.mkdirSync(mirrorDir, { recursive: true });
  const hashFile = path.join(mirrorDir, '.hashes.json');
  let hashes: Record<string, string> = {};
  try { hashes = JSON.parse(fs.readFileSync(hashFile, 'utf-8')); } catch { /* none */ }

  let written = 0;
  for (const r of records) {
    const name = r.file;
    // bare filename only — reject any path components or separators
    if (name.includes('/') || name.includes('\\') || name !== path.basename(name)) continue;
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const dest = path.join(mirrorDir, name);
    if (path.dirname(path.resolve(dest)) !== path.resolve(mirrorDir)) continue; // defense-in-depth
    if (hashes[name] === r.contentHash) continue;       // unchanged
    fs.writeFileSync(dest, r.content);
    hashes[name] = r.contentHash;
    written++;
  }
  if (written) fs.writeFileSync(hashFile, JSON.stringify(hashes));
  return written;
}
