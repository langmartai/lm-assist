/**
 * ttyd proxy: authenticate (x-api-key or a path capability) BEFORE the managed-port
 * check, then reach only Core-managed ttyd ports. Before this, /ttyd-proxy/<any port>/
 * was a tokenless open proxy to every loopback service on the host.
 *
 * The real-socket leg runs a fake "ttyd" on 127.0.0.1 and proves: 401 without creds,
 * 200 through the cap path, the upstream never sees x-api-key, and a WS upgrade is
 * refused without creds and accepted with the header. Data dir = mkdtemp.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  parseTtydProxyUrl,
  authorizeTtydRequest,
  handleTtydProxyRequest,
  handleTtydProxyUpgrade,
  getTtydProxyUrl,
  type TtydProxyDeps,
} from '../ttyd-proxy';
import { mintTtydCap, verifyTtydCap, TTYD_CAP_RE } from '../auth/ttyd-cap';
import {
  initApiToken,
  currentApiToken,
  rotateApiToken,
  rotateApiTokenNow,
  __resetApiTokenState,
} from '../auth/api-token';

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttyd-proxy-auth-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete process.env.LM_ASSIST_API_AUTH;
});
beforeEach(() => {
  __resetApiTokenState();
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  initApiToken();
});
after(() => {
  __resetApiTokenState();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const MANAGED_PORT = 7690;
const INST = 'inst-aaaa';
const deps = (port = MANAGED_PORT, id = INST): TtydProxyDeps => ({
  activeInstanceForPort: (p) => (p === port ? { id } : undefined),
});

// ---------- parse ----------

test('parseTtydProxyUrl: shapes with and without a cap, query kept verbatim', () => {
  const cap = 'A'.repeat(43);
  assert.deepEqual(parseTtydProxyUrl('/ttyd-proxy/7681/'), { port: 7681, cap: null, rest: '/' });
  assert.deepEqual(parseTtydProxyUrl('/ttyd-proxy/7681'), { port: 7681, cap: null, rest: '/' });
  assert.deepEqual(parseTtydProxyUrl('/ttyd/7681/token'), { port: 7681, cap: null, rest: '/token' });
  assert.deepEqual(parseTtydProxyUrl(`/ttyd-proxy/7681/c/${cap}/`), { port: 7681, cap, rest: '/' });
  assert.deepEqual(parseTtydProxyUrl(`/ttyd-proxy/7681/c/${cap}`), { port: 7681, cap, rest: '/' });
  assert.deepEqual(parseTtydProxyUrl(`/ttyd-proxy/7681/c/${cap}/ws?arg=1`), { port: 7681, cap, rest: '/ws?arg=1' });
  assert.deepEqual(parseTtydProxyUrl('/ttyd/7684/?token=hubtok'), { port: 7684, cap: null, rest: '/?token=hubtok' });
  // A too-short "cap" is not a cap: it stays part of the forwarded path.
  assert.deepEqual(parseTtydProxyUrl('/ttyd-proxy/7681/c/short/'), { port: 7681, cap: null, rest: '/c/short/' });
  assert.equal(parseTtydProxyUrl('/ttyd-proxy/0/'), null);
  assert.equal(parseTtydProxyUrl('/ttyd-proxy/70000/'), null);
  assert.equal(parseTtydProxyUrl('/ttyd/processes'), null);
  assert.equal(parseTtydProxyUrl('/sessions'), null);
});

test('mintTtydCap: 43 base64url chars, deterministic, bound to port AND instance', () => {
  const a = mintTtydCap(MANAGED_PORT, INST);
  assert.match(a, TTYD_CAP_RE);
  assert.equal(mintTtydCap(MANAGED_PORT, INST), a, 'stable across polls (iframe must not reload)');
  assert.notEqual(mintTtydCap(MANAGED_PORT + 1, INST), a);
  assert.notEqual(mintTtydCap(MANAGED_PORT, 'inst-bbbb'), a);
  assert.equal(getTtydProxyUrl(MANAGED_PORT, 'http://h:3200', a), `http://h:3200/ttyd-proxy/${MANAGED_PORT}/c/${a}/`);
  assert.equal(getTtydProxyUrl(MANAGED_PORT, 'http://h:3200'), `http://h:3200/ttyd-proxy/${MANAGED_PORT}/`);
});

// ---------- authorize matrix ----------

test('no credentials → unauthorized, on managed AND unmanaged ports (no port oracle)', () => {
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: null, apiKey: null }, deps()), 'unauthorized');
  assert.equal(authorizeTtydRequest({ port: 9224, cap: null, apiKey: null }, deps()), 'unauthorized');
  assert.equal(authorizeTtydRequest({ port: 9224, cap: null, apiKey: 'garbage' }, deps()), 'unauthorized');
});

test('valid header on an unmanaged port → not-managed; on a managed port → ok', () => {
  const k = currentApiToken();
  assert.equal(authorizeTtydRequest({ port: 9224, cap: null, apiKey: k }, deps()), 'not-managed');
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: null, apiKey: k }, deps()), 'ok');
});

test('the server static --api-key is accepted like the ring token', () => {
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: null, apiKey: 'static-k', serverApiKey: 'static-k' }, deps()), 'ok');
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: null, apiKey: '', serverApiKey: '' }, deps()), 'unauthorized');
});

test('valid cap → ok; a cap for another port or instance → unauthorized', () => {
  const cap = mintTtydCap(MANAGED_PORT, INST);
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap, apiKey: null }, deps()), 'ok');
  const otherPort = mintTtydCap(MANAGED_PORT + 1, INST);
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: otherPort, apiKey: null }, deps()), 'unauthorized');
  const otherInst = mintTtydCap(MANAGED_PORT, 'inst-old');
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: otherInst, apiKey: null }, deps()), 'unauthorized');
  // A cap for an unmanaged port can never verify (no instance to bind to).
  assert.equal(authorizeTtydRequest({ port: 9224, cap: mintTtydCap(9224, INST), apiKey: null }, deps()), 'unauthorized');
});

test('a cap minted from a GRACE token still works; revoke-now kills it', () => {
  const old = currentApiToken();
  const capOld = mintTtydCap(MANAGED_PORT, INST, old);
  rotateApiToken(Date.now()); // scheduled-style rotation: `old` stays in grace
  assert.notEqual(currentApiToken(), old);
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: capOld, apiKey: null }, deps()), 'ok');
  const capNew = mintTtydCap(MANAGED_PORT, INST);
  rotateApiTokenNow();
  assert.equal(verifyTtydCap(capOld, MANAGED_PORT, INST), false);
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: capOld, apiKey: null }, deps()), 'unauthorized');
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: capNew, apiKey: null }, deps()), 'unauthorized');
  assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: mintTtydCap(MANAGED_PORT, INST), apiKey: null }, deps()), 'ok');
});

test('auth kill-switch: no credential needed, but an unmanaged port is still not-managed', () => {
  process.env.LM_ASSIST_API_AUTH = '0';
  try {
    assert.equal(authorizeTtydRequest({ port: 9224, cap: null, apiKey: null }, deps()), 'not-managed');
    assert.equal(authorizeTtydRequest({ port: MANAGED_PORT, cap: null, apiKey: null }, deps()), 'ok');
  } finally {
    delete process.env.LM_ASSIST_API_AUTH;
  }
});

// ---------- real sockets ----------

interface Harness {
  upstreamPort: number;
  proxyPort: number;
  seen: http.IncomingHttpHeaders[];
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const seen: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head></head><body>fake ttyd</body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: '' }));
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws, req) => {
    seen.push(req.headers);
    ws.send('hello-from-ttyd');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const d = deps(upstreamPort, INST);

  const proxy = http.createServer((req, res) => {
    if (!handleTtydProxyRequest(req, res, { deps: d })) {
      res.writeHead(418);
      res.end();
    }
  });
  proxy.on('upgrade', (req, socket, head) => {
    if (!handleTtydProxyUpgrade(req, socket, head, { deps: d })) socket.destroy();
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    upstreamPort,
    proxyPort,
    seen,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      for (const s of [proxy, upstream]) {
        s.closeAllConnections?.();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}

function request(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsOutcome(url: string, headers?: Record<string, string>): Promise<{ opened: boolean; status?: number; message?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ['tty'], headers ? { headers } : {});
    const done = (v: { opened: boolean; status?: number; message?: string }) => { try { ws.terminate(); } catch { /* closed */ } resolve(v); };
    ws.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }));
    ws.on('message', (m) => done({ opened: true, message: String(m) }));
    ws.on('error', () => done({ opened: false }));
  });
}

test('real socket: 401 without creds, 200 via the cap path, x-api-key never reaches ttyd', async () => {
  const h = await startHarness();
  try {
    const bare = await request(h.proxyPort, `/ttyd-proxy/${h.upstreamPort}/`);
    assert.equal(bare.status, 401);
    assert.equal(bare.headers['cache-control'], 'no-store');
    assert.equal(h.seen.length, 0, 'upstream must not be touched by an unauthenticated request');

    // An arbitrary loopback port is not reachable even WITH the token (was an open proxy).
    const other = await request(h.proxyPort, '/ttyd-proxy/9/json/version', { 'x-api-key': currentApiToken() });
    assert.equal(other.status, 404);

    const cap = mintTtydCap(h.upstreamPort, INST);
    const page = await request(h.proxyPort, `/ttyd-proxy/${h.upstreamPort}/c/${cap}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /fake ttyd/);
    assert.match(page.body, /ttyd-proxy-scrollbar-style/, 'CSS injected on the root page');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['cache-control'], 'no-store');

    const sub = await request(h.proxyPort, `/ttyd-proxy/${h.upstreamPort}/c/${cap}/token`);
    assert.equal(sub.status, 200);

    const withHeader = await request(h.proxyPort, `/ttyd-proxy/${h.upstreamPort}/token`, { 'x-api-key': currentApiToken() });
    assert.equal(withHeader.status, 200);
    assert.ok(h.seen.length >= 3);
    for (const hdrs of h.seen) assert.equal(hdrs['x-api-key'], undefined, 'the ring token must never be forwarded to ttyd');
  } finally {
    await h.close();
  }
});

test('real socket: WS upgrade refused without creds, accepted with the header or the cap', async () => {
  const h = await startHarness();
  try {
    const url = `ws://127.0.0.1:${h.proxyPort}/ttyd-proxy/${h.upstreamPort}/ws`;
    const refused = await wsOutcome(url);
    assert.equal(refused.opened, false);
    assert.equal(refused.status, 401);

    const withKey = await wsOutcome(url, { 'x-api-key': currentApiToken() });
    assert.equal(withKey.opened, true);
    assert.equal(withKey.message, 'hello-from-ttyd');

    const cap = mintTtydCap(h.upstreamPort, INST);
    const viaCap = await wsOutcome(`ws://127.0.0.1:${h.proxyPort}/ttyd-proxy/${h.upstreamPort}/c/${cap}/ws`);
    assert.equal(viaCap.opened, true);

    const unmanaged = await wsOutcome(`ws://127.0.0.1:${h.proxyPort}/ttyd-proxy/9/ws`, { 'x-api-key': currentApiToken() });
    assert.equal(unmanaged.opened, false);
    assert.equal(unmanaged.status, 404);

    for (const hdrs of h.seen) assert.equal(hdrs['x-api-key'], undefined);
  } finally {
    await h.close();
  }
});
