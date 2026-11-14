/**
 * Origin policy — which browser origins are "this machine's own web UI".
 *
 * Core used to answer every request with `Access-Control-Allow-Origin: *`, so any page
 * the operator visited could read Core responses cross-origin (and the tokenless ttyd
 * proxy made that a drive-by read). Now an Origin is reflected only when it is one of
 * this machine's web origins: {own hostnames} × {webPort over http, httpsPort over https}.
 * The one exception is the scoped-token route allow-list (scoped-token.ts), which keeps
 * any-origin reflection so `lmsc_` embeds on a foreign page still work — those routes
 * accept only a narrow, revocable token.
 *
 * Requests without an Origin (CLI, MCP, hooks, fabric, hub relay, local-tier BFF) are
 * unaffected: CORS is a browser mechanism.
 *
 * Env:
 *   WEB_PORT / ASSIST_WEB_PORT   the web UI port (both launchers pass WEB_PORT to Core)
 *   LM_HTTPS_PORT                the HTTPS terminator port (default webPort + 1)
 *   LM_ASSIST_ALLOWED_HOSTS      extra own hostnames, CSV (a DNS name, a NAT/port-proxy IP)
 *   LM_ASSIST_CORS_ORIGINS       extra exact origins, CSV (e.g. https://desk.example:8443)
 */
import * as os from 'os';
import { localAddressSet } from './api-token';
import { isScopedRoute } from './scoped-token';

export const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-API-Key, X-LM-Client, X-LM-LAN-Key';
const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const CORS_MAX_AGE = '600';
const HOSTNAMES_TTL_MS = 60_000;

/** The web UI ports. Same precedence the HTTPS terminator always used (and now uses
 *  from here): WEB_PORT, then ASSIST_WEB_PORT, then the prod/dev default. */
export function resolveWebPorts(): { webPort: number; httpsPort: number } {
  // Same prod/dev detection pattern as cli.ts (LM_ASSIST_PROD overrides).
  const isProdInstall = process.env.LM_ASSIST_PROD === 'true' || __dirname.includes('node_modules');
  const webPort = parseInt(
    process.env.WEB_PORT || process.env.ASSIST_WEB_PORT || (isProdInstall ? '3848' : '3948'),
    10,
  );
  const httpsPort = parseInt(process.env.LM_HTTPS_PORT || String(webPort + 1), 10);
  return { webPort, httpsPort };
}

function csv(v: string | undefined): string[] {
  return (v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Hostname of a Host header / authority: strips `:port` and IPv6 brackets, lowercases.
 *  `[::1]:3100` → `::1`, `LOCALHOST:3948` → `localhost`, a bare `::1` stays `::1`. */
export function hostnameOf(host: string | string[] | undefined | null): string {
  const h = (Array.isArray(host) ? host[0] : host || '').trim().toLowerCase();
  if (!h) return '';
  // IPv6 zone ids (`%eth0`, URL-encoded `%25eth0`) are dropped, like ownHostnames does.
  const noZone = (v: string) => v.split('%')[0];
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return noZone(end > 0 ? h.slice(1, end) : h.slice(1));
  }
  const firstColon = h.indexOf(':');
  // More than one colon and no brackets: a bare IPv6 literal, no port to strip.
  if (firstColon >= 0 && h.indexOf(':', firstColon + 1) >= 0) return noZone(h);
  return firstColon >= 0 ? h.slice(0, firstColon) : h;
}

let hostnamesCache: { set: Set<string>; at: number; extra: string } | null = null;

/** Every name this machine answers to: loopback names, each interface address (zone
 *  stripped), the OS hostname and its mDNS `.local` form, plus LM_ASSIST_ALLOWED_HOSTS.
 *  Cached for 60 s (DHCP / VPN changes are picked up without a restart). */
export function ownHostnames(): Set<string> {
  const now = Date.now();
  const extra = process.env.LM_ASSIST_ALLOWED_HOSTS || '';
  if (hostnamesCache && hostnamesCache.extra === extra && now - hostnamesCache.at < HOSTNAMES_TTL_MS) {
    return hostnamesCache.set;
  }
  const set = new Set<string>(['localhost', '127.0.0.1', '::1']);
  for (const a of localAddressSet()) {
    const bare = a.split('%')[0].toLowerCase();
    if (bare && !bare.startsWith('::ffff:')) set.add(bare);
  }
  try {
    const hn = os.hostname().trim().toLowerCase();
    if (hn) {
      set.add(hn);
      set.add(`${hn}.local`);
    }
  } catch {
    /* best effort */
  }
  for (const h of csv(extra)) {
    const n = hostnameOf(h);
    if (n) set.add(n);
  }
  hostnamesCache = { set, at: now, extra };
  return set;
}

/** True when a Host header names this machine. A DNS-rebinding page is same-origin
 *  with its own hostname, so its requests carry the ATTACKER's name here. */
export function isOwnHost(hostHeader: string | string[] | undefined | null): boolean {
  const h = hostnameOf(hostHeader);
  return !!h && ownHostnames().has(h);
}

function extraOrigins(): Set<string> {
  const out = new Set<string>();
  for (const o of csv(process.env.LM_ASSIST_CORS_ORIGINS)) {
    try {
      out.add(new URL(o).origin.toLowerCase());
    } catch {
      /* ignore malformed entries */
    }
  }
  return out;
}

/** Is `origin` one of this machine's own web origins (or an operator-listed extra)? */
export function isAllowedWebOrigin(origin: string | string[] | undefined | null): boolean {
  const o = (Array.isArray(origin) ? origin[0] : origin || '').trim();
  if (!o || o === 'null') return false;
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (extraOrigins().has(u.origin.toLowerCase())) return true;
  const { webPort, httpsPort } = resolveWebPorts();
  const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
  const portOk = (u.protocol === 'http:' && port === webPort) || (u.protocol === 'https:' && port === httpsPort);
  if (!portOk) return false;
  return ownHostnames().has(hostnameOf(u.host));
}

/** CORS response headers for one request. `Vary: Origin` always (the answer depends on
 *  it); the Allow-* set only when the Origin is allowed — an own web origin, or any
 *  origin on a scoped-token route (on a preflight the effective method is
 *  Access-Control-Request-Method). Never Allow-Credentials: the browser sends Core no
 *  cookies. */
export function corsHeadersFor(
  method: string | undefined,
  rawUrl: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = { Vary: 'Origin' };
  const originRaw = headers['origin'];
  const origin = (Array.isArray(originRaw) ? originRaw[0] : originRaw || '').trim();
  if (!origin) return out;
  const m = (method || 'GET').toUpperCase();
  const acrm = headers['access-control-request-method'];
  const effective = m === 'OPTIONS' ? String((Array.isArray(acrm) ? acrm[0] : acrm) || '').toUpperCase() : m;
  const pathName = (rawUrl || '/').split('?')[0];
  // Scoped routes reflect ANY origin (they were covered by `*` before, sandboxed
  // `null` embeds included); the route itself accepts only a narrow lmsc_ token.
  const allowed = isAllowedWebOrigin(origin) || (!!effective && isScopedRoute(effective, pathName));
  if (!allowed) return out;
  out['Access-Control-Allow-Origin'] = origin;
  out['Access-Control-Allow-Methods'] = CORS_ALLOW_METHODS;
  out['Access-Control-Allow-Headers'] = CORS_ALLOW_HEADERS;
  out['Access-Control-Max-Age'] = CORS_MAX_AGE;
  return out;
}

/** Test hook: drop the hostname cache. */
export function __resetOriginPolicyCache(): void {
  hostnamesCache = null;
}
