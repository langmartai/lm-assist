# Mission Controller Intelligence — Design

**Goal:** Make the elected Mission Controller use the new mission data from sub-projects 1+2 (`tags`, `parentId`, `dependsOn`, version `history`) to schedule parallel-vs-sequence, manage epics, smart-tag its own decisions, and react to external changes — via a **hybrid** of a deterministic scheduler module (code) and an expanded LLM controller prompt.

**Status:** Sub-project **3 of 4** of the mission-enhancement program. #1 (foundation: tags/parentId/dependsOn/history) and #2 (graph-query API + views) and #4 (dashboard web) are merged to main (local). #3 needs #1+#2. After #3: ONE fleet deploy of the whole program (1+2+3+4).

**Tech stack:** TypeScript (core, CommonJS); the existing mission subsystem (`core/src/mission/`), MCP tools (`core/src/mcp-server/`), and the controller-as-session prompt. Pure modules are TDD'd (vitest/node test runner, matching the existing mission tests).

---

## Decisions (resolved with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Where the intelligence lives | **Hybrid** — deterministic code rails for hard constraints (dependency/resource/parent/serialize), LLM agent for judgment (smart-tagging, parallel-vs-sequence on soft cases, history reaction). |
| 2 | parentId scheduling semantics | **Epic/container rollup** — a parent with ≥1 child is a non-executed container; the controller schedules its children (parallel unless `dependsOn` between them), never spawns an executor for a container, and rolls the parent's status/progress up from its children. |
| 3 | Smart-tagging | **Controller owns operational tags** under a reserved `ctl:` dimension namespace (writes them, version-tracked + attributed); **reads** author dimensions (project/feature/component) as scheduling input; never writes author dims. |
| 4 | History-awareness | **React to external changes** — each pass, find changes by non-controller actors since the last pass and re-evaluate those missions first (adapt, never blindly override). |
| 5 | Structure | **Scheduler module + thin read tools, LLM consumes** — a pure `mission-scheduler.ts` computes the deterministic plan; new read tools expose it; the controller prompt is expanded to consume it and apply judgment. |

---

## Context — what exists (verified)

- **`place(m, all)`** (`core/src/mission/mission-model.ts:179-207`) is pure code and ALREADY gates execution: blocks a mission until every `dependsOn` id is `status==='done'` (reason `'dependency'`), and checks same-host resource conflicts (`env.host`/`env.resources`/`env.exclusive`, reason — returns `{go:false}`). It does **not** read `tags`, `parentId`, or `history`. The scheduler reuses it as-is.
- **Controller = two layers.** Layer 1 (pure-code supervisor, `mission-controller.ts` `runSupervisorTick`, 1-min tick) handles election + controller-session lifecycle + engagement detection + `decideSupervisor → teardown|launch|idle|drive`. Layer 2 (the LLM controller, a `claude --remote-control` session) reasons via MCP tools when the supervisor sends `CONTROLLER_PASS_DIRECTIVE`. The LLM is currently **never told** about tags/parentId/history. `CONTROLLER_SYSTEM_PROMPT` (~line 340) + `CONTROLLER_PASS_DIRECTIVE` (~line 325) are the plug-in points.
- **Writes are auto-versioned.** Every mission write goes through `putMission` (`mission-store.ts:212`) → `appendHistory` (`mission-history.ts:47`), which diffs tracked fields (`title,objective,plan,nextSteps,projects,tags,parentId,dependsOn,status,env`), bumps `rev`, appends a `MissionChange{rev,at,actor,changes}` inline (cap 50) and spills older to the `mission-history` dataset. So the controller writing `tags`/`status` is version-tracked + attributed for free. No-op writes (empty diff) are skipped — re-writing an unchanged tag produces no history.
- **Actor attribution.** `MissionActor = { kind, channel, node, toolUseId?, id?, at }` (`mission-model.ts:47`). The controller's own writes are `channel:'controller'` (`mission-controller.ts:43-44`, `mission-history.ts:39` `defaultActor`). MCP writes from a human default to `kind:'user', channel:'mcp'` via `actorFor`/`resolveMcpActor` (`mission.routes.ts:82`, `mission-actor.ts:14`). **External-change discriminator = `actor.channel !== 'controller'`.**
- **Sub-2 engines available but unused by the controller:** `mission-filter.ts` (`filterMissions`, tag-dimension-aware), `mission-traverse.ts` (`neighbors`/`subgraphEdges`), `mission-graph.ts` (`normalizeTags`/`mergeTags`). Read tools `mission_query`/`mission_neighbors`/`mission_graph`/`mission_history` exist.

---

## §1 — Deterministic scheduler (`core/src/mission/mission-scheduler.ts`, pure, TDD)

A new pure module. No I/O, no LLM. Reuses `place()` and direct field access.

```ts
export type BlockReason = 'dependency' | 'parent' | 'resource' | 'serialize';
export interface Schedule {
  ready: string[];                                                  // mission ids that can start now
  blocked: { id: string; reason: BlockReason; waitOn?: string[] }[];
  serializeGroups: { group: string; missionIds: string[]; running: string | null }[];
  epicRollups: { parentId: string; status: MissionStatus; progressPercent: number; childCount: number; doneCount: number }[];
  containers: string[];                                             // parent ids that have ≥1 child (pure epics → never executed)
}
export function computeSchedule(missions: Mission[]): Schedule;
```

Logic:
- **Containers / epics:** `containers` = every mission id that is some other mission's `parentId`. A container is never `ready` (the controller schedules its children, not the container itself).
- **Epic rollup:** for each container, derive `status` from its direct children: all children `done` → `done`; else any child `active` → `active`; else any child `blocked` → `blocked`; else `waiting`. `progressPercent = round(100 * doneCount / childCount)`. (Rollup is *computed* here; the controller *applies* it via `mission_update` — §5 — so it stays version-tracked. The scheduler itself never writes.)
- **Serialize groups:** missions sharing a `ctl:serialize-group` tag VALUE form a group (`group` = the value). Within a group at most one runs at a time: `running` = the id of a group member that is currently `active`/running (else `null`); all other non-terminal members are `blocked` with reason `'serialize'`.
- **Readiness:** a mission is `ready` iff `place(m, all).go === true` AND it is not a container AND it is not serialize-blocked. Otherwise it is in `blocked` with the appropriate reason (`dependency`/`resource` from `place`; `serialize` from the group; `parent` reserved — see note). Terminal missions (`done`/`failed`) and pure containers are excluded from both `ready` and `blocked`.
- **`parent` reason:** with the epic-rollup model, `parentId` does NOT gate a child's execution (children run on their own `dependsOn`). The `parent` `BlockReason` is reserved for the case where a child references a parent that does not exist (mirrors `place`'s missing-dependency handling) — a data-integrity block, not a scheduling gate.

Deterministic and fully unit-testable: readiness, container detection, epic rollup (each status-precedence case), serialize grouping (running vs blocked), and the missing-parent edge.

## §2 — Recent external-change detection (pure helper)

```ts
export interface ExternalChange { missionId: string; rev: number; at: number; actor: MissionActor; changedFields: string[]; }
export function recentExternalChanges(
  missions: Mission[],
  opts: { sinceRev?: Record<string, number>; sinceTs?: number; excludeChannel?: string },  // excludeChannel default 'controller'
): ExternalChange[];
```

- Reads each mission's inline `history[]` (the recent-N already on the record; the unbounded tail in the `mission-history` dataset is not needed for "since last pass" because passes are frequent relative to the inline cap of 50).
- Returns changes whose `actor.channel !== excludeChannel` (default `'controller'`) and that are newer than the per-mission `sinceRev[missionId]` (or `sinceTs`). `changedFields` = the keys of the `MissionChange.changes` map.
- Pure; tested for: actor-channel filtering, `sinceRev` boundary, multiple changes per mission, and empty history.

## §3 — Two new read MCP tools + routes

New file `core/src/mcp-server/tools/mission-schedule.ts` (kept out of `mission.ts`/`mission-query.ts`):

| Tool | Scope | Returns |
|------|-------|---------|
| `mission_schedule` | `read` | `computeSchedule(all)` — the deterministic plan (ready/blocked/serializeGroups/epicRollups/containers). |
| `mission_changes` | `read` | `recentExternalChanges(all, {sinceRev?})` — external (non-controller) edits since the given per-mission revs (or all inline if omitted). |

- Both are leader-anchored reads (`anchorToLeader(..., failClosed=false)` — fall back to the local synced copy), matching `mission_query`/`mission_graph`.
- Both added to `TOOL_SCOPES` in `configure.ts` (boot-critical — `assertScopesCoverTools` throws on a missing scope).
- Registered in `expanded.ts`. Backed by new POST routes in `mission.routes.ts` (`POST /mission/schedule`, `POST /mission/changes`) using the shared list-anchoring helper; literal single-segment routes registered before every `/mission/:id` pattern (the established ordering gotcha). MCP numeric args (`sinceRev` values, if any) coerced from strings (connector delivers numbers as strings).

## §4 — Controller-owned `ctl:` operational tags

The controller WRITES only the reserved `ctl:` dimension namespace, via the existing `mission_tag` tool (so writes are auto-versioned + attributed):

| Dimension | Values | Meaning |
|-----------|--------|---------|
| `ctl:readiness` | `ready` / `blocked` / `running` / `done` | the controller's current view of the mission (for dashboard/history visibility) |
| `ctl:serialize-group` | `<group-name>` | the controller's decision to serialize a set of missions (read back by §1's scheduler) |
| `ctl:phase` | `<phase/wave label>` | optional grouping of a batch the controller scheduled together |

- **Author dimensions (project/feature/component) are never written by the controller** — only read as scheduling input. The `ctl:` prefix is documented as controller-reserved; a small guard/constant records the reserved prefix.
- The scheduler (§1) reads `ctl:serialize-group`. The other `ctl:` tags are informational (surface in the sub-4 dashboard + history at no extra cost).

### §4a — Controller write attribution (REQUIRED — the plan must nail this)

For §2 (`recentExternalChanges`) to reliably exclude the controller's own writes, the controller's `mission_tag`/`mission_update` MCP calls MUST be attributed with `actor.channel === 'controller'` (not the default `channel:'mcp'`/`kind:'user'` that a human MCP edit gets). The supervisor already holds the elected controller's session identity (`controllerState.binding.sessionId` / the ccr `sid`, used at `mission-controller.ts:43-44`).

**Required mechanism (preferred):** the MCP write path stamps `channel:'controller'` when the calling session **is** the elected controller session — resolved via the same session→actor path (`resolveMcpActor`/`actorFor` + the controller session id the supervisor knows), NOT by trusting the LLM to self-declare. The plan verifies the resolver has access to (or can be given) the controller session id and that `mission_tag`/`mission_update` writes from the controller session land as `channel:'controller'`. (Fallback, only if the resolver cannot see the controller session: the controller agent passes an `_actor:{channel:'controller'}` hint on its write calls, accepted by `actorFor` — but this depends on the LLM and is less robust, so it is the fallback, not the primary.)

## §5 — Expanded controller prompting (the LLM judgment)

`CONTROLLER_SYSTEM_PROMPT` + `CONTROLLER_PASS_DIRECTIVE` (`mission-controller.ts`) gain a "Scheduling intelligence" section. Each pass, the agent:

1. Calls `mission_schedule` → the deterministic plan. **Hard constraints (dependency/resource/serialize/epic-rollup) are always taken from this tool, never re-derived by the LLM.**
2. Calls `mission_changes` → external edits since its last pass; **re-evaluates those missions first** and adapts (a human re-scoped/re-tagged → the controller adjusts its plan; it never blindly overrides a human change).
3. For `ready` missions → spawn/advance executors (the existing flow).
4. For `containers` (epics) → does NOT execute; ensures the children are scheduled; applies the `epicRollups` status/progress via `mission_update` when it differs from the stored value.
5. For **soft** cases the code did not hard-constrain (e.g. two `ready` missions that touch the same area but have no explicit `dependsOn`) → uses `mission_neighbors`/`mission_graph` (sub-2) to understand structure and decides parallel-vs-sequence; if it serializes them, it tags them `ctl:serialize-group:<g>` so the **deterministic** scheduler enforces it on the next pass.
6. Records its decisions as `ctl:*` tags (`ctl:readiness`, optional `ctl:phase`) so the dashboard + history show what the controller decided.

The `guide("mission-controller")` topic (`guide.ts`) gains the same scheduling-intelligence summary so a controller session bootstrapping via the guide learns it.

## §6 — What does NOT change

- `place()` stays the dependency/resource gate (the scheduler reuses it; no change).
- `putMission`→`appendHistory` already versions every write — no change.
- The supervisor tick / election / engagement (Layer 1) is unchanged except the drive directive may surface the schedule.
- **No dashboard change** — sub-4 already renders all tag dimensions (incl. `ctl:*`) + history, so the controller's operational tags and decisions appear there for free.
- No change to the existing `mission_tag`/`mission_update`/`mission_history` tools beyond the §4a attribution wiring.

## §7 — Testing

- **TDD the pure modules:** `mission-scheduler.ts` (`computeSchedule`: readiness, container detection, each epic-rollup status-precedence case, serialize running-vs-blocked, missing-parent edge) and `recentExternalChanges` (channel filter, `sinceRev` boundary, multi-change, empty history).
- **The 2 new tools/routes:** scope coverage (the `assertScopesCoverTools` enumeration test must include both), handler behavior (leader-anchoring fall-back, arg coercion, route ordering).
- **§4a attribution:** a test asserting a write originating from the controller session is recorded with `actor.channel==='controller'` (and a human MCP write is not), so `recentExternalChanges` excludes the controller.
- **Prompt changes:** verified by review; an OPTIONAL live controller-pass smoke (the prompt is instructions, not code — no unit test). The full mission suite must stay green.

## §8 — File structure

- **Create:** `core/src/mission/mission-scheduler.ts` (`computeSchedule` + `recentExternalChanges`; split `recentExternalChanges` into its own small `mission-changes.ts` if `mission-scheduler.ts` grows past ~200 lines), `core/src/mcp-server/tools/mission-schedule.ts` (the 2 tools), and their tests.
- **Modify:** `core/src/mission/mission-controller.ts` (`CONTROLLER_SYSTEM_PROMPT` + `CONTROLLER_PASS_DIRECTIVE` + the §4a attribution wiring if it lives here), `core/src/routes/core/mission.routes.ts` (2 read routes + handlers), `core/src/mission/mission-actor.ts` and/or the MCP session resolver (§4a controller-session attribution), `core/src/mcp-server/configure.ts` (2 scopes), `core/src/mcp-server/tools/expanded.ts` (register the 2 tools), `core/src/mcp-server/tools/guide.ts` (mission-controller topic).
- **Reuse:** `place()` (mission-model), `mission-filter`/`mission-traverse` (read-side helpers), `putMission`/`appendHistory` (write+version path), the leader-anchoring helper in `mission.routes.ts`.

---

## Out of scope

- Any sub-2 backend change (done) or sub-4 dashboard change (the `ctl:*` tags render for free).
- New executor-runtime behavior — the controller still spawns/drives executors the existing way; only its *decision inputs* (schedule + changes) and *outputs* (`ctl:*` tags, epic-rollup status) are new.
- Auto-acting in the pure-code supervisor layer (the rejected "heavy code" approach) — the scheduler computes; the LLM acts.

## Open questions

None — the intelligence split (hybrid), parent semantics (epic rollup), tag ownership (`ctl:` reserved), history reaction (external-change), and structure (scheduler module + read tools) are all resolved. The one implementation risk (§4a controller write attribution) is specified as a required mechanism with a fallback, to be nailed in the plan.
