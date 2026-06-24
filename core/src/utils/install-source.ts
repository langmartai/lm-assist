/** Records WHICH source the current lm-assist was installed from, so the CLI/UI/routes
 *  can show it and avoid nudging a custom build to downgrade. ~/.lm-assist/install-source.json */
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './path-utils';

export interface InstallSource {
  kind: 'published' | 'custom';
  source: string; // 'lm-assist@<ver|latest>' (registry) | a tgz path | a URL | 'github:…#ref' | a dir
  version: string | null;
  installedAt: string; // ISO timestamp
}

function markerFile(): string {
  return path.join(getDataDir(), 'install-source.json');
}

/** Pure: a registry spec (`lm-assist@…`, or empty/latest) is `published`; everything else
 *  (tgz path, URL, github:…#ref, dir) is a `custom` build. */
export function classifyInstallSource(spec: string): { kind: 'published' | 'custom'; source: string } {
  const s = (spec || '').trim();
  if (!s || s === 'latest' || s === 'lm-assist@latest') return { kind: 'published', source: 'lm-assist@latest' };
  if (/^lm-assist@[^/\\:]+$/.test(s)) return { kind: 'published', source: s };
  return { kind: 'custom', source: s };
}

export function recordInstallSource(info: { kind: 'published' | 'custom'; source: string; version?: string | null }): void {
  try {
    const rec: InstallSource = {
      kind: info.kind,
      source: info.source,
      version: info.version == null ? null : String(info.version),
      installedAt: new Date().toISOString(),
    };
    const f = markerFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
  } catch { /* best effort — never fail an install over the marker */ }
}

export function readInstallSource(): InstallSource | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
    if (raw && (raw.kind === 'published' || raw.kind === 'custom') && typeof raw.source === 'string') {
      return { kind: raw.kind, source: raw.source, version: raw.version == null ? null : String(raw.version), installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : '' };
    }
    return null;
  } catch {
    return null;
  }
}
