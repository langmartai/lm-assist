/**
 * ttyd path capabilities — how a terminal iframe authenticates to Core's ttyd proxy.
 *
 * An iframe cannot send headers, and cookies do not work either (the dashboard on
 * localhost:<webPort> embeds Core on 127.0.0.1:<corePort> — cross-site, so SameSite
 * cookies never flow, SameSite=None needs Secure which plain http cannot give, and
 * third-party cookie blocking breaks cross-site iframes anyway). So Core mints a
 * capability and puts it in the iframe URL: /ttyd-proxy/<port>/c/<cap>/.
 *
 *   key = HMAC-SHA256(ringToken, 'lm-assist/ttyd-cap/v1')
 *   cap = base64url(HMAC-SHA256(key, `${port}:${instanceId}`))   — 43 chars
 *
 * Why this shape:
 *  - Bound to ONE ttyd instance (port + instance id): a later instance reusing the port
 *    gets a different cap, so an old URL never opens a new terminal.
 *  - Deterministic for the instance's life: the terminal dashboard re-derives iframe URLs
 *    on every /ttyd/processes poll, and a fresh ticket per poll would reload the iframe.
 *  - Survives a Core restart: derived from the persisted token ring, not process memory.
 *  - Dies with the token: valid through the grace window of a scheduled rotation (derived
 *    from any in-grace ring token), dead at once after rotateApiTokenNow.
 *  - In the PATH, not the query: ttyd 1.6.3 builds its sub-URLs from location.pathname —
 *    measured from its page: ws = proto//host + pathname + '/ws' + search, and
 *    token = proto//host + pathname + '/token' (no search) — so a query credential would
 *    never reach /token, while a path segment rides along on both.
 *
 * The cap never leaves Core except inside a URL Core itself returns to an authenticated
 * caller; the web treats those URLs as opaque.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { currentApiToken, ringTokensForDerivation } from './api-token';

export const TTYD_CAP_RE = /^[A-Za-z0-9_-]{43}$/;
const CAP_CONTEXT = 'lm-assist/ttyd-cap/v1';

export function mintTtydCap(port: number, instanceId: string, token: string = currentApiToken()): string {
  const key = createHmac('sha256', token).update(CAP_CONTEXT).digest();
  return createHmac('sha256', key).update(`${port}:${instanceId}`).digest('base64url');
}

/** True when `cap` was minted for (port, instanceId) from the current or an in-grace
 *  ring token. Constant-time per candidate. */
export function verifyTtydCap(cap: string | null | undefined, port: number, instanceId: string): boolean {
  if (!cap || !TTYD_CAP_RE.test(cap) || !instanceId) return false;
  const presented = Buffer.from(cap, 'utf8');
  let ok = false;
  for (const t of ringTokensForDerivation()) {
    const expected = Buffer.from(mintTtydCap(port, instanceId, t), 'utf8');
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) ok = true;
  }
  return ok;
}
