import { NextRequest, NextResponse } from 'next/server';
import { coreBaseUrlServer } from './server-auth';

const CHECK_TIMEOUT_MS = 3_000;
/** Printable ASCII only — anything else cannot be a Core token, and fetch() would throw on it. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/;

function deny(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Does the Origin name the same host:port the request was sent to? */
function isSameOrigin(origin: string, host: string): boolean {
  try {
    const o = new URL(origin);
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    // Parse the Host header under the Origin's scheme so a default port written
    // explicitly on one side (":443") still compares equal to an omitted one.
    const h = new URL(`${o.protocol}//${host}`);
    return o.host === h.host;
  } catch {
    return false;
  }
}

/**
 * Gate for the web server's state-changing API routes (PUT/POST /api/server).
 *
 * The web server runs on the node and can do privileged things (flip LAN access,
 * run core.sh), yet it is reachable by any LAN device and any page that can post a
 * form. So a caller must prove two things:
 *   1. Same-origin: an Origin whose host equals the Host it sent to. Browsers always
 *      attach Origin to state-changing fetches, so a missing one means a non-browser
 *      or a relayed call, neither of which has a legitimate use here. Cross-site
 *      form posts and DNS-rebinding pages fail this check.
 *   2. The node's Core token, verified BY CORE (GET /auth/check re-validates against
 *      the current token and the grace ring) so the web never needs its own copy of
 *      the rotation logic.
 * Fails closed: if Core cannot be asked, the answer is 503, never "allowed".
 * Returns null when the caller may proceed, else the response to send.
 */
export async function requireWebCaller(req: NextRequest): Promise<NextResponse | null> {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host || !isSameOrigin(origin, host)) {
    return deny(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  }

  const key = req.headers.get('x-api-key');
  if (!key || !KEY_SHAPE.test(key)) {
    return deny(401, 'UNAUTHORIZED', 'Missing or invalid API token');
  }

  let res: Response;
  try {
    res = await fetch(`${coreBaseUrlServer()}/auth/check`, {
      method: 'GET',
      headers: { 'x-api-key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return deny(503, 'CORE_UNREACHABLE', 'Cannot verify the API token: Core is not reachable');
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* not Core's envelope */ }

  // Both the status and Core's own verdict: a 200 from anything that is not Core's
  // /auth/check (another server on the port, an older Core) must not count as a yes.
  if (res.status === 200 && body?.success === true && body?.data?.valid === true) return null;
  if (res.status >= 500) {
    return deny(503, 'CORE_UNREACHABLE', 'Cannot verify the API token: Core returned an error');
  }
  return deny(401, 'UNAUTHORIZED', 'Missing or invalid API token');
}
