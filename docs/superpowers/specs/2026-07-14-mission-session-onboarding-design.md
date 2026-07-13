# Mission Session Onboarding + Workflow Registry — Design

**Date:** 2026-07-14 · **Branch:** `feat/mission-session-onboarding` · **Status:** approved by user (brainstorm 2026-07-14)

## 1. Summary

Mission control today only manages executors it spawned itself. This program adds:

1. **Workflow Registry** (Phase 1) — mission-control processes become versioned, editable **playbook documents** in a fleet-synced `mission-workflows` dataset, agent-interpreted (never engine-executed), with TS defaults as fallback and a code-appended non-editable invariant preamble. Evolving a process = editing a doc — live immediately, no rebuild/redeploy. The controller may self-edit its docs in a managed, attributed, rollback-able way.
2. **Session Onboarding** (Phase 2) — a human, from inside any session, calls the lm-assist MCP to onboard **that session itself** (or a named session) into a **target cluster's** mission control. Onboarding analyzes the session's history (goal · what's done · what's in progress · state: stuck/in-progress/completed · work type: design/direct-impl/bugfix/feature), records it as a mission, and manages it per a **type-routed process doc** — in `handoff` mode (mission control drives end-to-end) or `standby` mode (observe only; human stays in charge). Mode is switched only by a human via MCP.

This resumes the **paused mission-workflow registry research** (2026-07-02, peer-fabric program §"PAUSED thread"), whose W3/W4 prerequisites (durable bus + data-over-fabric ~1s convergence) shipped 2026-07-03. Prior locked decisions honored: agent-interpreted playbooks; fleet-synced dataset with TS fallback; every layer re-reads its directive each pass; direct-edit immediately-live, versioned + attributed; code-appended invariant preamble.

## 2. Decisions locked in this brainstorm

| # | Decision |
|---|---|
| D1 | Approach: registry-backed process library (agent-interpreted docs); minimal registry first, onboarding built on it. Full externalization of remaining prompts (`CONTROLLER_SYSTEM_PROMPT` etc.) is incremental, later. |
| D2 | Initiation: human-initiated via MCP from inside a session — self-onboard (caller-identity resolution) or explicit sessionId; onboarding targets a **cluster** (default: the session node's cluster). No controller auto-scanning/proposals in v1. |
| D3 | Modes: `handoff` (full auto drive) vs `standby` (observe only, human in charge). Explicit, human-switched via MCP. Default on onboard: `standby`. |
| D4 | Process-doc edit authority: controller **can self-edit** and humans edit via MCP — both through one governed path (versioned, attributed, announced, rollback); per-doc `editPolicy` can restrict a doc to `human-only`. Invariant preamble is never editable. |
| D5 | Registry dataset scope: **fleet** (one shared doc set across all clusters; safety = versioning + rollback, not cluster isolation). |
| D6 | Onboarding analysis is performed **by the controller agent per the `onboard.analyze` doc** (no separate one-shot code path), so analysis quality evolves by editing the doc. |

## 3. Phase 1 — Workflow Registry

### 3.1 Dataset + record model

New system dataset **`mission-workflows`** registered in `core/src/data/system-datasets.ts` following the `missions` pattern: backend `cache`, visibility `cross-node-readable`, `syncMode:'full'`, **scope `fleet`** (D5). Companion append-only **`mission-workflow-history`** dataset (mirrors `mission-history`).

```ts
interface WorkflowDoc {
  id: string;                 // dot-namespaced: 'onboard.analyze', 'drive.bugfix', 'controller.pass'
  title: string;
  body: string;               // markdown playbook — agent-interpreted
  editPolicy: 'open' | 'human-only';   // open ⇒ controller self-edit allowed
  rev: number;                // monotonic
  history: WorkflowChange[];  // inline recent-N (cap via project setting, default 50)
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  createdAt: string;
  updatedAt: string;
}
```

New module `core/src/mission/workflow-store.ts` (mirrors `mission-store.ts`): single `putWorkflow` choke point → pre-image read, diff, rev bump, attributed history entry, spill full trail to `mission-workflow-history` (best-effort, never throws out of put). Body size cap (64KB) to stay far from the 1MiB LMDB record cap. Pure helpers in `core/src/mission/workflow-model.ts` (validate id/policy, diff, rollback = re-write of an old rev's body as a **new** rev — history never rewritten).

### 3.2 Defaults, seeding, fallback

- `DEFAULT_WORKFLOWS: Record<string, {title, body, editPolicy}>` TS const (new `core/src/mission/workflow-defaults.ts`) — the 9 docs of §5.
- **Seeding:** the elected leader seeds any missing default docs at supervisor startup (id-keyed upsert, actor = system), so every doc is visible/editable from day one.
- **Fallback:** `renderWorkflow(id)` returns `INVARIANT_PREAMBLE + (storeDoc?.body ?? DEFAULT_WORKFLOWS[id].body)`. Registry/dataset unavailable ⇒ defaults render; the controller is never bricked.

### 3.3 Invariant preamble (non-editable, code-appended)

TS const `WORKFLOW_INVARIANT_PREAMBLE`, always prepended by `renderWorkflow`, never stored, never editable by anyone:

- Never auto-approve `need_approval` gates or material pivots — pause and surface to a human.
- Human input always takes priority; on detected human activity in a session, acknowledge and yield.
- `standby` mode means **never drive** the session.
- Onboarded sessions are never killed, never auto-closed, never force-resumed without an explicit human `force`.
- Self-edits to workflow docs must be announced in controller chat and are always attributable/rollback-able.

### 3.4 Governance (managed self-evolution, D4)

- Every write is attributed via the existing `MissionActor` machinery incl. the §4a `upgradeControllerActor` path — controller writes stamped `kind:controller, channel:controller`.
- Route enforces `editPolicy`: `human-only` docs reject controller-attributed writers (structured `EDIT_POLICY` error). v1 default: all seeded docs `open`.
- Rollback tool writes the target rev's body as a new attributed rev.
- Controller conduct (in `controller.pass`): announce any self-edit with one line of rationale in chat. Controller status output includes a "recent playbook changes" line (last N from history).

### 3.5 Surfaces

- **MCP tools** (in a new `core/src/mcp-server/tools/mission-workflow.ts`, registered in expanded defs + `TOOL_SCOPES` — boot-critical): `mission_workflow_list` (read), `mission_workflow_get` (read), `mission_workflow_set` (write; upsert title/body/editPolicy — editPolicy changes human-only), `mission_workflow_history` (read; paged like `mission_history`), `mission_workflow_rollback` (write).
- **REST** in `mission.routes.ts` under `/mission/workflows...`, registered **before** every `/mission/:id` pattern (the sub-2 route-ordering lesson). Writes leader-anchored fail-closed like mission writes (avoids concurrent-edit loss); reads fall back to the local synced copy.
- Numeric/bool MCP args string-coerced (connector delivers strings).
- Web editor: **out of scope v1** (later phase reuses the memory/rules hash-guarded editor pattern).

### 3.6 Render points (Phase 1 code rails)

1. Supervisor drive text: `CONTROLLER_PASS_DIRECTIVE` → `renderWorkflow('controller.pass')` at drive time (`mission-controller.ts` — const remains as fallback body).
2. `CONTROLLER_SYSTEM_PROMPT` stays TS this phase + gains a short pointer: process docs live in the registry; the pass directive names the doc to fetch via `mission_workflow_get`.
3. `guide("missions")` gains the onboarding/workflow recipe (rendered text references, not duplicated bodies).

## 4. Phase 2 — Session Onboarding

### 4.1 `mission_onboard` (MCP, write scope) + `POST /mission/onboard`

Args:
- `sessionId?` — omitted ⇒ **self-onboard**: resolve the caller's own session via `currentMcpContext()` toolUseId → `resolveCallerCandidates` precise local-session match; unresolvable ⇒ structured error instructing to pass an explicit id.
- `cluster?` — target cluster name; default = the session node's cluster. The route resolves the **target cluster's leader** (cluster map → lowest online gateway id in that cluster) and anchors the mission create there (peer proxy when not self). Cross-cluster onboarding (session node ∉ target cluster) is allowed — the human explicitly asked — and tagged `onboard:cross-cluster=true`.
- `mode?` — `'handoff' | 'standby'`, default `'standby'` (D3).
- `note?` — free-text human hint; stored on the mission, fed to analysis.

Behavior (thin rail, fast return — no LLM inline):
1. Resolve session → node + transport (`session_…` ⇒ cloud; UUID ⇒ native) via existing session/CCR lookups; missing session ⇒ `SESSION_NOT_FOUND`.
2. **Idempotency:** an existing non-terminal mission with `origin:'onboarded'` and the same `binding.sessionId` ⇒ return it (no duplicate).
3. Create mission: `origin:'onboarded'`, `manageMode`, `status:'active'`, binding `{sessionId, node, kind:'onboarded', boundAt}`, tags `onboard:state=analyzing` (+ cross-cluster tag), `note` stored verbatim as the first `nextSteps` entry (`Human note: <note>`), title `Onboarded: <sessionId short form>` until analysis renames it.
4. Return `{missionId, mode, cluster, leaderNode}`.

### 4.2 Analysis (controller-performed, D6)

The supervisor's existing new-mission engagement wakes the controller. Per `controller.pass` routing, an `onboard:state=analyzing` mission ⇒ fetch + follow **`onboard.analyze`**:

- Read session history via `mission_session_read` (page with lastN/cursor on long transcripts; summarize progressively).
- Produce: goal · done-so-far · in-progress-now · `state ∈ {stuck, in-progress, completed}` · `work-type ∈ {design, direct-impl, bugfix, feature}` · suggested next steps; incorporate the human `note`.
- `mission_update`: objective/plan/nextSteps, retitle (`Onboarded: <goal>`), tags `onboard:work-type=…`, `onboard:state=…` (replacing `analyzing`).
- Then: `standby` ⇒ post a summary to controller chat and enter observe conduct; `handoff` ⇒ proceed per the routed drive doc.

### 4.3 Modes — hard rails in code (D3)

- **standby:** `handleSessionDrive` **rejects** drives to missions with `manageMode:'standby'` (structured `STANDBY_MODE`). Supervisor performs cheap Wave-4 signal reads → `interim` updates; controller engaged only on material change to update the record / notify — never to drive.
- **handoff:** controller drives per the routed doc. **Attach is lazy** — first drive on a native session runs `ensureRemoteControlled` (live+reachable ⇒ inject `/remote-control` in place; dead ⇒ resume; live+unreachable ⇒ `needs-force` recorded on the mission + surfaced, **never auto-forced**). Cloud sessions drive via the existing cloud path directly.
- **Mode switch:** `mission_update {manageMode}` — the route **rejects controller-attributed actors** for `manageMode` changes (human-only knob, both directions).
- **Marker:** the drive route auto-prefixes `⟦MISSION-CONTROL⟧` on drives to onboarded missions (code-guaranteed, so human-activity detection is reliable). `mission_session_answer` payloads are **not** prefixed — they must match the pending question's expected options.

### 4.4 Human-activity detection & yield

`classifyExecutorActivity` (supervisor) additionally flags new user-role **plain-text prompts** (excluding `tool_result` blocks and harness `<system-reminder>` injections, which are also user-role in the JSONL) **without** the `⟦MISSION-CONTROL⟧` prefix on onboarded missions ⇒ `humanActive`. Handoff + `humanActive` ⇒ engage controller with that context; per docs it acknowledges, does not send competing instructions, and waits for idle. Standby ⇒ tracking only.

### 4.5 Protections for the human's session

- Reaper: `sweepIdle` excludes `origin:'onboarded'`; onboarded resume paths never call `trackResumedNative`.
- Un-onboard/release: mission → `done`/`failed`/archived ⇒ controller stops touching the session; the session itself is left untouched (an in-place RC connection is harmless).
- Scheduler: `computeSchedule` treats onboarded missions as already-bound — never `ready` for spawn, never placed (`place()` not consulted); `mission_schedule` output unchanged for normal missions.

### 4.6 Cross-node reads

An onboarded native session may live on any in-cluster node (not the leader). `handleSessionRead` / liveness / drive must route by `binding.node` via the existing peer-proxy machinery (`proxyGet`/`proxyPost` — same pattern as the Wave-3 controller-status proxy). Today's native read path assumes the local `AgentSessionStore` — this is a **known integration gap Phase 2 must close**. Transient cross-node read failures follow the existing grace rule (transient ⇒ alive, only confirmed-terminal ⇒ gone).

## 5. Default process library (all `editPolicy:'open'`, seeded from TS defaults)

| Doc id | Content (playbook, abbreviated) |
|---|---|
| `controller.pass` | Externalized pass directive + onboarded handling: route by tags — `state=completed` ⇒ `wrapup.completed`; `state=stuck` ⇒ `recover.stuck` first; else `drive.<work-type>`; fetch via `mission_workflow_get`. Shared conduct: marker prefix, answer `pendingQuestion` immediately, resume-first, yield on human activity, never auto-approve gates, announce self-edits. |
| `onboard.analyze` | §4.2 intake: read history (paged), synthesize goal/done/in-progress/state/work-type, write mission fields + `onboard:*` tags, honor the human `note`, then standby-summary or handoff-proceed. |
| `drive.design` | Converge design-type work: surface open questions, drive to a spec/decision artifact, raise human-judgment calls as gates, done = artifact delivered. |
| `drive.direct-impl` | Straightforward implementation: confirm scope → drive implementation → require test/build evidence before accepting done. |
| `drive.bugfix` | Reproduce → confirmed root cause before any fix → fix → regression test → verify. |
| `drive.feature` | Requirements clear (gate if ambiguous) → design-if-needed → implement → test → verify end-to-end. |
| `recover.stuck` | Classify blocker (error loop / missing info / waiting-on-human / environment), targeted unstick or resume, gate + notify when human-shaped, then return to the work-type doc. |
| `wrapup.completed` | Verify the completion claim with evidence, summarize into the mission, capture follow-ups as proposed next steps, mark done, notify. |
| `observe.standby` | Never drive (also route-enforced); keep `interim`/fields current; notify on material events (stuck, completed, gate seen, repeated errors). |

Extending later = add one doc + one classifier line in `onboard.analyze` — no code.

## 6. Model / route / supervisor changes (implementation anchors)

- `mission-model.ts`: `Mission.origin?: 'onboarded'`; `Mission.manageMode?: 'handoff'|'standby'`; binding `kind:'onboarded'`. `TRACKED_FIELDS` += `manageMode` (history records mode flips + actor). `place()` untouched for normal missions; onboarded skipped upstream.
- `mission-scheduler.ts`: exclude onboarded from `ready`; they appear in rollups/blocked only as already-bound work.
- `mission-controller.ts`: pass-directive render point (§3.6); engagement extension (§4.3/§4.4); seeding at leader startup (§3.2); reaper exclusions (§4.5).
- `mission.routes.ts`: `POST /mission/onboard` (+ workflows routes §3.5, ordered before `/:id`); standby drive rejection; manageMode actor guard; marker auto-prefix; cluster-leader anchoring for onboard.
- MCP: `mission_onboard` + 5 workflow tools; `TOOL_SCOPES` updated (assert-covered); guide/bootstrap text updated.
- Web (minimal v1): Missions list renders onboarded missions with an `onboarded` badge + mode chip (they are ordinary missions otherwise). Full onboarding UI = later phase.

## 7. Error handling

| Failure | Behavior |
|---|---|
| Self-onboard identity unresolvable | Structured error: pass explicit `sessionId`. |
| Session not found / file gone | `SESSION_NOT_FOUND`; no mission created. |
| Target cluster has no online leader | `LEADER_UNREACHABLE` (fail-closed write, existing pattern). |
| Attach `needs-force` | Recorded on mission (`control`/adjustments) + notify; retry only after human `force` or session idle. Never auto-force. |
| Leader failover mid-analysis | Mission durable in synced dataset; new leader's supervisor re-engages from `onboard:state=analyzing`. Onboard idempotent by sessionId. |
| Registry dataset unavailable | `renderWorkflow` falls back to TS defaults. |
| Huge transcript | `onboard.analyze` mandates paged reads + progressive summary. |
| Cross-node read transient failure | Grace (alive/transient), only confirmed-terminal ⇒ gone. |

## 8. Testing

- **Pure/unit (node:test, TDD):** workflow-model (validate/diff/rollback), workflow-store (rev/history/editPolicy/spill), `renderWorkflow` (preamble always present; fallback), seeding idempotency, onboard resolution (toolUseId fixture; explicit sid), scheduler exclusion, reaper exclusion, marker auto-prefix, manageMode actor guard, standby drive rejection, cluster-leader resolution, `mission_onboard` idempotency.
- **Routes/MCP:** workflows CRUD + ordering vs `/:id`, history paging, TOOL_SCOPES coverage (boot assert), connector string-coercion.
- **Live e2e (isolated dev core :3201-style, the class unit tests can't catch):** onboard a real scratch session → controller analyzes + tags → standby drive rejected → flip to handoff (human actor) → controller drives with marker → un-onboard leaves session untouched. RC-inject attach via the `scripts/e2e/live-rc-e2e` fixture pattern. Cross-node onboarded read on stage (123/107) at deploy time.
- Baseline recorded in worktree: 393/393 mission tests pass pre-change.

## 9. Out of scope (v1)

- Controller auto-scanning/proposing onboarding candidates (D2).
- Web onboarding UI + workflow web editor (later phase; Missions list badge only).
- Externalizing `CONTROLLER_SYSTEM_PROMPT`, orchestrator/worker role docs, `buildBootstrapInstruction` (incremental follow-ups on the same registry).
- claude.ai web conversations as onboarding targets (only CC sessions: native UUID or cloud `session_`).
- Engine-executed workflows (explicitly rejected — agent-interpreted only).
