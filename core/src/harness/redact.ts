/**
 * Redaction for everything the harness-run surfaces write or serve.
 *
 * The provider key reaches the child (qwen via OPENAI_API_KEY in its env,
 * opencode via a config file it can read), so one `env` or `cat` from the agent
 * puts it in stdout, the native transcript and the result. Measured: no key has
 * landed on disk so far — which is luck, not a property. Redaction is therefore
 * applied twice: at WRITE time (capture lines, prompt.txt, previews) so the
 * files never hold it, and at SERVE time so an older file or a native source we
 * do not write ourselves cannot hand it out either.
 *
 * Exact configured values are the primary rule; the generic patterns catch keys
 * that were never configured here (a key an agent read from a project file).
 * There is deliberately no generic `key=value` rule: it mangles ordinary content
 * (diffs, env examples) far more often than it catches anything.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, isDevRepo } from '../utils/path-utils';
import { HARNESS_ENV_PREFIX, loadProviderConfig } from './provider-config';

export const REDACTED = '[REDACTED]';

/** Shorter values are too likely to occur in ordinary text to replace blindly. */
const MIN_SECRET_CHARS = 8;
/**
 * A cut fragment is replaced from this many chars up. Longer than MIN_SECRET_CHARS on
 * purpose: many keys share a public prefix (`sk-or-v1-` is 9), and text that merely
 * ENDS with that prefix is not a leak. A shorter fragment exposes at most a few chars.
 */
const EDGE_MIN_CHARS = 12;
const CACHE_MAX_AGE_MS = 30_000;

const SK_RE = /\bsk-[A-Za-z0-9_-]{20,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

let cache: { key: string; at: number; secrets: string[] } | null = null;

function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

function keysFromFile(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Object.values(parsed?.profiles ?? {}).map((p: any) => (typeof p?.apiKey === 'string' ? p.apiKey : ''));
  } catch {
    return [];
  }
}

/**
 * Every configured credential value, longest first (so a key that contains
 * another is replaced whole).
 *
 * BOTH modes' provider files are read: the legacy run dirs are shared by the dev
 * and prod Cores, so a run this Core serves may have been made with the other
 * one's key. Re-read whenever either file changes, and at least every 30 s.
 */
export function collectSecrets(): string[] {
  const dataDir = getDataDir();
  const current = path.join(dataDir, `harness-providers${isDevRepo() ? '-dev' : ''}.json`);
  const other = path.join(dataDir, `harness-providers${isDevRepo() ? '' : '-dev'}.json`);
  const envKey = process.env[`${HARNESS_ENV_PREFIX}API_KEY`] ?? '';
  const key = `${dataDir}|${fileStamp(current)}|${fileStamp(other)}|${envKey}|${process.env[`${HARNESS_ENV_PREFIX}BASE_URL`] ?? ''}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MAX_AGE_MS) return cache.secrets;

  const all = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim().length >= MIN_SECRET_CHARS) all.add(v.trim());
  };
  try {
    for (const p of Object.values(loadProviderConfig().profiles)) add(p?.apiKey);
  } catch {
    // An unreadable config still leaves the other sources and the patterns.
  }
  for (const k of keysFromFile(other)) add(k);
  add(envKey);

  const secrets = [...all].sort((a, b) => b.length - a.length);
  cache = { key, at: now, secrets };
  return secrets;
}

/**
 * A configured secret CUT by an earlier slice survives only at an edge of the string
 * that was cut: its head at the end, or its tail at the start (a tail read). Exact
 * matching misses both, so an edge that is EDGE_MIN_CHARS+ chars of a secret is replaced too.
 * Every cut site (transcript fields, previews, parse-time caps) is covered by this one
 * rule, including cut sites added later.
 */
function redactCutEdges(s: string, secret: string): string {
  let out = s;
  const max = Math.min(secret.length - 1, out.length);
  // Head of the secret at the END of the string.
  for (let k = max; k >= EDGE_MIN_CHARS; k--) {
    if (out.charCodeAt(out.length - k) === secret.charCodeAt(0) && out.endsWith(secret.slice(0, k))) {
      out = out.slice(0, out.length - k) + REDACTED;
      break;
    }
  }
  // Tail of the secret at the START of the string.
  const max2 = Math.min(secret.length - 1, out.length);
  for (let k = max2; k >= EDGE_MIN_CHARS; k--) {
    if (out.charCodeAt(k - 1) === secret.charCodeAt(secret.length - 1) && out.startsWith(secret.slice(secret.length - k))) {
      out = REDACTED + out.slice(k);
      break;
    }
  }
  return out;
}

/** Replace every configured secret and every key-shaped token in `s`. */
export function redactString(s: string, secrets: string[] = collectSecrets()): string {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    if (out.length >= EDGE_MIN_CHARS && secret.length > EDGE_MIN_CHARS) out = redactCutEdges(out, secret);
  }
  if (out.includes('sk-')) out = out.replace(SK_RE, REDACTED);
  if (/bearer/i.test(out)) out = out.replace(BEARER_RE, `$1${REDACTED}`);
  return out;
}

/**
 * Redact every string LEAF of a JSON-shaped value and return a copy.
 *
 * Leaves, not the serialised text: a regex over serialised JSON can cut across
 * an escape sequence and corrupt the document it was meant to clean. Keys are
 * left alone (they are field names and tool names). Non-plain objects (Date,
 * Buffer) pass through untouched.
 */
export function redactDeep<T>(value: T, secrets: string[] = collectSecrets()): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v, secrets);
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v as object)) return v;
    if (Array.isArray(v)) {
      seen.add(v);
      return v.map(walk);
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    seen.add(v as object);
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child);
    return out;
  };
  return walk(value) as T;
}
