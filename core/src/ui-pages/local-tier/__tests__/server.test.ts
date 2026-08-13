/**
 * Local serving tier — self-contained integration test.
 *
 * Stands up two stub upstreams (an lmui static host + a Core API that records x-api-key and
 * echoes) and the tier in front of them, on ephemeral ports, under an isolated HOME so the
 * per-node secret and ~/.lmui state never touch the real ones.
 *
 * 🔴 TOPOLOGY — read before adding a case. The tier is a DISPATCHER on `tierPort` plus ONE
 * ORIGIN PER PANE. The dispatcher serves no pane content: it 302s to the pane's own port. So a
 * request to `tierPort` for `/ui/<id>/`, `/data/…`, `/auth/me` or `/viewtoken/remint` is NOT the
 * pane surface — the pane surface is on `panePort(id)`, resolved here the way a browser resolves
 * it (follow the 302).
 *
 * 🔴 And read this before believing a green run: what makes a sibling pane unable to read this
 * document is the BROWSER's same-origin policy, which raw HTTP does not have. This file can
 * prove the tier puts each pane on its own origin and that every surface refuses a foreign
 * uiId; it CANNOT prove a hostile pane is thereby blocked. `browser-cross-pane.test.ts` does
 * that, in a real Chrome, on both transports. Neither file is sufficient alone.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

// HOME must be redirected BEFORE token.ts / manager.ts read os.homedir(); both read it lazily
// (at call time), and the modules are require()'d in before(), so setting it here is in time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-home-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const UI_ID = 'demo-pane';
// A SECOND pane: every cross-pane case (/go, the chooser, the data-plane regression) needs
// a target that is not the pane holding the cookie.
const UI_ID2 = 'demo-pane-2';
const API_TOKEN = 'test-api-token-xyz';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }
function req(port: number, method: string, pathName: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathName, method, headers: o.headers || {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (o.body) r.write(o.body);
    r.end();
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** The port inside an absolute Location, or 0 — the browser's view of "where does this pane live". */
function portOfLocation(loc: unknown): number {
  const m = /^http:\/\/(?:\[[^\]]+\]|[^/:]+):(\d+)(\/|$)/.exec(String(loc || ''));
  return m ? Number(m[1]) : 0;
}

interface CoreHit { url?: string; method?: string; apiKey?: string | string[]; body: string }

let lmui: http.Server, core: http.Server;
let tierPort = 0;                 // the DISPATCHER — the one stable address
let panePort = 0, panePort2 = 0;  // each pane's OWN origin
let stopTier: () => void;
const coreHits: CoreHit[] = [];
let cookieValue = '';   // 'lm_ui_demo-pane=<8h token>'
let viewToken = '';     // window.__VIEW_TOKEN__ (15-min data-plane token)
let docResp: Resp;
let entryRedirect: Resp;

before(async () => {
  // Stub lmui host — serves each app's document + one asset under /ui-<uiId>/.
  const SERVED = [UI_ID, UI_ID2];
  lmui = http.createServer((rq, rs) => {
    const doc = SERVED.find((id) => rq.url === `/ui-${id}/index.html`);
    const asset = SERVED.find((id) => rq.url === `/ui-${id}/assets/app.js`);
    if (doc) {
      rs.writeHead(200, { 'content-type': 'text/html' });
      rs.end('<!doctype html><html><head><title>demo</title></head><body>hi</body></html>');
    } else if (asset) {
      rs.writeHead(200, { 'content-type': 'application/javascript' });
      rs.end('console.log("app")');
    } else {
      rs.writeHead(404); rs.end('nope');
    }
  });
  // Stub Core API — records the forwarded key and echoes the request back.
  core = http.createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on('data', (c: Buffer) => chunks.push(c));
    rq.on('end', () => {
      coreHits.push({ url: rq.url, method: rq.method, apiKey: rq.headers['x-api-key'], body: Buffer.concat(chunks).toString('utf8') });
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ ok: true, url: rq.url, method: rq.method, apiKey: rq.headers['x-api-key'] }));
    });
  });
  const lmuiPort = await listen(lmui);
  const corePort = await listen(core);

  // App dir with a declared grant, and the ~/.lmui state file that makes listReportableUis
  // resolve this uiId → this dir (port must be non-zero or listStateFiles drops it).
  const appDir = path.join(tmpHome, 'apps', UI_ID);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'lmui.config.json'), JSON.stringify({
    uiId: UI_ID,
    service: `ui-${UI_ID}`,
    grant: [
      { service: 'node', pathPrefix: '/sessions', verbs: ['GET', 'POST'] },
      { service: 'files', pathPrefix: '/', verbs: ['GET'] },
    ],
  }));
  fs.mkdirSync(path.join(tmpHome, '.lmui'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.lmui', `dev-${UI_ID}.json`), JSON.stringify({
    uiId: UI_ID, service: `ui-${UI_ID}`, pid: process.pid, port: lmuiPort, dir: appDir,
    sdkPath: '', log: '', startedAt: new Date().toISOString(),
  }));

  // Second pane — same shape, a NARROWER grant so the cross-pane data regression below
  // proves the /go cookie did not widen anyone's reach.
  const appDir2 = path.join(tmpHome, 'apps', UI_ID2);
  fs.mkdirSync(appDir2, { recursive: true });
  fs.writeFileSync(path.join(appDir2, 'lmui.config.json'), JSON.stringify({
    uiId: UI_ID2,
    service: `ui-${UI_ID2}`,
    grant: [{ service: 'node', pathPrefix: '/sessions', verbs: ['GET'] }],
  }));
  fs.writeFileSync(path.join(tmpHome, '.lmui', `dev-${UI_ID2}.json`), JSON.stringify({
    uiId: UI_ID2, service: `ui-${UI_ID2}`, pid: process.pid, port: lmuiPort, dir: appDir2,
    sdkPath: '', log: '', startedAt: new Date().toISOString(),
  }));

  // A pre-bound-then-closed socket yields a free port to hand the tier (it binds a concrete port).
  const probe = http.createServer();
  const freePort = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));

  const { startLocalUiTier, isLocalTierRunning } = require('../server');
  stopTier = startLocalUiTier({ localUiPort: freePort, uiWebPort: lmuiPort, apiPort: corePort, getApiToken: () => API_TOKEN, log: () => {} });
  tierPort = freePort;
  for (let i = 0; i < 200 && !isLocalTierRunning(); i++) await delay(10);
  assert.ok(isLocalTierRunning(), 'tier failed to start listening');

  // Entry-token exchange once, up front, EXACTLY as a browser does it: the minted URL points at
  // the dispatcher, which 302s to the pane's own origin, which does the exchange.
  const { mintEntryToken } = require('../token');
  const entryToken: string = mintEntryToken(UI_ID);
  entryRedirect = await req(tierPort, 'GET', `/ui/${UI_ID}/?lt=${entryToken}`);
  panePort = portOfLocation(entryRedirect.headers['location']);
  assert.ok(panePort > 0, `dispatcher must 302 to a pane origin (got ${entryRedirect.status} ${entryRedirect.headers['location']})`);
  docResp = await req(panePort, 'GET', `/ui/${UI_ID}/?lt=${entryToken}`);
  const setCookie = (docResp.headers['set-cookie'] || [])[0] || '';
  cookieValue = setCookie.split(';')[0];
  const vt = /window\.__VIEW_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(docResp.body);
  viewToken = vt ? JSON.parse(vt[1]) : '';

  // The second pane's origin, resolved the same way.
  const r2 = await req(tierPort, 'GET', `/ui/${UI_ID2}/`);
  panePort2 = portOfLocation(r2.headers['location']);
  assert.ok(panePort2 > 0, 'pane 2 must get an origin too');
});

after(async () => {
  try { stopTier?.(); } catch { /* ignore */ }
  await new Promise<void>((r) => lmui.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── the origin boundary ──────────────────────────────────────────────────────────────────
// 🔴 The isolation mechanism, asserted first because everything below assumes it. A shared
// origin cannot isolate panes on a non-trustworthy transport (plain http to a LAN IP sends no
// Fetch Metadata, so no request-header gate can tell a scripted read from a navigation).
// Different PORT = different origin, on every transport, enforced by the browser.

test('every pane gets its OWN origin, and they are not the same one', () => {
  assert.ok(panePort > 0 && panePort2 > 0, 'both panes have an origin');
  assert.notEqual(panePort, panePort2, 'two panes must never share an origin');
  assert.notEqual(panePort, tierPort, 'a pane must never be served on the dispatcher origin');
  assert.notEqual(panePort2, tierPort);
  const { panePortFor } = require('../server');
  assert.equal(panePortFor(UI_ID), panePort);
  assert.equal(panePortFor(UI_ID2), panePort2);
  assert.equal(panePortFor('never-visited'), null);
});

test('the dispatcher redirects to the pane origin and serves NO pane content itself', async () => {
  // The redirect keeps path + query verbatim (the entry token has to survive the hop).
  assert.equal(entryRedirect.status, 302);
  assert.match(String(entryRedirect.headers['location']), new RegExp(`^http://127\\.0\\.0\\.1:${panePort}/ui/${UI_ID}/\\?lt=`));
  assert.equal(entryRedirect.headers['referrer-policy'], 'no-referrer');
  assert.ok(!entryRedirect.headers['set-cookie'], 'the dispatcher mints nothing');
  assert.ok(!entryRedirect.body.includes('__VIEW_TOKEN__'), 'and hands out no token');

  // Every credential-bearing surface is absent from the dispatcher origin. If one of these ever
  // answers 200 here, panes share an origin again and the whole model is back to header gates.
  const dataOnDispatcher = await req(tierPort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(dataOnDispatcher.status, 404);
  const remintOnDispatcher = await req(tierPort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' }, body: JSON.stringify({ uiId: UI_ID, token: viewToken }),
  });
  assert.equal(remintOnDispatcher.status, 404);
  const meOnDispatcher = await req(tierPort, 'GET', '/auth/me', { headers: { cookie: cookieValue } });
  assert.equal(meOnDispatcher.status, 404);
});

test('a pane origin never serves ANOTHER pane — it redirects, and the token stays behind', async () => {
  // The jar holds pane 1's cookie; ask pane 1's origin for pane 2's document.
  const r = await req(panePort, 'GET', `/ui/${UI_ID2}/`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 302, 'a foreign uiId is redirected, never served');
  assert.equal(portOfLocation(r.headers['location']), panePort2);
  assert.ok(!r.body.includes('__VIEW_TOKEN__'), 'no token in the redirect body');
  assert.ok(!r.headers['set-cookie'], 'and nothing is minted on the way');
});

test('a pane origin refuses a FOREIGN pane\'s data token (the server half of the CORS rule)', async () => {
  // Acquire pane 2's own token, then try to spend it on pane 1's origin. A browser would never
  // deliver this call (an Authorization header preflights, and nothing here answers OPTIONS);
  // the server refuses it anyway so a token that leaked by some other route is origin-bound.
  const token2 = await openPaneToken(UI_ID2);
  const cross = await req(panePort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${token2}` } });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /this origin serves demo-pane/);
  // And the mirror: pane 1's token is refused on pane 2's origin.
  const back = await req(panePort2, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(back.status, 403);
});

// ── document ─────────────────────────────────────────────────────────────────────────────

test('unauthed document → 401', async () => {
  const r = await req(panePort, 'GET', `/ui/${UI_ID}/`);
  assert.equal(r.status, 401);
  assert.match(r.body, /entry token required/);
});

test('entry-token flow → cookie set + all four injections + base href', async () => {
  assert.equal(docResp.status, 200);
  assert.match(docResp.headers['content-type'] || '', /text\/html/);
  assert.match(docResp.headers['cache-control'] || '', /no-store/);
  // Cookie: HttpOnly, SameSite=Lax, scoped Path.
  const sc = (docResp.headers['set-cookie'] || [])[0] || '';
  assert.match(sc, new RegExp(`^lm_ui_${UI_ID}=`));
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  // Root path so the browser sends it to the origin-root /viewtoken/remint (shim contract).
  assert.match(sc, /Path=\//);
  // Injections.
  assert.match(docResp.body, new RegExp(`<base href="/ui/${UI_ID}/">`));
  assert.match(docResp.body, /window\.__VIEW_TOKEN__=/);
  assert.match(docResp.body, /window\.__UI_ID__=/);
  assert.match(docResp.body, /window\.__UI_KEY__=/);
  assert.match(docResp.body, /window\.__SHELL_ORIGIN__=/);
  assert.ok(viewToken.length > 0, 'view token injected');
  // Injected before </head>.
  assert.ok(docResp.body.indexOf('__VIEW_TOKEN__') < docResp.body.indexOf('</head>'));
});

test('a reload on the cookie alone still serves the document (no Sec-Fetch-Dest condition)', async () => {
  // 🔴 The regression this replaces: the document used to demand `Sec-Fetch-Dest: document`
  // when the header was present. Over plain http to a LAN IP a browser sends it on NOTHING, so
  // the rule was inert exactly where the product ships — it never blocked the scripted read it
  // was written for, and it is gone. A reload, a curl and a scripted same-origin fetch all get
  // the same answer here, and that is correct now: this listener serves ONE pane, so the only
  // script that can read it same-origin is that pane's own.
  const cases: Record<string, string>[] = [
    { cookie: cookieValue },
    { cookie: cookieValue, 'sec-fetch-dest': 'document' },
    { cookie: cookieValue, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' },
  ];
  for (const headers of cases) {
    const r = await req(panePort, 'GET', `/ui/${UI_ID}/`, { headers });
    assert.equal(r.status, 200, `headers ${JSON.stringify(headers)} must serve`);
    assert.match(r.body, /__VIEW_TOKEN__/);
  }
});

test('the document still refuses to be framed, and refuses a no-cors cross-origin read', async () => {
  // Framing is cross-origin for every OTHER pane already; these headers close the last case (a
  // pane framing itself, or any future surface that ends up co-origin) and cost nothing.
  const r = await req(panePort, 'GET', `/ui/${UI_ID}/`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-security-policy'] || ''), /frame-ancestors 'none'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  // frame-ancestors ONLY — a default-src here would kill the injected inline <script>.
  assert.ok(!/default-src/.test(String(r.headers['content-security-policy'] || '')),
    'a default-src directive would break the token injection');
  assert.match(docResp.headers['content-security-policy'] as string || '', /frame-ancestors 'none'/);
  assert.equal(docResp.headers['x-frame-options'], 'DENY');
});

test('asset proxied with private,no-cache + nosniff', async () => {
  const r = await req(panePort, 'GET', `/ui/${UI_ID}/assets/app.js`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'] || '', /application\/javascript/);
  assert.equal(r.headers['cache-control'], 'private, no-cache');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.body, /console\.log/);
});

test('asset without cookie → 401', async () => {
  const r = await req(panePort, 'GET', `/ui/${UI_ID}/assets/app.js`);
  assert.equal(r.status, 401);
});

test('assets are unframable too (a pane\'s secondary HTML is not a way back in)', async () => {
  const r = await req(panePort, 'GET', `/ui/${UI_ID}/assets/app.js`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
});

test('traversal in asset path → 403 before proxy', async () => {
  const r = await req(panePort, 'GET', `/ui/${UI_ID}/../secret`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 403);
});

test('/data traversal is rejected before the grant check (raw AND percent-encoded)', async () => {
  // grantAllows would pass '/sessions/../secrets' on the '/sessions' prefix, and Core would
  // normalize it to '/secrets' — an ungranted route reached with the node's key. Reject first.
  for (const p of ['/data/node/sessions/../secrets', '/data/node/sessions/%2e%2e/secrets', '/data/node/sessions//secrets']) {
    const r = await req(panePort, 'GET', p, { headers: { authorization: `Bearer ${viewToken}` } });
    assert.equal(r.status, 403, `${p} must 403`);
    assert.match(r.body, /illegal data path/);
  }
});

test('/auth/me answers for THIS pane only, even with a sibling\'s cookie in the jar', async () => {
  const victim = await openPane(UI_ID2);
  const jar = `${cookieValue}; ${victim.cookie}`;
  const ok = await req(panePort, 'GET', '/auth/me', { headers: { cookie: jar } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).uiId, UI_ID, 'a scan-all would answer with the sibling id here');
  const other = await req(panePort2, 'GET', '/auth/me', { headers: { cookie: jar } });
  assert.equal(JSON.parse(other.body).uiId, UI_ID2);
  // Only the sibling's cookie → this origin does not know you.
  const foreignOnly = await req(panePort, 'GET', '/auth/me', { headers: { cookie: victim.cookie } });
  assert.equal(foreignOnly.status, 401);
  const no = await req(panePort, 'GET', '/auth/me');
  assert.equal(no.status, 401);
});

test('/data node service happy path → Bearer accepted, x-api-key forwarded', async () => {
  const before = coreHits.length;
  const r = await req(panePort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.url, '/sessions');
  assert.equal(j.apiKey, API_TOKEN);
  // The Core stub itself saw the key (proves server-side attachment, not an echo trick).
  const hit = coreHits[coreHits.length - 1];
  assert.ok(coreHits.length > before);
  assert.equal(hit.apiKey, API_TOKEN);
  assert.equal(hit.url, '/sessions');
});

test('/data explicit <uiId>/<service>/<path> shape resolves identically', async () => {
  const r = await req(panePort, 'GET', `/data/${UI_ID}/node/sessions`, { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.url, '/sessions');
  assert.equal(j.apiKey, API_TOKEN);
});

test('/data without Bearer → 401', async () => {
  const r = await req(panePort, 'GET', '/data/node/sessions');
  assert.equal(r.status, 401);
});

test('/data outside declared grant → 403', async () => {
  const r = await req(panePort, 'GET', '/data/node/secrets', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 403);
  assert.match(r.body, /grant does not allow/);
});

test('/data granted non-node service → 503 LOCAL_TIER_NODE_ONLY', async () => {
  const r = await req(panePort, 'GET', '/data/files/anything', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 503);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'LOCAL_TIER_NODE_ONLY');
  assert.match(j.detail, /only service "node"/);
});

test('/data body over 1MB → 413', async () => {
  const big = 'x'.repeat(1024 * 1024 + 32);
  const r = await req(panePort, 'POST', '/data/node/sessions', {
    headers: { authorization: `Bearer ${viewToken}`, 'content-type': 'application/json' },
    body: big,
  });
  assert.equal(r.status, 413);
});

// ── remint ───────────────────────────────────────────────────────────────────────────────
// 🔴 What closes cross-pane laundering here is the ORIGIN: this handler answers for ONE uiId
// and refuses every other one, so the only script that can reach a pane's remint same-origin is
// that pane's own. That is why the caller's own token is OPTIONAL — see the next test.

/** Open a pane the way a browser does, and keep BOTH its cookie and its injected token. */
async function openPane(id: string): Promise<{ cookie: string; token: string; port: number }> {
  const { mintEntryToken } = require('../token');
  const hop = await req(tierPort, 'GET', `/ui/${id}/?lt=x`);      // resolve the pane's origin
  const port = portOfLocation(hop.headers['location']);
  const r = await req(port, 'GET', `/ui/${id}/?lt=${mintEntryToken(id)}`);
  const cookie = ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const vt = /window\.__VIEW_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(r.body);
  return { cookie, token: vt ? JSON.parse(vt[1]) as string : '', port };
}
async function openPaneToken(id: string): Promise<string> {
  return (await openPane(id)).token;
}

test('remint round-trip: the shim\'s {uiId, token} body, and the reminted token works', async () => {
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID, token: viewToken }),
  });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(typeof j.token === 'string' && j.token.length > 0, 'reminted token returned');
  const d = await req(panePort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${j.token}` } });
  assert.equal(d.status, 200);
});

test('remint accepts the DEPLOYED shim body {uiId} alone — an upgrade must not 401 live panes', async () => {
  // 🔴 The panes that actually run are served from ~/.lmui/apps, which a Core build does not
  // touch. Every deployed copy of lmui.js posts `{uiId}` with no token; a server that demanded
  // the new field would break every open pane on this node 15 minutes after the upgrade, and a
  // reload would re-serve the same old shim. It is safe to accept because this handler answers
  // for ONE pane on ONE origin: a sibling asking here gets 401 (next test), and asking on the
  // victim's own origin is a cross-origin call it cannot read the answer to.
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID }),
  });
  assert.equal(r.status, 200);
  const d = await req(panePort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${JSON.parse(r.body).token}` } });
  assert.equal(d.status, 200, 'and the token it hands back is a real one');
});

test('remint refuses a FOREIGN uiId on this origin, with both cookies in the jar', async () => {
  // The laundering path, in one call: the owner has opened both panes, so ONE host-wide jar
  // carries both cookies (cookies ignore port). The attacker pane asks its OWN origin for the
  // sibling's token — the only remint a hostile script can both reach and read.
  const victim = await openPane(UI_ID2);
  const jar = `${cookieValue}; ${victim.cookie}`;
  for (const body of [{ uiId: UI_ID2 }, { uiId: UI_ID2, token: viewToken }, { uiId: UI_ID2, token: victim.token }]) {
    const r = await req(panePort, 'POST', '/viewtoken/remint', {
      headers: { cookie: jar, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 401, `${JSON.stringify(body)} must not remint a foreign pane here`);
    assert.ok(!r.body.includes('lvt1.'), 'and it must not leak a token in the error body');
  }
});

test('remint without a cookie → 401', async () => {
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID, token: viewToken }),
  });
  assert.equal(r.status, 401);
});

test('remint: a missing uiId is a 400, not a scan-all', async () => {
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 400);
});

test('remint: a token that is SENT must verify — garbage is refused, not ignored', async () => {
  // Proof of possession stays load-bearing whenever the caller offers it: a new shim always
  // holds its own token, so a body carrying one that does not verify is a signal, not noise.
  const { mintEntryToken } = require('../token');
  for (const bad of ['not-a-token', 'lvt1.aaa.bbb', mintEntryToken(UI_ID)]) {
    const rb = await req(panePort, 'POST', '/viewtoken/remint', {
      headers: { cookie: cookieValue, 'content-type': 'application/json' },
      body: JSON.stringify({ uiId: UI_ID, token: bad }),
    });
    assert.equal(rb.status, 401, `token=${JSON.stringify(bad).slice(0, 24)} must not pass as proof`);
  }
  // A sibling's real token offered under this pane's id is refused too.
  const victim = await openPane(UI_ID2);
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID, token: victim.token }),
  });
  assert.equal(r.status, 401);
});

test('remint: an EXPIRED-but-in-grace token is still proof (a pane idle past the 15-min TTL)', async () => {
  // The point of the grace: proof of possession is about WHICH document is asking, and the 8h
  // cookie is what bounds the session. Without it, every pane left open >15 min that DOES send
  // its token would 401 on its next call — the guard would break the feature it protects.
  const { mintViewToken } = require('../token');
  const expired: string = mintViewToken(UI_ID, -60_000);          // minted already-expired
  assert.equal(require('../token').verifyViewToken(expired), null, 'precondition: dead on the data plane');
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID, token: expired }),
  });
  assert.equal(r.status, 200, 'an expired token still proves possession within the cookie life');
  // …but it buys nothing on the data plane itself.
  const d = await req(panePort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${expired}` } });
  assert.equal(d.status, 401, 'an expired token must never authorize data');
});

test('remint: a token older than the whole cookie life is NOT proof', async () => {
  const { mintViewToken } = require('../token');
  const ancient: string = mintViewToken(UI_ID, -(9 * 60 * 60 * 1000));   // 9h past expiry > 8h grace
  const r = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: cookieValue, 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID, token: ancient }),
  });
  assert.equal(r.status, 401);
});

test('unknown path → 404 (origin wall, on both the dispatcher and a pane)', async () => {
  assert.equal((await req(tierPort, 'GET', '/whatever')).status, 404);
  assert.equal((await req(panePort, 'GET', '/whatever')).status, 404);
});

// ── /go: cross-pane navigation ───────────────────────────────────────────────────────────
// The ONE surface that mints ANOTHER pane's cookie on a caller's behalf. Under one origin per
// pane that is no longer a credential handover — see serveGo.

/** A request carrying this owner's (demo-pane) cookie, and NOTHING else. */
function nav(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: cookieValue, ...extra };
}

test('/go/<other pane> → 302 to that pane\'s OWN ORIGIN with a freshly minted cookie', async () => {
  const r = await req(panePort, 'GET', `/go/${UI_ID2}`, { headers: nav() });
  assert.equal(r.status, 302);
  // Absolute + cross-origin: a pane could not have built this URL — it does not know the port.
  assert.equal(r.headers['location'], `http://127.0.0.1:${panePort2}/ui/${UI_ID2}/`);
  const sc = (r.headers['set-cookie'] || [])[0] || '';
  assert.match(sc, new RegExp(`^lm_ui_${UI_ID2}=`));
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  // Bodyless, and no referrer leak of the params to the target.
  assert.equal(r.body, '');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.headers['cache-control'] || '', /no-store/);
});

test('/go works with NO Sec-Fetch-* at all — the LAN regime, where the product actually ships', async () => {
  // 🔴 The bug this pins. `POST /ui-pages/<uiId>/local-url` mints `http://<LAN-IP>:<port>/…`,
  // and over plain http to a LAN IP Chrome sends no Fetch Metadata on ANY request, including a
  // real top-level navigation. The previous /go refused an absent header outright, so the
  // feature was 403 for every viewer who followed the documented path — measured 127.0.0.1 →
  // 302, 10.0.1.117 → 403 on the identical click. There is no header condition here now; the
  // isolation is the target's separate origin, which needs no header to work.
  const bare = await req(panePort, 'GET', `/go/${UI_ID2}?tab=logs&id=7`, { headers: { cookie: cookieValue } });
  assert.equal(bare.status, 302, '/go must work with no Sec-Fetch-Dest header');
  assert.equal(bare.headers['location'], `http://127.0.0.1:${panePort2}/ui/${UI_ID2}/?tab=logs&id=7`);
  // …and identically when the header IS present (loopback / https), so the two transports agree.
  for (const dest of ['document', 'iframe', 'empty']) {
    const r = await req(panePort, 'GET', `/go/${UI_ID2}?tab=logs&id=7`, { headers: { cookie: cookieValue, 'sec-fetch-dest': dest } });
    assert.equal(r.status, 302, `sec-fetch-dest=${dest} must behave the same`);
    assert.equal(r.headers['location'], bare.headers['location']);
  }
});

test('/go from the DISPATCHER works too (the chooser\'s links, and a hand-typed URL)', async () => {
  const r = await req(tierPort, 'GET', `/go/${UI_ID2}`, { headers: nav() });
  assert.equal(r.status, 302);
  assert.equal(r.headers['location'], `http://127.0.0.1:${panePort2}/ui/${UI_ID2}/`);
});

test('/go carries params through to the target query string', async () => {
  const r = await req(panePort, 'GET', `/go/${UI_ID2}?tab=logs&id=7`, { headers: nav() });
  assert.equal(r.status, 302);
  assert.equal(r.headers['location'], `http://127.0.0.1:${panePort2}/ui/${UI_ID2}/?tab=logs&id=7`);
});

test('/go drops reserved params — a forged ?lt= never reaches the document', async () => {
  const r = await req(panePort, 'GET', `/go/${UI_ID2}?lt=let1.forged&token=x&embed=1&theme=light&tab=x`, { headers: nav() });
  assert.equal(r.status, 302);
  assert.equal(r.headers['location'], `http://127.0.0.1:${panePort2}/ui/${UI_ID2}/?tab=x`);
});

test('/go with over-cap params refuses (400) rather than truncating', async () => {
  const r = await req(panePort, 'GET', `/go/${UI_ID2}?v=${'x'.repeat(513)}`, { headers: nav() });
  assert.equal(r.status, 400);
  assert.ok(!r.headers['set-cookie'], 'a refused nav must mint nothing');
});

test('/go without an owner cookie → 401 and NO cookie minted', async () => {
  const r = await req(panePort, 'GET', `/go/${UI_ID2}`);
  assert.equal(r.status, 401);
  assert.ok(!r.headers['set-cookie'], 'an unauthed /go must not mint a cookie');
});

test('/go is GET only → 405', async () => {
  const r = await req(panePort, 'POST', `/go/${UI_ID2}`, { headers: nav() });
  assert.equal(r.status, 405);
  assert.ok(!r.headers['set-cookie']);
});

test('/go/<unknown> → 404 rendering the pane chooser inline (no second URL to secure)', async () => {
  const r = await req(panePort, 'GET', '/go/nope', { headers: nav() });
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'] || '', /text\/html/);
  assert.match(r.body, new RegExp(`href="/go/${UI_ID}"`));
  assert.match(r.body, new RegExp(`href="/go/${UI_ID2}"`));
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy'] || ''), /frame-ancestors 'none'/);
  assert.ok(!r.headers['set-cookie']);
});

test('the chooser never echoes a hostile id (the feature\'s only HTML sink)', async () => {
  const r = await req(panePort, 'GET', `/go/${encodeURIComponent('<script>alert(1)</script>')}`, { headers: nav() });
  assert.equal(r.status, 400);           // fails UI_ID_RE before it can reach the renderer
  assert.ok(!r.body.includes('<script>alert'), r.body);
  // And an id that is merely unknown but shaped like garbage renders no raw markup either.
  const r2 = await req(panePort, 'GET', '/go/%3Cimg%20src%3Dx%3E', { headers: nav() });
  assert.ok(!r2.body.includes('<img'), r2.body);
});

test('NO surface emits an Access-Control-Allow-* header — the one change that would undo all of it', async () => {
  // 🔴 Every vector in browser-cross-pane.test.ts is closed by the browser refusing a
  // cross-origin READ. A single `Access-Control-Allow-Origin: *` anywhere here would hand those
  // reads back — silently, with every test above still green, because raw HTTP cannot see it.
  // So the invariant is asserted directly, on every surface including the preflights a browser
  // sends before a cross-origin /data or remint call.
  const probes: [number, string, string, Record<string, string>][] = [
    [tierPort, 'GET', `/ui/${UI_ID}/`, {}],
    [tierPort, 'GET', '/panes', { cookie: cookieValue }],
    [tierPort, 'GET', `/go/${UI_ID2}`, { cookie: cookieValue }],
    [panePort, 'GET', `/ui/${UI_ID}/`, { cookie: cookieValue }],
    [panePort, 'GET', `/ui/${UI_ID}/assets/app.js`, { cookie: cookieValue }],
    [panePort, 'GET', '/data/node/sessions', { authorization: `Bearer ${viewToken}` }],
    [panePort, 'OPTIONS', '/data/node/sessions', { origin: `http://127.0.0.1:${panePort2}`, 'access-control-request-headers': 'authorization' }],
    [panePort, 'OPTIONS', '/viewtoken/remint', { origin: `http://127.0.0.1:${panePort2}`, 'access-control-request-method': 'POST' }],
    [panePort, 'GET', '/auth/me', { cookie: cookieValue }],
  ];
  for (const [port, method, p, headers] of probes) {
    const r = await req(port, method, p, { headers });
    const cors = Object.keys(r.headers).filter((h) => h.toLowerCase().startsWith('access-control-'));
    assert.deepEqual(cors, [], `${method} ${p} on :${port} emitted ${cors.join(',')}`);
  }
});

test('the pane LIST is never handed to a stranger, on any surface', async () => {
  // The chooser enumerates every pane on the node, so it is owner-gated everywhere it can be
  // reached: /panes, /go/<unknown>, and the dispatcher's unknown-/ui/ branch (which runs before
  // any auth, because the entry token is single-use and belongs to the pane origin).
  for (const p of ['/panes', '/go/nope', `/ui/nope/`]) {
    const r = await req(tierPort, 'GET', p);
    assert.ok(r.status === 401 || r.status === 404, `${p} unauthed → ${r.status}`);
    assert.ok(!r.body.includes(`/go/${UI_ID2}`), `${p} must not list panes to a stranger`);
  }
  // With the owner cookie the unknown-id branch is helpful again.
  const owner = await req(tierPort, 'GET', '/ui/nope/', { headers: nav() });
  assert.equal(owner.status, 404);
  assert.match(owner.body, new RegExp(`href="/go/${UI_ID2}"`));
});

test('a bad uiId cannot make the tier bind a port', async () => {
  const { panePortFor } = require('../server');
  for (const bad of ['/ui/NOPE/', '/ui/never-served-here/', '/go/never-served-here']) {
    const r = await req(tierPort, 'GET', bad, { headers: nav() });
    assert.ok(r.status === 400 || r.status === 404, `${bad} → ${r.status}`);
  }
  assert.equal(panePortFor('never-served-here'), null, 'an unserved id must never get a listener');
  assert.equal(panePortFor('NOPE'), null);
});

test('/go cannot reach the data plane: traversal and multi-segment forms 404 with zero upstream calls', async () => {
  const before = coreHits.length;
  for (const p of ['/go/../data/node/sessions', '/go/A/B', `/go/${UI_ID2}/../../data/node/sessions`]) {
    const r = await req(panePort, 'GET', p, { headers: nav() });
    assert.equal(r.status, 404, `${p} must 404`);
    assert.ok(!r.headers['set-cookie'], `${p} must mint nothing`);
  }
  assert.equal(coreHits.length, before, '/go must never reach Core');
});

test('the minted cookie actually works: follow the 302 to a token-injected document', async () => {
  const go = await req(panePort, 'GET', `/go/${UI_ID2}?tab=logs`, { headers: nav() });
  assert.equal(go.status, 302);
  const cookie2 = ((go.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const target = new URL(String(go.headers['location']));
  const doc = await req(Number(target.port), 'GET', target.pathname + target.search, { headers: { cookie: cookie2 } });
  assert.equal(doc.status, 200);
  assert.match(doc.body, new RegExp(`window\\.__UI_ID__="${UI_ID2}"`));
  assert.match(doc.body, new RegExp(`<base href="/ui/${UI_ID2}/">`));
  assert.match(doc.body, /window\.__VIEW_TOKEN__=/);
});

test('/go did not widen the data plane: pane 2 still cannot reach pane 1\'s routes', async () => {
  // Acquire demo-pane-2's own view token the way a browser would, then prove its reach is
  // still exactly its OWN declared grant.
  const go = await req(panePort, 'GET', `/go/${UI_ID2}`, { headers: nav() });
  const cookie2 = ((go.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const doc = await req(panePort2, 'GET', `/ui/${UI_ID2}/`, { headers: { cookie: cookie2 } });
  const vt = /window\.__VIEW_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(doc.body);
  const token2 = vt ? JSON.parse(vt[1]) as string : '';
  assert.ok(token2.length > 0, 'pane 2 got its own view token');

  // Its own granted route works…
  const own = await req(panePort2, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${token2}` } });
  assert.equal(own.status, 200);
  // …but naming pane 1 in the path buys nothing (the uiId comes from the TOKEN).
  const cross = await req(panePort2, 'GET', `/data/${UI_ID}/node/sessions`, { headers: { authorization: `Bearer ${token2}` } });
  assert.equal(cross.status, 403);
  // And pane 1's write verb is still denied to a GET-only grant.
  const write = await req(panePort2, 'POST', '/data/node/sessions', {
    headers: { authorization: `Bearer ${token2}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(write.status, 403);
});

test('REGRESSION (PoC shape): the attacker pane\'s reach is exactly its own grant', async () => {
  // The whole PoC from the attacker pane's point of view, minus the browser. Every step it can
  // script on its OWN origin dead-ends; the steps it can script on the VICTIM's origin are
  // reachable only by a client with no same-origin policy (see the file header, and
  // browser-cross-pane.test.ts for the measurement that actually covers a hostile pane).
  const attacker = { cookie: cookieValue, token: viewToken };

  // Step 1 — ask its own origin for the sibling's document: redirected away, nothing leaked.
  const doc = await req(panePort, 'GET', `/ui/${UI_ID2}/`, { headers: { cookie: attacker.cookie } });
  assert.equal(doc.status, 302);
  assert.ok(!doc.body.includes('__VIEW_TOKEN__'));

  // Step 2 — launder it through its own remint instead: refused.
  const laundered = await req(panePort, 'POST', '/viewtoken/remint', {
    headers: { cookie: attacker.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ uiId: UI_ID2, token: attacker.token }),
  });
  assert.equal(laundered.status, 401);

  // Step 3 — with no foreign token, the attacker's reach is still exactly its own grant.
  const write = await req(panePort, 'POST', '/data/node/sessions', {
    headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' }, body: '{"x":1}',
  });
  assert.equal(write.status, 200, 'demo-pane\'s OWN grant covers POST /sessions (control)');
  const cross = await req(panePort, 'GET', `/data/${UI_ID2}/node/sessions`, { headers: { authorization: `Bearer ${attacker.token}` } });
  assert.equal(cross.status, 403, 'naming another pane in the PATH buys nothing — the uiId comes from the token');
});

test('GET /panes is the standing chooser: 200 with a cookie, 401 without', async () => {
  for (const port of [tierPort, panePort]) {
    const ok = await req(port, 'GET', '/panes', { headers: nav() });
    assert.equal(ok.status, 200);
    assert.match(ok.body, new RegExp(`href="/go/${UI_ID}"`));
    assert.match(ok.body, new RegExp(`href="/go/${UI_ID2}"`));
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    const no = await req(port, 'GET', '/panes');
    assert.equal(no.status, 401);
  }
});

test('/panes is an owner-gated LIST, and is documented as nothing more', async () => {
  // 🔴 This test used to be called "a scripted read is refused" and then asserted 200 for the
  // header-absent case — i.e. it pinned the opposite of its own title. There is no gate here
  // that could tell a script from a human on the shipped transport (no Fetch Metadata over
  // plain http), so the honest claim is the one asserted: a stranger gets nothing, the owner
  // gets a list of ids, and the list is not a credential because /go hands a scripted caller
  // nothing it can read.
  const cases: Record<string, string>[] = [{ cookie: cookieValue }, { cookie: cookieValue, 'sec-fetch-dest': 'empty' }];
  for (const headers of cases) {
    const r = await req(panePort, 'GET', '/panes', { headers });
    assert.equal(r.status, 200, 'the owner sees the list however it is fetched');
    assert.match(r.body, new RegExp(`href="/go/${UI_ID2}"`));
  }
  const stranger = await req(panePort, 'GET', '/panes', { headers: { cookie: 'lm_ui_demo-pane=forged' } });
  assert.equal(stranger.status, 401, 'and a forged cookie is not an owner');
});
