# Mission Dashboard Enhancements (sub-4 v2) — Design

**Goal:** Make the Mission Graph dashboard richer and directly customizable — a friendly filter editor (dropdowns + Save-as-view), text search, comprehensive node detail (full mission + relationships + history + sub-3 scheduling intel), tag/attribute surfacing in BOTH the dashboard and the Missions page, and a cleaner layout.

**Status:** Enhancement of the shipped sub-4 Mission Graph dashboard (the mission-enhancement program 1–4 is deployed at 0.1.115 on 117/123). Web-only; the backend (sub-1/2/3) is reused as-is. Branch `feat/mission-dashboard-enhancements`.

**Tech stack:** Next.js 16 / React 19 / Tailwind v4 / Zustand (existing web). Reuses the SVG `DagGraph`, the sub-4 adapter/hooks, and the sub-2/3 mission APIs. Pure helpers TDD'd via vitest.

---

## Decisions (resolved with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Filter-editor model | **Ad-hoc builder + Save as view** — friendly dropdowns (status multi, tag dimension→values, relationship/expand) that drive `POST /mission/graph` and instantly re-render; a "Save as view" persists via `mission_view_set`. No raw field/op/value query language exposed. |
| 2 | Node detail richness | **Comprehensive + scheduling intel** — fetch the full mission on click and show objective/plan/nextSteps, all tags, relationships, recent history, sessions, AND the live scheduler state. |
| 3 | Quick-chips vs editor | The filter editor **subsumes** today's standalone status/tag quick-chips — one unified filter UI, not two parallel rows. |

---

## Context — what exists (verified)

- **The graph node is a lightweight projection:** `MissionNode = {id, title, status, tags: Record<string,string[]>, parentId, progressPercent}` (`toNode`, `mission-traverse.ts:8`). It does NOT carry objective/plan/nextSteps/dependsOn/history — those need a per-mission fetch.
- **`GET /mission/:id`** (`handleGet`, `mission.routes.ts:131`, leader-anchored) returns the **full Mission** (`ok(m)`) incl objective, plan, nextSteps, tags, parentId, dependsOn, status, progress, history, adjustments, binding. **`GET /mission/:id/sessions`** (`handleSessions`, route `mission.routes.ts:1277`) returns bound sessions. **`POST /mission/schedule`** (sub-3) returns `{ready, blocked[{id,reason}], serializeGroups, epicRollups, containers}`. **No backend change is required.**
- **The dashboard** (`MissionDashboardPage`) is a 3-pane: left = `MissionViewPicker` + `MissionQuickFilters` (status chips + tag-dimension chips), center = `MissionGraphCanvas` (reuses `DagGraph`), right = `MissionNodeDetail` (minimal: title/status/progress/tags/link). Hooks: `useMissionViews`, `useMissionGraph(source)`; adapter `toDagGraph`/`applyQuickFilters`/`colorForGroup`/`matchesHighlight`.
- **The Missions page** (`MissionsPage`) has a keyword search (space-separated terms ANDed over `title/objective/id/status`, line 252-264) but renders **no tags** and no parent/dependsOn on its list items. The mission detail tab (`MissionDetailView`) likewise omits tags/relationships.
- **`MissionFilter`** (web mirror, `mission-graph-types.ts`): `{ field: string; op: string; value: unknown; flags?: string }`. The backend `mission-filter` resolves `tags.<dim>` fields + array ops (contains/in/eq/…). `MissionView.display = { groupBy?, highlight?, layout?: 'tree'|'dag', nodeFields? }`.

---

## Scope

**In scope:** the dashboard shell/layout, a text search, a comprehensive node-detail panel (fetch-on-click), the filter editor (ad-hoc dropdowns + save-as-view, subsuming the quick-chips), tag/attribute surfacing on the dashboard cards/detail AND on the Missions page list+detail, plus the pure helpers + tests.

**Out of scope:** any backend/API change (reuse existing); the controller's MCP view composition (unchanged — saved views from the editor join the same list the controller reads/writes); editing mission FIELDS from the dashboard (the detail links into `/missions` for that, via the existing deep-link).

---

## §1 — Layout & info (the shell)

`MissionDashboardPage` stays 3-pane, refined:
- **Header bar:** the page title + a live summary — `"N shown / M total · <active view or 'ad-hoc filter'> · groupBy: <dim>"` — and a Refresh control (wires the existing `useMissionGraph().refresh` + `refreshViews`).
- **Left rail (scrollable):** (1) `MissionViewPicker` (existing — pick a saved view), (2) `MissionSearchBox` (§2), (3) `MissionFilterEditor` (§4, collapsible). The standalone `MissionQuickFilters` is REMOVED — its status/tag controls move into the filter editor (decision #3).
- **Center:** `MissionGraphCanvas` (existing) + the groupBy legend.
- **Right:** `MissionNodeDetail` (§3) — widened (~w-80), scrollable, hidden until a node is clicked.

Tailwind, matching the app's dark theme. The rail uses clear section headers ("View", "Search", "Filter").

## §2 — Text search (`MissionSearchBox` + a pure matcher)

- `MissionSearchBox`: a controlled text input in the left rail; `value`/`onChange` lifted to `MissionDashboardPage` state (`search`).
- A pure `matchesSearch(node: MissionNode, query: string): boolean` (in `mission-graph-adapter.ts`): space-separated terms ANDed (mirrors MissionsPage); each term matches case-insensitively against `title`, `id`, `status`, and any `tags[dim]` value. Empty query → all match.
- `MissionDashboardPage` applies it alongside the existing `applyQuickFilters` to narrow the displayed nodes (then re-filters edges to the surviving node set, as today).

## §3 — Comprehensive node detail (`MissionNodeDetail` + `useMissionDetail`)

- New hook `useMissionDetail(id: string | null): { mission, schedule, sessions, loading, error }` — when `id` is set, fetches in parallel `GET /mission/:id`, `POST /mission/schedule`, `GET /mission/:id/sessions` via `useAppMode().apiClient.fetchPath` (token + cloud-proxy handled). Re-fetches when `id` changes; returns nulls when `id` is null.
- A web-local `MissionFull` type (in `mission-graph-types.ts`) mirroring the fields the panel reads: `{ id, title, status, objective?, plan?, nextSteps?: string[], tags, parentId, dependsOn?: string[], progress?: {percent?: number}, history?: MissionChange[], ... }` and `MissionChange = { rev, at, actor: {kind,channel,label?,id?}, changes: Record<string,{from,to}> }`.
- `MissionNodeDetail` (rewritten) renders, on a clicked node:
  - **Header:** title, status badge, progress.
  - **Objective / Plan / Next steps** (from the full mission).
  - **Tags** grouped by dimension; author dims (project/feature/component/…) vs `ctl:*` dims styled distinctly (a "controller" label on `ctl:*`).
  - **Relationships:** parent (if any), dependsOn list, and dependents/children (derived from the loaded graph edges) — each rendered as a chip that, on click, calls `onSelect(thatId)` to **jump to that node** in the graph + detail.
  - **Scheduling state:** from `schedule` — this id in `ready` / `blocked` (+ reason) / a `serializeGroups` member / an `epicRollups` parent; rendered as a one-line status ("Ready" / "Blocked: dependency on …" / "Serialized in group X" / "Epic: 2/5 done").
  - **Recent history:** the last N `history` entries — `rev · <actor label/kind> · <relative time> · changed: <fields>`.
  - **Sessions:** bound sessions (sid + status), if any.
  - **"Open in Missions →"** deep-link (kept, `/missions?mission=<id>`).
  - Loading/error states while fetching.

## §4 — Filter editor (`MissionFilterEditor` + a pure builder)

A collapsible "Filter" panel (left rail) with **friendly dropdowns** — NO raw query language:
- **Status:** multi-select chips (active/waiting/paused/blocked/done/failed).
- **Tags:** for each tag dimension present in the loaded graph, a value multi-select (e.g. `project: [web, infra]`). Dimensions/values derived from the loaded nodes (same derivation the old quick-filters used).
- **Relationship / expand:** a small control — direction (none / dependencies / children / all) + depth (1–3) — mapping to the graph `expand`.
- **Reset** (→ all missions) and **Save as view** (prompts a name → `mission_view_set` with the built filter + current display hints → refreshes the view list).

**How it drives the graph (client-fast, server-for-scope):**
- **Status + tag selections narrow CLIENT-SIDE instantly** via the existing `applyQuickFilters` over the loaded node set (no round-trip) — snappy.
- **The expand/relationship control + Save-as-view build a server `MissionFilter[]` + `expand`** via a pure `buildFilter(state): { filter: MissionFilter[]; expand?: {direction,depth} }` and drive `useMissionGraph({ filter, expand })` (the existing ad-hoc path → `POST /mission/graph`). So changing scope re-queries the server; status/tag narrowing stays instant.
- `buildFilter` (pure, in `mission-graph-adapter.ts`): status → `{field:'status', op:'in', value:[...]}`; each selected `dim` → `{field:'tags.'+dim, op:'in', value:[...]}`. TDD'd.

The editor REPLACES `MissionQuickFilters`. The dashboard keeps the same narrowing pipeline (`applyQuickFilters`) for status/tags, now fed by the editor's state.

## §5 — Tags/attributes in BOTH UIs

- **Dashboard cards** (`MissionGraphCanvas` renderNode): add a compact tag indicator — the `groupBy` value when set, else a small tag-count badge — so cards convey tagging at a glance (kept minimal to not overcrowd the card).
- **Dashboard detail:** all tags shown grouped by dimension (§3).
- **Missions page** (`MissionsPage`): add a **tag-chips row** to each mission list item (dimension: values, compact), and surface **parentId + dependsOn** on the item or its expanded view. Extend the keyword search haystack (line 264) to also include tag values. The mission detail tab (`MissionDetailView`) shows tags + parent + dependsOn. (Read-only display — editing stays via the existing create/patch flow.)

## §6 — Backend

**No change.** Reuses `GET /mission/:id`, `GET /mission/:id/sessions`, `POST /mission/schedule`, `POST /mission/graph`, `GET /mission/views`, `mission_view_set` (the last via the existing web path or a small `apiFetch` POST to `/mission/views`). During planning, confirm `mission_view_set`'s web entry (POST `/mission/views` with `{name, query, display}`).

## §7 — Testing

- **Pure helpers TDD'd (vitest):** `matchesSearch` (§2), `buildFilter` (§4), and any tag-dimension derivation/grouping helper. Extend the existing `mission-graph-adapter.test.ts`.
- **React/hooks:** `tsc --noEmit` clean + a **browser-smoke** on dev `:3948`: search narrows the graph; the filter editor builds a query and re-renders + Save-as-view persists (appears in the view list); clicking a node shows the comprehensive detail (objective/tags/relationships/scheduling/history/sessions) and a relationship chip jumps nodes; the Missions page shows tag chips. (Components are thin; the pure logic is unit-tested.)

## §8 — Build order (two phases, one spec)

- **Phase 1 — info richness (additive, lower risk):** §1 layout shell, §2 search, §3 comprehensive detail + `useMissionDetail`, §5 tags-in-both (dashboard cards/detail + Missions page).
- **Phase 2 — customization:** §4 filter editor (subsuming the quick-chips) + Save-as-view.

Each phase ends shippable. The plan orders tasks so Phase 1 lands first.

## §9 — File structure

- **Create:** `web/src/hooks/useMissionDetail.ts`; `web/src/components/missions/dashboard/{MissionSearchBox,MissionFilterEditor}.tsx`; new pure helpers in `web/src/lib/mission-graph-adapter.ts` (`matchesSearch`, `buildFilter`, tag-derivation) + tests in `web/src/lib/__tests__/mission-graph-adapter.test.ts`.
- **Modify:** `web/src/components/missions/dashboard/{MissionDashboardPage,MissionNodeDetail,MissionGraphCanvas}.tsx`; `web/src/lib/mission-graph-types.ts` (add `MissionFull`/`MissionChange`); REMOVE the standalone `MissionQuickFilters` usage (folded into the editor). `web/src/components/missions/MissionsPage.tsx` + `MissionDetailView.tsx` (tag chips + relationships + search haystack).
- **Reuse:** `DagGraph`, `useMissionViews`/`useMissionGraph`, `toDagGraph`/`applyQuickFilters`, `useAppMode().apiClient`.

---

## Open questions

None — the filter model (ad-hoc + save), detail richness (comprehensive + scheduling), the quick-chips→editor unification, the client-fast/server-scope split, and tag surfacing in both UIs are resolved. Backend reuse confirmed (no API change).
