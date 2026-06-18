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

/** Deep-clone an arbitrary value, replacing any object property whose key matches SECRET_KEY_RE with REDACTED.
 *  Used to scrub admin-op results (status/stats objects), which are not DataRecords. */
export function redactValueDeep(v: unknown): unknown {
  return redactValue(v);
}

/** Deep-clone the record with any secret-named field values replaced by REDACTED. */
export function redactRecord(rec: DataRecord): DataRecord {
  return {
    ...rec,
    fields: redactValue(rec.fields) as Record<string, unknown>,
    metadata: rec.metadata ? (redactValue(rec.metadata) as Record<string, unknown>) : rec.metadata,
  };
}

// Inline secret-VALUE patterns — for scrubbing file CONTENT (logs/JSON), where secrets can appear
// in arbitrary text positions that key-name redaction (SECRET_KEY_RE) does not catch. Best-effort.
const SECRET_TOKEN_RE = /\b(sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|[A-Fa-f0-9]{40,})\b/g;
const SECRET_ASSIGN_RE = /\b(token|secret|password|passwd|api[-_]?key|apikey|authorization|bearer|credential|private[-_]?key|access[-_]?key|cookie)\b(["']?\s*[:=]\s*(?:bearer\s+)?["']?)([^\s"',}&]+)/gi;

/** Best-effort scrub of inline secrets in arbitrary text (log lines, string values). */
export function redactText(s: string): string {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(SECRET_ASSIGN_RE, (_m, k, sep) => `${k}${sep}${REDACTED}`)
    .replace(SECRET_TOKEN_RE, REDACTED);
}

/** Deep value scrub: secret-NAMED keys → REDACTED; every remaining string → redactText. */
function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : scrubValue(val);
    }
    return out;
  }
  return v;
}

/** Scrub a record's content (text + fields + metadata) for inline AND named secrets.
 *  Used by the file backend on read — tracked file content must never leak secrets. */
export function scrubRecordContent(rec: DataRecord): DataRecord {
  return {
    ...rec,
    fields: scrubValue(rec.fields) as Record<string, unknown>,
    text: rec.text ? redactText(rec.text) : rec.text,
    metadata: rec.metadata ? (scrubValue(rec.metadata) as Record<string, unknown>) : rec.metadata,
  };
}
