# Cross-project memory signpost

Status: DESIGN (2026-06-23, approved in brainstorming).

## Goal

When an LLM recalls a project's memory, make it AWARE that this lm-assist node curates memory for
OTHER projects too, and that it can pull that memory on demand via the langmart MCP tools. Realized
as a **managed signpost file auto-written into every project's memory dir** plus a one-line pointer
in each project's `MEMORY.md` (the index surfaced on recall).

## Background

- Per-project memory lives in `~/.claude/projects/<slug>/memory/*.md` + a `MEMORY.md` index.
- Cross-project READ already exists via the langmart MCP: `memory_projects` (list projects),
  `detail` / by-project read (`getByProject`), `search_memory` (search across), `memory_cross_host`
  (host mirrors). The gap is **awareness** — nothing tells the LLM these exist during recall.
- Precedent: lm-assist already writes a managed `_hosts.md` into memory dirs; `parseDir`
  (`memory-cache.ts`) skips it so it isn't a knowledge record. We follow that convention.

## Design

### 1. The managed file — `_cross-project.md`

Written into each project's LIVE memory dir (`~/.claude/projects/<slug>/memory/_cross-project.md`).
The `_` prefix follows the `_hosts.md` convention (kept out of host-mirror discovery + knowledge
records). Starts with a managed header (`<!-- managed by lm-assist … do not edit; regenerated -->`)
and a content version, then two parts:

1. **Static instruction** (identical everywhere) — names the cross-project MCP tools + when to use:
   prefer this project's memory first; reach cross-project when a question spans projects, references
   shared infra/conventions, or this project's memory is thin.
2. **Live "other projects" list** (auto-generated) — every OTHER non-excluded project on this node,
   one line each: `- **<name>** (`<slug>`) — <hook>` where `<name>` = basename of the project path,
   `<hook>` = the project's `MEMORY.md` title/first prose line, else `<fileCount> memory entries`.

### 2. MEMORY.md pointer

lm-assist ensures one **managed pointer line** in each project's `MEMORY.md` (idempotent — add only if
absent; create a minimal `MEMORY.md` if none exists):
`- [Cross-Project Memory](_cross-project.md) — other projects' memory via langmart MCP (managed)`
This is the recall-surface (MEMORY.md is the loaded index).

### 3. Auto-sync to all projects (local)

lm-assist auto-writes/refreshes the file into EVERY local non-excluded project:
- **Core-start sweep** — regenerate all projects' files once on boot.
- **Debounced re-sweep on project-set change** — a watcher on `~/.claude/projects/` (depth 0); when a
  project dir is added/removed, re-sweep so every file's "other projects" list stays current.
- **Lazy-ensure** — safety net: when a project's memory is read, ensure its signpost exists/current.
- **Idempotent** — only rewrite a file (or MEMORY.md) when its content actually changes (hash compare),
  so the watcher doesn't loop and mtimes stay stable.

"Auto-sync to all projects by default" = this local replication; the file is **per-node managed
boilerplate**, regenerated on each node — it is NOT pushed over the cross-node memory sync.

### 4. Exclusions

- **Knowledge records:** `parseDir` + `extractRecords` skip `_cross-project.md` (no search/listing
  pollution), exactly like `_hosts.md`.
- **Cross-node sync:** the autosync guard drops `_cross-project.md` (alongside `MEMORY.md`/`_hosts.md`).
- **Self:** a project never lists itself; **excluded** projects (`project-settings.excludedPaths`) are
  neither written to nor listed.

### 5. Config

`crossProjectSignpostEnabled: boolean` in `ProjectSettings` (`~/.lm-assist/project-settings.json`),
**default `true`**. When false, the sweep/watcher/lazy-ensure all no-op (existing files left as-is).

## Files (create / modify)

- `core/src/memory/cross-project-signpost.ts` (create) — `renderSignpost(self, others)` (pure
  markdown), `ensureSignpostFor(projectsDir, slug, others)` (write file + MEMORY.md pointer,
  idempotent), `sweepAllProjects()` (list via memory-api, generate each).
- `core/src/memory-cache.ts` (modify) — `parseDir` skips `_cross-project.md`.
- `core/src/memory/record-extract.ts` (modify) — `extractRecords` returns `[]` for `_cross-project.md`.
- `core/src/memory/autosync.ts` (modify) — `guard()` drops `_cross-project.md`.
- `core/src/project-settings.ts` (modify) — add `crossProjectSignpostEnabled` (default true).
- `core/src/rest-server.ts` (modify) — run the start sweep + projects-root watcher (near the autosync
  daemon start).
- tests (see plan).

## Testing

- **Unit:** `renderSignpost` includes the static tool list + each "other" project line, excludes self;
  managed header + version present. `ensureSignpostFor` writes the file, adds the MEMORY.md pointer
  once (idempotent re-run = no change), creates MEMORY.md if absent. Exclusion: `extractRecords` /
  `parseDir` skip the file; autosync `guard()` drops it. Config-off → `sweepAllProjects` no-ops.
- **Integration:** a two-project sweep writes each project's file listing the OTHER project; re-sweep
  is a no-op (idempotent); an excluded project is skipped.

## Out of scope (YAGNI)

- Cross-node propagation of the signpost (regenerated per node).
- A UI for it; editing it (it's managed/overwritten).
- Embedding full memory content of other projects (the LLM calls the live MCP tools for that).
