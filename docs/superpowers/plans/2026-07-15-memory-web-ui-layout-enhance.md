# Memory Web UI — Layout Correctness + UI/Feature Enhancements

Date: 2026-07-15. Branch: `worktree-memory-ui-enhance` (worktree of main @ b92fb07).

## Problem (verified live on dev :3948 + code review)

The Memory page (`web/src/components/memory/`) renders a document-flow block (`p-6 space-y-4`)
inside the app shell `.shell-main`, which is `overflow: hidden` (globals.css:226). App convention
(see `SessionBrowser.tsx:311`) is a `height:100%` flex root with internally-scrolling panes.
Consequences, all confirmed in browser:

1. **The record list, project rail, rules list, and Sync tab content are CLIPPED below the fold
   and unreachable** — shell-main clientHeight 835 vs scrollHeight 4292; zero scroll containers
   except the detail panes' `max-h-[80vh]`.
2. Right-edge overflow: "+ New rule" button and "active" badges clip off-viewport; record-row
   project paths clip at the edge.
3. Project rail counts render jammed against names ("lm-assist52").
4. Sync tab dumps raw `JSON.stringify` for all 5 status endpoints — developer UI, also clipped.
5. Errors show raw `String(e)` ("API 400: {json}") everywhere except RecordDetail, which already
   has a private `errText()` extractor (RecordDetail.tsx:14) — the known deferred item is to share it.
6. `window.confirm` used for deletes (RecordDetail, RulesBrowser) and dirty-cancel (FileEditor).
7. `/rules/list` (rule-files.routes.ts `listDir`) is top-level-only while the actual loader
   `readOwnRules` (rule-sync.ts:59) walks recursively → nested rules are ACTIVE but INVISIBLE in the UI.
8. `frontmatterWarnings()` (memory-files.routes.ts:39) warns on MEMORY.md, which legitimately has
   no frontmatter (known deferred item).
9. No hint when a record originates from another node (`record.node` vs self) — deferred item.
   `selfHostId()` exists (rule-sync.ts:33: LM_HOST_ID > hub gatewayId > hostname).
10. `MapRecord.recordedAtMs` exists but is never shown; no type/validity filters; no counts; no copy.

## Global Constraints (binding for every task)

- Visual language: keep the existing Tailwind palette used by these components (gray-950/900/800
  borders `border-gray-800`, text grays, emerald/rose/amber/sky accents, `text-sm`/`text-xs` scale).
- Scroll pattern: a pane that can grow gets `flex-1 min-h-0 overflow-y-auto`; fixed chrome (headers,
  search bars, tab strips) stays outside the scroller. Root of each tab component: `h-full`,
  wrapper in MemoryPage: `flex-1 min-h-0`. NO `max-h-[NNvh]` caps anywhere after this change.
- No horizontal page scroll at 1280px or wider; truncation via `truncate` + `title` tooltip; badges
  and metadata spans get `shrink-0`.
- The `key={nodeId ?? 'local'}` remount + `refreshTick` re-fetch semantics in MemoryPage MUST be
  preserved (MemoryPage.tsx:53-57), as must the hash-guarded save flow (`expectedHash`,
  HASH_MISMATCH → conflict UI) in FileEditor.
- All web→core calls stay on the provided `call` prop (peer-relay-aware `apiClient.fetchPath`) —
  no raw fetch(), no new client helpers.
- API compatibility: `GET /memory/map` response shape MUST NOT change (bare array consumed by MCP +
  connector). `GET /rules/list` entries keep all existing fields; `filename` becomes a relative
  POSIX path for nested entries (top-level entries unchanged — same string as today).
- Core changes need node:test unit tests placed in NESTED `__tests__` dirs (e.g.
  `core/src/routes/core/__tests__/`, `core/src/memory/__tests__/`) — the `npm test` glob SKIPS
  top-level `core/src/__tests__/*`. Any test that touches MemoryApi/`invalidate()` must
  `after(() => resetMemoryCache())` (pattern: memory-api-list-projects.test.ts) or the suite hangs.
- Worktree hygiene: stage EXPLICIT paths (`git add <file>...`) — NEVER `git add -A` (node_modules
  symlinks exist here). Commit per task with a conventional message.
- TypeScript must compile: web `npx tsc --noEmit -p web/tsconfig.json` (if configured) or rely on
  `next build` later; core `./core.sh build` must pass after core changes.

## Tasks

### Task 1 — Layout restructure to full-height scrolling panes (web only)

Files: MemoryPage.tsx, MemoryBrowser.tsx, RulesBrowser.tsx, RecordDetail.tsx, SyncTab.tsx.

- MemoryPage root: `p-6 space-y-4` → `h-full flex flex-col overflow-hidden p-6 gap-4`. The keyed
  tab wrapper div (line 54) gets `flex-1 min-h-0` (keep the key semantics comment).
- MemoryBrowser root: `flex gap-4 text-sm` → `h-full min-h-0 flex gap-4 text-sm`.
  - Project rail: `w-56 shrink-0 space-y-1` → `w-56 shrink-0 flex flex-col min-h-0`; "All projects"
    button fixed on top (add total record-file count via sum of fileCount, style like project rows);
    project list in `flex-1 min-h-0 overflow-y-auto space-y-1 pr-1`.
  - Project row: name `truncate` (keep `title=` tooltip) + count moved into a right-aligned pill:
    row becomes `flex items-center gap-2`, name `flex-1 truncate`, count
    `shrink-0 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400`.
    This fixes the jammed "lm-assist52" rendering.
  - Records column: `flex-1 min-w-0 space-y-2` → `flex-1 min-w-0 flex flex-col min-h-0 gap-2`;
    search row + error/loading stay fixed; then ONE scroller `flex-1 min-h-0 overflow-y-auto space-y-2`
    containing the bordered record list AND the import-candidates box.
  - Record row: add `shrink-0` to both Badges, the node span, and the project span; add
    `title={r.title || r.file}` on the row title span and `title={r.project}` on the project span.
- RecordDetail root: `w-[36rem] shrink-0 border ... max-h-[80vh] overflow-y-auto` →
  `basis-[36rem] min-w-[20rem] max-w-[36rem] shrink border border-gray-800 rounded bg-gray-950 h-full flex flex-col`
  (shrinkable detail pane: flexbox negotiates down to 20rem on narrow viewports instead of forcing
  horizontal overflow — the 3-pane row must fit at 1280px with a record selected).
  Header block (title row + error) fixed with `p-3 pb-0`; body `flex-1 min-h-0 overflow-y-auto p-3 space-y-3`.
- RulesBrowser root: same treatment as MemoryBrowser (`h-full min-h-0 flex gap-4`); list column
  header row fixed; list in `flex-1 min-h-0 overflow-y-auto`; detail pane `w-[32rem] max-h-[75vh]`
  → `basis-[36rem] min-w-[20rem] max-w-[36rem] shrink h-full flex flex-col` (unified sizing with
  RecordDetail), header fixed, `pre` body in `flex-1 min-h-0 overflow-y-auto`.
- SyncTab root: `space-y-4` → `h-full min-h-0 overflow-y-auto space-y-4 pr-1`.
- MemoryPage header row (line 38): add `flex-wrap` so the NodeSelector wraps instead of
  overflowing on narrow viewports.
- Badge tooltips: `Badge` (MemoryBrowser.tsx:17) accepts an optional `hint` and sets `title`
  (use e.g. "record type" / "validity"); RulesBrowser os and active/inert badges get `title=`
  ("applies on: …" / "active on this node" / "inert here (os-scoped or mirror)").
- Keyboard focus: record-row and rule-row buttons get `focus-visible:ring-1 focus-visible:ring-gray-500 outline-none`.
- Acceptance: with dev tools, every pane scrolls independently; NO horizontal scroll at 1280px
  even with a detail pane open; the page itself never scrolls.

### Task 2 — Shared formatting helpers + kill browser dialogs + keyboard (web only)

New file `web/src/components/memory/format.tsx` exporting:
- `errText(e: unknown): string` — MOVE verbatim from RecordDetail.tsx:14-19 (delete the private copy).
- `timeAgo(ms: number): string` — "just now", "Nm ago", "Nh ago", "Nd ago", else `toLocaleDateString()`;
  guard non-finite/<=0 input → ''.
- `ConfirmButton({ label, confirmLabel, onConfirm, className })` — two-step inline confirm: first
  click arms (shows confirmLabel, e.g. "Confirm delete", amber/rose emphasis), auto-disarms after 3s
  or on blur; second click fires onConfirm. No window.confirm.

Apply:
- Replace every `setError(String(e))` in MemoryBrowser (×3), RulesBrowser (×2), SyncTab (×2 in
  StatusBlock/QueueList) with `setError(errText(e))`. In FileEditor keep the
  `String(e).includes('HASH_MISMATCH')` conflict check but display `errText(e)` for the error banner.
- RecordDetail delete + RulesBrowser delete: replace `window.confirm` with ConfirmButton
  (keep exact delete semantics incl. `removeIndexLine=true` and `expectedHash`). ConfirmButton
  disables itself while `onConfirm`'s promise is in flight (no double-fire DELETEs); the
  import-to-live button in MemoryBrowser likewise gets a per-row in-flight disabled state.
- FileEditor cancel: replace `window.confirm('Discard unsaved changes?')` with an inline bar that
  appears when cancel is clicked while dirty: "Unsaved changes." [Discard] [Keep editing].
- FileEditor: add a `beforeunload` listener while dirty (`content !== baseline`) so closing the
  browser tab mid-edit warns (removed on unmount/when clean).
- Escape key: FileEditor — Escape triggers the same cancel flow (root gets `data-file-editor`
  attribute); RecordDetail and RulesBrowser detail pane — Escape closes the pane, but the handler
  no-ops when `document.querySelector('[data-file-editor]')` exists (editor overlay wins).
- RecordDetail header: add a Copy button (copies `file.body ?? full.complete ?? ''` via
  `navigator.clipboard.writeText`, flashes "Copied" for ~1.5s; hidden when nothing to copy).
- RecordDetail markdown links: pass `components={{ a }}` to ReactMarkdown — external http(s)
  hrefs render as `<a target="_blank" rel="noopener noreferrer">`; any other href renders as a
  plain styled `<span>` (kills dead-route in-app navigations from memory docs). Memory-scoped
  only; the app-wide sweep stays a non-goal.

### Task 3 — Sync tab humanization (web only; depends on Task 2's format.tsx)

SyncTab.tsx: replace raw-JSON `StatusBlock` with a structured card renderer, keeping the raw JSON
one toggle away.
- `StatusBlock` parses the KNOWN shape `{ config?: object, daemon?: { mode?, running?, hostId?,
  counts?: Record<string,number>, recentEvents?: Array<{ts,mode?,project?,decision?,detail?}> } }`
  (memory/rules sync + autosync + harvest all follow it; probe defensively — every field optional).
  Render:
  - status line: colored dot + text — emerald "running" when `daemon.running===true`, gray "off"
    when mode is 'off'/undefined, amber otherwise; show `mode` and `hostId` when present.
  - config chips: each non-null scalar key of `config` as `key: value` chip
    (`bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-[10px]`).
  - counts grid: `grid grid-cols-3 gap-x-4 gap-y-1` of label/value (tabular-nums); render all keys.
  - recent events: last 5, newest first — `timeAgo(ts)` + `decision` + `project` (truncate),
    each on one `text-[11px]` row.
  - Unrecognized/absent structure → fall back to today's `<pre>` JSON.
- Each Section gets a small "raw" toggle (top-right of the section header row) that reveals the
  original `<pre>{JSON.stringify(data,null,2)}</pre>` under the cards; the raw `<pre>` (and the
  QueueList expanded-row `<pre>`) get `max-h-64 overflow-auto` so a huge payload can't blow up
  the section.
- QueueList: add an "N items" count line above the rows (and keep "Empty." state).
- Acceptance: /memory Sync tab shows readable cards for all 5 status sections; raw toggle works;
  queues show counts.

### Task 4 — Core: recursive rules listing + nested rule file ops + MEMORY.md warning exemption + self-node route (+ unit tests)

Files: `core/src/memory/file-write.ts`, `core/src/routes/core/rule-files.routes.ts`,
`core/src/routes/core/memory-files.routes.ts`, `core/src/routes/core/memory.routes.ts` (or
memory-map.routes.ts — implementer picks the natural home), plus NESTED `__tests__` files.

- `file-write.ts`: add `export function relPathProblem(relpath: string, protectedPatterns: RegExp[] = []): FileWriteErrorCode | null`
  — accepts `a.md` or `sub/dir/a.md`: split on '/', reject empty/`.`/`..`/backslash/control chars;
  every DIRECTORY segment must match `/^[A-Za-z0-9._-]+$/` and not start with '.'; the BASENAME is
  validated with the existing `filenameProblem` (protected patterns apply to the basename). Add a
  nested-capable confinement helper (resolved dest must be inside resolved root) used by
  `writeMdFile`/`deleteMdFile` when given relpaths, and `writeMdFile` must `mkdirSync(dirname, {recursive:true})`
  for nested creates. Keep existing top-level behavior byte-identical for plain filenames.
- `rule-files.routes.ts`:
  - `listDir` walks recursively (withFileTypes; recurse into dirs, skip dot-dirs and dot-files),
    `filename` = POSIX relpath from the source root. Everything else (os/active/syncedFrom via
    basename regex, editable, title) unchanged. Mirrors are separate roots (rules-mirror under
    data dir, NOT inside rulesRoot) — no double-listing.
  - GET/PUT/POST/DELETE `/rules/file/...`: swap `filenameProblem` → `relPathProblem` (same
    RULES_PROTECTED patterns, tested against basename); mirror `sourceDir` handling unchanged.
- `memory-files.routes.ts`: `frontmatterWarnings(content, filename)` returns `[]` when
  `/^memory\.md$/i.test(filename)` (Windows-safe `/i`). Update both call sites.
- New route `GET /memory/self-node` → `wrapResponse({ node, platform })` where `node` uses the SAME
  identity the memory-map records use for local files — inspect `core/scripts/memory-map.js`
  (`myHost` derivation ~line 110); if it matches `selfHostId()` from `core/src/rules/rule-sync.ts`,
  import and reuse that. This is for the web UI origin hint (Task 6).
- Web (RulesBrowser): rows show the relpath (existing `{r.title || r.filename}` is fine — ensure
  the filename span truncates with a title tooltip; nested paths must not break edit/delete:
  `encodeURIComponent(filename)` already encodes '/').
- Unit tests (node --test, NESTED dirs):
  - `core/src/memory/__tests__/rel-path.test.ts`: relPathProblem — accepts `a.md`, `sub/a.md`,
    `s.u-b_2/x.md`; rejects `../a.md`, `sub/../a.md`, `.hidden/a.md`, `sub\\a.md`, `a.txt`,
    `synced.host.md` under protected patterns (case-insensitive `Synced.`), empty segments (`//`).
  - `core/src/routes/core/__tests__/rule-files-recursive.test.ts`: tmpdir rules root with
    `top.md` + `nested/dir/deep.md` + `.git/skip.md` → list returns exactly the two with correct
    relpath filenames; GET/PUT/DELETE round-trip a nested rule; PUT to `synced.x.md` basename in a
    subdir is PROTECTED.
  - `core/src/routes/core/__tests__/memory-files-warnings.test.ts`: PUT MEMORY.md with plain
    bullet content → `warnings: []`; PUT other.md without frontmatter → warning present. Follow the
    resetMemoryCache() teardown pattern if MemoryApi is touched.
  - self-node: assert `{node, platform}` non-empty strings.
- Acceptance: `./core.sh build` clean; the new tests pass via
  `node --test dist-test/...` (build:test) or the documented per-file invocation.

### Task 5 — Browse features: filters, counts, sort, search polish, timestamps (web only)

MemoryBrowser.tsx (+ format.tsx timeAgo):
- Filter chips under the search row: TYPE chips built from distinct `type` values present in the
  loaded records, VALIDITY chips fixed [current, stale, outdated, superseded]. Multi-select toggle;
  active chip = its palette color, inactive = gray outline. Client-side filter of `records`.
- Count + cap note: right of the search row show `{filtered}/{records.length}`; when
  `records.length === 200` add "first 200 matches — refine search" hint (`text-[10px] text-gray-500`).
- Sort select (compact, next to count): `recent` (recordedAtMs desc, DEFAULT) | `title` (A-Z).
- Record rows: right-aligned `timeAgo(r.recordedAtMs)` in `text-[10px] text-gray-600 shrink-0 w-14 text-right`.
- Search input: add a lucide Search icon inside (left), a clear "×" button when q non-empty;
  Escape in the input clears q. Keep the 300ms debounce. While `loading` with previous results
  still shown, dim the stale list (`opacity-60`) instead of showing rows + "Loading…" as if final.
- Refresh buttons: a small lucide RefreshCw icon button next to the search input (MemoryBrowser →
  `loadRecords()`) and next to the rules header (RulesBrowser → `load()`).
- RulesBrowser: add a client-side filter input (same styling as memory search, no debounce needed)
  matching filename/title, plus a count line "N rules · M active" above the list.
- Import candidates rows: when `relevanceScore` is a finite number, show it as a `text-[10px]`
  gray chip (e.g. `rel 0.82`); keep existing fields.
- Acceptance: chips filter instantly without refetch; sort stable; timestamps humanized; refresh
  re-fetches without a full page reload.

### Task 6 — Remote/origin awareness (web only; depends on Task 4's /memory/self-node)

- MemoryPage: fetch `/memory/self-node` once per node selection (plain `call`, ignore errors →
  selfNode null) and pass `selfNode` down to MemoryBrowser/RulesBrowser/SyncTab; when `nodeId` is
  set show a one-line amber banner above the keyed wrapper: "Viewing node {nodeId} via relay —
  reads and edits apply on that node." (`text-amber-300/90 text-xs border border-amber-900/50
  bg-amber-950/30 rounded px-2 py-1`).
- RecordDetail: accept optional `selfNode`; when `record.node && selfNode && record.node !== selfNode`
  render an amber `origin: {record.node}` badge next to the subtitle with
  `title="Recorded on {record.node}; the raw file shown is the copy visible to this node."`.
- Acceptance: local browsing (no node selected, record.node === selfNode) shows NO banner/badge;
  unit-verifiable by code inspection + e2e spot-check of no-badge case (staging cross-node pass
  is post-deploy, per precedent).

### Task 7 — MCP: memory write capability + bootstrap/guide memory story (core only)

Today the MCP memory surface is READ-ONLY (memory_projects / memory_map / memory_record /
memory_cross_host / memory_import_candidates / memory_sync_status / search_memory) while the web
UI has full hash-guarded CRUD via `/memory/by-project/:id/file...`. Agents on any connector can
list/read memory but cannot update it. Close the gap by REUSING the existing routes (all
server-side validation — filenameProblem, protected files, hash guard — applies automatically).

Files: `core/src/mcp-server/tools/expanded.ts` (defs + handlers + EXPANDED_TOOL_DEFS
registration), `core/src/mcp-server/configure.ts` (access-class map), `core/src/mcp-server/tools/guide.ts`
(bootstrap + guide content). Follow the existing def/handler/registration pattern exactly
(read-only tools carry `annotations.readOnlyHint`; write tools are classed `'write'` in
configure.ts like `data_put`/`mission_update`).

- New tool `memory_file` (read class): args `project_id` (slug from memory_projects), `filename`,
  optional `source` (default `live`). Handler GETs
  `/memory/by-project/:project_id/file/:filename?source=` on the local Core (same loopback HTTP
  helper the sibling handlers use) and returns `{ filename, source, body, hash }`. Description:
  "Read one memory file raw (body + hash). The hash is the expected_hash for memory_write update
  — read before you write."
- New tool `memory_write` (write class): args `action` ('create'|'update'|'delete'), `project_id`,
  `filename`, `content` (create/update), `expected_hash` (update/delete — optional but STRONGLY
  recommended; omitting overwrites blind), `index_line` (create, optional — MEMORY.md index
  bullet), `remove_index_line` (delete, optional, default true). Handler maps to
  POST / PUT / DELETE on `/memory/by-project/:id/file[...]` with the same query/body contracts
  the web uses; returns the route's `{ hash, warnings, indexUpdated }` (or delete ack) verbatim
  plus a one-line hint when `warnings` non-empty. On `HASH_MISMATCH` the error text must tell the
  caller to re-read with `memory_file` and retry. Description documents the discipline:
  list (memory_map) → read (memory_file) → write with expected_hash; per-node: a `node:`-targeted
  call runs on that node and edits THAT node's memory (existing hub routing).
- MCP arg coercion gotcha (from [[generic-data-service]]): connector clients send numbers/bools
  as STRINGS — coerce `remove_index_line` with the file's existing coercion helper/pattern.
- Bootstrap + guide (guide.ts): update the memory portion of the `bootstrap` payload and the
  relevant guide topic (locate the existing memory/guide text) so a session discovers the FULL
  story in one read: list → read → WRITE (hash-guarded) → cross-host search → import candidates →
  sync status → the web Memory page (sidebar). Keep it to a handful of lines, matching the
  existing bootstrap voice.
- Deliberate non-goals, stated in the tool descriptions/report: no rule_write (rules stay
  read-only over MCP for now); no changes to search_memory/memory_map shapes.
- Tests (nested `__tests__`): whatever pattern existing tool tests use (e.g. machine-access);
  at minimum unit-test the arg→route mapping (action/query construction incl. string-coerced
  booleans and encodeURIComponent of project/filename) by factoring the request-builder into a
  small exported function. Full live verification happens in the integration e2e step via
  `POST :3200/mcp` tools/call round-trip (create → read → update w/ hash → delete on a temp
  project).

## Execution notes

- Order: 1 → 2 → 3 → 4 → 5 → 6 (3 uses 2's helpers; 6 uses 4's route). Sequential dispatch, one
  implementer at a time (SDD).
- Per task: implement, run the relevant checks (web: `cd web && npx next build` is deferred to the
  integration step — instead run `npx tsc --noEmit` scoped if quick; core: `./core.sh build` +
  targeted node --test), commit with explicit paths.
- Integration step after Task 6: full web `next build` (Node 20), core build, full-ish core test
  run, then e2e browser pass on dev :3948, then fleet deploy, then merge to main.

## Non-goals

- ReactMarkdown dead-route links (app-wide, 9 components — separate effort).
- rule-map.js / MCP rule tools recursion (separate scope; UI list is the target here).
- Cross-node write-path changes (peer-relay path validation already allows nested reads/writes;
  live cross-node verification remains a post-deploy staging pass, per precedent).
- NodeSelector gating changes (isHybrid gate is a deliberate security decision).
