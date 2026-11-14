/**
 * Request-path safety in rest-server.ts, exercised through the REAL request code
 * (dispatchRequest → handleRequest → routeRequest) on a bare http.Server. The
 * TierRestServer constructor is skipped (it starts watchers and the whole route table);
 * the instance gets only the fields the request path reads.
 *
 *  1. GET /tasks/events must not answer `Access-Control-Allow-Origin: *`. Its writeHead
 *     used to override the allow-listed CORS headers staged by corsHeadersFor.
 *  2. A malformed Host on the open /health route used to throw in parseRequest outside
 *     any try; the async rejection was unhandled and Node exited — one unauthenticated
 *     LAN packet killed Core. Now: fixed-base parse, 400 for an unparseable target, and a
 *     wrapper that turns any escaped error into a 500.
 *  3. Static guard: no `'Access-Control-Allow-Origin': '*'` literal anywhere in core/src.
 *
 * Tokens are compared, never printed. Data dir = mkdtemp.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';

let dir = '';
let server: http.Server;
let port = 0;
let srv: any;
let token = '';
let unhandled = 0;
const onUnhandled = () => { unhandled++; };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-safety-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  process.env.WEB_PORT = '3948';
  delete process.env.ASSIST_WEB_PORT;
  delete process.env.LM_HTTPS_PORT;
  delete process.env.LM_ASSIST_CORS_ORIGINS;
  delete process.env.LM_ASSIST_ALLOWED_HOSTS;
  delete process.env.LM_ASSIST_API_AUTH;
  delete process.env.LM_ASSIST_API_AUTH_EXEMPT_LOCAL;
  process.on('unhandledRejection', onUnhandled);

  // Lazy: LM_ASSIST_DATA_DIR must be set before any module touches the data dir.
  const { TierRestServer } = require('../rest-server') as typeof import('../rest-server');
  token = (require('../auth/api-token') as typeof import('../auth/api-token')).currentApiToken();

  srv = Object.create(TierRestServer.prototype);
  srv.options = { port: 0, host: '127.0.0.1', projectPath: dir, cors: true, apiKey: '' };
  srv.sseClients = new Map();
  srv.claudeTasksSSEClients = new Set();
  srv.modularRoutes = [
    { method: 'GET', pattern: /^\/health$/, handler: async () => ({ success: true, data: { ok: true } }) },
  ];

  server = http.createServer((req, res) => srv.dispatchRequest(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as net.AddressInfo).port;
});

after(async () => {
  for (const c of srv?.claudeTasksSSEClients || []) { try { c.destroy(); } catch { /* ignore */ } }
  (server as any)?.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  process.off('unhandledRejection', onUnhandled);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Raw request (so Host / request-target can be malformed); resolves status + headers text. */
function raw(requestHead: string): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(requestHead));
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('no response within 5s')); }, 5000);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        clearTimeout(timer);
        sock.destroy();
        const head = buf.slice(0, end);
        resolve({ status: parseInt(head.split(' ')[1], 10), head });
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** GET an SSE route, resolve on the response head, then abort the stream. */
function sseHead(p: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      resolve(res);
      req.destroy();
    });
    req.on('error', (e) => { if ((e as any).code !== 'ECONNRESET') reject(e); });
  });
}

async function stillServing(): Promise<void> {
  const r = await raw('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.equal(r.status, 200, 'Core must keep serving after the bad request');
}

test('/tasks/events: a foreign Origin gets NO Access-Control-Allow-Origin (never *)', async () => {
  const res = await sseHead('/tasks/events', { 'x-api-key': token, origin: 'http://evil.invalid' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('/tasks/events: this machine\'s web origin is reflected, not replaced by *', async () => {
  const res = await sseHead('/tasks/events', { 'x-api-key': token, origin: 'http://localhost:3948' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3948');
});

test('/tasks/events without a token: 401, no ACAO (gate unchanged)', async () => {
  const r = await raw('GET /tasks/events HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.invalid\r\nConnection: close\r\n\r\n');
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.head, /access-control-allow-origin/i);
});

test('malformed Host on the open /health route: answered, and Core stays up', async () => {
  for (const host of ['a b', '[', 'x:99999']) {
    const r = await raw(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.equal(r.status, 200, `Host ${JSON.stringify(host)} is irrelevant to routing now`);
  }
  await stillServing();
  assert.equal(unhandled, 0, 'no unhandled rejection');
});

test('unparseable request target (authenticated): 400, Core stays up', async () => {
  for (const target of ['http://[/health', 'http://a%zz/health', '//x:99999/health']) {
    const r = await raw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-api-key: ${token}\r\nConnection: close\r\n\r\n`);
    assert.equal(r.status, 400, `target ${target}`);
  }
  await stillServing();
  assert.equal(unhandled, 0, 'no unhandled rejection');
});

test('unparseable request target (no token): still 401 at the gate', async () => {
  const r = await raw('GET http://[/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.equal(r.status, 401);
});

test('an error escaping the request path becomes a 500, never a crash', async () => {
  const orig = srv.parseRequest;
  srv.parseRequest = async () => { throw new Error('boom'); };
  try {
    const r = await raw('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.equal(r.status, 500);
  } finally {
    srv.parseRequest = orig;
  }
  await stillServing();
  assert.equal(unhandled, 0, 'no unhandled rejection');
});

test('static guard: no hardcoded `Access-Control-Allow-Origin: *` in core/src', () => {
  // dist-test/__tests__/<this>.js → core/src
  const src = path.join(__dirname, '..', '..', 'src');
  assert.ok(fs.existsSync(path.join(src, 'rest-server.ts')), `core/src not found at ${src}`);
  const wildcard = /['"]Access-Control-Allow-Origin['"]\s*[:,]\s*['"]\*['"]/i;
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(p);
      } else if (/\.(ts|js)$/.test(e.name)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((l, i) => { if (wildcard.test(l)) hits.push(`${path.relative(src, p)}:${i + 1}`); });
      }
    }
  };
  walk(src);
  assert.deepEqual(hits, [], 'CORS goes through auth/origin-policy.ts corsHeadersFor, never a literal *');
});
