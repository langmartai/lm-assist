# Mission Foundation: Tags, Relationships & Version History — Design

**Goal:** Extend the Mission data model with multi-dimensional **tags**, a typed **hierarchy** (`parentId`) alongside the existing ordering DAG (`dependsOn`), and **field-level version history** (which field changed, old→new, by whom, when, via which channel), all written through MCP/REST with provenance — so a later graph-query API, the mission controller, and a Mission Dashboard can reason over them.

**Status:** Sub-project **1 of 4** in the mission-enhancement program. Build order: **(1) Foundation [this spec]** → (2) Graph-query API → (3) Controller intelligence → (4) Mission Dashboard. Each ships and is testable independently. #2 needs #1; #3 needs #1–2; #4 needs #2.

**Tech stack:** TypeScript (CommonJS core), LMDB via the generic data service (dataset `missions`, `syncMode:'full'`, leader-anchored), `node:test`, MCP tools proxying REST routes.

---

## Context — what exists today

(From a full read of the current mission subsystem.)

- **`Mission`** (`core/src/mission/mission-model.ts:69-91`): `id, title, objective, plan?, nextSteps?, projects[], dependsOn[], env, binding, progress, interim?, control, results[], adjustments[], createdBy, lastUpdatedBy, status, ownerNode, createdAt, updatedAt`.
- **Relationships today:** only `dependsOn: string[]` (flat list of mission ids), consumed solely by the placement ordering-gate in `place()` (`mission-model.ts:157-163`): a dep is "met" iff it exists and is `status==='done'`. **No** parent/child, ordering, or typed edges.
- **Tags today:** none. Only `projects: string[]` (one-dimensional).
- **Provenance today (reused as-is):** `createdBy` / `lastUpdatedBy: MissionActor` (`mission-model.ts:37-47` — `kind, id?, node?, channel('mcp'|'controller'|'user'|'api'), label?, toolUseId?, at`). MCP calls resolve the actor from the connector `toolUseId` via `resolveMcpActor` (`mission-actor.ts:8-33`); the route extracts the `_actor` hint and strips it before storage (`mission.routes.ts:76-81`).
- **History today (weak):** `adjustments: MissionAdjustment[]` (`{at, trigger, change, by, actor}`) — records who/when/coarse-trigger/free-text, but **never which field changed or old/new values**. API edits always log the generic `change:'mission updated via API'`. `DataRecord.version` is hard-set to `0` for missions; every LMDB `put` overwrites with no snapshot retained. So there is **no field-level history today**.
- **Storage / write choke point:** `mission-store.ts` — `putMission(m)` (`:148-152`) is the single LMDB write for a mission (stamps `updatedAt`, serializes the whole mission into `DataRecord.fields`). `recordToMission` (`:57`) runs `withActorBackfill` for legacy-record back-compat (`mission-model.ts:53-67`).
- **Leader-anchoring:** missions live on the elected leader; non-leader writes proxy to it server-side via `anchorToLeader` (`mission.routes.ts:30-72`, **fail-closed** for writes). All MCP/API writes funnel through `handleCreate`/`handlePatch`.
- **MCP surface:** 12 mission tools (`core/src/mcp-server/tools/mission.ts`); `mission_create`/`mission_update` are the writers; `mission_list` takes no args and returns everything. Scopes in `configure.ts:249-263`; the boot-critical `assertScopesCoverTools()` (`configure.ts:283-288`) throws at startup if any advertised tool lacks a `TOOL_SCOPES` entry.

---

## Scope

**In scope (this spec):** the model additions, the version-history write path, the MCP/REST writers for the new fields, validation, migration/back-compat, and tests. After this ships, missions *carry* the queryable attributes and a complete change history.

**Out of scope (later sub-projects, do not build here):**
- The **graph-query API** (filter missions by tag/attribute, traverse relationships) — sub-project #2. `mission_list` stays unchanged here.
- The **controller** using tags/deps/history to schedule parallel-vs-sequence or to smart-tag — sub-project #3.
- The **Mission Dashboard** web UI and saved views — sub-project #4.

---

## Decisions (resolved with the user)

| Decision | Choice |
|---|---|
| Tag model | **Dimension→values map** — `tags: Record<string, string[]>`, open-ended dimensions (project/feature/component today; add more later with no schema change). |
| Relationship model | **Two structural fields** — keep `dependsOn[]` (ordering DAG) + add `parentId` (single-parent hierarchy/tree). **Parallel is implicit** (siblings with no `dependsOn` between them). No generic/soft edges (YAGNI). |
| Version history | **Per-update grouped diffs** — one entry per write that changes a tracked field, capturing every changed field's old→new, plus a monotonic `rev` and the `MissionActor`. **Retained unbounded** in a separate append-only `mission-history` dataset; the mission record embeds only the most recent **N (default 50, configurable)** for cheap inline access. |

---

## §1 — Data model

Additions to `Mission` (`core/src/mission/mission-model.ts`):

```ts
tags: Record<string, string[]>;   // dimension -> values. default {}
parentId: string | null;          // single-parent hierarchy (tree). default null
rev: number;                       // monotonic; bumps on each tracked-field change. starts at 1
history: MissionChange[];          // the most recent N entries inline (default 50). full trail lives in the `mission-history` dataset
// dependsOn: string[]  — already exists (ordering DAG); now validated on write
```

```ts
export interface MissionChange {
  rev: number;                     // the rev this change produced
  at: number;                      // epoch ms
  actor: MissionActor;             // existing provenance type — who/node/channel/toolUseId
  changes: Record<string, FieldDiff>;  // keyed by field path, e.g. "status", "tags.component", "dependsOn"
}
export interface FieldDiff { from: unknown; to: unknown; }
```

**Tracked fields** (a change to any of these produces a `rev` bump + a `history` entry):
`title, objective, plan, nextSteps, projects, tags, parentId, dependsOn, status, env`.

**Untracked** (high-churn controller telemetry — would flood the log; intentionally excluded):
`binding, progress, interim, control, results, adjustments, ownerNode, lastTickAt, createdAt, updatedAt, rev, history, createdBy, lastUpdatedBy`.

**Field-path keys** in `changes`: top-level fields use their name (`"status"`, `"dependsOn"`); the tags map is diffed **per dimension** and keyed `"tags.<dimension>"` (e.g. `"tags.component"`) so a tag edit names the exact dimension touched. `env` is diffed as a whole object under key `"env"`.

**Value truncation:** string values longer than **500 chars** (e.g. `objective`, `plan`) are stored truncated in `from`/`to` as `"<first 500 chars>…(len N)"` so a single history entry stays bounded. Arrays/objects are stored whole (they are small).

**Retention — unbounded trail + inline recent-N:** the full change history is retained **unbounded** in a separate append-only dataset **`mission-history`** (one record per `MissionChange`, id `${missionId}:${rev}`, fields `{missionId, rev, at, actor, changes}`; same `cache`/LMDB backend, `syncMode:'full'` so it replicates like missions). The mission record embeds only the **most recent N** entries in `Mission.history` (default **N = 50**, configurable via a `missionHistoryInlineCap` project-setting) for cheap inline access and bounded record size — a mission is a single LMDB record under a **1 MiB cap**, so the inline slice must stay bounded; the durable dataset carries the rest. Older entries age out of the inline slice but are **never deleted** from `mission-history`. `syncMode:'full'` is deliberate: the trail must survive controller **failover** (a new leader inherits the full history, not just the old leader's local copy). Growth is bounded in practice — entries are small and 500-char-truncated, so realistic mission-edit volumes stay far under LMDB limits; a global retention cap is a non-goal here and can be added later if ever warranted (the inline cap already bounds the hot read path).

**`newMission()` defaults** (`mission-model.ts:98-139`): `tags: {}`, `parentId: null`, `rev: 1`, and `history` seeded with one entry `{rev:1, at, actor: createdBy, changes:{…initial non-empty tracked fields as {from:null, to:value}}}`.

### Validation (pure, pre-commit)

A write that sets `parentId` or `dependsOn` is validated against the current mission set before it commits:

- **`parentId`**: must reference an existing mission; must not create a cycle (a mission cannot be its own ancestor following `parentId` links); a mission cannot be its own parent.
- **`dependsOn`**: each id must reference an existing mission; no self-dependency; the directed `dependsOn` graph must remain **acyclic** (adding the edges must not introduce a cycle).

Violations reject the write with a structured error: `{ code: 'INVALID_RELATIONSHIP' | 'CYCLE', message }` (surfaced through the existing `fail(code,message)` envelope and the MCP `err()` path). Validation needs the full mission list, which the leader already has in-store.

---

## §2 — Write path & version history (single choke point)

**History is recorded in `putMission` (`mission-store.ts`)** — the single LMDB write for a mission — so that *any* code path that persists a tracked-field change is versioned, not just the REST route. The new `actor` is a **trailing optional param** so existing `putMission(m, port)` callers are unaffected:

```ts
// today:   putMission(m: Mission, port = defaultPort()): Promise<Mission>
// becomes: putMission(m: Mission, port = defaultPort(), actor?: MissionActor): Promise<Mission>
```

Logic:
1. Read the currently-stored record for `m.id` (the pre-image). If none, this is a create.
2. Compute `diffMission(old, next)` over the **tracked-field set** (pure; per-dimension for tags; truncates long strings).
3. If the diff is **non-empty**: `next.rev = (old?.rev ?? 0) + 1`; build `change = {rev, at:Date.now(), actor: actor ?? defaultActor, changes}`; push it onto `next.history` and trim the **inline** slice to the most recent `missionHistoryInlineCap` (default 50); set `next.lastUpdatedBy = change.actor`.
4. If the diff is **empty** (only untracked churn — progress/control/interim/binding): do **not** bump `rev`, do **not** append history, do **not** disturb `lastUpdatedBy`.
5. Persist the mission (existing serialize + `db.put`).
6. If a change was recorded, **best-effort append** `change` as a durable record to the `mission-history` dataset (id `${m.id}:${rev}`). This append is best-effort: a failure does **not** fail the mission write (the entry still lives in the inline slice until it ages out), and it is idempotent on `${id}:${rev}` so a retry can't duplicate.

`defaultActor` (when a direct store call supplies none) = `{ kind:'controller', channel:'controller', node: thisNode(), at }` — i.e. an unattributed internal write is credited to the controller/system, never silently dropped.

**Route integration** (`mission.routes.ts`):
- `handleCreate` builds the mission via `newMission` (seeds `rev:1` + initial history with `createdBy`) and calls `putMission(m, port, who)`.
- `handlePatch` applies the requested tracked-field changes to the loaded mission, then calls `putMission(m, port, who)` — which performs the diff/rev/history. The existing generic `adjustments.push({trigger:'user-edit', …})` and `m.lastUpdatedBy = who` lines are **removed** in favour of the precise `history` entry + the `lastUpdatedBy` set inside `putMission` (the semantic `adjustments[]` log remains for controller annotations like `gate`/`pivot`).
- Existing controller-internal helpers (`mirrorProgress`, `setMissionInterim`, `bindExecutor`, `recordAdjustment`) keep calling `putMission` without an actor; they touch only untracked fields, so they produce **no** history noise.

Because every write funnels through `putMission`, **history + provenance are automatic and uniform** — no caller has to remember to log, and the invariant "any tracked-field change to a persisted mission is versioned" holds across MCP, controller, and API.

---

## §3 — MCP / REST surface

**`mission_create`** (`mission.ts` + `POST /mission`): schema gains
- `tags`: object — dimension → `string[]`
- `parentId`: string

**`mission_update`** (`mission.ts` + `PATCH/POST /mission/:id`): schema gains
- `tags`: object — dimension → `string[]` (**replace** semantics, uniform with all other fields)
- `parentId`: string (set; empty string or `null` clears to `null`)
- (`dependsOn`, `status`, etc. already present)

**New `mission_tag` tool** (scope `write`) — ergonomic per-dimension tag deltas without read-modify-write (tags are the only multi-value field where whole-map replace is painful, and the controller tags incrementally):

```
mission_tag({ id, add?:{dim:[vals]}, remove?:{dim:[vals]}, set?:{dim:[vals]} })
```
- `set` replaces a dimension's values wholesale; `add`/`remove` merge/subtract values; dimensions absent from the call are untouched.
- Server merges into the tags map (pure `mergeTags(current, {add,remove,set})`), then `putMission(port, m, who)` → automatic `rev`/history/provenance.
- Backed by a new leader-anchored route **`POST /mission/:id/tags`** (uses `anchorToLeader`, fail-closed, like other writes).
- **Boot-critical:** add `mission_tag: 'write'` to `TOOL_SCOPES` (`configure.ts`) — omission throws at `assertScopesCoverTools()` and Core won't start.

**Normalization (pure `normalizeTags`):** dimension keys trimmed and lower-cased; values trimmed; empty values dropped; values de-duplicated; a dimension whose value list becomes empty is removed from the map.

**Errors:** `INVALID_RELATIONSHIP`, `CYCLE`, `NOT_FOUND` via the existing `fail()`/`err()` envelopes.

**New `mission_history` tool** (scope `read`) — page the **full unbounded** trail beyond the inline recent-N:

```
mission_history({ id, limit?, beforeRev? })   // newest-first; default limit 50
```
- Backed by a new read route **`GET /mission/:id/history?limit=&beforeRev=`** (leader-anchored read, falls back to the local synced copy). Queries the `mission-history` dataset by `missionId` (and `rev < beforeRev` when paging), sorted `rev` desc.
- Boot-critical `TOOL_SCOPES` entry: `mission_history: 'read'`.
- `GET /mission/:id` still returns the mission with its inline recent-N `history` (no extra query) — `mission_history` is only needed to look further back.

**`mission_list` is unchanged** in this spec (the query surface is sub-project #2).

---

## §4 — Migration / back-compat

No data migration. Extend the existing read-time `withActorBackfill` (`mission-model.ts:53-67`, called by `recordToMission`) to also synthesize, when absent on a legacy record: `tags: {}`, `parentId: null`, `rev: (existing or 1)`, `history: []`. Defaults are synthesized on read and persisted on the next write. `dependsOn` is already present on every record. Nothing breaks; no downtime; mirrors the pattern provenance already uses.

---

## §5 — File structure & testing

**New focused pure modules** (keep `mission-model.ts` from bloating):
- **`core/src/mission/mission-history.ts`** — `TRACKED_FIELDS`, `diffMission(old, next) → Record<string, FieldDiff>` (per-dimension tags, long-string truncation), `appendHistory(mission, actor, inlineCap=50) → {mission, change|null}` (rev bump + inline-slice trim; returns the `change` so the caller can spill it durably), `defaultActor()`.
- **`core/src/mission/mission-graph.ts`** — `validateParent(mission, parentId, all)`, `validateDependsOn(mission, deps, all)` (existence + self + cycle), `mergeTags(current, ops)`, `normalizeTags(map)`.

**Durable history store** (in `mission-store.ts`): `MISSION_HISTORY_DATASET = 'mission-history'` descriptor (`cache`/LMDB, `syncMode:'full'`); `appendMissionHistory(missionId, change, port?)` (best-effort `${missionId}:${rev}` put) and `listMissionHistory(missionId, {limit=50, beforeRev?}, port?)` (newest-first by `rev`, via the data service `query`).

**Wiring:** `mission-store.ts` (`putMission` actor param → diff/`appendHistory`/durable spill; new history dataset + read), `mission-model.ts` (new fields + `newMission` defaults + backfill), `mission.routes.ts` (create/patch integration + `POST /mission/:id/tags` + `GET /mission/:id/history`), `mission.ts` (schemas + `mission_tag` + `mission_history` def/handlers), `configure.ts` (`mission_tag:'write'`, `mission_history:'read'` scopes), project-settings (`missionHistoryInlineCap`, default 50).

**Tests** (`node:test`, the repo's `core && npm run build:test && node --test dist-test/__tests__/<f>.test.js` pattern; TDD):
- **`mission-history.test.ts`** — `diffMission` detects each tracked field, ignores untracked churn, keys tags per-dimension, truncates >500-char strings; `appendHistory` bumps `rev`, trims the inline slice to `inlineCap` (default 50) while returning the `change`, and an empty diff produces no entry/no rev bump.
- **`mission-graph.test.ts`** — parent: missing/self/ancestor-cycle rejected, valid chain accepted; dependsOn: missing/self/cycle rejected, valid DAG accepted; `mergeTags` add/remove/set semantics; `normalizeTags` trims/lowercases dimensions, dedups/drops-empty values.
- **`mission-history-store.test.ts`** (in-memory port) — `appendMissionHistory` writes `${id}:${rev}` and is idempotent on rev; `listMissionHistory` returns newest-first, honours `limit` + `beforeRev` paging; a durable-append failure does not throw out of `putMission`.
- **`mission-foundation-routes.test.ts`** — create stamps `rev:1` + initial inline history + `createdBy` + a durable record; update of a tracked field records a grouped diff + bumps `rev` + sets `lastUpdatedBy`; an update touching only untracked fields adds no history; **the inline slice never exceeds the cap while `mission_history` still returns the older entries**; a cyclic `parentId`/`dependsOn` is rejected with the structured code; `mission_tag` add/remove flows through history; legacy record (no tags/parentId/rev/history) backfills on read.

Implementation via **subagent-driven-development** + TDD, mirroring the prior mission-controller and node-build work.

---

## Open questions

None — the three modeling forks (tags, relationships, history) and the surface (extend create/update + add `mission_tag`) are resolved above.
