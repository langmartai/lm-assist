# Mission Dashboard (web) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "Mission Graph" web tab that renders missions as a graph (tags + parentId/dependsOn) from the sub-2 query/view API, views-first + client-side quick filters, reusing the SVG `DagGraph` renderer.

**Architecture:** A pure `mission-graph-adapter.ts` (TDD via a new vitest) maps the backend `{nodes,edges}` → the `DagGraph` shape and applies display hints; two thin data hooks fetch via the existing `apiClient`; read-only React components assemble the 3-pane tab. The backend (sub-2) is done.

**Tech Stack:** Next.js 16 / React 19 / Tailwind v4 / `DagGraph` SVG renderer / **vitest** (new dev-dep) for the pure adapter.

## Global Constraints

- **The web has no test runner** — Task 1 adds vitest. The pure adapter is TDD'd in vitest; React components/hooks are verified via `cd web && npx tsc --noEmit` (type-check, expect 0 new errors) — there is no unit test for components. A live **browser smoke** on the dev web is a controller step after the tasks, not a subagent task.
- **Data source (sub-2, already on main):** `GET /mission/views` → `{views}`; `GET /mission/views/:id/graph` → `{view, nodes, edges}`; `POST /mission/graph {filter?,expand?}` → `{nodes, edges}`. `MissionNode = {id,title,status,tags:Record<string,string[]>,parentId,progressPercent?}`; `MissionEdge = {from,to,type:'parent'|'dependsOn'}`; `MissionView.display = {groupBy?,highlight?:MissionFilter[],layout?:'tree'|'dag',nodeFields?}`.
- **Fetch pattern (mirror `MissionsPage.tsx`):** `const { apiClient, proxy } = useAppMode();` then `apiClient.fetchPath<T>(path, { method?, body?, machineId: proxy.machineId || undefined })` — returns the unwrapped data; handles the `x-api-key` token + cloud-proxy `_coreapi` routing internally. POST: `{ method:'POST', body: <object> }`.
- **`DagGraph` props:** `{ graph: {nodes:DagNode{id,type,label,metadata:Record<string,unknown>}, edges:DagEdge{from,to,type}, rootId:string|null, stats:{nodeCount,edgeCount,maxDepth,branchCount}}, layoutOptions?, selectedNodeId?, highlightDepth?, onNodeClick?:(node:DagNode)=>void, onNodeHover?, renderNode?:(p:{node,x,y,width,height,selected})=>ReactNode }`.
- **Read-only dashboard:** views come from MCP (`mission_view_set`); this tab renders them. No view-create/edit UI.
- **`@` import alias** = `web/src/`. Tailwind: match the app's existing dark-theme classes (e.g. `bg-neutral-900`, `text-neutral-200`, `border-neutral-800`).

## File Structure

- Create `web/vitest.config.ts`, `web/src/lib/mission-graph-types.ts`, `web/src/lib/mission-graph-adapter.ts`, `web/src/lib/__tests__/mission-graph-adapter.test.ts`.
- Create `web/src/hooks/useMissionViews.ts`, `web/src/hooks/useMissionGraph.ts`.
- Create `web/src/components/missions/dashboard/{MissionGraphCanvas,MissionViewPicker,MissionQuickFilters,MissionNodeDetail,MissionDashboardPage}.tsx`.
- Create `web/src/app/(dashboard)/mission-graph/page.tsx`.
- Modify `web/package.json` (vitest devDep + `test` script), `web/src/components/layout/Sidebar.tsx` (nav entry).

---

### Task 1: vitest setup

**Files:**
- Modify: `web/package.json` (add vitest devDep + `"test"` script)
- Create: `web/vitest.config.ts`, `web/src/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test` (vitest) in the web package, with the `@` → `src` alias resolving.

- [ ] **Step 1: Add vitest + the test script** — in `web/package.json`, add to `"scripts"`: `"test": "vitest run"`, and to `"devDependencies"`: `"vitest": "^2.1.9"`. This is an **npm workspace** (deps hoist to the root `node_modules`), so install from the **repo root**: `npm install` (do NOT run `npm install` inside `web/` — it nests a shadowing `node_modules`). The `vitest` binary hoists to root `node_modules/.bin`, so `cd web && npm test` still resolves it.

- [ ] **Step 2: Create `web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
```

- [ ] **Step 3: Write a smoke test** — `web/src/lib/__tests__/smoke.test.ts`

```ts
import { test, expect } from 'vitest';
test('vitest runs', () => { expect(1 + 1).toBe(2); });
```

- [ ] **Step 4: Run it** — `cd web && npm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
# the lockfile is the ROOT package-lock.json (workspaces), not web/package-lock.json
git add web/package.json package-lock.json web/vitest.config.ts web/src/lib/__tests__/smoke.test.ts
git commit -m "chore(web): add vitest for pure-module unit tests"
```

---

### Task 2: Pure adapter (`mission-graph-adapter.ts`) + types

**Files:**
- Create: `web/src/lib/mission-graph-types.ts`, `web/src/lib/mission-graph-adapter.ts`
- Test: `web/src/lib/__tests__/mission-graph-adapter.test.ts`

**Interfaces:**
- Consumes: `DagGraph`/`DagNode`/`DagEdge` (type-only) from `@/components/dag/dag-types`.
- Produces (Tasks 3–5 import these): types `MissionNode`, `MissionEdge`, `MissionFilter`, `MissionViewDisplay`, `MissionView` (in `mission-graph-types.ts`); functions `toDagGraph(mg, display?): DagGraph`, `matchesHighlight(node, filter): boolean`, `colorForGroup(value): string`, `applyQuickFilters(nodes, qf): MissionNode[]`.

- [ ] **Step 1: Write the failing test** — `web/src/lib/__tests__/mission-graph-adapter.test.ts`

```ts
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
```

- [ ] **Step 2: Run it to confirm RED**

Run: `cd web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts`
Expected: FAIL — cannot resolve `@/lib/mission-graph-adapter`.

- [ ] **Step 3: Create the types** — `web/src/lib/mission-graph-types.ts`

```ts
// Mirrors the sub-project-2 backend shapes (the web cannot import core).
export interface MissionNode { id: string; title: string; status: string; tags: Record<string, string[]>; parentId: string | null; progressPercent?: number; }
export interface MissionEdge { from: string; to: string; type: 'parent' | 'dependsOn'; }
export interface MissionFilter { field: string; op: string; value: unknown; flags?: string; }
export interface MissionViewDisplay { groupBy?: string; highlight?: MissionFilter[]; layout?: 'tree' | 'dag'; nodeFields?: string[]; }
export interface MissionView {
  id: string; name: string;
  query: { filter?: MissionFilter[]; expand?: { direction?: string; depth?: number } };
  display: MissionViewDisplay;
  createdAt: number; updatedAt: number;
}
```

- [ ] **Step 4: Create the adapter** — `web/src/lib/mission-graph-adapter.ts`

```ts
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
      tags: m.tags ?? {},
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
```

- [ ] **Step 5: Run to confirm GREEN**

Run: `cd web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/mission-graph-types.ts web/src/lib/mission-graph-adapter.ts web/src/lib/__tests__/mission-graph-adapter.test.ts
git commit -m "feat(web): pure mission-graph→DagGraph adapter (TDD)"
```

---

### Task 3: Data hooks (`useMissionViews`, `useMissionGraph`)

**Files:**
- Create: `web/src/hooks/useMissionViews.ts`, `web/src/hooks/useMissionGraph.ts`

**Interfaces:**
- Consumes: `useAppMode` from `@/contexts/AppModeContext`; `MissionView`/`MissionNode`/`MissionEdge`/`MissionFilter` from `@/lib/mission-graph-types`.
- Produces (Task 5 imports): `useMissionViews(): { views, loading, error, refresh }`; `useMissionGraph(source): { graph, view, loading, error, refresh }` where `source = { viewId: string } | { filter?: MissionFilter[]; expand?: { direction?: string; depth?: number } } | null`.

- [ ] **Step 1: Create `web/src/hooks/useMissionViews.ts`**

```ts
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { MissionView } from '@/lib/mission-graph-types';

export function useMissionViews() {
  const { apiClient, proxy } = useAppMode();
  const [views, setViews] = useState<MissionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.fetchPath<{ views: MissionView[] }>('/mission/views', { machineId: proxy.machineId || undefined });
      setViews(data?.views ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiClient, proxy.machineId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { views, loading, error, refresh };
}
```

- [ ] **Step 2: Create `web/src/hooks/useMissionGraph.ts`**

```ts
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { MissionView, MissionNode, MissionEdge, MissionFilter } from '@/lib/mission-graph-types';

export type GraphSource = { viewId: string } | { filter?: MissionFilter[]; expand?: { direction?: string; depth?: number } } | null;
type GraphData = { nodes: MissionNode[]; edges: MissionEdge[] };

export function useMissionGraph(source: GraphSource) {
  const { apiClient, proxy } = useAppMode();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [view, setView] = useState<MissionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = source ? JSON.stringify(source) : '';
  const refresh = useCallback(async () => {
    if (!source) { setGraph(null); setView(null); return; }
    setLoading(true);
    setError(null);
    try {
      if ('viewId' in source) {
        const data = await apiClient.fetchPath<{ view: MissionView; nodes: MissionNode[]; edges: MissionEdge[] }>(
          `/mission/views/${encodeURIComponent(source.viewId)}/graph`,
          { machineId: proxy.machineId || undefined },
        );
        setView(data?.view ?? null);
        setGraph({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] });
      } else {
        const data = await apiClient.fetchPath<GraphData>('/mission/graph', { method: 'POST', body: source, machineId: proxy.machineId || undefined });
        setView(null);
        setGraph({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, proxy.machineId, key]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { graph, view, loading, error, refresh };
}
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors in `src/hooks/useMissionViews.ts` / `src/hooks/useMissionGraph.ts` (report any pre-existing unrelated errors but ensure these two files are clean).

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useMissionViews.ts web/src/hooks/useMissionGraph.ts
git commit -m "feat(web): mission views + graph data hooks"
```

---

### Task 4: `MissionGraphCanvas`

**Files:**
- Create: `web/src/components/missions/dashboard/MissionGraphCanvas.tsx`

**Interfaces:**
- Consumes: `DagGraph` from `@/components/dag/dag-types` (type) + the `DagGraph` component from `@/components/dag/DagGraph`; `toDagGraph` from `@/lib/mission-graph-adapter`; `MissionNode`/`MissionViewDisplay` from `@/lib/mission-graph-types`.
- Produces (Task 5 imports): `MissionGraphCanvas({ nodes, edges, display, selectedId, onSelect })`.

- [ ] **Step 1: Create the component** — `web/src/components/missions/dashboard/MissionGraphCanvas.tsx`

```tsx
'use client';
import { useMemo } from 'react';
import { DagGraph } from '@/components/dag/DagGraph';
import type { DagNode } from '@/components/dag/dag-types';
import { toDagGraph } from '@/lib/mission-graph-adapter';
import type { MissionNode, MissionEdge, MissionViewDisplay } from '@/lib/mission-graph-types';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171', done: '#60a5fa', failed: '#ef4444', draft: '#6b7280',
};

export function MissionGraphCanvas({ nodes, edges, display, selectedId, onSelect }: {
  nodes: MissionNode[];
  edges: MissionEdge[];
  display?: MissionViewDisplay;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const graph = useMemo(() => toDagGraph({ nodes, edges }, display), [nodes, edges, display]);
  const groups = useMemo(() => {
    if (!display?.groupBy) return [] as Array<{ value: string; color: string }>;
    const seen = new Map<string, string>();
    for (const n of graph.nodes) {
      const v = ((n.metadata.tags as Record<string, string[]>)?.[display.groupBy] ?? [])[0] ?? '∅';
      if (!seen.has(v)) seen.set(v, n.metadata.groupColor as string);
    }
    return [...seen.entries()].map(([value, color]) => ({ value, color }));
  }, [graph, display?.groupBy]);

  if (graph.nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-neutral-500">No missions match this view.</div>;
  }

  const renderNode = ({ node, width, height, selected }: { node: DagNode; x: number; y: number; width: number; height: number; selected: boolean }) => {
    const dimmed = node.metadata.highlighted === false;
    const accent = (node.metadata.groupColor as string) || STATUS_COLOR[node.metadata.status as string] || '#6b7280';
    const fields = (display?.nodeFields?.length ? display.nodeFields : ['status']) as string[];
    return (
      <div
        className="h-full w-full overflow-hidden rounded-md border bg-neutral-900 px-2 py-1 text-xs"
        style={{ width, height, opacity: dimmed ? 0.35 : 1, borderColor: selected ? '#fff' : accent, borderLeftWidth: 4 }}
      >
        <div className="truncate font-medium text-neutral-100">{node.label}</div>
        <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-neutral-400">
          {fields.map((f) => (
            <span key={f}>{f === 'status' ? String(node.metadata.status) : f === 'progress' ? `${node.metadata.progressPercent ?? 0}%` : String((node.metadata as Record<string, unknown>)[f] ?? '')}</span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="relative h-full w-full">
      <DagGraph
        graph={graph}
        selectedNodeId={selectedId}
        onNodeClick={(n) => onSelect(n.id === selectedId ? null : n.id)}
        renderNode={renderNode}
      />
      {groups.length > 0 && (
        <div className="absolute right-2 top-2 rounded-md border border-neutral-800 bg-neutral-900/90 p-2 text-xs">
          <div className="mb-1 text-neutral-400">{display?.groupBy}</div>
          {groups.map((g) => (
            <div key={g.value} className="flex items-center gap-1.5 text-neutral-200">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: g.color }} />
              {g.value}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: `MissionGraphCanvas.tsx` clean. (Confirm `DagGraph`'s `renderNode` prop signature matches the destructured `{node,x,y,width,height,selected}`.)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/missions/dashboard/MissionGraphCanvas.tsx
git commit -m "feat(web): MissionGraphCanvas — DagGraph wrapper with mission nodes, groups, highlight/dim"
```

---

### Task 5: Page assembly + nav (`MissionDashboardPage`, picker, filters, detail, route, Sidebar)

**Files:**
- Create: `web/src/components/missions/dashboard/{MissionViewPicker,MissionQuickFilters,MissionNodeDetail,MissionDashboardPage}.tsx`, `web/src/app/(dashboard)/mission-graph/page.tsx`
- Modify: `web/src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `useMissionViews`/`useMissionGraph` (Task 3), `MissionGraphCanvas` (Task 4), `applyQuickFilters` (Task 2), the `MissionView`/`MissionNode` types.

- [ ] **Step 1: `MissionViewPicker.tsx`**

```tsx
'use client';
import type { MissionView } from '@/lib/mission-graph-types';

export function MissionViewPicker({ views, activeId, onSelect, onRefresh, loading }: {
  views: MissionView[]; activeId: string | null; onSelect: (id: string | null) => void; onRefresh: () => void; loading: boolean;
}) {
  return (
    <div className="border-b border-neutral-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Views</span>
        <button onClick={onRefresh} className="text-xs text-neutral-400 hover:text-neutral-100" disabled={loading}>↻</button>
      </div>
      <button onClick={() => onSelect(null)} className={`mb-1 block w-full rounded px-2 py-1 text-left text-sm ${activeId === null ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50'}`}>All missions (ad-hoc)</button>
      {views.map((v) => (
        <button key={v.id} onClick={() => onSelect(v.id)} className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${activeId === v.id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50'}`}>{v.name}</button>
      ))}
      {views.length === 0 && !loading && <div className="px-2 py-1 text-xs text-neutral-500">No saved views. Create one via the mission_view_set MCP tool.</div>}
    </div>
  );
}
```

- [ ] **Step 2: `MissionQuickFilters.tsx`**

```tsx
'use client';
import { useMemo } from 'react';
import type { MissionNode } from '@/lib/mission-graph-types';

const STATUSES = ['active', 'waiting', 'paused', 'blocked', 'done', 'failed'];

export function MissionQuickFilters({ nodes, statuses, onToggleStatus }: {
  nodes: MissionNode[]; statuses: string[]; onToggleStatus: (s: string) => void;
}) {
  const present = useMemo(() => new Set(nodes.map((n) => n.status)), [nodes]);
  return (
    <div className="p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Status</div>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.filter((s) => present.has(s)).map((s) => (
          <button key={s} onClick={() => onToggleStatus(s)} className={`rounded-full border px-2 py-0.5 text-xs ${statuses.includes(s) ? 'border-neutral-500 bg-neutral-700 text-neutral-100' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'}`}>{s}</button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `MissionNodeDetail.tsx`**

```tsx
'use client';
import Link from 'next/link';
import type { MissionNode } from '@/lib/mission-graph-types';

export function MissionNodeDetail({ node, onClose }: { node: MissionNode | null; onClose: () => void }) {
  if (!node) return null;
  return (
    <div className="w-72 shrink-0 border-l border-neutral-800 p-4 text-sm">
      <div className="mb-2 flex items-start justify-between">
        <h3 className="font-semibold text-neutral-100">{node.title}</h3>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200">✕</button>
      </div>
      <div className="space-y-1 text-neutral-300">
        <div>Status: <span className="text-neutral-100">{node.status}</span></div>
        {node.progressPercent != null && <div>Progress: {node.progressPercent}%</div>}
        {Object.entries(node.tags ?? {}).map(([dim, vals]) => (
          <div key={dim} className="text-xs">{dim}: {vals.join(', ')}</div>
        ))}
      </div>
      <Link href="/missions" className="mt-3 inline-block text-xs text-blue-400 hover:underline">Open in Missions →</Link>
    </div>
  );
}
```

- [ ] **Step 4: `MissionDashboardPage.tsx`**

```tsx
'use client';
import { useMemo, useState } from 'react';
import { useMissionViews } from '@/hooks/useMissionViews';
import { useMissionGraph, type GraphSource } from '@/hooks/useMissionGraph';
import { applyQuickFilters } from '@/lib/mission-graph-adapter';
import { MissionGraphCanvas } from './MissionGraphCanvas';
import { MissionViewPicker } from './MissionViewPicker';
import { MissionQuickFilters } from './MissionQuickFilters';
import { MissionNodeDetail } from './MissionNodeDetail';

export function MissionDashboardPage() {
  const { views, loading: viewsLoading, refresh: refreshViews } = useMissionViews();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const source: GraphSource = activeId ? { viewId: activeId } : {};
  const { graph, view, loading, error } = useMissionGraph(source);

  const rawNodes = graph?.nodes ?? [];
  const filteredNodes = useMemo(() => applyQuickFilters(rawNodes, { statuses }), [rawNodes, statuses]);
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);
  const selectedNode = useMemo(() => filteredNodes.find((n) => n.id === selectedId) ?? null, [filteredNodes, selectedId]);

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <MissionViewPicker views={views} activeId={activeId} onSelect={(id) => { setActiveId(id); setSelectedId(null); }} onRefresh={refreshViews} loading={viewsLoading} />
        <MissionQuickFilters nodes={rawNodes} statuses={statuses} onToggleStatus={toggleStatus} />
      </div>
      <div className="relative flex-1">
        {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
        {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
        <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} display={view?.display} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <MissionNodeDetail node={selectedNode} onClose={() => setSelectedId(null)} />
    </div>
  );
}
```

- [ ] **Step 5: Route + nav** — create `web/src/app/(dashboard)/mission-graph/page.tsx`:

```tsx
import { MissionDashboardPage } from '@/components/missions/dashboard/MissionDashboardPage';
export default function Page() { return <MissionDashboardPage />; }
```

In `web/src/components/layout/Sidebar.tsx`: add `Network` to the existing `lucide-react` import, and add to `baseNavItems` (after the `/missions` entry): `{ href: '/mission-graph', icon: Network, label: 'Mission Graph' },`.

- [ ] **Step 6: Type-check the whole new surface**

Run: `cd web && npx tsc --noEmit`
Expected: all new files clean (report any pre-existing unrelated errors separately).

- [ ] **Step 7: Commit**

```bash
git add web/src/components/missions/dashboard/ web/src/app/(dashboard)/mission-graph/page.tsx web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): Mission Graph dashboard tab (view picker, quick filters, graph, detail)"
```

---

## Done criteria

- `npm test` (web) green incl. the adapter suite; `cd web && npx tsc --noEmit` clean for the new files.
- A "Mission Graph" tab renders: pick a saved view → its graph draws (nodes=missions, edges=parent/dependsOn) with display hints (layout/groupBy-color/highlight-dim/nodeFields); status quick-filters narrow it; clicking a node opens the detail panel with a link to `/missions`; "All missions (ad-hoc)" renders `POST /mission/graph`.
- **Controller browser-smoke (after the tasks, before merge):** `./core.sh start` (Node ≥ 20.9), open `http://<IP>:3948/mission-graph`, verify a view renders + node click works.

**Out of scope:** the sub-2 backend (done); controller view composition (sub-3).
