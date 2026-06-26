import { test, expect } from 'vitest';
import { toDagGraph, matchesHighlight, colorForGroup, applyQuickFilters } from '@/lib/mission-graph-adapter';
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
