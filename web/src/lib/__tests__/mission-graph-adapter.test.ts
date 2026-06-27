import { test, expect, describe, it } from 'vitest';
import { toDagGraph, matchesHighlight, colorForGroup, applyQuickFilters, matchesSearch, buildFilter, expandToComponents } from '@/lib/mission-graph-adapter';
import type { MissionNode, MissionEdge } from '@/lib/mission-graph-types';

const mn = (id: string, over: Partial<MissionNode> = {}): MissionNode => ({ id, title: id, status: 'active', tags: {}, parentId: null, ...over });

test('toDagGraph maps nodes + edges and metadata', () => {
  const g = toDagGraph({ nodes: [mn('a', { status: 'done', tags: { component: ['web'] }, progressPercent: 50 })], edges: [] });
  expect(g.nodes[0]).toMatchObject({ id: 'a', type: 'mission', label: 'a' });
  expect(g.nodes[0].metadata).toMatchObject({ status: 'done', progressPercent: 50, highlighted: true });
  expect(g.stats.nodeCount).toBe(1);
});

test('layout selects edges: tree=parent only, dag=dependsOn only, default=both', () => {
  const nodes = [mn('a', { parentId: 'b', tags: {} }), mn('b'), mn('c')];
  const edges: MissionEdge[] = [{ from: 'b', to: 'a', type: 'parent' }, { from: 'a', to: 'c', type: 'dependsOn' }];
  expect(toDagGraph({ nodes, edges }, { layout: 'tree' }).edges).toEqual([{ from: 'b', to: 'a', type: 'parent' }]);
  expect(toDagGraph({ nodes, edges }, { layout: 'dag' }).edges).toEqual([{ from: 'a', to: 'c', type: 'dependsOn' }]);
  expect(toDagGraph({ nodes, edges }).edges.length).toBe(2);
});

test('groupBy assigns a deterministic groupColor per dimension value', () => {
  const g = toDagGraph({ nodes: [mn('a', { tags: { project: ['x'] } }), mn('b', { tags: { project: ['x'] } }), mn('c', { tags: { project: ['y'] } })], edges: [] }, { groupBy: 'project' });
  expect(g.nodes[0].metadata.groupColor).toBe(g.nodes[1].metadata.groupColor); // same value → same color
  expect(g.nodes[0].metadata.groupColor).not.toBe(g.nodes[2].metadata.groupColor);
  expect(colorForGroup('x')).toBe(colorForGroup('x'));
});

test('highlight marks matching nodes; others not highlighted', () => {
  const g = toDagGraph({ nodes: [mn('a', { status: 'active' }), mn('b', { status: 'done' })], edges: [] }, { highlight: [{ field: 'status', op: 'eq', value: 'active' }] });
  expect(g.nodes.find((n) => n.id === 'a')!.metadata.highlighted).toBe(true);
  expect(g.nodes.find((n) => n.id === 'b')!.metadata.highlighted).toBe(false);
});

test('matchesHighlight handles tag dimensions + ops', () => {
  const n = mn('a', { tags: { component: ['web', 'api'] }, status: 'active' });
  expect(matchesHighlight(n, [{ field: 'tags.component', op: 'contains', value: 'web' }])).toBe(true);
  expect(matchesHighlight(n, [{ field: 'tags.component', op: 'exists', value: true }])).toBe(true);
  expect(matchesHighlight(n, [{ field: 'status', op: 'in', value: ['done', 'failed'] }])).toBe(false);
});

test('applyQuickFilters narrows by status + tag', () => {
  const nodes = [mn('a', { status: 'active', tags: { component: ['web'] } }), mn('b', { status: 'done' })];
  expect(applyQuickFilters(nodes, { statuses: ['active'] }).map((n) => n.id)).toEqual(['a']);
  expect(applyQuickFilters(nodes, { tags: { component: ['web'] } }).map((n) => n.id)).toEqual(['a']);
});

const node = (over: Partial<import('@/lib/mission-graph-types').MissionNode> = {}) =>
  ({ id: 'm1', title: 'Auth epic', status: 'active', tags: { project: ['web'] }, parentId: null, ...over });

test('matchesSearch: empty query matches all', () => {
  expect(matchesSearch(node() as any, '')).toBe(true);
});
test('matchesSearch: ANDs space-separated terms over title/id/status/tags', () => {
  expect(matchesSearch(node() as any, 'auth web')).toBe(true);   // title + tag value
  expect(matchesSearch(node() as any, 'auth missing')).toBe(false);
  expect(matchesSearch(node() as any, 'active')).toBe(true);     // status
  expect(matchesSearch(node({ id: 'mission_abc' }) as any, 'abc')).toBe(true); // id
});
test('buildFilter: status + tags → MissionFilter[] with op:in', () => {
  const r = buildFilter({ statuses: ['active', 'done'], tags: { project: ['web'] } });
  expect(r.filter).toContainEqual({ field: 'status', op: 'in', value: ['active', 'done'] });
  expect(r.filter).toContainEqual({ field: 'tags.project', op: 'in', value: ['web'] });
  expect(r.expand).toBeUndefined();
});
test('buildFilter: empty selections → empty filter; direction none → no expand', () => {
  expect(buildFilter({}).filter).toEqual([]);
  expect(buildFilter({ expand: { direction: 'none', depth: 2 } }).expand).toBeUndefined();
});
test('buildFilter: a real direction → expand with depth default 1', () => {
  expect(buildFilter({ expand: { direction: 'dependencies' } }).expand).toEqual({ direction: 'dependencies', depth: 1 });
});

const N = (id: string): MissionNode => ({ id, title: id, status: 'active', tags: {}, parentId: null });
const ME = (from: string, to: string): MissionEdge => ({ from, to, type: 'dependsOn' });

describe('expandToComponents', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(N);
  const edges = [ME('a', 'b'), ME('b', 'c'), ME('d', 'e')];

  it('expands a match to its whole connected component', () => {
    const out = expandToComponents(nodes, edges, new Set(['a']));
    expect([...out].sort()).toEqual(['a', 'b', 'c']);
  });

  it('unions components for matches in different groups', () => {
    const out = expandToComponents(nodes, edges, new Set(['a', 'd']));
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a match with no edges returns just itself', () => {
    const out = expandToComponents([...nodes, N('x')], edges, new Set(['x']));
    expect([...out]).toEqual(['x']);
  });
});
