# Mission Graph Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mission-graph dashboard renderer with a purpose-built CSS-transform canvas (no foreignObject ghosting), add connected-component clustering with four layout strategies, mouse-drag pan + pinch-zoom, and search that reveals each match's whole connected group.

**Architecture:** A new pure layout engine (`mission-layout.ts`) clusters missions by connected component and arranges each component per strategy, then bin-packs the blocks. A new canvas (`MissionGraphCanvas` rewrite) renders HTML cards + an SVG edge layer inside one CSS-transformed `<div>` and owns pan/zoom/pinch/select. The shared `DagGraph`/`dag-layout.ts` are untouched (session-DAG views unchanged).

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Tailwind v4 / Zustand; web vitest for pure modules. Reuses `computeDagLayout` for intra-component flow.

## Global Constraints

- **No backend changes.** Use existing endpoints only (`/mission/graph`, `/mission/views/:id/graph`, `/mission/sessions`).
- **Do NOT modify** `web/src/components/dag/DagGraph.tsx` or `web/src/components/dag/dag-layout.ts` (shared by session-DAG views).
- **No foreignObject** anywhere in the new mission canvas — that is the ghost bug; cards are plain HTML `<div>` inside a CSS-transformed container.
- Card size is fixed: `nodeW=200`, `nodeH=76`. Strategy gap `gap=28`.
- Strategy set + default: `clusters` (default), `hubs`, `focus`, `recent`. Strategy names are exactly these lowercase strings.
- Zoom clamp `[0.05, 3]`. Wheel: `deltaY>0` → ×0.9 else ×1.1.
- Web fetches go through `useAppMode()` → `apiClient.fetchPath<T>(path, { method?, body?, machineId })` (returns UNWRAPPED `data`); always pass `machineId: proxy.machineId || undefined`.
- Run web tests with: `cd web && npx vitest run`. Typecheck with `cd web && npx tsc --noEmit` — baseline is **39 pre-existing errors in unrelated files**; touched files must add zero new errors.
- Node ≥ 20.9 for any web build (`source ~/.nvm/nvm.sh && nvm use 20`).

---

### Task 1: Layout engine — scaffold + clustering + Clusters strategy

**Files:**
- Create: `web/src/lib/mission-layout.ts`
- Test: `web/src/lib/__tests__/mission-layout.test.ts`

**Interfaces:**
- Consumes: `computeDagLayout` from `@/components/dag/dag-layout`; `DagGraph` type from `@/components/dag/dag-types`.
- Produces:
  - `type MissionLayoutStrategy = 'clusters' | 'hubs' | 'focus' | 'recent'`
  - `interface MissionLayoutInput { nodes: { id: string }[]; edges: { from: string; to: string; type: 'parent' | 'dependsOn' }[]; strategy: MissionLayoutStrategy; selectedId?: string | null; liveIds?: Set<string>; nodeW?: number; nodeH?: number; gap?: number; }`
  - `interface PositionedNode { id: string; x: number; y: number; }`
  - `interface MissionLayoutResult { positions: Map<string, PositionedNode>; width: number; height: number; nodeW: number; nodeH: number; dimmed?: Set<string>; }`
  - `function computeMissionLayout(input: MissionLayoutInput): MissionLayoutResult`
  - Internal (exported for tests): `function connectedComponents(nodeIds: string[], edges: { from: string; to: string }[]): string[][]`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/__tests__/mission-layout.test.ts
import { describe, it, expect } from 'vitest';
import { computeMissionLayout, connectedComponents } from '../mission-layout';

const E = (from: string, to: string, type: 'parent' | 'dependsOn' = 'dependsOn') => ({ from, to, type });

describe('connectedComponents', () => {
  it('splits two disconnected chains and groups singletons separately', () => {
    const comps = connectedComponents(['a', 'b', 'c', 'd', 's1', 's2'], [E('a', 'b'), E('b', 'c')]);
    const sizes = comps.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 1, 1, 3]); // {a,b,c}, {d}, {s1}, {s2}
    expect(comps.find((c) => c.includes('a'))!.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('computeMissionLayout — clusters', () => {
  it('lays two disconnected components into non-overlapping regions', () => {
    const r = computeMissionLayout({
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
      edges: [E('a', 'b'), E('c', 'd')],
      strategy: 'clusters',
    });
    expect(r.positions.size).toBe(4);
    // component {a,b} and {c,d} must not overlap: their x-or-y ranges are disjoint
    const box = (ids: string[]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) { const p = r.positions.get(id)!; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + r.nodeW); y1 = Math.max(y1, p.y + r.nodeH); }
      return { x0, y0, x1, y1 };
    };
    const A = box(['a', 'b']), B = box(['c', 'd']);
    const disjoint = A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0;
    expect(disjoint).toBe(true);
  });

  it('packs singletons (no edges) into a sqrt-ish grid block', () => {
    const r = computeMissionLayout({ nodes: ['s1', 's2', 's3', 's4'].map((id) => ({ id })), edges: [], strategy: 'clusters' });
    expect(r.positions.size).toBe(4);
    // 4 singletons → 2 columns → at least 2 distinct x AND 2 distinct y
    const xs = new Set([...r.positions.values()].map((p) => Math.round(p.x)));
    const ys = new Set([...r.positions.values()].map((p) => Math.round(p.y)));
    expect(xs.size).toBeGreaterThanOrEqual(2);
    expect(ys.size).toBeGreaterThanOrEqual(2);
  });

  it('returns empty bounds for empty input', () => {
    const r = computeMissionLayout({ nodes: [], edges: [], strategy: 'clusters' });
    expect(r.width).toBe(0); expect(r.height).toBe(0); expect(r.positions.size).toBe(0);
  });

  it('every edge endpoint has a position', () => {
    const edges = [E('a', 'b'), E('b', 'c')];
    const r = computeMissionLayout({ nodes: ['a', 'b', 'c'].map((id) => ({ id })), edges, strategy: 'clusters' });
    for (const e of edges) { expect(r.positions.has(e.from)).toBe(true); expect(r.positions.has(e.to)).toBe(true); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/mission-layout.test.ts`
Expected: FAIL — `Cannot find module '../mission-layout'`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/lib/mission-layout.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/__tests__/mission-layout.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `39` (unchanged baseline; zero new errors in `mission-layout.ts`).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/mission-layout.ts web/src/lib/__tests__/mission-layout.test.ts
git commit -m "feat(web): mission-layout engine — clustering + Clusters strategy + packing"
```

---

### Task 2: Layout engine — Hubs + Focus (radial) strategies

**Files:**
- Modify: `web/src/lib/mission-layout.ts`
- Test: `web/src/lib/__tests__/mission-layout.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `computeMissionLayout` now honours `strategy: 'hubs'` and `strategy: 'focus'`; `MissionLayoutResult.dimmed` is populated for `focus` with a `selectedId` (all node ids NOT in the selected component).

- [ ] **Step 1: Write the failing test** (append to `mission-layout.test.ts`)

```ts
describe('computeMissionLayout — hubs & focus', () => {
  // star: hub connected to 4 leaves
  const star = { nodes: ['h', 'l1', 'l2', 'l3', 'l4'].map((id) => ({ id })), edges: [E('h', 'l1'), E('h', 'l2'), E('h', 'l3'), E('h', 'l4')] };

  it('hubs: the highest-degree node sits closest to the component centroid', () => {
    const r = computeMissionLayout({ ...star, strategy: 'hubs' });
    const center = (id: string) => { const p = r.positions.get(id)!; return { x: p.x + r.nodeW / 2, y: p.y + r.nodeH / 2 }; };
    const ids = ['h', 'l1', 'l2', 'l3', 'l4'];
    const cx = ids.reduce((s, id) => s + center(id).x, 0) / ids.length;
    const cy = ids.reduce((s, id) => s + center(id).y, 0) / ids.length;
    const dist = (id: string) => { const c = center(id); return Math.hypot(c.x - cx, c.y - cy); };
    const hubDist = dist('h');
    for (const l of ['l1', 'l2', 'l3', 'l4']) expect(hubDist).toBeLessThanOrEqual(dist(l) + 1);
  });

  it('focus: selected node is the centroid of its component; other components are dimmed', () => {
    const two = {
      nodes: ['h', 'l1', 'l2', 'x', 'y'].map((id) => ({ id })),
      edges: [E('h', 'l1'), E('h', 'l2'), E('x', 'y')],
      strategy: 'focus' as const,
      selectedId: 'l1',
    };
    const r = computeMissionLayout(two);
    // l1's component is {h,l1,l2}; x and y are in another component → dimmed
    expect(r.dimmed?.has('x')).toBe(true);
    expect(r.dimmed?.has('y')).toBe(true);
    expect(r.dimmed?.has('l1')).toBe(false);
  });

  it('focus with no selection === clusters (no dimming)', () => {
    const r = computeMissionLayout({ ...star, strategy: 'focus', selectedId: null });
    expect(r.dimmed).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/mission-layout.test.ts`
Expected: FAIL — hubs/focus currently fall through to flow; the centroid + dimmed assertions fail.

- [ ] **Step 3: Write the implementation**

Add the radial helper to `mission-layout.ts` (after `layoutComponentFlow`):

```ts
/** Radial layout: centerId at the middle, others on concentric rings by hop distance. */
function layoutComponentRadial(ids: string[], edges: { from: string; to: string }[], centerId: string, nodeW: number, nodeH: number, gap: number): Block {
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) if (idSet.has(e.from) && idSet.has(e.to)) { adj.get(e.from)!.push(e.to); adj.get(e.to)!.push(e.from); }

  const ring = new Map<string, number>([[centerId, 0]]);
  let frontier = [centerId];
  const seen = new Set([centerId]);
  while (frontier.length) {
    const next: string[] = [];
    for (const u of frontier) for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); ring.set(v, ring.get(u)! + 1); next.push(v); }
    frontier = next;
  }
  let maxRing = 0;
  for (const r of ring.values()) maxRing = Math.max(maxRing, r);
  for (const id of ids) if (!ring.has(id)) ring.set(id, maxRing + 1); // disconnected-within-component guard
  maxRing = 0;
  for (const r of ring.values()) maxRing = Math.max(maxRing, r);

  const byRing = new Map<number, string[]>();
  for (const id of ids) { const r = ring.get(id)!; const g = byRing.get(r) ?? []; g.push(id); byRing.set(r, g); }

  const ringStep = Math.max(nodeW, nodeH) + gap + 40;
  const center = maxRing * ringStep + Math.max(nodeW, nodeH);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [r, members] of byRing) {
    if (r === 0) { pos.set(members[0], { x: center - nodeW / 2, y: center - nodeH / 2 }); continue; }
    const radius = r * ringStep;
    members.forEach((id, i) => {
      const ang = (2 * Math.PI * i) / members.length - Math.PI / 2;
      pos.set(id, { x: center + radius * Math.cos(ang) - nodeW / 2, y: center + radius * Math.sin(ang) - nodeH / 2 });
    });
  }
  // normalize to origin and compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + nodeW); maxY = Math.max(maxY, p.y + nodeH); }
  for (const p of pos.values()) { p.x -= minX; p.y -= minY; }
  return { pos, w: maxX - minX, h: maxY - minY };
}
```

Then replace the `multiBlocks` construction inside `computeMissionLayout` with strategy-aware intra-layout:

```ts
  const focusComp = (input.strategy === 'focus' && input.selectedId)
    ? multi.find((c) => c.includes(input.selectedId!)) ?? null
    : null;

  const multiBlocks: Tagged[] = multi.map((comp) => {
    let block: Block;
    if (input.strategy === 'hubs') {
      block = layoutComponentRadial(comp, input.edges, highestDegree(comp, input.edges), nodeW, nodeH, gap);
    } else if (focusComp && comp === focusComp) {
      block = layoutComponentRadial(comp, input.edges, input.selectedId!, nodeW, nodeH, gap);
    } else {
      block = layoutComponentFlow(comp, input.edges, nodeW, nodeH);
      if (focusComp) for (const id of comp) dimmed.add(id); // non-focused components are dimmed
    }
    const liveCount = input.liveIds ? comp.filter((id) => input.liveIds!.has(id)).length : 0;
    return { ...block, ids: comp, liveCount };
  });
```

And make ordering put the focused component first (insert before the existing `multiBlocks.sort` line, replacing it):

```ts
  if (focusComp) {
    multiBlocks.sort((a, b) => (b.ids === focusComp ? 1 : 0) - (a.ids === focusComp ? 1 : 0) || b.ids.length - a.ids.length);
  } else {
    multiBlocks.sort((a, b) => b.ids.length - a.ids.length);
  }
```

(Focus dimming only covers `multi` components; singletons under focus are also non-focused, so also add them to `dimmed` when `focusComp` is set — add right before building `ordered`:)

```ts
  if (focusComp) for (const id of singles) dimmed.add(id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/__tests__/mission-layout.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -c "error TS"` → `39`.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/mission-layout.ts web/src/lib/__tests__/mission-layout.test.ts
git commit -m "feat(web): mission-layout Hubs + Focus radial strategies"
```

---

### Task 3: Layout engine — Recent strategy (live-session ordering)

**Files:**
- Modify: `web/src/lib/mission-layout.ts`
- Test: `web/src/lib/__tests__/mission-layout.test.ts`

**Interfaces:**
- Consumes: Task 1+2.
- Produces: `computeMissionLayout` honours `strategy: 'recent'` using `input.liveIds` — components with live members pack first.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('computeMissionLayout — recent', () => {
  it('packs a component with a live mission before a non-live component', () => {
    const r = computeMissionLayout({
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
      edges: [E('a', 'b'), E('c', 'd')],
      strategy: 'recent',
      liveIds: new Set(['c']), // component {c,d} is live
    });
    // {c,d} should be packed at a smaller origin (top-left) than {a,b}
    const minX = (ids: string[]) => Math.min(...ids.map((id) => r.positions.get(id)!.x));
    expect(minX(['c', 'd'])).toBeLessThan(minX(['a', 'b']));
  });

  it('recent with no liveIds falls back to size order (=== clusters)', () => {
    const base = { nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })), edges: [E('a', 'b'), E('b', 'c'), E('d', 'e')] };
    const recent = computeMissionLayout({ ...base, strategy: 'recent' });
    const clusters = computeMissionLayout({ ...base, strategy: 'clusters' });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(recent.positions.get(id)).toEqual(clusters.positions.get(id));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/mission-layout.test.ts`
Expected: FAIL — recent currently uses size order, so the live component is not ordered first.

- [ ] **Step 3: Write the implementation**

Replace the ordering block from Task 2 with one that also handles `recent`:

```ts
  if (focusComp) {
    multiBlocks.sort((a, b) => (b.ids === focusComp ? 1 : 0) - (a.ids === focusComp ? 1 : 0) || b.ids.length - a.ids.length);
  } else if (input.strategy === 'recent') {
    multiBlocks.sort((a, b) => (b.liveCount > 0 ? 1 : 0) - (a.liveCount > 0 ? 1 : 0) || b.liveCount - a.liveCount || b.ids.length - a.ids.length);
  } else {
    multiBlocks.sort((a, b) => b.ids.length - a.ids.length);
  }
```

(No other change — singletons always pack last; `liveCount` is already computed in Task 2.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/__tests__/mission-layout.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Typecheck** → `39`.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/mission-layout.ts web/src/lib/__tests__/mission-layout.test.ts
git commit -m "feat(web): mission-layout Recent strategy (live-session ordering)"
```

---

### Task 4: Search reveals related — `expandToComponents`

**Files:**
- Modify: `web/src/lib/mission-graph-adapter.ts`
- Test: `web/src/lib/__tests__/mission-graph-adapter.test.ts`

**Interfaces:**
- Consumes: `MissionNode`, `MissionEdge` from `@/lib/mission-graph-types`.
- Produces: `function expandToComponents(nodes: MissionNode[], edges: MissionEdge[], matchIds: Set<string>): Set<string>` — returns the union of every connected component (over the full undirected edge set) that contains at least one id in `matchIds`.

- [ ] **Step 1: Write the failing test** (append to `mission-graph-adapter.test.ts`)

```ts
import { expandToComponents } from '../mission-graph-adapter';
import type { MissionNode, MissionEdge } from '../mission-graph-types';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts`
Expected: FAIL — `expandToComponents` is not exported.

- [ ] **Step 3: Write the implementation** (append to `mission-graph-adapter.ts`)

```ts
/** Given matching node ids, return them plus every node in the same connected component (undirected edges). */
export function expandToComponents(nodes: MissionNode[], edges: MissionEdge[], matchIds: Set<string>): Set<string> {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; } return r; };
  for (const e of edges) if (idSet.has(e.from) && idSet.has(e.to)) { const ra = find(e.from), rb = find(e.to); if (ra !== rb) parent.set(ra, rb); }
  const matchRoots = new Set<string>();
  for (const m of matchIds) if (idSet.has(m)) matchRoots.add(find(m));
  const out = new Set<string>();
  for (const id of ids) if (matchRoots.has(find(id))) out.add(id);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts`
Expected: PASS (existing 11 + 3 new = 14).

- [ ] **Step 5: Typecheck** → `39`.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/mission-graph-adapter.ts web/src/lib/__tests__/mission-graph-adapter.test.ts
git commit -m "feat(web): expandToComponents — search reveals each match's connected group"
```

---

### Task 5: `useMissionActivity` hook + `MissionLayoutPicker`

**Files:**
- Create: `web/src/hooks/useMissionActivity.ts`
- Create: `web/src/components/missions/dashboard/MissionLayoutPicker.tsx`

**Interfaces:**
- Consumes: `useAppMode` from `@/contexts/AppModeContext`; `MissionLayoutStrategy` from `@/lib/mission-layout`.
- Produces:
  - `function useMissionActivity(): { liveIds: Set<string>; refresh: () => void }` — fetches `GET /mission/sessions` → `{ sessions: { missionId: string | null }[] }`, building a `Set` of mission ids that have a live bound session. Failure → empty set.
  - `function MissionLayoutPicker({ strategy, onChange, hasSelection }: { strategy: MissionLayoutStrategy; onChange: (s: MissionLayoutStrategy) => void; hasSelection: boolean }): JSX.Element`

- [ ] **Step 1: Write `useMissionActivity.ts`**

```ts
// web/src/hooks/useMissionActivity.ts
'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';

type SessionRow = { missionId: string | null };

export function useMissionActivity() {
  const { apiClient, proxy } = useAppMode();
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const refresh = useCallback(async () => {
    try {
      const data = await apiClient.fetchPath<{ sessions: SessionRow[] }>('/mission/sessions', { machineId: proxy.machineId || undefined });
      const ids = new Set<string>();
      for (const s of data?.sessions ?? []) if (s.missionId) ids.add(s.missionId);
      setLiveIds(ids);
    } catch {
      setLiveIds(new Set());
    }
  }, [apiClient, proxy.machineId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { liveIds, refresh };
}
```

- [ ] **Step 2: Write `MissionLayoutPicker.tsx`**

```tsx
// web/src/components/missions/dashboard/MissionLayoutPicker.tsx
'use client';
import type { MissionLayoutStrategy } from '@/lib/mission-layout';

const OPTIONS: { value: MissionLayoutStrategy; label: string; hint: string }[] = [
  { value: 'clusters', label: 'Clusters', hint: 'Related missions grouped; standalone in a grid' },
  { value: 'hubs', label: 'Hubs', hint: 'Most-connected mission centered in each group' },
  { value: 'focus', label: 'Focus', hint: 'Radial around the selected mission' },
  { value: 'recent', label: 'Recent', hint: 'Live/active missions surfaced first' },
];

export function MissionLayoutPicker({ strategy, onChange, hasSelection }: {
  strategy: MissionLayoutStrategy;
  onChange: (s: MissionLayoutStrategy) => void;
  hasSelection: boolean;
}) {
  const active = OPTIONS.find((o) => o.value === strategy);
  return (
    <div className="border-b border-neutral-800 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Layout</div>
      <select
        value={strategy}
        onChange={(e) => onChange(e.target.value as MissionLayoutStrategy)}
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
      >
        {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className="mt-1 text-[10px] text-neutral-500">{active?.hint}</div>
      {strategy === 'focus' && !hasSelection && <div className="mt-1 text-[10px] text-amber-500/80">Select a mission to focus on.</div>}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E "useMissionActivity|MissionLayoutPicker" || echo "clean"`
Expected: `clean`. Then `npx tsc --noEmit 2>&1 | grep -c "error TS"` → `39`.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useMissionActivity.ts web/src/components/missions/dashboard/MissionLayoutPicker.tsx
git commit -m "feat(web): useMissionActivity (live ids) + MissionLayoutPicker strategy dropdown"
```

---

### Task 6: `MissionCard` (HTML card)

**Files:**
- Create: `web/src/components/missions/dashboard/MissionCard.tsx`

**Interfaces:**
- Consumes: `MissionNode` from `@/lib/mission-graph-types`.
- Produces:
  ```ts
  interface MissionCardProps {
    node: MissionNode;
    x: number; y: number; width: number; height: number;
    selected: boolean; dimmed: boolean; live: boolean;
    rels: { deps: number; children: number; dependents: number };
    accent: string;
    majorTag?: string;
    fields: string[];
    onSelect: (id: string) => void;
  }
  function MissionCard(props: MissionCardProps): JSX.Element
  ```
  The card is an absolutely-positioned HTML `<div>` (NOT foreignObject). `onMouseDown` must NOT stopPropagation (drags must bubble to the canvas to pan). Selection happens on `onClick`.

- [ ] **Step 1: Write `MissionCard.tsx`**

```tsx
// web/src/components/missions/dashboard/MissionCard.tsx
'use client';
import type { MissionNode } from '@/lib/mission-graph-types';

export interface MissionCardProps {
  node: MissionNode;
  x: number; y: number; width: number; height: number;
  selected: boolean; dimmed: boolean; live: boolean;
  rels: { deps: number; children: number; dependents: number };
  accent: string;
  majorTag?: string;
  fields: string[];
  onSelect: (id: string) => void;
}

export function MissionCard({ node, x, y, width, height, selected, dimmed, live, rels, accent, majorTag, fields, onSelect }: MissionCardProps) {
  const relParts: string[] = [];
  if (node.parentId) relParts.push('↑parent');
  if (rels.deps) relParts.push(`⛓${rels.deps}`);
  if (rels.children) relParts.push(`▽${rels.children}`);
  if (rels.dependents) relParts.push(`${rels.dependents}blk`);
  return (
    <div
      className="absolute overflow-hidden rounded-md border bg-neutral-900 px-2 py-1 text-xs"
      style={{
        left: x, top: y, width, height,
        opacity: dimmed ? 0.3 : 1,
        borderColor: selected ? '#fff' : accent,
        borderLeftWidth: 4,
        cursor: 'pointer',
        boxShadow: selected ? '0 0 0 1px #fff' : undefined,
      }}
      onClick={() => onSelect(node.id)}
    >
      <div className="flex items-center gap-1">
        {live && <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 4px #34d399' }} />}
        <div className="truncate font-medium text-neutral-100">{node.title}</div>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-neutral-400">
        {fields.map((f) => (
          <span key={f}>{f === 'status' ? node.status : f === 'progress' ? `${node.progressPercent ?? 0}%` : String((node as unknown as Record<string, unknown>)[f] ?? '')}</span>
        ))}
        {majorTag && <span className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-300">{majorTag}</span>}
      </div>
      {relParts.length > 0 && <div className="mt-0.5 truncate text-[9px] text-neutral-500">{relParts.join(' · ')}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E "MissionCard" || echo "clean"` → `clean`. Total errors → `39`.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/missions/dashboard/MissionCard.tsx
git commit -m "feat(web): MissionCard — HTML mission card (no foreignObject)"
```

---

### Task 7: `MissionGraphCanvas` rewrite — CSS-transform render + auto-fit

**Files:**
- Rewrite: `web/src/components/missions/dashboard/MissionGraphCanvas.tsx`

**Interfaces:**
- Consumes: `computeMissionLayout`, `MissionLayoutStrategy` from `@/lib/mission-layout`; `MissionCard` from `./MissionCard`; `MissionNode`, `MissionEdge`, `MissionViewDisplay` from `@/lib/mission-graph-types`; `colorForGroup` from `@/lib/mission-graph-adapter`.
- Produces:
  ```ts
  function MissionGraphCanvas({ nodes, edges, strategy, selectedId, liveIds, display, onSelect }: {
    nodes: MissionNode[]; edges: MissionEdge[]; strategy: MissionLayoutStrategy;
    selectedId: string | null; liveIds: Set<string>; display?: MissionViewDisplay;
    onSelect: (id: string | null) => void;
  }): JSX.Element
  ```
  Renders an HTML world (CSS `transform`) with an SVG edge layer + `MissionCard`s. THIS task ships render + auto-fit only; interactions come in Task 8.

- [ ] **Step 1: Write the component** (replaces the whole file)

```tsx
// web/src/components/missions/dashboard/MissionGraphCanvas.tsx
'use client';
import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { computeMissionLayout, type MissionLayoutStrategy } from '@/lib/mission-layout';
import { colorForGroup } from '@/lib/mission-graph-adapter';
import { MissionCard } from './MissionCard';
import type { MissionNode, MissionEdge, MissionViewDisplay } from '@/lib/mission-graph-types';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171', done: '#60a5fa', failed: '#ef4444', draft: '#6b7280',
};
const MIN_ZOOM = 0.05, MAX_ZOOM = 3;

/** Point on a card's border in the direction of (tx,ty), so edges meet card edges (not centers). */
function borderPoint(x: number, y: number, w: number, h: number, tx: number, ty: number) {
  const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function MissionGraphCanvas({ nodes, edges, strategy, selectedId, liveIds, display, onSelect }: {
  nodes: MissionNode[]; edges: MissionEdge[]; strategy: MissionLayoutStrategy;
  selectedId: string | null; liveIds: Set<string>; display?: MissionViewDisplay;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const layout = useMemo(
    () => computeMissionLayout({ nodes: nodes.map((n) => ({ id: n.id })), edges, strategy, selectedId, liveIds }),
    [nodes, edges, strategy, selectedId, liveIds],
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // relationship counts per node (parent edge {from:parent,to:child}; dependsOn {from:mission,to:dep})
  const relsById = useMemo(() => {
    const m = new Map<string, { deps: number; children: number; dependents: number }>();
    const get = (id: string) => { let r = m.get(id); if (!r) { r = { deps: 0, children: 0, dependents: 0 }; m.set(id, r); } return r; };
    for (const e of edges) { if (e.type === 'parent') get(e.from).children += 1; else { get(e.from).deps += 1; get(e.to).dependents += 1; } }
    return m;
  }, [edges]);

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || layout.width === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const z = Math.min(Math.max(Math.min((rect.width - 20) / layout.width, (rect.height - 20) / layout.height), MIN_ZOOM), MAX_ZOOM);
    setZoom(z);
    setPan({ x: Math.max(0, (rect.width - layout.width * z) / 2), y: Math.max(0, (rect.height - layout.height * z) / 2) });
  }, [layout.width, layout.height]);

  // auto-fit when the layout changes (stable dep — layout is memoized)
  useEffect(() => {
    const t = requestAnimationFrame(fitToView);
    return () => cancelAnimationFrame(t);
  }, [fitToView]);

  if (nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-neutral-500">No missions match this view.</div>;
  }

  const W = layout.width, H = layout.height;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ touchAction: 'none' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
        <svg width={W} height={H} style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <defs>
            <marker id="mg-arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
              <polygon points="0 0, 9 3.5, 0 7" fill="#475569" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = layout.positions.get(e.from), b = layout.positions.get(e.to);
            if (!a || !b) return null;
            const ac = { x: a.x + layout.nodeW / 2, y: a.y + layout.nodeH / 2 };
            const bc = { x: b.x + layout.nodeW / 2, y: b.y + layout.nodeH / 2 };
            const p1 = borderPoint(a.x, a.y, layout.nodeW, layout.nodeH, bc.x, bc.y);
            const p2 = borderPoint(b.x, b.y, layout.nodeW, layout.nodeH, ac.x, ac.y);
            return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#475569" strokeWidth={1.2} strokeOpacity={0.5} markerEnd="url(#mg-arrow)" />;
          })}
        </svg>
        {nodes.map((n) => {
          const p = layout.positions.get(n.id);
          if (!p) return null;
          const t = n.tags ?? {};
          const majorTag = display?.groupBy ? (t[display.groupBy] ?? [])[0] : (Object.entries(t).find(([d]) => !d.startsWith('ctl:'))?.[1] ?? [])[0];
          const accent = (display?.groupBy ? colorForGroup((t[display.groupBy] ?? [])[0] ?? '∅') : undefined) || STATUS_COLOR[n.status] || '#6b7280';
          return (
            <MissionCard
              key={n.id}
              node={n}
              x={p.x} y={p.y} width={layout.nodeW} height={layout.nodeH}
              selected={n.id === selectedId}
              dimmed={layout.dimmed?.has(n.id) ?? false}
              live={liveIds.has(n.id)}
              rels={relsById.get(n.id) ?? { deps: 0, children: 0, dependents: 0 }}
              accent={accent}
              majorTag={majorTag}
              fields={display?.nodeFields?.length ? display.nodeFields : ['status', 'progress']}
              onSelect={(id) => onSelect(id === selectedId ? null : id)}
            />
          );
        })}
      </div>
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 text-[10px] text-neutral-400">
        <button onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2))} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom in">+</button>
        <button onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z * 0.8))} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom out">−</button>
        <button onClick={fitToView} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Fit">Fit</button>
        <span className="font-mono">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update the page call to pass new props (compile gate)**

`MissionGraphCanvas` now requires `strategy` and `liveIds`. Temporarily wire defaults so the page compiles (Task 9 finishes the wiring). In `web/src/components/missions/dashboard/MissionDashboardPage.tsx`, change the `<MissionGraphCanvas .../>` usage to:

```tsx
<MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} strategy={'clusters'} selectedId={selectedId} liveIds={new Set()} display={view?.display} onSelect={setSelectedId} />
```

- [ ] **Step 3: Typecheck + build**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -c "error TS"` → `39`.

- [ ] **Step 4: Browser smoke — render + no ghost**

Rebuild dev (`source ~/.nvm/nvm.sh && nvm use 20 && ./core.sh restart` from repo root), then on `http://<IP>:3948/mission-graph` (use the LAN IP), via the browser MCP:
- Confirm 19 cards render as HTML (`document.querySelectorAll('foreignObject').length === 0` AND the world `<div>` contains `>15` absolutely-positioned card divs).
- Zoom in 3× via a synthetic `WheelEvent` is NOT wired yet (Task 8); instead set zoom via the `+` button (click it 3×) and confirm the cards stay crisp with no duplicate/stale paint (screenshot; compare card count stays constant, no overlap artifacts).

Expected: cards render, two clusters + a singleton grid visible, no foreignObject.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/missions/dashboard/MissionGraphCanvas.tsx web/src/components/missions/dashboard/MissionDashboardPage.tsx
git commit -m "feat(web): MissionGraphCanvas rewrite — CSS-transform HTML render + auto-fit (no foreignObject)"
```

---

### Task 8: `MissionGraphCanvas` interactions — pan, wheel zoom, double-click fit, touch pinch

**Files:**
- Modify: `web/src/components/missions/dashboard/MissionGraphCanvas.tsx`

**Interfaces:**
- Consumes: Task 7's component.
- Produces: the canvas now handles mouse-drag pan (anywhere), wheel zoom-to-cursor (non-passive), double-click fit, click-to-select with a drag guard, and two-finger touch pinch + one-finger touch pan.

- [ ] **Step 1: Add interaction state/refs + handlers** (inside the component, after the existing `pan`/`zoom` state)

```tsx
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const pinchRef = useRef<{ dist: number; zoom: number; cx: number; cy: number } | null>(null);

  // Zoom toward a focal point, keeping it fixed (reads zoom/pan from closure — proven 0.1.118 pattern).
  const zoomAt = useCallback((factor: number, fx: number, fy: number) => {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    const ratio = nz / zoom;
    setPan({ x: fx - (fx - pan.x) * ratio, y: fy - (fy - pan.y) * ratio });
    setZoom(nz);
  }, [zoom, pan]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    movedRef.current = false;
    draggingRef.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y;
    if (!movedRef.current && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) movedRef.current = true;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, []);
  const onMouseUp = useCallback(() => { draggingRef.current = false; }, []);
```

- [ ] **Step 2: Wheel + touch via native non-passive listeners** (add an effect)

```tsx
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rectXY = (cx: number, cy: number) => { const r = el.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = rectXY(e.clientX, e.clientY);
      zoomAt(e.deltaY > 0 ? 0.9 : 1.1, x, y);
    };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => rectXY((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const m = mid(e.touches);
        pinchRef.current = { dist: dist(e.touches), zoom, cx: m.x, cy: m.y };
      } else if (e.touches.length === 1) {
        movedRef.current = false; draggingRef.current = true;
        dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX: pan.x, panY: pan.y };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const pr = pinchRef.current;
        const ratio = dist(e.touches) / pr.dist;
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pr.zoom * ratio));
        const r = nz / zoom;
        setPan((p) => ({ x: pr.cx - (pr.cx - p.x) * r, y: pr.cy - (pr.cy - p.y) * r }));
        setZoom(nz);
      } else if (e.touches.length === 1 && draggingRef.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - dragStart.current.x, dy = e.touches[0].clientY - dragStart.current.y;
        if (!movedRef.current && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) movedRef.current = true;
        setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
      }
    };
    const onTouchEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinchRef.current = null; if (e.touches.length === 0) draggingRef.current = false; };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [zoomAt, zoom, pan]);
```

- [ ] **Step 3: Wire mouse handlers + drag-guard + double-click to the container**

Change the outer container element to:

```tsx
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: 'none', cursor: 'grab' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={fitToView}
      onClickCapture={(e) => { if (movedRef.current) e.stopPropagation(); }}
    >
```

- [ ] **Step 4: Upgrade the +/- buttons to zoom toward the viewport center**

Replace the two zoom buttons' `onClick` handlers (from Task 7) so they zoom about the center instead of the origin:

```tsx
        <button onClick={() => { const r = containerRef.current?.getBoundingClientRect(); zoomAt(1.2, r ? r.width / 2 : 0, r ? r.height / 2 : 0); }} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom in">+</button>
        <button onClick={() => { const r = containerRef.current?.getBoundingClientRect(); zoomAt(0.8, r ? r.width / 2 : 0, r ? r.height / 2 : 0); }} className="rounded border border-neutral-700 px-1.5 py-0.5" title="Zoom out">−</button>
```

- [ ] **Step 5: Typecheck + rebuild dev**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -c "error TS"` → `39`. Then rebuild dev (`./core.sh restart`).

- [ ] **Step 6: Browser smoke — interactions** (DOM-level on `http://<IP>:3948/mission-graph`, the 19-node graph)

Read the world transform via `document.querySelector('[style*="translate"]').style.transform` and assert:
- **Pan:** dispatch `mousedown` on the container then 6 `mousemove`s (>3px) then `mouseup`; transform `translate` changes; no card selected (no detail panel).
- **Wheel zoom-to-cursor:** dispatch a real `WheelEvent({deltaY:-120})`; `scale` increases and `wheelPreventDefaultWorked` (`ev.defaultPrevented`) is `true`.
- **Double-click fit:** pan away, dispatch `dblclick`; transform returns to a fit value.
- **Click select:** dispatch `mousedown`+`mouseup`+`click` on a card's div (via `document.elementFromPoint`); the detail panel opens.
- **Touch pinch:** dispatch synthetic `TouchEvent`s `touchstart` (2 touches) → `touchmove` (touches farther apart) → `touchend`; `scale` increases.
- **Ghost check:** after several zooms, card DOM count is constant and there are no stale duplicate nodes.

(Use `setTimeout`, not `requestAnimationFrame`, in browser-eval awaits — rAF pauses in a backgrounded tab.)

- [ ] **Step 7: Commit**

```bash
git add web/src/components/missions/dashboard/MissionGraphCanvas.tsx
git commit -m "feat(web): MissionGraphCanvas interactions — pan, wheel zoom, dblclick fit, touch pinch"
```

---

### Task 9: Wire the dashboard — strategy state, live activity, search-reveals-related

**Files:**
- Modify: `web/src/components/missions/dashboard/MissionDashboardPage.tsx`

**Interfaces:**
- Consumes: `MissionLayoutPicker`, `useMissionActivity`, `expandToComponents`, `MissionLayoutStrategy`, the rewritten `MissionGraphCanvas`.
- Produces: the finished dashboard — a Layout dropdown drives `strategy`; live ids feed the canvas; search now reveals each match's whole connected group.

- [ ] **Step 1: Add imports + state**

In `MissionDashboardPage.tsx`, add imports:

```tsx
import { MissionLayoutPicker } from './MissionLayoutPicker';
import { useMissionActivity } from '@/hooks/useMissionActivity';
import { expandToComponents } from '@/lib/mission-graph-adapter';
import type { MissionLayoutStrategy } from '@/lib/mission-layout';
```

Add state near the other `useState`s:

```tsx
  const [strategy, setStrategy] = useState<MissionLayoutStrategy>('clusters');
  const { liveIds } = useMissionActivity();
```

- [ ] **Step 2: Replace `filteredNodes` with search-reveals-related logic**

Replace the existing `filteredNodes` / `nodeIds` / `filteredEdges` block with:

```tsx
  const filteredNodes = useMemo(() => {
    const base = expand.direction !== 'none' ? rawNodes : applyQuickFilters(rawNodes, { statuses, tags });
    const matched = base.filter((n) => matchesSearch(n, search));
    if (!search.trim()) return matched;
    // search active → reveal each match's whole connected group (over the full graph edges)
    const reveal = expandToComponents(rawNodes, graph?.edges ?? [], new Set(matched.map((n) => n.id)));
    return rawNodes.filter((n) => reveal.has(n.id));
  }, [rawNodes, statuses, tags, search, expand.direction, graph]);
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);
```

- [ ] **Step 3: Add the picker to the left panel + reset strategy on view select**

Add `<MissionLayoutPicker .../>` after `<MissionFilterEditor .../>` in the left column:

```tsx
          <MissionLayoutPicker strategy={strategy} onChange={setStrategy} hasSelection={!!selectedId} />
```

- [ ] **Step 4: Pass new props to the canvas**

Replace the canvas usage from Task 7 with the final wiring:

```tsx
          <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} strategy={strategy} selectedId={selectedId} liveIds={liveIds} display={view?.display} onSelect={setSelectedId} />
```

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -c "error TS"` → `39`.

- [ ] **Step 6: Browser smoke — full feature** (rebuild dev, then `http://<IP>:3948/mission-graph`)

- Layout dropdown shows Clusters/Hubs/Focus/Recent; switching relays out the graph (transform/positions change; clusters visibly grouped).
- **Clusters:** the Platform epic + its services form one block; Auth epic + Login/Token + Data/Graph (connected via deps) form their block; truly standalone missions (e.g. "Cross dep B", "Demo") sit in a singleton grid.
- **Hubs:** within the Platform cluster the epic (most edges) is near the cluster center.
- **Focus:** select a mission → it centers, its component radiates, the rest dim.
- **Recent:** (no live sessions on dev → falls back to size order, no error).
- **Search:** type `token` → the Auth/Token connected group stays visible (not just the single match).
- Pan/zoom/pinch/double-click still work; no ghosting on zoom.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/missions/dashboard/MissionDashboardPage.tsx
git commit -m "feat(web): wire Layout picker + live activity + search-reveals-related into the dashboard"
```

---

## Final review & rollout (after all tasks)

- Whole-branch review (opus) over `git merge-base main HEAD`..HEAD.
- Full web vitest: `cd web && npx vitest run` (mission-layout 10 + adapter 14 + smoke = green).
- `cd web && npx tsc --noEmit` → 39 (baseline, no new).
- Browser smoke of every strategy + search + pan/zoom/pinch on the 19-node dev graph; confirm the zoom-ghost is gone.
- Bump 0.1.119 (package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json lm-assist entry), merge `--no-ff` to main, push, deploy fleet (117/123/107) per the established procedure (npm pack Node 20 → 117 `npm i -g`+restart; 123 sudo install + systemd + manual standalone web; 107 stop+EBUSY-retry install+robocopy static+`schtasks /run LmAssistCoreInteractive`, all via PowerShell `-EncodedCommand`).
