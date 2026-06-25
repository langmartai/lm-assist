# Wave 4 — Change-Detection Engagement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** The non-LLM supervisor tick engages the Mission Controller LLM only on a material executor/mission change (or a long safety interval); ongoing progress is surfaced token-free on the mission item without engaging the controller.

**Architecture:** Modeled on `stall-monitor`. A pure classifier turns a cheap per-mission executor read (`{alive, gate, newOutput}` from `readExecutorState` — no LLM) + the last-seen record into `{material, interim}`. A per-mission engagement store (reserved key in the mission dataset) holds last-seen `{alive, gated, cursor}` + `lastEngagedAt` + `lastActiveIds`. The supervisor persists interim updates (no engage) and engages only when `shouldEngage`.

**Tech Stack:** TS (core, CJS), node:test; Next.js/React.

## Global Constraints
- CommonJS; bare `{success,data}` mission envelope; worker-token gate; only the leader runs the supervisor.
- The detector MUST be token-free (no LLM / no adjust call) — cheap transcript reads + string scans only.
- Keep the controller lifecycle (Wave 2 launch/teardown) + Wave 3 bootstrap unchanged; only replace the DRIVE gate.
- Test (single file): `cd /home/ubuntu/lm-assist/core && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Full core: `./core.sh build`. Web: `(cd web && npx next build)`.

---

### Task 1: Pure engagement classifier + decision

**Files:** Create `core/src/mission/mission-engagement.ts`. Test `core/src/__tests__/mission-engagement.test.ts`.

**Interfaces (Produces):**
```ts
export interface ExecSeen { alive: boolean; gated: boolean; cursor: number; }
export interface ExecNow { alive: boolean; gated: boolean; cursor: number; newLines: string[]; }
export interface Activity { material: boolean; reason?: string; interim?: { summary: string }; }
// material = liveness drop (was alive, now not) OR gate transition (was !gated, now gated)
//            OR a status marker in newLines (⟦WORKER-STATUS⟧ / a 'need_approval'|'blocked'|'done' marker line).
// interim  = !material && cursor advanced (newLines non-empty) → summary = last non-empty newLines entry (trim, ≤200 chars).
export function classifyExecutorActivity(prev: ExecSeen | undefined, cur: ExecNow): Activity;

export interface EngageInput {
  now: number;
  lastEngagedAt: number | null;
  safetyIntervalMin: number;
  materialCount: number;          // missions with a material activity this tick
  activeIds: string[];            // current active mission ids
  lastActiveIds: string[];        // active ids at last engagement
}
// engage if materialCount>0 OR the active-id SET changed (new/removed mission) OR never engaged OR safety elapsed.
export function shouldEngage(i: EngageInput): boolean;
```

- [ ] **Step 1: test** — write `mission-engagement.test.ts`:
```ts
import { classifyExecutorActivity, shouldEngage } from '../mission/mission-engagement';
test('classify: liveness drop → material', () => {
  const a = classifyExecutorActivity({alive:true,gated:false,cursor:3}, {alive:false,gated:false,cursor:3,newLines:[]});
  assert.equal(a.material, true);
});
test('classify: gate transition → material', () => {
  const a = classifyExecutorActivity({alive:true,gated:false,cursor:3}, {alive:true,gated:true,cursor:3,newLines:[]});
  assert.equal(a.material, true);
});
test('classify: status marker in new output → material', () => {
  const a = classifyExecutorActivity({alive:true,gated:false,cursor:3}, {alive:true,gated:false,cursor:4,newLines:['⟦WORKER-STATUS⟧ done']});
  assert.equal(a.material, true);
});
test('classify: only cursor advance → interim (last line summary)', () => {
  const a = classifyExecutorActivity({alive:true,gated:false,cursor:3}, {alive:true,gated:false,cursor:5,newLines:['building...','running tests']});
  assert.equal(a.material, false);
  assert.equal(a.interim?.summary, 'running tests');
});
test('classify: no change → neither', () => {
  const a = classifyExecutorActivity({alive:true,gated:false,cursor:3}, {alive:true,gated:false,cursor:3,newLines:[]});
  assert.equal(a.material, false); assert.equal(a.interim, undefined);
});
test('shouldEngage: material → true', () => {
  assert.equal(shouldEngage({now:100,lastEngagedAt:100,safetyIntervalMin:45,materialCount:1,activeIds:['a'],lastActiveIds:['a']}), true);
});
test('shouldEngage: new mission (set changed) → true', () => {
  assert.equal(shouldEngage({now:100,lastEngagedAt:100,safetyIntervalMin:45,materialCount:0,activeIds:['a','b'],lastActiveIds:['a']}), true);
});
test('shouldEngage: never engaged → true', () => {
  assert.equal(shouldEngage({now:100,lastEngagedAt:null,safetyIntervalMin:45,materialCount:0,activeIds:[],lastActiveIds:[]}), true);
});
test('shouldEngage: safety elapsed → true', () => {
  assert.equal(shouldEngage({now:100*60_000,lastEngagedAt:0,safetyIntervalMin:45,materialCount:0,activeIds:['a'],lastActiveIds:['a']}), true);
});
test('shouldEngage: nothing changed, within interval → false', () => {
  assert.equal(shouldEngage({now:10*60_000,lastEngagedAt:9*60_000,safetyIntervalMin:45,materialCount:0,activeIds:['a'],lastActiveIds:['a']}), false);
});
```
- [ ] **Step 2-4:** run fail → implement (marker regex: `/⟦WORKER-STATUS⟧|need_approval|^\W*(blocked|done)\b/i`; set compare via sorted join) → pass.
- [ ] **Step 5: commit** `feat(mission): pure engagement classifier + shouldEngage (Wave 4)`.

---

### Task 2: Engagement store + cheap executor signal + interim write

**Files:** Modify `core/src/mission/mission-store.ts` (engagement record get/put under reserved `__engagement__`; `setMissionInterim`), `core/src/mission/mission-model.ts` (add `Mission.interim?`), `core/src/mission/mission-controller.ts` (`readExecutorSignal`). Test `core/src/__tests__/mission-engagement-store.test.ts` + extend a controller test.

**Interfaces (Produces):**
```ts
// mission-model.ts: add to Mission:  interim?: { at: number; text: string };
// mission-store.ts:
export interface EngagementState { lastEngagedAt: number | null; lastActiveIds: string[]; seen: Record<string, ExecSeen>; }
export async function getEngagementState(port?): Promise<EngagementState>;   // reserved key '__engagement__'; default {null,[],{}}
export async function putEngagementState(s: EngagementState, port?): Promise<void>;
export async function setMissionInterim(id: string, interim: {at:number;text:string}, port?): Promise<void>; // writes m.interim, putMission
// mission-controller.ts:
export async function readExecutorSignal(m: Mission): Promise<ExecNow>; // token-free: {alive,gated,cursor,newLines}
```

- [ ] **Step 1: test** — `mission-engagement-store.test.ts` with a fake `MissionDataPort` (mirror existing store tests): `getEngagementState` default → `{lastEngagedAt:null,lastActiveIds:[],seen:{}}`; put→get round-trips; `__engagement__` is excluded from `listMissions`/`listActiveMissions` (assert filter); `setMissionInterim` sets `m.interim` and persists.
- [ ] **Step 2-4:** run fail → implement. Engagement record stored as `{ id:'__engagement__', ...state }` (cast like CONTROLLER_ID); add `'__engagement__'` to the `CONTROLLER_ID` exclusion in `listMissions`/`listActiveMissions` (use a `RESERVED_IDS` set). `readExecutorSignal(m)`: reuse the `readExecutorState(m)` read path but return ABSOLUTE `{alive: st.alive, gated: !!st.gate, cursor: st.newOutput?.cursor ?? (m.control.lastOutputCursor ?? 0), newLines: st.newOutput?.messages ?? []}`. → pass.
- [ ] **Step 5: commit** `feat(mission): engagement store + readExecutorSignal + mission.interim (Wave 4)`.

---

### Task 3: Supervisor wiring + event-driven system prompt + setting

**Files:** Modify `core/src/mission/mission-controller.ts` (`runSupervisorTick` engage gate; `CONTROLLER_SYSTEM_PROMPT`; realDeps), `core/src/project-settings.ts` (`missionControllerSafetyIntervalMin` default 45). Test extend `core/src/__tests__/mission-supervisor.test.ts`.

**Interfaces:** `SupervisorDeps` gains (all optional, defaults preserve Wave-3 behavior so existing tests hold):
```ts
listActiveForEngage?: () => Promise<Mission[]>;
readSignal?: (m: Mission) => Promise<ExecNow>;
getEngagement?: () => Promise<EngagementState>;
putEngagement?: (s: EngagementState) => Promise<void>;
setInterim?: (id: string, x: {at:number;text:string}) => Promise<void>;
safetyIntervalMin?: number;
```
When these are present and `isMonitor && live`: read each active mission's signal, classify vs `seen`, collect `materialCount` + interim writes, compute `shouldEngage`; on engage → drive + stamp `{lastEngagedAt:now, lastActiveIds, seen:current}`; else persist interim + updated `seen`/cursors (NO drive). When absent → fall back to the Wave-3 `isDriveDue` path (unchanged).

- [ ] **Step 1: test** — extend `mission-supervisor.test.ts`: (a) monitor+live, 0 active missions, lastEngagedAt recent, safety 45 → action NOT 'drive' (idle, the token-saving case); (b) one mission with a material signal (alive→dead) → action 'drive' + engagement stamped; (c) interim-only signal → NOT 'drive' but `setInterim` called with the last line. Use injected `listActiveForEngage`/`readSignal`/`getEngagement`/`putEngagement`/`setInterim` stubs.
- [ ] **Step 2-4:** run fail → implement the engage gate in `runSupervisorTick` (branch on the new deps; keep `decideSupervisor` for teardown/launch; the drive decision now comes from `shouldEngage`). Update `CONTROLLER_SYSTEM_PROMPT`: add that the controller is **engaged on events, not polling** — "You are driven only when something material happens (an executor finished/blocked/needs approval, a new mission, or a periodic safety check). When driven, act on the current state: `mission_list`, then place/adjust/advance. Ongoing executor progress is tracked for you and shown on each mission — you do NOT need to poll it; look only if relevant. Reply `⟦HEARTBEAT⟧ …` only if, on a safety check, there is genuinely nothing to do." Add the setting (default 45) to project-settings.ts (4 sites). Wire realDeps (listActiveMissions, readExecutorSignal, get/putEngagementState, setMissionInterim, safetyIntervalMin). → pass.
- [ ] **Step 5: commit** `feat(mission): supervisor engages controller only on material change (Wave 4) + event-driven system prompt`.

---

### Task 4: Web — interim progress on the mission item

**Files:** Modify `web/src/components/missions/MissionsPage.tsx`. Verify `next build`.

**Interfaces:** the `Mission` shape the page consumes gains `interim?: { at: number; text: string }`. Render it on each mission row.

- [ ] **Step 1:** in the mission item/sidebar render, when `mission.interim?.text` is present and the mission is active, show a muted line `⏳ working — {interim.text}` (truncate ~120 chars) under the title/status. (Add `interim` to the page's `Mission` type.)
- [ ] **Step 2: build** — `(cd web && npx next build 2>&1 | tail -15)` clean.
- [ ] **Step 3: commit** `feat(web): show executor interim progress (⏳ working — …) on the mission item (Wave 4)`.

---

## Final verification (pre-deploy)
- [ ] `node --test "dist-test/__tests__/mission-*.test.js"` green; `./core.sh build` + web build clean.
- [ ] Bump version, build tgz, GitHub release, deploy fleet (123 leader first — it runs the supervisor; then 117/107) via direct `npm install -g <tgz>` (NOT `lm-assist upgrade`). Restart the controller on 123 so it picks up the new system prompt.
- [ ] e2e: idle (0 missions) → controller NOT driven for ~45 min (no new `Run a controller pass` in the transcript). Create a mission → controller engages within ~1 min, places it. While the executor runs → mission item shows "⏳ working — …" updating with NO controller drives. Executor finishes (liveness drop) → controller engages once.

## Self-Review notes
- Spec coverage: classifier+decision (T1), store+signal+interim (T2), supervisor gate + event-driven prompt + setting (T3), web interim (T4). Token-free detection (no LLM). New deps optional → Wave-3 fallback preserves existing tests.
- Types: `ExecSeen`/`ExecNow`/`Activity`/`EngageInput` (T1) consumed by the store (T2) + supervisor (T3); `Mission.interim` (T2) consumed by web (T4).
