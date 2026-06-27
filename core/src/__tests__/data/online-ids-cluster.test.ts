import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOnlineToCluster } from '../../data/peer-client';
import { electMonitor } from '../../monitor/stall-election';

test('per-cluster election', async (t) => {
  const recs = [
    { gatewayId: 'gw4-a', cluster: 'release' },
    { gatewayId: 'gw4-b', cluster: 'release' },
    { gatewayId: 'gw4-c', cluster: 'dev' },
  ];

  await t.test('each cluster elects its own lowest-id leader', () => {
    const all = ['gw4-a', 'gw4-b', 'gw4-c'];
    const relOnline = filterOnlineToCluster(all, recs as any, 'gw4-b', 'release');
    const devOnline = filterOnlineToCluster(all, recs as any, 'gw4-c', 'dev');

    assert.deepStrictEqual(relOnline, ['gw4-a', 'gw4-b'], 'release cluster should have gw4-a and gw4-b');
    assert.deepStrictEqual(devOnline, ['gw4-c'], 'dev cluster should have only gw4-c');

    assert.strictEqual(electMonitor(relOnline, 'gw4-a'), true, 'gw4-a should be leader in release (lowest)');
    assert.strictEqual(electMonitor(relOnline, 'gw4-b'), false, 'gw4-b should not be leader in release');
    assert.strictEqual(electMonitor(devOnline, 'gw4-c'), true, 'gw4-c should be leader in dev (only node)');
  });
});
