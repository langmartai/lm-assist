import { test } from 'node:test';
import assert from 'node:assert';
import { filterMissions, missionFieldValue, FilterError, type MissionFilter } from '../mission/mission-filter';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
const f = (field: string, op: MissionFilter['op'], value: unknown, flags?: string): MissionFilter => ({ field, op, value, flags });

test('missionFieldValue resolves tag dimensions and top-level fields', () => {
  const m = mk('a', { status: 'active', tags: { component: ['web', 'api'] } });
  assert.equal(missionFieldValue(m, 'status'), 'active');
  assert.deepEqual(missionFieldValue(m, 'tags.component'), ['web', 'api']);
  assert.equal(missionFieldValue(m, 'tags.missing'), undefined);
});

test('scalar ops filter on status', () => {
  const ms = [mk('a', { status: 'active' }), mk('b', { status: 'done' })];
  assert.deepEqual(filterMissions(ms, [f('status', 'eq', 'active')]).map((m) => m.id), ['a']);
  assert.deepEqual(filterMissions(ms, [f('status', 'in', ['done', 'failed'])]).map((m) => m.id), ['b']);
  assert.deepEqual(filterMissions(ms, [f('status', 'ne', 'active')]).map((m) => m.id), ['b']);
});

test('array ops on tag dimensions + dependsOn', () => {
  const ms = [mk('a', { tags: { component: ['web'] }, dependsOn: ['x'] }), mk('b', { tags: { component: ['api'] } })];
  assert.deepEqual(filterMissions(ms, [f('tags.component', 'contains', 'web')]).map((m) => m.id), ['a']);
  assert.deepEqual(filterMissions(ms, [f('tags.component', 'in', ['api', 'cli'])]).map((m) => m.id), ['b']);
  assert.deepEqual(filterMissions(ms, [f('tags.component', 'exists', true)]).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(filterMissions(ms, [f('dependsOn', 'contains', 'x')]).map((m) => m.id), ['a']);
});

test('regex + sort + limit; AND of clauses', () => {
  const ms = [mk('a', { title: 'alpha', status: 'active' }), mk('b', { title: 'beta', status: 'active' }), mk('c', { title: 'gamma', status: 'done' })];
  assert.deepEqual(filterMissions(ms, [f('title', 'regex', '^a|^b', 'i'), f('status', 'eq', 'active')]).map((m) => m.id).sort(), ['a', 'b']);
  assert.deepEqual(filterMissions(ms, undefined, { sort: [{ field: 'title', dir: 'desc' }], limit: 2 }).map((m) => m.id), ['c', 'b']);
});

test('bad op + bad regex throw FilterError with codes', () => {
  assert.throws(() => filterMissions([mk('a')], [f('status', 'bogus' as any, 'x')]), (e) => e instanceof FilterError && e.code === 'BAD_FILTER_OP');
  assert.throws(() => filterMissions([mk('a')], [f('title', 'regex', '(')]), (e) => e instanceof FilterError && e.code === 'BAD_REGEX');
});
