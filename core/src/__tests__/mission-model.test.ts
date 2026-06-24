import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, coarseActor } from '../mission/mission-model';

test('newMission fills defaults and starts active', () => {
  const m = newMission(
    { title: 'T', objective: 'Do X', ownerNode: 'gw4-1', createdBy: coarseActor('api', 'gw4-1', 1000) },
    1000,
    () => 'mission_abc',
  );
  assert.strictEqual(m.id, 'mission_abc');
  assert.strictEqual(m.status, 'active');
  assert.strictEqual(m.env.isolation, 'cloud');
  assert.deepStrictEqual(m.env.resources, []);
  assert.deepStrictEqual(m.dependsOn, []);
  assert.deepStrictEqual(m.projects, []);
  assert.strictEqual(m.binding, null);
  assert.strictEqual(m.progress, null);
  assert.deepStrictEqual(m.control, { nudgeCount: 0, backoffStep: 0 });
  assert.strictEqual(m.ownerNode, 'gw4-1');
  assert.strictEqual(m.createdAt, 1000);
});

test('newMission honors provided env + dependsOn', () => {
  const m = newMission(
    { title: 'T', objective: 'O', ownerNode: 'gw4-1', dependsOn: ['mission_x'], env: { isolation: 'worktree', repo: 'lm-assist', resources: ['port:3000'] }, createdBy: coarseActor('api', 'gw4-1', 1) },
    1, () => 'mission_y',
  );
  assert.strictEqual(m.env.isolation, 'worktree');
  assert.strictEqual(m.env.repo, 'lm-assist');
  assert.deepStrictEqual(m.env.resources, ['port:3000']);
  assert.deepStrictEqual(m.dependsOn, ['mission_x']);
});

test('coarseActor builds a user actor for a plain channel', () => {
  const a = coarseActor('api', 'gw4-x', 1000);
  assert.equal(a.kind, 'user');
  assert.equal(a.channel, 'api');
  assert.equal(a.node, 'gw4-x');
  assert.equal(a.at, 1000);
});

test('coarseActor builds a controller actor for the controller channel', () => {
  assert.equal(coarseActor('controller', 'gw4-x', 1).kind, 'controller');
});

test('newMission stamps createdBy and mirrors it to lastUpdatedBy', () => {
  const who = coarseActor('mcp', 'gw4-n', 5);
  const m = newMission(
    { title: 't', objective: 'o', ownerNode: 'gw4-n', createdBy: who },
    5, () => 'mission_abc',
  );
  assert.deepEqual(m.createdBy, who);
  assert.deepEqual(m.lastUpdatedBy, who);
  assert.deepEqual(m.adjustments, []);
});
