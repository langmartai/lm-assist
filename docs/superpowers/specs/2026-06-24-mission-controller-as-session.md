# Controller-as-Session + Mission Session Operability (Wave 2) — Design

**Goal:** Turn the Mission Controller from a deterministic in-process job into an **autonomous agent session** running on the elected fleet node, supervised for election/lifecycle by a thin deterministic job; and expose **mission-scoped get/list/read/send-message/control** of the controller and every orchestrator/worker session to both MCP callers (agents) and the human user (web UI).

**Architecture:** A thin **supervisor** (the existing `mission-controller` scheduled job, refactored) owns election + the controller session's lifecycle + cadence. The **controller agent** (a native `claude --remote-control` session on the elected node) runs the adaptive per-mission loop using MCP tools. The old deterministic logic (`place()`, liveness) is repurposed into **callable rail tools** so the agent keeps its safety guarantees. A **mission-aware session resolver** unifies cloud-vs-native read/drive/control behind mission-scoped tools + routes, consumed identically by MCP and the UI.

**Tech stack:** TypeScript (core, CJS), node:test; native `claude --remote-control` via `tmuxCcController.launch`; CCR cloud relay; Next.js/React (web). Builds on Wave-1 provenance.

## Global Constraints

- Core build is CommonJS — no new ESM static imports.
- Mission routes use the bare `{success,data}`/`{success,error}` envelope.
- The controller session lives ONLY on the elected node; exactly one exists fleet-wide at a time (supervisor-enforced single-writer).
- Idle controller = ~0 tokens (native heartbeat only); the supervisor caps agent activity to one pass per `missionControllerIntervalMin`.
- The agent never auto-approves a `need_approval` gate or a material pivot (carried from Wave-1).
- All new MCP tools + routes use the worker-token gate; Wave-1 provenance applies to agent `mission_update`s.

---

## Component 1 — Supervisor (refactor `mission-controller.ts` job)

The `mission-controller` scheduled-job handler (5-min, gated by `missionControllerEnabled` + `dataServiceEnabled`) becomes a **supervisor**; it no longer runs `runMissionTick`'s per-mission loop. Each tick:
1. `amIMonitor()`. If NOT elected → ensure no local controller session (kill the tmux + clear local state) and return `skipped (not monitor)`.
2. If elected → reconcile the controller session:
   - Load controller-session state (`controllerSession`: `{node, sessionId, cse?, tmux, startedAt}` — stored in the mission-store under a reserved key `__controller__`, so it syncs + survives restart).
   - If no live session on THIS node (state missing, or `sessionVerdict(sessionId).inTmux` false) → **launch** one via `tmuxCcController.launch({ cwd: controllerCwd(), remoteControl: true, skipPermissions: true, autoTrust: true })`, discover its session (reuse `startNativeExecutor`'s `pickNewSession` discovery), persist `controllerSession`.
   - **Drive a pass**: send the controller agent the standing directive *"Run a controller pass now: review every active mission via mission_list; for each, call mission_place, spawn/drive/adapt/decide as needed; then await the next pass."* (cloud relay if a `cse` exists, else `getCcController().prompt(sessionId, …)`).
3. Return `{ controllerSession, drovePass: true }`.

**Failover:** election flips in ≤8s; within ≤1 tick the newly-elected node's supervisor launches its controller session and persists `controllerSession` (overwriting the dead node's). The de-elected node's next tick (step 1) tears its local session down. Missions are the durable state — the new agent re-derives everything from `mission_list`.

`controllerCwd()`: a dedicated worktree of the lm-assist repo (or `missionControllerRepo` setting if set), so the agent has a workspace + lm-assist context.

## Component 2 — Controller agent playbook (`guide("mission-controller")`)

A new guide topic + the launch directive give the agent its role:
- Bootstrap/self-heal (reuse `buildBootstrapInstruction`) so lm-assist is up locally.
- The loop contract: on each drive → `mission_list` → per active mission: `mission_place(id)` (the rail) → if `go`, spawn/bind an executor (cloud `ccr_cloud_start` or native worktree) and `mission_session_drive` it; read executor output (`mission_session_read`); **adapt** objective/plan/nextSteps by its own reasoning and `mission_update`; handle gates with `decide_gate`; mark `done`/`blocked` via `mission_update`. Then **await** the next pass (idle).
- Hard rules: never auto-approve a `need_approval` gate or a material pivot (pause + surface); respect `mission_place` verdicts (never spawn when it says wait); one executor per mission unless orchestrating.
- Model: `missionControllerModel` (opus-4.8) — set on launch.

## Component 3 — Rail tools (deterministic guardrails)

- **`mission_place(id)`** (new MCP tool + `GET /mission/:id/place`): wraps the pure `place(m, all)` → returns `{go, reason?, env?, host?, branch?, lease?, waitOn?, conflictWith?}`. The agent calls it before spawning so dependency-ordering, resource conflicts, and isolation are enforced as code, not judgment.
- **`mission_executor_status(id)`** (new MCP tool + `GET /mission/:id/executor-status`): wraps the existing `readExecutor`/`executorLiveness` → `{alive, idle, serverStalled, gate?, status}` so the agent reads executor liveness deterministically.

## Component 4 — Mission session resolver + operability routes

A pure **transport resolver** `resolveMissionSession(sid, missions): { transport: 'cloud'|'native', sid, missionId?, role }`:
- `cse_`/`session_` shape → `cloud`; UUID shape → `native` (reuse `mission-native.isNativeBinding`/`cseToSessionSid`).
- `role` from the mission bindings + the `controllerSession` (controller) and the worker store (orchestrator vs worker).

REST routes (`mission.routes.ts`):
- `GET /mission/sessions` → all operable mission sessions: the controller session + every active mission's orchestrator + workers. Rows: `{sid, missionId|null, role: 'controller'|'orchestrator'|'worker', transport, status, webUrl}`.
- `GET /mission/:id/sessions` (exists) — extended with `transport` + `webUrl` per row.
- `POST /mission/session/:sid/read` `{lastN?}` → resolve transport → cloud `cloudRead` / native `getConversation` → `{messages}`.
- `POST /mission/session/:sid/drive` `{text}` → resolve → cloud `cloudDrive` / native `getCcController().prompt` → `{delivered}`. (Provenance: if this drive updates a mission, the caller is attributed.)
- `POST /mission/session/:sid/control` `{action: 'interrupt'|'stop'|'restart'}` → resolve → `interrupt` (cloud: drive an interrupt / native `terminal_interrupt`), `stop` (cloud `cloudStop` / native kill tmux), `restart` (controller only → supervisor relaunch on next tick by clearing `controllerSession`; refuse for non-controller).

## Component 5 — Mission session MCP tools

In `mcp-server/tools/mission.ts`, add + register (expanded.ts defs/handlers, configure.ts scope), each proxying the routes above via `_passthrough`:
- `mission_sessions(missionId?)` → list (get/list).
- `mission_session_read(sid, lastN?)` → read.
- `mission_session_drive(sid, text)` → send-message input (write).
- `mission_session_control(sid, action)` → interrupt | stop | restart (control).
- `mission_place(id)`, `mission_executor_status(id)` → the rails.
Number/bool args coerced (existing pattern). Worker-token gate.

## Component 6 — Web UI (open to the user)

`web/src/components/missions/MissionsPage.tsx`:
- **Default-open the controller session**: on load, `GET /mission/controller` (extended to return `controllerSession`) → auto-connect to it (reuse `CcrCloudView` for a `cse`, or a native session view) as the default panel — the user sees the controller agent live.
- **Per-session operate panel** for the controller AND every orchestrator/worker (from `GET /mission/sessions` / `GET /mission/:id/sessions`): **read** (live transcript), a **send-message** input box (drive), and **control** buttons (interrupt / stop / restart) — all user-initiated. This is the "open to the user" surface: the user decides when to step in and message or control any session.

## Provenance / cost / state

- Agent `mission_update`s → attributed to the controller session (Wave-1, automatic).
- Idle = heartbeat only (~0 tokens); one agent pass per interval bounds cost; the user's ad-hoc drives cost a turn each (their decision).
- `controllerSession` persisted in the mission-store (reserved key) so it syncs + survives restart/failover.

## Tests (`core/src/__tests__/`)

- Supervisor decision table: not-monitor → teardown/skip; monitor + no live session → launch+persist; monitor + live → drive-pass (stub launcher/driver/store).
- Failover: elected changes → new node launches, `controllerSession` overwritten; de-elected → teardown.
- `resolveMissionSession`: cse_/session_ → cloud; UUID → native; role from bindings/controller/worker-store.
- Route read/drive/control dispatch to the right transport (mock cloud + native deps); `control restart` refused for non-controller.
- `mission_place`/`mission_executor_status` tools return the rail verdicts (wrap pure place()/liveness).
- `guide("mission-controller")` returns the loop contract + the hard rules.

## Verification (e2e, on deploy)

- Supervisor on the elected node launches a `Mission Controller` native session ("Remote Control active"); `GET /mission/controller` returns its binding.
- `mission_sessions()` lists the controller; `mission_session_read`/`drive` work on it; a worker session is listable + readable + driveable + stoppable.
- One controlled mission: controller agent places (via `mission_place`), spawns an executor, drives it, adapts via `mission_update` (attributed to the controller session), reaches done.
- Web: `/missions` auto-opens the controller; user can read + send a message + interrupt/stop a worker.

## Out of scope

- Multi-controller / sharded control (still single elected controller).
- Replacing the data-service mission store.
