/**
 * Local serving tier — a hub-free HTTP origin PER pluggable-UI pane.
 *
 * Reproduces the ui-gateway's app contract on dedicated listeners so an UNMODIFIED pane
 * (an lmui static app) works with no hub in the loop. The gateway normally: authenticates
 * the viewer, sets a cookie, serves the app document with window.__VIEW_TOKEN__ / __UI_ID__
 * injected, proxies assets, and gates a /data plane against the app's declared grant. This
 * tier does the same against 127.0.0.1 services only.
 *
 * Trust model: an ENTRY token (short-lived, minted by the Core route) arrives once in ?lt=,
 * is exchanged for an HttpOnly cookie, and thereafter documents+assets authenticate on that
 * cookie. The /data plane authenticates ONLY on a Bearer view token (the 15-min token the
 * document injects) — never the cookie — so a page's data reach is exactly its declared
 * grant, and only service "node" (this host's Core API) is served here in v1.
 *
 * ── ONE ORIGIN PER PANE — the isolation boundary ──────────────────────────────────────────
 * 🔴 Read this before adding a surface, and especially before merging listeners back together.
 *
 * Every pane is served from its OWN listener on its OWN ephemeral port, so pane A and pane B
 * are DIFFERENT ORIGINS (origin = scheme + host + PORT). That is the whole isolation story:
 *   • pane A's `fetch('http://host:<B>/ui/B/')` is cross-origin → the response is blocked
 *     (CORS) or opaque (`mode:'no-cors'`); the token in the body is unreadable either way;
 *   • `<iframe src="http://host:<B>/…">` and `window.open(...)` yield a CROSS-ORIGIN window —
 *     `w.__VIEW_TOKEN__` throws SecurityError;
 *   • an `Authorization:` header is not CORS-safelisted, so a cross-origin /data call preflights
 *     — and NO `Access-Control-Allow-*` header is emitted anywhere in this tier, so the preflight
 *     fails and the real request is never even delivered.
 * A browser enforces all of that on EVERY transport — plain http to a LAN IP included.
 * 🔴 Corollary: adding any `Access-Control-Allow-*` header here hands every one of those reads
 * back, silently. `server.test.ts` asserts the absence directly, because no raw-HTTP test of the
 * vectors themselves could ever notice.
 *
 * 🔴 That last clause is why this shape exists and why the previous one had to go. The tier
 * used to serve every pane from ONE origin and lean on `Sec-Fetch-Dest: document` to tell a
 * top-level navigation from a scripted read. Fetch Metadata is sent ONLY to potentially
 * trustworthy origins (https + loopback). MEASURED, Chrome 145, over `http://<LAN-IP>` — the
 * URL `POST /ui-pages/<uiId>/local-url` actually hands out — the browser sends NO `Sec-Fetch-*`
 * header at all, on a scripted fetch AND on a real navigation. So on the shipped transport
 * that gate distinguished NOTHING: a hostile pane read a sibling's document with one plain
 * `fetch()` and spent the token, while `/go` (which refused an ABSENT header) was dead for
 * every legitimate LAN viewer. Request headers cannot be the boundary here. The ORIGIN is.
 *
 * The stable, documented address is the DISPATCHER on `localUiPort`: it serves no pane content
 * at all, only 302s to the right pane origin (plus the /panes chooser). `POST /ui-pages/local-url`
 * keeps minting exactly one URL and it keeps working — the extra hop is invisible.
 *
 * ⚠️ OPERATIONAL: pane ports are EPHEMERAL (listen(0)) and bound on 0.0.0.0, so a host that
 * firewalls inbound traffic to `localUiPort` alone would let a LAN viewer reach the dispatcher
 * and then fail on the redirect. MEASURED on THIS host (the LAN IP, 2026-08-13): `ufw status` is
 * inactive and the iptables INPUT policy is ACCEPT, so nothing filters a LAN viewer's path to an
 * ephemeral pane port. That is a ONE-HOST measurement, not a fleet property — the INPUT chain
 * here does carry targeted DROP rules (source 172.28.0.0/16, a container bridge, irrelevant to a
 * LAN viewer), and other nodes are NOT verified: 107 is Windows with an entirely different
 * firewall model. Re-measure per host before relying on this. If a host does filter, the fix is a
 * configured port BAND here, not a shared origin — merging panes back onto one port re-opens
 * everything above.
 *
 * 🔴 RESIDUAL — what one origin per pane does NOT close:
 *   • Cookies ignore PORT (they are host-scoped), so every pane's `lm_ui_*` cookie rides
 *     requests to every pane origin on this host. Nothing here trusts an ambient cookie for
 *     anything but "this browser has a live session": a document/asset/remint needs the cookie
 *     for THAT pane on THAT pane's own origin, and /data is Bearer-only. A scripted `/go` can
 *     still cause a sibling's cookie to be MINTED into the jar — and that buys nothing, because
 *     reading anything back is a cross-origin read.
 *   • A NON-browser client that already holds a cookie (i.e. has already defeated HttpOnly, or
 *     is a process on this host) is unconstrained — it has no same-origin policy to bind it.
 *     MEASURED, and it is the honest reading of the raw-HTTP PoC: such a client can still walk
 *     /go → follow the cross-origin 302 → read the token, because nothing stops a client that
 *     ignores origins. Out of scope by construction: this tier is OWNER-ONLY, and that
 *     constraint is load-bearing, not aspirational.
 *   • The dispatcher answers 302-vs-404 for `/ui/<id>/` BEFORE any auth (it must not touch the
 *     single-use entry token), so a stranger who can reach the port can test whether a GIVEN id
 *     is served. The LIST is owner-gated; individual existence is not.
 *   • Visual spoofing (a pane rendering a fake sibling) is not addressed by origins.
 *
 * /go/<uiId> (+ its chooser at /panes) is the cross-pane navigation contract: a pane calls
 * lmui.goto(uiId, params) and THIS decides where that lands, because the destination shape
 * differs between tiers and is not a pane's to assemble — and here it is a CROSS-ORIGIN URL,
 * which a pane could not have built even if it were allowed to.
 */

import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { loadOrCreateSecret, mintViewToken, verifyViewToken, verifyViewTokenForProof, verifyEntryToken } from './token';
import { readDeclaredGrant, grantAllows, resolveDataTarget } from './grants';
import { loopbackOptions } from '../../utils/loopback-http';
import { UI_ID_RE, sanitizeNavQuery } from './nav';
import { listReportableUis } from '../manager';

export interface LocalTierOptions {
  localUiPort: number;
  uiWebPort: number;
  apiPort: number;
  getApiToken: () => string;
  log?: (m: string) => void;
}

const COOKIE_TTL_MS = 8 * 60 * 60 * 1000; // document cookie: an 8h working session
const BODY_CAP = 1024 * 1024;             // /data request body ceiling (1MB → 413)
// One listener per pane, so the count is bounded on purpose: only ids this node actually
// serves ever get one (see paneIsServedHere), and the ceiling caps sockets if that list grows.
const MAX_PANE_ORIGINS = 64;

// Module-level so the Core status route can report liveness (isLocalTierRunning) and so a
// second start on the same process is a no-op rather than a second bind.
let _server: http.Server | null = null;
let _running = false;
let _opts: LocalTierOptions | null = null;
let _log: Log = () => {};
/** uiId → its own origin. Created lazily on first visit, closed by stopTier. */
const _panes = new Map<string, { server: http.Server; port: number }>();
/** In-flight creations, so two concurrent requests for one pane bind ONE port. */
const _paneStarts = new Map<string, Promise<number>>();

export function isLocalTierRunning(): boolean {
  return _running;
}

/**
 * The port a pane's OWN origin listens on, or null before its first visit.
 * Diagnostic/test seam — production callers reach a pane through the dispatcher's 302.
 */
export function panePortFor(uiId: string): number | null {
  return _panes.get(uiId)?.port ?? null;
}

export function startLocalUiTier(opts: LocalTierOptions): () => void {
  const log = opts.log || (() => {});
  if (_server) {
    log('[local-tier] already running — start ignored');
    return stopTier;
  }
  try { loadOrCreateSecret(); } catch { /* mint paths create it lazily anyway */ }
  _opts = opts;
  _log = log;

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch((e) => fail(req, res, log, e));
  });
  // Binding is not allowed to take Core down: log and leave the tier off. EADDRINUSE fires
  // ASYNCHRONOUSLY, so _server/_running are set ONLY from the listening callback — a failed
  // bind leaves both unset (isLocalTierRunning() false, no dangling server ref to close).
  server.on('error', (e) => { _running = false; _server = null; log(`[local-tier] listen failed: ${errMsg(e)}`); });
  server.listen(opts.localUiPort, '0.0.0.0', () => {
    _server = server;
    _running = true;
    log(`[local-tier] dispatcher on 0.0.0.0:${opts.localUiPort} (ui=${opts.uiWebPort} api=${opts.apiPort}); each pane gets its own origin`);
  });
  return stopTier;
}

function stopTier(): void {
  _running = false;
  const s = _server;
  _server = null;
  _opts = null;
  if (s) { try { s.close(); } catch { /* already closing */ } }
  for (const { server } of _panes.values()) { try { server.close(); } catch { /* already closing */ } }
  _panes.clear();
  _paneStarts.clear();
}

function fail(req: IncomingMessage, res: ServerResponse, log: Log, e: unknown): void {
  try {
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('local tier: internal error'); }
    else res.end();
  } catch { /* socket already gone */ }
  log(`[local-tier] 500 ${req.method} ${req.url}: ${errMsg(e)}`);
}

// ── pane origins ─────────────────────────────────────────────────────────────────────────

/** Only a uiId this node actually serves may consume a port. */
function paneIsServedHere(uiId: string): boolean {
  try { return listReportableUis().some((u) => u.uiId === uiId); } catch { return false; }
}

/**
 * The pane's own listener, created on first visit.
 *
 * 🔴 There is deliberately NO fallback to the dispatcher origin. If a port cannot be bound the
 * caller gets a 503 — serving the pane next to a sibling instead would silently restore the
 * shared origin this whole design exists to eliminate.
 */
function ensurePaneOrigin(uiId: string): Promise<number> {
  const live = _panes.get(uiId);
  if (live) return Promise.resolve(live.port);
  const inflight = _paneStarts.get(uiId);
  if (inflight) return inflight;
  if (_panes.size >= MAX_PANE_ORIGINS) {
    return Promise.reject(new Error(`pane-origin limit reached (${MAX_PANE_ORIGINS})`));
  }
  const started = new Promise<number>((resolve, reject) => {
    let settled = false;
    const s = http.createServer((rq, rs) => {
      handlePane(uiId, rq, rs).catch((e) => fail(rq, rs, _log, e));
    });
    s.on('error', (e) => {
      if (settled) { _log(`[local-tier] pane origin ${uiId} error: ${errMsg(e)}`); return; }
      settled = true;
      _paneStarts.delete(uiId);
      reject(e);
    });
    s.listen(0, '0.0.0.0', () => {
      settled = true;
      const port = (s.address() as AddressInfo).port;
      _panes.set(uiId, { server: s, port });
      _paneStarts.delete(uiId);
      _log(`[local-tier] pane origin ${uiId} → 0.0.0.0:${port}`);
      resolve(port);
    });
  });
  _paneStarts.set(uiId, started);
  return started;
}

/**
 * The host the VIEWER dialled, from its own Host header — never the socket address.
 *
 * Cookies are scoped by HOST, so a redirect that swapped `myhost.local` for `the LAN IP`
 * would strand the session it just minted. The charset is narrow enough that nothing can be
 * smuggled into the Location header; a missing/odd Host falls back to loopback. A viewer
 * "attacking" its own Host header only ever redirects itself.
 */
function viewerHost(req: IncomingMessage): string {
  let host = (headerStr(req.headers.host) || '').trim();
  if (host.startsWith('[')) {                       // [::1]:1234 → [::1]
    const i = host.indexOf(']');
    host = i > 0 ? host.slice(0, i + 1) : '';
    return /^\[[0-9a-fA-F:.]{2,45}\]$/.test(host) ? host : '127.0.0.1';
  }
  const i = host.lastIndexOf(':');
  if (i >= 0) host = host.slice(0, i);
  return /^[A-Za-z0-9.-]{1,253}$/.test(host) ? host : '127.0.0.1';
}

/** Absolute URL on a pane's own origin, reached from wherever this request landed. */
function paneUrl(req: IncomingMessage, port: number, pathAndQuery: string): string {
  return `http://${viewerHost(req)}:${port}${pathAndQuery}`;
}

// ── request routing ──────────────────────────────────────────────────────────────────────

interface Parsed { method: string; rawPath: string; search: string; url: string }
function parseReq(req: IncomingMessage): Parsed {
  const url = req.url || '/';
  const qIdx = url.indexOf('?');
  return {
    method: (req.method || 'GET').toUpperCase(),
    rawPath: qIdx >= 0 ? url.slice(0, qIdx) : url,
    search: qIdx >= 0 ? url.slice(qIdx) : '',
    url,
  };
}

/**
 * The DISPATCHER (localUiPort) — the one stable address, and it serves no pane content.
 *
 * It knows three things: where a pane lives (302), how to start a cross-pane navigation
 * (/go, which is a 302 to another origin), and how to list what is here (/panes). No document,
 * no asset, no /data, no remint: nothing that hands out a credential a script could read, so
 * there is nothing here for a pane to reach cross-origin in the first place.
 */
async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, rawPath, search, url } = parseReq(req);
  const log = _log;

  const uiMatch = /^\/ui\/([^/]+)(\/.*)?$/.exec(rawPath);
  if (uiMatch) return redirectToPane(req, res, log, uiMatch[1], url);

  const goMatch = /^\/go\/([^/]+)$/.exec(rawPath);
  if (goMatch) {
    if (method !== 'GET') return reply(res, log, 405, 'text/plain', 'local tier: /go is GET only', undefined, `${method} ${rawPath}`);
    let target = goMatch[1];
    try { target = decodeURIComponent(target); } catch { /* keep raw — it will fail UI_ID_RE */ }
    return serveGo(req, res, log, target, search);
  }
  if (rawPath === '/panes') {
    if (method !== 'GET') return reply(res, log, 405, 'text/plain', 'local tier: /panes is GET only', undefined, `${method} ${rawPath}`);
    return servePaneIndex(req, res, log);
  }
  if (rawPath === '/favicon.ico') return serveFavicon(res);
  // The origin wall. /data, /viewtoken/remint and /auth/me live on a PANE origin only —
  // answering them here would put a second, shared origin back into the trust story.
  return reply(res, log, 404, 'text/plain', 'not found', undefined, `${method} ${rawPath}`);
}

/** A PANE origin — serves exactly one uiId, and nothing that belongs to another. */
async function handlePane(paneId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, rawPath, search, url } = parseReq(req);
  const log = _log;
  const opts = _opts;
  if (!opts) return reply(res, log, 503, 'text/plain', 'local tier: stopped', undefined, `${method} ${rawPath}`);

  const uiMatch = /^\/ui\/([^/]+)(\/.*)?$/.exec(rawPath);
  if (uiMatch) {
    const uiId = uiMatch[1];
    // A hand-typed or bookmarked link for a DIFFERENT pane: send it to that pane's origin
    // rather than 404ing. Serving it here is the one thing that must never happen.
    if (uiId !== paneId) return redirectToPane(req, res, log, uiId, url);
    const tail = uiMatch[2] || '';            // includes the leading '/', or '' for /ui/<uiId>
    const rest = tail.replace(/^\//, '');
    if (rest === '' || rest === 'index.html') return serveDocument(req, res, opts, log, uiId, search);
    return serveAsset(req, res, opts, log, uiId, tail, search);
  }
  if (rawPath === '/auth/me') {
    // Cosmetic identity for the pane's "signed in as" badge — NOT a credential path. Scoped to
    // THIS pane: the jar carries every pane's cookie (cookies ignore port), so a scan-all would
    // answer with a sibling's id on this origin.
    const cv = parseCookies(req.headers.cookie)[`lm_ui_${paneId}`];
    const t = cv ? verifyViewToken(cv) : null;
    if (t && t.uiId === paneId) {
      return reply(res, log, 200, 'application/json', JSON.stringify({ userId: 'owner', uiId: paneId, local: true }));
    }
    return reply(res, log, 401, 'application/json', JSON.stringify({ error: 'not signed in' }), undefined, 'GET /auth/me');
  }
  if (rawPath === '/viewtoken/remint') {
    if (method !== 'POST') return reply(res, log, 404, 'text/plain', 'not found', undefined, `${method} ${rawPath}`);
    return remint(req, res, log, paneId);
  }
  // Cross-pane navigation. A SINGLE segment on purpose: '/go/a/b' does not match, so it can
  // never be smuggled past this branch into serveData below.
  const goMatch = /^\/go\/([^/]+)$/.exec(rawPath);
  if (goMatch) {
    if (method !== 'GET') return reply(res, log, 405, 'text/plain', 'local tier: /go is GET only', undefined, `${method} ${rawPath}`);
    let target = goMatch[1];
    try { target = decodeURIComponent(target); } catch { /* keep raw — it will fail UI_ID_RE */ }
    return serveGo(req, res, log, target, search);
  }
  if (rawPath === '/panes') {
    if (method !== 'GET') return reply(res, log, 405, 'text/plain', 'local tier: /panes is GET only', undefined, `${method} ${rawPath}`);
    return servePaneIndex(req, res, log);
  }
  if (rawPath === '/favicon.ico') return serveFavicon(res);
  const dataMatch = /^\/data\/(.*)$/.exec(rawPath);
  if (dataMatch) return serveData(req, res, opts, log, method, dataMatch[1], search, paneId);

  return reply(res, log, 404, 'text/plain', 'not found', undefined, `${method} ${rawPath}`);
}

/** 302 to where a pane actually lives. Mints nothing — the pane origin re-checks everything. */
async function redirectToPane(
  req: IncomingMessage, res: ServerResponse, log: Log, uiId: string, pathAndQuery: string,
): Promise<void> {
  if (!UI_ID_RE.test(uiId)) {
    return reply(res, log, 400, 'text/plain', 'local tier: bad uiId', undefined, 'GET /ui (bad uiId)');
  }
  if (!paneIsServedHere(uiId)) {
    // 🔴 The chooser LISTS every pane on this node, so it is owner-gated like /panes and /go.
    // This branch runs BEFORE any auth (the entry token is single-use and belongs to the pane
    // origin, so the dispatcher must not touch it) — which leaves a small residual an honest
    // reader should know about: a stranger who can reach this port learns whether a GIVEN id is
    // served, from 302-vs-404. A pane id is not a credential and the owner sees the whole list
    // anyway; what a stranger must never get is the list itself, and it does not.
    if (!ownerCookiePresent(req)) {
      return reply(res, log, 404, 'text/plain', 'not found', undefined, `GET /ui/${uiId} (unknown ui)`);
    }
    return renderPaneIndex(res, log, 404, uiId);
  }
  let port: number;
  try { port = await ensurePaneOrigin(uiId); }
  catch (e) {
    return reply(res, log, 503, 'text/plain', `local tier: cannot open an origin for ${uiId}: ${errMsg(e)}`,
      undefined, `GET /ui/${uiId} (no origin)`);
  }
  // referrer-policy so an entry token in ?lt= is not handed onward by the landing page.
  reply(res, log, 302, 'text/plain', '', {
    location: paneUrl(req, port, pathAndQuery),
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
}

// ── document ─────────────────────────────────────────────────────────────────────────────

async function serveDocument(
  req: IncomingMessage, res: ServerResponse, opts: LocalTierOptions, log: Log, uiId: string, search: string,
): Promise<void> {
  // This response carries the pane's data-plane token in its BODY, so who may read the body is
  // the whole question. The answer is the ORIGIN: this listener serves only `uiId`, so the only
  // script that can read this document same-origin is this pane's own. A sibling pane reaching
  // in is a cross-origin read and the browser refuses it — on every transport, with no
  // dependence on request headers (see the header block for what that replaced and why).
  //
  // There is deliberately NO Sec-Fetch-Dest gate here. It was inert on the shipped transport
  // (plain http to a LAN IP: no Fetch Metadata at all), so it protected nobody while reading
  // like protection.
  const cookies = parseCookies(req.headers.cookie);
  let setCookie: string | undefined;
  let authed = false;

  // First hit carries the entry token in ?lt=; exchange it for the working-session cookie.
  const lt = new URLSearchParams(search).get('lt');
  if (lt) {
    const t = verifyEntryToken(lt);
    if (t && t.uiId === uiId) {
      authed = true;
      // Path=/ (not /ui/<uiId>): the SDK shim calls /viewtoken/remint at the ORIGIN ROOT,
      // and a path-scoped cookie would never be sent there — remint would 401 in a real
      // browser. Cookies stay per-UI by NAME.
      setCookie = `lm_ui_${uiId}=${mintViewToken(uiId, COOKIE_TTL_MS)}; HttpOnly; SameSite=Lax; Path=/`;
    }
  }
  // Subsequent hits (and reloads) authenticate on the cookie for THIS uiId only.
  if (!authed) {
    const cv = cookies[`lm_ui_${uiId}`];
    const t = cv ? verifyViewToken(cv) : null;
    if (t && t.uiId === uiId) authed = true;
  }
  if (!authed) {
    return reply(res, log, 401, 'text/plain',
      'local tier: entry token required — mint via POST /ui-pages/<uiId>/local-url on the Core API',
      undefined, `GET /ui/${uiId}/`);
  }

  let doc: FetchResult;
  try {
    doc = await fetchBuffer(opts.uiWebPort, `/ui-${uiId}/index.html`);
  } catch (e) {
    return reply(res, log, 502, 'text/plain', `local tier: lmui unreachable: ${errMsg(e)}`, undefined, `GET /ui/${uiId}/`);
  }

  // 🔴 frame-ancestors ONLY. A default-src here would kill the inline <script> injected below
  // (the pane would load with no token and no identity). Framing is already cross-origin for
  // every OTHER pane; these headers close the last case — a pane framing ITSELF, or any future
  // surface that ends up co-origin with one — and they cost nothing: nothing frames a pane on
  // this tier (__SHELL_ORIGIN__ is "" — there is no local shell).
  // CORP blocks a cross-origin no-cors subresource load of this document, the one read path
  // CORS does not already cover.
  const headers: OutHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, must-revalidate',
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (setCookie) headers['set-cookie'] = setCookie;
  if (doc.status >= 400) {
    // Upstream said no — forward its status untouched, no injection.
    res.writeHead(doc.status, headers); res.end(doc.body);
    log(`[local-tier] ${doc.status} GET /ui/${uiId}/ (lmui document)`);
    return;
  }

  // The pane reads its data-plane token + identity off window; SHELL_ORIGIN empty = no shell.
  const dataToken = mintViewToken(uiId); // 15-min token, distinct from the 8h cookie
  const inject =
    `<base href="/ui/${uiId}/">` +
    `<script>window.__VIEW_TOKEN__=${JSON.stringify(dataToken)};` +
    `window.__UI_ID__=${JSON.stringify(uiId)};` +
    `window.__UI_KEY__=${JSON.stringify(uiId)};` +
    `window.__SHELL_ORIGIN__="";</script>`;
  const html = doc.body.toString('utf8');
  const idx = html.search(/<\/head>/i);
  const out = idx >= 0 ? html.slice(0, idx) + inject + html.slice(idx) : inject + html;
  res.writeHead(200, headers);
  res.end(out);
}

// ── cross-pane navigation ────────────────────────────────────────────────────────────────

/**
 * GET /go/<uiId>[?params] — send the viewer to ANOTHER pane on this tier.
 *
 * A pane must never assemble a sibling's URL: the shape belongs to the serving tier, it differs
 * between the hub (one origin per pane, one host) and here (one origin per pane, one PORT each),
 * and here a pane could not build it anyway — it does not know the sibling's port. The pane
 * emits a root-relative /go/<uiId> and this returns an absolute cross-origin Location.
 *
 * 🔴 This is the ONLY surface that mints ANOTHER pane's cookie on a caller's behalf. Under one
 * origin per pane that is no longer a credential handover: the cookie is HttpOnly and lands in
 * a host-wide jar, but every response it could authenticate on the target's origin is a
 * cross-origin read for the caller. What a scripted /go achieves is therefore exactly what a
 * clicked /go achieves minus the reading — nothing.
 *
 * 🔴 It is served on ANY transport, with no Sec-Fetch-Dest condition. The previous version
 * refused an ABSENT header to block silent cookie planting on a shared origin; over plain http
 * to a LAN IP no browser sends that header at all, so the rule refused every REAL cross-pane
 * navigation too — measured Chrome 145: 127.0.0.1 → 302, the LAN IP → 403 on the identical
 * click. The planting it was buying is worthless now; the deadness it was costing was total.
 */
async function serveGo(
  req: IncomingMessage, res: ServerResponse, log: Log, target: string, search: string,
): Promise<void> {
  // 1. Owner proof — ANY valid lm_ui_* view cookie, not the target's. You navigate to panes you
  //    have never opened, so requiring the target's cookie would defeat the feature; and the
  //    local tier is single-owner by construction (the /auth/me precedent).
  if (!ownerCookiePresent(req)) {
    return reply(res, log, 401, 'text/plain',
      'local tier: entry token required — mint via POST /ui-pages/<uiId>/local-url on the Core API',
      undefined, 'GET /go');
  }

  // 2. Shape. Logged WITHOUT the raw id — it is caller-controlled text.
  if (!UI_ID_RE.test(target)) {
    return reply(res, log, 400, 'text/plain', 'local tier: bad uiId', undefined, 'GET /go (bad uiId)');
  }

  // 3. Params: refuse, never truncate.
  const q = sanitizeNavQuery(search);
  if (!q.ok) return reply(res, log, 400, 'text/plain', q.reason, undefined, `GET /go/${target} (${q.reason})`);

  // 4. Existence. Unknown → the chooser, rendered INLINE at 404: a redirect would create a
  //    second URL to secure, and there is no shell on this tier to fall back to.
  if (!paneIsServedHere(target)) return renderPaneIndex(res, log, 404, target);

  // 5. The target's own origin.
  let port: number;
  try { port = await ensurePaneOrigin(target); }
  catch (e) {
    return reply(res, log, 503, 'text/plain', `local tier: cannot open an origin for ${target}: ${errMsg(e)}`,
      undefined, `GET /go/${target} (no origin)`);
  }

  // 6. Mint the target's working-session cookie and redirect to a CLEAN path. No '?lt=' ever:
  //    entry tokens are single-use against an in-memory ledger a Core restart clears, and one
  //    in the URL bar lands in history, Referer and the target's own location.search.
  const location = paneUrl(req, port, `/ui/${target}/${q.qs ? `?${q.qs}` : ''}`);
  reply(res, log, 302, 'text/plain', '', {
    location,
    'set-cookie': `lm_ui_${target}=${mintViewToken(target, COOKIE_TTL_MS)}; HttpOnly; SameSite=Lax; Path=/`,
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  // reply() only logs at >=400, and a credential mint should never be silent.
  log(`[local-tier] 302 GET /go/${target} → ${location} (minted cookie)`);
}

/** GET /panes — the standing index, same owner proof as /go. */
async function servePaneIndex(req: IncomingMessage, res: ServerResponse, log: Log): Promise<void> {
  // 🔴 This list is NOT a secret and must not be documented as one. It mints nothing, and a
  // scripted read of it cannot be told from a human's on the shipped transport (no Fetch
  // Metadata over plain http), so no gate here could make it one. What it enumerates — every
  // /go target — is safe to enumerate precisely because /go hands a scripted caller nothing it
  // can read. The owner-cookie check below is all that is claimed: not "no script may list
  // these", only "no stranger may".
  if (!ownerCookiePresent(req)) {
    return reply(res, log, 401, 'text/plain',
      'local tier: entry token required — mint via POST /ui-pages/<uiId>/local-url on the Core API',
      undefined, 'GET /panes');
  }
  return renderPaneIndex(res, log, 200);
}

/**
 * The pane chooser — this tier's answer to "the target is not here". There is no local shell
 * (__SHELL_ORIGIN__ is "" below), so a dead 404 would be the end of the road.
 *
 * Links stay root-relative: /go/<id> resolves against whichever origin rendered this page and
 * that origin's /go issues the cross-origin redirect. Nothing here needs to know a port.
 *
 * This is the feature's ONLY HTML sink: everything interpolated is escaped, `missing` is
 * echoed only when it is a well-formed uiId, and the response refuses to be framed.
 */
function renderPaneIndex(res: ServerResponse, log: Log, status: 200 | 404, missing?: string): void {
  let ids: string[] = [];
  try { ids = listReportableUis().map((u) => u.uiId).filter((id) => UI_ID_RE.test(id)); } catch { ids = []; }
  ids = [...new Set(ids)].sort();
  const items = ids.length
    ? ids.map((id) => `<li><a href="/go/${escapeHtml(id)}">${escapeHtml(id)}</a></li>`).join('')
    : '<li class="dim">no panes are being served on this node</li>';
  // Echo the requested id ONLY when it is a valid uiId; anything else is described, not shown.
  const head = status === 404
    ? `<p class="miss">${missing && UI_ID_RE.test(missing) ? `<code>${escapeHtml(missing)}</code> is not served here.` : 'That UI is not served here.'}</p>`
    : '';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Panes</title><style>`
    + `body{font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#0f172a;color:#e2e8f0}`
    + `h1{font-size:1.1rem;margin:0 0 .4rem}p{color:#94a3b8;font-size:.85rem;margin:.2rem 0 1rem}`
    + `ul{list-style:none;padding:0;margin:0;max-width:32rem}li{border-bottom:1px solid #334155;padding:.5rem 0}`
    + `a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}`
    + `code{background:#1e293b;padding:.1rem .3rem;border-radius:3px}.dim{color:#94a3b8}`
    + `</style></head><body><h1>Panes on this node</h1>${head}<ul>${items}</ul></body></html>`;
  reply(res, log, status, 'text/html; charset=utf-8', body, {
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }, status === 404 ? 'GET /go (unknown ui)' : undefined);
}

/** Owner proof: ANY lm_ui_* cookie this node signed. The /auth/me precedent, reused. */
function ownerCookiePresent(req: IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie);
  for (const [name, value] of Object.entries(cookies)) {
    if (name.startsWith('lm_ui_') && verifyViewToken(value)) return true;
  }
  return false;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * GET /favicon.ico → 204, not 404.
 *
 * Browsers request this from the ORIGIN ROOT on every document load, unasked, and no pane ships
 * one — so every pane load logged a 404 that nobody could act on. On several panes it was the
 * ONLY console error in an otherwise clean run, which trains a viewer to ignore the console —
 * the exact condition under which a REAL error goes unnoticed. 204 says "deliberately nothing":
 * it needs no auth because it carries no body, no cookie and no token, and the short cache stops
 * the browser asking again on the next load.
 */
function serveFavicon(res: ServerResponse): void {
  try { res.writeHead(204, { 'cache-control': 'max-age=86400' }); res.end(); } catch { /* socket gone */ }
}

// ── assets ───────────────────────────────────────────────────────────────────────────────

async function serveAsset(
  req: IncomingMessage, res: ServerResponse, opts: LocalTierOptions, log: Log, uiId: string, tail: string, search: string,
): Promise<void> {
  const cv = parseCookies(req.headers.cookie)[`lm_ui_${uiId}`];
  const t = cv ? verifyViewToken(cv) : null;
  if (!t || t.uiId !== uiId) {
    return reply(res, log, 401, 'text/plain', 'local tier: view cookie required', undefined, `GET /ui/${uiId}${tail}`);
  }
  // Traversal is rejected BEFORE any proxy — on both the raw and decoded tail so an encoded
  // '..' or '//' cannot slip a request outside the /ui-<uiId>/ tree.
  let dtail = tail; try { dtail = decodeURIComponent(tail); } catch { /* keep raw */ }
  if (tail.includes('..') || tail.includes('//') || dtail.includes('..') || dtail.includes('//')) {
    return reply(res, log, 403, 'text/plain', 'local tier: illegal asset path', undefined, `GET /ui/${uiId}${tail}`);
  }

  const target = `/ui-${uiId}/${tail.replace(/^\//, '')}${search}`;
  const up = http.request(loopbackOptions({ host: '127.0.0.1', port: opts.uiWebPort, path: target, method: 'GET' }), (r) => {
    // XFO DENY so a pane's SECONDARY html (a sub-page under /ui/<uiId>/…) is not framable
    // either — serveDocument only covers index.html. CORP for the no-cors subresource path.
    const headers: OutHeaders = {
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin',
    };
    if (r.headers['content-type']) headers['content-type'] = r.headers['content-type'] as string;
    res.writeHead(r.statusCode || 502, headers);
    r.pipe(res);
    if ((r.statusCode || 0) >= 400) log(`[local-tier] ${r.statusCode} GET ${target} (asset)`);
  });
  up.on('error', (e) => reply(res, log, 502, 'text/plain', `local tier: asset upstream error: ${errMsg(e)}`, undefined, `GET ${target}`));
  up.setTimeout(10_000, () => up.destroy(new Error('asset upstream timeout')));
  up.end();
}

// ── data plane ───────────────────────────────────────────────────────────────────────────

async function serveData(
  req: IncomingMessage, res: ServerResponse, opts: LocalTierOptions, log: Log, method: string, dataPath: string,
  search: string, paneId: string,
): Promise<void> {
  // Authenticated ONLY by a Bearer view token — never the cookie.
  const auth = headerStr(req.headers['authorization']);
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  const tok = m ? verifyViewToken(m[1].trim()) : null;
  if (!tok) {
    return reply(res, log, 401, 'application/json', JSON.stringify({ error: 'local tier: Bearer view token required' }),
      undefined, `${method} /data/${dataPath}`);
  }
  // 🔴 A pane origin answers for ITS pane only. An `Authorization:` header is not CORS-safelisted,
  // so a cross-origin call preflights, and NOTHING in this tier ever emits an
  // `Access-Control-Allow-*` header — the preflight fails and the real request is never sent
  // (measured: OPTIONS /data → 401, and the caller sees a TypeError). This check is the
  // server-side half of the same rule: it makes a token that leaked by some other route
  // unusable anywhere but on its own origin.
  if (tok.uiId !== paneId) {
    return reply(res, log, 403, 'application/json',
      JSON.stringify({ error: `local tier: this origin serves ${paneId}; that token belongs to another pane` }),
      undefined, `${method} /data/${dataPath} (foreign token)`);
  }
  const uiId = tok.uiId;

  // Two path shapes collapse to one: /data/<service>/<path> and /data/<uiId>/<service>/<path>.
  // Only the first segment matching the token's OWN uiId selects the second (explicit) shape.
  //
  // 🔴 CANONICALIZE FIRST, THEN CHECK, THEN FORWARD THE SAME STRING — "check what you execute".
  // This used to authorize the RAW tail and forward that same raw tail, while Core selects its
  // route from `new URL(req.url, …).pathname` (rest-server.ts). The WHATWG parser treats `\` as
  // a path SEPARATOR and DELETES a `.` segment; grantAllows models neither, because it splits on
  // `/`. So the grant saw one path and the router ran another — and since `exact`/`*` are
  // expressed in segment COUNTS, moving a boundary is exactly what defeats them. Measured on the
  // shipped configs before this fix: `GET /data/node/mission/session\abc\read` satisfied
  // assist-missions' `{'/mission/*', exact:true}` leaf rule as TWO segments and then executed as
  // the four-segment `/mission/session/abc/read`; the same trick reached
  // `PATCH /mission/views/v1`, `GET /sessions/abc/raw`, `POST /backlog/id/remove` and
  // `POST /mission/workflows/x/rollback/force` from panes whose grants exclude all four.
  //
  // canonicalRequestPath is the router's own algorithm (it calls the same `new URL(...).pathname`)
  // plus the traversal/encoded-separator refusals, in the order that matters — see grants.ts. It
  // also subsumes the raw+decoded `..`/`//` reject this block used to do inline, so there is ONE
  // place left that decides what a data path means. Same order as the hub's evaluator
  // (ui-gateway/src/data/routes.ts: canonicalUpstreamPath → grantAllows → relay
  // the canonical form), which is why the two now agree on crafted input and not just clean input.
  const resolved = resolveDataTarget(dataPath, uiId);
  if (resolved === null) {
    return reply(res, log, 403, 'application/json', JSON.stringify({ error: 'local tier: illegal data path' }),
      undefined, `${method} /data/${dataPath}`);
  }
  // ONE string from here down: `targetPath` is what the grant is asked about AND what goes on
  // the wire, so no second normalization can creep in between the check and the forward.
  const { service, path: targetPath } = resolved;

  const ui = listReportableUis().find((u) => u.uiId === uiId);
  if (!ui) {
    return reply(res, log, 403, 'application/json',
      JSON.stringify({ error: `grant does not allow ${method} ${service} ${targetPath} (no such ui ${uiId})` }),
      undefined, `${method} /data/${dataPath}`);
  }
  let grant: ReturnType<typeof readDeclaredGrant>;
  try { grant = readDeclaredGrant(ui.dir); } catch { grant = []; }
  if (!grantAllows(grant, service, targetPath, method)) {
    return reply(res, log, 403, 'application/json',
      JSON.stringify({ error: `grant does not allow ${method} ${service} ${targetPath}` }),
      undefined, `${method} /data/${dataPath}`);
  }

  if (service !== 'node') {
    return reply(res, log, 503, 'application/json',
      JSON.stringify({ error: 'LOCAL_TIER_NODE_ONLY', detail: `only service "node" is served by the local tier in v1; use the hub origin for ${service}` }),
      undefined, `${method} /data/${dataPath}`);
  }

  const body = await readBody(req, BODY_CAP);
  if (body === null) {
    return reply(res, log, 413, 'application/json', JSON.stringify({ error: 'request body exceeds 1MB' }),
      undefined, `${method} /data/${dataPath}`);
  }

  // service 'node' → this host's Core API, authenticated with the server-held api token.
  // `targetPath` is the string grantAllows just authorized, verbatim — do not rebuild it here.
  const target = `${targetPath}${search}`;
  const headers: Record<string, string> = { 'x-api-key': opts.getApiToken() };
  const ct = headerStr(req.headers['content-type']);
  if (ct) headers['content-type'] = ct;
  const up = http.request(loopbackOptions({ host: '127.0.0.1', port: opts.apiPort, path: target, method, headers }), (r) => {
    const outHeaders: OutHeaders = { 'cross-origin-resource-policy': 'same-origin' };
    if (r.headers['content-type']) outHeaders['content-type'] = r.headers['content-type'] as string;
    res.writeHead(r.statusCode || 502, outHeaders);
    r.pipe(res);
    if ((r.statusCode || 0) >= 400) log(`[local-tier] ${r.statusCode} ${method} ${target} (node proxy)`);
  });
  up.on('error', (e) => reply(res, log, 502, 'application/json', JSON.stringify({ error: `node upstream error: ${errMsg(e)}` }),
    undefined, `${method} ${target}`));
  up.setTimeout(30_000, () => up.destroy(new Error('node upstream timeout')));
  if (body.length) up.end(body); else up.end();
}

// ── view-token remint ────────────────────────────────────────────────────────────────────

async function remint(req: IncomingMessage, res: ServerResponse, log: Log, paneId: string): Promise<void> {
  // A cookie→bearer converter. On a SHARED origin that was a cross-pane token handover: every
  // pane's lm_ui_* cookie (Path=/) rides every request, so "the cookie for the uiId you named is
  // in the jar" is a property of the BROWSER, not of the caller — measured, a pane whose grant
  // was GET /health did ONE plain fetch() here and walked away with a sibling's view token.
  //
  // 🔴 What closes it now is the ORIGIN, not the body: this handler answers for `paneId` and
  // refuses every other uiId outright, so the only script that can reach a pane's remint
  // same-origin is that pane's own. Cross-origin it is unreachable in practice (a JSON POST
  // preflights, and no Access-Control-Allow-* header is emitted anywhere in this tier) and
  // unreadable in principle (an opaque `no-cors` response), so a sibling gains nothing by
  // triggering it.
  //
  // Because of that, the CALLER'S OWN TOKEN IS OPTIONAL. Deployed shims send `{uiId}` alone and
  // must keep working across an upgrade — the panes that run are served from ~/.lmui/apps, which
  // a Core build does not touch, so a server that demanded a new field would 401 every pane on
  // the node the moment its 15-min token expired. When a token IS sent it must verify (proof of
  // possession, checked with the cookie's 8h grace so a pane idle past the view TTL still
  // qualifies); it is never accepted as authorization and never as data-plane auth.
  const body = await readBody(req, BODY_CAP);
  let uiId = '';
  let held = '';
  try {
    const b = JSON.parse((body || Buffer.alloc(0)).toString('utf8') || '{}') as { uiId?: unknown; token?: unknown };
    uiId = String(b.uiId || '');
    held = typeof b.token === 'string' ? b.token : '';
  } catch { /* malformed → 400 below */ }
  if (!uiId) {
    return reply(res, log, 400, 'application/json', JSON.stringify({ error: 'uiId required' }), undefined, 'POST /viewtoken/remint');
  }
  if (uiId !== paneId) {
    return reply(res, log, 401, 'application/json',
      JSON.stringify({ error: `local tier: this origin only remints ${paneId}` }),
      undefined, `POST /viewtoken/remint (foreign uiId, origin ${paneId})`);
  }
  const cookie = parseCookies(req.headers.cookie)[`lm_ui_${uiId}`];
  const t = cookie ? verifyViewToken(cookie) : null;
  const proofOk = !held || verifyViewTokenForProof(held, COOKIE_TTL_MS)?.uiId === uiId;
  if (t && t.uiId === uiId && proofOk) {
    return reply(res, log, 200, 'application/json', JSON.stringify({ token: mintViewToken(uiId) }));
  }
  reply(res, log, 401, 'application/json',
    JSON.stringify({ error: 'remint requires this uiId\'s view cookie (and, if a token is sent, one this document holds)' }),
    undefined, 'POST /viewtoken/remint');
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

type Log = (m: string) => void;
type OutHeaders = Record<string, string>;
interface FetchResult { status: number; body: Buffer }

function reply(
  res: ServerResponse, log: Log, status: number, contentType: string, body: string | Buffer,
  extraHeaders?: OutHeaders, note?: string,
): void {
  const headers: OutHeaders = { 'content-type': contentType };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  try { res.writeHead(status, headers); res.end(body); } catch { /* socket gone */ }
  if (status >= 400) log(`[local-tier] ${status} ${note || ''}`.trimEnd());
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function headerStr(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0];
  return typeof h === 'string' ? h : undefined;
}

/** Read the request body, capped. Resolves null once the cap is exceeded (→ 413). */
function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > cap) { over = true; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!over) resolve(Buffer.concat(chunks)); });
  });
}

function fetchBuffer(port: number, path: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const r = http.request(loopbackOptions({ host: '127.0.0.1', port, path, method: 'GET' }), (up) => {
      const chunks: Buffer[] = [];
      up.on('data', (c: Buffer) => chunks.push(c));
      up.on('end', () => resolve({ status: up.statusCode || 502, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(10_000, () => r.destroy(new Error('lmui document timeout')));
    r.end();
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
