import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { classifyTerminatorRequest, startHttpsTerminator } from '../tls/https-terminator';
import { ensureTlsCert } from '../tls/cert-manager';

// ---------- pure routing ----------

test('classify: /_coreapi prefix strips to core-relative URLs', () => {
  assert.deepEqual(classifyTerminatorRequest('/_coreapi'), { target: 'core', url: '/' });
  assert.deepEqual(classifyTerminatorRequest('/_coreapi/'), { target: 'core', url: '/' });
  assert.deepEqual(classifyTerminatorRequest('/_coreapi/sessions?limit=5'), { target: 'core', url: '/sessions?limit=5' });
  assert.deepEqual(classifyTerminatorRequest('/_coreapi?x=1'), { target: 'core', url: '/?x=1' });
});

test('classify: core WS + ttyd paths pass through unmodified', () => {
  assert.deepEqual(classifyTerminatorRequest('/voice/stt/ws?token=t'), { target: 'core', url: '/voice/stt/ws?token=t' });
  assert.deepEqual(classifyTerminatorRequest('/voice/stt/ws'), { target: 'core', url: '/voice/stt/ws' });
  assert.deepEqual(classifyTerminatorRequest('/ttyd-proxy/7681/token'), { target: 'core', url: '/ttyd-proxy/7681/token' });
  assert.deepEqual(classifyTerminatorRequest('/ttyd/7681/'), { target: 'core', url: '/ttyd/7681/' });
});

test('classify: everything else (including lookalikes) goes to web', () => {
  for (const u of ['/', '/sessions', '/_coreapiX/health', '/_next/static/x.js', '/voice/stt/wsX', '/cowork']) {
    assert.deepEqual(classifyTerminatorRequest(u), { target: 'web' }, u);
  }
});

// ---------- integration over real TLS ----------

let tlsDir: string;
let webServer: http.Server;
let terminator: https.Server;
let termPort = 0;
// The test generates the cert itself, so clients PIN it as the CA — full TLS
// verification stays ON (also proves the generated cert + IP SAN verify cleanly).
let caPem = '';
const wsServers: WebSocketServer[] = [];
const wsClients: WebSocket[] = [];

function httpsGet(pathName: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: termPort, path: pathName, ca: caPem },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function wssFirstMessage(pathName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${termPort}${pathName}`, { ca: caPem });
    wsClients.push(ws);
    const to = setTimeout(() => reject(new Error(`ws timeout for ${pathName}`)), 5000);
    ws.on('message', (data) => { clearTimeout(to); resolve(String(data)); ws.close(); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

before(async () => {
  tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-term-test-'));
  // 1024-bit: fast keygen but still above OpenSSL's default security-level floor
  // (512 can be refused at handshake time with "key too weak").
  const { key, cert } = ensureTlsCert({ dir: tlsDir, keySize: 1024, hostnames: ['h'], ips: [] });
  caPem = cert;

  // Web stub: HTTP responder + an echo WS server (stands in for Next incl. HMR sockets).
  webServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`web:${req.url}`);
  });
  const webWss = new WebSocketServer({ server: webServer });
  wsServers.push(webWss);
  webWss.on('connection', (ws, req) => ws.send(`web-ws:${req.url}`));
  await new Promise<void>((r) => webServer.listen(0, '127.0.0.1', () => r()));
  const webPort = (webServer.address() as AddressInfo).port;

  // Core stubs: capture what the terminator dispatches in-process.
  const coreWss = new WebSocketServer({ noServer: true });
  wsServers.push(coreWss);
  terminator = await startHttpsTerminator({
    port: 0,
    host: '127.0.0.1',
    key,
    cert,
    webPort,
    coreRequest: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: 'core', url: req.url, proto: req.headers['x-forwarded-proto'] }));
    },
    coreUpgrade: (req, socket, head) => {
      coreWss.handleUpgrade(req, socket as any, head, (ws) => ws.send(`core-ws:${req.url}`));
    },
  });
  termPort = (terminator.address() as AddressInfo).port;
});

after(async () => {
  for (const ws of wsClients) { try { ws.terminate(); } catch { /* closed */ } }
  for (const s of wsServers) { try { s.close(); } catch { /* closed */ } }
  for (const srv of [terminator, webServer]) {
    if (!srv) continue;
    try { (srv as http.Server).closeAllConnections?.(); } catch { /* n/a */ }
    await new Promise<void>((r) => srv.close(() => r()));
  }
  try { fs.rmSync(tlsDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('terminator: plain paths proxy to the web server over TLS', async () => {
  const r = await httpsGet('/some/page?a=1');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'web:/some/page?a=1');
});

test('terminator: /_coreapi dispatches in-process to core with stripped URL + https proto', async () => {
  const r = await httpsGet('/_coreapi/health?deep=1');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { from: 'core', url: '/health?deep=1', proto: 'https' });
});

test('terminator: wss /voice/stt/ws upgrade reaches the core upgrade router', async () => {
  const msg = await wssFirstMessage('/voice/stt/ws?token=abc');
  assert.equal(msg, 'core-ws:/voice/stt/ws?token=abc');
});

test('terminator: non-core wss upgrades proxy through to the web server', async () => {
  const msg = await wssFirstMessage('/_next/webpack-hmr');
  assert.equal(msg, 'web-ws:/_next/webpack-hmr');
});
