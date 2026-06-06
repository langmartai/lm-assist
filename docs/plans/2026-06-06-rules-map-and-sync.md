# Record-level, project/node-aware Rules Map + Sync

Status: DESIGN (2026-06-06). Sibling of the record-level MEMORY map (`docs/plans/2026-06-06-record-level-memory-map-and-sync.md`). Builds on the same infrastructure — the `/memory/projects` enumeration (`core/src/api/memory-api.ts`), the frontmatter parser (`core/src/utils/frontmatter.ts`), and the deterministic-CLI-behind-an-HTTP-route pattern. It mirrors the memory map's shape one-for-one and adapts it to the specifics of Claude Code **RULES**.

## Goal

A unified, project- AND node-aware **rules** layer that works at the **record** level (one rule file = one record), gives a **two-level brief/complete (selectively partial) map** for quick reference across every project and node, and **detects → registers → reconciles** rule records. The deliverable is the cross-project/node map, the **path-scope index**, the **user-vs-project conflict detector**, and cross-node sync.

## What RULES are (and how they differ from memory)

Rules are the user-written `.claude/rules/*.md` instruction files — modular, topic/path-specific instructions, like CLAUDE.md but split per topic. Distinct from CLAUDE.md and from auto-memory.

| Dimension | Memory | Rules |
|---|---|---|
| Author | Claude (auto-saved during sessions) | **The USER** (hand-written, like CLAUDE.md) |
| Location | `~/.claude/projects/<slug>/memory/*.md` + repo mirrors | `<projectRoot>/.claude/rules/**.md` (PROJECT, committed, recursive subdirs) + `~/.claude/rules/**.md` (USER, every project on the machine) |
| Loading | Loaded by relevance / cross-host import | USER rules load **before** PROJECT rules → **project rules win on conflict** |
| Scoping | always in context for the project | **path-scoping** (key feature, below) |
| Harvested from sessions | yes (the harvester tier) | **no** — rules are user-written, not auto-harvested |

### Path-scoping (the key rules-specific feature)

A rule's YAML frontmatter may carry a `paths:` glob list:

```
---
paths:
  - "src/api/**/*.ts"
---
# API rules ...
```

- A rule **without** `paths` loads unconditionally every session (same priority as CLAUDE.md) → `loadCondition = 'always'`.
- A rule **with** `paths` only enters context when Claude touches a file matching one of the globs → `loadCondition = 'path-scoped'`.

`/memory` in a session shows which rules are currently loaded.

## 1. The Record model (the atomic unit)

Mirrors `MemoryRecord`, adds the rules-specific dimensions. Each rule file → exactly ONE `RuleRecord`.

```
RuleRecord {
  recordId    : string   // "<node>:<scope>:<project>:<relpath>"
  contentHash : string   // sha256(complete) — change detection + cross-node dedup
  node        : string   // host/node id (linux-117, windows-desk, ...)
  project     : string   // project slug; USER rules use the synthetic "(user)" project
  source      : "live" | "repo:<host>"
  file        : string   // relpath under .claude/rules (may include subdirs)
  title       : string   // frontmatter.name | filename
  brief       : string   // frontmatter.description | first prose line   (BRIEF level)
  complete    : string   // full body                                    (COMPLETE level)
  category    : string   // reuses the memory categorizer (architecture/endpoint/lesson/config/...)
  // ---- rules-specific ----
  scope         : "user" | "project"          // user = machine-wide; project = committed
  paths         : string[]                     // the globs; [] = always-on
  loadCondition : "always" | "path-scoped"     // derived from paths.length
  priority      : number                       // 10 user (loads first) < 20 project (wins on conflict)
  originSessionId?, recordedAtMs, lastValidatedMs, validity, mtimeMs, size
}
```

### Extraction rules
- One rule file → one record (rules are one-topic, like the "one file = one fact" memory convention).
- `title = frontmatter.name || filename`; `brief = frontmatter.description || first prose line`; `complete = body`.
- `scope` is set by where the file lives: `~/.claude/rules` → `user`; `<projectRoot>/.claude/rules` → `project`.
- `paths` is parsed from the raw frontmatter block. **Important:** the shared `parseFrontmatter()` only keeps the known memory keys (name/description/type/originSessionId) and collapses everything else into `extra` as a scalar string, so a multi-line `paths:` list is dropped there. `rule-extract.ts` therefore parses `paths:` itself (`parsePaths()`) — supporting the block list, an inline flow list (`paths: ["a","b"]`), and a single scalar.
- `category` reuses `categorize()` imported from `core/src/memory/record-extract.ts` (the same rule-based categorizer — no duplication).
- `recordId` scheme mirrors memory but inserts `scope`: `"<node>:<scope>:<project>:<relpath>"`.

## 2. Two-level reference map (the deliverable)

Identical shape to the memory map:
- **BRIEF**: `{recordId, node, project, scope, file, title, brief, category, loadCondition, paths}` per record — compact scan.
- **COMPLETE**: full records incl. `complete` bodies.
- **PARTIAL / selective**: filter by `projects[]`, `nodes[]`, `category[]`, `scope`, `paths` (glob substring), `always` (loadCondition), `q` (relevance), applied at either level.

## 3. Unified API

Shells out to `core/scripts/rule-map.js` (one deterministic engine shared by HTTP + CLI), mirroring `memory-map.routes.ts` exactly (including the dev/prod port detection `__dirname.includes('node_modules') ? '3100' : '3200'`).

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/rules/map?level=brief\|complete&projects=&nodes=&category=&scope=&paths=&always=&q=&limit=` | The cross-project/node rule map, filtered |
| GET | `/rules/map/stats` | Counts per project / node / scope / loadCondition / category |
| GET | `/rules/rule/:id` | One complete rule record |

Registered in `core/src/routes/core/index.ts` next to `createMemoryMapRoutes`.

## 4. CLI surface

`node core/scripts/rule-map.js` (mirror of `memory-map.js`):
- `--level brief|complete` (default brief)
- `--projects a,b` `--nodes linux-117,windows-desk` `--category lesson,config`
- `--scope user|project` `--paths <glob-substr>` `--always` (loadCondition === 'always')
- `--q <query>` `--limit N`
- `--record <recordId>` (one complete record) | `--stats` (overview incl. **byScope**, **byLoadCondition**)
- `--snapshot` (write `~/.lm-assist/rule-map.json`) | `--changes [--commit]` (record-level deltas vs snapshot → `~/.lm-assist/rule-changes.jsonl`) | `--duplicates` (reconcile candidates)
- `--format json|md` `--port 3100`

It enumerates projects the same way as `memory-map.js` — fetching `/memory/projects` from the running server for project paths — then scans each project's `<projectRoot>/.claude/rules/**` (PROJECT scope, recursive) and the machine-wide `~/.claude/rules/**` (USER scope). It also walks any `memory/<host>/.claude/rules` repo mirrors for cross-node project rules. Uses `String.fromCharCode(10)` in `appendFileSync` to avoid escaping issues.

## 5. Module layout

1. `core/src/rules/rule-extract.ts` — file → `RuleRecord` (`extractRule`, `parsePaths`). Reuses `parseFrontmatter` + `categorize`.
2. `core/scripts/rule-map.js` — the deterministic CLI (brief/complete, filters, stats, record, snapshot, changes, duplicates).
3. `core/src/routes/core/rule-map.routes.ts` — the §3 endpoints; registered in `routes/core/index.ts`.

## 6. The two-stream architecture (the applicable parts)

Rules are **user-written, not auto-harvested**, so the memory "harvester" tier (session → candidate memory) does NOT apply. The value of the rules map is the cross-project/node index, the path-scope index, conflict detection, and cross-node sync. The two-stream framing still applies to the parts that do:

### Stream A — Detect / register / sync (write side)
`watch .claude/rules → detect record-level delta (by contentHash, via --snapshot/--changes) → register (map + rule-changes.jsonl) → categorize → sync project rules across nodes`.
- Detection/registration are deterministic (the `--snapshot`/`--changes` pair, exactly like memory's `memory-changes.jsonl`).
- **Sync transport differs by scope:**
  - PROJECT rules live under `<projectRoot>/.claude/rules/` and are **committed to the repo** — they propagate across nodes through normal git (same on every node), and are only *indexed* into the map for cross-node reference (like CLAUDE.md in the memory design). The map walks `memory/<host>/.claude/rules` mirrors when present.
  - USER rules are machine-local (`~/.claude/rules`) and host-tailored; cross-node sharing is opt-in, mirrored the same way the per-host memory folders are.

### Stream B — Front query (read side)
`front "what rules apply to src/api?" (NL + context) → agent orchestrator → runs rule-map.js to pull the RELATED rule records (scope + path-scope + category filters) → decides brief vs complete per record → returns the actual assembled slice (verbatim script output, never fabricated)`.
The path-scope filter (`--paths src/api`) answers "which rules would Claude load when touching this file?" directly.

### Reconcile / conflict (the rules-specific reconciliation)
`--duplicates` computes candidate sets deterministically; an agent (orchestrator, never fabricating) decides and applies:
1. **Exact duplicates** — records with identical `contentHash` across nodes/scopes.
2. **Divergent mirrors** — the same project rule file present in multiple node mirrors with diverging `contentHash`.
3. **User-vs-project conflicts** — the headline rules case: the same rule **title** present at BOTH `user` and `project` scope. Because USER rules load before PROJECT rules, the project-scoped one **wins on conflict** — the script flags this with `winsOnConflict: true` on the project record so the operator sees which instruction actually takes effect. (This is the rules analogue of memory's dedup/merge tier; nothing is auto-deleted.)

## 7. Why this shape

Same rationale as the memory map: record-level + two-level/partial map = quick inference without loading whole files; one deterministic CLI behind the HTTP route avoids duplicated scan logic; everything rides infrastructure that already exists (`/memory/projects` enumeration, frontmatter parser, shared categorizer). The rules-specific additions — **scope (user/project + priority), path-scoping (loadCondition + the paths index), and the user-vs-project conflict detector** — are exactly the dimensions that make rules different from memory, and they are first-class filters in both the CLI and the API.
