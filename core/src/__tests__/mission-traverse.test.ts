import { test } from 'node:test';
import assert from 'node:assert';
import { neighbors, subgraphEdges, toNode } from '../mission/mission-traverse';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'mcp', node: 'n', at: 1 };
const mk = (id: string, over: Partial<Mission> = {}): Mission => ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: actor }, 1, () => id), id, ...over });
// parent: a->b->c (b parent a, c parent b);  deps: d depends on e
const ALL = [mk('a', { parentId: 'b' }), mk('b', { parentId: 'c' }), mk('c'), mk('d', { dependsOn: ['e'] }), mk('e')];

test('toNode projects the lightweight shape', () => {
  const n = toNode(mk('a', { status: 'active', tags: { x: ['y'] }, parentId: 'b', progress: { percent: 40, summary: 's', updatedAt: 1 } }));
  assert.deepEqual(n, { id: 'a', title: 'a', status: 'active', tags: { x: ['y'] }, parentId: 'b', progressPercent: 40 });
});

test('parents direction walks up to depth', () => {
  const r1 = neighbors('a', ALL, { direction: 'parents', depth: 1 });
  assert.deepEqual(r1.neighbors.map((m) => m.id), ['b']);
  assert.deepEqual(r1.edges, [{ from: 'b', to: 'a', type: 'parent' }]);
  const r2 = neighbors('a', ALL, { direction: 'parents', depth: 2 });
  assert.deepEqual(r2.neighbors.map((m) => m.id).sort(), ['b', 'c']);
});

test('children + dependencies + dependents', () => {
  assert.deepEqual(neighbors('b', ALL, { direction: 'children', depth: 1 }).neighbors.map((m) => m.id), ['a']);
  assert.deepEqual(neighbors('d', ALL, { direction: 'dependencies', depth: 1 }).neighbors.map((m) => m.id), ['e']);
  const dep = neighbors('e', ALL, { direction: 'dependents', depth: 1 });
  assert.deepEqual(dep.neighbors.map((m) => m.id), ['d']);
  assert.deepEqual(dep.edges, [{ from: 'd', to: 'e', type: 'dependsOn' }]);
});

test('all direction is cycle-safe', () => {
  const cyc = [mk('p', { parentId: 'q' }), mk('q', { parentId: 'p' })];
  const r = neighbors('p', cyc, { direction: 'all', depth: 5 });
  assert.deepEqual(r.neighbors.map((m) => m.id), ['q']); // does not loop forever
});

test('subgraphEdges only emits in-set edges', () => {
  const ids = new Set(['a', 'b', 'd']); // c, e excluded
  const edges = subgraphEdges(ids, ALL);
  assert.deepEqual(edges, [{ from: 'b', to: 'a', type: 'parent' }]); // a->b kept; b->c dropped (c out); d->e dropped (e out)
});
