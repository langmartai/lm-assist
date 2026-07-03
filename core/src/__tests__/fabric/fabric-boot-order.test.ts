// core/src/__tests__/fabric/fabric-boot-order.test.ts
//
// Deliberately has NO `before(() => initEnvelopeCodec())` hook (unlike
// fabric-request.test.ts) — this file's whole purpose is to prove that
// fabricRequest() awaits codec readiness ITSELF (via the module-private
// ensureCodec()) before doing any envelope I/O, rather than relying on some
// earlier caller having already warmed it. `node --test` runs each test file
// in its own process, so this file starts with a genuinely cold (unloaded)
// msgpack codec — the first call to fabricRequest() below is the first thing
// in this process that touches it.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeBody } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';
import { fabricRequest, __setFabricLinkForTest, stopFabric } from '../../fabric';

function echoLink(): FabricLink {
  let aCb: ((d: Buffer) => void) | null = null;
  let bCb: ((d: Buffer) => void) | null = null;
  const clientCh: FabricChannel = {
    peer: 'nodeCold', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => bCb && bCb(b)),
    sendControl: (b) => queueMicrotask(() => bCb && bCb(b)),
    onData: (cb) => { aCb = cb; },
  };
  const serverCh: FabricChannel = {
    peer: 'nodeColdServer', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => aCb && aCb(b)),
    sendControl: (b) => queueMicrotask(() => aCb && aCb(b)),
    onData: (cb) => { bCb = cb; },
  };
  // encodeBody is called INSIDE the handler — i.e. only once a request has
  // actually flowed through, which can only happen after fabricRequest's own
  // `await ensureCodec()` already resolved. Constructing this pair (and
  // importing this file) never itself touches the codec.
  const server = new FabricLink(serverCh, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200 }, payload: encodeBody({ echoed: env.headers.path }) }),
  });
  const client = new FabricLink(clientCh, {});
  (client as unknown as { _peerServer: FabricLink })._peerServer = server;
  return client;
}

test('fabricRequest awaits codec readiness itself before its first envelope I/O — no prior initEnvelopeCodec() call in this process', async () => {
  stopFabric();
  __setFabricLinkForTest('nodeCold', echoLink());
  // If fabricRequest (or FabricLink.request, which it calls) did NOT await
  // the codec before encoding, this would throw "envelope codec not loaded —
  // call await initEnvelopeCodec() first" instead of resolving.
  const res = await fabricRequest({ node: 'nodeCold' }, { method: 'GET', path: '/cold-start' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { echoed: '/cold-start' });
  stopFabric();
});
