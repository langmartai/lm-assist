// core/src/__tests__/data/sync-keyinbody.test.ts
// Verifies that POST /data/:dataset/export and POST /data/:dataset/fetch carry the
// access key in the request BODY (not a header) so hub-proxy forwarding works.
// The hub proxy forwards POST bodies but strips custom headers like x-lm-access-key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Isolate data storage for this test module
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-keyinbody-'));

import { createDataRoutes } from '../../routes/core/data.routes';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../../routes/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  opts: { body?: any; headers?: Record<string, string> } = {},
) {
  const { handler, params } = find(method, urlPath);
  const req: ParsedRequest = {
    method,
    path: urlPath,
    params,
    query: {},
    body: opts.body,
    headers: opts.headers ?? {},
    clientIp: '127.0.0.1',
  };
  return handler(req, {} as any);
}

// Cloud request simulated by the hub proxy (has x-relay-source but NOT x-lm-access-key header)
const CLOUD_HEADERS = { 'x-relay-source': 'hub', 'x-lm-user-id': 'u1' };

// ── Setup — dataset + record ───────────────────────────────────────────────────

let DS_ID: string;
let RECORD_ID: string;
let MINTED_KEY: string;

// Runs synchronously before tests via top-level await on Node ≥ 18 test runner.
// We use a setup test that runs first so state is available to subsequent tests.
test('setup: create cross-node-readable dataset and local record', async () => {
  enable();

  DS_ID = `keyinbody_${Date.now()}`;
  RECORD_ID = 'rec1';

  // Create dataset with cloud-read ACL and syncMode full (mirrors a cross-node-readable dataset)
  const created = await call('POST', '/data/datasets', {
    body: {
      id: DS_ID,
      backend: 'cache',
      config: { kind: 'cache' },
      visibility: 'cross-node-readable',
      syncMode: 'full',
      acl: [{ principal: 'cloud', actions: ['read'] }],
    },
  });
  assert.equal(created.success, true, `dataset creation failed: ${JSON.stringify(created)}`);

  // Put a record locally (local principal — always permitted)
  const put = await call('PUT', `/data/${DS_ID}/records`, {
    body: { id: RECORD_ID, fields: { value: 42, token: 'secret-value' } },
  });
  assert.equal(put.success, true, `record put failed: ${JSON.stringify(put)}`);

  // Mint a scoped key for cloud read access (what HubPeerClient does via /data/access)
  const minted = await getDataService().requestAccess(
    { type: 'cloud', userId: 'u1' },
    { grants: [{ dataset: DS_ID, actions: ['read'] }] },
  );
  assert.equal(minted.ok, true, `requestAccess failed: ${JSON.stringify(minted)}`);
  MINTED_KEY = (minted as any).value.key;
  assert.ok(typeof MINTED_KEY === 'string' && MINTED_KEY.length > 0, 'minted key must be non-empty');
});

// ── Test 1: POST /export without key → KEY_REQUIRED ──────────────────────────

test('POST /data/:ds/export with no key as cloud → KEY_REQUIRED', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/export`, {
    body: {},                  // no key field
    headers: CLOUD_HEADERS,   // cloud principal (hub-relayed)
  });

  assert.equal(res.success, false, 'expected failure for keyless cloud export');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got ${res.error?.code}`);
});

// ── Test 2: POST /export with minted key → success + records returned ─────────

test('POST /data/:ds/export with minted key as cloud → records returned (redacted)', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/export`, {
    body: { key: MINTED_KEY },   // key in body — the hub-proxy-safe path
    headers: CLOUD_HEADERS,
  });

  assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data?.records), 'data.records must be an array');
  assert.equal(res.data.records.length, 1, 'should export exactly 1 record');

  const rec = res.data.records[0];
  assert.equal(rec.id, RECORD_ID, 'record id must match');
  assert.equal(rec.fields.value, 42, 'non-secret field must be preserved');
  // Redaction: "token" matches the secret-key regex → must be redacted
  assert.equal(rec.fields.token, '«redacted»', `token field must be redacted, got ${rec.fields.token}`);
});

// ── Test 3: POST /fetch without key → KEY_REQUIRED ───────────────────────────

test('POST /data/:ds/fetch with no key as cloud → KEY_REQUIRED', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/fetch`, {
    body: { id: RECORD_ID },   // no key field
    headers: CLOUD_HEADERS,
  });

  assert.equal(res.success, false, 'expected failure for keyless cloud fetch');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got ${res.error?.code}`);
});

// ── Test 4: POST /fetch with minted key → record returned (redacted) ──────────

test('POST /data/:ds/fetch with minted key as cloud → record returned (redacted)', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/fetch`, {
    body: { id: RECORD_ID, key: MINTED_KEY },   // key in body
    headers: CLOUD_HEADERS,
  });

  assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
  // /fetch wraps the record directly in data (not data.records)
  const rec = res.data;
  assert.ok(rec && typeof rec === 'object', 'response data must be the record');
  assert.equal(rec.id, RECORD_ID, 'record id must match');
  assert.equal(rec.fields.value, 42, 'non-secret field must be preserved');
  assert.equal(rec.fields.token, '«redacted»', `token field must be redacted, got ${rec.fields.token}`);
});

// ── Test 5: GET /export (header-key) still works (existing callers unaffected) ──

test('GET /data/:ds/export with key in header still works', async () => {
  enable();

  const res = await call('GET', `/data/${DS_ID}/export`, {
    headers: { ...CLOUD_HEADERS, 'x-lm-access-key': MINTED_KEY },
  });

  assert.equal(res.success, true, `GET export with header key should still work: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data?.records), 'data.records must be an array');
  assert.equal(res.data.records.length, 1, 'should export exactly 1 record');
});
