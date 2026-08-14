# Pane Authoring — Reference Design

**Date:** 2026-08-14 · **Status:** current reference (consolidates shipped practice)
**Scope:** how a pluggable UI pane in `ui-apps/` is built — sizing, view structure, graph
views, sidebar placement, data plane, and the safety rails. Companion to the
[gateway auth model](2026-08-04-pluggable-ui-gateway-design.md) (identity/tokens/grants)
and `docs/ui-panes-deploy.md` (deployment). This spec describes only the contract a pane
observes; the hub shell's internals are not lm-assist's to document.

## 1. The serving contract

One unmodified document serves three ways: **standalone** on its own pane origin,
**embedded** in the hub shell (`?embed=1`, optional `&theme=light`), and via the
**node-local tier**. Everything below follows from two facts:

- All data calls go through the injected SDK (`lmui.call`) — view token + re-mint on
  401/403; never a hard-coded origin, never a privileged credential in the browser.
- **The shell gives the pane iframe the FULL content panel.** The `lmui:height`
  postMessage is a **liveness signal only** — it does not size the frame. Keep sending it
  (it is how the shell knows the pane is alive), but never design around it as sizing.

## 2. Sizing — fill the panel (the `--vh-cap` pattern)

Because the iframe is panel-fixed, `100vh` inside the embed IS the panel height. Every
pane sizes its primary content region(s) with one shared custom property:

```css
:root{--vh-cap:calc(100vh - <A>rem)}       /* A = standalone chrome around the region */
body.embed{--vh-cap:calc(100vh - <B>rem)}  /* B ≈ A − 4.4: the embed hides the pane header
                                              (~3.2) and shrinks main padding (~1.2);
                                              panes with extra standalone-only chrome
                                              (e.g. an external tab bar) reclaim more */
```

- Fixed-height canvases → `height:var(--vh-cap)` plus a `min-height` floor (18–22rem).
- Capped lists → `max-height:max(var(--vh-cap), <floor>rem)` so short content stays
  compact. A sparsely-filled list NOT reaching the panel bottom is correct, not a bug.
- Compute `A` from the pane's real markup, ~1rem generous. Secondary boxes (outputs,
  note boxes, ≤16rem sublists) stay fixed.
- 🔴 **`body.embed{overflow:auto}` — never `hidden`.** The `hidden` variant was the old
  content-sized-iframe era's scrollbar-feedback guard; with a panel-fixed iframe it makes
  everything past one viewport **unreachable** (measured: ~2000px of clipped kanban).

## 3. View structure

- Multiple views = a pill **tab bar** above `main`; the primary view is FIRST and is the
  landing view, with its state already in the initial markup (no flash of the secondary
  layout before the script runs). Secondary views load lazily on first entry.
- A full-canvas view (graph, board) lifts the width cap (`main.graph-mode{max-width:none}`)
  and takes the viewport height; document-flow views keep the centered column layout.
- `[hidden]{display:none!important}` global rule is load-bearing: an author `display:flex`
  otherwise silently defeats the hidden attribute — an overlay that "hides" but keeps
  eating pointer events is exactly how that failure presents.

## 4. Graph views — use the house pattern, never a new renderer

The repo has ONE graph implementation style (reference: `assist-mission-graph`, second
implementation: `assist-backlog`'s Graph tab). Any new graph view ports it:

- **Stage**: absolutely-positioned HTML cards over an inline SVG edge layer inside one
  CSS-transformed stage. Pan/zoom is a transform (drag / wheel / pinch / ± / fit /
  double-click background) — never viewBox surgery. Cards give readable multi-line
  labels; pure-SVG circle-and-text does not.
- **Layout is deterministic, no physics**: union-find components → per component radial
  around the highest-degree hub or layered left→right flow → singleton grid → shelf-pack.
  Same data, same picture, every load.
- Typed edges: one palette map drives line color/dash, arrowhead markers, and the legend
  (light theme swaps the palette — thin lines need 600-series hues on a light canvas).
- Click-select: 1-hop neighborhood stays lit, rest dims, info card offers the detail
  jump. Guard the gesture handlers: a press/dblclick/wheel starting on a floating overlay
  or card must not pan/refit/zoom the canvas.
- History note: the first backlog graph hand-rolled a force layout and re-derived four
  interaction bugs the house code had already solved. Check for the house pattern before
  building — `grep -rln 'layout\|stage' ui-apps/` costs seconds.

## 5. Sidebar placement

The shell sidebar groups panes by registry **category** and orders by **sortOrder**
(total order: `sortOrder, name, uiId`; a group appears at its first member's position).
Both ride `lmui.config.json` → node boot sync → registry — so placing or reordering a
pane is a config edit plus a Core restart, no gateway involvement. Current Node order
policy: work surfaces first (Backlog 10, Sessions 20, Missions 30, mission-adjacent
40–60), knowledge surfaces 70–100, ops 110–150. New panes pick a slot, don't renumber
the fleet.

## 6. Data plane in the pane

- Normalize the dual-tier envelope once (the `api()` helper pattern): the hub tier wraps
  the node's `{success,data}` in an outer `{status,data}`; the local tier does not. Strip
  when present; surface non-node failures verbatim — never swallow.
- Loads are **latest-wins**: a monotonic sequence token per fetch family; a stale
  response must not paint. Add `.catch` routing render-time throws to the same
  error+Retry surface the fetch errors use.
- Grants are exact leaf rules (see `ui-apps/README.md` "The grant language") — a new
  read that fits an existing leaf (e.g. `GET /backlog/graph` under `node:/backlog/*`)
  needs no grant change; add it to the grants safety-net test inventory either way.

## 7. Safety rails (every one earned by a real defect)

- `esc()` every user-controlled string into HTML *and* SVG markup, attribute contexts
  included. Server-validated ids are still escaped.
- Server-data-keyed lookups (`STATUS_COLOR[status]`, `KIND[kind]`) must be own-property
  (`Object.prototype.hasOwnProperty`) — a value like `"constructor"` otherwise leaks
  `Object.prototype` members into attribute markup.
- Surrogate-safe truncation for display slices of user text.
- `autocomplete="off"` on stateful controls that JS mirrors into app state (Firefox
  back-forward restore desyncs them otherwise).
- Interaction state machines handle `pointercancel`/`lostpointercapture`/pinch-tails;
  a tap tolerates 3px of roll before it counts as a drag.
