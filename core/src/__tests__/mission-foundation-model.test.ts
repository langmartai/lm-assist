import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, withActorBackfill, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'n', at: 1 };

test('newMission seeds tags/parentId/rev/history defaults', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: actor }, 1000, () => 'mission_x');
  assert.deepEqual(m.tags, {});
  assert.equal(m.parentId, null);
  assert.equal(m.rev, 1);
  assert.deepEqual(m.history, []);
});

test('newMission carries provided tags + parentId', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: actor, tags: { project: ['p'] }, parentId: 'mission_p' }, 1000, () => 'mission_x');
  assert.deepEqual(m.tags, { project: ['p'] });
  assert.equal(m.parentId, 'mission_p');
});

test('withActorBackfill synthesizes new fields on a legacy record', () => {
  const legacy = { id: 'mission_y', title: 't', objective: 'o', dependsOn: [], projects: [], env: { isolation: 'cloud', resources: [] }, status: 'active', binding: null, progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [], ownerNode: 'n', createdAt: 1, updatedAt: 1 } as unknown as Mission;
  const m = withActorBackfill(legacy);
  assert.deepEqual(m.tags, {});
  assert.equal(m.parentId, null);
  assert.equal(m.rev, 1);
  assert.deepEqual(m.history, []);
});
