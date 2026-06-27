// core/src/__tests__/cluster-routes.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNodeId } from '../routes/core/cluster.routes';
import type { ClusterRecord } from '../cluster/cluster-map';

const recs: ClusterRecord[] = [{ gatewayId: 'gw4-a', cluster: 'release', hostname: 'alpha' }];
const online = ['gw4-a', 'gw4-b'];

describe('resolveNodeId', () => {
  it('passes a gatewayId through', () => {
    assert.equal(resolveNodeId('gw4-b', recs, online), 'gw4-b');
  });
  it('resolves a hostname via records', () => {
    assert.equal(resolveNodeId('alpha', recs, online), 'gw4-a');
  });
  it('unknown → null', () => {
    assert.equal(resolveNodeId('nope', recs, online), null);
  });
});
