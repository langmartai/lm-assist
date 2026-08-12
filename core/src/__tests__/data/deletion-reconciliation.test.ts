// core/src/__tests__/data/deletion-reconciliation.test.ts
// Deletion reconciliation (bl_bad31392): a delete must converge across nodes through the
// same pull channel as writes — via a TOMBSTONE record — instead of relying on a bus
// notify a node can miss (the ghost-mission incident, 2026-08-04/05).
//
// Safety invariants under test:
//   • a missed delete is healed by the next reconcile (positive tombstone signal);
//   • an unreachable origin / failed or partial export deletes NOTHING;
//   • an old tombstone never kills a newer legitimate re-create (LWW order);
//   • tombstone GC bounds the store but never touches live records;
//   • cluster-scoped datasets are untouched by foreign-cluster origins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Isolated data dir — must be set before any module that reads paths.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dr-'));
// Isolated HOME so getMyCluster() reads OUR fixture rather than the host's real
// ~/.lm-assist/cluster-dev.json — the cluster-isolation test below needs a KNOWN
// self-cluster, and the 2026-08-02 note in sync-engine.test.ts documents what
// happens when a test's outcome depends on the machine's live cluster config.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dr-home-'));
process.env.HOME = FAKE_HOME;
fs.mkdirSync(path.join(FAKE_HOME, '.lm-assist'), { recursive: true });
fs.writeFileSync(
  path.join(FAKE_HOME, '.lm-assist', 'cluster-dev.json'),
  JSON.stringify({ cluster: 'cl-self' }),
);

import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DataService } from '../../data/data-service';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { SyncEngine } from '../../data/sync-engine';
import { KeyedLocks } from '../../data/key-lock';
import type { PeerClient, DataRecord, ManifestEntry, NodeInfo, StorageBackend } from '../../data/types';

// ── Helper to build an isolated DataService + its raw backend (mirrors sync-engine.test) ──

function svc(nodeId: string) {
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), `dr-${nodeId}-`)), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), `drk-${nodeId}-`)));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `drc-${nodeId}-`));
  const backend = new CacheBackend(cacheDir);
  const backends = new BackendRegistry();
  backends.register(backend);
  const manager = new AccessManager({ datasets, keys, nodeId });
  // The service's put/del lock, shared with any SyncEngine a test builds — GC's
  // check-then-delete must run under the SAME lock (prod wiring: getDataService).
  const locks = new KeyedLocks();
  const service = new DataService({ datasets, backends, manager, locks });
  (service as any).enabledOverride = true;
  return { service, datasets, backends, backend, locks };
}

const LOCAL_CTX = { principal: { type: 'local' as const } };

function mkRecord(id: string, fields: Record<string, unknown> = {}): DataRecord {
  return { id, version: 0, fields, createdAt: '', updatedAt: '' };
}

/** A fake peer bridging directly to a source node's backend, fleet scope (see the
 *  🔴 note in sync-engine.test.ts: explicit 'fleet' keeps the cluster guard out of
 *  these replication tests). */
function bridgePeer(node: string, src: ReturnType<typeof svc>, dataset = 'tickets'): PeerClient {
  return {
    listPeers: async (): Promise<NodeInfo[]> => [{ node, hostname: 'h', platform: 'linux' }],
    manifest: async () => ({
      node,
      datasets: [{ id: dataset, syncMode: 'full', ownerNode: node, backend: 'cache', scope: 'fleet' }] as ManifestEntry[],
    }),
    exportFrom: async (_n, ds, since) => src.backend.exportSince(ds, since),
    getFrom: async (_n, ds, id) => src.backend.get(ds, id),
  };
}

// ── 1. The core defect: a missed delete is healed on the next reconcile ─────────

test('deletion reconciliation: a delete missed by a peer is healed on its next reconcile', async () => {
  const a = svc('A');
  const b = svc('B');

  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'ghost-to-be' }));
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r2', { title: 'keeper' }));

  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: bridgePeer('A', a), nodeId: 'B' });

  // B replicates both records.
  await engineB.reconcile();
  assert.ok(await b.backend.get('tickets', 'r1'), 'precondition: r1 replicated to B');

  // A deletes r1. B gets NO bus notify (offline / restart) — the incident scenario.
  const del = await a.service.del(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(del.ok && del.value === true, 'delete on A reports success');

  // Origin-side visibility: the record is gone from every consumer surface on A.
  const aGet = await a.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(aGet.ok && aGet.value === null, 'A: get after delete is null');
  const aQuery = await a.service.query(LOCAL_CTX, 'tickets', {});
  assert.ok(aQuery.ok);
  assert.deepEqual(aQuery.value.records.map((r) => r.id), ['r2'], 'A: query no longer lists r1');

  // The heal: B's next reconcile pulls the tombstone and the doc stops being schedulable.
  const status = await engineB.reconcile();
  assert.equal(status.errors.length, 0, 'reconcile is clean');
  const bGet = await b.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(bGet.ok && bGet.value === null, 'B: r1 is gone after reconcile (the ghost is healed)');
  const bQuery = await b.service.query(LOCAL_CTX, 'tickets', {});
  assert.ok(bQuery.ok);
  assert.deepEqual(bQuery.value.records.map((r) => r.id), ['r2'], 'B: query no longer lists r1');
  const bR2 = await b.service.get(LOCAL_CTX, 'tickets', 'r2');
  assert.ok(bR2.ok && bR2.value !== null, 'B: unrelated record r2 survives');
});

// ── 2. Negative signals must delete NOTHING ────────────────────────────────────

test('deletion reconciliation: an unreachable origin deletes nothing', async () => {
  const a = svc('A4');
  const b = svc('B4');

  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'v1' }));
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r2', { title: 'v1' }));

  const good = bridgePeer('A4', a);
  let reachable = true;
  const flaky: PeerClient = {
    listPeers: good.listPeers,
    manifest: async (n) => { if (!reachable) throw new Error('ECONNREFUSED'); return good.manifest(n); },
    exportFrom: async (n, ds, since) => { if (!reachable) throw new Error('ECONNREFUSED'); return good.exportFrom(n, ds, since); },
    getFrom: good.getFrom,
  };
  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: flaky, nodeId: 'B4' });
  await engineB.reconcile();
  assert.ok(await b.backend.get('tickets', 'r1'), 'precondition: r1 replicated');

  // Origin goes dark. Reconcile must record the error and keep every local record.
  reachable = false;
  const status = await engineB.reconcile();
  assert.ok(status.errors.length > 0, 'unreachable origin is reported, not swallowed');
  const q = await b.service.query(LOCAL_CTX, 'tickets', {});
  assert.ok(q.ok);
  assert.deepEqual(q.value.records.map((r) => r.id).sort(), ['r1', 'r2'], 'nothing was deleted on a fetch failure');
});

test('deletion reconciliation: an empty/partial export response deletes nothing', async () => {
  const a = svc('A5');
  const b = svc('B5');

  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', {}));
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r2', {}));

  const good = bridgePeer('A5', a);
  let healthy = true;
  const truncating: PeerClient = {
    ...good,
    exportFrom: async (n, ds, since) => (healthy ? good.exportFrom(n, ds, since) : []),
  };
  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: truncating, nodeId: 'B5' });
  await engineB.reconcile();
  assert.ok(await b.backend.get('tickets', 'r2'), 'precondition: replicated');

  // The origin now answers with an EMPTY set (failed/partial answer). Absence from an
  // export is NOT a deletion signal — only an explicit tombstone is.
  healthy = false;
  const status = await engineB.reconcile();
  assert.equal(status.errors.length, 0);
  const q = await b.service.query(LOCAL_CTX, 'tickets', {});
  assert.ok(q.ok);
  assert.deepEqual(q.value.records.map((r) => r.id).sort(), ['r1', 'r2'], 'an empty export deletes nothing');
});

// ── 3. LWW interplay: re-creates vs tombstones ─────────────────────────────────

test('deletion reconciliation: a record re-created after a delete survives and propagates', async () => {
  const a = svc('A6');
  const b = svc('B6');

  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'v1' }));

  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: bridgePeer('A6', a), nodeId: 'B6' });
  await engineB.reconcile();

  // Delete, sync the tombstone to B, then legitimately re-create on A.
  await a.service.del(LOCAL_CTX, 'tickets', 'r1');
  await engineB.reconcile();
  const gone = await b.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(gone.ok && gone.value === null, 'B: r1 deleted after tombstone sync');

  const recreate = await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'reborn' }), { ifVersion: 0 });
  assert.ok(recreate.ok, `re-create with ifVersion:0 must succeed after a delete (got ${JSON.stringify(recreate)})`);

  await engineB.reconcile();
  const back = await b.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(back.ok && back.value !== null, 'B: re-created record replicates');
  assert.equal((back.value as DataRecord).fields.title, 'reborn');
});

test('deletion reconciliation: an OLD tombstone never kills a newer legitimate re-create (LWW)', async () => {
  const b = svc('B7');
  b.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('tickets')!);

  // Local truth: a re-created record at version 3.
  const now = new Date().toISOString();
  await b.backend.put('tickets', { id: 'r1', version: 3, fields: { title: 'reborn' }, createdAt: now, updatedAt: now });

  // A straggler peer replays the tombstone from BEFORE the re-create (version 2, older time).
  const staleT = new Date(Date.now() - 60_000).toISOString();
  const oldTombstone: DataRecord = { id: 'r1', version: 2, fields: {}, deleted: true, createdAt: staleT, updatedAt: staleT };
  const r = await b.backend.importBatch('tickets', [oldTombstone], { machineId: 'straggler', hostname: 'h', os: 'linux' });
  assert.equal(r.applied, 0, 'old tombstone loses LWW');

  const got = await b.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(got.ok && got.value !== null, 'the newer re-create survives the stale tombstone');
  assert.equal((got.value as DataRecord).fields.title, 'reborn');
});

// ── 4. Delete surface semantics on the origin ──────────────────────────────────

test('deletion reconciliation: del is idempotent and CAS create-if-absent works over a tombstone', async () => {
  const a = svc('A8');
  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { x: 1 }));

  const d1 = await a.service.del(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(d1.ok && d1.value === true, 'first delete: true');
  const d2 = await a.service.del(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(d2.ok && d2.value === false, 'second delete: false (already gone), no tombstone re-bump');
  const d3 = await a.service.del(LOCAL_CTX, 'tickets', 'never-existed');
  assert.ok(d3.ok && d3.value === false, 'deleting a nonexistent id: false');

  // The tombstone is invisible to consumers but present in the raw store for propagation.
  const raw = await a.backend.get('tickets', 'r1');
  assert.ok(raw && raw.deleted === true, 'raw store holds the tombstone');
  assert.deepEqual(raw!.fields, {}, 'tombstone carries no payload');
  const seen = await a.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(seen.ok && seen.value === null, 'consumers see the record as absent');

  // CAS: the tombstoned id is logically absent (ifVersion 0 passes), and the re-create's
  // version continues PAST the tombstone so it wins LWW on every replica.
  const cas = await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { x: 2 }), { ifVersion: 0 });
  assert.ok(cas.ok, 're-create with ifVersion 0 succeeds over a tombstone');
  const rec = await a.backend.get('tickets', 'r1');
  assert.ok(rec && !rec.deleted, 're-created record is live');
  assert.ok(rec!.version > raw!.version, `re-create version ${rec!.version} must exceed tombstone version ${raw!.version}`);
});

// ── 5. Tombstone GC bounds the store ───────────────────────────────────────────

test('deletion reconciliation: age-based GC purges only genuinely old tombstones', async () => {
  const b = svc('B9');
  b.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('tickets')!);

  const now = new Date().toISOString();
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15d > 14d TTL
  // An expired tombstone, a fresh tombstone, a live record, and the shadow hazard:
  // a LIVE record whose USER FIELDS carry deleted:true — GC must never touch it.
  await b.backend.put('tickets', { id: 'dead-old', version: 2, fields: {}, deleted: true, createdAt: old, updatedAt: old });
  await b.backend.put('tickets', { id: 'dead-new', version: 2, fields: {}, deleted: true, createdAt: now, updatedAt: now });
  await b.backend.put('tickets', { id: 'alive', version: 1, fields: { title: 'x' }, createdAt: old, updatedAt: old });
  await b.backend.put('tickets', { id: 'shadow', version: 1, fields: { deleted: true }, createdAt: old, updatedAt: old });

  const noPeers: PeerClient = {
    listPeers: async () => [], manifest: async () => ({ node: '', datasets: [] }),
    exportFrom: async () => [], getFrom: async () => null,
  };
  const engine = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: noPeers, nodeId: 'B9' });
  const status = await engine.reconcile();

  assert.equal(status.tombstonesPurged, 1, 'exactly the expired tombstone is purged');
  assert.equal(await b.backend.get('tickets', 'dead-old'), null, 'expired tombstone gone');
  assert.ok(await b.backend.get('tickets', 'dead-new'), 'fresh tombstone retained (still propagating)');
  assert.ok(await b.backend.get('tickets', 'alive'), 'live record untouched');
  assert.ok(await b.backend.get('tickets', 'shadow'), 'live record with fields.deleted=true untouched (shadow hazard)');
});

test('deletion reconciliation: the GC TTL floor defeats a too-small configured TTL', async () => {
  const b = svc('B10');
  b.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('tickets')!);

  // 10 minutes old — younger than the 1h floor, older than the (misconfigured) 1s TTL.
  const t = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await b.backend.put('tickets', { id: 'young-tomb', version: 2, fields: {}, deleted: true, createdAt: t, updatedAt: t });

  const noPeers: PeerClient = {
    listPeers: async () => [], manifest: async () => ({ node: '', datasets: [] }),
    exportFrom: async () => [], getFrom: async () => null,
  };
  const engine = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: noPeers, nodeId: 'B10', tombstoneTtlMs: 1000 });
  const status = await engine.reconcile();

  assert.equal(status.tombstonesPurged, 0, 'floor clamps the TTL — a young tombstone survives');
  assert.ok(await b.backend.get('tickets', 'young-tomb'), 'tombstone still present to propagate');
});

test('deletion reconciliation: GC does not delete a record re-created between its snapshot and its delete (TOCTOU)', async () => {
  // gcTombstones takes a query-time SNAPSHOT and then hard-deletes. A legitimate
  // re-create (CAS ifVersion:0 over the tombstone — a supported flow) landing
  // between the snapshot and the delete must NOT lose its new live record: the GC
  // has to re-read at delete time under the same per-key lock del/put use.
  const b = svc('B12');
  b.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('tickets')!);

  // An EXPIRED tombstone — exactly what GC wants to purge.
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  await b.backend.put('tickets', { id: 'r1', version: 2, fields: {}, deleted: true, createdAt: old, updatedAt: old });

  // The engine sees the backend through a wrapper whose query() lands a CAS
  // re-create AFTER the snapshot is taken but BEFORE GC proceeds — the exact
  // interleaving of the race, made deterministic.
  let armed = true;
  const raw = b.backend;
  const wrapped: StorageBackend = {
    kind: raw.kind,
    createDataset: (d) => raw.createDataset(d),
    dropDataset: (id) => raw.dropDataset(id),
    put: (ds, r) => raw.put(ds, r),
    get: (ds, id) => raw.get(ds, id),
    delete: (ds, id) => raw.delete(ds, id),
    exportSince: (ds, since) => raw.exportSince(ds, since),
    importBatch: (ds, rs, o) => raw.importBatch(ds, rs, o),
    query: async (ds, q) => {
      const snapshot = await raw.query(ds, q);
      if (armed && ds === 'tickets') {
        armed = false;
        const recreate = await b.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'reborn' }), { ifVersion: 0 });
        assert.ok(recreate.ok, `re-create during the GC window must succeed (got ${JSON.stringify(recreate)})`);
      }
      return snapshot;
    },
  };
  const gcBackends = new BackendRegistry();
  gcBackends.register(wrapped);

  const noPeers: PeerClient = {
    listPeers: async () => [], manifest: async () => ({ node: '', datasets: [] }),
    exportFrom: async () => [], getFrom: async () => null,
  };
  // SAME lock instance as the service — the prod wiring (getDataService) does this too.
  const engine = new SyncEngine({ datasets: b.datasets, backends: gcBackends, peers: noPeers, nodeId: 'B12', locks: b.locks });
  const status = await engine.reconcile();

  assert.equal(status.tombstonesPurged, 0, 'GC must purge nothing — the tombstone was replaced by a live record');
  const got = await b.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(got.ok && got.value !== null, 'the re-created record survives the GC pass');
  assert.equal((got.value as DataRecord).fields.title, 'reborn');
});

// ── 6. Cluster scoping: foreign origins cannot deliver deletions ───────────────

test('deletion reconciliation: a cluster-scoped dataset is untouched by a foreign-cluster origin', async () => {
  // HOME is overridden at the top of this file: getMyCluster() reads our fixture 'cl-self'.
  // Peer 'F' is in no cluster record → resolves to 'default' ≠ 'cl-self' → the pull gate
  // (shouldPullDataset) refuses the dataset BEFORE any records — tombstones included — move.
  const b = svc('B11');
  b.datasets.create({ id: 'own-things', backend: 'cache', visibility: 'synced', syncMode: 'full', config: { kind: 'cache' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('own-things')!);
  await b.service.put(LOCAL_CTX, 'own-things', mkRecord('r1', { mine: true }));

  let exportFromCalls = 0;
  const staleT = new Date().toISOString();
  const foreign: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'F', hostname: 'fh', platform: 'linux' }],
    manifest: async () => ({
      node: 'F',
      datasets: [{ id: 'own-things', syncMode: 'full', ownerNode: 'F', backend: 'cache', scope: 'cluster' }] as ManifestEntry[],
    }),
    // A malicious/buggy foreign origin serving a tombstone for OUR record.
    exportFrom: async () => {
      exportFromCalls++;
      return [{ id: 'r1', version: 99, fields: {}, deleted: true, createdAt: staleT, updatedAt: staleT } as DataRecord];
    },
    getFrom: async () => null,
  };

  const engine = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: foreign, nodeId: 'B11' });
  await engine.reconcile();

  assert.equal(exportFromCalls, 0, 'the cluster gate refuses the pull outright');
  const got = await b.service.get(LOCAL_CTX, 'own-things', 'r1');
  assert.ok(got.ok && got.value !== null, 'the record survives — a foreign origin cannot delete what it does not own');
});

test('deletion reconciliation: the bus-notify pull path (pullDataset) honors the cluster gate too', async () => {
  // sync-listener → pullDataset is the OTHER road into pullOne. Without the same
  // shouldPullDataset gate the reconcile loop applies, a foreign-cluster notify
  // pulls (and can tombstone-delete) a dataset the reconcile loop would refuse.
  const b = svc('B13');
  b.datasets.create({ id: 'own-things', backend: 'cache', visibility: 'synced', syncMode: 'full', config: { kind: 'cache' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('own-things')!);
  await b.service.put(LOCAL_CTX, 'own-things', mkRecord('r1', { mine: true }));

  let exportFromCalls = 0;
  const staleT = new Date().toISOString();
  const foreign: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'F', hostname: 'fh', platform: 'linux' }],
    manifest: async () => ({
      node: 'F',
      datasets: [{ id: 'own-things', syncMode: 'full', ownerNode: 'F', backend: 'cache', scope: 'cluster' }] as ManifestEntry[],
    }),
    exportFrom: async () => {
      exportFromCalls++;
      return [{ id: 'r1', version: 99, fields: {}, deleted: true, createdAt: staleT, updatedAt: staleT } as DataRecord];
    },
    getFrom: async () => null,
  };

  const engine = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: foreign, nodeId: 'B13' });
  const r = await engine.pullDataset('F', 'own-things');

  assert.equal(exportFromCalls, 0, 'the notify-driven pull is refused before any record moves');
  assert.deepEqual(r, { applied: 0, skipped: 0 }, 'a refused pull reports zero work');
  const got = await b.service.get(LOCAL_CTX, 'own-things', 'r1');
  assert.ok(got.ok && got.value !== null, 'the record survives a foreign-cluster bus notify');
});

test('deletion reconciliation: pullDataset still pulls from an allowed (fleet-scope) origin', async () => {
  // The gate must refuse FOREIGN pulls only — the reactive convergence path keeps working.
  const a = svc('A14');
  const b = svc('B14');
  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'hello' }));

  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: bridgePeer('A14', a), nodeId: 'B14' });
  const r = await engineB.pullDataset('A14', 'tickets');
  assert.ok(r.applied >= 1, `fleet-scope pullDataset applies records (got ${JSON.stringify(r)})`);
  assert.ok(await b.backend.get('tickets', 'r1'), 'record arrived via the notify-driven pull');
});
