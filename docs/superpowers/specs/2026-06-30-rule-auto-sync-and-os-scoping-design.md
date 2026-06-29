# Rule Auto-Sync (cross-node) + per-OS scoping — Design

Status: DESIGN (2026-06-30). Sibling of the record-level **memory** cross-node sync
(`core/src/memory/autosync.ts`, `routes/core/memory-sync.routes.ts`). Builds on the existing
**rule-map** (`core/src/rules/rule-extract.ts`, `routes/core/rule-map.routes.ts`) and mirrors
memory's sync shape, adapting it to Claude Code **RULES**.

## Goal

USER-scope rules (`~/.claude/rules/*.md`) **auto-converge across the fleet, on by default**,
the same way memory does — with an explicit **per-OS dimension** so a platform-specific rule
replicates to every node but only *activates* on a matching platform, and every rule is tagged
with its OS-dependence so it never confuses a node it doesn't apply to.

**In scope:** USER rules only.
**Out of scope:** PROJECT rules (`<repo>/.claude/rules/`) — they keep propagating via **git**
(commit/push/pull), unchanged. A project rule's presence is deliberately tied to the repo's
presence; auto-pushing it to nodes without the repo would have no coherent home and would fire
in sessions not in that project. USER rules have no repo to ride on, which is why they need a daemon.

## Decisions (locked with the user)

1. **Off-OS behavior:** sync the rule to **all** nodes, but tag each rule with whether it's
   OS-dependent (and for which OS); on a non-matching OS the rule is **inert** (present + visible
   in the map, never injected into a session).
2. **Auto-sync default:** **on by default fleet-wide** (with a master off-switch).
3. **OS tag source:** **explicit `os:` frontmatter only** — no content auto-detection. Absent `os:`
   ⇒ all platforms (current always-on behavior).

## Key architectural constraint — injection is native, so OS-filter at placement time

`~/.claude/rules/**.md` is injected into a session **natively by Claude Code**, NOT by lm-assist
(verified repo-wide: no lm-assist code reads `.claude/rules` for injection; the context-inject
hook does not touch rules; rule-map only *indexes* them). lm-assist therefore cannot filter rules
by OS at injection time.

**Consequence:** OS-applicability is decided at **placement time** — *which directory* a synced
rule lands in:

| Synced rule applies to this node's OS? | Lands in | Native CC injects it? |
|---|---|---|
| yes (or `os:` absent) | `~/.claude/rules/synced.<sourceHost>.<name>.md` (flat, top-level) | yes → **active** |
| no (wrong OS) | `~/.lm-assist/rules-mirror/<sourceHost>/<name>.md` (outside the rules dir) | no → **inert**, map-indexed only |

Every node still **receives every USER rule** (= "sync all"); wrong-OS rules simply land where
native injection can't see them. Flat top-level naming in the active dir means it works whether or
not native loading is recursive.

## Memory parity (what we mirror, what we intentionally simplify)

The rule sync mirrors memory's cross-node architecture module-for-module, reusing the same patterns
(and, where possible, the same helpers). Where rules are inherently simpler than memory, we drop a
piece rather than carry dead weight:

| memory module | rule parallel | notes |
|---|---|---|
| `memory/autosync.ts` | **`rules/autosync.ts`** | daemon: watch → reconcile (pull) → apply. Same shape, on by default. |
| `memory/ingest.ts` | **`rules/rule-sync.ts`** | confined, host-namespaced writes. |
| `memory/mcp-transport.ts` | **reuse** | direct-MCP pull through the hub `/machines/<id>/proxy` (key-in-body, since the proxy drops `x-lm-access-key`). |
| `memory/node-mode.ts` | **reuse** | mode (persistent-home vs ephemeral-cloud) surfaced in `rule_sync_status`. |
| `memory/sync-select.ts` | **reuse pattern** | shareability + credential-filename guard on export. |
| `memory/record-extract.ts` | `rules/rule-extract.ts` (exists) | + the `os:` dimension. |
| `memory/merge-ingest.ts`, `merge3.ts`, `llm-merge.ts` | **not needed** | rules are **host-namespaced** (`synced.<host>.*`), so two peers never write the same file → no 3-way / convergent merge. This is memory's **per-host-mirror** mode (not its convergent-merge mode), just placed in the active dir. |
| `memory/harvest-daemon.ts` | **N/A** | rules are user-written, not harvested from sessions. |
| `memory/cross-project-signpost.ts`, `project-remote.ts`, `peer-resolve.ts` | **N/A / trivial** | USER rules are machine-wide, not project-git-scoped → no project/remote resolution; peers = all fleet nodes. |

So "just like memory" = the **per-host-mirror** model (host-namespaced, pull-based reconcile, on by
default), with the mirror placed where native injection makes OS-matching rules active. Host-namespacing
removes the write conflict, so the convergent-merge stack is intentionally omitted.

## Design

### 1. The `os:` frontmatter dimension

- New optional frontmatter key `os:` — a YAML list (or scalar). Parsed from the raw frontmatter
  block in `rule-extract.ts`, the same way `paths:` already is (`parseFrontmatter` keeps only the
  known memory keys, so `os` is pulled from the raw block exactly like `paths`).
- Friendly → canonical normalization (canonical = Node `os.platform()` values):
  `windows|win|win32 → win32`, `mac|macos|osx|darwin → darwin`, `linux → linux`. Unknown tokens are
  kept verbatim (forward-compatible) and counted in the map.
- Absent/empty `os:` ⇒ `[]` ⇒ applies to ALL platforms (always-on; unchanged from today).
- `RuleRecord` gains:
  - `os: string[]` — canonical platform list (`[]` = all).
  - `osDependent: boolean` — `os.length > 0`. **This is the per-rule "OS-dependent or not" tag.**
  - `active: boolean` — computed against the **serving node's** platform:
    `os.length === 0 || os.includes(platform)`.

### 2. Placement-time activation (the OS router)

On ingest, node B computes, for each incoming rule R from node A:
`appliesToB = R.os.length === 0 || R.os.includes(Bplatform)` where `Bplatform = os.platform()`.

- `appliesToB` → write `~/.claude/rules/synced.<A>.<basename>` (active).
- `!appliesToB` → write `~/.lm-assist/rules-mirror/<A>/<basename>` (inert).

**Synced files are byte-identical to the origin** (the original frontmatter + body, unmodified).
Rationale: the rule-map dedups across nodes by `contentHash = sha256(complete)`; mutating the copy
(e.g. injecting a provenance banner) would break cross-node dedup and make one rule look like N
different rules. Provenance is carried **out-of-band**: the `synced.<host>.` filename prefix + the
map's existing `source` field (`live` for local, `repo:<host>` for synced). A `README` is written
once into `~/.lm-assist/rules-mirror/` and alongside the synced files' provenance is documented; the
filename prefix is the human signal ("don't hand-edit `synced.*`; edit it on its source host").

A node's **own export excludes `synced.*` files** (and the mirror dir), so synced rules never
re-propagate → no echo loops. Each node is the sole authority for its own rules.

### 3. Auto-sync daemon — `core/src/rules/autosync.ts` (mirrors `memory/autosync.ts`)

- Starts with Core when `ruleSyncEnabled !== false` (**default ON**).
- Watches `~/.claude/rules/*.md` (own rules; chokidar **v3**, excludes `synced.*`).
- **Pull-based reconcile** (the proven path — memory's `dataset_updated` push is dead): a timer
  (default 5 min) + a trigger on local change + an on-demand run. For each **online fleet node**
  (unfiltered / fleet-wide, like memory — NOT cluster-scoped), pull its `/rules/export` and apply
  locally through the OS router.
- **Removal propagation (tombstone-free):** `/rules/export` returns A's *complete current* own-rule
  set. On reconcile from A, B upserts the present ones and **deletes any `synced.A.*` / `rules-mirror/A/*`
  not in A's current set**. So deleting a rule on A removes it everywhere on the next cycle.

### 4. Routes — `core/src/routes/core/rule-sync.routes.ts`

Auth + transport follow memory's export/ingest exactly (cross-node rides the hub
`/machines/<id>/proxy`, which **drops `x-lm-access-key`**, so the key travels **in the body** like
memory/data):

- `POST /rules/export` → `{ host, platform, rules: [{ file, content, contentHash, os[], osDependent }] }`
  — this node's own USER rules (credential-shaped filenames excluded; see §6).
- `POST /rules/ingest` `{ sourceHost, sourcePlatform, rules[] }` → routes each rule via the OS router;
  returns `{ applied, active, inert, removed }`. Writes are **path-confined** (basename-sanitized;
  only ever under `~/.claude/rules/synced.<host>.*` and `~/.lm-assist/rules-mirror/<host>/`).
- `GET /rules/sync/status` → config + last reconcile + per-peer counts.
- `GET /rules/autosync/status` → daemon mode + recent decision log (mirrors `/memory/autosync/status`).
- Add `'/rules'` to the `hub-client/api-relay-handler.ts` allow-list so the routes are reachable
  cross-node.

### 5. rule-map + MCP surface (parity with memory)

`rule-extract.ts` gains `os`/`osDependent`/`active` (§1); the map CLI behind `/rules/map` scans
**both** `~/.claude/rules/**` (active, incl. `synced.*`) and `~/.lm-assist/rules-mirror/**` (inert),
tagging `active` + `source` (`live` vs `repo:<host>`), and adds filter flags `--os <plat>`,
`--os-dependent`, `--active` (mirroring existing `--scope`/`--paths`/`--always`).

Rules get the **same MCP surface as memory** — all read-only (like memory, rule authoring stays
file-based; the daemon does the syncing):

| memory MCP tool | rule MCP tool | status |
|---|---|---|
| `memory_map` | `rule_map` | **exists** — gains os/active filters + fields |
| `memory_record` | **`rule_record`** | new — fetch one rule's full text by recordId (`GET /rules/rule/:id`) |
| `memory_sync_status` | **`rule_sync_status`** | new — node mode + rule-autosync daemon status (`/rules/sync/status` + `/rules/autosync/status`) |
| `memory_cross_host` | **`rule_cross_host`** | new — rules across ALL hosts ranked by query, with `active`/`presentLocally` flags |
| `memory_import_candidates` | **`rule_import_candidates`** | new — rules on other hosts newer/absent locally (preview; auto-sync usually already applied them) |
| `memory_projects` | **`rule_projects`** | new — scopes/hosts that have rule dirs |

All six are **`read`** scope — each needs a `TOOL_SCOPES` entry in `configure.ts` (a missing entry
crashes Core on the next `/mcp` call) and lives in `EXPANDED_TOOL_DEFS` + `EXPANDED_HANDLERS`
(`expanded.ts`) only — no explicit dispatch `case`. The cross_host / import_candidates / projects
tools are **thin views over the rule-map records already built**, so the only new infrastructure is
the sync daemon + routes (§3–§4); these tools are cheap derivations.

**No MCP write tool** — same as memory. Rules are authored as files; the daemon syncs them. (A remote
`rule_put` would exceed memory parity and is out of scope here.)

### 6. Settings & safety

- `ruleSyncEnabled` (project-settings, **default true**) — master off switch. False ⇒ daemon doesn't
  start; export/ingest return `disabled`.
- Ingest writes **confined** to the two managed locations; basename sanitization (reject `/`, `\`,
  `..`, absolute paths); per-rule size cap (64 KB); credential-shaped filename guard (reuse memory's
  export guard / regex).
- **Never overwrite a hand-authored local rule** — B only ever writes `synced.<A>.*` / mirror files;
  a basename collision coexists (`panic-mode.md` next to `synced.117.panic-mode.md`), never clobbers.
- Fleet-wide scope (like memory), explicitly NOT cluster-scoped.

### 7. Testing

- **Unit:** `os:` parse + normalize (friendly + raw + unknown); `active`/`osDependent` per platform;
  OS-router placement (active vs mirror) for win32/darwin/linux; export excludes `synced.*` +
  credential names; ingest path-confinement + collision coexistence; removal reconcile (set-diff).
- **Integration:** loopback two-node — author a rule on A → reconcile on B yields an active
  `synced.A.*` (matching/empty OS) or an inert `rules-mirror/A/*` (wrong OS); delete on A → removed
  on B next cycle.

### 8. Rollout

Core-only change (TS → `core/dist`, cross-platform JS) → deploy by syncing `core/dist` to the fleet
(117/123/107) + restart; the daemon comes up **on** by default. Ideal live OS-routing test is the
mixed fleet: a `os: windows` rule authored on **107** → active on 107, inert mirror on **117/123**;
a `os: linux` rule on 117 → active on 117/123, inert on 107. Verify cross-node convergence,
OS routing, and removal propagation end-to-end through the langmart connector.

## File structure (new + modified)

- **New** `core/src/rules/autosync.ts` — the reconcile daemon (sibling of `memory/autosync.ts`).
- **New** `core/src/rules/rule-sync.ts` — export/ingest core (read own rules, OS-route, path-confined writes, set-diff removal).
- **New** `core/src/routes/core/rule-sync.routes.ts` — the 4 routes above.
- **Modify** `core/src/rules/rule-extract.ts` — `os:` parsing + `os`/`osDependent`/`active` on `RuleRecord`.
- **Modify** the rule-map CLI script — scan the mirror dir; `--os`/`--os-dependent`/`--active`; emit new fields.
- **Modify** `core/src/routes/core/index.ts` — register `createRuleSyncRoutes`.
- **Modify** `core/src/hub-client/api-relay-handler.ts` — add `'/rules'` to the relay allow-list.
- **Modify** project-settings — `ruleSyncEnabled` (default true).
- **Modify** `core/src/mcp-server/tools/expanded.ts` — `rule_map` description (os/active) + **5 new tool defs + handlers** (`rule_record`, `rule_sync_status`, `rule_cross_host`, `rule_import_candidates`, `rule_projects`) in `EXPANDED_TOOL_DEFS` + `EXPANDED_HANDLERS`.
- **Modify** `core/src/mcp-server/configure.ts` — `TOOL_SCOPES` entries (`read`) for the 5 new tools (missing entry → Core crash on next `/mcp`).
- **Reuse** `core/src/memory/{mcp-transport,node-mode,sync-select}.ts` patterns/helpers for transport, mode reporting, and the credential/shareability export guard.
