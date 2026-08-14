# assist-backlog

The backlog registry as a scoped UI pane — a plain-JS (no build, no framework) app that
lists, inspects, creates, edits and discusses backlog items through the node's `/backlog`
routes. It is the pilot pane for the lm-assist local serving tier: the same unmodified
document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because
every data call goes through the injected `assets/lmui.js` SDK helper (view token +
re-mint on 401/403), never a hard-coded origin.

## Grant

Three leaf rules in `lmui.config.json`, and nothing else it can reach:

```
node:/backlog           [GET, POST]  exact
node:/backlog/*         [GET, POST]  exact
node:/backlog/*/discuss [POST]       exact
```

They cover list (`GET /backlog`), detail (`GET /backlog/:id`), graph/history reads under
`/backlog/*`, create (`POST /backlog`), update (`POST /backlog/:id`) and discuss
(`POST /backlog/:id/discuss`).

🔴 **Why not the bare `node:/backlog [GET, POST]` it used to be.** A rule with no `exact` is a
**subtree** rule, so that one line also carried `POST /backlog/:id/remove`,
`/rollback`, `/link`, `/unlink` and `/review` — five mutations this pane never issues, including
deleting an item and reverting one to an older revision. Both forms come from the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`).
The view token's grant is the hard ceiling — anything outside these rules 403s.

## Layout

Three panes: a client-side-filterable list (status/type chips + text filter, optional
"include removed"), a detail view (description rendered as plain text, plus edges /
discussion / reviews and edge/discussion/history counts), and a create/edit form with a
discussion-note box. Type / status / priority are select fields carrying the model enums
(`idea|feature|issue|bug|task`, `open|discussing|accepted|deferred|rejected|planned|implemented`,
`low|med|high|critical`).

## Graph view

The **Graph is the landing view** — a `Graph | List` tab bar (graph first; the list is
fetched lazily on first List-tab entry) renders `GET /backlog/graph` (covered by the same
`node:/backlog/*` leaf rule — no grant change). In graph mode the 80rem content cap is
lifted and the canvas fills the viewport height (standalone; the embedded pane keeps its
fixed height — vh inside the shell's iframe is the very height reportHeight defines). It uses the HOUSE
graph pattern, ported from `assist-mission-graph` (itself from
`web/src/lib/mission-layout.ts`) so every graph surface lays out and feels the same:

- **Stage**: absolutely-positioned item cards over an inline SVG edge layer inside ONE
  transformed stage — pan/zoom is a CSS transform (drag / wheel / pinch / ± buttons /
  fit / double-click), never a viewBox.
- **Layout is deterministic, no physics**: union-find components, then per component
  either radial around the highest-degree hub (**Hubs**, default — the backlog is mostly
  hub-and-spoke) or layered left→right flow (**Clusters**); standalone items pack into a
  sqrt grid; blocks shelf-pack. Same data → same picture, every load.
- **Cards** carry the readable title, type/status/priority pills and link/note/review
  counts; the left border is the status accent. **Edges** are typed — kind → color/dash
  from one palette shared by lines, per-kind arrow markers, and the legend (light theme
  swaps in 600-series hues).
- Click a card → select: 1-hop neighborhood stays lit (rest dims), edges to the selection
  go hot, an info card offers "open details" → the list view's detail pane. Click again
  or close to deselect.
- The graph is fetched lazily on first tab switch, latest-wins sequenced, and re-fetched
  after any successful create/edit/note; "include removed" is per-view state.
- 🔴 `[hidden]{display:none!important}` (top of app.css) is load-bearing: an author
  `display:flex` on `.g-msg` would otherwise beat the hidden attribute and the overlay
  would silently eat every pointer event — the same trap assist-mission-graph and
  assist-data already documented. Keep the rule when touching the CSS.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-backlog ~/.lmui/apps/assist-backlog
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-backlog/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
