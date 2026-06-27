import { test } from 'node:test';
import assert from 'node:assert';
import { computeSchedule, CTL_SERIALIZE_DIM } from '../mission/mission-scheduler';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });

test('ready: a draft mission with no deps is ready', () => {
  const s = computeSchedule([mk('a', { status: 'draft' })]);
  assert.deepEqual(s.ready, ['a']);
  assert.deepEqual(s.blocked, []);
});

test('blocked dependency: waits until the dep is done', () => {
  const s = computeSchedule([mk('a', { status: 'waiting', dependsOn: ['b'] }), mk('b', { status: 'active' })]);
  assert.deepEqual(s.ready, []);
  assert.deepEqual(s.blocked, [{ id: 'a', reason: 'dependency', waitOn: ['b'] }]);
});

test('dependency met: becomes ready when the dep is done', () => {
  const s = computeSchedule([mk('a', { status: 'waiting', dependsOn: ['b'] }), mk('b', { status: 'done' })]);
  assert.deepEqual(s.ready, ['a']);
});

test('containers: a parent with children is a container, never ready; children are scheduled', () => {
  const s = computeSchedule([mk('epic', { status: 'active' }), mk('c1', { status: 'draft', parentId: 'epic' })]);
  assert.deepEqual(s.containers, ['epic']);
  assert.ok(!s.ready.includes('epic'));
  assert.ok(s.ready.includes('c1'));
});

test('epic rollup: all children done -> done, progress 100', () => {
  const s = computeSchedule([mk('epic', { status: 'active' }), mk('c1', { status: 'done', parentId: 'epic' }), mk('c2', { status: 'done', parentId: 'epic' })]);
  assert.deepEqual(s.epicRollups, [{ parentId: 'epic', status: 'done', progressPercent: 100, childCount: 2, doneCount: 2 }]);
});

test('epic rollup: any active -> active; mixed progress', () => {
  const s = computeSchedule([mk('epic', { status: 'waiting' }), mk('c1', { status: 'done', parentId: 'epic' }), mk('c2', { status: 'active', parentId: 'epic' })]);
  assert.deepEqual(s.epicRollups, [{ parentId: 'epic', status: 'active', progressPercent: 50, childCount: 2, doneCount: 1 }]);
});

test('serialize: a non-running member is serialize-blocked when a group member is active', () => {
  const s = computeSchedule([
    mk('a', { status: 'active', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
    mk('b', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
  ]);
  assert.deepEqual(s.serializeGroups, [{ group: 'g', missionIds: ['a', 'b'], running: 'a' }]);
  assert.deepEqual(s.blocked, [{ id: 'b', reason: 'serialize' }]);
});

test('serialize: with no running member, members fall through to normal placement (both ready)', () => {
  const s = computeSchedule([
    mk('a', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
    mk('b', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
  ]);
  assert.equal(s.serializeGroups[0].running, null);
  assert.deepEqual(s.ready.sort(), ['a', 'b']);
});

test('missing parent: a child pointing at a non-existent parent is blocked with reason parent', () => {
  const s = computeSchedule([mk('a', { status: 'draft', parentId: 'ghost' })]);
  assert.deepEqual(s.blocked, [{ id: 'a', reason: 'parent', waitOn: ['ghost'] }]);
});

test('terminal + paused + active are neither ready nor blocked', () => {
  const s = computeSchedule([mk('a', { status: 'done' }), mk('b', { status: 'failed' }), mk('c', { status: 'paused' }), mk('d', { status: 'active' })]);
  assert.deepEqual(s.ready, []);
  assert.deepEqual(s.blocked, []);
});

test('epic rollup: no active, some blocked -> blocked (progress 0)', () => {
  const s = computeSchedule([mk('epic', { status: 'waiting' }), mk('c1', { status: 'blocked', parentId: 'epic' }), mk('c2', { status: 'waiting', parentId: 'epic' })]);
  assert.deepEqual(s.epicRollups, [{ parentId: 'epic', status: 'blocked', progressPercent: 0, childCount: 2, doneCount: 0 }]);
});

test('resource conflict: a held exclusive resource blocks another mission with reason resource', () => {
  const s = computeSchedule([
    mk('a', { status: 'active', env: { isolation: 'shared', host: 'h', resources: ['db'], exclusive: true } }),
    mk('b', { status: 'waiting', env: { isolation: 'shared', host: 'h', resources: ['db'] } }),
  ]);
  assert.deepEqual(s.blocked, [{ id: 'b', reason: 'resource' }]);
});

test('serialize: a done member is not serialize-blocked; only non-terminal non-running members are', () => {
  const s = computeSchedule([
    mk('a', { status: 'active', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
    mk('b', { status: 'done', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
    mk('c', { status: 'waiting', tags: { [CTL_SERIALIZE_DIM]: ['g'] } }),
  ]);
  assert.deepEqual(s.blocked, [{ id: 'c', reason: 'serialize' }]);
});
