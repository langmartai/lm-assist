import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccessManager } from '../data/access-manager';
import { CLUSTER_ACL } from '../cluster/cluster-store';
import type { DatasetDescriptor, Principal } from '../data/types';

// Regression for the fleet cluster-map convergence bug: a relayed cross-node sync
// request resolves to a {type:'cloud'} principal (api-relay tags x-relay-source:hub).
// evaluateGrants intersects the requested actions with the dataset's ACL rules that
// match the principal — so WITHOUT an ACL a cloud peer gets zero grants, the dataset
// is omitted from the cross-node sync manifest, and the node-clusters map never
// converges. CLUSTER_ACL grants '*':read so any peer can pull it.

function mgr(): AccessManager {
  // evaluateGrants only reads the descriptor + principal; deps are unused here.
  return new AccessManager({ datasets: {} as any, keys: {} as any, nodeId: 'n1' });
}

function dataset(acl: DatasetDescriptor['acl']): DatasetDescriptor {
  return {
    id: 'node-clusters',
    backend: 'cache',
    ownerNode: 'n1',
    visibility: 'cross-node-readable',
    syncMode: 'full',
    scope: 'fleet',
    acl,
    config: { kind: 'cache' } as any,
    createdAt: '',
    updatedAt: '',
  };
}

describe('CLUSTER_ACL grants cross-node peers read (map convergence)', () => {
  const cloud: Principal = { type: 'cloud', userId: undefined };

  it('a cloud (relayed peer) principal gets read with CLUSTER_ACL', () => {
    assert.deepEqual(mgr().evaluateGrants(cloud, dataset(CLUSTER_ACL), ['read']), ['read']);
  });

  it('the bug: an EMPTY acl denies the cloud peer (dataset invisible to sync manifest)', () => {
    assert.deepEqual(mgr().evaluateGrants(cloud, dataset([]), ['read']), []);
  });

  it('CLUSTER_ACL keeps writes local-only (no cloud write/delete/manage)', () => {
    assert.deepEqual(mgr().evaluateGrants(cloud, dataset(CLUSTER_ACL), ['write', 'delete', 'manage']), []);
  });

  it('CLUSTER_ACL has a wildcard read rule', () => {
    const wild = CLUSTER_ACL.find((r) => r.principal === '*');
    assert.ok(wild && wild.actions.includes('read'), 'expected a {principal:"*"} rule granting read');
  });
});
