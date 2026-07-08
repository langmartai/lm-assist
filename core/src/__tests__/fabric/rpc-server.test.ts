import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';
import { createRpcServer, type DispatchResult } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';

before(async () => { await initEnvelopeCodec(); });

const req = (id: string, reqId = id): Envelope => ({
  kind: 'req', id,
  headers: { method: 'GET', path: '/health', reqId, cls: 'rpc' },
  payload: encodeBody({ body: null, query: {} }),
});

test('dispatches a req and replies with a res carrying the route data', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: { ok: true } } as DispatchResult; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => true,
    peerNodeOf: () => 'gw4-peer',
  });
  let out: Envelope | null = null;
  handler(req('c1'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(out!.headers.status, 200);
  assert.deepEqual(decodeBody(out!.payload), { ok: true });
  assert.equal(calls, 1);
});

test('a retried req (same reqId) replays the cached res without re-dispatch', async () => {
  let calls = 0;
  const idem = new IdempotencyCache();
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 201, data: { n: calls } }; },
    idempotency: idem, rpcEnabled: () => true, peerNodeOf: () => 'gw4-peer',
  });
  const collect = () => { let o: Envelope | null = null; handler(req('call-A', 'REQ-1'), (e) => { o = e; }); return () => o; };
  const g1 = collect(); await new Promise((r) => setImmediate(r));
  const g2 = collect(); await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);                       // second was served from cache
  assert.deepEqual(decodeBody(g1()!.payload), { n: 1 });
  assert.deepEqual(decodeBody(g2()!.payload), { n: 1 });
});

test('kill-switch off → 503 rpc_disabled, no dispatch', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(), rpcEnabled: () => false, peerNodeOf: () => 'p',
  });
  let out: Envelope | null = null;
  handler(req('c9'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
  assert.equal(calls, 0);
});

test('concurrent duplicate reqId while dispatch is slow: dispatch runs exactly once, both replies carry the same res under their own correlation id', async () => {
  let calls = 0;
  let resolveDispatch!: (v: DispatchResult) => void;
  const slow = new Promise<DispatchResult>((r) => { resolveDispatch = r; });
  const handler = createRpcServer({
    dispatch: async () => { calls++; return slow; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => true,
    peerNodeOf: () => 'gw4-peer',
  });
  let out1: Envelope | null = null;
  let out2: Envelope | null = null;
  // Two envelopes, same reqId (sender retry semantics — fresh wire id, stable reqId),
  // fired back-to-back while the original is still awaiting a slow dispatch.
  handler(req('call-A', 'REQ-DUP'), (e) => { out1 = e; });
  handler(req('call-B', 'REQ-DUP'), (e) => { out2 = e; });
  // The retry must NOT have triggered a second dispatch call even before the slow
  // one resolves — this is the exactly-once assertion (RED pre-fix: calls === 2).
  assert.equal(calls, 1);
  resolveDispatch({ status: 201, data: { n: 1 } });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(out1!.id, 'call-A');
  assert.equal(out2!.id, 'call-B');
  assert.equal(out1!.headers.status, out2!.headers.status);
  assert.deepEqual(decodeBody(out1!.payload), decodeBody(out2!.payload));
});

test('a large data payload becomes a bulk res (offload invoked)', async () => {
  let offloaded = 0;
  const handler = createRpcServer({
    dispatch: async () => ({ status: 200, data: { big: 'x'.repeat(50) } }),
    idempotency: new IdempotencyCache(), rpcEnabled: () => true, peerNodeOf: () => 'gw4-peer',
    offloadThreshold: 10,                        // tiny threshold forces offload
    offload: async () => { offloaded++; return { handle: { transferId: 't1', size: 999, sha256: 'ab', sink: 'fabric-bulk/t1.bin' } }; },
  });
  let out: Envelope | null = null;
  handler(req('cb'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(offloaded, 1);
  assert.equal(out!.headers.bulk, true);
  assert.deepEqual((decodeBody(out!.payload) as { transferId: string }).transferId, 't1');
});

// ---------------------------------------------------------------------------
// Task 12 review fix (Important #2, rpc-server half): unlike the dispatch()
// try/catch above, the offload() call used to be unguarded — a throw (e.g.
// offloadResponse now failing loudly on a non-'done' job, per bulk-offload
// fix) would propagate out of the handler's async IIFE unhandled: no reply
// ever sent, AND the idempotency entry begin() claimed above left in-flight
// forever, hanging any concurrent same-reqId retry.
// ---------------------------------------------------------------------------
test('offload failure replies a 502 error res (not a false-success 200/bulk) and settles idempotency so an in-flight concurrent retry does not hang', async () => {
  let offloadCalls = 0;
  let rejectOffload!: (e: Error) => void;
  const slow = new Promise<never>((_res, rej) => { rejectOffload = rej; });
  const handler = createRpcServer({
    dispatch: async () => ({ status: 200, data: { big: 'x'.repeat(50) } }),
    idempotency: new IdempotencyCache(), rpcEnabled: () => true, peerNodeOf: () => 'gw4-peer',
    offloadThreshold: 10,
    offload: async () => { offloadCalls++; return slow; },
  });
  let out1: Envelope | null = null;
  let out2: Envelope | null = null;
  // Two envelopes, same reqId, fired back-to-back while the original is still
  // awaiting a slow (never-resolving-until-we-reject-it) offload — mirrors
  // the "concurrent duplicate reqId" dispatch test above, but for the offload
  // stage instead of the dispatch stage.
  handler(req('call-A', 'REQ-OFF-FAIL'), (e) => { out1 = e; });
  handler(req('call-B', 'REQ-OFF-FAIL'), (e) => { out2 = e; });
  await new Promise((r) => setImmediate(r));
  // The retry must NOT have triggered a second offload call — proves it's
  // genuinely parked on the in-flight idempotency entry, not double-dispatched
  // (mirrors the `calls` counter check in the dispatch-stage test above; an
  // equality check directly on out1/out2 here would trip a TS control-flow
  // trap: assert.strict.equal narrows toward `null`, which then collides with
  // the truthy `assert.ok` narrowing used below and types them as `never`).
  assert.equal(offloadCalls, 1);

  rejectOffload(new Error('fabric bulk offload: job j1 did not complete (state=failed)'));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  // Bare `!` (not assert.ok/if-guard) — matches the existing dispatch-stage
  // test's own style above: `out1`/`out2` are only ever assigned inside a
  // closure, and TS's control-flow analysis does not treat that as a
  // reassignment in THIS function's flow, so an assert.ok/if narrowing
  // attempt here sees the (stale, CFA-tracked) initializer type `null` and
  // collapses to `never` — RED pre-fix would ALSO be a real failure (out1/out2
  // stay null forever, `!` throws a plain TypeError), just with a less
  // friendly message than an assert.ok guard would have given.
  assert.equal(out1!.headers.status, 502);
  assert.equal(out1!.headers.code, 'bulk_offload_failed');
  assert.equal(out2!.headers.status, 502, 'second (concurrent retry) reply arrived with the same failure — idempotency was settled, not left hanging');
  assert.equal(out2!.headers.code, 'bulk_offload_failed');
  assert.equal(out1!.id, 'call-A');
  assert.equal(out2!.id, 'call-B'); // replayed under ITS OWN correlation id, not call-A's
});

// ---------------------------------------------------------------------------
// feat/rules-fabric: RULES sync allow-list entry. Mirrors the DATA_SYNC_ROUTES
// scoped-entry tests above — the same URL-normalized routedPath decides
// eligibility, EXACT shape only, /rules/export (READ) never /rules/ingest
// (WRITE). Security-sensitive: this extends the surface of the W3 CRITICAL
// traversal-bypass (a bare-prefix allow-list let `/bus/../hub/config`
// normalize past a naive startsWith).
// ---------------------------------------------------------------------------

const rulesReq = (path: string, id = 'r1'): Envelope => ({
  kind: 'req', id,
  headers: { method: 'POST', path, reqId: id, cls: 'rpc' },
  payload: encodeBody({ body: {}, query: {} }),
});

test('ruleSyncEnabled on: /rules/export dispatches even with rpcEnabled off', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async (r) => { calls++; return { status: 200, data: { path: r.path } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false,
    ruleSyncEnabled: () => true,
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/export'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(out!.headers.status, 200);
  assert.deepEqual(decodeBody(out!.payload), { path: '/rules/export' });
});

test('ruleSyncEnabled off: /rules/export is rejected (503 rpc_disabled), no dispatch', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false,
    ruleSyncEnabled: () => false,
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/export'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
});

test('/rules/ingest (a WRITE) is NEVER allowed via ruleSyncEnabled, even when ruleSyncEnabled is on — only the general rpc class opens it', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false,     // general RPC class OFF
    ruleSyncEnabled: () => true, // rules-read allow-list ON — must not leak to ingest
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/ingest'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
});

test('/rules/ingest DOES dispatch when the general rpcEnabled class is on (write stays reachable only through the general class, unaffected by this change)', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async (r) => { calls++; return { status: 200, data: { path: r.path } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => true,
    ruleSyncEnabled: () => true,
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/ingest'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(out!.headers.status, 200);
});

test('exact-shape guard: /rules/exportx is NOT allowed via ruleSyncEnabled (no prefix match)', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false,
    ruleSyncEnabled: () => true,
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/exportx'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
});

test('exact-shape guard: /rules/export/x (extra segment) is NOT allowed via ruleSyncEnabled', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false,
    ruleSyncEnabled: () => true,
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/export/x'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
});

test('traversal guard: /rules/../hub/config (normalizes to /hub/config) is NOT allowed via ruleSyncEnabled', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async (r) => { calls++; return { status: 200, data: { path: r.path } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false,
    ruleSyncEnabled: () => true,
    peerNodeOf: () => 'gw-peer',
  });
  let out: Envelope | null = null;
  handler(rulesReq('/rules/../hub/config'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0, 'must never reach dispatch with the normalized /hub/config path');
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
});
