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
