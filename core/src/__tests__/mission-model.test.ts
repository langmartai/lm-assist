import { test } from 'node:test';
import assert from 'node:assert';
import { newMission } from '../mission/mission-model';

test('newMission fills defaults and starts active', () => {
  const m = newMission(
    { title: 'T', objective: 'Do X', ownerNode: 'gw4-1' },
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
    { title: 'T', objective: 'O', ownerNode: 'gw4-1', dependsOn: ['mission_x'], env: { isolation: 'worktree', repo: 'lm-assist', resources: ['port:3000'] } },
    1, () => 'mission_y',
  );
  assert.strictEqual(m.env.isolation, 'worktree');
  assert.strictEqual(m.env.repo, 'lm-assist');
  assert.deepStrictEqual(m.env.resources, ['port:3000']);
  assert.deepStrictEqual(m.dependsOn, ['mission_x']);
});
