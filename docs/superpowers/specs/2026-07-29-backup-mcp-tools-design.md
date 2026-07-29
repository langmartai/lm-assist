# Backup MCP tools — porting `E:\claude-backup` into lm-assist

**Date:** 2026-07-29 · **Branch:** `feat/backup-mcp-tools` · **Reference:** code session
`54aa4d40-b84a-4942-8915-7ded1b169151` on DESKTOP-GDKLATG (271 turns), artifacts at
`E:\claude-backup` on 107, remote `git@github.com:langmartai/claude-backup.git` (private).

## Goal

Take the working PowerShell backup on 107 and make it a first-class lm-assist capability:
five MCP tools that run a backup, report status, **query the backup without restoring it**,
and **remove an item for real** — including from inside a packed snapshot.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Store | **Adopt `E:\claude-backup` as-is** | Keeps 4.7 GB already captured, the private repo, and the status history. No migration. |
| Collector | **107 (DESKTOP-GDKLATG)** | 117 is 97% full (3.3 GB free) and its own `.claude` is 6.8 GB. E: is the only volume with room, and the archives already live there. |
| Repack on remove | **Immediate, on 107** | The archives are there and so is the scratch space. 117 cannot repack a 2 GB tarball. |
| Secrets | **Excluded at capture** | Full exact backup of sessions/memory/rules; no auth material for lm-assist, Claude Code or claude.ai. |
| Engine | **TypeScript in Core, shelling out to `robocopy`/`tar`** | Keeps the proven copy semantics; adds indexing + filtering in code. |

## Architecture

New module `core/src/backup/`, mirroring `core/src/linkedin/`:

```
core/src/backup/
  config.ts     backupRoot discovery, target table, collector identity
  secrets.ts    the capture-time deny-list (wraps sensitiveReadReason)
  store.ts      status.json / STATUS.md / history.log / excludes.json / removals.jsonl
  index.ts      SQLite FTS5 index (better-sqlite3, already a dep)
  capture.ts    the five targets: mirror, two tar snapshots, claude.ai, memory-rules
  remove.ts     targeted delete + stream-repack of a snapshot
```

Wiring — additive edits only, mirroring how LinkedIn is registered:

| File | Edit |
|---|---|
| `core/src/mcp-server/tools/backup.ts` | **new** — `BACKUP_TOOL_DEFS` + `BACKUP_HANDLERS` (handlers call loopback REST via `_passthrough`) |
| `core/src/mcp-server/tools/expanded.ts` | import + spread into `EXPANDED_TOOL_DEFS` and `EXPANDED_HANDLERS` |
| `core/src/mcp-server/configure.ts` | 5 `TOOL_SCOPES` entries — **required or `assertScopesCoverTools()` crashes Core at boot** |
| `core/src/mcp-server/registry/catalog.ts` | `mod('backup.ts', 'backup', [...])` + `'backup'` in `CATEGORY_ORDER` — enforced by `mcp-tool-catalog.test.ts` |
| `core/src/mcp-server/tool-output-budget.ts` | classify all 5 — enforced by `mcp-tool-output-size.test.ts` |
| `core/src/mcp-server/tool-topics.ts` | `backup: [...]` playbook topic |
| `core/src/routes/core/backup.routes.ts` | **new** — REST surface |
| `core/src/routes/core/index.ts` | import + spread `createBackupRoutes(ctx)` |

Three guards, not one. The brief named `configure.ts`; `catalog.ts` and
`tool-output-budget.ts` fail the test suite the same way.

## Tools

### `backup_run` — scope `write`
```ts
{ targets?: string[], dryRun?: boolean, skipBlobs?: boolean, reindex?: boolean }
```
Targets: `windows-desk` (=107) · `linux-117` · `linux-123` · `claudeai` · `memory-rules`; default all.
Returns per target: method, result, sizeMB, items, **secretsExcluded**, rows indexed, duration.
`dryRun` enumerates and reports what *would* be captured and excluded, writing nothing.

### `backup_status` — scope `read`
```ts
{ detail?: 'summary' | 'full' }
```
The STATUS table plus what the PowerShell version never had: a **staleness verdict** per source
(`fresh` / `stale (N days)` / `never`), index freshness (`indexedAt`, rows by kind), free space on
the backup volume, cumulative secret-exclusion counts, and the last git push result.

### `backup_list` — scope `read`  ← "what is actually in the backup"
```ts
{ source?, kind?, project?, prefix?, container?, limit? /*30, max 60*/, offset? }
```
Called bare it returns an **overview** — items and bytes per host and kind, plus the snapshots
held. That view aggregates, so its size is fixed by policy (5 hosts × 5 kinds, 5 retained
snapshots each) rather than growing with the backup, which is what makes it safe as the default
landing call. Any filter switches it to a paged window over the entries themselves, newest first.

Search cannot answer this: it needs a term, and guessing terms to discover content is not
discovery.

### `backup_search` — scope `read`  ← the "query without restoring" tool
```ts
{ q: string, kind?: 'session'|'memory'|'rule'|'conversation'|'file',
  source?: 'windows-desk'|'linux-117'|'linux-123'|'claudeai',
  project?: string, since?: string, limit?: number /*20, max 100*/, offset?: number }
```
`source`, not `node` — `node` is the auto-injected routing parameter on every lm-assist tool and
must not be shadowed.
Returns hits (`id`, kind, source, title, path, snapshot, mtime, size, excerpt) plus `total`,
`truncated`, `indexedAt`, `stale`.

### `backup_read` — scope `read`
```ts
{ id: string, offset?: number, maxBytes?: number /*64 KiB default, 1 MiB max*/ }
```
Extracted tree → direct file read. Tarball member → `tar -xzOf <snapshot> <member>`, which streams
one entry without unpacking the archive. Bounds match `fs_read` so the surface feels consistent.

### `backup_remove` — scope `admin`
```ts
{ id: string, reason: string, confirm: true, exclude?: boolean /*default true*/,
  scope?: 'item' | 'snapshot' /*default item*/ }
```
Deletes from extracted trees; for a member inside a `.tar.gz`, **stream-repacks** the snapshot
without it, verifies the new entry count, and swaps atomically. Appends a tombstone to
`removals.jsonl` (what, why, when, by whom). `exclude:true` also records the path in
`excludes.json` so the next run does not re-capture it.

## Paging — the size contract

The MCP result ceiling is **65,536 B** (`DEFAULT_MAX_RESULT_BYTES`) with a **25 KiB** per-tool
soft budget. Past the ceiling a result is truncated **above** the tool, so the tool's own "End of
results" is still printed and the reply reads as complete when it is not. That is how a single
923 KB `mission_list` killed a 110-message conversation.

So every windowed result here obeys three rules:

1. **A measured page, not an assumed one.** `backup-output-size.test.ts` renders worst-case data —
   140-char clamped paths, 220-char excerpts, 500 legacy secrets — through the real renderers at
   each route's maximum page, and asserts the bytes. Measured: overview 2,931 B · list 15,285 B ·
   search 15,824 B · read 21,439 B, against a 25,600 B soft budget.
2. **The renderer enforces its own clamps**, not just the route. A bound that lives only upstream
   disappears the moment the renderer is called from somewhere else.
3. **Every page states `Showing X–Y of Z` and the exact next call.** A partial page never prints
   "End of results". A `backup_read` whose `maxBytes` was clamped says so, so a short reply is
   never mistaken for the whole file.

Pages: list 30 rows (max 60) · search 10 hits (max 25, each carrying an excerpt) · read 8 KB
(max 20 KB).

**A schema that advertises a page above the ceiling is a lie, and one shipped here already** —
`backup_read` claimed "64 KB default, 1 MB max" while the route clamped to 20 KB. A caller asking
for 1 MB would have received a short reply with nothing indicating it was short. A test now walks
`backup_read`'s own description and schema and fails if any advertised byte figure exceeds the
ceiling or disagrees with the route.

## Design answers

### (1) Removal vs git history

**The premise does not apply, and that is the most important finding.** The payload was never
committed. `.gitignore` excludes `windows-desk/`, `linux-117/`, `linux-123/`, `claudeai/`,
`memory-rules/`, `logs/`, and the remote tree confirms it: 6 files, 41 KB, all scripts and status.

So removal is a **filesystem operation only** — no `filter-repo`, no force-push, and the remote is
unaffected. What removal *does* have to defeat is different and easy to miss:

- **The mirror re-creates it.** `windows-desk/` is `robocopy /MIR` from the live `.claude`. A plain
  delete is undone on the next run. Hence `excludes.json`.
- **`robocopy /XF` does not delete what is already there.** An excluded file that already exists in
  the destination is skipped, not removed — so adding an exclusion is not retroactive. Existing
  captured secrets must be deleted explicitly. This is why the purge is a real step, not a no-op.
- **A tarball member cannot be deleted in place.** Repack is the only honest answer, and it runs
  where the archive lives.

Only `STATUS.md` / `status.json` are in git; if a removal changes them they commit forward normally.

### (2) Query index

SQLite **FTS5** via `better-sqlite3` (already a core dependency), at `<backupRoot>/index.db`,
gitignored.

```sql
CREATE TABLE items(
  id TEXT PRIMARY KEY,        -- sha1(source|container|member)
  kind TEXT, source TEXT, project TEXT,
  path TEXT,                  -- logical path within .claude
  container TEXT,             -- '' for extracted trees, else the snapshot filename
  member TEXT,                -- tar member path when container is set
  title TEXT, mtime INTEGER, size INTEGER, capturedAt INTEGER);
CREATE VIRTUAL TABLE items_fts USING fts5(title, text, content='');
```

**Built during capture**, while the tar stream is already decompressed — the only moment the data
is readable without paying for it twice. One pass, no extra I/O. Incremental: unchanged
`(path, mtime, size)` is skipped.

What carries indexed text, so the index stays small and the results stay meaningful:

| kind | text indexed |
|---|---|
| session | user prompts + assistant text from `projects/*/**.jsonl` — **not** tool payloads (that is where the 90,414 entries and most bytes are) |
| memory | `projects/*/memory/*.md` in full |
| rule | `rules/**.md` in full |
| conversation | claude.ai message text + `attachments[].extracted_content` |
| file | metadata only |

`backup_search` reports `indexedAt` and `stale` rather than silently degrading to a scan.

### (3) Cross-node

**Central pull, collector = 107.** Forced by measurement, not preference: 117 has 3.3 GB free
against its own 6.8 GB `.claude`. Per-node push would need write credentials on three nodes and
still have nowhere to write.

Orchestration moves into Core so it is node-agnostic: the collector is whichever node declares a
`backupRoot`. The MCP `node:` parameter routes there for free. Called on 117, the tools return a
pointer rather than a vague failure: *"no backupRoot on this node — the collector is
DESKTOP-GDKLATG; re-call with `node:"DESKTOP-GDKLATG"`"*.

SSH targets come from 107's existing `~/.ssh/config` (the proven path — bare `ssh <ip>` with
per-host users) with `machine_access` as the documented fallback. Measured from 117 for the record:
123 needs `-i ~/.ssh/ssh-keys/id_rsa`; the default key fails.

### (4) Security

Verified state of the existing backup:

| Finding | Verdict |
|---|---|
| GitHub repo contents | ✅ 6 files, 41 KB, scripts + status only. **No secret has ever been pushed.** |
| Repo visibility | ✅ private |
| `windows-desk/.claude/.credentials.json` | 🔴 555 B — live Claude Code OAuth token, plaintext on E: |
| `claudeai-session{,.isolated,.Profile_1}.json` | 🔴 ~3 KB each — live claude.ai cookies |
| `claudeai-browser-profile/` | 🔴 whole Chrome profile incl. cookie DB |
| 117 / 123 tarballs | 🔴 `tar czf - .claude` = whole folder, so each contains that host's `.credentials.json` |

The exposure is not GitHub — it is that the only control **is** the `.gitignore`. A `git add -A`
under a changed ignore file, or flipping the repo public, publishes live tokens. lm-assist's own
`fs_read` already refuses `~/.claude/.credentials.json`; the backup has no equivalent.

**Capture-time deny-list** (`core/src/backup/secrets.ts`), reusing `sensitiveReadReason()` from
`core/src/file-transfer/fs-inspect.ts` (already covers `.credentials.json`, `.ssh/`, `.env`,
`*.pem`, `*.key`, `.lm-assist/`) plus the extension it lacks:

```
.claude/claudeai-session*.json        claude.ai cookies (all profile variants)
.claude/claudeai-browser-profile/     Chrome profile + cookie DB
.claude/chrome/                       browser state
.claude/ide/                          IDE lockfiles with ports/tokens
.claude/mcp-needs-auth-cache.json     auth state cache
```

Everything else is backed up fully and exactly: `projects/*/` sessions, `projects/*/memory/`,
`rules/`, `settings.json`, `history.jsonl`, `tasks/`, plugins, and the claude.ai conversations.

Made verifiable rather than assumed: `backup_status` reports `secretsExcluded`, and a unit test
asserts the deny-list matches every file listed above.

**Purge of already-captured secrets is a separate approved step** — `backup_run` never deletes
existing data silently. `backup_status` names the offending files; a `backup_remove` call with an
explicit reason removes them, repacking the 117/123 tarballs.

### Tar slip — found in review, fixed before landing

Extracting a remote archive with `path.join(dest, entry.name)` trusts member names that arrive
over ssh from another host. A name containing `..`, a leading `/`, or a drive letter escapes the
destination — and on the collector that destination sits next to the live `.claude` the backup
exists to protect, so one compromised fleet host would turn the backup into a write primitive
against 107.

`safeMemberPath()` normalises and refuses those names, `containedPath()` verifies the resolved
target really is under the destination, and only regular files (`type === '0'`) are written, so a
symlink member cannot be planted for a later member to be written through. Both checks run at the
**index** as well as the extract: a member name is persisted and later handed back to
`backup_read` and `backup_remove`, so a name unsafe to write is a name unsafe to record. Refusals
are counted and logged rather than passed over silently.

Tested with a hand-assembled hostile archive — GNU `tar` refuses to *create* these names, which is
precisely why the test writes the header bytes itself. Verified the test fails when the guard is
removed.

## Implementation order

1. `config.ts` + `secrets.ts` + tests — deny-list correctness first, since everything else writes data.
2. `store.ts` — status/history/excludes/removals, reading the existing `status.json` shape unchanged.
3. `index.ts` — schema, FTS5, incremental upsert; tests against fixtures.
4. `capture.ts` — five targets, secret filtering, index-during-capture.
5. `remove.ts` — targeted delete, stream-repack, tombstone.
6. `backup.routes.ts` + registration in `routes/core/index.ts`.
7. `tools/backup.ts` + the three guard registrations + topic.
8. `npm test` in the worktree; `./core.sh build` to prove it compiles.

## Constraints honoured

Work happens in the worktree `.claude/worktrees/backup-mcp` on branch `feat/backup-mcp-tools`,
off `main`. No tracked file in the shared checkout is modified — three other sessions
(`117-lm-assist-ccr`, `-2`, `-3`) are editing `expanded.ts`, `configure.ts`, `catalog.ts`,
`tool-topics.ts` and `tool-output-budget.ts` right now, so all edits here are additive and land as
separate hunks. No deploy, no Core/Web restart, no `node_upgrade`, no commit to `main`.
Deployment to 107 is a later, separately authorised step.
