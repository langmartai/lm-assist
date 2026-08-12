# assist-memory

Claude Code **memory + rules** as a scoped, read-only UI pane — a plain-JS (no build, no
framework) app that browses this node's saved memory files and user rule files through the
node's `/memory` and `/rules` routes. It follows the `assist-backlog` / `assist-knowledge`
pilots exactly: the same unmodified document runs behind the hub's ui-gateway AND behind the
node-local HTTP tier, because every data call goes through the injected `assets/lmui.js` SDK
helper (view token + re-mint on 401/403), never a hard-coded origin. The only raw fetch is
`/auth/me` (identity for the header badge).

## Grant

Two declared grants in `lmui.config.json`, both **read-only (GET only)** — nothing else it
can reach:

```
node:/memory [GET]
node:/rules  [GET]
```

This pane is intentionally read-only: it lists and reads, it never writes. The memory read
routes have no write counterpart, and the rule write routes (`PUT`/`POST`/`DELETE /rules/file`)
carry concurrency (`expectedHash`) and sync-artifact protections that a simple viewer should
not attempt for v1. The view token's grant is the hard ceiling — anything outside `/memory`
or `/rules` 403s.

## Layout

Two tabs, sharing a list column and a detail column:

- **Memory** — a project selector (`GET /memory/projects`, a bare array of project summaries),
  then the selected project's file list (`GET /memory/by-project/:projectId` → `files[]`, with
  the `MEMORY.md` index surfaced as a synthetic top entry when present). Clicking a file reads
  it (`GET /memory/by-project/:projectId/file/:filename?source=…`) and renders the body as
  **plain-text `pre-wrap`** (no markdown library) with metadata: source (live / `repo:<host>`),
  size, updated, and frontmatter (name, description, type, category, validity, validation tier,
  origin session).
- **Rules** — the user rule files (`GET /rules/list` → `rules[]`), own/active first then synced
  and per-host mirror copies. Clicking a rule reads it (`GET /rules/file/:filename?source=…`)
  and renders the content as plain-text `pre-wrap` with metadata: source (live / `mirror:<host>`),
  size, OS scope, active flag, synced-from origin, and editability.

Both tabs have a client-side text filter over the file list. A hard failure of the active tab's
primary call surfaces the server's own error text full-screen — nothing is swallowed.

## Both tiers

Every data call is tier-agnostic (it goes through `lmui.call`), so the same files serve under:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-memory/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell (drops own chrome,
reports `lmui:height` so the shell can size the iframe).

## Deploy

The integrator registers it; the manual path mirrors the sibling panes:

```bash
cp -r ui-apps/assist-memory ~/.lmui/apps/assist-memory
lm-assist restart          # (prod) — pick up the newly-served app
```
