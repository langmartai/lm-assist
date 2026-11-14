/**
 * Loopback-trust laundering: the web binds 0.0.0.0 and rewrites /_coreapi/* to
 * 127.0.0.1:<core>, so a LAN browser reaches Core FROM LOOPBACK — marked only by the
 * x-forwarded-host Next adds (possibly empty). Every loopback-only guard must refuse
 * that; relay-accepting guards must still accept a clean relayed loopback call.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ParsedRequest, RouteHandler } from '../routes/index';

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-guards-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  process.env.LM_MACHINE_ACCESS_FILE = path.join(dir, 'machine-access.json');
});
after(() => {
  delete process.env.LM_MACHINE_ACCESS_FILE;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const FORWARDED = { 'x-forwarded-host': '' };
const base = (over: Partial<ParsedRequest>): ParsedRequest =>
  ({ method: 'POST', path: '/', params: {}, query: {}, body: {}, headers: {}, clientIp: '127.0.0.1', ...over }) as ParsedRequest;

test('mcp-plugins write guard: forwarded → FORBIDDEN; relayed → FORBIDDEN (as its message promises)', async () => {
  const { handleConnectorSync, handlePluginEnable } = require('../routes/core/mcp-plugins.routes') as typeof import('../routes/core/mcp-plugins.routes');
  for (const headers of [FORWARDED, { 'x-forwarded-for': '10.0.1.42' }, { 'x-relay-source': 'hub' }]) {
    const r = await handleConnectorSync(base({ headers }));
    assert.equal(r.success, false, JSON.stringify(headers));
    assert.equal((r as { error: { code: string } }).error.code, 'FORBIDDEN');
    const e = await handlePluginEnable('helloworld', base({ headers }), {});
    assert.equal((e as { error: { code: string } }).error.code, 'FORBIDDEN');
  }
});

function machineAccessPut(): RouteHandler {
  const { createMachineAccessRoutes } = require('../routes/core/machine-access.routes') as typeof import('../routes/core/machine-access.routes');
  const r = createMachineAccessRoutes({} as never).find((h) => h.method === 'PUT' && h.pattern.test('/machine-access/machines/node-x'));
  assert.ok(r);
  return r as RouteHandler;
}
const PROFILE = { name: 'node-x', access: [{ type: 'ssh', host: '192.0.2.23', user: 'u' }] };

test('machine-access PUT: loopback + x-forwarded-host → FORBIDDEN', async () => {
  const h = machineAccessPut();
  const r = await h.handler(base({ method: 'PUT', path: '/machine-access/machines/node-x', params: { id: 'node-x' }, body: PROFILE, headers: FORWARDED }), {} as never);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('machine-access PUT: a clean RELAYED loopback call is still accepted (relay semantics unchanged)', async () => {
  const h = machineAccessPut();
  const r = await h.handler(base({ method: 'PUT', path: '/machine-access/machines/node-x', params: { id: 'node-x' }, body: PROFILE, headers: { 'x-relay-source': 'hub' } }), {} as never);
  assert.equal(r.success, true, JSON.stringify(r.error));
});

test('access-manager: forwarded loopback is cloud, never local/peer/owner', () => {
  const { AccessManager } = require('../data/access-manager') as typeof import('../data/access-manager');
  const am = new AccessManager({} as never);
  assert.deepEqual(am.resolvePrincipal(base({ headers: {} })), { type: 'local' });
  assert.deepEqual(am.resolvePrincipal(base({ headers: FORWARDED })), { type: 'cloud' });
  assert.deepEqual(
    am.resolvePrincipal(base({ headers: { 'x-relay-source': 'peer', 'x-lm-peer-node': 'n1', ...FORWARDED } })),
    { type: 'cloud' },
  );
  assert.deepEqual(am.resolvePrincipal(base({ headers: { 'x-relay-source': 'peer', 'x-lm-peer-node': 'n1' } })), { type: 'peer', node: 'n1' });
  // Sync-read resolver: a relayed call is the owner only when nothing else stood in between.
  assert.deepEqual(am.resolveSyncPrincipal(base({ headers: { 'x-relay-source': 'hub' } })), { type: 'owner' });
  assert.equal(am.resolveSyncPrincipal(base({ headers: { 'x-relay-source': 'hub', ...FORWARDED } })).type, 'cloud');
});

test('/auth/is-local: forwarded loopback is not local', async () => {
  const { createHealthRoutes } = require('../routes/core/health.routes') as typeof import('../routes/core/health.routes');
  const r = createHealthRoutes({} as never).find((h) => h.pattern.test('/auth/is-local'))!;
  const direct = await r.handler(base({ method: 'GET', path: '/auth/is-local' }), {} as never);
  assert.equal(direct.data.isLocal, true);
  const fwd = await r.handler(base({ method: 'GET', path: '/auth/is-local', headers: FORWARDED }), {} as never);
  assert.equal(fwd.data.isLocal, false);
  const lan = await r.handler(base({ method: 'GET', path: '/auth/is-local', clientIp: '198.51.100.7' }), {} as never);
  assert.equal(lan.data.isLocal, false);
});
