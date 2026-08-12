/**
 * Local-tier token primitives — the auth material for the standalone pane server
 * that reproduces the ui-gateway contract without the hub (see local-tier design).
 *
 * Two token kinds, both HMAC-SHA256 over the payload with a per-node secret:
 *  - VIEW  ('lvt1.') — 15-min bearer for the /data plane; multi-use until expiry.
 *  - ENTRY ('let1.') — 2-min, SINGLE-USE, exchanged once for the session cookie on
 *    the first document hit. Single-use is enforced by an in-memory nonce ledger,
 *    so a replayed ?lt= is refused even inside its 2-minute window.
 *
 * The secret lives 0600 at ~/.lm-assist/local-ui-secret and is created lazily.
 * `baseDir` on loadOrCreateSecret is a TEST SEAM only: production callers pass
 * nothing and get the real home dir. mint/verify resolve the secret through the
 * module-level override set by __initLocalUiSecret, so their public signatures
 * stay zero-config while tests can point them at an isolated dir.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const VIEW_PREFIX = 'lvt1';
const ENTRY_PREFIX = 'let1';
const VIEW_TTL_MS = 15 * 60 * 1000;
// 10 min: single-use and immediately exchanged for the 8h HttpOnly cookie, but a human who
// copies a LAN URL (or a remote browser driver) needs headroom to navigate before it expires.
const ENTRY_TTL_MS = 10 * 60 * 1000;
const SECRET_BYTES = 32;
const CONSUMED_CAP = 1000;

interface TokenPayload { u: string; e: number; n: string }

// ── Per-node secret ──────────────────────────────────────────────────────────
// baseDirOverride is the test seam; cachedSecret keeps mint/verify off the disk
// after the first load. __initLocalUiSecret drops both so a new baseDir takes.
let baseDirOverride: string | undefined;
let cachedSecret: Buffer | null = null;

function secretFile(baseDir?: string): string {
  return path.join(baseDir ?? os.homedir(), '.lm-assist', 'local-ui-secret');
}

export function loadOrCreateSecret(baseDir?: string): Buffer {
  const file = secretFile(baseDir);
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    // chmod-repair on every load: a group/other-readable secret is a leak.
    if ((fs.statSync(file).mode & 0o777) !== 0o600) {
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    }
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length >= SECRET_BYTES * 2) return Buffer.from(hex, 'hex');
    // present but malformed → fall through and re-mint
  } catch { /* absent/unreadable → mint below */ }
  const secret = randomBytes(SECRET_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return secret;
}

function getSecret(): Buffer {
  if (!cachedSecret) cachedSecret = loadOrCreateSecret(baseDirOverride);
  return cachedSecret;
}

// ── Mint / verify core ───────────────────────────────────────────────────────
function mint(prefix: string, uiId: string, ttlMs: number, now: number): string {
  const payload: TokenPayload = { u: uiId, e: now + ttlMs, n: randomBytes(4).toString('hex') };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  // Domain-separate the two token KINDS: the MAC covers the prefix, so flipping 'lvt1'↔'let1'
  // on a valid token (same secret, same payload) no longer verifies. Without this a durable
  // 8h view token could be replayed as an entry token (bypassing single-use + the short entry
  // TTL), or vice versa — the prefix was only string-compared, not signed.
  const mac = createHmac('sha256', getSecret()).update(`${prefix}.${payloadB64}`).digest();
  return `${prefix}.${payloadB64}.${mac.toString('base64url')}`;
}

/** Validate structure + signature + expiry. NEVER throws — any fault returns null. */
function verify(prefix: string, token: string, now: number): TokenPayload | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, payloadB64, macB64] = parts;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = createHmac('sha256', getSecret()).update(`${prefix}.${payloadB64}`).digest();
    given = Buffer.from(macB64, 'base64url');
  } catch { return null; }
  // Length guard before timingSafeEqual (it throws on a length mismatch).
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: TokenPayload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload; }
  catch { return null; }
  if (!payload || typeof payload.u !== 'string' || typeof payload.e !== 'number' || typeof payload.n !== 'string') return null;
  if (payload.e <= now) return null;
  return payload;
}

// ── View tokens ──────────────────────────────────────────────────────────────
export function mintViewToken(uiId: string, ttlMs: number = VIEW_TTL_MS): string {
  return mint(VIEW_PREFIX, uiId, ttlMs, Date.now());
}

export function verifyViewToken(token: string): { uiId: string } | null {
  const p = verify(VIEW_PREFIX, token, Date.now());
  return p ? { uiId: p.u } : null;
}

// ── Entry tokens (single-use) ────────────────────────────────────────────────
// nonce → token expiry; a consumed nonce is refused for the rest of its window.
const consumed = new Map<string, number>();

function pruneConsumed(now: number): void {
  for (const [n, exp] of consumed) if (exp <= now) consumed.delete(n);
  if (consumed.size > CONSUMED_CAP) {
    // Still over after expiry-prune → evict soonest-expiring first.
    const oldest = [...consumed.entries()].sort((a, b) => a[1] - b[1]);
    for (const [n] of oldest.slice(0, consumed.size - CONSUMED_CAP)) consumed.delete(n);
  }
}

export function mintEntryToken(uiId: string): string {
  return mint(ENTRY_PREFIX, uiId, ENTRY_TTL_MS, Date.now());
}

export function verifyEntryToken(token: string): { uiId: string } | null {
  const now = Date.now();
  const p = verify(ENTRY_PREFIX, token, now);
  if (!p) return null;
  // Consume on success only: a tampered/expired attempt never burns a live nonce.
  if (consumed.has(p.n)) return null;
  pruneConsumed(now);
  consumed.set(p.n, p.e);
  return { uiId: p.u };
}

/** Test seam: point the secret at an isolated baseDir and clear cached state. */
export function __initLocalUiSecret(baseDir?: string): void {
  baseDirOverride = baseDir;
  cachedSecret = null;
  consumed.clear();
}
