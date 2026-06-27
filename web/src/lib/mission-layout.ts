// Pure mission-graph layout: cluster by connected component, arrange each per
// strategy, then bin-pack the blocks. No React. Reuses computeDagLayout for flow.
import { computeDagLayout } from '@/components/dag/dag-layout';
import type { DagGraph } from '@/components/dag/dag-types';

export type MissionLayoutStrategy = 'clusters' | 'hubs' | 'focus' | 'recent';

export interface MissionLayoutInput {
  nodes: { id: string }[];
  edges: { from: string; to: string; type: 'parent' | 'dependsOn' }[];
  strategy: MissionLayoutStrategy;
  selectedId?: string | null;
  liveIds?: Set<string>;
  nodeW?: number;
  nodeH?: number;
  gap?: number;
}

export interface PositionedNode { id: string; x: number; y: number; }

export interface MissionLayoutResult {
  positions: Map<string, PositionedNode>;
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
  dimmed?: Set<string>;
}

type Block = { pos: Map<string, { x: number; y: number }>; w: number; h: number };

/** Union-find connected components over the UNDIRECTED edge set. Singletons appear as size-1 groups. */
export function connectedComponents(nodeIds: string[], edges: { from: string; to: string }[]): string[][] {
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of edges) if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to);
  const groups = new Map<string, string[]>();
  for (const id of nodeIds) { const r = find(id); const g = groups.get(r) ?? []; g.push(id); groups.set(r, g); }
  return [...groups.values()];
}

function highestDegree(ids: string[], edges: { from: string; to: string }[]): string {
  const idSet = new Set(ids);
  const deg = new Map<string, number>();
  for (const id of ids) deg.set(id, 0);
  for (const e of edges) if (idSet.has(e.from) && idSet.has(e.to)) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
  let best = ids[0], bd = -1;
  for (const id of ids) { const d = deg.get(id) || 0; if (d > bd) { bd = d; best = id; } }
  return best;
}

/** Lay a component out with the existing LR parent/dependency flow (reuse computeDagLayout). */
function layoutComponentFlow(ids: string[], edges: { from: string; to: string; type: string }[], nodeW: number, nodeH: number): Block {
  const idSet = new Set(ids);
  const subEdges = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
  const dg: DagGraph = {
    nodes: ids.map((id) => ({ id, type: 'mission', label: id, metadata: {} })),
    edges: subEdges.map((e) => ({ from: e.from, to: e.to, type: e.type })),
    rootId: null,
    stats: { nodeCount: ids.length, edgeCount: subEdges.length, maxDepth: 0, branchCount: 0 },
  };
  const r = computeDagLayout(dg, { nodeW, nodeH, nodeGap: 24, layerGap: 80 });
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of r.nodes) pos.set(n.id, { x: n.x, y: n.y });
  return { pos, w: r.width, h: r.height };
}

/** Pack singletons into a sqrt-ish grid. */
function layoutSingletons(ids: string[], nodeW: number, nodeH: number, gap: number): Block {
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  const pos = new Map<string, { x: number; y: number }>();
  ids.forEach((id, i) => { const c = i % cols, row = Math.floor(i / cols); pos.set(id, { x: c * (nodeW + gap), y: row * (nodeH + gap) }); });
  const rows = Math.ceil(ids.length / cols);
  return { pos, w: cols * nodeW + (cols - 1) * gap, h: rows * nodeH + (rows - 1) * gap };
}

/** Shelf bin-pack blocks left→right, wrapping at a target width derived from total area. */
function packBlocks(blocks: Block[], gap: number): { positions: Map<string, PositionedNode>; width: number; height: number } {
  const totalArea = blocks.reduce((s, b) => s + b.w * b.h, 0);
  const targetW = Math.max(800, Math.sqrt(totalArea * 1.6));
  const positions = new Map<string, PositionedNode>();
  let x = 0, y = 0, rowH = 0, maxW = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > targetW) { x = 0; y += rowH + gap * 2; rowH = 0; }
    for (const [id, p] of b.pos) positions.set(id, { id, x: x + p.x, y: y + p.y });
    x += b.w + gap * 2;
    rowH = Math.max(rowH, b.h);
    maxW = Math.max(maxW, x - gap * 2);
  }
  return { positions, width: maxW, height: y + rowH };
}

export function computeMissionLayout(input: MissionLayoutInput): MissionLayoutResult {
  const nodeW = input.nodeW ?? 200, nodeH = input.nodeH ?? 76, gap = input.gap ?? 28;
  const ids = input.nodes.map((n) => n.id);
  if (ids.length === 0) return { positions: new Map(), width: 0, height: 0, nodeW, nodeH };

  const comps = connectedComponents(ids, input.edges);
  const multi = comps.filter((c) => c.length > 1);
  const singles = comps.filter((c) => c.length === 1).map((c) => c[0]);
  const dimmed = new Set<string>();

  type Tagged = Block & { ids: string[]; liveCount: number };
  const multiBlocks: Tagged[] = multi.map((comp) => {
    const block = layoutComponentFlow(comp, input.edges, nodeW, nodeH);
    const liveCount = input.liveIds ? comp.filter((id) => input.liveIds!.has(id)).length : 0;
    return { ...block, ids: comp, liveCount };
  });

  // ordering: clusters = size desc
  multiBlocks.sort((a, b) => b.ids.length - a.ids.length);

  const ordered: Block[] = [...multiBlocks];
  if (singles.length) ordered.push(layoutSingletons(singles, nodeW, nodeH, gap));

  const packed = packBlocks(ordered, gap);
  const pad = 20;
  return {
    positions: new Map([...packed.positions].map(([id, p]) => [id, { id, x: p.x + pad, y: p.y + pad }])),
    width: packed.width + pad * 2,
    height: packed.height + pad * 2,
    nodeW,
    nodeH,
    dimmed: dimmed.size ? dimmed : undefined,
  };
}
