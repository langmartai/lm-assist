/** ui-pages: gateway URL derivation + manager guards (pure parts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveGatewayUrl } from '../ui-pages/gateway-client';
import { respawnable, pidAlive, type UiPageState } from '../ui-pages/manager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
