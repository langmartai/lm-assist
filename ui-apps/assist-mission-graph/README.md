# assist-mission-graph

The mission dependency/parent graph as a scoped UI pane — the migration of the web app's
`/mission-graph` page (`web/src/components/missions/dashboard/*` + `lib/mission-layout.ts` +
`lib/mission-graph-adapter.ts`). A plain-JS app (no build, no framework, **no charting
library**): the canvas is absolutely-positioned cards over an inline `<svg>` edge layer inside
one transformed stage, so pan/zoom is a single CSS transform.

It follows the `assist-backlog` / `assist-knowledge` / `assist-scheduler` pilots exactly: the
same unmodified document runs behind the hub's ui-gateway AND behind the node-local HTTP tier,
because every data call goes through the injected `assets/lmui.js` SDK helper (view token +
re-mint on 401/403), never a hard-coded origin. `assets/lmui.js` is copied verbatim from the
pilots (md5 `3c5a56aad07af262b4fb326b034ce668`, byte-identical across all 17 `ui-apps/*` panes) —
never hand-edited. (The md5 recorded here previously was stale and matched no pane on disk.)

## Cross-pane links — the params this pane accepts and emits

Cross-pane navigation uses the pinned vocabulary: **the entity's singular noun, unqualified**
(`mission`, `session`, `project`, `task`, …), plus exactly two generic modifiers (`tab`, `q`).
A pane must EMIT only those names and READ the ones that name an entity it can display —
a param that no target reads is a silently broken button, not a no-op.

### Inbound — read from `location.search` on load

| param | value | what this pane does with it |
|---|---|---|
| `mission` | a mission id | **Lands on it**: selects the card (which emphasises its 1-hop neighbourhood and dims the rest), centres that card in the viewport at ≥90 % zoom, and loads its detail panel. |
| `q` | search text | Prefills the **Search** box *before* the first load, so the opening paint is already narrowed. |
| `embed` | `1` | Embedded chrome (unchanged, pre-existing). |
| `theme` | `light` | Light theme (unchanged, pre-existing). |

`tab` is deliberately **not** read — this pane has no named sub-views. Views and Layout are user
controls, not tabs, and an inbound link should not flip a user's control under them. For the same
reason `?mission=` does not switch the Layout picker to "Focus": it selects and centres, it does
not re-arrange the whole graph.

Both values are clamped to 512 chars — the same ceiling `lmui.goto` enforces on the emit side —
so a hand-typed URL cannot push an unbounded string into the status line or the search box.

**Every outcome is reported**, because a deep link that quietly does nothing is exactly the defect
this reads the param to fix:

| case | what you see |
|---|---|
| id is in the graph | `deep link: focused mission <id>` |
| id is not in the graph | `deep link: mission <id> is not in this graph` (flagged as an error) |
| id is hidden by a `q` sent alongside it | `deep link: mission <id> is selected but hidden by the current search — clear it to see the card` — the detail panel still shows the mission |
| the graph call itself failed | the fatal layer only; no misleading "not in this graph" over a graph that never loaded |

🔴 **Fitting is not landing.** The auto-fit that runs after every load frames the WHOLE graph — at
19 missions that is 21 % zoom, where a 200 px card renders 42 px wide. A deep link therefore
centres the named card and never zooms out below 90 %. The centring is queued with
`requestAnimationFrame` *after* `select()`, so it lands last in the same frame's callback list and
neither the post-load fit nor the "focus" layout's own re-fit re-frames the viewport on top of it.

The address bar is kept in sync as you select (`history.replaceState`), so a reload — or a link
copied out of it — lands back on the same mission. That rewrite **preserves every param it does
not own**: `embed`/`theme` are the serving contract, and `lt`/`code`/`token`/`returnTo` are
reserved by the serving tier (`NAV_RESERVED` in `lmui.js`). Rebuilding the query from a whitelist
would silently drop them.

### Outbound — emitted via `lmui.goto`

| target | params | trigger |
|---|---|---|
| `assist-missions` | `{ mission: <id> }` | the detail panel's **Open in Missions →** |

## Grant

Six leaf rules in `lmui.config.json`, and nothing else it can reach:

```
node:/mission/*             [GET]   exact
node:/mission/*/sessions    [GET]   exact
node:/mission/views/*/graph [GET]   exact
node:/mission/graph         [POST]  exact
node:/mission/schedule      [POST]  exact
node:/mission/views         [POST]  exact
```

The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed
on both serving tiers.


Paths + envelope shapes mirror `core/src/routes/core/mission.routes.ts` and the node projection
in `core/src/mission/mission-traverse.ts`; every one was curl-verified against the dev API
(`:3200`) before it was coded against:

- `GET /mission/views` — saved views. `data` is a **wrapper `{ views:[...] }`**.
- `GET /mission/views/:id/graph` — a view's graph. `data = { view, nodes, edges }` — the view sits
  **alongside** the graph, it does not wrap it.
- `POST /mission/graph` `{filter?,expand?}` — the ad-hoc graph. `data = { nodes, edges }`.
- `POST /mission/schedule` `{}` — `data = { ready, blocked, serializeGroups, epicRollups, containers }`,
  used only to label the selected mission (Ready / Blocked / Epic / Serialized).
- `GET /mission/sessions` — `data = { sessions:[{sid,missionId,role,transport}] }`, drives the live dot.
- `GET /mission/:id` — **the mission object BARE** (no wrapper key), for the detail panel.
- `GET /mission/:id/sessions` — `data = { sessions:[...] }`.
- `POST /mission/views` `{name,query,display}` — the **only write**: save-as-view. `data` is **the
  view object BARE** (no `{view}` key). No `id` is ever sent, so it always CREATES a new named
  view and can never overwrite an existing one.

🔴 **`/mission/graph` and `/mission/schedule` are POST-only READS.** A GET does not 404 cleanly —
it falls through to `GET /mission/:id`, which treats the literal word as a mission id and answers
`{success:false,error:{code:'NOT_FOUND',message:'no mission graph'}}`. That reads like "you have
no missions" rather than "you used the wrong verb". Verified live.

🔴 **The over-reach this used to carry is closed.** `POST /mission/views` was a *subtree* rule,
so it also admitted `POST /mission/views/:id/delete` — deleting a saved view, which this pane
never issues. With `"exact": true` the rule stops at the path it names. Everything else stays out
too: `POST /mission` (create), `POST|PATCH /mission/:id` (patch), `/spawn`, `/tags`, `/onboard`,
`/query`, `/changes`, `/controller/adopt`, every `/mission/session/*` drive route, and — the one
that mattered fleet-wide — `POST /mission/workflows/:id` and `.../rollback`, the Mission-Controller
playbook writes. All **denied**, asserted against the real `grantAllows` in
`core/src/ui-pages/local-tier/__tests__/grants.test.ts`.

The `GET` side is leaf-shaped as well: `/mission/*` reads one mission (and, being one segment,
also `/mission/views` and `/mission/sessions`), `/mission/*/sessions` reads a mission's sessions,
`/mission/views/*/graph` reads a saved view. `GET /mission` — the whole mission list — is not
granted, because this pane never asks for it.

The view token's grant is the hard ceiling — anything outside these six rules 403s.

## Layout

Three panes:

- **Sidebar** — saved **Views** (plus "All missions (ad-hoc)"); **Search** (space-separated terms
  ANDed over title / id / status / tag values — a match reveals its whole connected group);
  **Filter** (status chips and one chip row per tag dimension, both built from the loaded graph,
  with Reset and Save-as-view); **Expand (server)** (direction × depth, which re-queries
  `/mission/graph` server-side); and **Layout** (the four strategies with their hints).
- **Canvas** — the graph. Cards carry the title, a live dot, the view's `nodeFields` (default
  status + progress), the major tag, and relationship counts (`↑parent · ⛓deps · ▽children ·
  Nblk`). Edges are drawn to card borders with arrowheads. Selecting a mission emphasises its
  1-hop neighbourhood and dims the rest. Pan by dragging, zoom by wheel/pinch or the ± buttons,
  Fit by button or double-click; the zoom level is shown.
- **Detail** — the selected mission's status/progress/scheduling pills, objective, plan (plain
  text `<pre>`), next steps, tags (a `ctl:` dimension is flagged as controller-owned),
  relationships as clickable id chips that select that mission, the last five history entries,
  its sessions, and **Open in Missions →**, which calls `lmui.goto('assist-missions', {mission:id})`.

Two deliberate differences from the source page, both because the old behaviour was a defect:

1. **Save-as-view uses an inline name field, not `window.prompt`.** The shell's iframe sandbox
   omits `allow-modals`, so a `prompt()` is silently suppressed when embedded — the old button
   simply did nothing there.
2. **The radial ("Hubs"/"Focus") layout spaces a crowded ring by its circumference.** The source
   used a flat `ring × step` radius, so a hub with ~10+ neighbours drew them on top of each other
   (reproduced on live data: 3 overlapping card pairs). Ring radii now grow by at least the step
   *or* far enough for every card to fit — 0 overlaps across 4 strategies at 300 nodes.

The expand controls are disabled while a saved view is active, because a view carries its own
`query.expand` and is always the server source — the source page silently ignored them there.

🔴 **`.cv-msg[hidden]{display:none}` is load-bearing, not tidy-up.** `.cv-msg` sets
`display:flex`, and an author `display` **overrides** the UA stylesheet's `[hidden]{display:none}`
— so `paintCanvas`'s `msg.hidden = true` did nothing and the word "loading…" stayed painted across
the middle of a fully-loaded graph (measured: `hidden=true` with `getComputedStyle().display ===
'flex'` over 19 rendered cards). Deleting that rule brings the ghost overlay straight back.

A hard failure of the primary graph call surfaces the server's own error text full-screen —
nothing is swallowed.

## Both tiers

`GET /auth/me` is the only raw fetch; on the local tier it answers
`{userId:'owner', uiId, local:true}` (no `claims`), on the hub it carries `claims.name` — the
identity badge renders both. Every other call goes through `lmui.call`, which emits the explicit
`/data/<uiId>/node/<path>` shape that both tiers accept.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-mission-graph ~/.lmui/apps/assist-mission-graph
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-mission-graph/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
