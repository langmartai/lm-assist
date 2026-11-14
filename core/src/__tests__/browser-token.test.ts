/**
 * GET /auth/browser-token — the browser's only way to the Core token now that no HTML
 * carries it. Walks the full decision table (decideBrowserToken is pure), then a
 * real-socket leg on a bare http.Server to prove the socket peer + headers wiring.
 *
 * Tokens are compared against currentApiToken(), never printed. Data dir = mkdtemp.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-token-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  process.env.WEB_PORT = '3948';
  delete process.env.ASSIST_WEB_PORT;
  delete process.env.LM_HTTPS_PORT;
  delete process.env.LM_ASSIST_CORS_ORIGINS;
  delete process.env.LM_ASSIST_ALLOWED_HOSTS;
  delete process.env.LM_ASSIST_API_AUTH;
});
after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Imported lazily so LM_ASSIST_DATA_DIR is set before any module touches the data dir.
const mod = () => require('../auth/browser-token') as typeof import('../auth/browser-token');
const tok = () => require('../auth/api-token') as typeof import('../auth/api-token');

const KEY = 'k'.repeat(64);
const LAN_ON = { lanAuthEnabled: true, lanAccessToken: KEY };
const LOCAL = '127.0.0.1';
const FOREIGN = '198.51.100.7'; // TEST-NET-2: never one of this host's interfaces

function decide(over: {
  method?: string;
  remoteAddress?: string;
  headers?: Record<string, string | undefined>;
  authEnabled?: boolean;
  lan?: { lanAuthEnabled: boolean; lanAccessToken: string | null };
}) {
  return mod().decideBrowserToken({
    method: over.method ?? 'GET',
    remoteAddress: over.remoteAddress ?? LOCAL,
    headers: { host: '127.0.0.1:3200', 'x-lm-client': 'web', ...(over.headers || {}) },
    authEnabled: over.authEnabled ?? true,
    lan: over.lan ?? LAN_ON,
  });
}

test('local peer + own Host + no Origin + client header → issue via local', () => {
  const d = decide({});
  assert.equal(d.status, 200);
  assert.equal(d.issue, true);
  assert.equal(d.via, 'local');
});

test('local peer with an allowed Origin (the desk web UI) → issue', () => {
  const d = decide({ headers: { origin: 'http://localhost:3948', host: 'localhost:3200' } });
  assert.equal(d.issue, true);
  assert.equal(d.via, 'local');
});

test('every forwarding header refuses the local branch — x-forwarded-host "" included', () => {
  for (const h of [
    { 'x-forwarded-host': '' },
    { 'x-forwarded-host': '10.0.0.9:3948' },
    { 'x-forwarded-for': '10.0.0.9' },
    { forwarded: 'for=10.0.0.9' },
    { 'x-real-ip': '10.0.0.9' },
  ]) {
    const d = decide({ headers: h });
    assert.equal(d.issue, false, JSON.stringify(h));
    assert.equal(d.status, 401, JSON.stringify(h));
    assert.equal(d.code, 'UNAUTHORIZED', JSON.stringify(h));
  }
});

test('x-forwarded-proto alone (HTTPS terminator in-process dispatch) still issues', () => {
  const d = decide({ headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(d.issue, true);
});

test('relayed request → 403 RELAYED, even with a valid LAN key', () => {
  const d = decide({ headers: { 'x-relay-source': 'hub', 'x-lm-lan-key': KEY } });
  assert.equal(d.status, 403);
  assert.equal(d.code, 'RELAYED');
  assert.equal(d.issue, false);
});

test('foreign Origin → 403 ORIGIN_NOT_ALLOWED (even from loopback)', () => {
  const d = decide({ headers: { origin: 'https://evil.example' } });
  assert.equal(d.status, 403);
  assert.equal(d.code, 'ORIGIN_NOT_ALLOWED');
});

test('DNS rebinding: local peer but Host rebind.example → 401, no token', () => {
  const d = decide({ headers: { host: 'rebind.example:3200' } });
  assert.equal(d.status, 401);
  assert.equal(d.issue, false);
});

test('non-local peer with the valid LAN key while lanAuthEnabled → issue via lan-key', () => {
  const d = decide({ remoteAddress: FOREIGN, headers: { 'x-lm-lan-key': KEY } });
  assert.equal(d.status, 200);
  assert.equal(d.issue, true);
  assert.equal(d.via, 'lan-key');
});

test('valid LAN key but lanAuthEnabled:false (LAN disabled) → 401 LAN_KEY_INVALID', () => {
  const d = decide({ remoteAddress: FOREIGN, headers: { 'x-lm-lan-key': KEY }, lan: { lanAuthEnabled: false, lanAccessToken: KEY } });
  assert.equal(d.status, 401);
  assert.equal(d.code, 'LAN_KEY_INVALID');
});

test('same-length wrong LAN key → 401 LAN_KEY_INVALID; no key configured → same', () => {
  const wrong = decide({ remoteAddress: FOREIGN, headers: { 'x-lm-lan-key': 'j'.repeat(64) } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.code, 'LAN_KEY_INVALID');
  const none = decide({ remoteAddress: FOREIGN, headers: { 'x-lm-lan-key': KEY }, lan: { lanAuthEnabled: true, lanAccessToken: null } });
  assert.equal(none.code, 'LAN_KEY_INVALID');
});

test('non-local peer with no key → 401 UNAUTHORIZED', () => {
  const d = decide({ remoteAddress: FOREIGN });
  assert.equal(d.status, 401);
  assert.equal(d.code, 'UNAUTHORIZED');
});

test('missing X-LM-Client → 400 CLIENT_HEADER_REQUIRED', () => {
  const d = decide({ headers: { 'x-lm-client': undefined } });
  assert.equal(d.status, 400);
  assert.equal(d.code, 'CLIENT_HEADER_REQUIRED');
});

test('non-GET → 405', () => {
  assert.equal(decide({ method: 'POST' }).status, 405);
});

test('auth kill-switch off → 200 with no token', () => {
  const d = decide({ authEnabled: false, remoteAddress: FOREIGN });
  assert.equal(d.status, 200);
  assert.equal(d.issue, false);
  assert.equal(d.via, 'auth-disabled');
});

test('an x-api-key header is ignored (cannot be traded for the ring token)', () => {
  const d = decide({ remoteAddress: FOREIGN, headers: { 'x-api-key': 'anything' } });
  assert.equal(d.status, 401);
  assert.equal(d.issue, false);
});

// ---------- real socket ----------

function get(port: number, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/auth/browser-token', method: 'GET', headers, agent: false }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('real socket: loopback GET issues the current token with no-store; forwarded is refused', async () => {
  const server = http.createServer((req, res) => mod().handleBrowserTokenRequest(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const ok = await get(port, { 'X-LM-Client': 'web' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.match(String(ok.headers['vary'] || ''), /Origin/);
    assert.equal(ok.body.data.via, 'local');
    assert.equal(ok.body.data.expiresAt, null);
    assert.ok(ok.body.data.token === tok().currentApiToken(), 'issued token must be the current ring token');

    const fwd = await get(port, { 'X-LM-Client': 'web', 'X-Forwarded-Host': '' });
    assert.ok(fwd.status === 401 || fwd.status === 403, `forwarded must be refused, got ${fwd.status}`);
    assert.equal(fwd.body.success, false);
    assert.equal(fwd.body.data, undefined);

    // The LAN-key branch over a real socket: forwarded (a LAN browser via the web
    // proxy) but holding the key.
    fs.writeFileSync(path.join(dir, 'assist-config.json'), JSON.stringify({ lanAuthEnabled: true, lanAccessToken: KEY }), { mode: 0o600 });
    const lan = await get(port, { 'X-LM-Client': 'web', 'X-Forwarded-Host': 'x', 'X-LM-LAN-Key': KEY });
    assert.equal(lan.status, 200);
    assert.equal(lan.body.data.via, 'lan-key');
    assert.ok(lan.body.data.token === tok().currentApiToken());
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
