import { test } from 'node:test';
import assert from 'node:assert';
import { withActorBackfill } from '../mission/mission-model';

test('withActorBackfill synthesizes provenance for a legacy mission', () => {
  const legacy: any = {
    id: 'mission_x', ownerNode: 'gw4-o', createdAt: 7, updatedAt: 9,
    adjustments: [{ at: 8, trigger: 'controller', change: 'c', by: 'controller' }],
  };
  const m = withActorBackfill(legacy);
  assert.equal(m.createdBy.kind, 'user');
  assert.equal(m.createdBy.node, 'gw4-o');
  assert.equal(m.createdBy.at, 7);
  assert.deepEqual(m.lastUpdatedBy, m.createdBy);
  assert.equal(m.adjustments[0].actor.kind, 'controller');
  assert.equal(m.adjustments[0].actor.node, 'gw4-o');
});

test('withActorBackfill preserves present provenance', () => {
  const who: any = { kind: 'ccr', id: 'cse_1', channel: 'mcp', at: 1 };
  const m = withActorBackfill({ id: 'm', ownerNode: 'n', createdAt: 1, updatedAt: 1,
    createdBy: who, lastUpdatedBy: who, adjustments: [] } as any);
  assert.deepEqual(m.createdBy, who);
});
