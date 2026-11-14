/**
 * GET /auth/browser-token — how a browser gets the Core token, since no HTML carries it.
 *
 * The web used to inline the ring token into every server-rendered page, so anything
 * that could fetch a page (a LAN device, the web's own /_coreapi rewrite, a relayed
 * request) walked away with full node authority. Now the browser asks Core at runtime,
 * and Core decides from the one signal nothing upstream can forge: the TCP peer.
 *
 * Decision order (first match wins; see decideBrowserToken):
 *   1. not GET                                   → 405 METHOD_NOT_ALLOWED
 *   2. x-relay-source present                    → 403 RELAYED   (the relay injects its own key)
 *   3. Origin present and not an own web origin  → 403 ORIGIN_NOT_ALLOWED
 *   4. X-LM-Client !== 'web'                     → 400 CLIENT_HEADER_REQUIRED
 *   5. LM_ASSIST_API_AUTH kill-switch off        → 200 { token: null, via: 'auth-disabled' }
 *   6. direct local peer AND Host is own         → 200 { token, via: 'local' }
 *   7. X-LM-LAN-Key present: valid while lanAuthEnabled → 200 via 'lan-key', else 401 LAN_KEY_INVALID
 *   8. anything else                             → 401 UNAUTHORIZED
 *
 * WHY each check:
 *  - The socket peer is the only honest "is this machine?" signal, and only when no
 *    forwarding header says a proxy stood in between (peer-trust.ts): Next's /_coreapi
 *    rewrite makes every LAN caller look like 127.0.0.1 but always adds x-forwarded-host.
 *  - Host defends against DNS rebinding: a rebound page's request is same-origin, so it
 *    carries no Origin — but it does carry the attacker's hostname.
 *  - X-LM-Client is a non-safelisted header, so a cross-origin caller must preflight
 *    (answered only for own origins), and no-cors fetches, <script>/<img> tags and
 *    navigations can never send it.
 *  - Any x-api-key on this route is IGNORED: a relayed hub browser must never be able to
 *    trade its injected key for the ring token.
 *
 * Stage-2 seam: `expiresAt` is always null today. A later short-lived browser credential
 * returns a number there and the web refreshes 60 s before it.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { apiAuthEnabled, currentApiToken } from './api-token';
import { isDirectLocalPeer, isRelayed } from './peer-trust';
import { isAllowedWebOrigin, isOwnHost } from './origin-policy';
import { readLanAccessConfig, type LanAccessConfig } from './lan-access';

type Headers = Record<string, string | string[] | undefined>;

export type BrowserTokenVia = 'local' | 'lan-key' | 'auth-disabled';

export interface BrowserTokenInput {
  method: string | undefined;
  remoteAddress: string | undefined | null;
  headers: Headers;
  authEnabled: boolean;
  lan: LanAccessConfig;
}

export interface BrowserTokenDecision {
  status: number;
  issue: boolean;
  via?: BrowserTokenVia;
  code?: string;
  message?: string;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time compare over fixed-length digests: no length oracle either. */
function lanKeyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/** Pure decision (no I/O) — the whole truth table lives here so tests can walk it. */
export function decideBrowserToken(input: BrowserTokenInput): BrowserTokenDecision {
  const { headers } = input;
  if ((input.method || '').toUpperCase() !== 'GET') {
    return { status: 405, issue: false, code: 'METHOD_NOT_ALLOWED', message: 'GET only' };
  }
  if (isRelayed(headers)) {
    return { status: 403, issue: false, code: 'RELAYED', message: 'relayed requests never receive a browser token' };
  }
  const origin = first(headers['origin']);
  if (origin !== undefined && origin !== '' && !isAllowedWebOrigin(origin)) {
    return { status: 403, issue: false, code: 'ORIGIN_NOT_ALLOWED', message: 'origin is not this machine’s web UI' };
  }
  if (first(headers['x-lm-client']) !== 'web') {
    return { status: 400, issue: false, code: 'CLIENT_HEADER_REQUIRED', message: 'X-LM-Client: web is required' };
  }
  if (!input.authEnabled) {
    return { status: 200, issue: false, via: 'auth-disabled' };
  }
  if (isDirectLocalPeer(input.remoteAddress, headers) && isOwnHost(headers['host'])) {
    return { status: 200, issue: true, via: 'local' };
  }
  const lanKey = first(headers['x-lm-lan-key']);
  if (lanKey !== undefined) {
    const expected = input.lan.lanAccessToken;
    if (input.lan.lanAuthEnabled !== false && expected && lanKeyMatches(lanKey, expected)) {
      return { status: 200, issue: true, via: 'lan-key' };
    }
    return { status: 401, issue: false, code: 'LAN_KEY_INVALID', message: 'LAN access key is invalid or LAN access is disabled' };
  }
  return { status: 401, issue: false, code: 'UNAUTHORIZED', message: 'sign in on this device first' };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(body));
}

/** Serve GET /auth/browser-token. Its own gate: rest-server dispatches it BEFORE the
 *  api-token gate. The token leaves only when the decision says `issue`. */
export function handleBrowserTokenRequest(req: IncomingMessage, res: ServerResponse): void {
  try {
    const d = decideBrowserToken({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      headers: req.headers as Headers,
      authEnabled: apiAuthEnabled(),
      lan: readLanAccessConfig(),
    });
    if (d.status === 200) {
      const token = d.issue ? currentApiToken() : null;
      send(res, 200, { success: true, data: { token, via: d.via, expiresAt: null } });
      return;
    }
    send(res, d.status, { success: false, error: { code: d.code, message: d.message } });
  } catch {
    // Never let a failure path carry a token (or an error string that might).
    if (!res.headersSent) send(res, 500, { success: false, error: { code: 'INTERNAL', message: 'browser-token failed' } });
    else res.end();
  }
}
