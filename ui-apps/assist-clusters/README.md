# assist-clusters

The fleet's **cluster map** (`core/src/cluster/`) as a scoped UI pane — the pluggable-UI
replacement for the web app's `/clusters` page (`web/src/components/clusters/ClustersPage.tsx`
+ `web/src/hooks/useClusters.ts`). A plain-JS app (no build, no framework) that shows every
cluster, its members, its leader and its annotation, and lets you move nodes between clusters —
all through the node's `/cluster/*` routes.

It follows the `assist-scheduler` / `assist-backlog` pilots exactly: the same unmodified
document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because every
data call goes through the injected `assets/lmui.js` SDK helper (view token + re-mint on
401/403), never a hard-coded origin. `assets/lmui.js` is copied verbatim from the pilots
(`md5 6cf55550268ae58bbfc75cb8284a76fa`).

## Grant

Five narrow grants in `lmui.config.json` — one per route this pane actually calls, rather than
a `/cluster` or `/hub` prefix:

```
node:/cluster/list      [GET]   exact
node:/cluster/assign    [POST]  exact
node:/cluster/unassign  [POST]  exact
node:/cluster/describe  [POST]  exact
node:/hub/machines      [GET]   exact
```

Each rule is `"exact": true` — a LEAF, not a subtree — so no route that might later be added
below one of these paths joins this pane's authority for free.

🔴 **Why not the `/cluster` prefix.** `POST /cluster/self` is the loopback-only setter for this
node's own cluster (`cluster.routes.ts` → `isLoopbackAddress(req.clientIp)`), and the local tier
proxies to Core from `127.0.0.1` — so a blanket `node:/cluster [POST]` grant would hand this pane
the privileged endpoint that check exists to protect. Naming the `/cluster` routes individually
keeps `/cluster/self` outside the ceiling.

🔴 **Why not the `/hub` prefix either.** `/hub` carries the node's hub credentials and lifecycle:
`GET /hub/config`, `GET /hub/api-key`, `POST /hub/connect|disconnect|login|logout` — and, directly
below the one path this pane needs, `POST /hub/machines/<id>/proxy-token`, which mints a proxy
credential for another machine. `GET` + `exact` reduces the addition to precisely "read the list of
machines": the verb excludes the token minter, and `exact` excludes the whole subtree it lives in.

Verified against the real `grantAllows` (`core/dist/ui-pages/local-tier/grants.js`) reading this
pane's actual `lmui.config.json` — 18/18 cases behaved as declared: the five pairs above are
allowed, and `POST /cluster/self`, `POST /cluster/list`, `GET /cluster`, `POST /hub/machines`,
`GET /hub/machines/<id>`, `POST /hub/machines/<id>/proxy-token`, `GET /hub`, `GET /hub/config`,
`GET /hub/api-key`, `GET /hub/status`, `POST /hub/logout` and the same paths under any other
service are all refused.

What each route gives the pane (paths + shapes mirror `core/src/routes/core/cluster.routes.ts`
and were curl-verified against the dev Core on `:3200`):

- `GET /cluster/list` — the cluster map in one read. `data` is a **wrapper**
  `{ clusters:[{ name, members:[{gatewayId,online,hostname?}], leader, description?, status? }],
  myCluster }` — `clusters` and `myCluster` sit side by side, and it is never a bare array.
  `clusters` is the union of the synced cluster records **and** every currently-online gateway id
  (`clustersOverview` in `cluster-map.ts`) — which is **not** the whole fleet: a node that is
  offline *and* has no cluster record is in neither set. See "The two sources" below.
- `POST /cluster/assign` `{node, cluster}` — move a node into a cluster, creating it if the name
  is new. `node` may be a gatewayId or a hostname; this pane always sends the gatewayId.
- `POST /cluster/unassign` `{node}` — move a node back to `default`.
- `POST /cluster/describe` `{cluster, description, status?}` — annotate a cluster. Annotation
  only: it never moves a node. `status` is omitted when blank, which clears it.
- `GET /hub/machines` — the machine registry: `data` is `{ machines:[{gatewayId, hostname,
  platform, status, lastHeartbeat, connectedAt, systemInfo?}] }`. Every machine the hub has
  ever registered, **online or not**. Two things need it, and nothing else does: the per-member
  platform indicator and the full node set for the assign dropdown (below).

The assign/unassign **response body is deliberately ignored**: it is `{assigned,node,cluster}`
when the target is this node, but the proxied peer's own nested envelope when it is not. Like the
page it replaces, the pane re-reads `/cluster/list` instead of parsing it.

The view token's grant is the hard ceiling — anything outside those five paths 403s.

## Layout

A toolbar (`this node: <cluster>` + Refresh) and a status line span both columns, then two panes:

- **List** — a text filter (cluster name, description, status, hostname, gatewayId) and a
  `status` chip row built from the statuses actually present in the data; then one row per
  cluster: the colour-coded name, a `this node` marker, the status, node/online counts, the
  description and the member hostnames inline, so the whole map reads at a glance. Below it,
  the fleet-level **Assign a node** form: a node dropdown (the registry ∪ the cluster map, in two
  groups — see below) plus a free-text cluster field backed by a `datalist` of existing names —
  typing a new name creates that cluster.
- **Detail** — the selected cluster: node/online counts, status, `this node's cluster` and
  `implicit` markers, the description, the leader, and every member (**platform indicator**,
  online dot, hostname, leader badge, gatewayId, and a `→ default` button — suppressed for
  `default`, which nodes can only be assigned out of). Then the **Describe** form, pre-filled
  with the current values.

Both writes that re-home a node — **Assign** and a member's **→ default** — are two-click: the
first click only re-labels the button to a confirmation and decays after 4 s, the second fires.
Placement, leader election and registry sync are all cluster-scoped, so either one moves a node
for the whole fleet; and the dropdown now lists nodes that exist only in the registry (18 of
them sharing one hostname here), so a mis-pick that used to be impossible to express is one click
away. A modal `confirm()` is not usable — the pane renders in a cross-origin iframe, where a
sandbox without `allow-modals` makes `confirm()` return false with no dialog at all.

Member hostnames are enriched from the registry when a cluster record carries none, and the text
filter searches the name actually displayed, so a node found by hostname is a node you can see.

Cluster colours reproduce `clusterBadge()` from the old hook (same `h*31 + charCode` hash over
8 slots, `default` always neutral), so a cluster keeps the colour it had on the old page.

A hard failure of the `/cluster/list` call surfaces the server's own error text full-screen —
nothing is swallowed. Every write reports its outcome as `code: message` in the status line.

## The two sources, and why one is not enough

An earlier version of this pane read `/cluster/list` alone and claimed that covered the fleet.
**It does not, and the claim was wrong in both directions.**

`clustersOverview()` (`core/src/cluster/cluster-map.ts`) builds its member set as the union of
the synced cluster **records** and the currently-**online** gateway ids. A node that is offline
*and* has no cluster record is in neither set, so it is absent from that response entirely —
and a dropdown built from it can never name that node, which is exactly the case the old page
allowed (its dropdown came from `MachineContext`, i.e. `/hub/machines`). Measured on this node
against the dev Core on `:3200`:

| source | nodes |
|---|---|
| `GET /cluster/list` (members, all clusters) | 2 |
| `GET /hub/machines` | 20 |
| **registry-only — unreachable without the second read** | **18** |

Cluster records also carry `gatewayId`/`online`/`hostname` and nothing else, so the platform of
a member is not in that response either. Both restored features are the same one `GET`.

The dropdown is therefore the **union**, keyed by gatewayId and split into two `<optgroup>`s:

- **in the cluster map** — carries its current cluster name;
- **registry only — no cluster record** — the 18 above.

Each option is labelled `<platform> <hostname> · <gatewayId[0..12]> · <cluster> · offline`, and
the short gatewayId is not decoration: on this fleet all 18 registry-only machines share one
hostname (successive gateway registrations of the same host), so a hostname-only label would
make them indistinguishable and a mis-pick would assign the wrong node.

**A registry-only node may still be refused, and the pane says so.** `resolveNodeId()` in
`cluster.routes.ts` resolves the assign target against records ∪ online — the same two sets — so
for a node that is offline with no record the server answers `BAD_NODE`. The pane reports that
verdict verbatim and adds why: the node is registry-only, and becomes assignable when it comes
back online. Expressing the case and reporting the refusal is the point; silently omitting the
option was the defect.

**When the registry is unreachable** — `/hub/machines` 400s with `Hub not configured` on a node
with no hub, and the grant could also be denied — nothing else on the page changes, and a notice
above both columns states plainly: a plain-English lead, the server's own message verbatim, that
platform indicators are hidden, and that the node list has fallen back to the cluster map alone so
an offline node with no cluster record cannot be selected. It offers a Retry that re-reads only
that route. The registry is a **secondary** source: its failure never raises the full-screen fatal
overlay, which stays reserved for `/cluster/list`.

🔴 **That notice must not print a bare `HTTP_400`.** `GET /hub/machines` answers *every* hub-side
condition with HTTP 400 and a bare string (`hub.routes.ts`) — `Hub not configured`, `Not connected
to hub`, `Hub returned <status>`, or the hub fetch's own error. None of them is a complaint about
the request, and none can be: the pane hard-codes a parameterless GET. The envelope carries no
`error.code`, so `api()` synthesizes `HTTP_400`, and 400 is the one status an operator reads as
"this page sent something bad". The pane therefore leads with the hub (`The hub is unreachable
from this node…`), prints the status as `HTTP 400: <the server's own words>` rather than as a
code the server chose, and adds one line saying the 400 is the route's catch-all. The server is
another owner's file and is left alone; the compensation is entirely in the pane.

🔴 **The degraded warning cannot live in the `<select>`.** It used to: the placeholder read
`— pick a node · cluster map only, registry unavailable —`, and a `<select>` renders only as much
of its selected option as the control is **wide** and cannot wrap. Measured in Chrome, that string
needs a **354px** control; the field is **350px** even widened to the full row, so the sentence was
silently truncated (the trailing em-dash rendered as a stub), and at a 380px viewport the field is
314px — 40px short, which costs whole words. The control now carries a short flag that fits
(`— pick a node · registry unavailable —`, intrinsic **251px**, 99px of headroom at 350px; the
`registry empty` variant 220px), and the sentence itself is `#node-warn`, an ordinary wrapping
block inside the field label. Being a block is the fix: it reflows instead of clipping, so it is
fully visible at every width — verified 380→1600px, `scrollWidth == clientWidth` throughout.
`.fld.wide` is kept because the option **labels** are long (the longest measured needs 330px), not
because it makes the warning readable — nothing about a control's width can.

Platform indicators follow the same honesty rule: the emoji is rendered **only** for a member the
registry actually knows. `getPlatformEmoji()` has no "unknown" bucket — it falls through to 🐧 —
so emitting it for an unrecognised member would assert a fact the pane does not have. The old page
had the same guard (`{mc && …}`).

**One behaviour worth knowing:** a write whose target is a *peer* lands on that node and
converges here through the reconcile the route kicks off fire-and-forget, so a single immediate
re-read can still show the pre-write map. The pane therefore re-reads once now and once ~1.5 s
later. (The old page's 3 s read-dedupe with a force-bypass after each write has no equivalent
here — the pane has no dedupe layer, so every read is a real fetch.) Those post-write re-reads
hit `/cluster/list` **only**: a cluster write cannot change the machine registry, so re-fetching
it would be pure load. Both sources load in parallel at boot and on **Refresh**, and the page
paints once, after both settle — painting per-response would render the dropdown twice, once
map-only and once complete.

## Verified

- `node --check` on `assets/app.js` and `assets/lmui.js`; `lmui.config.json` parses.
- `assets/lmui.js` is byte-identical to `ui-apps/assist-backlog/assets/lmui.js`
  (`md5 3c5a56aad07af262b4fb326b034ce668`) — never hand-edited.
- Every route curl'd against the dev Core on `:3200` and coded against the response actually
  returned, including the 2-vs-20 node measurement in the table above.
- The declared grant run through the real evaluator (`core/dist/ui-pages/local-tier/grants.js`,
  `readDeclaredGrant` + `grantAllows`) over this pane's own `lmui.config.json`: 18/18 allow/deny
  cases as declared.
- `assets/app.js` executed unmodified in a DOM shim against the **real** `/cluster/list` and
  `/hub/machines` payloads: 51 checks over the union dropdown, the platform indicator, the
  loading / empty / error states of both lists, escaping of hostile server data (a payload in
  every string field — hostname, platform, cluster name, status, description, gatewayId — never
  appears unescaped on any surface), the two-click arm, and the `BAD_NODE` explanation.

- **Rendered in headless Chrome against the running local tier on `:5603`**, with the
  `/hub/machines` response replaced per-load by CDP request interception, over every failure the
  route can produce (`Hub not configured`, `Not connected to hub`, `Hub returned 503`,
  `fetch failed`, a timeout, the generic `Failed to fetch machines`, an empty `machines[]`, a dead
  transport, and a non-JSON HTTP 500) plus the untouched healthy path. Each load was measured, not
  eyeballed: `#node-warn` `scrollWidth == clientWidth` and `scrollHeight == clientHeight` in all of
  them, and every one of its text line-boxes (`Range.getClientRects()`) inside the element's
  padding box and the viewport.
- **Legibility measured at 380 / 480 / 640 / 820 / 1024 / 1280 / 1600px**, dark and light, plain
  and `?embed=1`. The warning wraps to 1–3 lines and never overflows; the placeholder's Chrome
  intrinsic width (a `width:auto` clone of the real control — the engine stating what it needs)
  stays at or below the control's actual width at every one of them.
- **Retry round-trip**: degraded → `Retry` with the route healthy → degraded again. `#fld-node`
  goes `fld wide` 350px / 3 options → `fld` 170px / 21 options / `#node-warn` hidden /
  `#src-ok` shown / `machine registry: 20 machines` → back again. No page errors on any load.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-clusters ~/.lmui/apps/assist-clusters
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-clusters/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
