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

// Hub-relayed request simulated by the hub proxy (has x-relay-source but NOT x-lm-access-key
// header). On the 4 sync-READ routes this now resolves to `owner` (T3); on every other route
// it still resolves to `cloud` (see owner-principal-scoping.test.ts for that boundary proof).
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

// ── Test 1: POST /export, hub-relayed + no key → now SUCCEEDS as `owner` (T3) ───
//
// T3 (fix/hub-sync-owner-principal) intentionally changes this: POST /data/:ds/export is
// one of the 4 sync-READ routes that now resolve a hub-relayed caller (CLOUD_HEADERS carries
// x-relay-source:hub) via resolveSyncPrincipal → `owner`, not the general resolvePrincipal →
// `cloud`. An `owner` may read a shareable, non-sensitive dataset with NO key (see
// owner-principal-*.test.ts for the full authz proof). This dataset is exactly that shape
// (cross-node-readable, non-sensitive), so the keyless hub-relayed call now succeeds — this
// is the gap T3 closes, not a regression. The "cloud still needs a key" invariant is proven
// below by a genuinely non-owned request (no x-relay-source at all).
test('POST /data/:ds/export: hub-relayed + no key now succeeds as owner (T3 — closes the sync gap)', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/export`, {
    body: {},                  // no key field
    headers: CLOUD_HEADERS,   // hub-relayed → resolves to `owner` on this sync route
  });

  assert.equal(res.success, true, `expected success (owner trust), got: ${JSON.stringify(res)}`);
  assert.equal(res.data.records.length, 1, 'should export exactly 1 record');
});

test('POST /data/:ds/export: a NON-owned cloud caller (no x-relay-source, non-loopback) still needs a key → KEY_REQUIRED', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/export`, {
    body: {},                    // no key field
    headers: {},                 // NOT hub-relayed — resolves to plain `cloud`, not `owner`
    clientIp: '10.0.1.42',       // non-loopback — a bare '127.0.0.1' default would hit the LOCAL
                                  // fast-path instead of cloud, which is not what this test checks
  });

  assert.equal(res.success, false, 'expected failure for a non-owned, keyless caller');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got ${res.error?.code}`);
});

// ── Test 2: POST /export with minted key → success + records returned ─────────
// NOTE: uses a genuinely NON-owned request (no x-relay-source, non-loopback clientIp) so this
// test actually exercises the minted-key path, independent of the T3 owner-trust path above
// (a hub-relayed CLOUD_HEADERS request would now succeed via `owner` even without a key, which
// would make this test pass for the wrong reason).

test('POST /data/:ds/export with minted key (non-owned caller) → records returned (redacted)', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/export`, {
    body: { key: MINTED_KEY },   // key in body — the hub-proxy-safe path
    headers: {},                 // NOT hub-relayed — proves the KEY, not owner-trust, grants access
    clientIp: '10.0.1.42',
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

// ── Test 3: POST /fetch, hub-relayed + no key → now SUCCEEDS as `owner` (T3) ────
// Same T3 rationale as the export test above — POST /data/:ds/fetch is one of the 4
// sync-READ routes that now trust a hub-relayed caller as `owner`.

test('POST /data/:ds/fetch: hub-relayed + no key now succeeds as owner (T3 — closes the sync gap)', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/fetch`, {
    body: { id: RECORD_ID },   // no key field
    headers: CLOUD_HEADERS,   // hub-relayed → resolves to `owner` on this sync route
  });

  assert.equal(res.success, true, `expected success (owner trust), got: ${JSON.stringify(res)}`);
  assert.equal(res.data.id, RECORD_ID, 'record id must match');
});

test('POST /data/:ds/fetch: a NON-owned cloud caller (no x-relay-source, non-loopback) still needs a key → KEY_REQUIRED', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/fetch`, {
    body: { id: RECORD_ID },     // no key field
    headers: {},                  // NOT hub-relayed — resolves to plain `cloud`, not `owner`
    clientIp: '10.0.1.42',        // non-loopback, see the export test above for rationale
  });

  assert.equal(res.success, false, 'expected failure for a non-owned, keyless caller');
  assert.equal(res.error?.code, 'KEY_REQUIRED', `expected KEY_REQUIRED, got ${res.error?.code}`);
});

// ── Test 4: POST /fetch with minted key → record returned (redacted) ──────────
// Same non-owned-caller rationale as Test 2 above.

test('POST /data/:ds/fetch with minted key (non-owned caller) → record returned (redacted)', async () => {
  enable();

  const res = await call('POST', `/data/${DS_ID}/fetch`, {
    body: { id: RECORD_ID, key: MINTED_KEY },   // key in body
    headers: {},                                 // NOT hub-relayed — proves the KEY grants access
    clientIp: '10.0.1.42',
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
// Same non-owned-caller rationale — GET /data/:ds/export IS one of the 4 sync routes too, so a
// hub-relayed GET would also now succeed via `owner`; using a non-owned caller here specifically
// proves the header-key mechanism (not owner-trust) is what grants access.

test('GET /data/:ds/export with key in header still works (non-owned caller)', async () => {
  enable();

  const res = await call('GET', `/data/${DS_ID}/export`, {
    headers: { 'x-lm-access-key': MINTED_KEY }, // NOT hub-relayed
    clientIp: '10.0.1.42',
  });

  assert.equal(res.success, true, `GET export with header key should still work: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.data?.records), 'data.records must be an array');
  assert.equal(res.data.records.length, 1, 'should export exactly 1 record');
});

// ── Test 6: GET /export, hub-relayed + no key → now succeeds as owner (T3) ──────
// Completes the picture for GET (the other 3 routes are covered above) — proves GET
// /data/:ds/export is correctly wired to resolveSyncPrincipal too.

test('GET /data/:ds/export: hub-relayed + no key now succeeds as owner (T3 — closes the sync gap)', async () => {
  enable();

  const res = await call('GET', `/data/${DS_ID}/export`, {
    headers: CLOUD_HEADERS,
  });

  assert.equal(res.success, true, `expected success (owner trust), got: ${JSON.stringify(res)}`);
  assert.equal(res.data.records.length, 1, 'should export exactly 1 record');
});
