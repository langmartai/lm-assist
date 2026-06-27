import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../data/sync-engine';

// Regression: fleet-scoped metadata datasets (node-clusters, cluster-meta) are
// tiny + multi-writer. A single global per-dataset watermark drops a peer's older
// record once another peer's newer record advances `since` past it → the cluster
// map never fully converges and cluster_assign-by-hostname breaks. pullOne must
// FULL-pull (since=undefined) fleet datasets, but keep the incremental watermark
// for (potentially large) cluster-scoped datasets.

function makeEngine(localRecords: Array<{ id: string; updatedAt: string }>) {
  let capturedSince: string | undefined = 'UNSET' as any;
  const backend = {
    exportSince: async () => localRecords,
    importBatch: async () => ({ applied: 0, skipped: 0 }),
  };
  const deps = {
    datasets: { upsertReplica: () => {} },
    backends: { get: () => backend },
    peers: {
      exportFrom: async (_node: string, _id: string, since?: string) => {
        capturedSince = since;
        return [];
      },
    },
    nodeId: 'self',
  };
  const engine = new SyncEngine(deps as any);
  const peer = { node: 'peer', hostname: 'h', platform: 'linux' };
  return {
    pull: (entry: any) => (engine as any).pullOne(peer, entry),
    getSince: () => capturedSince,
  };
}

const fleetEntry = { id: 'node-clusters', backend: 'cache', syncMode: 'full', scope: 'fleet', ownerNode: 'peer' };
const clusterEntry = { id: 'missions', backend: 'cache', syncMode: 'full', scope: 'cluster', ownerNode: 'peer' };

test('pullOne full-pulls a fleet dataset (since=undefined) even with local records', async () => {
  const { pull, getSince } = makeEngine([{ id: 'a', updatedAt: '2026-05-01T00:00:00.000Z' }]);
  await pull(fleetEntry);
  assert.equal(getSince(), undefined);
});

test('pullOne uses the incremental watermark for a cluster-scoped dataset', async () => {
  const { pull, getSince } = makeEngine([
    { id: 'a', updatedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'b', updatedAt: '2026-06-01T00:00:00.000Z' },
  ]);
  await pull(clusterEntry);
  assert.equal(getSince(), '2026-06-01T00:00:00.000Z');
});

test('cluster-scoped dataset with no local records has no watermark', async () => {
  const { pull, getSince } = makeEngine([]);
  await pull(clusterEntry);
  assert.equal(getSince(), undefined);
});
