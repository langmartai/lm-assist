// core/src/__tests__/bus/rpc-bus-allowlist.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';
import { createRpcServer } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';

before(async () => { await initEnvelopeCodec(); });

function req(path: string): Envelope {
  return { kind: 'req', id: 'r1', headers: { method: 'POST', path, reqId: 'r1', cls: 'rpc' }, payload: encodeBody({ body: { cursors: {} }, query: {} }) };
}

test('a /bus/* req dispatches under busEnabled even when rpcEnabled is false', async () => {
  const seen: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { seen.push(r.path); return { status: 200, data: { events: [] } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  const res = await new Promise<Envelope>((resolve) => server(req('/bus/m/since'), resolve));
  assert.equal(res.headers.status, 200);
  assert.deepEqual(seen, ['/bus/m/since']);
});

test('a non-bus req is still refused when rpcEnabled is false', async () => {
  const server = createRpcServer({
    dispatch: async () => ({ status: 200, data: {} }),
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  const res = await new Promise<Envelope>((resolve) => server(req('/data/x/export'), resolve));
  assert.equal(res.headers.status, 503);
  assert.equal(res.headers.code, 'rpc_disabled');
});

// --- Path-traversal kill-switch bypass (CRITICAL fix regression proof) -----
//
// Pre-fix, the allow-list tested `env.headers.path.startsWith('/bus/')` on
// the RAW path. `loopbackDispatch` sends that raw string verbatim as the
// literal HTTP request line, but rest-server.ts's parseRequest routes on
// `new URL(req.url, base).pathname` — which collapses `..` / `%2e%2e`
// segments. So a peer req with `path:'/bus/../hub/config'` passed the raw
// prefix test (it IS a string starting with '/bus/') and reached dispatch,
// which — over the real loopback HTTP hop — resolves to the NON-bus route
// `/hub/config`, defeating the kill switch at the fleet default
// (fabricRpcEnabled=false, busEnabled=true). Confirmed on the pre-fix code:
// `seen` below was `['/bus/../hub/config']` and status was 200, not 503.

test('a literal-dot traversal path (/bus/../hub/config) is refused, never reaches dispatch', async () => {
  const seen: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { seen.push(r.path); return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  const res = await new Promise<Envelope>((resolve) => server(req('/bus/../hub/config'), resolve));
  assert.equal(res.headers.status, 503);
  assert.equal(res.headers.code, 'rpc_disabled');
  assert.deepEqual(seen, [], 'dispatch must never be invoked for a traversal path — pre-fix this reached dispatch as /bus/../hub/config');
});

test('a percent-encoded traversal path (/bus/%2e%2e/data/keys) is refused, never reaches dispatch', async () => {
  const seen: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { seen.push(r.path); return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  const res = await new Promise<Envelope>((resolve) => server(req('/bus/%2e%2e/data/keys'), resolve));
  assert.equal(res.headers.status, 503);
  assert.equal(res.headers.code, 'rpc_disabled');
  assert.deepEqual(seen, [], 'dispatch must never be invoked for an encoded traversal path — %2e%2e collapses to .. under URL normalization');
});

test('a legit /bus/m/since request still dispatches (200) after the normalization fix — including a harmless dot segment', async () => {
  const seen: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { seen.push(r.path); return { status: 200, data: { events: [] } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  // A harmless single-dot segment ('/bus/./m/since') normalizes to the exact
  // same legit route ('/bus/m/since') — proving both that real catch-up
  // traffic still works post-fix, AND that dispatch receives the NORMALIZED
  // path (not the raw pre-normalization string), per the fix's requirement
  // that the allow-list decision and the dispatched path can never diverge.
  const res = await new Promise<Envelope>((resolve) => server(req('/bus/./m/since'), resolve));
  assert.equal(res.headers.status, 200);
  assert.deepEqual(seen, ['/bus/m/since']);
});
