import type { DagGraph, DagNode, DagEdge } from '@/components/dag/dag-types';
import type { MissionNode, MissionEdge, MissionFilter, MissionViewDisplay } from './mission-graph-types';

const PALETTE = ['#60a5fa', '#f87171', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f472b6', '#a3e635', '#e879f9', '#2dd4bf', '#facc15'];

/** Deterministic color for a group value (groupBy a tag dimension). */
export function colorForGroup(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Minimal client-side highlight predicate — a subset of the server ops over status/parentId/tags.<dim>. */
export function matchesHighlight(node: MissionNode, filter: MissionFilter[]): boolean {
  const val = (field: string): unknown => (field.startsWith('tags.') ? (node.tags ?? {})[field.slice(5)] : (node as unknown as Record<string, unknown>)[field]);
  return filter.every((f) => {
    const v = val(f.field);
    const isArr = Array.isArray(v);
    switch (f.op) {
      case 'eq': return v === f.value;
      case 'ne': return v !== f.value;
      case 'exists': return (isArr ? (v as unknown[]).length > 0 : v != null) === Boolean(f.value);
      case 'contains': return isArr ? (v as unknown[]).includes(f.value) : (typeof v === 'string' && typeof f.value === 'string' && v.toLowerCase().includes(f.value.toLowerCase()));
      case 'in': return Array.isArray(f.value) && (isArr ? (v as unknown[]).some((x) => (f.value as unknown[]).includes(x)) : (f.value as unknown[]).includes(v));
      default: return true; // unknown op → don't exclude
    }
  });
}

function maxDepth(nodes: DagNode[], edges: DagEdge[]): number {
  const adj = new Map<string, string[]>();
  for (const e of edges) { const a = adj.get(e.from) ?? []; a.push(e.to); adj.set(e.from, a); }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let d = 0;
    for (const n of adj.get(id) ?? []) d = Math.max(d, 1 + depth(n));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  let m = 0;
  for (const n of nodes) m = Math.max(m, depth(n.id));
  return m;
}

/** Map the backend mission graph → the DagGraph renderer shape, applying display hints. */
export function toDagGraph(mg: { nodes: MissionNode[]; edges: MissionEdge[] }, display?: MissionViewDisplay): DagGraph {
  const layout = display?.layout;
  const edges: DagEdge[] = mg.edges
    .filter((e) => (layout === 'tree' ? e.type === 'parent' : layout === 'dag' ? e.type === 'dependsOn' : true))
    .map((e) => ({ from: e.from, to: e.to, type: e.type }));
  const nodes: DagNode[] = mg.nodes.map((m) => ({
    id: m.id,
    type: 'mission',
    label: m.title,
    metadata: {
      status: m.status,
      tags: { ...(m.tags ?? {}) },
      parentId: m.parentId,
      progressPercent: m.progressPercent,
      highlighted: display?.highlight?.length ? matchesHighlight(m, display.highlight) : true,
      groupColor: display?.groupBy ? colorForGroup((m.tags?.[display.groupBy] ?? [])[0] ?? '∅') : undefined,
    },
  }));
  const hasParent = new Set(edges.filter((e) => e.type === 'parent').map((e) => e.to));
  const rootId = nodes.find((n) => !hasParent.has(n.id))?.id ?? null;
  const childCount = new Map<string, number>();
  for (const e of edges) childCount.set(e.from, (childCount.get(e.from) ?? 0) + 1);
  const stats = { nodeCount: nodes.length, edgeCount: edges.length, maxDepth: maxDepth(nodes, edges), branchCount: [...childCount.values()].filter((c) => c > 1).length };
  return { nodes, edges, rootId, stats };
}

/** Client-side quick-filter narrowing of mission nodes (status chips + tag chips). */
export function applyQuickFilters(nodes: MissionNode[], qf: { statuses?: string[]; tags?: Record<string, string[]> }): MissionNode[] {
  return nodes.filter((m) => {
    if (qf.statuses?.length && !qf.statuses.includes(m.status)) return false;
    if (qf.tags) for (const [dim, vals] of Object.entries(qf.tags)) {
      if (vals.length && !vals.some((v) => (m.tags?.[dim] ?? []).includes(v))) return false;
    }
    return true;
  });
}

/** Space-separated terms ANDed; each matches case-insensitively against title/id/status/tag values. */
export function matchesSearch(node: MissionNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tagVals = Object.values(node.tags ?? {}).flat().join(' ');
  const hay = `${node.title} ${node.id} ${node.status} ${tagVals}`.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/** Build a server MissionFilter[] + expand from the friendly filter-editor state (status/tag multi-selects + expand). */
export function buildFilter(state: {
  statuses?: string[];
  tags?: Record<string, string[]>;
  expand?: { direction?: string; depth?: number };
}): { filter: MissionFilter[]; expand?: { direction?: string; depth?: number } } {
  const filter: MissionFilter[] = [];
  if (state.statuses?.length) filter.push({ field: 'status', op: 'in', value: state.statuses });
  if (state.tags) for (const [dim, vals] of Object.entries(state.tags)) {
    if (vals.length) filter.push({ field: `tags.${dim}`, op: 'in', value: vals });
  }
  const dir = state.expand?.direction;
  const expand = dir && dir !== 'none' ? { direction: dir, depth: state.expand?.depth ?? 1 } : undefined;
  return { filter, expand };
}
