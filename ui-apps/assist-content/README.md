# assist-content

The lm-assist **Content** pane: the `assist-content` registry (the bootstrap/guide prose the
MCP connector serves — overridable fleet-wide, live, with no deploy) folded together with
**assist-resources** (the `~/.lm-assist` file + log browser). They are sibling surfaces over
the same node: one edits what the connector *says*, the other reads what it *wrote*. Follows
the `assist-backlog` pilot and the `assist-memory` two-tab shape; plain JS, no build, no deps.

Ported from `web/src/components/assist-content/{AssistContentPage,ContentDetail}.tsx` and
`web/src/components/assist-resources/AssistResourcesPage.tsx`.

## Grant

```json
[
  { "service": "node", "pathPrefix": "/assist-content",            "verbs": ["GET"],         "exact": true },
  { "service": "node", "pathPrefix": "/assist-content/*",          "verbs": ["GET", "POST"], "exact": true },
  { "service": "node", "pathPrefix": "/assist-content/*/rollback", "verbs": ["POST"],        "exact": true },
  { "service": "node", "pathPrefix": "/assist-resources",          "verbs": ["GET"] }
]
```

Rule by rule:
- `GET  /assist-content` — the catalog joined with the registry delta (`{units,orphanDocs,groups,counts}`)
- `GET  /assist-content/:id` — one unit, **flat** (no `{unit:…}` wrapper)
- `POST /assist-content/:id` — save/clear `{contentOverride?, blurbOverride?}`
- `POST /assist-content/:id/rollback` — `{toRev}`

🔴 **The write rules name leaves, not the `/assist-content` subtree.** It used to be one
`node:/assist-content [GET, POST]` line, which grants `POST` on *every* path under
`/assist-content` — today that happens to be the same two routes, but any mutating route added
below that prefix later would join this pane's authority silently, with no config change and no
review. The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed
on both serving tiers.

`/assist-resources` keeps its subtree form on purpose: it is GET-only, so no write can hide in it,
and it prefix-covers `/files`, `/file`, `/file-stat` and `/log`.

The view token's grant is the hard ceiling — anything outside these rules 403s. POST is granted
**only** on the two `/assist-content` write routes; the resources side is structurally read-only.

⚠️ `/assist-resources/file` hands the pane any file under the server's allow-list
(`~/.lm-assist`), which includes credential-bearing files such as `assist-config.json`
(`lanAccessToken`). That is the route's existing behaviour, not something this pane widened —
but it means the pane is a **secret-reading surface**, and its grant should not be handed out
more freely than API-key access to the node itself.

## Layout

Two top-level tabs sharing one list|detail grid (`assist-memory`'s shape).

**Content registry** — units grouped in the server's declared order (`overview` →
`bootstrap` → `guide`), plus an `orphans` group for stored docs this build emits no unit for.
Badges: `rev N`/`default`, `override`, `blurb`, `§bootstrap`/`§guide`, size. Detail has three
sub-tabs:
- **view** — the blurb one-liner, orphan / generated-list warnings, and the effective body as
  plain-text `pre`. When a unit is overridden, a toggle shows the **code default** beside it.
- **edit** — body textarea + blurb field, live UTF-8 byte meters against the server's real caps
  (16384 B body, 300 B single-line blurb), Revert, Restore default (two-click confirm), and a
  Save that **re-reads the doc first and refuses on a rev change**, keeping your draft.
- **history** — every revision with actor, size and blurb, and a two-click Rollback.

**Resources** — the `~/.lm-assist` tree with expand/collapse, a name filter, size + mtime, and
a viewer that renders per format: `context-inject-hook.log` as parsed START…context…END blocks
(prompt, session, sources/tokens/ms, expandable injected context), `mcp-calls.jsonl` as call
cards, JSON pretty-printed, everything else as plain-text `pre`. A 2 s `file-stat` watcher
flags "updated on disk" and reloads; toggle it off with the **watch** checkbox.

### Four things the port had to get right

1. **Two routes reach the same tree selection.** `/assist-resources/log` takes a **key** from a
   server-side map (`context-inject-hook.log`, `mcp-calls.jsonl`) — anything else is
   `ASSIST_RESOURCES_UNKNOWN_LOG`; `/assist-resources/file` takes an **absolute path**. The
   viewer branches on the selected node, or half the tree 400s. (The old page keyed this off
   "name ends in `.log`/`.jsonl`" and then forced the name to one of the two known logs, so
   selecting any *other* `.jsonl` silently displayed the **wrong file**. Here a non-known log
   goes to `/file` and shows itself, with a client-side line filter.)
2. **`depth` is the whole payload budget.** Measured on this node: depth 1 → 33 KB/3.3 s,
   2 → 1.3 MB/4.8 s, 3 → 4.3 MB/6.2 s, **4 → 26 MB/8.8 s**. The old page hard-coded `depth=4`.
   This pane defaults to **2** and puts depth on a labelled selector. A non-numeric `depth`
   makes the server recurse unbounded, so the value is clamped to 1–6 before it is sent.
3. **`effectiveBody`, not `defaultBody`.** The detail payload carries four body fields; loading
   the wrong one into the editor silently discards an existing override on the next save.
4. **Two tabs, one `#list` and one `#detail` — so every paint reached from a promise re-checks
   the tab.** `paintUnitList`, `paintUnitDetail`, `paintTree` and `paintFileDetail` each return
   immediately unless `state.tab` is still theirs. Without that, any response outliving a tab
   switch paints over the other tab: selecting a unit and clicking **Resources** before the
   open resolves used to paint the unit detail across the file viewer, and a save or rollback
   completing after a switch did the same. `state.seq` does not cover this — it supersedes one
   unit open by a *newer open*, not by a tab change. The file-stat watcher always had this
   guard (`state.tab !== 'resources'`); the promise paths did not. Nothing is lost by skipping
   a paint: `switchTab` repaints both panes from state on the way back in.

### Cross-pane navigation

Param names follow the pinned cross-pane vocabulary: **the entity's singular noun, unqualified**
(`session`, `project`, `mission`, `task`, `cluster`, `tool`, `dataset`, `skill`, `unit`, `doc`),
plus the two generic modifiers `tab` and `q`. No other names are emitted or read.

**Outbound.** Knowledge ids (`[K001.2]`) inside injected-context log lines become chips that call
`lmui.goto('assist-knowledge', { unit: … })` — never a hand-built URL. Session ids render
as inert chips carrying the full id in their tooltip: there is no sessions pane to jump to yet.
If one lands, that is the single place to wire it.

**The chip sends the id at full grain — suffix and all.** `KID_RE` captures either `K12` (the
document) or `K12.3` (one part of it), and both go out as `unit` unchanged. There is no second
param for the part: the vocabulary has none for a sub-locator, and one is not invented here.

That the dotted form is not itself a document address is real — Core's document route is
`/^\/knowledge\/(?<id>K\d+)$/`, **no dot**. Measured on this node:

```
GET /knowledge/K12    -> HTTP 400  {"error":"Not found"}                  # route matched, handler ran
GET /knowledge/K12.3  -> HTTP 404  "Route not found: GET /knowledge/K12.3" # route never matched
```

🔴 **But that split belongs to the target, not to this emit.** `assist-knowledge`'s `landOnUnit()`
validates `/^K\d+(?:\.\d+)?$/`, slices the base id off for the document fetch, and reuses the `.N`
suffix as the part to **highlight** in the detail. Normalizing to the base id here (an earlier
version of this fix did) still opens the right document, but silently discards precision the
target is written to consume — a caller that pre-flattens an id is indistinguishable, at the
target, from one that never had a part. Send what was clicked; let the receiver decide the grain.

**Inbound.** The pane reads these from `location.search` on load and lands on the entity:

| param | meaning | behaviour |
|---|---|---|
| `unit` | a content unit id | loads the list, then opens that unit **on the Content tab**; an unknown id renders the detail pane's error state (`code: message`), never a silent no-op. An empty or whitespace-only value is not a deep link |
| `tab`  | `content` (default) or `resources` | switches the top-level tab before the first load — honoured **only when no `unit` is given**. Any value other than `resources` leaves the default Content tab |

🔴 **They do not compose — `unit` decides the tab.** Both tabs render into the *same* `#list`
and `#detail` (index.html declares one of each), so `?tab=resources&unit=X` cannot show both.
Treating them as independent is exactly the bug this pane shipped with: the tab branch switched
to Resources (depth selector, `filter files…`, `loadFiles()`, watcher) and the unit branch then
ran unconditionally, painting content rows and the unit detail into that same DOM — the visible
result was Resources chrome wrapped around content, racing whichever fetch resolved last.
`unit` names an entity only the Content tab can render, so it wins and `tab=resources` is
ignored for that load; `tab` still decides on its own. `lmui.goto('assist-content',
{ unit: 'guide.ccr' })` lands on the unit, and `{ tab: 'resources' }` lands on the file browser.

Landing on Resources while opening the unit *behind* it is the other consistent reading, and it
was rejected: a deep link that shows nothing — including hiding the unknown-id error state
promised above until you happen to click the other tab — is not a deep link.

(`unit` is the same noun on both sides but not the same id space: inbound it is an
`assist-content` unit id such as `guide.ccr`, resolved against `/assist-content/:id`; outbound it
is a knowledge id such as `K12`, resolved by `assist-knowledge` against `/knowledge/:id`. The
pinned vocabulary covers both under "a knowledge/content unit id" — each pane resolves the noun
in its own store.)

`[label](#doc:<id>)` links inside a unit body (the overview map is 29 of them) stay live and
select the sibling unit in place. That is the only markdown construct rendered as markup —
everything else is plain text in a `pre`, so there is no markdown library and nothing to
violate the self-hosted/CSP rule. The `#doc:` id charset is `[a-z0-9][a-z0-9.-]*`, which is
what makes a `#doc:javascript:…` target inert rather than a link.

## Both tiers

`assets/lmui.js` is copied **verbatim** from `ui-apps/assist-backlog/assets/lmui.js` (the
canonical copy) — do not hand-edit it. `core/src/__tests__/lmui-shim-identity.test.ts` md5s every
copy against the canonical one and fails the suite on any drift; re-sync with
`cp ui-apps/assist-backlog/assets/lmui.js ui-apps/assist-content/assets/lmui.js`.
(This line used to quote a literal `md5 6cf5555…, 4228 B`, which had gone stale — the shim is now
10620 B — so anyone spot-checking integrity against the README would see a false mismatch. The
test is the live check; it needs no number here.) `api()` strips the hub relay's outer `{status,data}` envelope when present, so
the same file runs unchanged on the hub gateway and on the node-local tier. Every asset ref in
`index.html` is relative, and the document keeps a literal `</head>` — the local tier injects
`<base href>` and the view token by string-searching for it.

## Deploy

```bash
cp -r ui-apps/assist-content ~/.lmui/apps/assist-content
lm-assist restart
```

Hub gateway: `https://ui-<ownerSlug>-assist-content.<appDomain>/`
Local tier:  `http://<lan-ip>:<localUiPort>/ui/assist-content/?lt=<entry token>`
(mint the entry token with `POST /ui-pages/local-url {"uiId":"assist-content"}`).

Both honor `?embed=1&theme=light|dark`.
