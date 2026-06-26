import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTags, mergeTags, validateParent, validateDependsOn } from '../mission/mission-graph';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });

test('normalizeTags trims+lowercases dims, dedups+drops-empty values', () => {
  assert.deepEqual(normalizeTags({ ' Component ': ['web', 'web', ' '], Empty: [] }), { component: ['web'] });
});

test('mergeTags add/remove/set', () => {
  assert.deepEqual(mergeTags({ c: ['a'] }, { add: { c: ['b'] } }), { c: ['a', 'b'] });
  assert.deepEqual(mergeTags({ c: ['a', 'b'] }, { remove: { c: ['a'] } }), { c: ['b'] });
  assert.deepEqual(mergeTags({ c: ['a'] }, { set: { c: ['x', 'y'] } }), { c: ['x', 'y'] });
});

test('validateParent: self, missing, ancestor-cycle rejected; valid ok', () => {
  const a = mk('a'), b = mk('b', { parentId: 'a' });
  assert.equal(validateParent('a', 'a', [a]).ok, false);
  assert.equal(validateParent('a', 'zzz', [a]).ok, false);
  // a's parent = b, b's parent = a  -> cycle
  const aWithParent = mk('a', { parentId: 'b' });
  assert.equal(validateParent('a', 'b', [aWithParent, b]).ok, false);
  assert.equal(validateParent('c', 'a', [a, mk('c')]).ok, true);
});

test('validateDependsOn: self, missing, cycle rejected; valid DAG ok', () => {
  const a = mk('a'), b = mk('b', { dependsOn: ['a'] });
  assert.equal(validateDependsOn('a', ['a'], [a]).ok, false);
  assert.equal(validateDependsOn('a', ['zzz'], [a]).ok, false);
  // a depends on b, b depends on a -> cycle
  assert.equal(validateDependsOn('a', ['b'], [mk('a', { dependsOn: ['b'] }), b]).ok, false);
  assert.equal(validateDependsOn('c', ['a'], [a, b, mk('c')]).ok, true);
});
