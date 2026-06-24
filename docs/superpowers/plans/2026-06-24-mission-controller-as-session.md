# Controller-as-Session + Mission Session Operability (Wave 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the Mission Controller into a supervised autonomous agent session on the elected node, and expose mission-scoped get/list/read/send-message/control of the controller + orchestrator/worker sessions to MCP and the web UI.

**Architecture:** A thin supervisor (refactored `mission-controller` job) owns election + the controller session's lifecycle + cadence; the controller agent (native `claude --remote-control`) runs the per-mission loop via MCP tools; `place()`/liveness become callable rail tools; a pure transport resolver unifies cloud/native read/drive/control behind mission-scoped routes + tools consumed by both MCP and the UI.

**Tech Stack:** TypeScript (core, CJS), node:test; native `claude --remote-control` via `tmuxCcController.launch`; CCR relay; Next.js/React.

## Global Constraints

- CommonJS core — no new ESM static imports. Bare `{success,data}`/`{success,error}` mission-route envelope.
- Exactly one controller session fleet-wide, on the elected node (supervisor-enforced).
- Idle controller ≈ 0 tokens; supervisor caps agent activity to one pass per `missionControllerIntervalMin`.
- Agent never auto-approves a `need_approval` gate or material pivot.
- New routes/tools use the worker-token gate; Wave-1 provenance applies.
- Test (single file): `cd /home/ubuntu/lm-assist/core && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Full build: `./core.sh build`.

**File map:** `mission-session-resolver.ts` (NEW pure), `mission-store.ts` (controllerSession state), `mission-controller.ts` (supervisor refactor + rail helpers), `routes/core/mission.routes.ts` (rail + operability routes), `mcp-server/tools/mission.ts` (6 tools), `mcp-server/tools/guide.ts` (playbook topic), `web/.../MissionsPage.tsx` (default-open + operate panel).

---

### Task 1: Mission session transport resolver (pure)

**Files:** Create `core/src/mission/mission-session-resolver.ts`; Test `core/src/__tests__/mission-session-resolver.test.ts`.

**Interfaces:** Produces `type Transport='cloud'|'native'`; `type SessionRole='controller'|'orchestrator'|'worker'`; `interface ResolvedSession{sid:string;transport:Transport;missionId:string|null;role:SessionRole}`; `resolveMissionSession(sid:string, missions:Mission[], controllerSid?:string|null):ResolvedSession`.

- [ ] **Step 1: failing test** — `mission-session-resolver.test.ts`:
```ts
import { test } from 'node:test'; import assert from 'node:assert';
import { resolveMissionSession } from '../mission/mission-session-resolver';
const M = (o:any)=>o;
test('cse_/session_ id -> cloud transport', () => {
  const r = resolveMissionSession('session_01x', [], null);
  assert.equal(r.transport, 'cloud');
});
test('uuid id -> native transport', () => {
  const r = resolveMissionSession('4e15ac46-9053-477f-9dae-0000', [], null);
  assert.equal(r.transport, 'native');
});
test('controllerSid -> role controller', () => {
  assert.equal(resolveMissionSession('session_ctl', [], 'session_ctl').role, 'controller');
});
test('binding match -> role + missionId from the mission', () => {
  const missions = [M({ id:'mission_a', binding:{ kind:'orchestrator', sessionId:'session_o', ccr:{sid:'session_o'} } })];
  const r = resolveMissionSession('session_o', missions as any, null);
  assert.equal(r.role, 'orchestrator'); assert.equal(r.missionId, 'mission_a');
});
test('unknown sid -> worker role, null mission', () => {
  assert.equal(resolveMissionSession('session_zzz', [], null).role, 'worker');
});
```
- [ ] **Step 2: run, verify fail** — `node --test dist-test/__tests__/mission-session-resolver.test.js`.
- [ ] **Step 3: implement** `mission-session-resolver.ts`:
```ts
/** Pure: classify a mission session sid by transport (cloud cse_/session_ vs native UUID) + role. */
import { Mission } from './mission-model';
export type Transport = 'cloud' | 'native';
export type SessionRole = 'controller' | 'orchestrator' | 'worker';
export interface ResolvedSession { sid: string; transport: Transport; missionId: string | null; role: SessionRole }
const CLOUD_RE = /^(cse_|session_)/;
export function resolveMissionSession(sid: string, missions: Mission[], controllerSid?: string | null): ResolvedSession {
  const transport: Transport = CLOUD_RE.test(sid) ? 'cloud' : 'native';
  if (controllerSid && sid === controllerSid) return { sid, transport, missionId: null, role: 'controller' };
  for (const m of missions) {
    const b = m.binding; if (!b) continue;
    if (b.ccr?.sid === sid || b.sessionId === sid) {
      return { sid, transport, missionId: m.id, role: b.kind === 'orchestrator' ? 'orchestrator' : 'worker' };
    }
  }
  return { sid, transport, missionId: null, role: 'worker' };
}
```
- [ ] **Step 4: run, verify pass.**  - [ ] **Step 5: commit** `git add -A && git commit -m "feat(mission): pure transport/role resolver for mission sessions"`.

---

### Task 2: Controller-session state in the store

**Files:** Modify `core/src/mission/mission-store.ts`; Test `core/src/__tests__/mission-controller-session-store.test.ts`.

**Interfaces:** Produces `interface ControllerSession{node:string;sessionId:string;cse:string|null;tmux:string;startedAt:number}`; `getControllerSession(port?):Promise<ControllerSession|null>`; `putControllerSession(cs:ControllerSession|null,port?):Promise<void>` (null clears). Stored in the `missions` dataset under reserved id `__controller__` (a record whose `fields` hold the ControllerSession; excluded from `listMissions` by id filter).

- [ ] **Step 1: failing test** (stub port pattern from Wave-1 `mission-provenance-routes.test.ts`): put a ControllerSession, get it back; `listMissions` excludes `__controller__`; put null clears.
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** — add `ControllerSession` type + `getControllerSession`/`putControllerSession` that `svc.put/get(systemCtx(), 'missions', { id:'__controller__', fields:{...cs} })` (mirror `toRecord`/`recordToMission`), and filter `id==='__controller__'` out of `listMissions`'s map (and `recordToMission` must NOT run `withActorBackfill` on it — guard: if `fields.node && fields.sessionId && !fields.title` treat as controller-session, skip backfill).
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): persist controllerSession state (reserved key, fleet-synced)`.

---

### Task 3: Rail routes + tools (place, executor-status)

**Files:** Modify `core/src/routes/core/mission.routes.ts`; Test `core/src/__tests__/mission-rails.test.ts`.

**Interfaces:** Produces routes `GET /mission/:id/place` → `{success,data:PlacementDecision}` (wrap `place(m, all)`); `GET /mission/:id/executor-status` → `{success,data:{alive,idle,serverStalled,gate,status}}`. Testable handlers `handlePlace(id, port?)`, `handleExecutorStatus(id, port?, readExec?)`.

- [ ] **Step 1: failing test** — `handlePlace`: a mission with an unmet dependency → `{go:false,reason:'dependency'}`; a cloud-isolation ready mission → `{go:true,env:'cloud'}`. `handleExecutorStatus` with injected `readExec` stub → returns its `{alive,...}`.
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** — `handlePlace` loads the mission + `listMissions`, returns `ok(place(m, all))` (import `place` from mission-model). `handleExecutorStatus(id, port, readExec=defaultReadExecutor)` loads the mission, calls `readExec(m)` (default = the real `readExecutor` wiring already in `mission-controller.ts` — export a `readExecutorState(m)` from there that builds realCloud/realNative deps and returns `ExecutorState`), returns `ok({alive:s.alive, idle:s.idle, serverStalled:s.serverStalled, gate:s.gate, status:s.newOutput?'has-output':'idle'})`. Register both routes (literal `/place`, `/executor-status` BEFORE `/:id`).
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): rail routes place + executor-status (deterministic guardrails)`.

---

### Task 4: Operability list route — GET /mission/sessions

**Files:** Modify `core/src/routes/core/mission.routes.ts`; Test extend `core/src/__tests__/mission-provenance-routes.test.ts` or new `mission-sessions-list.test.ts`.

**Interfaces:** Produces `handleAllSessions(port?, listWorkers?, controllerSid?):Promise<Envelope>` → `{success,data:{sessions:[{sid,missionId,role,transport,status,webUrl}]}}` = the controllerSession (if any) + every active mission's orchestrator + workers (reuse the existing per-mission `handleSessions` logic; add `transport` via `resolveMissionSession`). Route `GET /mission/sessions` (literal, BEFORE `/:id` patterns).

- [ ] **Step 1: failing test** — with a stub port holding one active mission (orchestrator binding) + a controllerSession, `handleAllSessions` returns the controller row (role controller) + the orchestrator row (role orchestrator), each with a `transport`.
- [ ] **Step 2: run, verify fail.**  - [ ] **Step 3: implement** — iterate active missions, collect their sessions (reuse `handleSessions` per mission or inline), prepend the controllerSession row; stamp `transport` via `resolveMissionSession`. Register the literal route before `/mission/:id`.
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): GET /mission/sessions (controller + all orchestrators/workers)`.

---

### Task 5: Operability read/drive/control routes

**Files:** Modify `core/src/routes/core/mission.routes.ts`; Test `core/src/__tests__/mission-session-ops.test.ts`.

**Interfaces:** Produces `handleSessionRead(sid, lastN?, deps?)`, `handleSessionDrive(sid, text, actor?, deps?)`, `handleSessionControl(sid, action, deps?)` where `deps` inject `{ cloudRead, cloudDrive, cloudStop, nativeRead, nativeDrive, nativeInterrupt, nativeStop, clearController, resolve }` (all stubbable). Routes `POST /mission/session/:sid/read|drive|control`.

- [ ] **Step 1: failing test** — with stub deps + a resolver returning cloud for `session_x`/native for a uuid: read dispatches to `cloudRead` vs `nativeRead`; drive to `cloudDrive` vs `nativeDrive`; control `stop` to `cloudStop`/`nativeStop`, `interrupt` to drive-interrupt/`nativeInterrupt`; `control restart` on a non-controller sid → `{success:false, error.code:'INVALID_INPUT'}`; `restart` on the controller sid → calls `clearController` (supervisor relaunches next tick).
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** — each handler: `const r = deps.resolve(sid)`; switch on `r.transport`. Read: cloud `cloudRead({sid,lastN})`, native `getConversation({sessionId:sid})` (default dep). Drive: cloud `cloudDrive({sid,text})`, native `getCcController().prompt(sid,text)`; thread `actor`/`_actor` so a mission-updating drive is attributed (Wave-1). Control: `interrupt` (cloud→`cloudDrive({sid,text:'[interrupt] stop the current action and await'})` or native `terminal_interrupt`), `stop` (cloud `cloudStop(sid)`, native kill tmux), `restart` (only if `r.role==='controller'` → `putControllerSession(null)` so the supervisor relaunches; else `fail('INVALID_INPUT','restart is controller-only')`). Register the 3 POST routes. Default deps wire the real functions (`cloudRead`/`cloudDrive`/`cloudStop` from ccr-cloud; native via AgentSessionStore + getCcController + tmux).
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): session read/drive/control routes (transport-dispatched)`.

---

### Task 6: Mission session MCP tools

**Files:** Modify `core/src/mcp-server/tools/mission.ts`; register in `expanded.ts` + `configure.ts`; Test extend `core/src/__tests__/mission-mcp.test.ts`.

**Interfaces:** Adds tool defs + handlers `mission_place(id)`, `mission_executor_status(id)`, `mission_sessions(missionId?)`, `mission_session_read(sid,lastN?)`, `mission_session_drive(sid,text)`, `mission_session_control(sid,action)` — each proxies the routes via `workerGet`/`workerPost` (+ `withActorHint` for drive). Coerce numeric/bool string args.

- [ ] **Step 1: failing test** — assert the 6 names are in `MISSION_TOOL_DEFS`; a pure arg-coercion helper for `lastN` (string→number) is unit-tested; `mission_session_drive` body carries `_actor` (reuse `withActorHint`).
- [ ] **Step 2: run, verify fail.**  - [ ] **Step 3: implement** — add the defs (inputSchemas: place/executor_status/sessions/read/drive/control) + handlers proxying `workerGet('/mission/'+id+'/place')`, `workerGet('/mission/sessions'+(missionId?`?missionId=${missionId}`:''))`, `workerPost('/mission/session/'+sid+'/read',{lastN})`, `…/drive` (with `withActorHint`), `…/control',{action}`. Spread into `EXPANDED_TOOL_DEFS`/`EXPANDED_HANDLERS`; add the 6 names to the mission scope in `configure.ts`.
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): 6 mission-session MCP tools (place/exec-status/sessions/read/drive/control)`.

---

### Task 7: Supervisor refactor

**Files:** Modify `core/src/mission/mission-controller.ts`; Test `core/src/__tests__/mission-supervisor.test.ts`.

**Interfaces:** Produces pure `decideSupervisor(input:{isMonitor:boolean; live:boolean}):{action:'teardown'|'launch'|'drive'|'idle'}` and `runSupervisorTick(deps)` (deps inject `amMonitor, getControllerSession, putControllerSession, isLive(cs):boolean, launch():Promise<ControllerSession>, drive(cs):Promise<void>, teardown(cs):Promise<void>`). `registerMissionController` now wires `runSupervisorTick` with real deps (launch = `tmuxCcController.launch` + `pickNewSession` discovery; drive = relay/`getCcController().prompt` with the standing pass directive; isLive = `sessionVerdict(cs.sessionId).inTmux`; teardown = kill tmux + `putControllerSession(null)`).

- [ ] **Step 1: failing test** — decision table: `{isMonitor:false}`→teardown; `{isMonitor:true,live:false}`→launch; `{isMonitor:true,live:true}`→drive. `runSupervisorTick` with stub deps: not-monitor + existing cs → calls teardown + clears; monitor + no live → calls launch + putControllerSession; monitor + live → calls drive.
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** — add `decideSupervisor` (pure) + `runSupervisorTick(deps)`; replace the body of the `mission-controller` handler in `registerMissionController` (currently calls `runMissionTick`) with a call to `runSupervisorTick(realDeps)` gated by `missionControllerEnabled`+`dataServiceEnabled`. Keep `runMissionTick` exported (used by the rail `readExecutorState` + any fallback) but it is NO LONGER the scheduled path. The standing pass directive string lives in a `CONTROLLER_PASS_DIRECTIVE` const.
- [ ] **Step 4: run, verify pass.** Also run full `mission-*` suite. - [ ] **Step 5: commit** `feat(mission): supervisor refactor — election + controller-session lifecycle + cadence`.

---

### Task 8: Controller agent playbook — guide("mission-controller")

**Files:** Modify `core/src/mcp-server/tools/guide.ts`; Test `core/src/__tests__/mission-controller-guide.test.ts`.

**Interfaces:** Adds `GUIDES['mission-controller']` (the loop contract: mission_list → mission_place → spawn/drive/adapt/decide → mission_update → await; hard rules: never auto-approve need_approval/material-pivot; respect mission_place; one executor/mission), `BLURB['mission-controller']`, `TOPIC_TOOLS['mission-controller']`, and an ALIAS so the new mission-session tool names map to it. Export `CONTROLLER_PASS_DIRECTIVE` for reuse (or import from controller).

- [ ] **Step 1: failing test** — `guide({topic:'mission-controller'})` text matches `/mission_place/`, `/never auto-approve/i`, `/await the next pass/i`.
- [ ] **Step 2: run, verify fail.**  - [ ] **Step 3: implement** the guide content + registration (mirror the existing `GUIDES.missions` wiring).
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): guide("mission-controller") agent playbook`.

---

### Task 9: GET /mission/controller returns controllerSession

**Files:** Modify `core/src/routes/core/mission.routes.ts` (the `/mission/controller` handler); Test extend the rails/sessions test.

- [ ] **Step 1: failing test** — `/mission/controller` data now includes `controllerSession` (from `getControllerSession`, stub port) alongside `election` + `job`.
- [ ] **Step 2: run, verify fail.**  - [ ] **Step 3: implement** — add `controllerSession: await getControllerSession()` to the `ok({...})` payload.
- [ ] **Step 4: run, verify pass.** - [ ] **Step 5: commit** `feat(mission): expose controllerSession on GET /mission/controller`.

---

### Task 10: Web UI — default-open controller + operate panel

**Files:** Modify `web/src/components/missions/MissionsPage.tsx`. Verify: `next build`.

- [ ] **Step 1** — On load, read `controllerSession` from `GET /mission/controller`; if present, auto-open it (reuse `CcrCloudView` with `controllerSession.cse||sessionId` as sid) as the default panel; label it "Mission Controller".
- [ ] **Step 2** — Add an **operate panel** for any session row (from `GET /mission/sessions` and `GET /mission/:id/sessions`): a live read (poll `mission_session_read` via `POST /mission/session/:sid/read`), a **send-message** input (`/drive`), and **control** buttons interrupt/stop (and restart for the controller row) → `POST /mission/session/:sid/control`. All user-initiated; reuse the page's existing `apiFetch`.
- [ ] **Step 3: verify build** — `cd /home/ubuntu/lm-assist && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && (cd web && npx next build 2>&1 | tail -20)` → clean.
- [ ] **Step 4: commit** `feat(web): default-open controller session + per-session operate panel (read/send/control)`.

---

## Final verification (pre-deploy)
- [ ] `cd core && npm run build:test && node --test --test-reporter=spec "dist-test/__tests__/mission-*.test.js"` → green.
- [ ] `./core.sh build` + web build clean.
- [ ] Deploy `0.1.77-mc.3` via GitHub-Release + `lm-assist upgrade --from`; e2e per the spec's Verification (supervisor launches controller session; `mission_sessions`/read/drive/control on controller + a worker; one controlled mission to done; UI default-opens controller + user can read/send/interrupt).

## Self-Review notes
- **Spec coverage:** supervisor (T7), agent playbook (T8), rails (T3), resolver (T1), operability routes (T4/T5) + tools (T6), controllerSession state (T2) + endpoint (T9), UI (T10). All spec components mapped.
- **Type consistency:** `ResolvedSession`/`Transport`/`SessionRole` (T1) used by T4/T5; `ControllerSession` (T2) used by T7/T9/T10; route handler shapes match their MCP tool proxies (T6).
- **Placeholders:** pure units (resolver, decideSupervisor) carry complete code + tests; IO/route/UI tasks name the exact existing functions to wrap (`cloudRead`/`cloudDrive`/`cloudStop`/`getConversation`/`getCcController().prompt`/`tmuxCcController.launch`/`sessionVerdict`/`place`/`readExecutor`) — implementers wire against the spec + Wave-1 patterns.
