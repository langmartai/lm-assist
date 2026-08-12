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
import { respawnable, pidAlive, rememberAddressing, gatewayUiRef, addressingFor, listReportableUis, type UiPageState } from '../ui-pages/manager';
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
// The seam here is global fetch, NOT the module namespace. Assigning
// `(gatewayClient as any).gatewayCall = stub` looks like it works and silently does not:
// the route imported the binding directly, so it keeps calling the real one — and this
// test was quietly firing live registrations at the production gateway and failing on
// whatever it answered. gatewayCall resolves `fetch` at call time, so stubbing the global
// is what actually intercepts it.
test('register reports the gateway-supplied origin, not a locally built URL', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uihub-'));
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  try {
    process.env.HOME = home;
    const cfgDir = path.join(home, '.lm-assist');
    fs.mkdirSync(cfgDir, { recursive: true });
    // Written under both suffixes so the test does not depend on whether the runner
    // classifies this checkout as a dev repo.
    for (const suffix of ['', '-dev']) {
      fs.writeFileSync(path.join(cfgDir, `hub${suffix}.json`), JSON.stringify({ hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-test' }));
      fs.writeFileSync(path.join(cfgDir, `gateway-id${suffix}`), 'gw4-test');
    }
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ method: init?.method, url: String(url) });
      return { ok: true, status: 200, json: async () => ({ ok: true, uiId: 'demo', uiKey: '3f9a2b1c-demo', origin: 'https://ui-3f9a2b1c-demo.langmart.ai/' }) };
    }) as any;

    const route = createUiPagesRoutes({} as any).find((r) => r.method === 'POST' && /register/.test(r.pattern.source))!;
    const req = { method: 'POST', path: '/ui-pages/register', params: {}, query: {}, body: { uiId: 'demo' }, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
    const r: any = await route.handler(req, {} as any);
    assert.equal(r.success, true);
    assert.equal(r.data.url, 'https://ui-3f9a2b1c-demo.langmart.ai/');
    assert.equal(r.data.uiKey, '3f9a2b1c-demo');
    assert.notEqual(r.data.url, 'https://ui-demo.langmart.ai/'); // what building it from the uiId would have produced
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.url, 'https://ui.langmart.ai/registry/uis');
  } finally {
    globalThis.fetch = realFetch;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
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

// `lmui host` writes ONE state file for a server covering every app, so the process list
// and the reportable-UI list stop being the same thing. Reporting the state file verbatim
// sent status for a UI called `_host`, which no registry row matches — the gateway 404'd,
// the reporter swallows 404 as "not registered", and NO page ever got a status row. That
// is what made every pane read offline on SG prod while it was serving fine.
test('host mode expands into one reportable UI per app, per-app mode passes through', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uihome-'));
  const realHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const apps = path.join(home, '.lmui', 'apps');
    fs.mkdirSync(apps, { recursive: true });
    fs.writeFileSync(path.join(home, '.lmui', 'dev-_host.json'), JSON.stringify({
      ...base, uiId: '_host', service: 'ui-_host', pid: process.pid, port: 5601, dir: apps,
    }));
    for (const [id, service] of [['alpha', 'ui-alpha'], ['beta', undefined]] as const) {
      fs.mkdirSync(path.join(apps, id));
      fs.writeFileSync(path.join(apps, id, 'lmui.config.json'), JSON.stringify({ uiId: id, ...(service ? { service } : {}) }));
    }
    fs.mkdirSync(path.join(apps, 'not-an-app')); // no config — must not be reported

    const got = listReportableUis().sort((a, b) => a.uiId.localeCompare(b.uiId));
    assert.deepEqual(got.map((s) => s.uiId), ['alpha', 'beta'], 'apps replace the _host entry');
    assert.equal(got.find((s) => s.uiId === 'beta')!.service, 'ui-beta', 'service defaults to ui-<uiId>');
    // The probe must hit the app's own path on the SHARED host process/port.
    assert.deepEqual(got.map((s) => s.port), [5601, 5601]);
    assert.equal(got[0]!.dir, path.join(apps, 'alpha'), 'dir narrows to the app, not the root');
    assert.ok(!got.some((s) => s.uiId === '_host'), 'the unmatched _host pseudo-UI is never reported');

    // A per-app state file is a UI and a process at once — unchanged.
    fs.rmSync(path.join(home, '.lmui', 'dev-_host.json'));
    fs.writeFileSync(path.join(home, '.lmui', 'dev-solo.json'), JSON.stringify({
      ...base, uiId: 'solo', service: 'ui-solo', pid: process.pid, port: 5602, dir: apps,
    }));
    assert.deepEqual(listReportableUis().map((s) => s.uiId), ['solo']);
  } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
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

// ── managed sync: placement + per-UI failure isolation ────────────────────────────────
// Same seam as the register test above: stub global fetch, never the module namespace.

/** Lay out an apps root of managed configs + the hub config syncManagedUis needs. */
function managedFixture(home: string, apps: Array<Record<string, unknown>>): string {
  const cfgDir = path.join(home, '.lm-assist');
  fs.mkdirSync(cfgDir, { recursive: true });
  for (const suffix of ['', '-dev']) {
    fs.writeFileSync(path.join(cfgDir, `hub${suffix}.json`), JSON.stringify({ hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-test' }));
    fs.writeFileSync(path.join(cfgDir, `gateway-id${suffix}`), 'gw4-test');
  }
  const appsRoot = path.join(home, '.lmui', 'apps');
  for (const cfg of apps) {
    const d = path.join(appsRoot, String(cfg.uiId));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'lmui.config.json'), JSON.stringify(cfg));
  }
  return appsRoot;
}

test('managed sync forwards category + sortOrder so the shell can group and order panes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uisync-'));
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  const bodies: any[] = [];
  try {
    process.env.HOME = home;
    const appsRoot = managedFixture(home, [
      { uiId: 'p-one', name: 'One', scope: 'lm-assist', managed: true, category: 'Node', sortOrder: 20 },
      { uiId: 'p-two', name: 'Two', scope: 'lm-assist', managed: true },            // no placement declared
    ]);
    process.env.LMUI_APPS_DIR = appsRoot;
    globalThis.fetch = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ uiId: 'x', uiKey: 'k-x', origin: 'https://x/' }) };
    }) as any;

    const { syncManagedUis } = await import('../ui-pages/reporter');
    const n = await syncManagedUis();
    assert.equal(n, 2);
    const one = bodies.find((b) => b.uiId === 'p-one');
    assert.equal(one.category, 'Node');
    assert.equal(one.sortOrder, 20);
    // Undeclared placement is OMITTED, not sent as null/undefined — the registry keeps its default.
    const two = bodies.find((b) => b.uiId === 'p-two');
    assert.ok(!('category' in two), 'category must be omitted when undeclared');
    assert.ok(!('sortOrder' in two), 'sortOrder must be omitted when undeclared');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LMUI_APPS_DIR;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('managed sync: one failing UI does not skip the rest (it used to break the loop)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uisync-'));
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    process.env.HOME = home;
    const appsRoot = managedFixture(home, [
      { uiId: 'a-first', name: 'A', managed: true },
      { uiId: 'b-boom', name: 'B', managed: true },   // this one throws
      { uiId: 'c-last', name: 'C', managed: true },   // must STILL be asserted
    ]);
    process.env.LMUI_APPS_DIR = appsRoot;
    globalThis.fetch = (async (_u: any, init: any) => {
      const id = JSON.parse(init.body).uiId;
      seen.push(id);
      if (id === 'b-boom') throw new Error('fetch failed');
      return { ok: true, status: 200, json: async () => ({ uiId: id, uiKey: `k-${id}`, origin: 'https://x/' }) };
    }) as any;

    const { syncManagedUis } = await import('../ui-pages/reporter');
    const n = await syncManagedUis();
    assert.deepEqual(seen, ['a-first', 'b-boom', 'c-last'], 'every UI is attempted');
    assert.equal(n, 2, 'the two healthy UIs are asserted despite the failure between them');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LMUI_APPS_DIR;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('managed sync aborts only after repeated gateway failures (hub really is down)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uisync-'));
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  let attempts = 0;
  try {
    process.env.HOME = home;
    const appsRoot = managedFixture(home, ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => ({ uiId: `p-${s}`, name: s, managed: true })));
    process.env.LMUI_APPS_DIR = appsRoot;
    globalThis.fetch = (async () => { attempts++; throw new Error('fetch failed'); }) as any;

    const { syncManagedUis } = await import('../ui-pages/reporter');
    const n = await syncManagedUis();
    assert.equal(n, 0);
    assert.equal(attempts, 3, 'gives up after 3 consecutive failures instead of hammering all six');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LMUI_APPS_DIR;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
