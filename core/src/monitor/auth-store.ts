import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import type { AuthSnapshot } from './auth-monitor';

function storeFile(): string { return path.join(getDataDir(), 'auth-status.json'); }

export function loadAuthSnapshot(): AuthSnapshot | null {
  try { const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); return raw && typeof raw === 'object' ? raw as AuthSnapshot : null; }
  catch { return null; }
}

export function saveAuthSnapshot(snap: AuthSnapshot): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
  } catch { /* best-effort */ }
}
