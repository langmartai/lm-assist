// core/src/__tests__/data/owner-principal-routes.test.ts
// T3 route-level wiring test: the 4 sync-READ routes (GET /data/sync/manifest,
// GET /data/:ds/export, POST /data/:ds/export, POST /data/:ds/fetch) must resolve a
// hub-relayed caller as `owner` (via resolveSyncPrincipal) and let it read a shareable,
// non-sensitive, ACL-empty dataset with NO key. Every OTHER route must be UNCHANGED —
// still resolving a hub-relayed caller as keyless `cloud` (KEY_REQUIRED / FORBIDDEN).
// Mirrors the find/call harness in sync-routes.test.ts.
//
// clientIp is LOOPBACK (127.0.0.1) throughout for HUB_HEADERS requests: a GENUINE hub relay
// always arrives this way (api-relay-handler's makeLocalRequest dials hostname:'127.0.0.1') —
// see owner-principal-resolve.test.ts for the adversarial non-loopback-spoof unit proof, and
// the dedicated route-level spoof test near the bottom of this file for the same proof over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-owner-routes-'));

import { createDataRoutes } from '../../routes/core/data.routes';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../../routes/index';

function enable() { (getDataService() as any).enabledOverride = true; }

function find(method: string, urlPath: string) {
  const routes = createDataRoutes({} as any);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = urlPath.match(r.pattern);
    if (m) return { handler: r.handler, params: m.groups ?? {} };
  }
  throw new Error(`no route for ${method} ${urlPath}`);
}

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

const HUB_HEADERS = { 'x-relay-source': 'hub' };
const HUB_LOOPBACK = '127.0.0.1'; // the genuine relay path

async function makeShareableDataset(id: string) {
  enable();
  const svc = getDataService();
  await (svc as any).createDataset({ principal: { type: 'local' } }, {
    id, backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full',
    config: { kind: 'cache' }, acl: [],
  });
  await svc.put({ principal: { type: 'local' } }, id, {
    id: 'r1', version: 0, fields: { x: 1 }, createdAt: 't', updatedAt: 't',
  });
}

// ── 1. GET /data/sync/manifest — hub-relayed caller sees the shareable dataset ────────

test('GET /data/sync/manifest: a hub-relayed (owner) caller sees a shareable ACL-empty dataset', async () => {
  await makeShareableDataset('rt-manifest-ds');
  const res = await call('GET', '/data/sync/manifest', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(res.success, true);
  const ids = res.data.datasets.map((d: any) => d.id);
  assert.ok(ids.includes('rt-manifest-ds'), `expected rt-manifest-ds in manifest, got: ${JSON.stringify(ids)}`);
});

// ── 2. GET /data/:ds/export — hub-relayed caller can export with no key ───────────────

test('GET /data/:ds/export: a hub-relayed (owner) caller can export a shareable ACL-empty dataset with NO key', async () => {
  await makeShareableDataset('rt-get-export-ds');
  const res = await call('GET', '/data/rt-get-export-ds/export', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
  assert.equal(res.data.records.length, 1);
});

// ── 3. POST /data/:ds/export — same, via POST (key-in-body path) ─────────────────────

test('POST /data/:ds/export: a hub-relayed (owner) caller can export a shareable ACL-empty dataset with NO key in body', async () => {
  await makeShareableDataset('rt-post-export-ds');
  const res = await call('POST', '/data/rt-post-export-ds/export', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK, body: {} });
  assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
  assert.equal(res.data.records.length, 1);
});

// ── 4. POST /data/:ds/fetch — same, single-record fetch ──────────────────────────────

test('POST /data/:ds/fetch: a hub-relayed (owner) caller can fetch a single record with NO key in body', async () => {
  await makeShareableDataset('rt-fetch-ds');
  const res = await call('POST', '/data/rt-fetch-ds/fetch', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK, body: { id: 'r1' } });
  assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
  assert.equal(res.data.id, 'r1');
});

// ── Negative: the 4 routes still deny a hub-relayed caller on a SENSITIVE dataset ─────

test('the 4 sync routes still DENY a hub-relayed (owner) caller on a sensitive dataset', async () => {
  enable();
  const svc = getDataService();
  await (svc as any).createDataset({ principal: { type: 'local' } }, {
    id: 'rt-sensitive-ds', backend: 'cache', visibility: 'cross-node-readable', sensitive: true,
    syncMode: 'full', config: { kind: 'cache' }, acl: [],
  });
  await svc.put({ principal: { type: 'local' } }, 'rt-sensitive-ds', {
    id: 'r1', version: 0, fields: { secret: true }, createdAt: 't', updatedAt: 't',
  });

  const getExport = await call('GET', '/data/rt-sensitive-ds/export', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(getExport.success, false);
  const postExport = await call('POST', '/data/rt-sensitive-ds/export', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK, body: {} });
  assert.equal(postExport.success, false);
  const postFetch = await call('POST', '/data/rt-sensitive-ds/fetch', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK, body: { id: 'r1' } });
  assert.equal(postFetch.success, false);

  const manifest = await call('GET', '/data/sync/manifest', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(manifest.success, true);
  const ids = manifest.data.datasets.map((d: any) => d.id);
  assert.ok(!ids.includes('rt-sensitive-ds'), 'sensitive dataset must never appear in the owner-visible manifest');
});

// ── SECURITY: a direct non-loopback caller cannot forge owner trust over HTTP ─────────

test('SECURITY: a hub-relayed sync route from a NON-LOOPBACK clientIp does NOT get owner trust — KEY_REQUIRED, not success', async () => {
  await makeShareableDataset('rt-spoof-ds');
  // Same headers as every "owner" test above, but a non-loopback origin — simulating a direct
  // caller to this node's (0.0.0.0-bound) port who never actually went through the hub relay.
  const res = await call('GET', '/data/rt-spoof-ds/export', { headers: HUB_HEADERS, clientIp: '10.0.1.50' });
  assert.equal(res.success, false, 'a spoofed hub header from a non-loopback origin must be denied');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got: ${res.error?.code}`);
});

// ── CRITICAL scoping: every OTHER route stays on the general (cloud) model ────────────

test('GENERAL routes are UNCHANGED: GET /data/:ds/records/:id via a hub-relayed caller is still keyless-cloud (KEY_REQUIRED), not owner', async () => {
  await makeShareableDataset('rt-general-get-ds');
  // Same headers/clientIp (loopback — a genuine hub relay) that yield `owner` on the sync
  // routes above — but this is the GENERAL records route, which must still resolve via
  // resolvePrincipal (cloud), not resolveSyncPrincipal, regardless of loopback origin.
  const res = await call('GET', '/data/rt-general-get-ds/records/r1', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(res.success, false, 'general GET route must NOT grant owner-trust');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got: ${res.error?.code}`);
});

test('GENERAL routes are UNCHANGED: PUT /data/:ds/records (write) via a hub-relayed caller is still denied', async () => {
  await makeShareableDataset('rt-general-put-ds');
  const res = await call('PUT', '/data/rt-general-put-ds/records', {
    headers: HUB_HEADERS, clientIp: HUB_LOOPBACK,
    body: { id: 'r2', fields: { y: 2 } },
  });
  assert.equal(res.success, false, 'general PUT (write) route must NOT grant owner-trust');
});

test('GENERAL routes are UNCHANGED: POST /data/:ds/query via a hub-relayed caller is still keyless-cloud (KEY_REQUIRED)', async () => {
  await makeShareableDataset('rt-general-query-ds');
  const res = await call('POST', '/data/rt-general-query-ds/query', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK, body: {} });
  assert.equal(res.success, false, 'general POST query route must NOT grant owner-trust');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got: ${res.error?.code}`);
});

test('GENERAL routes are UNCHANGED: GET /data/catalog via a hub-relayed caller still reflects cloud (no owner-only datasets surfaced beyond ACL)', async () => {
  await makeShareableDataset('rt-general-catalog-ds'); // ACL-empty — cloud gets nothing via catalog either
  const res = await call('GET', '/data/catalog', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(res.success, true);
  assert.equal(res.data.you.principal, 'cloud', 'catalog must still report the caller as cloud, not owner');
});

test('GENERAL routes are UNCHANGED: POST /data/sync (trigger, local-only) via a hub-relayed caller is still FORBIDDEN', async () => {
  enable();
  const res = await call('POST', '/data/sync', { headers: HUB_HEADERS, clientIp: HUB_LOOPBACK });
  assert.equal(res.success, false);
  assert.equal(res.error?.code, 'FORBIDDEN');
});
