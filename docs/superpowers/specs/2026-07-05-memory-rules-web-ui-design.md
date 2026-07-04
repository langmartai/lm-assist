# Memory + Rules Web UI — Design

Date: 2026-07-05
Status: approved (user-reviewed in session)

## Context / problem

The memory backend is rich — per-project memory files with typed frontmatter
(`type`, `validity`, `validation_tier`, shareability, persistence), a deterministic
record index (`core/scripts/memory-map.js`) behind `/memory/map` + `/memory/record/:id`,
cross-host mirrors with search, import candidates, cross-node sync with 3-way + LLM
merge, and three curation queues (proposals / reconcile-plan / validate-plan as
read-only JSONL). Rules mirror this deliberately (`/rules/map`, `/rules/rule/:id`,
sync + autosync status, `os:` scoping, `synced.<host>.*` active copies + inert
mirrors under `~/.lm-assist/rules-mirror/<host>/`). Both prefixes are on the hub
relay allow-list.

The web is nearly blind to all of it: `settings/MemoryTab.tsx` shows two toggles and
sync counters. There is no way to view a memory file, search records, browse another
project's or node's memory, see rules at all, or view the curation queues. Rules lack
file-level read endpoints (map only), and neither memory nor rules has any write
endpoint.

## Decisions (made with user)

1. **Capabilities**: browse + search + **edit** (create/edit/delete from the web).
2. **Placement**: one new sidebar page **Memory** with tabs **Memory | Rules | Sync**
   (memory and rules get the same treatment — they are parallel systems).
3. **Node model**: **node selector + mirrors** — page header dropdown targets any
   online node via `apiClient.fetchPath(path, {machineId})` (hub relay); host-mirrors
   are always visible as read-only sources.
4. **Approach**: thin UI over the existing record map + small new file-CRUD routes
   (no new consolidated backend layer, no raw file-manager).

## Goals

From the web, on any node in the fleet:
- Find any memory record across projects and nodes with one search or ≤3 clicks.
- Read full record + raw file content, including other hosts' mirror copies.
- Edit / create / delete this node's live memory files and own user rules, safely.
- See rules with their os/active/inert routing per node.
- See sync health (memory + rules) and the curation queues in one place.

## Non-goals

- Editing mirror copies or `synced.<host>.*` rules (sync artifacts — edit at origin;
  the node selector makes the origin one click away).
- Mutating the proposals/reconcile/validate JSONL (harvester stays propose-only).
- PROJECT rules (`<repo>/.claude/rules/` — git-owned); only USER rules
  (`~/.claude/rules/`).
- WYSIWYG editing, memory generation, or new search infrastructure.

## Architecture

### Page structure

```
web/src/app/(dashboard)/memory/page.tsx      ← thin route wrapper
web/src/components/memory/
├── MemoryPage.tsx        ← tab frame + node selector + shared fetch hook
├── NodeSelector.tsx      ← online machines; default "This node"; re-points fetches
├── MemoryBrowser.tsx     ← Memory tab
├── RulesBrowser.tsx      ← Rules tab
├── SyncTab.tsx           ← Sync tab (status + curation queues)
├── RecordList.tsx        ← shared list w/ type/validity/node badges + search box
├── RecordDetail.tsx      ← drawer: record render + raw file w/ source selector
└── FileEditor.tsx        ← markdown textarea + preview + frontmatter template
```

Sidebar: add `{ href: '/memory', icon: Brain, label: 'Memory' }` to `baseNavItems`
in `web/src/components/layout/Sidebar.tsx`.

All fetches go through `useAppMode().apiClient.fetchPath(path, { machineId })`
— auth (`x-api-key` local / relay-injected in cloud) and `_coreapi` routing come
free. No raw `fetch()` anywhere (web-core-fetch-rules).

### Memory tab (default)

- Left rail: projects from `GET /memory/projects` (name, slug, file count).
  "All projects" pseudo-entry at top = cross-project view.
- Main: records from `GET /memory/map?projects=<slug>&q=&types=&nodes=&limit=`
  (omit `projects` for all). Columns: title, type badge, validity badge, node tags,
  recorded-at. Search box feeds `q=` (multi-term AND, server-side).
- Detail drawer on click: `GET /memory/record/:recordId` (rendered) + raw file via
  `GET /memory/by-project/:projectId/file/:filename?source=live|repo:<host>` with a
  source selector listing `GET /memory/by-project/:projectId/sources`.
- Per-project panel: import candidates
  (`GET /memory/by-project/:id/sync/import-candidates`). Candidate rows get
  **Import to live** = client composes a normal PUT with the candidate's
  `body` (the endpoint returns full content — no extra fetch, no new backend).
- *(Plan amendment)* No dedicated cross-host search panel: the record map
  already indexes host-mirror records, so the main search box covers
  cross-host content with node tags; `/memory/by-project/:id/cross-host`
  stays MCP/API-only.
- **Edit** on live files opens FileEditor; mirrors read-only.

### Rules tab

Same frame over `GET /rules/map?q=&nodes=&limit=` + `GET /rules/rule/:id`.
Raw view/list via new `GET /rules/list` + `GET /rules/file/:filename?source=live|mirror:<host>`.
First-class columns: `os`, **active vs inert** (mirror), origin node (parsed from
`synced.<host>.` prefix). Own rules (no `synced.` prefix) editable; synced + mirror
read-only with "edit at origin" affordance (switches node selector).

### Sync tab

Read-only, both systems side by side:
- Memory: `GET /memory/sync/status`, `GET /memory/autosync/status`,
  `GET /memory/harvest/status`.
- Rules: `GET /rules/sync/status`, `GET /rules/autosync/status`.
- Curation queues: `GET /memory/proposals`, `GET /memory/reconcile/plan`,
  `GET /memory/validate/plan` — lists with status filters. A proposal row offers
  **Open as new memory file** → pre-fills FileEditor (create flow); the JSONL is
  never mutated.
- Settings toggles STAY in Settings → MemoryTab (ownership unchanged); Sync tab
  links there.

### Node selector

- Machine list from the same source MachineDropdown uses; shows online state.
- Selection re-points every fetch on the page (`machineId` param). Local non-hub
  mode: selector pinned to "This node".
- Browsing + editing a remote node's live files rides the relay: same trust model
  as every other relayed route (hub-authenticated user has full API on their nodes;
  relay injects the worker token server-side).

## Backend additions

New route file `core/src/routes/core/memory-files.routes.ts`:

| Route | Body / params | Purpose |
|---|---|---|
| `PUT /memory/by-project/:projectId/file/:filename` | `{ content, expectedHash? }` | Write live memory file |
| `POST /memory/by-project/:projectId/file` | `{ filename, content, indexLine? }` | Create; optionally append `indexLine` to `MEMORY.md` (created if missing) |
| `DELETE /memory/by-project/:projectId/file/:filename` | `{ expectedHash?, removeIndexLine? }` | Delete; optionally remove `MEMORY.md` lines linking to the file |

New route file `core/src/routes/core/rule-files.routes.ts`:

| Route | Body / params | Purpose |
|---|---|---|
| `GET /rules/list` | — | User rules (`~/.claude/rules/*.md`) + mirror dirs: name, size, mtime, parsed `os`/active, synced-origin |
| `GET /rules/file/:filename` | `?source=live\|mirror:<host>` | Raw rule content |
| `PUT /rules/file/:filename` | `{ content, expectedHash? }` | Write own user rule |
| `POST /rules/file` | `{ filename, content }` | Create own user rule |
| `DELETE /rules/file/:filename` | `{ expectedHash? }` | Delete own user rule |

Shared helper `core/src/memory/file-write.ts` (used by both): validate + confine +
hash-check + write. Register both route files in `routes/core/index.ts`. Both live
under already-relay-allow-listed prefixes; standard api-token gate (the node↔node
key-in-body dance remains sync-only).

### Write-safety rails

- Filename must match `^[A-Za-z0-9._-]+\.md$` — no slashes, so mirrors,
  `.sync-base/`, and traversal are unreachable; resolved path must stay inside the
  target dir (double guard, mirroring `ingest.ts`).
- **Rejected** (400 with reason code): managed files (`_cross-project.md`,
  `_hosts.md`), any `synced.<host>.*` rule, any mirror source, dotfiles.
- **Allowed**: `MEMORY.md` (user-maintained index).
- **Concurrency**: `expectedHash` = sha256 of the content the editor loaded; server
  compares current file hash, 409 `HASH_MISMATCH` on drift (sync daemons write these
  files — real hazard). UI offers reload vs overwrite (resend without hash). Create
  409s if the file exists.
- Frontmatter parsed on write via existing utils; problems returned as
  `warnings[]`, never blocking.
- Writes are plain fs writes → the existing chokidar MemoryCache watcher picks them
  up, so the map refreshes and autosync propagates a web edit exactly like a local
  edit (feature, not side effect).

## Error handling

- Write rejections show the reason inline; Edit is disabled preemptively where the
  UI already knows (mirror source, `synced.*`, managed files).
- Node offline / relay failure → page banner with retry; selector shows online state.
- Map/script failure (500) → surfaced with the error message per tab; other tabs
  unaffected (independent fetches).
- 401 → existing api-client proxy-session-expiry handling.
- Editor dirty-state guard before navigation/tab switch.

## Testing

- **Unit (core)**: memory-files + rule-files routes — adversarial path cases
  (`../`, slashes, `synced.*`, managed files, dotfiles), hash conflict, create-exists,
  index-line append/remove idempotence. Follow existing core test conventions.
- **Browser (dev :3948)**: LAN IP + `lanAccessToken` flow; verify browse project
  memory, cross-project search, record detail incl. mirror source, edit→save→map
  refresh, create with index line, delete with index-line removal, reject cases
  (synced rule, managed file), Rules tab active/inert display, Sync tab queues.
- **Cross-node (staging)**: node selector against 123/107 (staging cluster) —
  browse + one hash-guarded edit round-trip via relay. Prod 117 untouched; fleet
  deploy remains a separate user-gated step.

## Out of scope / future

- Apply-proposal writeback to the JSONL (would break propose-only; revisit with a
  proper curation workflow).
- Diff view for live vs mirror (endpoint `GET /memory/by-project/:id/diff` exists —
  natural follow-up).
- Editing PROJECT rules from the web (git-owned).
