# assist-mission-processes

The mission **workflow registry** — the playbook docs Mission Control actually reads
(`controller.*`, `onboard.*`, `drive.*`, `wrapup.*`, `recover.*`, `observe.*`) plus the
`case.*` learned-case library — as a scoped UI pane. A plain-JS app (no build, no framework,
no dependencies) that lists every doc in the registry grouped by namespace and, for the
selected one, shows the text the controller is handed (invariant preamble + body), the raw
stored body, an **editor** with a rev-conflict-guarded save, and the doc's revision history
with **rollback**.

It follows the `assist-scheduler` / `assist-backlog` pilots exactly: the same unmodified
document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because every
data call goes through the injected `assets/lmui.js` SDK helper (view token + re-mint on
401/403), never a hard-coded origin. `assets/lmui.js` is copied verbatim from the pilots.

It replaces the web page at `web/src/app/(dashboard)/mission-processes/`. The grouping,
case-index cue parsing, invariant-preamble split and doc-id linkification are ports of the
vitest-covered pure helpers in `web/src/lib/mission-process.ts` — the same rules, not a rewrite.

## Grant

Three declared rules in `lmui.config.json` — one read, two writes — and nothing else it can reach:

```
node:/mission/workflows              [GET]
node:/mission/workflows/*            [POST]  exact:true
node:/mission/workflows/*/rollback   [POST]  exact:true
```

The read rule is a subtree and is strictly tighter than the `/mission` the Missions and
Mission-Graph panes need. **The write rules are deliberately not a subtree.** In the local-tier
rule form (`core/src/ui-pages/local-tier/grants.ts`) `*` matches exactly one path segment and
`exact:true` requires the request to have the rule's segment count, so the two POST rules reach
`POST /mission/workflows/<id>` and `POST /mission/workflows/<id>/rollback` and nothing else. The
one-line alternative — `pathPrefix:"/mission/workflows" [POST]` — would additionally have handed
this pane every POST anyone ever adds under that subtree, and `pathPrefix:"/mission" [POST]`
would have handed it mission create and patch. Asserted against Core's own matcher
(`readDeclaredGrant` + `grantAllows`) over 19 allow/deny cases, including
`POST /mission`, `POST /mission/<id>`, `POST /mission/workflows` and
`POST /mission/workflows/<id>/rollback/extra` — all denied.

Two things stay refused even though a write grant now exists:

- a **`human-only`** doc is not editable here. Core only refuses *controller* writes on that
  policy, and a REST write from a pane is attributed `user` — so the server would accept it.
  The ceiling is this pane's, not the API's, and the Edit tab says so.
- **`editPolicy` is never sent**, so this pane can neither set nor clear `human-only`. Omitted,
  the server keeps the doc's existing policy.

The five routes it calls (paths + shapes mirror `handleWorkflowList` / `handleWorkflowGet` /
`handleWorkflowHistory` / `handleWorkflowSet` / `handleWorkflowRollback` in
`core/src/routes/core/mission.routes.ts`, all curled against the live dev API):

- `GET /mission/workflows` — the registry. `data` is a **wrapper `{ workflows, defaults }`**
  (not a bare array). `workflows` carries the **full** doc including `body` and its inline
  `history`; `defaults` is the ids of **built-in docs that have never been stored** — real,
  openable docs that are *not* in `workflows`. Rendering only `workflows` would make every
  un-seeded built-in vanish from the list, so the pane renders the union and badges each row
  `rev N` or `default`.
- `GET /mission/workflows/:id` — `data = { doc|null, defaultBody|null, rendered }`. `doc` is
  **null** for an un-stored default (the pane falls back to `defaultBody`); `rendered` is the
  body with the immutable `⟦INVARIANTS⟧…⟦/INVARIANTS⟧` preamble prepended. An id that is
  neither stored nor built-in returns `{success:false,error:{code:'NOT_FOUND'}}`.
- `GET /mission/workflows/:id/history?limit=&beforeRev=` — `data = { snapshots:[…] }`, newest
  first. Each row **strips the body** and substitutes `bodyBytes:number`, so a revision can never
  be previewed or diffed from here — only its rev, actor, time, title, size and policy. `beforeRev`
  pages older (`rev < beforeRev`); past the oldest rev the route answers with an **empty list**,
  not an error, which is what the pager reads to stop. Curled: `?beforeRev=2` → `[1]`,
  `?beforeRev=1` → `[]`.
- `POST /mission/workflows/:id {title, body}` — `data = { doc, changed }`. `changed:false` when
  the write was byte-identical: `putWorkflow` no-ops and **the rev does not advance**. That is
  success-with-nothing-done, and the pane reports it as such rather than as a failed save.
- `POST /mission/workflows/:id/rollback {toRev}` — `data = { doc }`. Restoring rev N **re-saves
  N's title and body as a new rev**; it deletes nothing and renumbers nothing. A missing snapshot
  is `{code:'NOT_FOUND', message:'no snapshot <id>:<n>'}` and a missing/NaN `toRev` is
  `{code:'INVALID_INPUT'}` — both curled.

The view token's grant is the hard ceiling — anything outside those three rules 403s. Reads are
leader-anchored in Core and writes are origin-anchored, so either may be served by a peer node;
that is why a save applies the doc the **write** returned instead of re-`GET`ting, which can
legitimately answer with the previous rev and make a landed save look dropped.

## Layout

Two panes:

- **List** — a text filter (doc id / title / case cue) and a namespace chip row, then the docs:
  `process.overview` pinned at the top when it exists (the map of the control flow), followed by
  one group per namespace in registry order (`process`, `controller`, `onboard`, `drive`,
  `wrapup`, `recover`, `observe`, `case`, `other`). Each row shows the id, a `rev N` or `default`
  badge, a `human-only` badge where that policy applies, the title, who last edited it and when,
  and — for `case.*` rows — the RECOGNIZE cue parsed out of the `case.index` body. The counts
  line reports `showing X of Y docs · N stored · M default`.
- **Detail** — the provenance bar (id, title, rev/default and edit-policy pills, last editor and
  timestamps) over four tabs, then a status line carrying the server's own words about the last
  write:
  - **Rendered** — the invariant preamble in its own marked block ("immutable; prepended to
    every doc, not editable by anyone"), then the body, with every **known** doc id turned into
    a click-to-open chip so the playbooks stay navigable in place.
  - **Raw** — the stored body exactly as saved (or the built-in default body, labeled as such).
  - **Edit** — title + body, with a live UTF-8 byte meter against the server's 64 KiB
    `MAX_WORKFLOW_BODY_BYTES`. Save is disabled with the **reason** shown next to it (nothing
    changed / body empty / over the cap), and the button names the transition it will make
    (`Save (rev 4 → 5)`). An un-stored default opens seeded with the built-in body at rev 0.
  - **History** — rev, when, actor, title, size and policy per snapshot, current rev badged,
    with **Restore…** on every other row.

### Save is guarded against clobbering a concurrent edit

The rev this draft was loaded at is the concurrency anchor. Save re-`GET`s first and, if the doc
moved, **refuses without writing** and says so in full: which rev it was, which rev it is now, and
who moved it. The draft stays in the editor — the only way to lose it is to reload deliberately.
The guard is advisory, not a transaction (the route has no compare-and-set), but it turns
"silently overwrote the controller's edit" into "told you, kept your text". Switching tabs,
hitting *Refresh registry*, or opening another doc with unsaved text is called out rather than
silently discarding it; Refresh deliberately does **not** reload a doc you are editing.

### Rollback confirms first, and shows what it is restoring

*Restore…* only **arms** — it never writes on one click. The confirm bar names the revision, when
it was saved and by whom, its size, its policy and its title, and states plainly that restoring
rev N creates a **new** rev (nothing is deleted, nothing is renumbered) and that Mission Control
picks the restored text up on its next pass. Cancel is right next to it.

### History is paged, and the cap is disclosed

25 rows per call, newest first, with **Load older revisions** issuing `beforeRev=<oldest loaded>`
until the server returns an empty page. The note above the table states the page size *and* the
fact that Core prunes to the **20 most recent snapshots per doc** on every write — so anything
older is gone from the server, not merely unloaded. That note is shown on the empty state too:
"no snapshots" and "snapshots pruned away" look identical from here, and only one of them means
nothing ever happened.

Doc bodies are markdown but render as **plain text** in a pre-wrap block: there is no markdown
or mermaid library in any pane and adding one would break the self-hosted/CSP rule, so a
` ```mermaid ` fence is shown as its source with a note saying why. Nothing is hidden.

`?doc=<id>` is the inbound deep link (what `lmui.goto` carries into this pane) and is kept in
the address bar as you navigate, so a reload lands back on the same doc. A sibling may also send
`?mission=<id>`; this registry is fleet-wide rather than per-mission, so that param is accepted
and ignored rather than 404-ing the pane.

An inbound id is **always fetched**, whether or not the loaded registry lists it — the list read
is leader-anchored and a lagging replica can legitimately omit a doc that exists. An id the
server then rejects gets an explicit **"no such document"** state naming the id, quoting the
route's own `NOT_FOUND` text, saying how many docs this node does hold, offering the closest ids
in the registry as one-click chips, and leaving `?doc=` in the address bar so the URL and the
screen agree. *Clear the link* drops the param; *Check again* re-asks. (Before this, an unknown
`?doc=` was a silent no-op: no request, no message, and a URL still naming a doc nobody opened —
which is precisely what "nothing is swallowed" is supposed to rule out.) The same rule covers
*Refresh registry*: a doc that disappears from the list is re-asked, not blanked.

A hard failure of the primary registry call surfaces the server's own error text full-screen; a
failure of one doc or its history stays inline with a Retry — nothing is swallowed. A failed
list-refresh *after* a landed write is reported inline instead, because a full-screen error there
would tell the user the opposite of what happened.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-mission-processes ~/.lmui/apps/assist-mission-processes
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-mission-processes/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
