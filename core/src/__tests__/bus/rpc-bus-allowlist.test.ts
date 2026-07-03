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
