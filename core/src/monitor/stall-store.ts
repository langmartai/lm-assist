/** Per-session stall retry state — ~/.lm-assist/stall-monitor.json (atomic, 0600). */
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import { StallRecord } from './stall-state';

function storeFile(): string {
  return path.join(getDataDir(), 'stall-monitor.json');
}

export function localKey(sessionId: string): string {
  return `local:${sessionId}`;
}
export function remoteKey(sid: string): string {
  return `ccr:${sid}`;
}

export function loadStallStore(): Record<string, StallRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveStallStore(store: Record<string, StallRecord>): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
  } catch {
    /* best effort — losing the store only resets attempt counters */
  }
}
