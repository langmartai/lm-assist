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
 * stays good for RING_SIZE-1 more rotation windows — a couple of windows of
 * grace for any client to notice the file changed and re-read. A client that
 * still presents an aged-out token gets a 401 and re-reads + retries.
 *
 * Rotation state (lastRotatedAt + the grace ring) persists in a sidecar,
 * `<dataDir>/api-token.meta.json` (0600), so restarts neither restart the
 * rotation window nor drop the grace tokens. The token file itself stays a
 * RAW token string — external consumers (core.sh, bin/lm-assist.js,
 * ccr/ccr-bridge.js, core/hooks/*, core/scripts/lib/loopback-auth.js, the web
 * SSR layout/server-auth, the e2e scripts) cat/trim it as-is. A missing or
 * corrupt sidecar fails open: current file token only, window re-stamped now.
 *
 * The token is NEVER exposed to the LLM / MCP tool layer: it is read from disk
 * and attached server-side. It is a SEPARATE secret from the langmart hub API
 * key, with its own blast radius.
 *
 * Env:
 *   LM_ASSIST_API_AUTH=0|off|false   disable enforcement (emergency kill-switch)
 *   LM_ASSIST_API_TOKEN_RING=N       ring depth (default 3)
 *   LM_ASSIST_API_TOKEN_ROTATE_MS=N  rotation interval ms (default 30 days)
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getDataDir } from '../utils/path-utils';
import { networkInterfaces } from 'os';

const RING_SIZE = Math.max(1, Number(process.env.LM_ASSIST_API_TOKEN_RING) || 3);
const ROTATE_MS = Math.max(1_000, Number(process.env.LM_ASSIST_API_TOKEN_ROTATE_MS) || 30 * 24 * 60 * 60 * 1000);
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
function gen(): string {
  return randomBytes(32).toString('hex');
}

// index 0 = current token; the rest are still-valid grace tokens.
let ring: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
// Epoch ms of the last rotation (or of first boot / a fresh stamp when the
// sidecar was missing/corrupt). Persisted so restarts do NOT restart the window.
let lastRotatedAt = 0;
// mtime of the token file when the ring was last seeded/written — lets an auth
// miss detect a rotation performed by ANOTHER core process sharing <dataDir>.
let ringFileMtimeMs = -1;
// Most recent full countdown armed by startApiTokenRotation (test observability).
let armedMs: number | null = null;

interface ApiTokenMeta {
  lastRotatedAt: number;
  previous: string[]; // grace tokens, newest first (ring minus the current token)
}

function readMeta(): ApiTokenMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    const last = raw?.lastRotatedAt;
    if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) return null;
    const previous = Array.isArray(raw?.previous)
      ? raw.previous.filter((t: unknown): t is string => typeof t === 'string' && t.length > 0).slice(0, RING_SIZE - 1)
      : [];
    return { lastRotatedAt: last, previous };
  } catch {
    return null; // absent/corrupt → caller fails open (fresh stamp, never crash)
  }
}

function writeMeta(meta: ApiTokenMeta): void {
  const f = metaFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...meta }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f); // atomic replace
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    /* best effort — the window just re-stamps on the next boot */
  }
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
  if (ring.length) return ring[0];
  let seed: string | null = null;
  try {
    const c = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (c) seed = c;
  } catch {
    /* no file yet */
  }
  noteTokenFileMtime();
  if (seed) {
    const meta = readMeta();
    if (meta) {
      ring = [seed, ...meta.previous.filter((t) => t !== seed)].slice(0, RING_SIZE);
      lastRotatedAt = meta.lastRotatedAt;
    } else {
      // Missing/corrupt sidecar — fail open to the pre-sidecar behavior:
      // current token only, window starts NOW (stamped so the next boot keeps
      // counting instead of restarting from zero again).
      ring = [seed];
      lastRotatedAt = now;
      writeMeta({ lastRotatedAt: now, previous: [] });
    }
  } else {
    const t = gen();
    ring = [t];
    lastRotatedAt = now;
    writeToken(t);
    writeMeta({ lastRotatedAt: now, previous: [] });
  }
  return ring[0];
}

export function currentApiToken(): string {
  return ring.length ? ring[0] : initApiToken();
}

export function isValidToken(tok: string | string[] | undefined | null): boolean {
  if (!tok) return false;
  const t = Array.isArray(tok) ? tok[0] : String(tok);
  if (!ring.length) initApiToken();
  if (ring.includes(t)) return true;
  return reseedIfFileChanged() && ring.includes(t);
}

/** On an auth miss, absorb a rotation performed by ANOTHER core process sharing
 *  <dataDir> (dev :3200 and prod :3100 share one api-token file): if the token
 *  file changed since this process last seeded/wrote it, fold the file's
 *  current token and the sidecar's grace ring into ours. Costs one statSync
 *  per MISS — ring hits stay free. */
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
  const meta = readMeta();
  const merged = [fileTok, ...(meta ? meta.previous : []), ...ring];
  ring = merged.filter((t, i) => merged.indexOf(t) === i).slice(0, RING_SIZE);
  if (meta) lastRotatedAt = meta.lastRotatedAt;
  return true;
}

export function rotateApiToken(now: number = Date.now()): string {
  if (!ring.length) initApiToken(now);
  const next = gen();
  ring = [next, ...ring].slice(0, RING_SIZE);
  lastRotatedAt = now;
  writeToken(next);
  writeMeta({ lastRotatedAt: now, previous: ring.slice(1) });
  return next;
}

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
  return ring.length ? ring[0] : readTokenFromFile();
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

/** The ONLY paths allowed to authenticate via the `apiKey` query parameter:
 *  the voice WebSocket upgrade paths — a browser cannot set headers on a WS
 *  upgrade, so `web/src/lib/voice-url.ts` rides the token in the query string
 *  (the upgrade handlers themselves validate `?token=`; this list covers the
 *  same paths on the plain-HTTP side). Everywhere else the token must arrive
 *  as `x-api-key`: a query token lands in URLs, access logs, Referer headers
 *  and browser resource-timing entries. */
const QUERY_APIKEY_PATHS = new Set(['/voice/stt/ws', '/voice/claude/ws']);

/** Resolve the credential a request presents to the rest-server auth gate:
 *  the `x-api-key` header anywhere, or — on the voice WS paths only — the
 *  `?apiKey=` query fallback. Null means "no acceptable credential offered". */
export function resolveProvidedApiKey(
  header: string | string[] | undefined,
  url: string,
): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (h) return h;
  if (!QUERY_APIKEY_PATHS.has(url.split('?')[0])) return null;
  try {
    return new URL(url, 'http://localhost').searchParams.get('apiKey');
  } catch {
    return null;
  }
}

let _localAddrs: Set<string> | null = null;
/** True when the remote address is this machine itself (loopback or one of its
 *  own interface IPs) — mirrors /auth/is-local. Used for the optional
 *  LM_ASSIST_API_AUTH_EXEMPT_LOCAL gate exemption (trust the local desk). */
export function isLocalAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  if (!_localAddrs) {
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
  }
  return _localAddrs.has(ip);
}

export function apiTokenFilePath(): string {
  return tokenFile();
}

export function apiTokenMetaFilePath(): string {
  return metaFile();
}

// --- test hooks -------------------------------------------------------------

/** Drop all module state (ring, timer, clock stamps, file caches). */
export function __resetApiTokenState(): void {
  ring = [];
  lastRotatedAt = 0;
  ringFileMtimeMs = -1;
  armedMs = null;
  fileCache = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** The most recent full countdown armed by startApiTokenRotation, in ms. */
export function __armedRotationMs(): number | null {
  return armedMs;
}
