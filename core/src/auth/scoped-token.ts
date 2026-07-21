/**
 * Scoped, revocable API tokens — a narrow companion to the full rotating
 * api-token (see api-token.ts).
 *
 * WHY: embedded browser clients (e.g. the lm-unified-trade chart-chat panel)
 * need to call a small slice of the core API directly from the page. The full
 * api-token must NEVER ship to a browser — it grants everything on the node.
 * A scoped token grants exactly one named scope's route allow-list, expires on
 * its own, and can be revoked individually, so its blast radius when leaked
 * from a page is "the routes in the scope until expiry/revocation" instead of
 * "the whole node".
 *
 * Mechanics:
 *  - Minted only by a full-token caller (POST /auth/scoped-tokens).
 *  - Sent by the browser in the SAME `x-api-key` header (CORS already allows
 *    it); the rest-server auth gate falls back to validateScopedRequest()
 *    when the ring token check fails.
 *  - Persisted to `<dataDir>/scoped-tokens.json` (0600) so an open browser
 *    tab survives a core restart.
 *  - A scope is a fixed allow-list of (method, path-regex) pairs compiled in
 *    here — scopes are code, not data, so a leaked token can't be widened.
 *
 * Scopes:
 *  - 'claude-ai-chat': the minimal embedded-chat surface — create a
 *    conversation, run a completion (blocking or streaming), read the parsed
 *    transcript. Deliberately EXCLUDES listing conversations (privacy),
 *    deleting/renaming, via-chrome, and everything else on the node.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getDataDir } from '../utils/path-utils';

export type ScopeName = 'claude-ai-chat';

export interface ScopedToken {
  id: string;          // short handle for list/revoke (never secret)
  token: string;       // the secret — returned once at mint time
  scope: ScopeName;
  label?: string;      // free-form caller note ("trade-web chart chat")
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
}

/** Public view — everything except the secret. */
export type ScopedTokenInfo = Omit<ScopedToken, 'token'>;

const TOKEN_PREFIX = 'lmsc_';
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const MAX_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_TOKENS = 50;

const UUID_SEG = '[0-9a-fA-F-]{36}';
const SCOPE_ROUTES: Record<ScopeName, Array<{ method: string; pattern: RegExp }>> = {
  'claude-ai-chat': [
    { method: 'POST', pattern: /^\/claude-ai\/conversations$/ },
    { method: 'POST', pattern: new RegExp(`^/claude-ai/conversations/${UUID_SEG}/completion$`) },
    { method: 'POST', pattern: new RegExp(`^/claude-ai/conversations/${UUID_SEG}/completion/stream$`) },
    { method: 'GET', pattern: new RegExp(`^/claude-ai/conversations/${UUID_SEG}/messages$`) },
  ],
};

export function isKnownScope(s: unknown): s is ScopeName {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(SCOPE_ROUTES, s);
}

export function scopedTokenFilePath(): string {
  return path.join(getDataDir(), 'scoped-tokens.json');
}

// In-memory store per file path (multiple only under tests).
const stores = new Map<string, ScopedToken[]>();

function load(file: string): ScopedToken[] {
  let list = stores.get(file);
  if (list) return list;
  list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw?.tokens)) {
      for (const t of raw.tokens) {
        if (t && typeof t.token === 'string' && isKnownScope(t.scope)
          && typeof t.expiresAt === 'number' && typeof t.id === 'string') {
          list.push({
            id: t.id, token: t.token, scope: t.scope,
            label: typeof t.label === 'string' ? t.label : undefined,
            createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
            expiresAt: t.expiresAt,
            lastUsedAt: typeof t.lastUsedAt === 'number' ? t.lastUsedAt : undefined,
          });
        }
      }
    }
  } catch { /* absent/corrupt → empty */ }
  stores.set(file, list);
  return list;
}

function save(file: string, list: ScopedToken[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, tokens: list }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch { /* best effort — in-memory store still authoritative this process */ }
}

function prune(list: ScopedToken[], now: number): ScopedToken[] {
  return list.filter((t) => t.expiresAt > now);
}

const publicInfo = (t: ScopedToken): ScopedTokenInfo => ({
  id: t.id, scope: t.scope, label: t.label,
  createdAt: t.createdAt, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt,
});

export function mintScopedToken(
  opts: { scope: ScopeName; ttlMs?: number; label?: string },
  file: string = scopedTokenFilePath(),
  now: number = Date.now(),
): ScopedToken {
  if (!isKnownScope(opts.scope)) throw new Error(`unknown scope: ${String(opts.scope)}`);
  const ttl = Math.min(Math.max(1_000, opts.ttlMs ?? DEFAULT_TTL_MS), MAX_TTL_MS);
  const list = prune(load(file), now);
  if (list.length >= MAX_TOKENS) {
    throw new Error(`scoped-token cap reached (${MAX_TOKENS}) — revoke old tokens first`);
  }
  const tok: ScopedToken = {
    id: `sct_${randomBytes(4).toString('hex')}`,
    token: TOKEN_PREFIX + randomBytes(32).toString('hex'),
    scope: opts.scope,
    label: opts.label?.slice(0, 120),
    createdAt: now,
    expiresAt: now + ttl,
  };
  list.push(tok);
  stores.set(file, list);
  save(file, list);
  return tok;
}

export function listScopedTokens(file: string = scopedTokenFilePath(), now: number = Date.now()): ScopedTokenInfo[] {
  const list = prune(load(file), now);
  stores.set(file, list);
  return list.map(publicInfo);
}

export function revokeScopedToken(id: string, file: string = scopedTokenFilePath()): boolean {
  const list = load(file);
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  stores.set(file, next);
  save(file, next);
  return true;
}

/**
 * Gate check: does `token` authorize `method path`? Fast-fails on the prefix
 * so full-token traffic never pays a list scan. Updates lastUsedAt (throttled
 * to 60s so the file isn't rewritten per request).
 */
export function validateScopedRequest(
  token: string | undefined | null,
  method: string,
  pathName: string,
  file: string = scopedTokenFilePath(),
  now: number = Date.now(),
): boolean {
  if (!token || typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return false;
  const list = load(file);
  const hit = list.find((t) => t.token === token);
  if (!hit || hit.expiresAt <= now) return false;
  const routes = SCOPE_ROUTES[hit.scope];
  const allowed = routes.some((r) => r.method === method && r.pattern.test(pathName));
  if (allowed && (!hit.lastUsedAt || now - hit.lastUsedAt > 60_000)) {
    hit.lastUsedAt = now;
    save(file, list);
  }
  return allowed;
}

/** Test hook — drop the in-memory cache for a file. */
export function __resetScopedTokens(file?: string): void {
  if (file) stores.delete(file); else stores.clear();
}
