/**
 * Peer trust — "is the TCP peer really the caller, and is it this machine?"
 *
 * Every loopback / local-address trust decision in Core goes through here, because
 * a loopback socket alone proves nothing on this host:
 *
 *  - The web binds 0.0.0.0 and rewrites `/_coreapi/:path*` to 127.0.0.1:<core>, so a
 *    LAN browser reaches Core from loopback. Next's proxy ALWAYS marks that hop with
 *    `x-forwarded-host` (next/dist/server/lib/router-utils/proxy-request.js sets it to
 *    `req.headers.host || ''` — so the value can be the empty string).
 *  - The hub relay dials Core over loopback too, and marks every request with
 *    `x-relay-source` (api-relay-handler.makeLocalRequest), stripping any client copy.
 *
 * So a forwarding header's PRESENCE — any value, including '' — removes loopback trust.
 * A genuine console caller (the desk browser straight at Core, curl, the CLI, MCP,
 * hooks, the fabric's loopbackDispatch) sends none of them.
 *
 * `x-forwarded-proto` is deliberately NOT a forwarding header here: the HTTPS
 * terminator (tls/https-terminator.ts) sets it on an IN-PROCESS dispatch whose
 * req.socket IS the real TLS peer — nothing sits between that socket and Core, so the
 * desk on https://…:<webPort+1> must stay trusted. (harness.routes.ts keeps its own
 * stricter list that also refuses x-forwarded-proto: that write is console-only.)
 */
import { isLocalAddress } from './api-token';
import { isLoopbackAddress } from './enroll-exempt';

type Headers = Record<string, string | string[] | undefined> | undefined | null;

/** Headers a proxy hop adds between the real TCP peer and Core. PRESENCE (any value,
 *  even '') proves the socket peer is not the caller. */
export const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'] as const;

/** Set by the hub relay (and the fabric's loopback dispatch as 'peer'); the relay strips
 *  any client-supplied copy, so its presence means "arrived through a relay". */
export const RELAY_HEADER = 'x-relay-source';

function present(h: Headers, name: string): boolean {
  if (!h) return false;
  // Node lower-cases incoming header names; a hand-built map (tests, synthetic
  // requests) may not, so fall back to a case-insensitive scan.
  if (h[name] !== undefined) return true;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name && h[k] !== undefined) return true;
  }
  return false;
}

/** True when any forwarding header is PRESENT (value irrelevant, '' counts). */
export function hasForwardingHeaders(h?: Headers): boolean {
  return FORWARDING_HEADERS.some((name) => present(h, name));
}

/** True when the request came through the hub relay or the fabric loopback dispatch. */
export function isRelayed(h?: Headers): boolean {
  return present(h, RELAY_HEADER);
}

/** Strict loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) AND nothing between the socket
 *  and Core. `allowRelay` keeps relay-accepting guards working (the relay carries no
 *  forwarding headers — api-relay-handler strips them). */
export function isDirectLoopbackPeer(
  ip: string | undefined | null,
  h?: Headers,
  opts?: { allowRelay?: boolean },
): boolean {
  if (!isLoopbackAddress(ip)) return false;
  if (hasForwardingHeaders(h)) return false;
  if (!opts?.allowRelay && isRelayed(h)) return false;
  return true;
}

/** This machine (loopback OR one of its own interface IPs) AND nothing between the
 *  socket and Core. The desk browser on http://<own-LAN-IP>:<webPort> is local by
 *  this rule; the same address arriving through the web's /_coreapi rewrite is not. */
export function isDirectLocalPeer(
  ip: string | undefined | null,
  h?: Headers,
  opts?: { allowRelay?: boolean },
): boolean {
  if (!isLocalAddress(ip)) return false;
  if (hasForwardingHeaders(h)) return false;
  if (!opts?.allowRelay && isRelayed(h)) return false;
  return true;
}
