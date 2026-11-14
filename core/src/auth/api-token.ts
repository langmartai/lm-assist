/**
 * Rotating API-token auth for the local worker API.
 *
 * The worker OWNS the token: it generates one on first boot, writes it to
 * `<dataDir>/api-token` (mode 0600), and rotates it on an interval. Every other
 * client on the host (the MCP bridge, the hub relay forwarder, the web
 * dashboard, the stdio MCP) reads that file and sends it as `x-api-key`.
 *
 * Rotation never cuts anyone off: the worker keeps a RING of the last
 * RING_SIZE tokens (default 3) all valid at once, so a just-retired token
 * stays good for a GRACE window (default 7 days, LM_TOKEN_GRACE_MS) — long
 * enough for any client to notice the file changed and re-read. A retired
 * token past the grace TTL (or aged out of the ring) gets a 401; the client
 * re-reads the file + retries.
 *
 * Rotation state (lastRotatedAt + the grace ring with per-token retiredAt)
 * persists in a sidecar, `<dataDir>/api-token.meta.json` (0600, format v2),
 * so restarts neither restart the rotation window nor drop the grace tokens
 * — and the TTL holds ACROSS restarts too. The token file itself stays a
 * RAW token string — external consumers (core.sh, bin/lm-assist.js,
 * ccr/ccr-bridge.js, core/hooks/*, core/scripts/lib/loopback-auth.js, the web
 * server's server-auth, the e2e scripts) cat/trim it as-is. (The web layout no
 * longer inlines it into HTML; browsers fetch it from GET /auth/browser-token.)
 *
 * A missing or corrupt sidecar over an EXISTING token file seeds the rotation
 * window from the token file's mtime: the file is written only at creation/
 * rotation, so its mtime is an honest lower bound on the token's age. This is
 * what makes the FIRST deploy of this code rotate an already-overdue token
 * (the measured incident: a 49-day-old token vs a 30-day window) instead of
 * granting it a fresh full window. Only a missing token file (fresh install)
 * or an unreadable stat stamps the window from `now`. A v1-format sidecar
 * (grace entries as bare strings, no retiredAt) loads fail-open: entries are
 * treated as retired at load time.
 *
 * The token is NEVER exposed to the LLM / MCP tool layer: it is read from disk
 * and attached server-side. It is a SEPARATE secret from the langmart hub API
 * key, with its own blast radius.
 *
 * Revoke-now (rotateApiTokenNow, operator-only: `cli.js token rotate --now` or
 * POST /auth/token/rotate — NEVER on boot): mints a fresh token and revokes every
 * token this process or the files know, with NO grace. The revocations are
 * recorded as sha256 hashes in a third file, `<dataDir>/api-token.revoked.json`
 * (0600, `{v:1, revoked:[{sha256, revokedAt}]}`), and every ring this module
 * builds is filtered by it. A separate file rather than a meta field because an
 * OLDER build sharing the data dir rewrites api-token.meta.json at its own
 * rotation (re-adding a revoked token to `previous`) but never touches this one.
 * Ring HITS re-check the token file at most once a second
 * (maybeRecheckTokenFile), so a revoke-now done by another process takes effect
 * here within ~1 s instead of never.
 *
 * Files: api-token (raw), api-token.meta.json (rotation state + grace ring),
 * api-token.revoked.json (revoke-now hashes).
 *
 * Env:
 *   LM_ASSIST_API_AUTH=0|off|false   disable enforcement (emergency kill-switch)
 *   LM_ASSIST_API_TOKEN_RING=N       ring depth (default 3)
 *   LM_ASSIST_API_TOKEN_ROTATE_MS=N  rotation interval ms (default 30 days)
 *   LM_TOKEN_GRACE_MS=N              retired-token grace TTL ms (default 7 days)
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, createHash } from 'crypto';
import { getDataDir } from '../utils/path-utils';
import { networkInterfaces } from 'os';

const RING_SIZE = Math.max(1, Number(process.env.LM_ASSIST_API_TOKEN_RING) || 3);
const ROTATE_MS = Math.max(1_000, Number(process.env.LM_ASSIST_API_TOKEN_ROTATE_MS) || 30 * 24 * 60 * 60 * 1000);
// How long a RETIRED token stays valid after rotation. 7 days: every consumer
// of the token file re-reads it within one page render / relay reconnect /
// Core restart, and the fleet's slowest re-readers (a web SSR process that
// cached the token at boot, a long-lived hub relay) all cycle well inside a
// week — while a whole rotation window (30 days) of grace would let a leaked
// retired token live for up to two windows. Persisted per-token (retiredAt in
// the sidecar) so the TTL holds across restarts, enforced at load, at
// rotation, and on cross-process reseed.
const GRACE_MS = Math.max(1_000, Number(process.env.LM_TOKEN_GRACE_MS) || 7 * 24 * 60 * 60 * 1000);
// Node timer delays are a signed 32-bit int of ms (~24.8 days max). A raw delay
// above this overflows and Node clamps it to 1ms — firing continuously. The
// 30-day default exceeds it, so rotation must be armed in capped chunks.
const MAX_TIMER_MS = 2_147_483_647;

function tokenFile(): string {
  return path.join(getDataDir(), 'api-token');
}
// Rotation state sidecar. The token file itself stays a RAW token string —
// core.sh, bin/lm-assist.js, ccr-bridge, the hooks and the web SSR all cat/trim
// it as-is, so persisted state lives NEXT TO it, never inside it.
function metaFile(): string {
  return tokenFile() + '.meta.json';
}
// Revoke-now sidecar: sha256 hashes only, never a token value.
function revokedFile(): string {
  return tokenFile() + '.revoked.json';
}
function gen(): string {
  return randomBytes(32).toString('hex');
}
function sha256Hex(tok: string): string {
  return createHash('sha256').update(tok, 'utf8').digest('hex');
}

// index 0 = current token (retiredAt null); the rest are still-valid grace
// tokens, each stamped with WHEN it was rotated out so the grace TTL can be
// enforced at load, at rotation and on reseed — including across restarts.
interface RingEntry {
  token: string;
  retiredAt: number | null; // null = the current token
}
let ring: RingEntry[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
// Epoch ms of the last rotation (or of first boot / a fresh stamp when the
// sidecar was missing/corrupt). Persisted so restarts do NOT restart the window.
let lastRotatedAt = 0;
// mtime of the token file when the ring was last seeded/written — lets an auth
// miss detect a rotation performed by ANOTHER core process sharing <dataDir>.
let ringFileMtimeMs = -1;
// Most recent full countdown armed by startApiTokenRotation (test observability).
let armedMs: number | null = null;
// Throttle for the ring-HIT recheck of the token file (maybeRecheckTokenFile).
let lastFileCheckAt = 0;
const TOKEN_FILE_RECHECK_MS = 1000;
// Revoked-hash set, read from the sidecar at init and whenever the token file changes.
let revokedCache: Set<string> | null = null;
// Revocations older than this can no longer matter (grace is days, not months), and the
// cap keeps the file bounded however often an operator rotates.
const REVOKED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REVOKED_MAX = 200;

interface GraceEntry {
  token: string;
  retiredAt: number; // epoch ms the token was rotated out (grace TTL anchor)
}
interface ApiTokenMeta {
  lastRotatedAt: number;
  previous: GraceEntry[]; // grace tokens, newest first (ring minus the current)
}

/** Read + normalize the sidecar. Sidecar format v2 stores grace entries as
 *  `{token, retiredAt}`; a v1 sidecar (bare token strings, no retiredAt) —
 *  written by the previous build — loads FAIL-OPEN: each entry is treated as
 *  retired at `now`, so it gets one full grace window from this load rather
 *  than being cut off (or living forever). Absent/corrupt → null. */
function readMeta(now: number): ApiTokenMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    const last = raw?.lastRotatedAt;
    if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) return null;
    const previous: GraceEntry[] = [];
    if (Array.isArray(raw?.previous)) {
      for (const e of raw.previous.slice(0, RING_SIZE - 1)) {
        if (typeof e === 'string' && e.length > 0) {
          previous.push({ token: e, retiredAt: now }); // v1 entry — fail open
        } else if (e && typeof e === 'object' && typeof e.token === 'string' && e.token.length > 0) {
          const at = typeof e.retiredAt === 'number' && Number.isFinite(e.retiredAt) && e.retiredAt > 0 ? e.retiredAt : now;
          previous.push({ token: e.token, retiredAt: at });
        }
      }
    }
    return { lastRotatedAt: last, previous };
  } catch {
    return null; // absent/corrupt → caller fails open (mtime seed, never crash)
  }
}

/** A grace entry still inside its TTL at `now`. */
function inGrace(e: GraceEntry, now: number): boolean {
  return now - e.retiredAt <= GRACE_MS;
}

function writeMeta(meta: ApiTokenMeta): void {
  const f = metaFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    const previous = meta.previous.map((e) => ({ token: e.token, retiredAt: e.retiredAt }));
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, lastRotatedAt: meta.lastRotatedAt, previous }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f); // atomic replace
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    /* best effort — the window just re-seeds on the next boot */
  }
}

interface RevokedEntry {
  sha256: string;
  revokedAt: number;
}

function readRevokedEntries(): RevokedEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(revokedFile(), 'utf8'));
    if (!Array.isArray(raw?.revoked)) return [];
    const out: RevokedEntry[] = [];
    for (const e of raw.revoked) {
      if (e && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)) {
        out.push({ sha256: e.sha256, revokedAt: typeof e.revokedAt === 'number' ? e.revokedAt : 0 });
      }
    }
    return out;
  } catch {
    return []; // absent/corrupt → nothing revoked (today's behaviour, never a crash)
  }
}

/** The sha256 set of revoked tokens. Missing/corrupt sidecar → empty set. Refreshes the
 *  in-memory cache every ring build consults. */
export function readRevoked(): Set<string> {
  revokedCache = new Set(readRevokedEntries().map((e) => e.sha256));
  return revokedCache;
}

function revokedSet(): Set<string> {
  return revokedCache ?? readRevoked();
}

function isRevoked(tok: string): boolean {
  const set = revokedSet();
  return set.size > 0 && set.has(sha256Hex(tok));
}

/** Record `tokens` as revoked (hashes only). Written atomically, 0600; entries older than
 *  REVOKED_TTL_MS drop and the list is capped at REVOKED_MAX (newest kept). THROWS on a
 *  write failure: a revoke that did not land must not be reported as done. */
export function appendRevoked(tokens: string[], now: number = Date.now()): number {
  const merged = new Map<string, number>();
  for (const e of readRevokedEntries()) {
    if (now - e.revokedAt <= REVOKED_TTL_MS) merged.set(e.sha256, e.revokedAt);
  }
  let added = 0;
  for (const t of tokens) {
    if (!t) continue;
    const h = sha256Hex(t);
    if (!merged.has(h)) added++;
    merged.set(h, now);
  }
  const revoked = [...merged.entries()]
    .map(([sha256, revokedAt]) => ({ sha256, revokedAt }))
    .sort((a, b) => b.revokedAt - a.revokedAt)
    .slice(0, REVOKED_MAX);
  const f = revokedFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, revoked }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f); // atomic replace
  try {
    fs.chmodSync(f, 0o600);
  } catch {
    /* best effort */
  }
  revokedCache = new Set(revoked.map((e) => e.sha256));
  return added;
}

/** The grace entries currently in the ring (everything but the current token). */
function graceEntries(): GraceEntry[] {
  return ring.slice(1).map((e) => ({ token: e.token, retiredAt: e.retiredAt ?? Date.now() }));
}

function noteTokenFileMtime(): void {
  try {
    ringFileMtimeMs = fs.statSync(tokenFile()).mtimeMs;
  } catch {
    ringFileMtimeMs = -1;
  }
}

function writeToken(tok: string): void {
  const f = tokenFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, tok + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f); // atomic replace
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
    noteTokenFileMtime();
  } catch {
    /* best effort — in-process auth still works via the ring */
  }
}

/** Initialize the ring. Seeds from the token file + sidecar if present so a
 *  restart keeps BOTH the current token and the persisted grace ring valid,
 *  and keeps counting the same rotation window instead of restarting it. */
export function initApiToken(now: number = Date.now()): string {
  if (ring.length) return ring[0].token;
  let seed: string | null = null;
  try {
    const c = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (c) seed = c;
  } catch {
    /* no file yet */
  }
  noteTokenFileMtime();
  readRevoked();
  if (seed && isRevoked(seed)) {
    // The file still holds a token an operator revoked (a revoke-now whose token write
    // was lost, or an older build that restored it). Never serve it: mint a fresh one.
    console.warn('[api-token] token file holds a revoked token — rotating now');
    const t = gen();
    ring = [{ token: t, retiredAt: null }];
    lastRotatedAt = now;
    writeToken(t);
    writeMeta({ lastRotatedAt: now, previous: [] });
    return ring[0].token;
  }
  if (seed) {
    const meta = readMeta(now);
    if (meta) {
      ring = [
        { token: seed, retiredAt: null },
        ...meta.previous.filter((e) => e.token !== seed && inGrace(e, now) && !isRevoked(e.token)),
      ].slice(0, RING_SIZE);
      lastRotatedAt = meta.lastRotatedAt;
    } else {
      // Missing/corrupt sidecar over an EXISTING token file. Do NOT stamp the
      // window from `now`: that would hand an already-overdue token a fresh
      // full window on the very first boot with this code (the measured
      // incident — a 49-day-old fleet token vs a 30-day window). The token
      // file is written only at creation/rotation, so its mtime is an honest
      // lower bound on the token's age: seed the window from it, and
      // startApiTokenRotation rotates immediately when it is overdue. Only an
      // unreadable stat fails open to `now`.
      const seededAt = ringFileMtimeMs > 0 ? ringFileMtimeMs : now;
      ring = [{ token: seed, retiredAt: null }];
      lastRotatedAt = seededAt;
      writeMeta({ lastRotatedAt: seededAt, previous: [] });
    }
  } else {
    const t = gen();
    ring = [{ token: t, retiredAt: null }];
    lastRotatedAt = now;
    writeToken(t);
    writeMeta({ lastRotatedAt: now, previous: [] });
  }
  return ring[0].token;
}

export function currentApiToken(): string {
  return ring.length ? ring[0].token : initApiToken();
}

export function isValidToken(tok: string | string[] | undefined | null): boolean {
  if (!tok) return false;
  const t = Array.isArray(tok) ? tok[0] : String(tok);
  if (!ring.length) initApiToken();
  // BEFORE the hit check: a hit used to never look at the file, so a token revoked
  // by ANOTHER process (the CLI's rotate --now, or the other Core sharing <dataDir>)
  // stayed valid here indefinitely. Throttled to one statSync per second.
  maybeRecheckTokenFile();
  if (ring.some((e) => e.token === t)) return true;
  return reseedIfFileChanged() && ring.some((e) => e.token === t);
}

/** Absorb a token-file change at most once per TOKEN_FILE_RECHECK_MS (one statSync). */
export function maybeRecheckTokenFile(now: number = Date.now()): void {
  if (now - lastFileCheckAt < TOKEN_FILE_RECHECK_MS) return;
  lastFileCheckAt = now;
  reseedIfFileChanged();
}

/** On an auth miss (and on the throttled hit recheck), absorb a rotation performed by
 *  ANOTHER core process sharing <dataDir> (dev :3200 and prod :3100 share one
 *  api-token file): if the token file changed since this process last seeded/wrote
 *  it, fold the file's current token and the sidecar's grace ring into ours — minus
 *  anything the revoked sidecar lists (re-read on every change, so a revoke-now by
 *  the other process drops our copies of the old tokens too). */
function reseedIfFileChanged(): boolean {
  let mtime: number;
  try {
    mtime = fs.statSync(tokenFile()).mtimeMs;
  } catch {
    return false;
  }
  if (mtime === ringFileMtimeMs) return false;
  ringFileMtimeMs = mtime;
  let fileTok: string | null = null;
  try {
    fileTok = fs.readFileSync(tokenFile(), 'utf8').trim() || null;
  } catch {
    /* keep current ring */
  }
  if (!fileTok) return false;
  readRevoked();
  if (isRevoked(fileTok)) {
    // Never adopt a revoked token as current; just shed any revoked entries we hold.
    // (A revoked CURRENT token here means the file was rolled back — initApiToken
    // rotates away from it on the next boot.)
    const kept = ring.filter((e) => !isRevoked(e.token));
    if (kept.length) ring = kept;
    return false;
  }
  const now = Date.now();
  const meta = readMeta(now);
  // Our former current token was retired by the OTHER process' rotation; its
  // sidecar normally carries the honest retiredAt — a missing/corrupt sidecar
  // fails open to `now`. Grace entries past the TTL never resurrect, and a revoked
  // token never re-enters (an older build may have written it back into `previous`).
  const candidates: GraceEntry[] = [
    ...(meta ? meta.previous : []),
    ...ring.map((e) => ({ token: e.token, retiredAt: e.retiredAt ?? now })),
  ];
  const merged: RingEntry[] = [{ token: fileTok, retiredAt: null }];
  for (const e of candidates) {
    if (inGrace(e, now) && !isRevoked(e.token) && !merged.some((m) => m.token === e.token)) merged.push(e);
  }
  ring = merged.slice(0, RING_SIZE);
  if (meta) lastRotatedAt = meta.lastRotatedAt;
  return true;
}

export function rotateApiToken(now: number = Date.now()): string {
  if (!ring.length) initApiToken(now);
  const next = gen();
  // The outgoing current token is retired AT this rotation; grace entries past
  // their TTL are dropped here (as well as at load), so a retired token never
  // outlives GRACE_MS just because the ring has spare depth.
  const retired: RingEntry[] = ring
    .map((e) => (e.retiredAt === null ? { token: e.token, retiredAt: now } : e))
    .filter((e) => inGrace(e as GraceEntry, now) && !isRevoked(e.token));
  ring = [{ token: next, retiredAt: null }, ...retired].slice(0, RING_SIZE);
  lastRotatedAt = now;
  writeToken(next);
  writeMeta({ lastRotatedAt: now, previous: graceEntries() });
  return next;
}

export interface RotateNowResult {
  rotatedAt: number;
  revokedCount: number;
}

/**
 * Operator revoke-now: mint a fresh token and revoke EVERY token this process or the
 * files know (the ring, the token file's, the meta sidecar's grace entries) — no grace.
 * NEVER runs on boot or on a timer; only `cli.js token rotate --now` and
 * POST /auth/token/rotate call it. Returns no token (callers re-read the file).
 *
 * Order matters: the revocations — and the fresh meta (lastRotatedAt, empty grace) — are
 * written BEFORE the new token file. A peer Core reseeds only when it notices the
 * token-file change (mtime), so by then it already finds both on disk: the old tokens
 * are filtered out and its tokenGeneration() moves in the same step.
 * Throws when the revoke list or the new token file could not be written — a rotation
 * that did not land must not be reported as done.
 */
export function rotateApiTokenNow(now: number = Date.now()): RotateNowResult {
  if (!ring.length) initApiToken(now);
  const known = new Set<string>(ring.map((e) => e.token));
  try {
    const fileTok = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (fileTok) known.add(fileTok);
  } catch {
    /* no file — the ring is all there is */
  }
  const meta = readMeta(now);
  for (const e of meta?.previous ?? []) known.add(e.token);

  const revokedCount = appendRevoked([...known], now); // FIRST (see above)
  const next = gen();
  ring = [{ token: next, retiredAt: null }];
  lastRotatedAt = now;
  writeMeta({ lastRotatedAt: now, previous: [] });
  writeToken(next); // LAST: the change peers watch for
  let onDisk = '';
  try {
    onDisk = fs.readFileSync(tokenFile(), 'utf8').trim();
  } catch {
    /* handled below */
  }
  if (onDisk !== next) throw new Error(`could not write the new token to ${tokenFile()}`);
  lastFileCheckAt = 0;
  return { rotatedAt: now, revokedCount };
}

/** Tokens a derived credential (ttyd caps) may have been minted from: the current
 *  token plus the grace tokens still inside their TTL. Rechecks the file first so a
 *  revoke-now elsewhere kills derived credentials here too. */
export function ringTokensForDerivation(): string[] {
  if (!ring.length) initApiToken();
  maybeRecheckTokenFile();
  const now = Date.now();
  return ring
    .filter((e) => e.retiredAt === null || inGrace({ token: e.token, retiredAt: e.retiredAt }, now))
    .map((e) => e.token);
}

/** An opaque tag that changes on every rotation (scheduled, revoke-now, or one absorbed
 *  from another process) — clients holding token-derived URLs refetch when it moves. */
export function tokenGeneration(): string {
  if (!ring.length) initApiToken();
  maybeRecheckTokenFile();
  return Math.max(0, Math.floor(lastRotatedAt)).toString(36);
}

/** Rotation status for `cli.js token status` — counts and timestamps, never values.
 *  Read-only: it reads the files as they are and never inits, writes or rotates. */
export function apiTokenStatus(now: number = Date.now()): {
  lastRotatedAt: number | null;
  graceCount: number;
  revokedCount: number;
} {
  const meta = readMeta(now);
  const revoked = new Set(readRevokedEntries().map((e) => e.sha256));
  const graceCount = (meta?.previous ?? []).filter((e) => inGrace(e, now) && !revoked.has(sha256Hex(e.token))).length;
  return { lastRotatedAt: meta ? meta.lastRotatedAt : null, graceCount, revokedCount: revoked.size };
}

/** Boot-time + scheduled rotation. A scheduled rotation KEEPS the grace ring (clients
 *  re-read the file at their own pace); nothing here clears grace or revokes — that is
 *  rotateApiTokenNow, an explicit operator action that never runs on boot. */
export function startApiTokenRotation(now: number = Date.now()): void {
  initApiToken(now);
  if (timer) return;
  // The deadline is persisted (sidecar), not per-process: a fleet that restarts
  // Core more often than ROTATE_MS still rotates. Overdue at boot → rotate
  // immediately; otherwise arm only the REMAINING window, never a fresh one.
  const elapsed = Math.max(0, now - lastRotatedAt);
  if (elapsed >= ROTATE_MS) {
    try {
      rotateApiToken(now);
    } catch {
      /* keep prior token on failure */
    }
    armRotation(ROTATE_MS);
  } else {
    armRotation(ROTATE_MS - elapsed);
  }
}

// Count down in <= MAX_TIMER_MS chunks so a long window (e.g. 30 days) never
// overflows Node's timer cap. Rotate only once the full window has elapsed,
// then re-arm for the next full window.
function armRotation(totalMs: number): void {
  armedMs = totalMs;
  armChunk(totalMs);
}
function armChunk(remainingMs: number): void {
  const step = Math.min(MAX_TIMER_MS, remainingMs);
  timer = setTimeout(() => {
    const left = remainingMs - step;
    if (left > 0) {
      armChunk(left);
    } else {
      try {
        rotateApiToken();
      } catch {
        /* keep prior token on failure */
      }
      armRotation(ROTATE_MS);
    }
  }, step);
  timer.unref?.();
}

// --- client side: token to attach to an outbound loopback call to the worker ---
let fileCache: { tok: string; mtimeMs: number } | null = null;
function readTokenFromFile(): string | null {
  try {
    const f = tokenFile();
    const st = fs.statSync(f);
    if (!fileCache || fileCache.mtimeMs !== st.mtimeMs) {
      fileCache = { tok: fs.readFileSync(f, 'utf8').trim(), mtimeMs: st.mtimeMs };
    }
    return fileCache.tok || null;
  } catch {
    return null;
  }
}

/** The token to send: the live ring token when called in the worker process,
 *  else the file (for a separate process such as the stdio MCP). */
export function localApiToken(): string | null {
  return ring.length ? ring[0].token : readTokenFromFile();
}

/** Headers to spread into an outbound loopback request to the worker API. */
export function lmAuthHeaders(): Record<string, string> {
  const t = localApiToken();
  return t ? { 'x-api-key': t } : {};
}

export function apiAuthEnabled(): boolean {
  const v = process.env.LM_ASSIST_API_AUTH;
  return v !== '0' && v !== 'off' && v !== 'false';
}

/** Resolve the credential a request presents to the rest-server auth gate:
 *  the `x-api-key` header, ONLY. Null means "no credential offered".
 *
 *  Query-string acceptance was removed entirely: a query token lands in URLs,
 *  access logs, Referer headers and browser resource-timing entries, and the
 *  one legitimate query-credential case never reaches this gate. Verified: no
 *  HTTP route exists at /voice/stt/ws or /voice/claude/ws — the voice WS
 *  upgrades ride `server.on('upgrade')` → routeUpgrade (rest-server.ts) and
 *  authenticate their own `?token=` INSIDE the upgrade handlers
 *  (voice-relay.ts / claude-voice-relay.ts), so they never traverse the HTTP
 *  request path, and no repo consumer sends `?apiKey=` (both voice-url.ts
 *  builders send `?token=`). */
export function resolveProvidedApiKey(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  return h || null;
}

let _localAddrs: Set<string> | null = null;
let _localAddrsAt = 0;
// Re-read the interface list at most once a minute: it was cached for the process
// lifetime, so a DHCP renewal or a VPN coming up left a stale "own address" set
// (a departed address stayed trusted, a new one was refused) until a restart.
const LOCAL_ADDRS_TTL_MS = 60_000;

/** This machine's own addresses: loopback, every interface address, and the
 *  IPv4-mapped form of each IPv4 one. Cached for LOCAL_ADDRS_TTL_MS. */
export function localAddressSet(): Set<string> {
  const now = Date.now();
  if (_localAddrs && now - _localAddrsAt < LOCAL_ADDRS_TTL_MS) return _localAddrs;
  const s = new Set<string>(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  try {
    const nets = networkInterfaces();
    for (const ifaces of Object.values(nets)) {
      for (const i of ifaces || []) {
        s.add(i.address);
        if (i.family === 'IPv4') s.add('::ffff:' + i.address);
      }
    }
  } catch {
    /* best effort */
  }
  _localAddrs = s;
  _localAddrsAt = now;
  return s;
}

/** True when the remote address is this machine itself (loopback or one of its
 *  own interface IPs). Callers deciding TRUST must use peer-trust.ts's
 *  isDirectLocalPeer instead, which also refuses a proxied request. */
export function isLocalAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  return localAddressSet().has(ip);
}

export function apiTokenFilePath(): string {
  return tokenFile();
}

export function apiTokenMetaFilePath(): string {
  return metaFile();
}

export function apiTokenRevokedFilePath(): string {
  return revokedFile();
}

// --- test hooks -------------------------------------------------------------

/** Drop all module state (ring, timer, clock stamps, file caches). */
export function __resetApiTokenState(): void {
  ring = [];
  lastRotatedAt = 0;
  ringFileMtimeMs = -1;
  armedMs = null;
  fileCache = null;
  lastFileCheckAt = 0;
  revokedCache = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Let the next isValidToken recheck the token file immediately (simulates the
 *  throttle window elapsing in cross-process tests). */
export function __resetFileRecheck(): void {
  lastFileCheckAt = 0;
}

/** The most recent full countdown armed by startApiTokenRotation, in ms. */
export function __armedRotationMs(): number | null {
  return armedMs;
}
