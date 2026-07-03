// core/src/__tests__/fabric/fabric-request.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { initEnvelopeCodec, encodeBody } from '../../fabric/envelope';
import { FabricLink, type FabricChannel, type ServerHandler } from '../../fabric/fabric-link';
import { createRpcServer } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';
import { sha256Hex } from '../../fabric/bulk-offload';
import { receiveRoot, safeJoin } from '../../file-transfer';
import { fabricRequest, __setFabricLinkForTest, stopFabric } from '../../fabric';

before(async () => { await initEnvelopeCodec(); });

/** A client FabricLink wired to an in-process echo-server FabricLink (paired channels). */
function echoLink(): FabricLink {
  let aCb: ((d: Buffer) => void) | null = null; // client reader
  let bCb: ((d: Buffer) => void) | null = null; // server reader
  const clientCh: FabricChannel = {
    peer: 'nodeB', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => bCb && bCb(b)),
    sendControl: (b) => queueMicrotask(() => bCb && bCb(b)),
    onData: (cb) => { aCb = cb; },
  };
  const serverCh: FabricChannel = {
    peer: 'nodeA', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => aCb && aCb(b)),
    sendControl: (b) => queueMicrotask(() => aCb && aCb(b)),
    onData: (cb) => { bCb = cb; },
  };
  // Server: reply to any req with the echoed path. (Keep the ref alive via the closure.)
  const server = new FabricLink(serverCh, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200, 'content-type': 'application/json' }, payload: encodeBody({ path: env.headers.path }) }),
  });
  const client = new FabricLink(clientCh, {});
  (client as unknown as { _peerServer: FabricLink })._peerServer = server; // pin the server
  return client;
}

test('fabricRequest routes to the node link and returns decoded data', async () => {
  stopFabric();
  __setFabricLinkForTest('nodeB', echoLink());
  const res = await fabricRequest({ node: 'nodeB' }, { method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { path: '/health' });
  stopFabric();
});

test('fabricRequest to an unknown node errors clearly', async () => {
  stopFabric();
  await assert.rejects(fabricRequest({ node: 'ghost' }, { method: 'GET', path: '/health' }), /no fabric link|not connected/i);
});

// ---------------------------------------------------------------------------
// Additional Task 12 coverage (beyond the brief's 2 given tests above): a
// generic paired-link helper that plugs in any REAL rpc-server ServerHandler,
// so these tests exercise createRpcServer/idempotency the same way
// attachFabricLink wires it, not a hand-rolled stub server.
// ---------------------------------------------------------------------------
function pairedLink(onServer: ServerHandler, names: { client: string; server: string } = { client: 'nodeX', server: 'nodeY' }): FabricLink {
  let aCb: ((d: Buffer) => void) | null = null;
  let bCb: ((d: Buffer) => void) | null = null;
  const clientCh: FabricChannel = {
    peer: names.client, policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => bCb && bCb(b)),
    sendControl: (b) => queueMicrotask(() => bCb && bCb(b)),
    onData: (cb) => { aCb = cb; },
  };
  const serverCh: FabricChannel = {
    peer: names.server, policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => aCb && aCb(b)),
    sendControl: (b) => queueMicrotask(() => aCb && aCb(b)),
    onData: (cb) => { bCb = cb; },
  };
  const server = new FabricLink(serverCh, { onServer });
  const client = new FabricLink(clientCh, {});
  (client as unknown as { _peerServer: FabricLink })._peerServer = server;
  return client;
}

test('fabricRequest surfaces a disabled-rpc response as {status,code}, not a throw (fabricRpcEnabled=false path)', async () => {
  stopFabric();
  const server = createRpcServer({
    dispatch: async () => ({ status: 200, data: { should: 'not run' } }),
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, // simulates settings().fabricRpcEnabled === false
    peerNodeOf: () => 'nodeY',
  });
  __setFabricLinkForTest('nodeX', pairedLink(server, { client: 'nodeX', server: 'nodeY' }));
  const res = await fabricRequest({ node: 'nodeX' }, { method: 'GET', path: '/anything' });
  assert.equal(res.status, 503);
  assert.equal(res.code, 'rpc_disabled');
  stopFabric();
});

test('a bulk=true response is fetched + verified + decoded transparently, and the delivered drop file is cleaned up', async () => {
  stopFabric();
  const fsp = require('fs/promises') as typeof import('fs/promises');
  const dataValue = { big: 'x'.repeat(2000), n: 42 };
  const bytes = encodeBody(dataValue);
  const sink = 'fabric-bulk/test-fabric-request-bulk.bin';
  const abs = safeJoin(receiveRoot(), sink);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const handle = { transferId: 'test-fabric-request-bulk', size: bytes.length, sha256: sha256Hex(bytes), sink };

  const server: ServerHandler = (env, reply) => {
    reply({ kind: 'res', id: env.id, headers: { status: 200, bulk: true }, payload: encodeBody(handle) });
  };
  __setFabricLinkForTest('nodeZ', pairedLink(server, { client: 'nodeZ', server: 'nodeW' }));

  try {
    const res = await fabricRequest({ node: 'nodeZ' }, { method: 'GET', path: '/big' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, dataValue);
    // cleanup: fabricRequest must have removed the delivered drop file after fetch+verify.
    await assert.rejects(fsp.stat(abs), /ENOENT/);
  } finally {
    await fsp.unlink(abs).catch(() => {}); // best-effort safety net if the assertion above failed before cleanup ran
    stopFabric();
  }
});
