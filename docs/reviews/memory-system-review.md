# Memory-System Review

**Date:** 2026-06-21
**Branch:** `feat/memory-system-review`
**Scope:** The lm-assist MEMORY-SYSTEM platform feature — the MCP memory tools
(`search_memory`, `memory_projects`, `memory_cross_host`,
`memory_import_candidates`, `memory_map`, `memory_record`), the HTTP routes that
back them, and the storage/search backend (the file-memory cache + memory API).

This document records what the feature is, where it lives, and a prioritized
list of gaps/bugs/UX issues with `file:line` references. The two **low-risk**
items marked **[IMPLEMENTED]** are fixed on this branch with tests.

---

## 1. Architecture at a glance

```
MCP tool call
  ├─ stdio transport     core/src/mcp-server/index.ts:52   (HTTP client → Core /mcp/* shims)
  └─ StreamableHTTP      core/src/routes/core/mcp.routes.ts:49 (in-process dispatch)
       │
       ├─ search_memory            → handleSearchMemory   core/src/mcp-server/tools/search-memory.ts:89
       ├─ memory_projects          → workerGet /memory/projects                     (expanded.ts:957)
       ├─ memory_cross_host        → workerGet /memory/by-project/:id/cross-host     (expanded.ts:965)
       ├─ memory_import_candidates → workerGet /memory/by-project/:id/sync/import-candidates (expanded.ts:976)
       ├─ memory_map               → shells core/scripts/memory-map.js               (expanded.ts:1476)
       └─ memory_record            → shells core/scripts/memory-map.js --record      (expanded.ts:1494)
            │
            ▼
   HTTP routes: core/src/routes/core/memory.routes.ts , memory-map.routes.ts
            │
            ▼
   Storage/search API: core/src/api/memory-api.ts  (createMemoryApiImpl)
            │
            ▼
   File-memory cache: core/src/memory-cache.ts + memory-cache-store.ts (LMDB)
   Two sources per project:
     • live  →  ~/.claude/projects/<slug>/memory/
     • repo  →  <cwd>/memory/<host-id>/    (per-host mirror, cross-host sync)
   Shareability gate: core/src/utils/memory-shareability.ts (host-local | project-domain | ambiguous)
```

Tool input-schema field names match their handler argument names 1:1, and all
six memory tools are correctly registered as `read` scope
(`core/src/mcp-server/configure.ts`). The feature is well-structured; no critical
bugs were found.

---

## 2. Findings

### [IMPLEMENTED] F1 — `listProjects` aborts the entire listing on one bad project entry  *(robustness; backs `memory_projects`)*

`core/src/api/memory-api.ts:441-465`

```ts
for (const slug of fs.readdirSync(projectsDir)) {
  const projectStorage = path.join(projectsDir, slug);
  if (!fs.statSync(projectStorage).isDirectory()) continue;   // <-- unguarded
  ...
}
```

The per-slug body is **not** wrapped in try/catch. `fs.statSync` throws for a
dangling symlink or an entry removed mid-scan (TOCTOU); `cache.getForProject`
can also throw for an unreadable dir. Any single throw propagates to the outer
`catch` and returns `MEMORY_LIST_PROJECTS_ERROR` for the **whole** call — so one
stray entry under `~/.claude/projects/` makes the `memory_projects` tool return
nothing instead of skipping the bad entry. Every other disk-scanning loop in
this file already uses per-entry `try { … } catch { continue }`
(`search-memory.ts:128-135`, `warm`/`clear` at `memory-api.ts:934-936,965-971`),
so this loop is the inconsistent one.

**Fix (low-risk):** wrap the per-slug body in `try { … } catch { continue }`,
matching the rest of the file. Pure robustness — no change to the happy path.

---

### [IMPLEMENTED] F2 — `search_memory` only matches the query as one contiguous substring  *(recall bug / UX)*

`core/src/mcp-server/tools/search-memory.ts:100,151-169`

The whole query is lower-cased into `q` and every field test is
`field.includes(q)`. A multi-word query therefore only matches when the words
appear **contiguously and in order**. Example against a file body
`"The zebra crossing pattern is here."`:

- `query: "zebra crossing"` → matches (contiguous).
- `query: "crossing zebra"` → **no match**, even though both words are present.

The tool advertises itself as "grep across … for **keywords**"
(`definitions.ts:226`), so users reasonably expect term-wise matching. This
silently returns "no results" for natural multi-keyword queries.

**Fix (low-risk, backward compatible):** split the query into terms and treat a
file as a hit when **every** term appears somewhere in its searchable text
(filename + frontmatter + preview, falling back to a single full-body read).
Single-term queries are unchanged (one term == old substring behavior), so the
existing regression tests still pass; multi-term queries gain the expected
recall. Per-field scoring is preserved (phrase or any-term presence per field).

---

### F3 — `memory_import_candidates` can suggest importing an **older** remote file  *(correctness; not implemented here)*

`core/src/api/memory-api.ts:863-871`

```ts
} else if (f.mtimeMs > local.mtimeMs + 1000 || f.sizeBytes !== local.sizeBytes) {
  reason = 'newer-than-local';
}
```

The branch fires when the remote size merely **differs** from local, regardless
of mtime. If the remote copy is *older* but a different size, it is still
surfaced and labeled `newer-than-local`. Since the tool exists to feed Claude
Code an import/overwrite decision (it returns the full `body`), this can lead to
a newer local file being overwritten by an older remote one, and the
`newer-than-local` label is simply inaccurate.

**Suggested fix:** only treat a size-difference as a candidate when the remote is
not older (`f.mtimeMs >= local.mtimeMs`); otherwise either skip it or surface it
under an honest `diverged` reason. Deferred — it changes which candidates appear
and warrants its own discussion, so it is documented rather than applied in this
low-risk pass.

---

### F4 — CLI-shelled tools defer all validation to the script, with opaque errors  *(hardening; not implemented)*

`core/src/mcp-server/tools/expanded.ts:1476-1503` (`memory_map`, `memory_record`)

`handleMemoryMap` forwards `level`, `types`, `category`, etc. straight to
`core/scripts/memory-map.js` with no whitelist check. `level` has an enum
(`brief|complete`) in the schema but an out-of-enum value is passed through; the
only feedback is whatever the script prints to stderr, wrapped in a generic
error. Adding an early enum check for `level` (and surfacing the script's stderr)
would give callers a clear message. Low value, deferred.

Note: `if (args.limit)` / `if (args.since)` drop a literal `0`. This is **not** a
bug for `limit` (`memory-map.js:32,184` treats `0` as "all", which is also the
CLI default, so dropping `0` yields identical output); `since: 0` (epoch) is not
a meaningful filter either.

---

### F5 — `getImportCandidates` reads full file bodies with no size cap  *(resource; not implemented)*

`core/src/api/memory-api.ts:879` reads each candidate body via
`fs.readFileSync(f.filePath, 'utf-8')` with no cap, unlike `getByProject`
(detail=`full`) which enforces a 500 KB aggregate cap
(`memory-api.ts:181,306`). A pathologically large memory file would be read
wholesale into the response. Low likelihood for hand-curated memory; documented
for awareness.

---

## 3. Non-issues verified (so they are not re-flagged later)

- **`getFile` "inconsistent projectId".** `getFile` returns
  `projectId: legacyEncodeProjectPath(cwd)` (`memory-api.ts:560`) while sibling
  endpoints return `snapshot.projectId`. These are the **same string** —
  `resolveProject` sets `projectId = legacyEncodeProjectPath(cwd)`
  (`memory-cache.ts:191,203`). Cosmetic only; no behavioral difference.
- **Two dispatch routes for memory tools.** `search_memory` goes via the
  `/mcp/search_memory` shim while the others use the generic `/mcp-call`
  fallback (`mcp-server/index.ts:52-66`). Both transports resolve to the same
  handlers; this is a style inconsistency, not a defect.
- **Field-name parity.** All tool schema fields match their handler argument
  names (`project_id`, `recordId`, `q`, `limit`, …). 100% consistent.
- **`getForSession` returns `null` (not an error) for unknown sessions.** By
  design — `includeMemory` is an optional join (`memory-api.ts:666-668`).

---

## 4. What changed on this branch

| Item | File | Change | Test |
|------|------|--------|------|
| F1 | `core/src/api/memory-api.ts` | per-entry try/catch in `listProjects` | `core/src/__tests__/memory-api-list-projects.test.ts` |
| F2 | `core/src/mcp-server/tools/search-memory.ts` | term-wise ("all terms") matching | `core/src/__tests__/search-memory.test.ts` (new multi-term cases) |

Both are additive/defensive and backward compatible. Tests follow the repo
pattern: `npm run build:test` then `node --test`.
