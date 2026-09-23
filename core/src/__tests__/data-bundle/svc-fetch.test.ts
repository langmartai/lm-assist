// core/src/__tests__/data-bundle/svc-fetch.test.ts
// fetchFromPeer: pull a bundle chunk by chunk through a (fake) hub proxy, verify it, store it
// under a NEW bundleId with importedFrom + fromNode. A corrupted chunk, a lying peer, a peer
// refusal or a transport failure stores NOTHING and leaves no tmp file behind.
import { makeNode, ownedDataset, rec, rejectsCode, tmp } from './svc-harness';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BundleStore } from '../../data/bundle/store';
import { fetchFromPeer, type FetchTransport } from '../../data/bundle/fetch';

const PEER = 'gw-peer';

async function peerWithBundle() {
  const peer = makeNode();
  // Enough incompressible payload that a small chunk size needs several round trips.
  await ownedDataset(peer, 'ds', Array.from({ length: 8 }, (_, i) => rec(`r${i}`, 1, { pad: crypto.randomBytes(512).toString('hex') })));
  const exp = await peer.svc.createExport();
  return { peer, exp };
}

/** A transport that serves the peer's /data/bundles/:id/chunk route from its store, in the route's envelope. */
function transportFor(peerStore: BundleStore, log: string[], mutate?: (c: any, n: number) => any): FetchTransport {
  let n = 0;
  return {
    async get(node, urlPath) {
      log.push(`${node} ${urlPath}`);
      const m = /^\/data\/bundles\/([^/]+)\/chunk\?offset=(\d+)&length=(\d+)$/.exec(urlPath);
      if (!m) throw new Error(`unexpected path ${urlPath}`);
      const chunk = peerStore.readChunk(m[1], Number(m[2]), Number(m[3]));
      const env = { success: true, data: chunk, meta: {} };
      return mutate ? mutate(env, n++) : env;
    },
  };
}

function localStore() {
  const dir = path.join(tmp('svc-fetch-'), 'bundles');
  return new BundleStore({ dir, receivedDir: tmp(), retention: 10, freeBytes: () => 1e15 });
}

const leftovers = (s: BundleStore) => fs.readdirSync(s.dir()).filter((n) => n.includes('.tmp') || n.startsWith('.fetch'));

test('fetch: chunked pull through the proxy, verified, stored under a new id with provenance', async () => {
  const { peer, exp } = await peerWithBundle();
  const store = localStore();
  const log: string[] = [];
  const res = await fetchFromPeer(PEER, exp.bundleId, { store, transport: transportFor(peer.store, log), chunkBytes: 1024 });
  assert.ok(res.chunks > 2, `several chunks (${res.chunks})`);
  assert.equal(log.length, res.chunks);
  assert.match(log[0], /^gw-peer \/data\/bundles\/lmb-[^/]+\/chunk\?offset=0&length=1024$/);
  assert.notEqual(res.bundleId, exp.bundleId);
  assert.equal(res.sourceBundleId, exp.bundleId);
  assert.equal(res.fromNode, PEER);
  assert.equal(res.sha256, exp.sha256, 'byte-for-byte the peer file');
  assert.equal(res.imported.via, 'fetch');
  assert.equal(res.imported.fromNode, PEER);
  assert.equal(res.imported.importedFrom, exp.bundleId);
  assert.equal(res.imported.sourceBundleId, exp.bundleId, 'the peer\'s stored id is persisted too');
  assert.equal(store.getImportedMeta(res.bundleId)?.sourceBundleId, exp.bundleId);
  assert.equal((await store.verify(res.bundleId)).manifest.bundleId, exp.bundleId);
  assert.deepEqual(leftovers(store), []);

  // The service passthrough uses the injected transport and the node's own store.
  const b = makeNode({ store, deps: { fetchTransport: transportFor(peer.store, []) } });
  const viaSvc = await b.svc.fetchFromPeer(PEER, exp.bundleId);
  const plan = await b.svc.plan(viaSvc.bundleId);
  assert.equal(plan.sections[0].counts.add, 8);
});

test('fetch: a corrupted chunk → BUNDLE_CORRUPT, nothing stored, no tmp left', async () => {
  const { peer, exp } = await peerWithBundle();
  const store = localStore();
  const flip = (env: any, n: number) => {
    if (n !== 1) return env;
    const buf = Buffer.from(env.data.dataB64, 'base64');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    return { ...env, data: { ...env.data, dataB64: buf.toString('base64') } };
  };
  const e = await rejectsCode(fetchFromPeer(PEER, exp.bundleId, { store, transport: transportFor(peer.store, [], flip), chunkBytes: 1024 }), 'BUNDLE_CORRUPT');
  assert.ok(e.message.length > 0);
  assert.equal((await store.list()).length, 0);
  assert.deepEqual(leftovers(store), []);
});

test('fetch: lying or refusing peers and transport failures store nothing', async () => {
  const { peer, exp } = await peerWithBundle();
  const cases: Array<[string, (env: any, n: number) => any, string]> = [
    ['wrong offset', (env, n) => (n === 1 ? { ...env, data: { ...env.data, offset: env.data.offset + 1 } } : env), 'FETCH_FAILED'],
    ['length lies', (env) => ({ ...env, data: { ...env.data, length: env.data.length + 1 } }), 'FETCH_FAILED'],
    ['size changes', (env, n) => (n === 1 ? { ...env, data: { ...env.data, total: env.data.total + 5 } } : env), 'FETCH_FAILED'],
    ['early done', (env, n) => (n === 1 ? { ...env, data: { ...env.data, done: true } } : env), 'FETCH_FAILED'],
    ['not a chunk', () => ({ success: true, data: { hello: 1 } }), 'FETCH_FAILED'],
    ['refusal envelope', () => ({ success: false, error: { code: 'BUNDLE_NOT_FOUND', message: 'no stored bundle' } }), 'BUNDLE_NOT_FOUND'],
  ];
  for (const [name, mutate, code] of cases) {
    const store = localStore();
    await rejectsCode(fetchFromPeer(PEER, exp.bundleId, { store, transport: transportFor(peer.store, [], mutate), chunkBytes: 1024 }), code).catch((e) => { throw new Error(`${name}: ${e.message}`); });
    assert.equal((await store.list()).length, 0, name);
    assert.deepEqual(leftovers(store), [], name);
  }

  const store = localStore();
  const down: FetchTransport = { get: async () => { throw new Error('Proxy request to gw-peer/data/bundles/x/chunk returned 404 — {"success":false,"error":{"code":"BUNDLE_NOT_FOUND"}}'); } };
  await rejectsCode(fetchFromPeer(PEER, exp.bundleId, { store, transport: down }), 'BUNDLE_NOT_FOUND');
  const offline: FetchTransport = { get: async () => { throw new Error('Proxy request returned 503 — Machine offline'); } };
  await rejectsCode(fetchFromPeer(PEER, exp.bundleId, { store, transport: offline }), 'FETCH_FAILED');
  assert.equal((await store.list()).length, 0);
});

test('fetch: input validation and DISK_LOW before any byte is written', async () => {
  const { peer, exp } = await peerWithBundle();
  const log: string[] = [];
  const t = transportFor(peer.store, log);
  await rejectsCode(fetchFromPeer('../evil', exp.bundleId, { store: localStore(), transport: t }), 'BAD_REQUEST');
  await rejectsCode(fetchFromPeer(PEER, 'not-an-id', { store: localStore(), transport: t }), 'BUNDLE_ID_INVALID');
  assert.equal(log.length, 0);
  const tight = new BundleStore({ dir: path.join(tmp(), 'bundles'), receivedDir: tmp(), retention: 5, freeBytes: () => 10 });
  await rejectsCode(fetchFromPeer(PEER, exp.bundleId, { store: tight, transport: t }), 'DISK_LOW');
  assert.deepEqual(leftovers(tight), []);
});
