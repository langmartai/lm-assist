# Mission Graph Redesign — Design

**Date:** 2026-06-27
**Status:** Approved (design), pending spec review → plan

## Goal

Make the Mission Graph dashboard (`/mission-graph`) genuinely navigable and readable on dense, multi-cluster mission sets: eliminate the zoom-ghosting artifact, group related missions together (and standalone ones together), offer multiple layout strategies, and support fluid mouse-drag pan + finger/trackpad pinch-zoom + type-search that reveals related missions.

## Background — current state

- **Rendering:** `MissionGraphCanvas` wraps the shared `DagGraph` (SVG). Mission cards are rendered with `renderNode` returning a `<foreignObject>` (HTML div) positioned inside an SVG `<g transform="translate(pan) scale(zoom)">`.
- **Bug (ghosting):** Chrome does not reliably invalidate a `<foreignObject>`'s painted region when an ancestor SVG `<g>` transform changes. On zoom/pan the old card paint lingers and the new frame overlays it ("old chart still on screen, new chart overlays"). The pure-SVG `DagNodeCard` used by session-DAG views does not have this problem.
- **Layout (`dag-layout.ts`):** a single BFS topological layering of ALL nodes. Unconnected missions (in-degree 0, no edges) land in layer 0 beside real roots — connected and unconnected are intermixed, never clustered. There is no connected-component grouping and only one layout.
- **Interactions (0.1.118):** mouse-drag pan (anywhere), wheel zoom-to-cursor (non-passive listener), double-click fit, click-to-select with a `movedRef` drag-vs-click guard. No touch/pinch support.
- **Left panel:** `MissionViewPicker`, `MissionSearchBox` (already wired to `search` state), `MissionFilterEditor`. `matchesSearch` filters to matching nodes only; their neighbors are dropped (`filteredEdges` keeps edges with both endpoints present).
- **Data:** graph node projection `MissionNode = {id,title,status,tags,parentId,progressPercent}` — no timestamp/activity. `GET /mission/sessions` (`handleAllSessions`) returns rows keyed by `missionId` with session `lastContact`, limited to `active`/`waiting` missions — usable to mark "live" missions and order by recency.

## Approved approach

**Purpose-built mission canvas** (chosen over reusing the shared DagGraph). A new mission-only renderer: HTML cards + an SVG edge layer, both inside **one CSS-transformed `<div>`** (`transform: translate(panX,panY) scale(zoom)`). CSS transforms on HTML repaint cleanly (no foreignObject → no ghost) and are GPU-accelerated (smooth pan/zoom/pinch). This is isolated from the shared `DagGraph`, so session-DAG views are untouched and carry zero regression risk. Rich HTML card styling (tag chip, relationship line, live dot) is preserved.

The shared `DagGraph` / `dag-layout.ts` stay as-is for session DAGs. The mission dashboard stops using them.

## Architecture

Four units, each independently testable:

1. **`web/src/lib/mission-layout.ts`** (pure, no React) — clustering + strategy arrangement + packing → positioned nodes/edges/bounds. Unit-tested with vitest.
2. **`web/src/components/missions/dashboard/MissionGraphCanvas.tsx`** (rewrite) — the CSS-transform canvas: HTML cards + SVG edge layer + all pointer/touch/wheel interactions. Consumes positioned output from `mission-layout.ts`.
3. **`web/src/components/missions/dashboard/MissionCard.tsx`** (new) — one HTML mission card (presentational): title, status, progress, major-tag chip, relationship summary, live dot, selection/dim states.
4. **Left-panel wiring** — `MissionLayoutPicker.tsx` (new strategy dropdown) + search-reveals-related change in `MissionDashboardPage.tsx` + `mission-graph-adapter.ts`. A new `useMissionActivity` hook fetches `/mission/sessions` for the Recent strategy + live dots.

### Data flow

```
MissionDashboardPage
  state: activeView, statuses, tags, expand, search, selectedId, strategy
  data:  useMissionGraph(source) -> {nodes, edges}
         useMissionActivity()     -> Map<missionId, {lastContact, live}>
  derive: searchScope(nodes, edges, search) -> nodes+edges (match + whole component)
          applyQuickFilters/highlight as today
  ->
MissionGraphCanvas({nodes, edges, strategy, selectedId, activity, display, onSelect})
  layout = computeMissionLayout(nodes, edges, {strategy, selectedId, activity})
  render: CSS-transform world { <svg> edges </svg> ; nodes.map(MissionCard) }
  interactions: pan / wheel-zoom / pinch / dblclick-fit / click-select
```

## Unit 1 — `mission-layout.ts`

### Types

```ts
export type MissionLayoutStrategy = 'clusters' | 'hubs' | 'focus' | 'recent';

export interface MissionLayoutInput {
  nodes: { id: string; parentId?: string | null }[];   // only ids + parent needed for structure
  edges: { from: string; to: string; type: 'parent' | 'dependsOn' }[];
  strategy: MissionLayoutStrategy;
  selectedId?: string | null;                           // for 'focus'
  liveIds?: Set<string>;                                 // mission ids with a live bound session, for 'recent' + live dot
                                                         // (GET /mission/sessions has no timestamp; liveness is binary presence)
  nodeW?: number; nodeH?: number; gap?: number;         // defaults 200 / 76 / 28
}

export interface PositionedNode { id: string; x: number; y: number; }
export interface MissionLayoutResult {
  positions: Map<string, PositionedNode>;               // node id -> top-left in world coords
  width: number; height: number;                        // world bounds
  nodeW: number; nodeH: number;
  dimmed?: Set<string>;                                 // ids to render dimmed (focus strategy: nodes outside the selected component)
}

export function computeMissionLayout(input: MissionLayoutInput): MissionLayoutResult;
```

The result carries positions (+ an optional `dimmed` set for focus); the canvas already has the node metadata and draws edges from `positions`. The canvas ORs `dimmed` with its existing dim conditions (`display.highlight` misses, selection-connectivity).

### Algorithm

1. **Connected components (union-find)** over the UNDIRECTED edge set (both `parent` and `dependsOn` edges union their endpoints). Output: list of components (arrays of node ids). A component of size 1 with no incident edge is a **singleton**.
2. **Per-component internal layout** → local coordinates + a bounding box `{w,h}` per block:
   - **clusters / recent:** call the existing `computeDagLayout` on the component sub-graph (LR parent/dependency flow). Reuse, don't reinvent. (Import `computeDagLayout`; build a `DagGraph` shape from the component's nodes+edges.)
   - **hubs:** radial — pick the highest-degree node as center; BFS from it assigns each node a ring index = hop distance; nodes on ring `r` are evenly spaced by angle on a circle of radius `r * (max(nodeW,nodeH) + gap) * 1.3`. Center node at block center.
   - **focus:** only meaningful for the component containing `selectedId`; that component is laid out radial around `selectedId` (same ring math, center = selected). All OTHER components are laid out with `clusters` flow and every one of their node ids is added to `result.dimmed`. With no `selectedId`, `focus` === `clusters` (empty `dimmed`).
3. **Singletons block:** all singletons packed into a grid (columns = `ceil(sqrt(n))`), as one block with its own bounding box.
4. **Block ordering** (which block goes first in packing):
   - **clusters / hubs / focus:** components by node count descending; singleton block last.
   - **recent:** components that contain ≥1 live mission (member in `liveIds`) first, ordered by live-member count desc, then size desc; non-live components after by size desc; singleton block last (but a live singleton sorts ahead of non-live singletons within that block's grid order). `/mission/sessions` has no timestamp, so "recent" = "has live work now", per the chosen intent.
   - **focus:** the selected mission's component first (centered), others after, singleton block last.
5. **Block packing (shelf/row bin-packer):** place blocks left→right with `gap` between; when the row width would exceed a target width `T = max(viewportHint, sqrt(totalBlockArea * 1.6))`, wrap to a new row whose y = previous rows' max height + gap. Translate each block's local node coords by the block's packed origin → global `positions`.
6. **Bounds:** `width/height` = max packed extent + padding.

Edges are always intra-component (connected components share no edges), so every edge connects two nodes whose global positions exist — no cross-block edge routing needed.

### Tests (vitest, `mission-layout.test.ts`)

- Two disconnected chains → two separate blocks, no overlap (bounding boxes disjoint).
- N singletons (no edges) → one grid block, `ceil(sqrt(N))` columns.
- `hubs`: the highest-degree node is at its component's centroid (closer to block center than any leaf).
- `focus` with a `selectedId`: selected node is the centroid of its component; a node in another component is flagged/positioned in a non-focused block. No `selectedId` → identical to `clusters`.
- `recent`: a component containing a live mission (id in `liveIds`) is packed before a non-live component (smaller global x/y origin); no `liveIds` → falls back to size order (=== `clusters` ordering).
- Empty input → `{width:0,height:0,positions:empty}` (canvas shows empty state).
- All edges resolve to a position for both endpoints (no orphan edges).

## Unit 2 — `MissionGraphCanvas.tsx` (rewrite)

### Structure

```
<div ref=viewport  // overflow:hidden, position:relative, touch-action:none
     onMouseDown/Move/Up  onDoubleClick  onClickCapture(drag-guard)
     (native non-passive: wheel, touchstart/move/end)>
  <div class=world style="transform: translate(panX px, panY px) scale(zoom);
                          transform-origin: 0 0; width: bounds.w; height: bounds.h">
    <svg width=bounds.w height=bounds.h style="position:absolute; inset:0; overflow:visible">
       {edges.map(path)}      // bezier in world coords, faint by default
    </svg>
    {nodes.map(n => <MissionCard style="position:absolute; left:x; top:y; width; height" .../>)}
  </div>
  <Controls/>  // +/- , Fit, 1:1 , zoom% , Layout indicator (fixed overlay, NOT transformed)
</div>
```

### Interaction spec

- **Pan:** left-drag anywhere updates `pan` (px). `draggingRef` mirrors a `dragging` state (live read in the move handler — avoids the stale-closure pan-drop). `movedRef` set once movement > 3px; `onClickCapture` on the viewport swallows the click after a real drag so a pan never selects.
- **Wheel zoom:** native **non-passive** `wheel` listener (`{passive:false}`) so `preventDefault` suppresses page scroll. Zoom toward the cursor: `newPan = focal - (focal - pan) * (newZoom/zoom)`. `deltaY>0` → ×0.9, else ×1.1. Clamp zoom `[0.05, 3]`. (Trackpad pinch arrives as ctrl+wheel and is handled by this same path.)
- **Touch pinch + pan:** native `touchstart/touchmove/touchend` (non-passive).
  - 1 touch → pan (same as mouse drag).
  - 2 touches → pinch: on start record `startDist` (distance between touches), `startZoom`, and the midpoint. On move, `zoom = clamp(startZoom * (curDist/startDist))` toward the midpoint focal point; also translate by the midpoint delta. End on touchend < 2 touches.
- **Double-click:** `fitToView` — scale to fit `bounds` in the viewport (clamped) + center; synchronous (works in background tabs).
- **Auto-fit:** on first layout and when `bounds`/strategy change, fit once (rAF-guarded; stable deps so it does not loop — `layout`/`strategy` are the deps, both stable references via mem*).
- **Click select:** `MissionCard onClick` → `onSelect(id)` (toggles), guarded by `movedRef` via the viewport `onClickCapture`.

### Memoization rules (avoid re-fit loops)

- `layout = useMemo(computeMissionLayout(nodes, edges, opts), [nodes, edges, strategy, selectedId, activity])`.
- `opts`/`activity` references must be stable (memoized in the page/hook) — an inline object re-runs layout + auto-fit every render (the 0.1.118 `layoutOptions` lesson).

## Unit 3 — `MissionCard.tsx` (new, HTML)

Presentational. Props: `node` (MissionNode), `selected`, `dimmed`, `live` (bool), `rels` ({deps,children,dependents}), `display` (nodeFields/groupBy), `accent` color, `onSelect`.

- Title (truncate via CSS `truncate`).
- Row: status · `progress%` · major-tag chip (`groupBy` value, else first non-`ctl:` author-dim value).
- Relationship line: `↑parent · ⛓N · ▽N · Nblk` (from `rels`).
- **Live dot:** small pulsing dot when `live` (mission has an active/recent session) — shown in all strategies, emphasized in Recent.
- Colored left border by group/status; white ring when `selected`; opacity 0.35 when `dimmed`.
- `cursor:pointer`; `onMouseDown` does NOT stopPropagation (must bubble to the viewport so a drag starting on a card pans); selection happens via the click after the drag-guard.

## Unit 4 — Left panel + search + activity

### `MissionLayoutPicker.tsx` (new)

A labeled dropdown ("Layout") in the left panel with: **Clusters** (default), **Hubs**, **Focus**, **Recent**. Sets `strategy` state in `MissionDashboardPage`. Each option has a one-line hint. (Focus shows a subtle "select a mission" hint when no selection.)

### Search reveals related (`mission-graph-adapter.ts` + page)

New helper `expandToComponents(nodes, edges, matchIds)`: given a set of ids, return the union of every connected component that contains one of those ids (union-find over the full edge set). Precise interaction with quick-filters, to remove ambiguity:

- **Matches** = nodes passing BOTH `applyQuickFilters` (status/tag) AND `matchesSearch` (the typed text). Quick-filters define *what counts as a hit*.
- **Visible set** = when `search` is non-empty, `expandToComponents(rawNodes, rawEdges, matchIds)` — i.e. each hit plus its WHOLE connected component, shown **even if those neighbors don't pass the quick-filters** (the point is to see a hit in context). When `search` is empty, behavior is exactly today's: `applyQuickFilters` only.
- `filteredEdges` = edges with both endpoints in the visible set (unchanged rule).

This keeps "type to find a mission and see its related missions" working while leaving the no-search filter behavior identical.

### `useMissionActivity.ts` (new hook)

Fetches `GET /mission/sessions` once (and on refresh) → `{ sessions: {missionId}[] }`, returns a stable `Set<string>` of mission ids that have a live bound session (`liveIds`). Memoized. Feeds the Recent strategy ordering and the live dot. Failure → empty set (graph still renders; Recent falls back to size order, no dots).

## Out of scope (YAGNI)

- No backend changes (no new `updatedAt` on the node projection — `/mission/sessions` covers Recent).
- No edge re-routing/orthogonal edges; keep bezier curves.
- No minimap, no animation/transition between strategy switches (instant relayout).
- No changes to the shared `DagGraph`/`dag-layout.ts` (session-DAG views unchanged).
- No persistence of the chosen strategy across reloads (session-local state; can be added later).

## Testing & rollout

- **vitest:** `mission-layout.test.ts` (clustering, each strategy, singletons grid, packing disjointness, edge resolution) + `mission-graph-adapter.test.ts` additions (`expandToComponents`).
- **tsc:** clean on touched files (baseline 39 pre-existing unrelated errors).
- **Browser smoke (dev :3948, 19-node seeded graph):** ghost gone on zoom; each strategy lays out sensibly; drag pan; wheel zoom; double-click fit; synthetic touch pinch (dispatched TouchEvents) zooms; search "token" reveals its whole component; click selects + detail panel.
- **Deploy:** version 0.1.119, full fleet (117/123/107) per the established procedure.

## Risks

- **Touch pinch is hard to verify headlessly** — dispatch synthetic `TouchEvent`s in the browser smoke to exercise the handler; accept that real-device feel is a manual check the user can do.
- **Radial layouts (hubs/focus)** can overlap on very dense components — mitigate with ring radius scaling by ring population; acceptable for the expected mission counts (tens, not thousands).
- **`/mission/sessions` only covers active/waiting missions** — Recent surfaces live work first and falls back to size order for the rest; this matches the chosen "live/recent sessions" intent.
