// core/src/__tests__/data/sync-engine.test.ts
// Unit tests for SyncEngine (full-mode pull) using a fake PeerClient.
// Two in-process data services: A owns a 'full' dataset, B pulls via a fake peer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Each test node needs an isolated LM_ASSIST_DATA_DIR to avoid path collisions.
// We set it once per process here and rely on per-svc() temp dirs for the LMDB files.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-se-'));

import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DataService } from '../../data/data-service';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { SyncEngine } from '../../data/sync-engine';
import type { PeerClient, DataRecord, ManifestEntry, NodeInfo } from '../../data/types';

// ── Helper to build an isolated DataService + its raw backend ───────────────

function svc(nodeId: string) {
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), `r-${nodeId}-`)), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), `k-${nodeId}-`)));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `c-${nodeId}-`));
  const backend = new CacheBackend(cacheDir);
  const backends = new BackendRegistry();
  backends.register(backend);
  const manager = new AccessManager({ datasets, keys, nodeId });
  const service = new DataService({ datasets, backends, manager });
  (service as any).enabledOverride = true;
  return { service, datasets, backends, backend };
}

const LOCAL_CTX = { principal: { type: 'local' as const } };

function mkRecord(id: string, fields: Record<string, unknown> = {}): DataRecord {
  return { id, version: 0, fields, createdAt: '', updatedAt: '' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('SyncEngine: full reconcile replicates records from peer A to B', async () => {
  const a = svc('A');
  const b = svc('B');

  // Set up dataset 'tickets' on A with syncMode 'full'
  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);

  // Put two records on A
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'Bug #1' }));
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r2', { title: 'Feature #1' }));

  // Fake PeerClient for B: bridges directly to A's backend + datasets
  const fakePeer: PeerClient = {
    listPeers: async (): Promise<NodeInfo[]> => [{ node: 'A', hostname: 'hostA', platform: 'linux' }],
    manifest: async (_node: string) => ({
      node: 'A',
      datasets: [{ id: 'tickets', syncMode: 'full', ownerNode: 'A', backend: 'cache' }] as ManifestEntry[],
    }),
    exportFrom: async (_node: string, ds: string, since?: string) =>
      a.backend.exportSince(ds, since),
    getFrom: async (_node: string, ds: string, id: string) =>
      a.backend.get(ds, id),
  };

  const engineB = new SyncEngine({
    datasets: b.datasets,
    backends: b.backends,
    peers: fakePeer,
    nodeId: 'B',
  });

  // Run reconcile
  const status = await engineB.reconcile();

  // 1. Replica descriptor registered on B
  const replica = b.datasets.get('tickets');
  assert.ok(replica, 'replica descriptor must be present on B');
  assert.equal(replica.origin?.machineId, 'A', 'origin.machineId should be A');

  // 2. Records replicated to B
  const gotR1 = await b.backend.get('tickets', 'r1');
  assert.ok(gotR1, 'r1 must be present on B');
  assert.equal(gotR1.fields.title, 'Bug #1', 'r1 fields match A');

  // Version is preserved (not re-versioned by engine — importBatch stamps origin, not version)
  const aR1 = await a.backend.get('tickets', 'r1');
  assert.equal(gotR1.version, aR1!.version, 'version matches A');

  // Status counters
  assert.equal(status.peersChecked, 1);
  assert.equal(status.datasetsReplicated, 1);
  assert.ok(status.recordsApplied >= 2, `expected >= 2 applied, got ${status.recordsApplied}`);
  assert.equal(status.errors.length, 0, 'no errors');
});

test('SyncEngine: second reconcile is idempotent (applied=0)', async () => {
  const a = svc('A2');
  const b = svc('B2');

  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'Bug' }));

  const fakePeer: PeerClient = {
    listPeers: async () => [{ node: 'A2', hostname: 'hA', platform: 'linux' }],
    manifest: async () => ({
      node: 'A2',
      datasets: [{ id: 'tickets', syncMode: 'full', ownerNode: 'A2', backend: 'cache' }] as ManifestEntry[],
    }),
    exportFrom: async (_n, ds, since) => a.backend.exportSince(ds, since),
    getFrom: async (_n, ds, id) => a.backend.get(ds, id),
  };

  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: fakePeer, nodeId: 'B2' });

  // First pull
  await engineB.reconcile();

  // Second pull — same data, nothing new
  const status2 = await engineB.reconcile();
  assert.equal(status2.recordsApplied, 0, 'idempotent: 0 applied on second run');
  assert.equal(status2.errors.length, 0);
});

test('SyncEngine: update on A propagates to B on next reconcile (convergence)', async () => {
  const a = svc('A3');
  const b = svc('B3');

  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'v1' }));

  const fakePeer: PeerClient = {
    listPeers: async () => [{ node: 'A3', hostname: 'hA', platform: 'linux' }],
    manifest: async () => ({
      node: 'A3',
      datasets: [{ id: 'tickets', syncMode: 'full', ownerNode: 'A3', backend: 'cache' }] as ManifestEntry[],
    }),
    exportFrom: async (_n, ds, since) => a.backend.exportSince(ds, since),
    getFrom: async (_n, ds, id) => a.backend.get(ds, id),
  };

  const engineB = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: fakePeer, nodeId: 'B3' });

  // Initial pull
  await engineB.reconcile();
  const bR1v1 = await b.backend.get('tickets', 'r1');
  assert.equal(bR1v1?.version, 1, 'B sees version 1');

  // Update r1 on A (version bumps to 2)
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'v2' }));
  const aR1v2 = await a.backend.get('tickets', 'r1');
  assert.equal(aR1v2?.version, 2, 'A now has version 2');

  // Pull again — B should converge to v2
  const status3 = await engineB.reconcile();
  const bR1v2 = await b.backend.get('tickets', 'r1');
  assert.equal(bR1v2?.version, 2, 'B converges to version 2 after second reconcile');
  assert.ok(status3.recordsApplied >= 1, `expected >= 1 applied for update, got ${status3.recordsApplied}`);
  assert.equal(status3.errors.length, 0);
});
