/**
 * Local serving tier — self-contained integration test.
 *
 * Stands up two stub upstreams (an lmui static host + a Core API that records x-api-key and
 * echoes) and the tier in front of them, on ephemeral ports, under an isolated HOME so the
 * per-node secret and ~/.lmui state never touch the real ones.
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

interface CoreHit { url?: string; method?: string; apiKey?: string | string[]; body: string }

let lmui: http.Server, core: http.Server;
let tierPort = 0;
let stopTier: () => void;
const coreHits: CoreHit[] = [];
let cookieValue = '';   // 'lm_ui_demo-pane=<8h token>'
let viewToken = '';     // window.__VIEW_TOKEN__ (15-min data-plane token)
let docResp: Resp;

before(async () => {
  // Stub lmui host — serves the app document + one asset under /ui-<uiId>/.
  lmui = http.createServer((rq, rs) => {
    if (rq.url === `/ui-${UI_ID}/index.html`) {
      rs.writeHead(200, { 'content-type': 'text/html' });
      rs.end('<!doctype html><html><head><title>demo</title></head><body>hi</body></html>');
    } else if (rq.url === `/ui-${UI_ID}/assets/app.js`) {
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

  // A pre-bound-then-closed socket yields a free port to hand the tier (it binds a concrete port).
  const probe = http.createServer();
  const freePort = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));

  const { startLocalUiTier, isLocalTierRunning } = require('../server');
  stopTier = startLocalUiTier({ localUiPort: freePort, uiWebPort: lmuiPort, apiPort: corePort, getApiToken: () => API_TOKEN, log: () => {} });
  tierPort = freePort;
  for (let i = 0; i < 200 && !isLocalTierRunning(); i++) await delay(10);
  assert.ok(isLocalTierRunning(), 'tier failed to start listening');

  // Entry-token exchange once, up front — captures the cookie + injected view token the
  // rest of the suite reuses.
  const { mintEntryToken } = require('../token');
  const entryToken: string = mintEntryToken(UI_ID);
  docResp = await req(tierPort, 'GET', `/ui/${UI_ID}/?lt=${entryToken}`);
  const setCookie = (docResp.headers['set-cookie'] || [])[0] || '';
  cookieValue = setCookie.split(';')[0];
  const vt = /window\.__VIEW_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(docResp.body);
  viewToken = vt ? JSON.parse(vt[1]) : '';
});

after(async () => {
  try { stopTier?.(); } catch { /* ignore */ }
  await new Promise<void>((r) => lmui.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('unauthed document → 401', async () => {
  const r = await req(tierPort, 'GET', `/ui/${UI_ID}/`);
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

test('asset proxied with private,no-cache + nosniff', async () => {
  const r = await req(tierPort, 'GET', `/ui/${UI_ID}/assets/app.js`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'] || '', /application\/javascript/);
  assert.equal(r.headers['cache-control'], 'private, no-cache');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.body, /console\.log/);
});

test('asset without cookie → 401', async () => {
  const r = await req(tierPort, 'GET', `/ui/${UI_ID}/assets/app.js`);
  assert.equal(r.status, 401);
});

test('traversal in asset path → 403 before proxy', async () => {
  const r = await req(tierPort, 'GET', `/ui/${UI_ID}/../secret`, { headers: { cookie: cookieValue } });
  assert.equal(r.status, 403);
});

test('/data traversal is rejected before the grant check (raw AND percent-encoded)', async () => {
  // grantAllows would pass '/sessions/../secrets' on the '/sessions' prefix, and Core would
  // normalize it to '/secrets' — an ungranted route reached with the node's key. Reject first.
  for (const p of ['/data/node/sessions/../secrets', '/data/node/sessions/%2e%2e/secrets', '/data/node/sessions//secrets']) {
    const r = await req(tierPort, 'GET', p, { headers: { authorization: `Bearer ${viewToken}` } });
    assert.equal(r.status, 403, `${p} must 403`);
    assert.match(r.body, /illegal data path/);
  }
});

test('document is navigation-only: a scripted (Sec-Fetch-Dest: empty) fetch is refused', async () => {
  // Same-origin cross-pane scrape guard: pane B’s fetch() of pane A’s document carries
  // Sec-Fetch-Dest: empty and must not receive the token-injected HTML. A real nav (document)
  // or an iframe embed passes.
  const scripted = await req(tierPort, 'GET', `/ui/${UI_ID}/`, { headers: { cookie: cookieValue, 'sec-fetch-dest': 'empty' } });
  assert.equal(scripted.status, 403);
  const nav = await req(tierPort, 'GET', `/ui/${UI_ID}/`, { headers: { cookie: cookieValue, 'sec-fetch-dest': 'document' } });
  assert.equal(nav.status, 200);
  assert.match(nav.body, /__VIEW_TOKEN__/);
  const framed = await req(tierPort, 'GET', `/ui/${UI_ID}/`, { headers: { cookie: cookieValue, 'sec-fetch-dest': 'iframe' } });
  assert.equal(framed.status, 200);
});

test('/auth/me returns cosmetic identity for a valid view cookie, 401 without', async () => {
  const ok = await req(tierPort, 'GET', '/auth/me', { headers: { cookie: cookieValue } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).uiId, UI_ID);
  const no = await req(tierPort, 'GET', '/auth/me');
  assert.equal(no.status, 401);
});

test('/data node service happy path → Bearer accepted, x-api-key forwarded', async () => {
  const before = coreHits.length;
  const r = await req(tierPort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${viewToken}` } });
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
  const r = await req(tierPort, 'GET', `/data/${UI_ID}/node/sessions`, { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.url, '/sessions');
  assert.equal(j.apiKey, API_TOKEN);
});

test('/data without Bearer → 401', async () => {
  const r = await req(tierPort, 'GET', '/data/node/sessions');
  assert.equal(r.status, 401);
});

test('/data outside declared grant → 403', async () => {
  const r = await req(tierPort, 'GET', '/data/node/secrets', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 403);
  assert.match(r.body, /grant does not allow/);
});

test('/data granted non-node service → 503 LOCAL_TIER_NODE_ONLY', async () => {
  const r = await req(tierPort, 'GET', '/data/files/anything', { headers: { authorization: `Bearer ${viewToken}` } });
  assert.equal(r.status, 503);
  const j = JSON.parse(r.body);
  assert.equal(j.error, 'LOCAL_TIER_NODE_ONLY');
  assert.match(j.detail, /only service "node"/);
});

test('/data body over 1MB → 413', async () => {
  const big = 'x'.repeat(1024 * 1024 + 32);
  const r = await req(tierPort, 'POST', '/data/node/sessions', {
    headers: { authorization: `Bearer ${viewToken}`, 'content-type': 'application/json' },
    body: big,
  });
  assert.equal(r.status, 413);
});

test('viewtoken remint round-trip', async () => {
  const r = await req(tierPort, 'POST', '/viewtoken/remint', { headers: { cookie: cookieValue, 'content-type': 'application/json' }, body: JSON.stringify({ uiId: UI_ID }) });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(typeof j.token === 'string' && j.token.length > 0, 'reminted token returned');
  // The reminted token must itself work on the data plane.
  const d = await req(tierPort, 'GET', '/data/node/sessions', { headers: { authorization: `Bearer ${j.token}` } });
  assert.equal(d.status, 200);
});

test('viewtoken remint without a cookie → 401', async () => {
  const r = await req(tierPort, 'POST', '/viewtoken/remint', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiId: UI_ID }) });
  assert.equal(r.status, 401);
});

test('viewtoken remint is scoped to the requested uiId (cross-pane confused-deputy guard)', async () => {
  // A caller holding demo-pane's cookie may NOT remint a DIFFERENT pane's token by asking for it.
  const r = await req(tierPort, 'POST', '/viewtoken/remint', { headers: { cookie: cookieValue, 'content-type': 'application/json' }, body: JSON.stringify({ uiId: 'other-pane' }) });
  assert.equal(r.status, 401);
  // And a missing uiId is a 400, not a scan-all.
  const r2 = await req(tierPort, 'POST', '/viewtoken/remint', { headers: { cookie: cookieValue, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r2.status, 400);
});

test('unknown path → 404 (origin wall)', async () => {
  const r = await req(tierPort, 'GET', '/whatever');
  assert.equal(r.status, 404);
});
