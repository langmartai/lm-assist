# Mission Graph-Query API & Dashboard Views — Design

**Goal:** Give missions a graph-DB-style query layer — filter by attributes (incl. tag dimensions), traverse relationships (parentId tree + dependsOn DAG), and return drawable graphs — plus saved, MCP-composed "views" (a query + display hints) that the future Mission Dashboard renders.

**Status:** Sub-project **2 of 4** of the mission-enhancement program. Build order: (1) Foundation [DONE, merged `cce8bc6`] → **(2) Graph-query API & views [this spec]** → (3) Controller intelligence → (4) Mission Dashboard (web). #2 needs #1; #3 and #4 both build on #2. This sub-project is the **headless backend** — fully testable via MCP/REST; no web UI here.

**Tech stack:** TypeScript (CommonJS core), LMDB via the generic data service, `node:test`, MCP tools proxying leader-anchored REST routes.

---

## Context — what the foundation + platform already provide

- **Foundation (sub-project 1, shipped):** `Mission` now carries `tags: Record<string,string[]>`, `parentId: string|null`, `dependsOn: string[]`, `rev`, `history`. `listMissions(port)` (`core/src/mission/mission-store.ts`) returns all non-reserved missions (backfilled). Reads are leader-anchored at the route layer (`anchorToLeader(..., failClosed=false)` → falls back to the local synced copy), writes fail-closed.
- **Generic filter engine:** `core/src/data/backends/query-filter.ts` — `applyQuery(rows, QuerySpec)` + `matches(rec, filter)` implement the op vocabulary `eq/ne/gt/gte/lt/lte/in/nin/contains/regex/wildcard/exists` (+ symbolic aliases `>=,>,<=,<,=,!=`), with ReDoS-guarded regex. This is the vocabulary `data_query` exposes. Caveat: `matches`' `contains` is string-substring and `in` is "value ∈ filter-array" — neither does **array-field-includes**, which tag dimensions / `dependsOn` / `projects` need; the mission filter adds array semantics (below).
- **No relationship traversal exists** for missions; `mission_list` takes no args and returns everything.
- **Web graph renderer (sub-project 4 consumer):** `web/src/components/dag/` — `DagGraph` takes generic `{ nodes: DagNode{id,type,label,metadata}, edges: DagEdge{from,to,type} }` (zoom/pan, BFS highlight, dimming). The graph output here maps straight onto it.
- **MCP boot-critical:** every advertised tool needs a `TOOL_SCOPES` entry (`configure.ts`) or `assertScopesCoverTools()` throws at startup. The foundation added `mission_tag`/`mission_history`; MISSION_TOOL_DEFS is now 14 (strict-enumerated in `mission-mcp.test.ts`).

---

## Scope

**In scope:** the pure query/traversal engine, 3 query tools + routes, the `mission-views` store + view model + 4 view tools + a view-render route, validation, and tests.

**Out of scope (sub-project 4):** the web dashboard itself — drawing the graph, applying the display hints, the tab/page. This sub-project only produces the data + view definitions the dashboard will consume.

---

## Decisions (resolved with the user)

| Decision | Choice |
|---|---|
| API shape | **Focused tools** — three composable query tools (`mission_query` filter→list, `mission_neighbors` one mission's N-hop neighbors, `mission_graph` filter→drawable graph) **plus** a dashboard-view tool family. (Not one mega-query, not reuse-`data_query`.) |
| Dashboard view content | **Query + display hints** — a saved/named view = a query (filter + relationship expand) PLUS display hints (group-by tag dimension, highlight/dim rule, layout, node fields). MCP composes it; the web renders it. (Not query-only; not a full UI-spec language.) |

---

## §1 — Query engine (pure) + 3 query tools

### Pure modules

**`core/src/mission/mission-filter.ts`** — `filterMissions(missions: Mission[], filter?: MissionFilter[], opts?: { sort?; limit? }): Mission[]`.
- `MissionFilter = { field: string; op: FilterOp; value: unknown; flags?: string }` — the data-service op vocabulary (`eq/ne/gt/gte/lt/lte/in/nin/contains/regex/wildcard/exists` + symbolic aliases). Clauses AND-ed.
- A **mission field resolver** maps `field` → value: top-level scalars (`status`, `parentId`, `title`, `objective`, `rev`, `ownerNode`), array fields (`dependsOn`, `projects`), and **tag dimensions** via the `tags.<dim>` path (`tags.component` → `mission.tags['component']`, an array; absent → `undefined`).
- **Array semantics** (for `dependsOn`, `projects`, `tags.<dim>`): `contains v` = array includes `v`; `in [vs]` = array intersects `vs`; `nin [vs]` = array disjoint from `vs`; `exists true/false` = array present & non-empty / empty-or-absent. **Scalar semantics** (status, parentId, rev, …) reuse the standard op meanings (`eq/ne/gt/…/regex/wildcard/contains`-substring/`exists`). A bad op → structured `BAD_FILTER_OP`; an invalid regex → `BAD_REGEX` (never silently-empty), mirroring `data_query`.
- `sort` = `[{field, dir}]` (resolved via the same field resolver); `limit` caps results.

**`core/src/mission/mission-traverse.ts`** — pure graph walks over a mission set:
- `neighbors(id: string, all: Mission[], opts: { direction: Direction; depth: number }): { neighbors: Mission[]; edges: MissionEdge[] }` where `Direction = 'parents'|'children'|'dependencies'|'dependents'|'all'`. `parents`/`children` follow `parentId`; `dependencies` = the missions in `m.dependsOn`; `dependents` = missions whose `dependsOn` includes `id`. BFS to `depth` (default 1), cycle-safe (visited set).
- `subgraphEdges(nodeIds: Set<string>, all: Mission[]): MissionEdge[]` — every `parent` + `dependsOn` edge **between** nodes in the set.
- `MissionEdge = { from: string; to: string; type: 'parent' | 'dependsOn' }`. A **parent** edge is `{ from: parentId, to: childId, type:'parent' }`; a **dependsOn** edge is `{ from: missionId, to: dependencyId, type:'dependsOn' }`.

### Tools (all scope `read`, leader-anchored reads → local-synced fallback)

- **`mission_query({ filter?, sort?, limit? })` → `{ missions: Mission[] }`** — `filterMissions` over `listMissions`. The flat list for the controller / ad-hoc.
- **`mission_neighbors({ id, direction?, depth? })` → `{ mission, neighbors: MissionNode[], edges: MissionEdge[] }`** — `neighbors(id, …)`. `direction` default `all`, `depth` default 1. `NOT_FOUND` if the id is absent.
- **`mission_graph({ filter?, expand? })` → `{ nodes: MissionNode[], edges: MissionEdge[] }`** — `filterMissions` selects matches; `expand = { direction?, depth? }` optionally adds their neighbors; the node set = matches ∪ expanded; `edges = subgraphEdges(nodeIds)`. The drawable graph.
- **`MissionNode`** (lightweight, maps to web `DagNode`): `{ id, title, status, tags, parentId, progressPercent? }`.

**Routes:** `POST /mission/query`, `POST /mission/:id/neighbors`, `POST /mission/graph` — **POST is canonical** (the `filter`/`expand` JSON rides the request body to avoid URL-encoding large specs, and MCP reaches them via `workerPost`). These are **reads despite the verb**: they leader-anchor with `failClosed=false` (fall back to the local synced copy). No GET aliases (sub-project 4 calls the POST endpoints + the `GET /mission/views/:id/graph` render route).

---

## §2 — Mission views (saved query + display hints)

### Model (`core/src/mission/mission-views.ts`, pure)

```ts
interface MissionView {
  id: string;                 // 'view_<hex>' — canonical key (get/render/delete address by id)
  name: string;               // human label (not necessarily unique)
  query: {
    filter?: MissionFilter[];                                   // §1 filter shape
    expand?: { direction?: Direction; depth?: number };         // §1 traversal
  };
  display: {
    groupBy?: string;          // a tag dimension, e.g. 'project' (group nodes by tags.project)
    highlight?: MissionFilter[];  // predicates marking emphasized nodes (others dimmed)
    layout?: 'tree' | 'dag';   // tree = parentId hierarchy; dag = dependsOn
    nodeFields?: string[];     // mission fields to label each node with
  };
  createdBy: MissionActor;     // provenance, reused from the foundation
  lastUpdatedBy: MissionActor;
  createdAt: number;
  updatedAt: number;
}
```
Pure helpers: `newView(input, now, genId)`; `normalizeView(v)` (trim name, coerce `display` enums, drop unknown keys); `validateView(v)` (non-empty `name`; valid `layout`/`direction`; `groupBy` is a string) → structured `INVALID_VIEW`.

The view's **`query.filter` is the "smart filter (only show what's relevant)"** — the controller composes it; `display.highlight` is optional emphasis within that set.

### Storage (`core/src/mission/mission-views-store.ts`, mirrors `mission-store`)

A new **`mission-views` dataset** (backend `cache`/LMDB, `visibility:'cross-node-readable'`, `syncMode:'full'`) — fleet-wide, leader-anchored, survives failover. Port seam (`MissionViewPort { isEnabled; get; list; put; del }`) + `livePort()` over `getDataService()` + an in-memory fake for tests; `getView`/`listViews`/`putView`/`deleteView`. Writes set provenance (`MissionActor`) like missions.

### Tools + render route

- **`mission_view_set({ id?, name, query, display })` → the view** (scope `write`) — create (no id → genId) or update (id given). Normalizes + validates; provenance stamped via the actor hint. Leader-anchored write (fail-closed). `POST /mission/views`.
- **`mission_view_list({})` → `{ views: MissionView[] }`** (scope `read`). `GET /mission/views`.
- **`mission_view_get({ id })` → the view** (scope `read`). `GET /mission/views/:id`. (The dashboard lists views then addresses the chosen one by `id`.)
- **`mission_view_delete({ id })` → `{ deleted }`** (scope `write`). `DELETE /mission/views/:id`.
- **Render endpoint `GET /mission/views/:id/graph` → `{ view, nodes, edges }`** — loads the view, runs its `query` (filter + expand) through the §1 engine, returns the graph + the view's `display` hints for the web to apply. The dashboard's one-call "render this view." (Exposed as a route; MCP callers can `mission_view_get` then `mission_graph`, so no separate render tool — YAGNI.)

All new tool scopes added to `TOOL_SCOPES`: `mission_query:'read'`, `mission_neighbors:'read'`, `mission_graph:'read'`, `mission_view_set:'write'`, `mission_view_list:'read'`, `mission_view_get:'read'`, `mission_view_delete:'write'` (omission → boot failure).

---

## §3 — Output shapes (summary)

- `mission_query` → `{ missions: Mission[] }` (full mission-aware records).
- `mission_neighbors` → `{ mission: Mission, neighbors: MissionNode[], edges: MissionEdge[] }`.
- `mission_graph` and the view-render route → `{ nodes: MissionNode[], edges: MissionEdge[] }` (+ `view` on the render route). `MissionNode = { id, title, status, tags, parentId, progressPercent? }`; `MissionEdge = { from, to, type:'parent'|'dependsOn' }` with the directions defined in §1.

---

## §4 — File structure & testing

**New files:** `mission-filter.ts` (pure filter), `mission-traverse.ts` (pure traversal), `mission-views.ts` (pure view model), `mission-views-store.ts` (view dataset + port). The 3 query + 4 view tool defs/handlers live in a **new `core/src/mcp-server/tools/mission-query.ts`** (keeping `mission.ts` from growing past its 14 tools), registered in `expanded.ts`. Routes added to `mission.routes.ts`; scopes to `configure.ts`.

**Tests** (`node:test`, TDD, the repo's `cd core && npm run build:test && node --test dist-test/__tests__/<f>.test.js` pattern):
- `mission-filter.test.ts` — each op on scalar fields; tag-dimension `tags.<dim>` contains/in/exists; `dependsOn`/`projects` array semantics; sort + limit; `BAD_FILTER_OP`/`BAD_REGEX`.
- `mission-traverse.test.ts` — each `direction`; depth>1 BFS; cycle-safety; `subgraphEdges` emits only in-set edges with correct `from/to/type`.
- `mission-views.test.ts` — `newView` defaults; `normalizeView`; `validateView` (missing name / bad layout/direction → `INVALID_VIEW`).
- `mission-views-store.test.ts` (in-memory port) — set/get/list/delete round-trip; provenance stamped.
- `mission-query-routes.test.ts` — `mission_query`/`mission_neighbors`/`mission_graph` handlers (filter, neighbors, graph nodes+edges); view CRUD + the render route returns `{view, nodes, edges}`; `NOT_FOUND`/`INVALID_VIEW`; scope coverage (`assertScopesCoverTools`).

Implementation via **subagent-driven-development** + TDD, mirroring the foundation.

---

## Open questions

None — API shape (focused tools + views) and view content (query + display hints) are resolved; storage (a `mission-views` dataset), tool surface, filter/traversal/view shapes, and the render route are specified above.
