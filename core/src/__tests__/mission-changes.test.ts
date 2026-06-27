import { test } from 'node:test';
import assert from 'node:assert';
import { recentExternalChanges } from '../mission/mission-changes';
import { newMission, type Mission, type MissionActor, type MissionChange } from '../mission/mission-model';

const user: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 10 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', node: 'n', at: 10 };
const mk = (id: string, history: MissionChange[]): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: user }, 1, () => id), id, history });

test('excludes controller-channel changes, keeps external ones', () => {
  const m = mk('a', [
    { rev: 1, at: 100, actor: ctrl, changes: { 'ctl:readiness': { from: null, to: 'ready' } } },
    { rev: 2, at: 200, actor: user, changes: { objective: { from: 'o', to: 'o2' } } },
  ]);
  const r = recentExternalChanges([m]);
  assert.equal(r.length, 1);
  assert.equal(r[0].rev, 2);
  assert.deepEqual(r[0].changedFields, ['objective']);
});

test('sinceRev boundary: rev <= since is excluded', () => {
  const m = mk('a', [
    { rev: 1, at: 100, actor: user, changes: { title: { from: 'a', to: 'a1' } } },
    { rev: 2, at: 200, actor: user, changes: { title: { from: 'a1', to: 'a2' } } },
  ]);
  const r = recentExternalChanges([m], { sinceRev: { a: 1 } });
  assert.deepEqual(r.map((c) => c.rev), [2]);
});

test('newest-first ordering across missions', () => {
  const a = mk('a', [{ rev: 5, at: 500, actor: user, changes: { title: { from: 'x', to: 'y' } } }]);
  const b = mk('b', [{ rev: 9, at: 900, actor: user, changes: { title: { from: 'x', to: 'y' } } }]);
  const r = recentExternalChanges([a, b]);
  assert.deepEqual(r.map((c) => c.missionId), ['b', 'a']);
});

test('empty history yields nothing', () => {
  assert.deepEqual(recentExternalChanges([mk('a', [])]), []);
});

test('sinceTs boundary: at <= sinceTs excluded, at > sinceTs included', () => {
  const m = mk('a', [
    { rev: 1, at: 100, actor: user, changes: { title: { from: 'a', to: 'a1' } } },
    { rev: 2, at: 200, actor: user, changes: { title: { from: 'a1', to: 'a2' } } },
  ]);
  const r = recentExternalChanges([m], { sinceTs: 100 });
  assert.deepEqual(r.map((c) => c.rev), [2]);
});

test('sort tie-breaker: equal at -> higher rev first', () => {
  const a = mk('a', [{ rev: 3, at: 500, actor: user, changes: { title: { from: 'x', to: 'y' } } }]);
  const b = mk('b', [{ rev: 7, at: 500, actor: user, changes: { title: { from: 'x', to: 'y' } } }]);
  const r = recentExternalChanges([a, b]);
  assert.deepEqual(r.map((c) => c.rev), [7, 3]);
});

test('custom excludeChannel filters that channel instead of controller', () => {
  const m = mk('a', [
    { rev: 1, at: 100, actor: { kind: 'user', channel: 'mcp', node: 'n', at: 100 }, changes: { title: { from: 'a', to: 'a1' } } },
    { rev: 2, at: 200, actor: ctrl, changes: { 'ctl:readiness': { from: null, to: 'ready' } } },
  ]);
  const r = recentExternalChanges([m], { excludeChannel: 'mcp' });
  assert.deepEqual(r.map((c) => c.rev), [2]);
});
