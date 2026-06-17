import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
// Hermetic: point all data-service storage at a temp dir. getDataDir() reads this env var
// lazily (at first getDataService() call), so setting it here keeps the test off the real data dir.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-routes-'));
import { createDataRoutes } from '../../routes/core/data.routes';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../../routes/index';

// Enable the singleton service for this suite.
function enable() { (getDataService() as any).enabledOverride = true; }
function find(method: string, path: string) {
  const routes = createDataRoutes({} as any);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (m) return { handler: r.handler, params: m.groups ?? {} };
  }
  throw new Error(`no route for ${method} ${path}`);
}
function call(method: string, path: string, opts: { body?: any; headers?: Record<string, string> } = {}) {
  const { handler, params } = find(method, path);
  const req: ParsedRequest = { method, path, params, query: {}, body: opts.body, headers: opts.headers ?? {}, clientIp: '127.0.0.1' };
  return handler(req, {} as any);
}

test('routes: create dataset (local) then put/get round-trip', async () => {
  enable();
  const id = `t_${Date.now()}`;
  const created = await call('POST', '/data/datasets', { body: { id, backend: 'cache', config: { kind: 'cache' } } });
  assert.equal(created.success, true);
  const put = await call('PUT', `/data/${id}/records`, { body: { id: 'a', fields: { name: 'z' } } });
  assert.equal(put.success, true);
  const got = await call('GET', `/data/${id}/records/a`, {});
  assert.equal(got.success, true);
  assert.equal(got.data.fields.name, 'z');
});

test('routes: cloud caller without key is forbidden', async () => {
  enable();
  const id = `t2_${Date.now()}`;
  await call('POST', '/data/datasets', { body: { id, backend: 'cache', config: { kind: 'cache' } } });
  await call('PUT', `/data/${id}/records`, { body: { id: 'a', fields: { n: 1 } } });
  const got = await call('GET', `/data/${id}/records/a`, { headers: { 'x-relay-source': 'hub', 'x-lm-user-id': 'u' } });
  assert.equal(got.success, false);
  assert.equal(got.error.code, 'KEY_REQUIRED');
});

test('routes: cloud create dataset is forbidden (local-only admin)', async () => {
  enable();
  const got = await call('POST', '/data/datasets',
    { body: { id: `nope_${Date.now()}`, backend: 'cache', config: { kind: 'cache' } },
      headers: { 'x-relay-source': 'hub' } });
  assert.equal(got.success, false);
});

test('routes: POST /data/datasets forwards syncMode to registry', async () => {
  enable();
  const id = `sync_${Date.now()}`;
  const created = await call('POST', '/data/datasets',
    { body: { id, backend: 'cache', config: { kind: 'cache' }, syncMode: 'full' } });
  assert.equal(created.success, true);
  assert.equal(created.data.dataset.syncMode, 'full');
});
