/** ui-pages: gateway URL derivation + manager guards (pure parts) + gateway addressing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ~/.lmui is written by the addressing tests below — keep it out of the real home dir.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'uipages-home-'));

import { deriveGatewayUrl, uiIdError, MAX_UI_ID_LENGTH } from '../ui-pages/gateway-client';
import * as gatewayClient from '../ui-pages/gateway-client';
import * as hubConfig from '../hub-client/hub-config';
import { respawnable, pidAlive, rememberAddressing, gatewayUiRef, addressingFor, type UiPageState } from '../ui-pages/manager';
import { createUiPagesRoutes } from '../routes/core/ui-pages.routes';
import type { ParsedRequest } from '../routes/index';

test('deriveGatewayUrl maps assist-api.<domain> hubs to ui.<domain>', () => {
  assert.equal(deriveGatewayUrl('wss://assist-api.xeenhub.com'), 'https://ui.xeenhub.com');
  assert.equal(deriveGatewayUrl('wss://assist-api.langmart.ai'), 'https://ui.langmart.ai');
});

test('deriveGatewayUrl maps localhost hubs to the local gateway port', () => {
  assert.equal(deriveGatewayUrl('ws://localhost:8086'), 'http://127.0.0.1:8087');
});

test('deriveGatewayUrl override wins verbatim (trailing slash trimmed)', () => {
  assert.equal(deriveGatewayUrl('wss://assist-api.xeenhub.com', 'https://gw.example.com/'), 'https://gw.example.com');
});

test('deriveGatewayUrl returns null on a garbage hub URL, not a throw', () => {
  assert.equal(deriveGatewayUrl('not a url'), null);
});

const base: UiPageState = {
  uiId: 't', service: 'ui-t', pid: process.pid, port: 5601,
  dir: '/nonexistent-dir-xyz', sdkPath: '/nonexistent-sdk', log: '/tmp/x.log', startedAt: '',
};

test('pidAlive: own pid alive, absurd pid dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
});

test('respawnable refuses a vanished app dir', () => {
  const r = respawnable(base);
  assert.equal(r.ok, false);
  assert.ok(r.reason!.includes('app dir gone'));
});

test('uiIdError enforces the shape and the length the origin leaves for an id', () => {
  assert.equal(uiIdError('assist-manage'), null);
  assert.equal(uiIdError('a'.repeat(MAX_UI_ID_LENGTH)), null);
  const tooLong = uiIdError('a'.repeat(MAX_UI_ID_LENGTH + 1));
  assert.ok(tooLong && tooLong.includes(String(MAX_UI_ID_LENGTH)), tooLong || 'expected a length complaint');
  assert.ok(uiIdError('Not-Lowercase'));
  assert.ok(uiIdError(''));
});

test('addressing round-trips and gatewayUiRef prefers the uiKey', () => {
  assert.equal(gatewayUiRef('unknown-ui'), 'unknown-ui'); // never registered — bare id still addresses it
  rememberAddressing('demo', { uiKey: '3f9a2b1c-demo', origin: 'https://ui-3f9a2b1c-demo.langmart.ai/' });
  assert.equal(gatewayUiRef('demo'), '3f9a2b1c-demo');
  assert.equal(addressingFor('demo').origin, 'https://ui-3f9a2b1c-demo.langmart.ai/');
});

// The URL shape is the gateway's: it already moved from ui-<uiId> to ui-<ownerSlug>-<uiId>,
// so any URL this side builds is a guess that breaks on the next change.
test('register reports the gateway-supplied origin, not a locally built URL', async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const realCall = gatewayClient.gatewayCall;
  const realHub = hubConfig.getHubConfig;
  (gatewayClient as any).gatewayCall = async (method: string, pathName: string) => {
    calls.push({ method, path: pathName });
    return { status: 200, data: { ok: true, uiId: 'demo', uiKey: '3f9a2b1c-demo', origin: 'https://ui-3f9a2b1c-demo.langmart.ai/' } };
  };
  (hubConfig as any).getHubConfig = () => ({ gatewayId: 'gw-test', apiKey: 'sk-test', hubUrl: 'wss://assist-api.langmart.ai' });
  try {
    const route = createUiPagesRoutes({} as any).find((r) => r.method === 'POST' && /register/.test(r.pattern.source))!;
    const req = { method: 'POST', path: '/ui-pages/register', params: {}, query: {}, body: { uiId: 'demo' }, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
    const r: any = await route.handler(req, {} as any);
    assert.equal(r.success, true);
    assert.equal(r.data.url, 'https://ui-3f9a2b1c-demo.langmart.ai/');
    assert.equal(r.data.uiKey, '3f9a2b1c-demo');
    assert.notEqual(r.data.url, 'https://ui-demo.langmart.ai/'); // what building it from the uiId would have produced
    assert.equal(calls.length, 1);
  } finally {
    (gatewayClient as any).gatewayCall = realCall;
    (hubConfig as any).getHubConfig = realHub;
  }
});

test('register rejects an over-long uiId locally, without asking the gateway', async () => {
  const realCall = gatewayClient.gatewayCall;
  let called = 0;
  (gatewayClient as any).gatewayCall = async () => { called++; return { status: 200, data: {} }; };
  try {
    const route = createUiPagesRoutes({} as any).find((r) => r.method === 'POST' && /register/.test(r.pattern.source))!;
    const req = { method: 'POST', path: '/ui-pages/register', params: {}, query: {}, body: { uiId: 'a'.repeat(MAX_UI_ID_LENGTH + 1) }, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
    const r: any = await route.handler(req, {} as any);
    assert.equal(r.success, false);
    assert.ok(r.error.includes(String(MAX_UI_ID_LENGTH)), r.error);
    assert.equal(called, 0);
  } finally {
    (gatewayClient as any).gatewayCall = realCall;
  }
});

test('respawnable refuses missing lmui.config.json / sdk, accepts a complete layout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uipages-'));
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'uisdk-'));
  try {
    assert.equal(respawnable({ ...base, dir, sdkPath: sdk }).ok, false); // no config
    fs.writeFileSync(path.join(dir, 'lmui.config.json'), '{}');
    assert.equal(respawnable({ ...base, dir, sdkPath: sdk }).ok, false); // no sdk file
    fs.writeFileSync(path.join(sdk, 'lmui.js'), '// sdk');
    assert.equal(respawnable({ ...base, dir, sdkPath: sdk }).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});
