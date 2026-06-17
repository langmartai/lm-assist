// core/src/__tests__/data/sync-routes.test.ts
// Route-level tests for POST /data/sync and GET /data/sync/status (M5 Task 7).
// Hermetic: uses a temp data dir; no live hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Must be set before any module that calls getDataDir() is imported.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sync-routes-'));

import { createDataRoutes } from '../../routes/core/data.routes';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../../routes/index';

// Enable the data service singleton for this test suite.
function enable() { (getDataService() as any).enabledOverride = true; }

// Utility to locate a route handler by method + path string.
function find(method: string, urlPath: string) {
  const routes = createDataRoutes({} as any);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = urlPath.match(r.pattern);
    if (m) return { handler: r.handler, params: m.groups ?? {} };
  }
  throw new Error(`no route for ${method} ${urlPath}`);
}

// Build a ParsedRequest and invoke the handler.
function call(
  method: string,
  urlPath: string,
  opts: { body?: any; headers?: Record<string, string>; clientIp?: string } = {},
) {
  const { handler, params } = find(method, urlPath);
  const req: ParsedRequest = {
    method,
    path: urlPath,
    params,
    query: {},
    body: opts.body,
    headers: opts.headers ?? {},
    clientIp: opts.clientIp ?? '127.0.0.1',
  };
  return handler(req, {} as any);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('GET /data/sync/manifest (local) returns success with datasets array and node', async () => {
  enable();
  const res = await call('GET', '/data/sync/manifest');
  assert.equal(res.success, true, `expected success=true, got: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data.datasets), 'data.datasets should be an array');
  assert.ok(typeof res.data.node === 'string', 'data.node should be a string');
});

test('POST /data/sync as CLOUD caller returns FORBIDDEN', async () => {
  enable();
  // x-relay-source: hub marks the request as coming through the hub relay (cloud)
  const res = await call('POST', '/data/sync', {
    headers: { 'x-relay-source': 'hub', 'x-lm-user-id': 'u1' },
  });
  assert.equal(res.success, false, 'should fail for cloud caller');
  assert.equal(res.error?.code, 'FORBIDDEN', `expected FORBIDDEN, got: ${res.error?.code}`);
});

test('POST /data/sync as LOCAL caller returns success with SyncStatus shape', async () => {
  enable();
  // Local call (127.0.0.1, no relay headers). The real HubPeerClient.listPeers()
  // will throw (no hub configured) — that error is captured inside reconcile()
  // as an entry in errors[]. We assert success=true and the status shape, not zero errors.
  const res = await call('POST', '/data/sync', { clientIp: '127.0.0.1' });
  assert.equal(res.success, true, `expected success=true, got: ${JSON.stringify(res)}`);
  const d = res.data;
  assert.ok('lastRun' in d, 'status should have lastRun field');
  assert.ok(Array.isArray(d.errors), 'status.errors should be an array');
});

test('GET /data/sync/status (local) returns success with SyncStatus shape', async () => {
  enable();
  const res = await call('GET', '/data/sync/status');
  assert.equal(res.success, true, `expected success=true, got: ${JSON.stringify(res)}`);
  const d = res.data;
  assert.ok('lastRun' in d, 'status should have lastRun field');
  assert.ok(Array.isArray(d.errors), 'status.errors should be an array');
});
