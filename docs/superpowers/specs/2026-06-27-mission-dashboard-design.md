# Mission Dashboard (web) — Design

**Goal:** A new "Mission Graph" web tab that renders missions as a graph (tags + parentId/dependsOn relationships) driven by the sub-project-2 query/view API — views-first (the controller composes saved views via MCP; the web renders them) with lightweight client-side quick filters — reusing the existing SVG `DagGraph` renderer.

**Status:** Sub-project **4 of 4** of the mission-enhancement program (foundation #1 + graph-query/views #2 are merged to main). This is the **web/UI** layer; the backend is done. #4 needs #2 (done). Build order chosen by the user: **#4 (this) → #3 (controller intelligence) → one fleet deploy of the whole program.**

**Tech stack:** Next.js 16 / React 19 / Tailwind v4 / Zustand (existing web app); the hand-rolled SVG `DagGraph` renderer; **vitest** (new dev-dep) for the pure adapter.

---

## Context — what exists

- **Sub-2 backend (the data source):** `POST /mission/graph {filter?, expand?}` → `{nodes: MissionNode[], edges: MissionEdge[]}`; `GET /mission/views` → `{views}`; `GET /mission/views/:id/graph` → `{view, nodes, edges}` (a saved view's rendered graph + its display hints); `mission_view_*` MCP tools. `MissionNode = {id, title, status, tags: Record<string,string[]>, parentId, progressPercent?}`; `MissionEdge = {from, to, type:'parent'|'dependsOn'}`; `MissionView.display = {groupBy?, highlight?, layout?:'tree'|'dag', nodeFields?}`.
- **Reusable renderer** `web/src/components/dag/`: `DagGraph({ graph, layoutOptions?, selectedNodeId?, highlightDepth?, onNodeClick?, onNodeHover?, renderNode? })` where `graph: { nodes: DagNode{id,type,label,metadata}, edges: DagEdge{from,to,type}, rootId: string|null, stats:{nodeCount,edgeCount,maxDepth,branchCount} }`. It does zoom/pan, layered layout (`dag-layout.ts` `computeDagLayout`, LR/TB), BFS connection highlight (`highlightDepth`), and dims unconnected nodes. `renderNode` lets us draw a custom mission node card. Template consumer: `useSessionDag` hook + `DagTab.tsx`.
- **API client:** `useAppMode().apiClient` + the `apiFetch`/`fetchPath(path, opts)` pattern (`MissionsPage` uses it for both GET and `POST /mission`); the `x-api-key` worker token + the cloud-proxy `_coreapi` routing are handled inside the client.
- **Nav:** add a tab by adding `{href, icon, label}` to `baseNavItems` in `web/src/components/layout/Sidebar.tsx` + an `app/(dashboard)/<name>/page.tsx`.
- **Testing gap:** the web package has **no test runner** (no vitest/jest, no `.test` files) — addressed in §6.

---

## Scope

**In scope:** the new "Mission Graph" tab — a pure mission-graph→DagGraph adapter, two data hooks, the dashboard components (page, canvas, view picker, quick filters, node detail), the nav entry, and a minimal vitest setup for the pure adapter.

**Out of scope:** any sub-2 backend change (done); the controller composing views (sub-3); editing missions from the dashboard (it links into the existing `MissionsPage` for that).

---

## Decisions (resolved with the user)

| Decision | Choice |
|---|---|
| Interaction model | **Views-first + quick filters** — list saved views, pick one, render its graph via the render route; client-side status/tag quick filters narrow the displayed nodes; ad-hoc `POST /mission/graph` when no view is selected. |
| Placement | A **new top-level "Mission Graph" sidebar tab** (separate from the chat-first `MissionsPage`), 3-pane: left = view picker + filters, center = graph, right = node detail. |
| Testing | Add **vitest** to the web package; TDD the pure adapter; React components verified via `tsc` + browser smoke. |

---

## §1 — Placement & layout

- `web/src/app/(dashboard)/mission-graph/page.tsx` renders `<MissionDashboardPage/>`. `Sidebar.tsx` gains `{ href: '/mission-graph', icon: <a lucide icon, e.g. Network/Share2>, label: 'Mission Graph' }` in `baseNavItems`.
- Layout (Tailwind, matching the app's dark theme): a left rail (`MissionViewPicker` over `MissionQuickFilters`), a center flex-fill graph canvas (`MissionGraphCanvas`), and a right detail panel (`MissionNodeDetail`) that is hidden until a node is clicked.

## §2 — Pure adapter (`web/src/lib/mission-graph-adapter.ts`)

`toDagGraph(missionGraph: { nodes: MissionNode[]; edges: MissionEdge[] }, view?: MissionViewDisplay): DagGraph`:
- **Nodes** → `DagNode{ id, type:'mission', label: title, metadata: { status, tags, parentId, progressPercent, highlighted: boolean, groupColor?: string } }`.
- **Edges** → filtered by the `layout` hint: `layout:'tree'` keeps only `type:'parent'` edges; `layout:'dag'` keeps only `type:'dependsOn'`; **default (no layout)** keeps **both**. Mapped to `DagEdge{from,to,type}`.
- **`groupColor`** — when `display.groupBy` is set, assign each node a deterministic color from a fixed palette keyed by its first `tags[groupBy]` value (a pure `colorForGroup(value)` over a 12-color palette; missing dimension → a neutral color). The canvas renders a legend.
- **`highlighted`** — the adapter evaluates `display.highlight` (a `MissionFilter[]`) against each node with a small **pure** predicate `matchesHighlight(node, filter)` — a web-local subset of the server op semantics (`eq`/`ne`/`in`/`contains`/`exists` over `status`, `parentId`, and `tags.<dim>` arrays). Match → `metadata.highlighted:true`. When there is no `highlight` hint, every node is `highlighted:true`. The canvas dims the `false` ones (§5). (This is a bounded, tested re-implementation of just the ops a highlight uses — the web cannot import the core `mission-filter` module.)
- **`rootId`** — the first node with no in-set parent (or `null`).
- **`stats`** — `{nodeCount, edgeCount, maxDepth, branchCount}` computed from the resolved nodes/edges (maxDepth via the same layered pass `dag-layout` would do, or a simple longest-path; branchCount = nodes with >1 child).
- PURE, no React/DOM. `MissionViewDisplay`/`MissionNode`/`MissionEdge` types are declared in a small `web/src/lib/mission-graph-types.ts` (mirroring the sub-2 shapes) so the adapter + hooks share them.

## §3 — Data hooks

- `useMissionViews(): { views, loading, error, refresh }` — `apiFetch('/mission/views')` (GET), polled/refreshable.
- `useMissionGraph(source: { viewId: string } | { filter?: MissionFilter[]; expand? }): { graph, view?, loading, error, refresh }` — for a `viewId`, `GET /mission/views/:id/graph`; for an ad-hoc filter, `POST /mission/graph`. Returns the raw `{nodes,edges}` (+ `view` for the render route). Both use `useAppMode().apiClient` exactly as `MissionsPage` does (token + cloud-proxy handled). Optional 5 s polling toggle; manual `refresh()`.

## §4 — Components

- **`MissionDashboardPage`** — holds selected `viewId`, quick-filter state, and `selectedNodeId`; calls the hooks; runs `toDagGraph`; applies client-side quick filters (narrowing the node set) before passing to the canvas.
- **`MissionGraphCanvas`** — wraps `DagGraph`, supplies a mission `renderNode` (a card showing the `nodeFields` + status color + `groupColor` accent + progress), maps `selectedNodeId`/`onNodeClick`, and drives highlight/dim (§5). Shows the groupBy legend + empty/error states.
- **`MissionViewPicker`** — lists `useMissionViews().views`; select a view; shows the active view's name; a "Refresh" control. **The dashboard is read-only:** views are created/edited via MCP (`mission_view_set` — the controller in sub-3, or a manual call); this tab renders them. No view-create/edit UI in this sub-project.
- **`MissionQuickFilters`** — status chips (active/waiting/paused/blocked/done/failed) + a tag-dimension/value chip picker derived from the loaded graph's tags; toggles narrow the displayed nodes client-side.
- **`MissionNodeDetail`** — on node click, shows the mission's title/status/tags/objective/progress + a link to open it in `/missions`.

## §5 — Display hints → renderer

- `layout` → adapter edge selection (§2) + `DagGraph` `layoutOptions` direction.
- `groupBy` → node `groupColor` + a legend (color grouping, not spatial — `DagGraph` is layered).
- `highlight` → the canvas computes the highlighted id set (nodes whose `metadata.highlighted` is true) and renders non-highlighted nodes dimmed (lower opacity in `renderNode`), independent of `DagGraph`'s connection-based `highlightDepth` (which stays available for hover). When no `highlight` hint, nothing is dimmed.
- `nodeFields` → which mission fields the `renderNode` card displays (default: title + status + progress).
- The view's server-side `query.filter` already selected which missions are in the graph ("only show what's relevant"); quick filters narrow further client-side.

## §6 — Testing

- Add **vitest** as a web dev-dependency + a `"test": "vitest run"` script + `web/vitest.config.ts` (jsdom not required — the adapter is pure). 
- **TDD** `mission-graph-adapter.ts`: node mapping (label/metadata), edge selection per `layout` (tree=parent-only, dag=dependsOn-only, default=both), `colorForGroup` determinism + palette, `highlighted` set from a `highlight` filter, `rootId`, `stats`. Plus any pure quick-filter helper (`applyQuickFilters(nodes, {statuses, tags})`).
- React components + hooks: thin, verified via `tsc --noEmit` (or the next build) + a **browser smoke** on the dev web (`./core.sh start` needs Node ≥ 20.9; open `http://<IP>:3948/mission-graph`, select a view, confirm the graph draws + a node click opens the detail). SDD: the adapter task is TDD; component/hook tasks are implement + tsc-clean + a documented browser-verify step.

## §7 — File structure

- Create: `web/src/lib/mission-graph-types.ts`, `web/src/lib/mission-graph-adapter.ts`, `web/src/lib/__tests__/mission-graph-adapter.test.ts`.
- Create: `web/src/hooks/useMissionViews.ts`, `web/src/hooks/useMissionGraph.ts`.
- Create: `web/src/components/missions/dashboard/{MissionDashboardPage,MissionGraphCanvas,MissionViewPicker,MissionQuickFilters,MissionNodeDetail}.tsx`.
- Create: `web/src/app/(dashboard)/mission-graph/page.tsx`, `web/vitest.config.ts`.
- Modify: `web/src/components/layout/Sidebar.tsx` (nav entry), `web/package.json` (vitest devDep + `test` script).
- Reuse: `web/src/components/dag/{DagGraph,dag-layout,dag-types}`, `web/src/lib/api-client.ts`, `web/src/contexts/AppModeContext.tsx`.

---

## Open questions

None — interaction model (views-first + quick filters), placement (new top-level tab), display-hint mapping, and the testing approach (vitest for the pure adapter) are resolved.
