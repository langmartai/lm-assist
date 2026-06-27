// core/src/__tests__/data/sync-engine-scope.test.ts
// Unit tests for shouldPullDataset scope filtering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPullDataset } from '../../data/sync-engine';
import type { ClusterRecord } from '../../cluster/cluster-map';

test('shouldPullDataset', async (t) => {
  const recs: ClusterRecord[] = [{ gatewayId: 'B', cluster: 'dev' }];

  await t.test('fleet-scope datasets pull from any peer', () => {
    // scope 'fleet' always returns true regardless of cluster mismatch
    const result = shouldPullDataset('fleet', 'B', recs, 'A', 'release');
    assert.equal(result, true, 'fleet scope should pull from any peer');
  });

  await t.test('cluster-scope pulls only same-cluster peers', () => {
    // B is in 'dev' cluster, I am in 'release' cluster => should not pull
    const resultMismatch = shouldPullDataset('cluster', 'B', recs, 'A', 'release');
    assert.equal(resultMismatch, false, 'cluster scope should skip different-cluster peers');

    // B is in 'dev' cluster, I am also in 'dev' cluster => should pull
    const resultSame = shouldPullDataset('cluster', 'B', recs, 'A', 'dev');
    assert.equal(resultSame, true, 'cluster scope should pull same-cluster peers');
  });

  await t.test('undefined scope defaults to cluster scope', () => {
    // undefined defaults to cluster mode
    // B is in 'dev', I am in 'dev' => should pull
    const resultSame = shouldPullDataset(undefined, 'B', recs, 'A', 'dev');
    assert.equal(resultSame, true, 'undefined scope should default to cluster and pull same-cluster peers');

    // B is in 'dev', I am in 'release' => should not pull
    const resultMismatch = shouldPullDataset(undefined, 'B', recs, 'A', 'release');
    assert.equal(resultMismatch, false, 'undefined scope should default to cluster and skip different-cluster peers');
  });

  await t.test('self cluster is authoritative even if not in records', () => {
    // When checking peer 'A' (myself) against self cluster 'production'
    // The clusterOf function should use selfCluster when gatewayId === selfId
    const resultSelf = shouldPullDataset('cluster', 'A', recs, 'A', 'production');
    assert.equal(resultSelf, true, 'should pull from self (cluster scope, same-cluster by definition)');
  });

  await t.test('unknown peer defaults to default cluster', () => {
    // Peer 'C' is not in records => should resolve to 'default' cluster
    // I am in 'default' cluster => should pull
    const resultDefault = shouldPullDataset('cluster', 'C', recs, 'A', 'default');
    assert.equal(resultDefault, true, 'unknown peer should resolve to default cluster');

    // I am in 'release' cluster => should not pull
    const resultMismatch = shouldPullDataset('cluster', 'C', recs, 'A', 'release');
    assert.equal(resultMismatch, false, 'unknown peer in default should not match my non-default cluster');
  });
});
