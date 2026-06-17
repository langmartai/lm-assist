// core/src/data/redaction.ts
import * as os from 'os';
import * as path from 'path';
import type { DataRecord } from './types';

export const REDACTED = '«redacted»';

const SECRET_KEY_RE = /(token|secret|password|api[-_]?key|cookie|credential|authorization|private[-_]?key)/i;

const home = os.homedir();
const HARD_EXCLUDED = new Set(
  [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.lm-assist', 'hub.json'),
    path.join(home, '.lm-assist', 'hub-dev.json'),
    path.join(home, '.claude', 'claudeai-session.json'),
  ].map((p) => path.resolve(p)),
);

/** A path that holds secrets and must never be registered or tracked as a dataset. */
export function isHardExcludedPath(p: string): boolean {
  const norm = path.resolve(p);
  if (HARD_EXCLUDED.has(norm)) return true;
  const base = path.basename(norm);
  if (base === '.env' || base === 'api-token') return true;
  // the access-key store itself
  if (base.startsWith('keys.lmdb')) return true;
  return false;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

/** Deep-clone the record with any secret-named field values replaced by REDACTED. */
export function redactRecord(rec: DataRecord): DataRecord {
  return {
    ...rec,
    fields: redactValue(rec.fields) as Record<string, unknown>,
    metadata: rec.metadata ? (redactValue(rec.metadata) as Record<string, unknown>) : rec.metadata,
  };
}
