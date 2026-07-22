/** Per-session model-switch journal — ~/.lm-assist/model-fallback.json (atomic, 0600).
 *  Deliberately a SEPARATE file from stall-monitor.json: the model class and the
 *  server/network class must never share backoff state. */
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import { ModelSwitchRecord } from './model-limit';

function storeFile(): string {
  return path.join(getDataDir(), 'model-fallback.json');
}

export function localModelKey(sessionId: string): string {
  return `local:${sessionId}`;
}
export function remoteModelKey(sid: string): string {
  return `ccr:${sid}`;
}

export function loadModelFallbackStore(): Record<string, ModelSwitchRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveModelFallbackStore(store: Record<string, ModelSwitchRecord>): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
  } catch {
    /* best effort — losing the journal only forgets cooldowns */
  }
}
