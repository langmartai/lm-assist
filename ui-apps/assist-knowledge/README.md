# assist-knowledge

The lm-assist knowledge base as a scoped UI pane — a plain-JS (no build, no framework) app
that lists, searches and inspects knowledge documents through the node's `/knowledge` routes.
It follows the `assist-backlog` pilot exactly: the same unmodified document runs behind the
hub's ui-gateway AND behind the node-local HTTP tier, because every data call goes through the
injected `assets/lmui.js` SDK helper (view token + re-mint on 401/403), never a hard-coded
origin.

## Grant

One declared grant in `lmui.config.json`, and nothing else it can reach:

```
node:/knowledge [GET, POST]
```

That prefix covers everything this pane calls:

- `GET /knowledge?status=all` — list rows (bare array). Client-side filters by type / status / origin.
- `GET /knowledge/search?q=<text>` — hybrid (vector + FTS + content-match) part-level hits.
- `GET /knowledge/:id[?machineId=]` — the full document (parts with content + metadata).
- `GET /knowledge/review/status` — review-process status.
- `POST /knowledge/review` — trigger the batch review (the only write; empty body, concurrency-safe).

The view token's grant is the hard ceiling — anything outside `/knowledge` 403s.

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

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-knowledge ~/.lmui/apps/assist-knowledge
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-knowledge/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
