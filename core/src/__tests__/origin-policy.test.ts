/**
 * Core CORS: `Access-Control-Allow-Origin: *` is gone. An Origin is reflected only when
 * it is this machine's web UI (own hostname × webPort/http or httpsPort/https) or an
 * operator-listed extra — or on a scoped-token route (lmsc_ embeds, any origin).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import {
  resolveWebPorts,
  hostnameOf,
  isOwnHost,
  isAllowedWebOrigin,
  corsHeadersFor,
  CORS_ALLOW_HEADERS,
  __resetOriginPolicyCache,
} from '../auth/origin-policy';

const ENV_KEYS = ['WEB_PORT', 'ASSIST_WEB_PORT', 'LM_HTTPS_PORT', 'LM_ASSIST_PROD', 'LM_ASSIST_CORS_ORIGINS', 'LM_ASSIST_ALLOWED_HOSTS'];
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetOriginPolicyCache();
});

test('resolveWebPorts: WEB_PORT > ASSIST_WEB_PORT > dev default; https = LM_HTTPS_PORT or web+1', () => {
  // Compiled tests run from the repo checkout (not node_modules) → dev defaults.
  assert.deepEqual(resolveWebPorts(), { webPort: 3948, httpsPort: 3949 });
  process.env.LM_ASSIST_PROD = 'true';
  assert.deepEqual(resolveWebPorts(), { webPort: 3848, httpsPort: 3849 });
  delete process.env.LM_ASSIST_PROD;
  process.env.ASSIST_WEB_PORT = '4000';
  assert.deepEqual(resolveWebPorts(), { webPort: 4000, httpsPort: 4001 });
  process.env.WEB_PORT = '5000';
  assert.deepEqual(resolveWebPorts(), { webPort: 5000, httpsPort: 5001 });
  process.env.LM_HTTPS_PORT = '8443';
  assert.deepEqual(resolveWebPorts(), { webPort: 5000, httpsPort: 8443 });
});

test('hostnameOf strips port and brackets and lowercases', () => {
  assert.equal(hostnameOf('[::1]:3100'), '::1');
  assert.equal(hostnameOf('LOCALHOST:3948'), 'localhost');
  assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
  assert.equal(hostnameOf('::1'), '::1');
  assert.equal(hostnameOf(undefined), '');
});

test('isOwnHost: loopback names and the OS hostname yes; a foreign name no', () => {
  assert.equal(isOwnHost('localhost:3200'), true);
  assert.equal(isOwnHost('127.0.0.1:3200'), true);
  assert.equal(isOwnHost('[::1]:3200'), true);
  assert.equal(isOwnHost(`${os.hostname()}:3200`), true);
  assert.equal(isOwnHost('rebind.example:3200'), false);
  assert.equal(isOwnHost(''), false);
  process.env.LM_ASSIST_ALLOWED_HOSTS = 'desk.example, 203.0.113.5';
  __resetOriginPolicyCache();
  assert.equal(isOwnHost('desk.example:3200'), true);
  assert.equal(isOwnHost('203.0.113.5'), true);
});

function firstInterfaceIPv4(): string | null {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

test('allowed: own web origins on the dev ports', () => {
  for (const o of ['http://localhost:3948', 'http://127.0.0.1:3948', 'https://localhost:3949', 'http://[::1]:3948']) {
    assert.equal(isAllowedWebOrigin(o), true, o);
  }
  const ip = firstInterfaceIPv4();
  if (ip) assert.equal(isAllowedWebOrigin(`http://${ip}:3948`), true, 'own LAN IP origin');
});

test('rejected: wrong scheme/port pairs, foreign hosts, null and non-http schemes', () => {
  for (const o of ['https://localhost:3948', 'http://localhost:3949', 'http://localhost:3100', 'http://localhost',
    'https://evil.example', 'http://evil.example:3948', 'null', 'file://', 'chrome-extension://abc', '', 'not a url']) {
    assert.equal(isAllowedWebOrigin(o), false, o);
  }
});

test('extras: LM_ASSIST_CORS_ORIGINS (exact, normalised) and LM_ASSIST_ALLOWED_HOSTS', () => {
  process.env.LM_ASSIST_CORS_ORIGINS = 'https://desk.example:8443/, http://kiosk.example:9000';
  assert.equal(isAllowedWebOrigin('https://desk.example:8443'), true);
  assert.equal(isAllowedWebOrigin('http://kiosk.example:9000'), true);
  assert.equal(isAllowedWebOrigin('https://desk.example:8444'), false);
  process.env.LM_ASSIST_ALLOWED_HOSTS = 'myhost.lan';
  __resetOriginPolicyCache();
  assert.equal(isAllowedWebOrigin('http://myhost.lan:3948'), true);
  assert.equal(isAllowedWebOrigin('http://myhost.lan:3100'), false, 'still port-bound');
});

test('corsHeadersFor: foreign origin on POST /agent/execute (and its preflight) → Vary only', () => {
  const h = corsHeadersFor('POST', '/agent/execute', { origin: 'https://evil.example' });
  assert.deepEqual(h, { Vary: 'Origin' });
  const pre = corsHeadersFor('OPTIONS', '/agent/execute', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
  assert.deepEqual(pre, { Vary: 'Origin' });
});

test('corsHeadersFor: an allowed origin is reflected with the full allow set, never credentials', () => {
  const h = corsHeadersFor('GET', '/sessions?limit=5', { origin: 'http://localhost:3948' });
  assert.equal(h['Access-Control-Allow-Origin'], 'http://localhost:3948');
  assert.equal(h['Access-Control-Allow-Methods'], 'GET, POST, PUT, DELETE, OPTIONS');
  assert.equal(h['Access-Control-Allow-Headers'], CORS_ALLOW_HEADERS);
  assert.match(CORS_ALLOW_HEADERS, /X-LM-Client/);
  assert.match(CORS_ALLOW_HEADERS, /X-LM-LAN-Key/);
  assert.equal(h['Access-Control-Max-Age'], '600');
  assert.equal(h['Vary'], 'Origin');
  assert.equal(h['Access-Control-Allow-Credentials'], undefined);
});

test('corsHeadersFor: foreign-origin preflight to a scoped-token route IS reflected (lmsc_ embeds)', () => {
  const pre = corsHeadersFor('OPTIONS', '/claude-ai/conversations', {
    origin: 'https://embed.example',
    'access-control-request-method': 'POST',
  });
  assert.equal(pre['Access-Control-Allow-Origin'], 'https://embed.example');
  const real = corsHeadersFor('POST', '/claude-ai/conversations', { origin: 'https://embed.example' });
  assert.equal(real['Access-Control-Allow-Origin'], 'https://embed.example');
  // Same path, a method no scope allows → not reflected.
  const del = corsHeadersFor('OPTIONS', '/claude-ai/conversations', {
    origin: 'https://embed.example',
    'access-control-request-method': 'DELETE',
  });
  assert.equal(del['Access-Control-Allow-Origin'], undefined);
});

test('corsHeadersFor: no Origin → no ACAO', () => {
  const h = corsHeadersFor('GET', '/sessions', {});
  assert.equal(h['Access-Control-Allow-Origin'], undefined);
});
