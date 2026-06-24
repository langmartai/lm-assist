# Super Mission Controller — Design

**Date:** 2026-06-24
**Status:** Approved (design)
**Branch:** `feat/mission-controller`

**Goal:** A single, fleet-elected **super Mission Controller** that is responsible for *every* mission: it reads each executor's feedback/progress/results, **adapts the mission itself**, keeps the executor moving toward done, and **places** executors into isolated or serialized environments according to inter-mission dependencies and shared-resource conflicts. It is the higher-level generalization of the just-shipped `stall-monitor`.

---

## 1. Concept

Three nouns, by analogy to a scheduler job (where `description` = WHAT and the scheduled script = HOW):

- **Mission** — a *durable, living* record of WHAT to achieve. Cross-project, re-bindable to an executor. Not a static description with a binary done/failed: the controller **revises** its objective/plan from what the executor returns, and keeps an audit trail of every change.
- **Executor** — exactly **one primary** Claude Code session that fulfills a mission: a **cloud CCR** session or a **native** session, acting as an **orchestrator** (spawns/manages sub-workers) or a **direct worker**. It follows the existing **worker-role protocol** (`set_role`/`report_status`/`decide_gate`/`⟦WORKER-STATUS⟧`) and reports its own progress.
- **Super Mission Controller** — **one** fleet-elected loop (lowest online gateway-id, reusing the stall-monitor's election) that, every N minutes, does **liveness → adjust → placement** for *all* missions. It is the single scheduler, so it serializes conflicting work by decision — no distributed lock needed.

**Scope of this spec:** the controller is the star. The Mission record, its MCP CRUD, and the executor binding are the **minimal supporting structures** the controller operates on — designed only as far as the controller needs them.

**Relationship to `stall-monitor` (composition, not duplication):** the stall-monitor keeps *any* session alive through transient **server** errors (5xx/529 → types `continue`). The Mission Controller owns *mission* lifecycle (adapt the objective, re-bind a dead executor, advance to the next step, validate done). When the controller sees a server-stall it **defers** to the stall-monitor rather than double-driving. The two share the election function and will typically elect the same node — which is fine and desirable (one coordination node).

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Name | **Mission** |
| Executor binding | **One primary executor** per mission; durable + **re-bindable** (ephemeral cloud sessions die → controller re-binds). Executor maintains its own progress. |
| Push autonomy | **Fully autonomous (push to done)** — the controller resumes/nudges/re-binds/advances with no human babysitting. |
| Controller scope | **One fleet-elected super-master** for the whole fleet. |
| Mission lifecycle | **Living record**, not binary: the controller reads feedback/progress/results and **revises** the objective/plan; `done`/`failed` are just two verdicts the reasoning step can reach. |
| Autonomy boundary | The controller may **refine/re-scope autonomously** (logged in `adjustments[]`). A **material pivot** (direction change away from the original objective) and any executor `need_approval` gate **pause for the human** — the controller never auto-approves a gate or performs an irreversible/outward action itself. |
| Placement | **Isolate when possible** (cloud > worktree+branch), **serialize when sharing is unavoidable** (lease on the shared resource). Driven by `dependsOn[]` + `env.resources[]`. |
| Storage | The Mission records live in a **data-service dataset** (`missions`, `syncMode:'full'`) — the only cross-node-synced persistence — so any elected node sees all missions. Requires `dataServiceEnabled`. |
| Adjust reasoning | **opus-4.8** (`claude-opus-4-8[1m]`) with **max thinking** — adaptive extended thinking + `effort:'high'`. The **model is overridable** (`missionControllerModel`) so a newer/more capable model can be adopted later without code changes; the max-thinking/effort knobs are model-agnostic and stay on. |

---

## 3. Architecture

```
                ┌──────────────────────────────────────────────┐
                │  missions dataset (data-service, full-sync)   │  cross-node, version+LWW (isNewer)
                │  one DataRecord per Mission (WHAT + state)     │
                └───────────────▲───────────────┬──────────────┘
       put/get/query (DataService)              │ replicated to every node (SyncEngine.reconcile)
                                │                │
   report_status mirror ───────┤                │
   (POST /worker/status) ──────┘                ▼
   ┌──────────────┐  elected (amIMonitor)  ┌───────────────────────────────────┐
   │ scheduled    │ ─────────────────────▶ │  Mission Controller tick (1 node) │
   │ jobs (60s)   │  only the elected node │   per active mission:             │
   │ tick         │  runs the loop         │    A. liveness  → rebind/defer/gate
   └──────────────┘                        │    B. adjust    → sdk-runner one-shot (on NEW output)
                                           │    C. placement → dep gate + isolate / lease-serialize
                                           └───────────┬───────────────────────┘
                                                       │ drive / start
                       ┌────────────────────────────────┼───────────────────────────┐
                       ▼                                 ▼                           ▼
               cloudStart/Drive/Read            send_session_message          git worktree + branch
               (cloud CCR — isolated VM)         (native session)             (isolated native env)
                       │                                 │
                       └──── executor (orchestrator | worker) — worker-role protocol ────┘
                              reports progress/results via report_status / ⟦WORKER-STATUS⟧
```

---

## 4. Components & changes

### 4.1 Mission record + `mission-store` (cross-node, via the data service)

New `core/src/mission/mission-store.ts` — mirrors `worker-store.ts`'s API shape, but persists through `getDataService()` (not a local JSON file) so records sync fleet-wide. On first use it ensures a dataset `missions` (`syncMode:'full'`, `ownerNode = getHubConfig().gatewayId`). One `DataRecord` per mission; `record.id = mission.id`; `record.fields = Mission` (below); writes via `DataService.put(ctx, 'missions', record)` (stamps `version`/`updatedAt`, marks dirty → peers pull), reads via `get`/`query`.

```ts
type MissionStatus =
  | 'draft' | 'active' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed';

interface Mission {
  id: string;                       // 'mission_<rand>'
  title: string;

  // WHAT — living, controller-revisable
  objective: string;                // current objective (revised over time)
  plan?: string;                    // controller's current read of how to get there
  nextSteps?: string[];
  projects: string[];               // repos/projects this mission spans

  // dependency + environment footprint (declared at create; refinable by the adjust step)
  dependsOn: string[];              // other mission ids that must reach `done` (ordering edges)
  env: {
    isolation: 'cloud' | 'worktree' | 'shared';
    host?: string;                  // gatewayId of the target node (native/worktree)
    repo?: string;
    branch?: string;
    resources: string[];            // named, UNbranchable resources (ports, DBs, services, datasets)
    exclusive?: boolean;            // off-limits / never co-schedule (e.g. a live capture service)
  };

  // one primary executor (durable, re-bindable)
  binding: {
    sessionId: string | null;       // cloud sid or native sessionId
    node: string | null;            // gatewayId where it runs
    kind: 'orchestrator' | 'worker' | null;
    boundAt?: number;
  } | null;

  // progress (mirrored from the executor's report_status)
  progress: { percent: number; summary: string; updatedAt: number } | null;

  // controller bookkeeping
  control: {
    lastTickAt?: number;
    lastNudgeAt?: number;
    nudgeCount: number;
    backoffStep: number;
    lastOutputCursor?: number;      // high-water mark to detect "new output since last tick"
    waitReason?: 'dependency' | 'resource';
  };

  results: Array<{ at: number; ref: string; summary?: string }>;
  adjustments: Array<{ at: number; trigger: string; change: string; by: 'controller' | 'user' }>;

  status: MissionStatus;
  ownerNode: string;                // gatewayId that created it
  createdAt: number; updatedAt: number;
}
```

`mission-store.ts` exports: `getMission(id)`, `listMissions()`, `listActiveMissions()`, `putMission(m)`, `deleteMission(id)`, plus small helpers `bindExecutor(id, binding)`, `recordAdjustment(id, adj)`, `mirrorProgress(id, progress)`. All go through the data service; `dataServiceEnabled` off ⇒ the store returns empty/no-ops and the controller logs `skipped` (see 4.9).

**Leases are derived, not stored.** A resource is "held" iff some `active` mission's `env.resources` contains it on the same `host`. The controller recomputes the conflict view each placement decision from `listActiveMissions()` — no separate lease dataset, and failover is automatic (a new controller derives the identical view).

### 4.2 The control loop — `core/src/mission/mission-controller.ts`

Generalizes `stall-monitor.ts`. A pure-ish `runMissionTick(deps)` plus `registerMissionController(jobs)` that registers the handler and is lazy-`require`d from `scheduled-jobs.ts` `registerDefaults()` (exactly as `registerStallMonitor` is today).

```ts
interface MissionTickDeps {
  now: number;
  cfg: { intervalMin: number; maxNudges: number; model: string };
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  listActive: () => Mission[];
  readExecutor: (m: Mission) => Promise<ExecutorState>;   // cloudRead / worker-store
  adjust: (m: Mission, newOutput: ExecutorOutput) => Promise<AdjustResult>;  // sdk-runner one-shot
  place: (m: Mission, active: Mission[]) => PlacementDecision;
  drive: (m: Mission, directive: string) => Promise<void>; // cloudDrive / send_session_message
  startExecutor: (m: Mission, place: PlacementDecision) => Promise<Binding>; // cloudStart / native+worktree
  save: (m: Mission) => void;
}
export async function runMissionTick(deps: MissionTickDeps): Promise<MissionTickReport>;
export function registerMissionController(jobs: { registerHandler(t: string, fn: any): void }): void;
```

`readExecutor` surfaces what the three phases need without the controller re-deriving it:

```ts
interface ExecutorState {
  alive: boolean;                   // sid present in cloudListAccount() / native session live
  serverStalled: boolean;          // stall-classify saw 5xx/529 — defer to stall-monitor
  gate: { taskId: string; reason: string } | null;  // executor reported need_approval
  newOutput: ExecutorOutput | null; // present iff there is output past control.lastOutputCursor
  idle: boolean;                    // parked / awaiting input with no new output
}
interface ExecutorOutput { cursor: number; messages: string[]; results: Array<{ ref: string; summary?: string }>; }
```

The registered handler (type `mission-controller`) reads live `getProjectSettings()`, early-returns `{ result, status:'skipped' }` when `!missionControllerEnabled` or `!dataServiceEnabled`, else assembles the real deps and calls `runMissionTick`. **Only the elected node** acts: `amMonitor().isMonitor === false` ⇒ return `{ status:'skipped', result:'not the mission controller' }`.

Each mission is processed in its **own try/catch** (one bad mission never aborts the tick — the same isolation fix folded into `stall-monitor`).

### 4.3 Per-mission decision — the three phases (the heart)

For each `active`/`waiting` mission, in order:

**A. Liveness (deterministic, cheap — runs every tick):**

| Condition (from `readExecutor`) | Action |
|---|---|
| executor missing/dead — sid absent from `cloudListAccount()`, or native session ended without `done` | **rebind**: run phase C placement, then `startExecutor` with `reBootstrap`, update `binding` |
| session shows a **server stall** (5xx/529, via `stall-classify`) | **defer** — leave it to the stall-monitor; no nudge this tick |
| executor reported a `need_approval` **gate** (worker-store task `gate`, or `cloudRead.pendingQuestion` that is a decision) | **pause**: `status='paused'`; surface; wait for `decide_gate` — never auto-approve |

If none of the above and there is **new output** since `control.lastOutputCursor` → phase B; else phase C-then-nudge.

**B. Adjust (LLM reasoning — only when there is NEW output):**

Call `deps.adjust(mission, newOutput)` (4.4). Apply the verdict:

| `verdict` | Controller action |
|---|---|
| `continue` | `drive(m, nextDirective || 'continue')`; bump `lastOutputCursor` |
| `revise` | if `isMaterialPivot` → `status='paused'` + `recordAdjustment` + surface (gate the pivot, do **not** send the directive); else apply `revisedObjective`/`revisedNextSteps`, `recordAdjustment`, then `drive(m, nextDirective)` |
| `done` | mark `status='done'`; release derived leases (mission no longer active); stop driving |
| `blocked` | mark `status='blocked'`; record reason; flag for human |
| `gate` | `status='paused'`; surface |

Adding/changing `dependsOn` or `env` from the reasoning step is a **refinement** (logged), not a pivot.

**C. Placement + parked nudge (deterministic):**

`deps.place(mission, active)` returns a `PlacementDecision`:

```ts
type PlacementDecision =
  | { go: false; reason: 'dependency'; waitOn: string[] }          // unmet dependsOn
  | { go: false; reason: 'resource'; conflictWith: string }        // shared resource held by another active mission
  | { go: true; env: 'cloud' }                                     // isolated VM
  | { go: true; env: 'worktree'; host: string; repo: string; branch: string }  // isolated native
  | { go: true; env: 'shared'; lease: string };                    // serialized on a held resource (now free)
```

Resolution order: **(1) ordering gate** — any `dependsOn` mission not `done` ⇒ `{go:false, dependency}` → `status='waiting'`, `waitReason='dependency'`. **(2) isolate** — prefer `cloud`; else, if the footprint is branchable (only repo files), `worktree`+branch on `env.host`. **(3) serialize** — if the mission must touch a non-branchable `resources[]` entry that another `active` mission holds on the same host ⇒ `{go:false, resource}` → `status='waiting'`, `waitReason='resource'`; when free, `{go:true, shared}`. `exclusive` resources are never co-scheduled.

If the mission is alive, idle, and has **no new output** (not started yet, or parked mid-run): when phase C says `go:true` and there's no binding → `startExecutor`; when bound and parked → **nudge** `drive(m,'continue')` with capped backoff (reuse `backoffMinutes(control.backoffStep, intervalMin)`); after `control.nudgeCount > cfg.maxNudges` with no progress delta → `status='blocked'`.

### 4.4 The adjust (reasoning) step — `core/src/mission/mission-adjust.ts`

A one-shot, **max-reasoning** call:

```ts
createSdkRunner({ trackChanges:false }).execute(prompt, {
  model: cfg.model,                                   // default 'claude-opus-4-8[1m]'
  maxTurns: 1,
  extendedThinking: { enabled: true, type: 'adaptive' },   // Opus 4.6+/4.8 max (adaptive) thinking
  outputConfig: { effort: 'high', format: { type: 'json_schema', schema: ADJUST_SCHEMA } },
})
```

**Must** load the SDK via the existing ESM-import indirection (the runner already does; new code must not statically `import`/`require` the SDK). `cfg.model` comes from `missionControllerModel` (default `'claude-opus-4-8[1m]'`) and is the **single knob to adopt a newer model later**; the `adaptive` thinking + `effort:'high'` settings are model-agnostic and stay on. **Cost gate:** only invoked when phase A finds new output — most ticks never call it.

```
prompt  = mission.objective + mission.plan/nextSteps + the NEW feedback/results since last tick
schema  = {
  verdict: 'continue'|'revise'|'done'|'blocked'|'gate',
  revisedObjective: string|null,
  revisedNextSteps: string[]|null,
  isMaterialPivot: boolean,
  nextDirective: string,            // what to send the executor next
  reason: string
}
```

`mission-adjust.ts` builds the prompt, parses `r.result` (JSON) into `AdjustResult`, and defensively defaults to `{ verdict:'continue', nextDirective:'continue' }` on a parse/SDK error (never throws into the tick).

### 4.5 Election & failover — reuse `stall-election.ts`

`amIMonitor()` unchanged (`electMonitor(onlineIds, selfId)`, lowest online gateway-id). Only the elected node runs the loop, so missions are never double-driven; if it drops, the next-lowest node picks up on its next tick and — because missions live in the synced dataset and leases are derived — it reconstructs the full picture with no handoff state.

### 4.6 Executor binding & progress mirroring

When a bound executor calls `report_status`, the existing `POST /worker/status` handler (`worker.routes.ts`) already `putRecord`s the worker store. **Add:** after `putRecord`, if the session is bound to a mission (look up by `binding.sessionId`), call `mirrorProgress(missionId, { percent, summary, updatedAt:now })` and append any returned result to `mission.results`. This makes the mission record the single cross-node source of truth for progress — the controller reads only the mission, never per-node worker stores.

Binding happens in phase A/C: `startExecutor` (cloud `cloudStart({setup:true, role, repo, prompt})` → sid; or native worktree launch) returns a `Binding` written via `bindExecutor`.

### 4.7 MCP surface + routes (minimal)

Mirror the worker-role pattern exactly:

- `core/src/routes/core/mission.routes.ts` → `createMissionRoutes(ctx): RouteHandler[]` — `POST /mission` (create), `GET /mission` (list), `GET /mission/:id`, `PATCH /mission/:id` (update objective/env/dependsOn/status), `GET /mission/controller` (election + last-tick report). Registered in `routes/core/index.ts`.
- `core/src/mcp-server/tools/mission.ts` → `MISSION_TOOL_DEFS` + `MISSION_HANDLERS` (`mission_create`, `mission_list`, `mission_update`, `mission_control_status`) proxying those routes via `workerGet`/`workerPost` from `_passthrough` (behind the worker token, like the worker-role tools). Spread into `expanded.ts` defs + handlers; scoped in `configure.ts`.
- `guide("missions")` topic added (orientation for the LLM).

MCP number/bool args arrive as **strings** over the connector — coerce in the route/handler (known gotcha).

### 4.8 Registration + settings toggle

- `scheduled-jobs.ts` `registerDefaults()` → lazy-`require` and call `registerMissionController(this)`. `makeBuiltinJobs(nowMs)` seeds a built-in job `{ type:'mission-controller', enabled:true, intervalMinutes: <missionControllerIntervalMin default 5> }`.
- `project-settings.ts`: add to `ProjectSettings`, `DEFAULTS`, and the per-field read/write guards: `missionControllerEnabled` (default `true`), `missionControllerIntervalMin` (default `5`), `missionControllerMaxNudges` (default `6`), `missionControllerModel` (default `'claude-opus-4-8[1m]'` — change this one field to adopt a newer model when available; max-thinking/effort stay on regardless). The handler reads them live each run.

---

## 5. Data flow (one mission, end to end)

1. `mission_create` → `mission-store.putMission` → `missions` dataset record (replicates to the fleet).
2. Elected controller's next tick: phase C places it (cloud, or worktree on a branchable repo, else waits on a dependency/resource) → `startExecutor` → `bindExecutor`.
3. Executor runs under the worker-role protocol; `report_status` → `POST /worker/status` → `mirrorProgress` updates the mission record.
4. Next ticks: phase A liveness; on new output, phase B `adjust` revises the objective/plan and sends the next directive; parked → nudge with backoff; dead → rebind.
5. Adjust returns `done` (validated against the objective) → `status='done'`, leases released. A material pivot or `need_approval` → `status='paused'` for the human; a human resolves via `decide_gate`/`mission_update`.

---

## 6. Error handling / safety

- **Per-mission isolation:** every mission processed in its own try/catch; a failure logs and continues the tick.
- **Autonomy boundary:** the controller never auto-approves a `need_approval` gate, never commits a **material pivot** without a human, and never itself performs a prohibited/irreversible action — it drives the executor session, which runs under its own permission mode. `adjustments[]` is the audit trail for every autonomous refinement (reversible by the human).
- **Bounded nudging:** capped backoff; `> maxNudges` with no progress ⇒ `blocked` (no infinite loops, mirrors stall-monitor).
- **Protected resources:** `env.exclusive` resources are never co-scheduled or auto-touched (e.g. a live capture/trading service); placement treats them as permanently leased to their owner.
- **Data-service gate:** if `dataServiceEnabled` is off, the controller and MCP tools no-op with a clear `skipped`/error message (the feature requires it; documented).
- **Adjust step never throws into the tick:** SDK/parse errors default to `continue`; the cost gate (new-output-only) bounds spend.
- **Single writer:** one elected controller mutates mission control-state, so concurrent-write races are avoided by construction; data-service version+LWW (`isNewer`) covers the create/update-from-other-nodes case.

## 7. Testing

- **Unit (pure):** the phase-A/B/C decision function over a table of `Mission` + `ExecutorState` fixtures (progressing/idle/dead/gate/server-stall/new-output → expected action); `place()` resolver (dependency gate, isolate cloud>worktree, resource serialize, exclusive); nudge backoff reuse of `backoffMinutes`; `AdjustResult` parsing incl. the defensive default.
- **Store:** `mission-store` round-trip through a stubbed `DataService` (put→get→list; `dataServiceEnabled=false` ⇒ no-op/empty).
- **Route:** `mission_*` CRUD; `report_status` → `mirrorProgress` writes the bound mission's progress.
- **Adjust:** `mission-adjust` with a mocked `sdk-runner` (assert prompt contains objective+new output; parse verdict; SDK-error → `continue`).
- **Election:** `runMissionTick` with `amMonitor:false` ⇒ skipped, no drives.
- **Integration:** parked mission → one nudge → backoff; dead session → rebind; unmet `dependsOn` → `waiting`; two missions sharing a resource → one `active`, one `waiting`, then promotion when freed.

## 8. Out of scope (YAGNI)

- A missions **web UI** (records + control-status are MCP/REST only for now).
- Multiple/sharded controllers (one elected super-master only).
- Auto-approving agree-gates or auto-committing material pivots.
- Cross-**hub** (multi-fleet) missions — single fleet only.
- Fully programmatic **native** executor auto-start polish: phase-1 supports cloud executors end to end (`cloudStart/Drive/Read`) and worktree/native **placement assignment**; the exact native-launch call is finalized in the implementation plan.
