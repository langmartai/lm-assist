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

A `List | Graph` tab bar switches to a whole-graph rendering of `GET /backlog/graph`
(covered by the same `node:/backlog/*` leaf rule — no grant change). Plain hand-rolled
SVG, because the pane's CSP forbids any external chart library:

- **Nodes** = items, colored by status, radius by priority; degree-0 items sit in a grid
  strip under the force-laid (Fruchterman–Reingold) linked subgraph so they don't scatter
  the layout. **Edges** are typed — kind → CSS class; directed kinds (`depends-on`,
  `blocks`, `parent-of`, `spawned-mission`) get a computed arrowhead polygon (SVG markers
  can't take per-kind CSS color reliably).
- Interactions: wheel-zoom (clamped), background pan, node drag (incident edges follow),
  hover dims everything but the node's neighborhood, click opens an info card whose
  "open details" jumps back to the list view with that item loaded.
- The graph is fetched lazily on first tab switch and re-fetched after any successful
  create/edit/note (`G.loaded = false`) or via the toolbar's refresh; "include removed"
  is a separate toggle from the list's (separate fetches, per-view state).
- 🔴 The loading/error overlay (`.g-msg`) sets `display:flex`, which would silently beat
  the `hidden` attribute's UA `display:none` and eat every pointer event over the SVG —
  `.g-msg[hidden]{display:none}` restores it. Keep that rule when touching the CSS.

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
