/** Pure mission relationship traversal: parentId tree + dependsOn DAG walks. No IO. */
import type { Mission } from './mission-model';

export type Direction = 'parents' | 'children' | 'dependencies' | 'dependents' | 'all';
export interface MissionEdge { from: string; to: string; type: 'parent' | 'dependsOn'; }
export interface MissionNode { id: string; title: string; status: string; tags: Record<string, string[]>; parentId: string | null; progressPercent?: number; }

export function toNode(m: Mission): MissionNode {
  return { id: m.id, title: m.title, status: m.status, tags: m.tags ?? {}, parentId: m.parentId ?? null, progressPercent: m.progress?.percent };
}

/** One mission's neighbors by direction, BFS to `depth` (cycle-safe). Returns full missions + the edges traversed. */
export function neighbors(id: string, all: Mission[], opts: { direction: Direction; depth: number }): { neighbors: Mission[]; edges: MissionEdge[] } {
  const byId = new Map(all.map((m) => [m.id, m]));
  const want = opts.direction;
  const seen = new Set<string>([id]);
  const resultIds = new Set<string>();
  const edges: MissionEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (e: MissionEdge) => { const k = `${e.type}:${e.from}->${e.to}`; if (!edgeKeys.has(k)) { edgeKeys.add(k); edges.push(e); } };
  const visit = (newId: string, e: MissionEdge): string | null => { addEdge(e); if (seen.has(newId)) return null; seen.add(newId); resultIds.add(newId); return newId; };
  let frontier = [id];
  for (let d = 0; d < Math.max(1, opts.depth) && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const m = byId.get(cur);
      if (!m) continue;
      if ((want === 'parents' || want === 'all') && m.parentId && byId.has(m.parentId)) { const n = visit(m.parentId, { from: m.parentId, to: m.id, type: 'parent' }); if (n) next.push(n); }
      if (want === 'children' || want === 'all') for (const c of all) if (c.parentId === cur) { const n = visit(c.id, { from: cur, to: c.id, type: 'parent' }); if (n) next.push(n); }
      if (want === 'dependencies' || want === 'all') for (const dep of m.dependsOn ?? []) if (byId.has(dep)) { const n = visit(dep, { from: cur, to: dep, type: 'dependsOn' }); if (n) next.push(n); }
      if (want === 'dependents' || want === 'all') for (const c of all) if ((c.dependsOn ?? []).includes(cur)) { const n = visit(c.id, { from: c.id, to: cur, type: 'dependsOn' }); if (n) next.push(n); }
    }
    frontier = next;
  }
  return { neighbors: [...resultIds].map((x) => byId.get(x)!).filter(Boolean), edges };
}

/** Every parent + dependsOn edge BETWEEN nodes in the set. */
export function subgraphEdges(nodeIds: Set<string>, all: Mission[]): MissionEdge[] {
  const edges: MissionEdge[] = [];
  for (const m of all) {
    if (!nodeIds.has(m.id)) continue;
    if (m.parentId && nodeIds.has(m.parentId)) edges.push({ from: m.parentId, to: m.id, type: 'parent' });
    for (const dep of m.dependsOn ?? []) if (nodeIds.has(dep)) edges.push({ from: m.id, to: dep, type: 'dependsOn' });
  }
  return edges;
}
