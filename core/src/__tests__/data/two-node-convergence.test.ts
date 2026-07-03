// core/src/__tests__/data/two-node-convergence.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../../data/data-service';
import { SyncEngine } from '../../data/sync-engine';
import { SyncListener } from '../../data/sync-listener';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { getKeyStore } from '../../data/key-store';
import { Bus } from '../../bus/bus';
import { BusStore } from '../../bus/bus-store';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord, Principal } from '../../data/types';
import type { BusEvent } from '../../bus/types';

function node(id: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `n-${id}-`));
  const datasets = new DatasetRegistry(path.join(dir, 'datasets.json'));
  const backends = new BackendRegistry();
  // NOTE: CacheBackend MUST get a per-node dir override. lmdb-js dedupes open() calls to the
  // same resolved path within one process (verified: two independent CacheBackend() instances
  // with no override both resolve to the SAME on-disk `<dataRoot>/cache/missions.lmdb` and share
  // the underlying native env) — so two nodes in one test process would silently read/write the
  // SAME physical store, and B.svc.get() would see A's write with NO bus/listener/pull involved
  // at all. That would make the convergence assertion below pass vacuously. Passing `dir` isolates
  // each node's cache on disk, matching the override convention every other data test already uses
  // (cas-put.test.ts, data-service.test.ts, sync-engine.test.ts, etc.).
  backends.register(new CacheBackend(dir));
  const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: id });
  const bus = new Bus({ store: new BusStore(dir), selfNode: id, enabled: () => true });
  const svc = new DataService({ datasets, backends, manager, notify: (ds, type, ids) => bus.publish(`data:${ds}`, type, { ids }) });
  // 'missions' is a full, cross-node-readable dataset (exactly as mission-store.ts registers it).
  datasets.create({ id: 'missions', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } });
  return { id, datasets, backends, manager, bus, svc, dir };
}
const local: Principal = { type: 'local' };
const ctx = { principal: local };
const rec = (id: string, f: Record<string, unknown> = {}): DataRecord => ({ id, version: 0, fields: f, createdAt: '', updatedAt: '' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('write on A converges on B in ~1s via change-notify → bus → debounced pull (missions)', async () => {
  const A = node('gw-a');
  const B = node('gw-b');
  // Bridge A's fan-out into B's bus (the fabric pub path, in-process + synchronous).
  A.bus.onLocalEvent((e: BusEvent) => { if (e.origin === 'gw-a') B.bus.ingest(e); });
  // B pulls from A directly (the fabric export path, in-process): a PeerClient backed by A's service.
  const peers: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'gw-a', hostname: 'a', platform: 'linux' }],
    manifest: async (): Promise<{ node: string; datasets: ManifestEntry[] }> => ({ node: 'gw-a', datasets: A.svc.syncManifest({ type: 'peer', node: 'gw-b' }) as ManifestEntry[] }),
    exportFrom: async (_n, ds, since): Promise<DataRecord[]> => {
      const r = await A.svc.exportDataset({ principal: { type: 'peer', node: 'gw-b' } }, ds, since);
      return r.ok ? r.value : [];
    },
    getFrom: async () => null,
  };
  const engineB = new SyncEngine({ datasets: B.datasets, backends: B.backends, peers, nodeId: 'gw-b' });
  const listenerB = new SyncListener({ selfNode: () => 'gw-b', pull: (ds, from) => engineB.pullDataset(from, ds), onLocalEvent: (cb) => B.bus.onLocalEvent(cb), debounceMs: 20 });
  listenerB.start();

  // Act: A writes a mission.
  await A.svc.put(ctx, 'missions', rec('m-1', { title: 'ship W4' }));

  // Assert: B has it within ~1s (debounce 20ms + a couple of ticks).
  await wait(200);
  const got = await B.svc.get(ctx, 'missions', 'm-1');
  assert.equal(got.ok, true);
  assert.equal((got as { value: DataRecord | null }).value?.fields.title, 'ship W4');
  listenerB.stop();
});

test('legacy fallback: a peer principal cannot read a local-only dataset (denied), proving scope', async () => {
  const A = node('gw-a');
  A.datasets.create({ id: 'secrets', backend: 'cache', visibility: 'local-only', syncMode: 'none', config: { kind: 'cache' } });
  await A.svc.put(ctx, 'secrets', rec('s1'));
  const asPeer = { principal: { type: 'peer' as const, node: 'gw-b' } };
  const r = await A.svc.exportDataset(asPeer, 'secrets');
  assert.equal(r.ok, false); // peer cannot export a local-only dataset
});

test('CAS conflict surfaces on a stale ifVersion', async () => {
  const A = node('gw-a');
  await A.svc.put(ctx, 'missions', rec('m-2'));            // version → 1
  const stale = await A.svc.put(ctx, 'missions', rec('m-2'), { ifVersion: 0 });
  assert.equal(stale.ok, false);
  assert.equal((stale as { code: string }).code, 'CONFLICT');
});
