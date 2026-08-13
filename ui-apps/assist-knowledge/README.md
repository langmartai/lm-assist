# assist-knowledge

The lm-assist knowledge base as a scoped UI pane — a plain-JS (no build, no framework) app
that lists, searches and inspects knowledge documents through the node's `/knowledge` routes.
It follows the `assist-backlog` pilot exactly: the same unmodified document runs behind the
hub's ui-gateway AND behind the node-local HTTP tier, because every data call goes through the
injected `assets/lmui.js` SDK helper (view token + re-mint on 401/403), never a hard-coded
origin.

## Grant

Two rules in `lmui.config.json`, and nothing else it can reach:

```
node:/knowledge        [GET]           ← subtree: every read under /knowledge
node:/knowledge/review [POST]  exact   ← the ONE write
```

🔴 **The write is a leaf rule, not the `/knowledge` prefix it used to be.** `node:/knowledge
[GET, POST]` granted `POST` on the whole subtree — `POST /knowledge` (create),
`/knowledge/:id` (edit), `/knowledge/:id/regenerate`, `/knowledge/generate`, `/generate/all`,
`/generate/stop`, `/dedup`, `/remote-sync`, `/validate/generic` and the rest of
`knowledge.routes.ts` — around fifteen mutations for a pane that issues exactly one. The `GET`
rule keeps its subtree form because no write can hide inside a read-only verb.
The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed
on both serving tiers.

Between them they cover everything this pane calls:

- `GET /knowledge?status=all` — list rows (bare array). Client-side filters by type / status / origin.
- `GET /knowledge/search?q=<text>` — hybrid (vector + FTS + content-match) part-level hits.
- `GET /knowledge/:id[?machineId=]` — the full document (parts with content + metadata).
- `GET /knowledge/review/status` — review-process status.
- `POST /knowledge/review` — trigger the batch review (the only write; empty body, concurrency-safe).

The view token's grant is the hard ceiling — anything outside these two rules 403s.

## Layout

Three panes:

- **List** — a search box (empty = list all; text runs the server search) plus type / status /
  origin filter chips, and the filtered result rows.
- **Detail** — the selected document's parts, each rendered as **plain-text `pre-wrap`** (no
  markdown library), plus metadata: id, type, project, status, timestamps, source session,
  remote-machine info, LLM review rating/reason, and the search score when opened from a hit.
- **Review** — the count of documents with unaddressed comments (computed from the list), the
  review-process status, and a "Run review" button. The review pass is server-side and
  idempotent (it no-ops while already running and only touches docs that have comments).

Type / status / origin carry the model enums from `core/src/knowledge/types.ts`
(`algorithm|contract|schema|wiring|invariant|flow`, `active|outdated|archived|excluded`,
`local|remote`). A hard failure of the primary list call surfaces the server's own error text
full-screen — nothing is swallowed.

## Inbound params

Deep links arrive as `location.search` — from `lmui.goto('assist-knowledge', {…})` in a sibling
pane, or from a URL somebody pasted. This pane reads exactly one name, from the pinned
cross-pane vocabulary (**the entity's singular noun, unqualified**):

| param | meaning | what the pane does |
|---|---|---|
| `unit` | a knowledge unit id — `K12` (the document) or `K12.3` (one of its parts) | selects that document, scrolls its row into view in the list, opens it in the detail pane, and — when a part was named — highlights that part |

Nothing else is read: `type` / `status` / `origin` are chips the reader drives, and `tab` has no
meaning here (there are no named sub-views). A malformed or absent unit is reported **in the
detail pane** rather than silently ignored.

Notes that are not obvious from the table:

- **The part suffix is split off before the request.** The detail route is
  `/^\/knowledge\/(?<id>K\d+)$/` (`knowledge.routes.ts`), so a whole `K12.3` matches no route
  and comes back `NOT_FOUND: Route not found: GET /knowledge/K12.3`. The pane requests
  `/knowledge/K12` and reuses the suffix as the part to highlight — the same channel a clicked
  search hit already uses.
- **A remote document needs its `machineId`.** The pane resolves the id against the loaded list
  first and carries `?machineId=` when the row is remote; a bare `?unit=K70` for a remote-only
  document would otherwise 404. Ids are per-machine, so the same `K12` can exist locally and
  remotely — the local one wins, deterministically.
- **Values are clamped to 512 chars** — the same ceiling `lmui.goto` enforces on the emitting
  side — and are only ever written with `textContent`, never interpolated into markup.
- **Applied once.** If the list call fails, the fatal card's Retry re-runs the landing; once a
  unit has been landed on, a later retry will not yank the reader off a row they picked by hand.

🔴 `assist-content` linkifies `[K12]` / `[K12.3]` inside content bodies and jumps here with the
clicked id. Before this param was read, that button loaded an unfiltered list and dropped the
id on the floor — **a param no target reads is a silently broken button, not a no-op.**

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-knowledge ~/.lmui/apps/assist-knowledge
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-knowledge/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell, and both honor the
`unit` deep link above (`…/ui/assist-knowledge/?unit=K12.3`).
