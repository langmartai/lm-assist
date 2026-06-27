// core/src/__tests__/cluster-map.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterOf, sameClusterIds, clustersOverview, ClusterRecord } from '../cluster/cluster-map';

const recs: ClusterRecord[] = [
  { gatewayId: 'gw4-a', cluster: 'release' },
  { gatewayId: 'gw4-b', cluster: 'release' },
  { gatewayId: 'gw4-c', cluster: 'dev' },
];

describe('clusterOf', () => {
  it('self resolves to local cluster even if the map is stale/missing', () => {
    assert.equal(clusterOf('gw4-a', [], 'gw4-a', 'release'), 'release');
  });
  it('peer resolves from records; unknown → default', () => {
    assert.equal(clusterOf('gw4-c', recs, 'gw4-a', 'release'), 'dev');
    assert.equal(clusterOf('gw4-z', recs, 'gw4-a', 'release'), 'default');
  });
});

describe('sameClusterIds', () => {
  it('keeps only same-cluster online ids (two clusters → disjoint)', () => {
    const online = ['gw4-a', 'gw4-b', 'gw4-c'];
    assert.deepEqual(sameClusterIds(online, recs, 'gw4-a', 'release').sort(), ['gw4-a', 'gw4-b']);
    assert.deepEqual(sameClusterIds(online, recs, 'gw4-c', 'dev'), ['gw4-c']);
  });
  it('all-default fleet (no records) → everyone same cluster', () => {
    const online = ['gw4-a', 'gw4-b', 'gw4-c'];
    assert.deepEqual(sameClusterIds(online, [], 'gw4-a', 'default').sort(), ['gw4-a', 'gw4-b', 'gw4-c']);
  });
});

describe('clustersOverview', () => {
  it('groups members + picks lowest online id as leader', () => {
    const ov = clustersOverview(recs, ['gw4-b', 'gw4-c'], 'gw4-b', 'release');
    const rel = ov.find((c) => c.name === 'release')!;
    assert.equal(rel.leader, 'gw4-b'); // gw4-a offline, gw4-b online
    assert.equal(ov.find((c) => c.name === 'dev')!.leader, 'gw4-c');
  });
});
