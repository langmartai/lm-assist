import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFleetNodes } from '../mcp-server/tools/node-builds';
import type { ClusterRecord } from '../cluster/cluster-map';

const machines = [
  { gatewayId: 'gw4-a', hostname: 'h-a', status: 'online' },
  { gatewayId: 'gw4-b', hostname: 'h-b', status: 'online' },
  { gatewayId: 'gw4-c', hostname: 'h-c', status: 'online' },
];

const records: ClusterRecord[] = [
  { gatewayId: 'gw4-a', cluster: 'release' },
  { gatewayId: 'gw4-b', cluster: 'release' },
  { gatewayId: 'gw4-c', cluster: 'dev' },
];

test('selectFleetNodes cluster target: no filter → all online (backward compatible)', () => {
  const result = selectFleetNodes(machines, 'gw4-a', 'h-a');
  const ids = result.map((n) => n.nodeId).sort();
  assert.deepEqual(ids, ['gw4-a', 'gw4-b', 'gw4-c']);
});

test('selectFleetNodes cluster target: self-cluster → only my cluster', () => {
  const result = selectFleetNodes(machines, 'gw4-a', 'h-a', {
    records,
    selfCluster: 'release',
    target: 'self-cluster',
  });
  const ids = result.map((n) => n.nodeId).sort();
  assert.deepEqual(ids, ['gw4-a', 'gw4-b']);
});

test('selectFleetNodes cluster target: named cluster → that cluster', () => {
  const result = selectFleetNodes(machines, 'gw4-a', 'h-a', {
    records,
    selfCluster: 'release',
    target: 'dev',
  });
  const ids = result.map((n) => n.nodeId);
  assert.deepEqual(ids, ['gw4-c']);
});
