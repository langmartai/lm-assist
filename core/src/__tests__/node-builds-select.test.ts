import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFleetNodes } from '../mcp-server/tools/node-builds';

const SELF = 'gw-self';

test('excludes offline/stale entries — only online nodes + self', () => {
  const machines = [
    { gatewayId: 'gw-self', hostname: 'self-host', status: 'online' },
    { gatewayId: 'gw-a', hostname: 'node-a', status: 'online' },
    { gatewayId: 'gw-stale', hostname: 'node-a', status: 'offline' },
    { gatewayId: 'gw-b', hostname: 'node-b', status: 'OFFLINE' },
  ];
  const out = selectFleetNodes(machines, SELF, 'self-host');
  const ids = out.map((n) => n.nodeId).sort();
  assert.deepEqual(ids, ['gw-a', 'gw-self']);
});

test('marks the self entry isSelf and does not duplicate it', () => {
  const machines = [
    { gatewayId: 'gw-self', hostname: 'self-host', status: 'online' },
    { gatewayId: 'gw-a', hostname: 'node-a', status: 'online' },
  ];
  const out = selectFleetNodes(machines, SELF, 'self-host');
  assert.equal(out.filter((n) => n.isSelf).length, 1);
  assert.ok(out.find((n) => n.nodeId === 'gw-self')?.isSelf);
});

test('always includes self even when absent/offline in the hub list', () => {
  const machines = [
    { gatewayId: 'gw-self', hostname: 'self-host', status: 'offline' },
    { gatewayId: 'gw-a', hostname: 'node-a', status: 'online' },
  ];
  const out = selectFleetNodes(machines, SELF, 'self-host');
  const self = out.find((n) => n.nodeId === 'gw-self');
  assert.ok(self && self.isSelf, 'self must be present and flagged');
  assert.ok(out.some((n) => n.nodeId === 'gw-a'));
});

test('empty / all-offline list → self only', () => {
  assert.deepEqual(
    selectFleetNodes([], SELF, 'self-host').map((n) => n.nodeId),
    ['gw-self'],
  );
  assert.deepEqual(
    selectFleetNodes([{ gatewayId: 'gw-x', status: 'offline' }], SELF, 'self-host').map((n) => n.nodeId),
    ['gw-self'],
  );
});
