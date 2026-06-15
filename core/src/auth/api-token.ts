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
function gen(): string {
  return randomBytes(32).toString('hex');
}

// index 0 = current token; the rest are still-valid grace tokens.
let ring: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

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
  } catch {
    /* best effort — in-process auth still works via the ring */
  }
}

/** Initialize the ring. Seeds from the file if present so a restart keeps the
 *  token that clients already read still valid. */
export function initApiToken(): string {
  if (ring.length) return ring[0];
  let seed: string | null = null;
  try {
    const c = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (c) seed = c;
  } catch {
    /* no file yet */
  }
  if (seed) {
    ring = [seed];
  } else {
    const t = gen();
    ring = [t];
    writeToken(t);
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
  return ring.includes(t);
}

export function rotateApiToken(): string {
  if (!ring.length) initApiToken();
  const next = gen();
  ring = [next, ...ring].slice(0, RING_SIZE);
  writeToken(next);
  return next;
}

export function startApiTokenRotation(): void {
  initApiToken();
  if (timer) return;
  // Count down to the next rotation in <= MAX_TIMER_MS chunks so a long
  // ROTATE_MS (e.g. 30 days) never overflows Node's timer cap. Rotate only
  // once the full window has elapsed, then re-arm for the next window.
  const arm = (remainingMs: number): void => {
    const step = Math.min(MAX_TIMER_MS, remainingMs);
    timer = setTimeout(() => {
      const left = remainingMs - step;
      if (left > 0) {
        arm(left);
      } else {
        try {
          rotateApiToken();
        } catch {
          /* keep prior token on failure */
        }
        arm(ROTATE_MS);
      }
    }, step);
    timer.unref?.();
  };
  arm(ROTATE_MS);
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
