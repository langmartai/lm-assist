import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordsToClusterRecords } from '../cluster/cluster-store';

describe('recordsToClusterRecords', () => {
  it('maps data rows to ClusterRecord, normalizing cluster + skipping junk', () => {
    const rows = [
      { id: 'gw4-a', fields: { gatewayId: 'gw4-a', cluster: 'Release', hostname: 'h1' } },
      { id: 'gw4-b', fields: { gatewayId: 'gw4-b', cluster: '', hostname: 'h2' } },
      { id: 'x', fields: { hostname: 'no-gw' } },
    ];
    const out = recordsToClusterRecords(rows as any);
    assert.deepEqual(out, [
      { gatewayId: 'gw4-a', cluster: 'release', hostname: 'h1' },
      { gatewayId: 'gw4-b', cluster: 'default', hostname: 'h2' },
    ]);
  });
});
