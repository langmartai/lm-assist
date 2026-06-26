import { test } from 'node:test';
import assert from 'node:assert';
import { diffMission, appendHistory } from '../mission/mission-history';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => 'mission_a'), ...over });

test('diffMission detects a tracked field change', () => {
  const a = mk({ status: 'active' });
  const b = mk({ status: 'done' });
  const d = diffMission(a, b);
  assert.deepEqual(d, { status: { from: 'active', to: 'done' } });
});

test('diffMission ignores untracked churn (progress/control/binding)', () => {
  const a = mk();
  const b = mk();
  b.progress = { percent: 50, summary: 's', updatedAt: 2 };
  b.control = { nudgeCount: 9, backoffStep: 3 };
  assert.deepEqual(diffMission(a, b), {});
});

test('diffMission keys tag changes per dimension', () => {
  const a = mk({ tags: { component: ['controller'] } });
  const b = mk({ tags: { component: ['controller', 'web'] } });
  assert.deepEqual(diffMission(a, b), { 'tags.component': { from: ['controller'], to: ['controller', 'web'] } });
});

test('diffMission truncates long string values', () => {
  const big = 'x'.repeat(600);
  const d = diffMission(mk({ objective: 'o' }), mk({ objective: big }));
  assert.equal((d.objective.to as string).startsWith('x'.repeat(500)), true);
  assert.ok((d.objective.to as string).includes('len 600'));
});

test('appendHistory bumps rev, appends, trims to inlineCap, returns change', () => {
  let cur = mk({ rev: 5, history: [] });
  const r = appendHistory(mk({ rev: 5, status: 'done' }), cur, actor, 2);
  assert.equal(r.change?.rev, 6);
  assert.equal(r.mission.rev, 6);
  assert.equal(r.mission.history.length, 1);
  // cap: push two more (revs from old) -> only last 2 kept
  const m2 = appendHistory(mk({ rev: 6, status: 'paused', history: r.mission.history }), mk({ rev: 6, status: 'done', history: r.mission.history }), actor, 2).mission;
  const m3 = appendHistory(mk({ rev: 7, status: 'blocked', history: m2.history }), mk({ rev: 7, status: 'paused', history: m2.history }), actor, 2).mission;
  assert.equal(m3.history.length, 2);
});

test('appendHistory on empty diff returns null change and no rev bump', () => {
  const same = mk({ rev: 4 });
  const r = appendHistory(mk({ rev: 4 }), same, actor, 50);
  assert.equal(r.change, null);
  assert.equal(r.mission.rev, 4);
});
