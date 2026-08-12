/**
 * Local serving tier — a hub-free HTTP origin for pluggable-UI panes.
 *
 * Reproduces the ui-gateway's app contract on a dedicated listener so an UNMODIFIED pane
 * (an lmui static app) works with no hub in the loop. The gateway normally: authenticates
 * the viewer, sets a cookie, serves the app document with window.__VIEW_TOKEN__ / __UI_ID__
 * injected, proxies assets, and gates a /data plane against the app's declared grant. This
 * listener does the same against 127.0.0.1 services only.
 *
 * Trust model: an ENTRY token (short-lived, minted by the Core route) arrives once in ?lt=,
 * is exchanged for an HttpOnly cookie, and thereafter documents+assets authenticate on that
 * cookie. The /data plane authenticates ONLY on a Bearer view token (the 15-min token the
 * document injects) — never the cookie — so a page's data reach is exactly its declared
 * grant, and only service "node" (this host's Core API) is served here in v1.
 */

import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { loadOrCreateSecret, mintViewToken, verifyViewToken, verifyEntryToken } from './token';
import { readDeclaredGrant, grantAllows } from './grants';
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

// Module-level so the Core status route can report liveness (isLocalTierRunning) and so a
// second start on the same process is a no-op rather than a second bind.
let _server: http.Server | null = null;
let _running = false;

export function isLocalTierRunning(): boolean {
  return _running;
}

export function startLocalUiTier(opts: LocalTierOptions): () => void {
  const log = opts.log || (() => {});
  if (_server) {
    log('[local-tier] already running — start ignored');
    return stopTier;
  }
  try { loadOrCreateSecret(); } catch { /* mint paths create it lazily anyway */ }

  const server = http.createServer((req, res) => {
    handle(req, res, opts, log).catch((e) => {
      try {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('local tier: internal error'); }
        else res.end();
      } catch { /* socket already gone */ }
      log(`[local-tier] 500 ${req.method} ${req.url}: ${errMsg(e)}`);
    });
  });
  // Binding is not allowed to take Core down: log and leave the tier off. EADDRINUSE fires
  // ASYNCHRONOUSLY, so _server/_running are set ONLY from the listening callback — a failed
  // bind leaves both unset (isLocalTierRunning() false, no dangling server ref to close).
  server.on('error', (e) => { _running = false; _server = null; log(`[local-tier] listen failed: ${errMsg(e)}`); });
  server.listen(opts.localUiPort, '0.0.0.0', () => {
    _server = server;
    _running = true;
    log(`[local-tier] listening on 0.0.0.0:${opts.localUiPort} (ui=${opts.uiWebPort} api=${opts.apiPort})`);
  });
  return stopTier;
}

function stopTier(): void {
  _running = false;
  const s = _server;
  _server = null;
  if (s) { try { s.close(); } catch { /* already closing */ } }
}

// ── request routing ──────────────────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse, opts: LocalTierOptions, log: Log): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = req.url || '/';
  const qIdx = url.indexOf('?');
  const rawPath = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const search = qIdx >= 0 ? url.slice(qIdx) : '';

  const uiMatch = /^\/ui\/([^/]+)(\/.*)?$/.exec(rawPath);
  if (uiMatch) {
    const uiId = uiMatch[1];
    const tail = uiMatch[2] || '';            // includes the leading '/', or '' for /ui/<uiId>
    const rest = tail.replace(/^\//, '');
    if (rest === '' || rest === 'index.html') return serveDocument(req, res, opts, log, uiId, search);
    return serveAsset(req, res, opts, log, uiId, tail, search);
  }
  if (rawPath === '/auth/me') {
    // Cosmetic identity for the pane's "signed in as" badge — NOT a credential path. Authed by
    // any of this owner's valid view cookies (all panes are the one owner's on the local tier).
    const cookies = parseCookies(req.headers.cookie);
    for (const [name, value] of Object.entries(cookies)) {
      if (!name.startsWith('lm_ui_')) continue;
      const t = verifyViewToken(value);
      if (t) return reply(res, log, 200, 'application/json', JSON.stringify({ userId: 'owner', uiId: t.uiId, local: true }));
    }
    return reply(res, log, 401, 'application/json', JSON.stringify({ error: 'not signed in' }), undefined, 'GET /auth/me');
  }
  if (rawPath === '/viewtoken/remint') {
    if (method !== 'POST') return reply(res, log, 404, 'text/plain', 'not found', undefined, `${method} ${rawPath}`);
    return remint(req, res, log);
  }
  const dataMatch = /^\/data\/(.*)$/.exec(rawPath);
  if (dataMatch) return serveData(req, res, opts, log, method, dataMatch[1], search);

  // The origin wall: anything not one of the three surfaces above does not exist here.
  return reply(res, log, 404, 'text/plain', 'not found', undefined, `${method} ${rawPath}`);
}

// ── document ─────────────────────────────────────────────────────────────────────────────

async function serveDocument(
  req: IncomingMessage, res: ServerResponse, opts: LocalTierOptions, log: Log, uiId: string, search: string,
): Promise<void> {
  // 🔴 Same-origin isolation caveat: the local tier serves EVERY pane from ONE origin
  // (127.0.0.1:localUiPort), so pane B's script could fetch('/ui/paneA/') — same-origin, pane A's
  // cookie auto-attached — and scrape the __VIEW_TOKEN__ injected below, then exercise pane A's
  // grant. The hub tier avoids this by giving each pane its OWN origin; the local tier can't
  // without per-app ports (a v1 limitation — see backlog, local tier is OWNER-ONLY + trusted
  // panes). Defense here: serve the token-injected document ONLY to a real top-level navigation
  // or iframe load. Browsers stamp Sec-Fetch-Dest 'document'/'iframe'/'frame' on those and
  // 'empty' on fetch()/XHR — so a scripted cross-pane scrape is refused. (Absent header = a
  // non-browser client, which has no ambient cookie to abuse anyway.)
  const sfd = headerStr(req.headers['sec-fetch-dest']);
  if (sfd && !['document', 'iframe', 'frame', 'nested-document'].includes(sfd.toLowerCase())) {
    return reply(res, log, 403, 'text/plain', 'local tier: document is navigation-only', undefined, `GET /ui/${uiId}/ (sec-fetch-dest=${sfd})`);
  }

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
      // browser. Cookies stay per-UI by NAME; /data auth is Bearer-only, so a root-path
      // cookie exposes nothing across panes sharing this local origin.
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

  const headers: OutHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' };
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
  const up = http.request({ host: '127.0.0.1', port: opts.uiWebPort, path: target, method: 'GET' }, (r) => {
    const headers: OutHeaders = { 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' };
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
  req: IncomingMessage, res: ServerResponse, opts: LocalTierOptions, log: Log, method: string, dataPath: string, search: string,
): Promise<void> {
  // Authenticated ONLY by a Bearer view token — never the cookie.
  const auth = headerStr(req.headers['authorization']);
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  const tok = m ? verifyViewToken(m[1].trim()) : null;
  if (!tok) {
    return reply(res, log, 401, 'application/json', JSON.stringify({ error: 'local tier: Bearer view token required' }),
      undefined, `${method} /data/${dataPath}`);
  }
  const uiId = tok.uiId;

  // Two path shapes collapse to one: /data/<service>/<path> and /data/<uiId>/<service>/<path>.
  // Only the first segment matching the token's OWN uiId selects the second (explicit) shape.
  // Reject traversal BEFORE the grant check — on raw AND decoded. grantAllows is a
  // segment-boundary prefix match, so '/backlog/../sessions' passes the '/backlog' grant;
  // Core then normalizes the dot-segments (new URL) and the request escapes the grant onto
  // ANY route with the node's full api-key. serveAsset already guards this; /data must too.
  let ddata = dataPath; try { ddata = decodeURIComponent(dataPath); } catch { /* keep raw */ }
  if (dataPath.includes('..') || dataPath.includes('//') || ddata.includes('..') || ddata.includes('//')) {
    return reply(res, log, 403, 'application/json', JSON.stringify({ error: 'local tier: illegal data path' }),
      undefined, `${method} /data/${dataPath}`);
  }

  const parts = dataPath.split('/');
  let service: string, apiPath: string;
  if (parts[0] === uiId) { service = parts[1] || ''; apiPath = parts.slice(2).join('/'); }
  else { service = parts[0] || ''; apiPath = parts.slice(1).join('/'); }

  const ui = listReportableUis().find((u) => u.uiId === uiId);
  if (!ui) {
    return reply(res, log, 403, 'application/json',
      JSON.stringify({ error: `grant does not allow ${method} ${service} /${apiPath} (no such ui ${uiId})` }),
      undefined, `${method} /data/${dataPath}`);
  }
  let grant: ReturnType<typeof readDeclaredGrant>;
  try { grant = readDeclaredGrant(ui.dir); } catch { grant = []; }
  if (!grantAllows(grant, service, '/' + apiPath, method)) {
    return reply(res, log, 403, 'application/json',
      JSON.stringify({ error: `grant does not allow ${method} ${service} /${apiPath}` }),
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
  const target = `/${apiPath}${search}`;
  const headers: Record<string, string> = { 'x-api-key': opts.getApiToken() };
  const ct = headerStr(req.headers['content-type']);
  if (ct) headers['content-type'] = ct;
  const up = http.request({ host: '127.0.0.1', port: opts.apiPort, path: target, method, headers }, (r) => {
    const outHeaders: OutHeaders = {};
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

async function remint(req: IncomingMessage, res: ServerResponse, log: Log): Promise<void> {
  // All panes share ONE local origin, so every pane's lm_ui_* cookie is sent here. A pane may
  // ONLY remint its OWN token: reminting the first cookie that happens to verify would let a
  // narrow-grant pane obtain a broader-grant pane's view token (that token's uiId then selects
  // the grant in serveData) — a cross-pane confused-deputy. The SDK shim sends the uiId it wants
  // (assets/lmui.js: body {uiId}); we honor ONLY the matching cookie and require the token's own
  // uiId to equal it, so a forged/foreign cookie name buys nothing.
  const body = await readBody(req, BODY_CAP);
  let uiId = '';
  try { uiId = String((JSON.parse((body || Buffer.alloc(0)).toString('utf8') || '{}') as { uiId?: unknown }).uiId || ''); } catch { /* malformed → 400 below */ }
  if (!uiId) {
    return reply(res, log, 400, 'application/json', JSON.stringify({ error: 'uiId required' }), undefined, 'POST /viewtoken/remint');
  }
  const cookie = parseCookies(req.headers.cookie)[`lm_ui_${uiId}`];
  const t = cookie ? verifyViewToken(cookie) : null;
  if (t && t.uiId === uiId) {
    return reply(res, log, 200, 'application/json', JSON.stringify({ token: mintViewToken(uiId) }));
  }
  reply(res, log, 401, 'application/json', JSON.stringify({ error: 'no valid view cookie for this uiId' }), undefined, 'POST /viewtoken/remint');
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
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (up) => {
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
