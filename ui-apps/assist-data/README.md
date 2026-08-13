# assist-data

The node's generic **data service** — datasets, access keys and cross-node sync — as a scoped UI
pane. A plain-JS app (no build, no framework, no dependencies) that replaces the old web page at
`web/src/app/(dashboard)/data/` (`web/src/components/data/DataPage.tsx`), reproducing all three of
its tabs and all four of its write actions.

It follows the `assist-backlog` / `assist-knowledge` / `assist-memory` / `assist-scheduler` panes
exactly: the same unmodified document runs behind the hub's ui-gateway AND behind the node-local
HTTP tier, because every data call goes through the injected `assets/lmui.js` SDK helper (view
token + re-mint on 401/403), never a hard-coded origin. `assets/lmui.js` is copied verbatim from
`assist-scheduler` (md5 `6cf55550268ae58bbfc75cb8284a76fa`) — do not hand-edit it.

## Grant

Seven leaf rules in `lmui.config.json` — one per call this pane makes, and nothing else it can
reach:

```
node:/data/catalog     [GET]     exact      node:/data/keys       [GET]     exact
node:/data/sync/status [GET]     exact      node:/data/sync       [POST]    exact
node:/data/datasets    [POST]    exact      node:/data/datasets/* [DELETE]  exact
node:/data/access/*    [DELETE]  exact
```

🔴 **Deliberately not a single `node:/data` rule.** A rule with no `exact` flag is a **subtree**
rule, so one `/data` line would cover the **entire data plane** — `PUT`/`DELETE` on
`/data/:ds/records`, `/query`, `/search`, `/sql`, `/admin`, `/export`, `/fetch` — for every dataset
on the node.

🔴 **And no longer `node:/data/datasets [POST, DELETE]` either.** Verb sets apply to the whole
rule, so that pairing granted `POST /data/datasets/:id` and `DELETE /data/datasets` as well as the
two calls actually made. Splitting it into `POST /data/datasets` (create, a leaf) and
`DELETE /data/datasets/*` (drop one, one wildcard segment) grants exactly the two. Same for
`/data/access`: only `DELETE /data/access/:keyId` is reachable, never `DELETE /data/access`.
The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed
on both serving tiers.

The seven rules cover exactly the seven calls this pane makes and nothing more (asserted in
`core/src/ui-pages/local-tier/__tests__/grants.test.ts`, which carries this pane's full call
inventory).

Paths + shapes mirror `core/src/routes/core/data.routes.ts`, each confirmed against the live dev
API before being coded against:

- `GET /data/catalog` — **the only read the page needs.** `data = { you:{principal,canManage},
  datasets:[{id,backend,visibility,readOnly,actions[]}] }`. `GET /data/datasets` returns the same
  rows but **without** the `you` block, so granting that instead would break the permission badge
  and hide the management controls — it is not granted and not called.
- `GET /data/keys` — `data = { keys:[…] }` (a **wrapper**, not a bare array). Metadata only; Core
  strips `secretHash` before it leaves the process.
- `GET /data/sync/status` and `POST /data/sync` — both answer the **bare** `SyncStatus` object
  (`{lastRun,peersChecked,datasetsReplicated,recordsApplied,recordsSkipped,errors[],
  tombstonesPurged?}`), not wrapped under a `status` key.
- `POST /data/datasets` — create. `data = { dataset }`.
- `DELETE /data/datasets/:id` — drop the dataset **and its storage**. `data = { dropped:boolean }`.
- `DELETE /data/access/:keyId` — revoke an issued key. `data = { revoked:boolean }`.

The view token's grant is the hard ceiling — anything outside those five prefixes 403s. Note that
`POST /data/access` (which *mints* a key) is **not** granted: this pane can revoke access, never
issue it.

### Two things worth knowing

**`success:true` does not mean it happened.** Both `DELETE` routes answer HTTP 200 /
`success:true` with a **false flag** when nothing was removed — verified: deleting an unknown
`keyId` returns `{revoked:false}`. The old React page read only the HTTP result and reported those
as successes. This pane reports the flag ("revoke had no effect — … was not revoked").

**Residual of prefix grants.** Because the granted prefixes are also legal dataset ids, a dataset
named literally `datasets`, `access`, `sync`, `keys` or `catalog` would expose its own
record/query/sql routes through this grant (e.g. `POST /data/datasets/sql`). For every
normally-named dataset those routes are refused. No dataset on this fleet uses one of those five
names; avoid them. Eliminating this entirely needs per-route grants, which the matcher does not have.

## Local-only management

Dataset create/drop, key listing/revocation and sync are gated to the **`local` principal** in Core
(`data-service.ts`). On the node-local tier the proxy calls `127.0.0.1` with the node api-token, so
the pane resolves as `local` and the writes work. Behind the hub relay the same document resolves as
`cloud` and Core answers `FORBIDDEN`, so the pane reads `you.canManage` from the catalog and, when
false, shows a badge plus an explanatory banner, hides every write control, and **does not issue the
keys/sync calls at all** — exactly as the old page did. Both branches are exercised.

## Layout

One tab row plus a single full-width content pane — the source page had no detail view, so every
row stays fully readable inline rather than hiding fields behind a click.

- **Datasets** — text filter + a backend chip row (derived from the loaded rows, so an unknown
  backend kind still gets a working chip). Each row: id, backend / visibility / read-only pills, the
  granted actions, and a two-step **Drop** button. A **New dataset** form (id, backend, visibility,
  syncMode) validates the id against the server's own rule `^[a-z0-9][a-z0-9_-]{0,63}$` before the
  round trip.
- **Access Keys** — text filter + an active/expired/revoked chip row that defaults to **all**, so
  nothing is hidden by default (this node currently has 124 keys, which is why the filter and the
  `showing N of M · K active` count exist). Each row: key id, state, principal, node, label, the
  per-dataset grants, issued/expires as both absolute and relative time, and a two-step **Revoke**.
- **Sync** — last-run line, stat tiles (peers, datasets, records applied/skipped, and tombstones
  purged when the build reports it), the error list from the last run, and **Reconcile now**.

A hard failure of a tab's primary call surfaces the server's own error text full-screen — nothing is
swallowed — and the overlay is cleared on tab switch so a failure on one tab cannot stay pinned over
another.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-data ~/.lmui/apps/assist-data
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-data/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
