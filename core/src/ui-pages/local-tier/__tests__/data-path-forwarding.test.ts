/**
 * The WIRE half of "check what you execute".
 *
 * `path-canonicalization.test.ts` proves the DECISION is about the canonical path. It cannot
 * prove the tier then SENDS that path — and the defect was exactly a mismatch between the string
 * that was checked and the string that went out. So this file stands the real tier in front of a
 * stub Core that records `req.url`, and asserts the recorded URL is the canonical one.
 *
 * A separate harness from server.test.ts on purpose: this needs a pane whose grant uses
 * `exact:true` + `*` (the narrowing the crafted path defeats), and `node --test` gives each file
 * its own process, so the HOME redirection below cannot collide with that file's.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

// Must precede the require()s in before(): token.ts/manager.ts read os.homedir() at call time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-fwd-home-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const UI_ID = 'fwd-pane';
const API_TOKEN = 'fwd-api-token';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }
function req(port: number, method: string, rawPath: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

let lmui: http.Server, core: http.Server;
let panePort = 0;
let stopTier: () => void;
let viewToken = '';
const coreUrls: string[] = [];

before(async () => {
  lmui = http.createServer((rq, rs) => {
    if (rq.url === `/ui-${UI_ID}/index.html`) {
      rs.writeHead(200, { 'content-type': 'text/html' });
      rs.end('<!doctype html><html><head><title>fwd</title></head><body>hi</body></html>');
    } else { rs.writeHead(404); rs.end('nope'); }
  });
  // Records the EXACT request line Core would route on — this is the measurement.
  core = http.createServer((rq, rs) => {
    coreUrls.push(rq.url || '');
    rq.resume();
    rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ ok: true, url: rq.url, routed: new URL(rq.url || '/', 'http://127.0.0.1').pathname }));
    });
  });
  const lmuiPort = await listen(lmui);
  const corePort = await listen(core);

  // The grant under test: a LEAF rule with a wildcard — "one mission by id, read only".
  const appDir = path.join(tmpHome, 'apps', UI_ID);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'lmui.config.json'), JSON.stringify({
    uiId: UI_ID,
    service: `ui-${UI_ID}`,
    grant: [
      { service: 'node', pathPrefix: '/mission', verbs: ['GET'], exact: true },
      { service: 'node', pathPrefix: '/mission/*', verbs: ['GET'], exact: true },
    ],
  }));
  fs.mkdirSync(path.join(tmpHome, '.lmui'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.lmui', `dev-${UI_ID}.json`), JSON.stringify({
    uiId: UI_ID, service: `ui-${UI_ID}`, pid: process.pid, port: lmuiPort, dir: appDir,
    sdkPath: '', log: '', startedAt: new Date().toISOString(),
  }));

  const probe = http.createServer();
  const freePort = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));

  const { startLocalUiTier, isLocalTierRunning } = require('../server');
  stopTier = startLocalUiTier({ localUiPort: freePort, uiWebPort: lmuiPort, apiPort: corePort, getApiToken: () => API_TOKEN, log: () => {} });
  for (let i = 0; i < 200 && !isLocalTierRunning(); i++) await delay(10);
  assert.ok(isLocalTierRunning(), 'tier failed to start listening');

  const { mintEntryToken } = require('../token');
  const entryToken: string = mintEntryToken(UI_ID);
  const hop = await req(freePort, 'GET', `/ui/${UI_ID}/?lt=${entryToken}`);
  const m = /^http:\/\/(?:\[[^\]]+\]|[^/:]+):(\d+)(\/|$)/.exec(String(hop.headers['location'] || ''));
  panePort = m ? Number(m[1]) : 0;
  assert.ok(panePort > 0, `dispatcher must 302 to a pane origin (got ${hop.status})`);
  const doc = await req(panePort, 'GET', `/ui/${UI_ID}/?lt=${entryToken}`);
  const vt = /window\.__VIEW_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(doc.body);
  viewToken = vt ? JSON.parse(vt[1]) as string : '';
  assert.ok(viewToken.length > 0, 'pane must receive a view token');
});

after(async () => {
  try { stopTier?.(); } catch { /* ignore */ }
  await new Promise<void>((r) => lmui.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${viewToken}` });

test('a granted call reaches Core with the path it was granted', async () => {
  const before = coreUrls.length;
  const r = await req(panePort, 'GET', '/data/node/mission/m1', auth());
  assert.equal(r.status, 200);
  assert.equal(coreUrls.length, before + 1);
  assert.equal(coreUrls[coreUrls.length - 1], '/mission/m1');
  assert.equal(JSON.parse(r.body).routed, '/mission/m1', 'and Core routes on exactly that');
});

test('THE DEFECT, end to end: the backslash form is refused and NOTHING reaches Core', async () => {
  // Pre-fix this returned 200: the leaf grant saw two segments (`mission`, `session\s1\read`)
  // and Core then routed the four-segment `/mission/session/s1/read`.
  const before = coreUrls.length;
  const r = await req(panePort, 'GET', '/data/node/mission/session\\s1\\read', auth());
  assert.equal(r.status, 403, `expected 403, got ${r.status} ${r.body}`);
  assert.match(r.body, /grant does not allow/);
  assert.match(r.body, /\/mission\/session\/s1\/read/, 'the refusal names the path that WOULD have run');
  assert.equal(coreUrls.length, before, 'no upstream request may be made at all');
});

test('a `.` segment is normalized BEFORE the check, and Core sees the normalized path', async () => {
  const before = coreUrls.length;
  const r = await req(panePort, 'GET', '/data/node/mission/./m1', auth());
  assert.equal(r.status, 200, r.body);
  assert.equal(coreUrls.length, before + 1);
  assert.equal(coreUrls[coreUrls.length - 1], '/mission/m1', 'the dot segment must not go on the wire');
});

test('traversal and encoded separators are refused with zero upstream traffic', async () => {
  for (const p of [
    '/data/node/mission/m1/../../backlog',
    '/data/node/mission/m1/%2e%2e/backlog',
    '/data/node/mission/m1/%252e%252e/backlog',
    '/data/node/mission/a%2fb',
    '/data/node/mission/a%5cb',
    '/data/node/mission//m1',
  ]) {
    const before = coreUrls.length;
    const r = await req(panePort, 'GET', p, auth());
    assert.equal(r.status, 403, `${p} must 403, got ${r.status}`);
    assert.match(r.body, /illegal data path/);
    assert.equal(coreUrls.length, before, `${p} must not reach Core`);
  }
});

test('the query string still rides along, attached to the CANONICAL path', async () => {
  const before = coreUrls.length;
  const r = await req(panePort, 'GET', '/data/node/mission/./m1?depth=2&x=a%20b', auth());
  assert.equal(r.status, 200, r.body);
  assert.equal(coreUrls.length, before + 1);
  assert.equal(coreUrls[coreUrls.length - 1], '/mission/m1?depth=2&x=a%20b');
});

test('a non-ASCII id is forwarded percent-encoded — the form Core would have normalized it to', async () => {
  const before = coreUrls.length;
  const r = await req(panePort, 'GET', '/data/node/mission/caf%C3%A9', auth());
  assert.equal(r.status, 200, r.body);
  assert.equal(coreUrls[coreUrls.length - 1], '/mission/caf%C3%A9');
  assert.equal(coreUrls.length, before + 1);
});
