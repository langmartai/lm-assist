# Super Mission Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single fleet-elected Mission Controller scheduled job that reads each executor's feedback, adapts the mission, and pushes every mission toward done — with dependency-aware placement.

**Architecture:** A pure model (`mission-model.ts`) + a cross-node store over the data service (`mission-store.ts`) + an LLM adjust step (`mission-adjust.ts`) + an orchestration tick (`mission-controller.ts`) that generalizes the shipped `stall-monitor.ts`. Wired into the scheduler, project-settings, REST routes, and MCP tools.

**Tech Stack:** TypeScript (CommonJS), Node.js `node:test`, the existing data service (Vectra/LMDB-backed, cross-node sync), the Claude Agent SDK via `sdk-runner.ts`, ccr-cloud for executors.

## Global Constraints

- **Test framework = Node `node:test`.** Tests live in `core/src/__tests__/*.test.ts`; run with `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<name>.test.js`. Style: `import { test } from 'node:test'; import assert from 'node:assert';`, top-level `test(...)`, dependency injection via function args, `as any` for fixtures. No vitest/jest/describe.
- **Core build is CommonJS** (`tsc`, `module: commonjs`). Build with `./core.sh build` (or `cd core && npm run build`).
- **Never static-`import`/`require` `@anthropic-ai/claude-agent-sdk`.** It is ESM-only and breaks under CJS tsc. Use it ONLY through `core/src/sdk-runner.ts` (which already does the `new Function('m','return import(m)')` indirection). New code imports `createSdkRunner` from our `../sdk-runner`, never the SDK directly.
- **Do NOT change the `chokidar` pin (`^3.6.0`).**
- **Naming (verbatim):** feature = "Mission"; dataset id = `missions`; scheduled-job type = `mission-controller`; settings keys = `missionControllerEnabled` / `missionControllerIntervalMin` / `missionControllerMaxNudges` / `missionControllerModel`; default model = `claude-opus-4-8[1m]`.
- **Cross-node persistence = the data service ONLY.** Missions are stored via `getDataService()` on a `syncMode:'full'` dataset; requires `dataServiceEnabled` (default false) — when off, the store no-ops/returns empty and the controller logs `skipped`.
- **Worker/mission REST routes use the bare `{success,data}` / `{success,error}` envelope** (local `ok`/`fail` helpers), NOT `wrapResponse`.
- **MCP number/bool/array args may arrive as strings over the connector — coerce them.**
- **Autonomy boundary:** the controller NEVER auto-approves a `need_approval` gate or a material pivot (both → `status:'paused'`), and never performs an irreversible action itself. Every mission is processed in its own try/catch so one failure never aborts the tick.
- **Only the elected node acts** (reuse `amIMonitor()` from `core/src/monitor/stall-election.ts`).
- **Branch:** `feat/mission-controller`. Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `core/src/mission/mission-model.ts` (new) | Pure: types, `newMission`, `place`, `decideMission`, `planMissionNudge`, `ADJUST_SCHEMA`, `parseAdjustResult`. No IO. |
| `core/src/mission/mission-store.ts` (new) | Async cross-node store over `getDataService()` (dataset `missions`, `syncMode:'full'`) + helpers. `MissionDataPort` seam for tests. |
| `core/src/mission/mission-adjust.ts` (new) | The LLM adjust step via `createSdkRunner`; builds the prompt; parses the verdict. |
| `core/src/mission/mission-controller.ts` (new) | `runMissionTick(deps)` (generalizes the stall-monitor) + `registerMissionController(jobs)` + the real-deps wiring (executor read/start/drive). |
| `core/src/project-settings.ts` (modify) | Add the 4 `missionController*` fields. |
| `core/src/scheduler/scheduled-jobs.ts` (modify) | Seed the builtin job + lazy-register the handler. |
| `core/src/routes/core/mission.routes.ts` (new) | `createMissionRoutes(ctx)` — CRUD + controller status. |
| `core/src/routes/core/index.ts` (modify) | Register mission routes. |
| `core/src/routes/core/worker.routes.ts` (modify) | Mirror a bound mission's progress on `POST /worker/status`. |
| `core/src/mcp-server/tools/mission.ts` (new) | `MISSION_TOOL_DEFS` + `MISSION_HANDLERS`. |
| `core/src/mcp-server/tools/expanded.ts` (modify) | Spread mission tools into defs + handlers. |
| `core/src/mcp-server/configure.ts` (modify) | `TOOL_SCOPES` for mission tools. |
| `core/src/mcp-server/tools/guide.ts` (modify) | `guide("missions")` topic. |

---

### Task 1: Mission model — types + `newMission`

**Files:**
- Create: `core/src/mission/mission-model.ts`
- Test: `core/src/__tests__/mission-model.test.ts`

**Interfaces:**
- Produces: all the Mission types below; `newMission(input: NewMissionInput, now: number, genId: () => string): Mission`. Consumed by every later task.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-model.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { newMission } from '../mission/mission-model';

test('newMission fills defaults and starts active', () => {
  const m = newMission(
    { title: 'T', objective: 'Do X', ownerNode: 'gw4-1' },
    1000,
    () => 'mission_abc',
  );
  assert.strictEqual(m.id, 'mission_abc');
  assert.strictEqual(m.status, 'active');
  assert.strictEqual(m.env.isolation, 'cloud');
  assert.deepStrictEqual(m.env.resources, []);
  assert.deepStrictEqual(m.dependsOn, []);
  assert.deepStrictEqual(m.projects, []);
  assert.strictEqual(m.binding, null);
  assert.strictEqual(m.progress, null);
  assert.deepStrictEqual(m.control, { nudgeCount: 0, backoffStep: 0 });
  assert.strictEqual(m.ownerNode, 'gw4-1');
  assert.strictEqual(m.createdAt, 1000);
});

test('newMission honors provided env + dependsOn', () => {
  const m = newMission(
    { title: 'T', objective: 'O', ownerNode: 'gw4-1', dependsOn: ['mission_x'], env: { isolation: 'worktree', repo: 'lm-assist', resources: ['port:3000'] } },
    1, () => 'mission_y',
  );
  assert.strictEqual(m.env.isolation, 'worktree');
  assert.strictEqual(m.env.repo, 'lm-assist');
  assert.deepStrictEqual(m.env.resources, ['port:3000']);
  assert.deepStrictEqual(m.dependsOn, ['mission_x']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-model.test.js`
Expected: FAIL — `Cannot find module '../mission/mission-model'` (not implemented yet).

- [ ] **Step 3: Write minimal implementation**

`core/src/mission/mission-model.ts`:
```ts
/** Pure Mission model: types + constructors + decision/placement logic. No IO. */

export type MissionStatus = 'draft' | 'active' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed';
export type ExecutorKind = 'orchestrator' | 'worker';
export type Isolation = 'cloud' | 'worktree' | 'shared';

export interface MissionEnv {
  isolation: Isolation;
  host?: string;
  repo?: string;
  branch?: string;
  resources: string[];
  exclusive?: boolean;
}
export interface MissionBinding {
  sessionId: string | null;
  node: string | null;
  kind: ExecutorKind | null;
  boundAt?: number;
}
export interface MissionProgress { percent: number; summary: string; updatedAt: number; }
export interface MissionControl {
  lastTickAt?: number;
  lastNudgeAt?: number;
  nudgeCount: number;
  backoffStep: number;
  lastOutputCursor?: number;
  waitReason?: 'dependency' | 'resource';
  gaveUp?: boolean;
}
export interface MissionResult { at: number; ref: string; summary?: string; }
export interface MissionAdjustment { at: number; trigger: string; change: string; by: 'controller' | 'user'; }

export interface Mission {
  id: string;
  title: string;
  objective: string;
  plan?: string;
  nextSteps?: string[];
  projects: string[];
  dependsOn: string[];
  env: MissionEnv;
  binding: MissionBinding | null;
  progress: MissionProgress | null;
  control: MissionControl;
  results: MissionResult[];
  adjustments: MissionAdjustment[];
  status: MissionStatus;
  ownerNode: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewMissionInput {
  title: string;
  objective: string;
  ownerNode: string;
  projects?: string[];
  dependsOn?: string[];
  env?: Partial<MissionEnv>;
  plan?: string;
  nextSteps?: string[];
}

export function newMission(input: NewMissionInput, now: number, genId: () => string): Mission {
  return {
    id: genId(),
    title: input.title,
    objective: input.objective,
    plan: input.plan,
    nextSteps: input.nextSteps,
    projects: input.projects ?? [],
    dependsOn: input.dependsOn ?? [],
    env: {
      isolation: input.env?.isolation ?? 'cloud',
      host: input.env?.host,
      repo: input.env?.repo,
      branch: input.env?.branch,
      resources: input.env?.resources ?? [],
      exclusive: input.env?.exclusive,
    },
    binding: null,
    progress: null,
    control: { nudgeCount: 0, backoffStep: 0 },
    results: [],
    adjustments: [],
    status: 'active',
    ownerNode: input.ownerNode,
    createdAt: now,
    updatedAt: now,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-model.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-model.ts core/src/__tests__/mission-model.test.ts
git commit -m "feat(mission): mission model types + newMission"
```

---

### Task 2: Placement resolver — `place()`

**Files:**
- Modify: `core/src/mission/mission-model.ts`
- Test: `core/src/__tests__/mission-place.test.ts`

**Interfaces:**
- Consumes: `Mission` (Task 1).
- Produces: `PlacementDecision`; `place(m: Mission, all: Mission[]): PlacementDecision`. Consumed by the controller (Task 8).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-place.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { place, Mission } from '../mission/mission-model';

const base = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});

test('unmet dependency blocks placement', () => {
  const m = base({ id: 'a', dependsOn: ['b'] });
  const dep = base({ id: 'b', status: 'active' });
  assert.deepStrictEqual(place(m, [m, dep]), { go: false, reason: 'dependency', waitOn: ['b'] });
});

test('done dependency unblocks; cloud is isolated', () => {
  const m = base({ id: 'a', dependsOn: ['b'] });
  const dep = base({ id: 'b', status: 'done' });
  assert.deepStrictEqual(place(m, [m, dep]), { go: true, env: 'cloud' });
});

test('shared running resource on same host serializes', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  const holder = base({ id: 'z', status: 'active', binding: { sessionId: 's', node: 'h1', kind: 'worker' }, env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: false, reason: 'resource', conflictWith: 'z' });
});

test('paused non-exclusive holder does NOT block', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  const holder = base({ id: 'z', status: 'paused', env: { isolation: 'shared', host: 'h1', resources: ['db:main'] } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: true, env: 'shared', lease: 'db:main' });
});

test('exclusive resource is reserved even when holder paused', () => {
  const m = base({ id: 'a', env: { isolation: 'shared', host: 'h1', resources: ['oanda:live'] } });
  const holder = base({ id: 'z', status: 'paused', env: { isolation: 'shared', host: 'h1', resources: ['oanda:live'], exclusive: true } });
  assert.deepStrictEqual(place(m, [m, holder]), { go: false, reason: 'resource', conflictWith: 'z' });
});

test('worktree placement defaults branch to mission/<id>', () => {
  const m = base({ id: 'a', env: { isolation: 'worktree', host: 'h1', repo: 'lm-assist', resources: [] } });
  assert.deepStrictEqual(place(m, [m]), { go: true, env: 'worktree', host: 'h1', repo: 'lm-assist', branch: 'mission/a' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-place.test.js`
Expected: FAIL — `place` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/mission-model.ts`:
```ts
export type PlacementDecision =
  | { go: false; reason: 'dependency'; waitOn: string[] }
  | { go: false; reason: 'resource'; conflictWith: string }
  | { go: true; env: 'cloud' }
  | { go: true; env: 'worktree'; host: string; repo: string; branch: string }
  | { go: true; env: 'shared'; lease: string };

function isRunning(m: Mission): boolean {
  return m.status === 'active' && !!m.binding?.sessionId;
}

/** Resolve where a mission's executor may run: dependency gate → resource conflict → isolation. */
export function place(m: Mission, all: Mission[]): PlacementDecision {
  // 1) ordering gate — a dependency is met only if it exists AND is done.
  const unmet = m.dependsOn.filter((id) => {
    const dep = all.find((x) => x.id === id);
    return !dep || dep.status !== 'done';
  });
  if (unmet.length > 0) return { go: false, reason: 'dependency', waitOn: unmet };

  // 2) resource conflict — same host, same resource. A running holder always blocks;
  //    an exclusive resource (either side) is reserved even when its holder is idle/paused.
  for (const res of m.env.resources) {
    const holder = all.find(
      (a) =>
        a.id !== m.id &&
        a.env.host === m.env.host &&
        a.env.resources.includes(res) &&
        (isRunning(a) || a.env.exclusive === true || m.env.exclusive === true),
    );
    if (holder) return { go: false, reason: 'resource', conflictWith: holder.id };
  }

  // 3) isolate: cloud (separate VM) > worktree (branchable repo); else explicitly shared.
  if (m.env.isolation === 'cloud') return { go: true, env: 'cloud' };
  if (m.env.isolation === 'worktree') {
    return { go: true, env: 'worktree', host: m.env.host ?? '', repo: m.env.repo ?? '', branch: m.env.branch ?? `mission/${m.id}` };
  }
  return { go: true, env: 'shared', lease: m.env.resources.join(',') || m.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-place.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-model.ts core/src/__tests__/mission-place.test.ts
git commit -m "feat(mission): dependency-aware placement resolver"
```

---

### Task 3: Decision dispatch + nudge backoff — `decideMission()` + `planMissionNudge()`

**Files:**
- Modify: `core/src/mission/mission-model.ts`
- Test: `core/src/__tests__/mission-decide.test.ts`

**Interfaces:**
- Consumes: `Mission`, `MissionControl` (Task 1); `backoffMinutes` from `../monitor/stall-state`.
- Produces: `ExecutorState`, `ExecutorOutput`, `MissionDecision`; `decideMission(m, st): MissionDecision`; `MissionNudgeCfg`; `planMissionNudge(control, cfg, now): { action: 'nudge'|'wait'|'giveup'; control: MissionControl }`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-decide.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { decideMission, planMissionNudge, Mission, ExecutorState, MissionControl } from '../mission/mission-model';

const m = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});
const st = (over: Partial<ExecutorState>): ExecutorState =>
  ({ alive: true, serverStalled: false, gate: null, newOutput: null, idle: false, ...over });

test('bound + dead executor => rebind', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  assert.deepStrictEqual(decideMission(mission, st({ alive: false })), { kind: 'rebind' });
});
test('server stall => defer to stall-monitor', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  assert.deepStrictEqual(decideMission(mission, st({ serverStalled: true })), { kind: 'defer' });
});
test('gate => gate', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  assert.deepStrictEqual(decideMission(mission, st({ gate: { taskId: 't1', reason: 'approve?' } })), { kind: 'gate', reason: 'approve?' });
});
test('new output => adjust', () => {
  const mission = m({ binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const out = { cursor: 5, messages: ['did thing'], results: [] };
  assert.deepStrictEqual(decideMission(mission, st({ newOutput: out })), { kind: 'adjust', output: out });
});
test('unbound mission => place (start)', () => {
  assert.deepStrictEqual(decideMission(m({}), st({ alive: false, idle: true })), { kind: 'place' });
});

test('planMissionNudge: first call nudges', () => {
  const r = planMissionNudge({ nudgeCount: 0, backoffStep: 0 }, { intervalMin: 5, maxNudges: 6 }, 1000);
  assert.strictEqual(r.action, 'nudge');
  assert.strictEqual(r.control.nudgeCount, 1);
  assert.strictEqual(r.control.lastNudgeAt, 1000);
});
test('planMissionNudge: within backoff waits', () => {
  const c: MissionControl = { nudgeCount: 1, backoffStep: 1, lastNudgeAt: 1000 };
  // backoffMinutes(1,5)=5min=300000ms; now just after => wait
  const r = planMissionNudge(c, { intervalMin: 5, maxNudges: 6 }, 1000 + 60_000);
  assert.strictEqual(r.action, 'wait');
});
test('planMissionNudge: at cap gives up', () => {
  const c: MissionControl = { nudgeCount: 6, backoffStep: 6, lastNudgeAt: 0 };
  const r = planMissionNudge(c, { intervalMin: 5, maxNudges: 6 }, 9_999_999);
  assert.strictEqual(r.action, 'giveup');
  assert.strictEqual(r.control.gaveUp, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-decide.test.js`
Expected: FAIL — `decideMission`/`planMissionNudge` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/mission-model.ts`:
```ts
import { backoffMinutes } from '../monitor/stall-state';

export interface ExecutorOutput { cursor: number; messages: string[]; results: Array<{ ref: string; summary?: string }>; }
export interface ExecutorState {
  alive: boolean;
  serverStalled: boolean;
  gate: { taskId: string; reason: string } | null;
  newOutput: ExecutorOutput | null;
  idle: boolean;
}

export type MissionDecision =
  | { kind: 'rebind' }
  | { kind: 'defer' }
  | { kind: 'gate'; reason: string }
  | { kind: 'adjust'; output: ExecutorOutput }
  | { kind: 'place' };

/** Pure phase dispatch for one mission given its executor's state. */
export function decideMission(m: Mission, st: ExecutorState): MissionDecision {
  const bound = !!m.binding?.sessionId;
  if (bound && !st.alive) return { kind: 'rebind' };
  if (st.serverStalled) return { kind: 'defer' };
  if (st.gate) return { kind: 'gate', reason: st.gate.reason };
  if (st.newOutput) return { kind: 'adjust', output: st.newOutput };
  return { kind: 'place' };
}

export interface MissionNudgeCfg { intervalMin: number; maxNudges: number; }

/** Capped, widening backoff for the parked-executor `continue` nudge (reuses backoffMinutes). */
export function planMissionNudge(
  control: MissionControl,
  cfg: MissionNudgeCfg,
  now: number,
): { action: 'nudge' | 'wait' | 'giveup'; control: MissionControl } {
  if (control.gaveUp) return { action: 'wait', control };
  if (control.nudgeCount >= cfg.maxNudges) return { action: 'giveup', control: { ...control, gaveUp: true } };
  if (control.nudgeCount > 0) {
    const dueAt = (control.lastNudgeAt ?? 0) + backoffMinutes(control.backoffStep, cfg.intervalMin) * 60_000;
    if (now < dueAt) return { action: 'wait', control };
  }
  return { action: 'nudge', control: { ...control, nudgeCount: control.nudgeCount + 1, lastNudgeAt: now, backoffStep: control.backoffStep + 1 } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-decide.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-model.ts core/src/__tests__/mission-decide.test.ts
git commit -m "feat(mission): per-mission decision dispatch + nudge backoff"
```

---

### Task 4: Adjust schema + parser — `ADJUST_SCHEMA` + `parseAdjustResult()`

**Files:**
- Modify: `core/src/mission/mission-model.ts`
- Test: `core/src/__tests__/mission-adjust-parse.test.ts`

**Interfaces:**
- Produces: `AdjustVerdict`, `AdjustResult`, `ADJUST_SCHEMA`, `parseAdjustResult(raw: string): AdjustResult`. Consumed by Task 6 (mission-adjust) and Task 8 (controller).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-adjust-parse.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { parseAdjustResult } from '../mission/mission-model';

test('parses a valid verdict', () => {
  const r = parseAdjustResult('{"verdict":"done","nextDirective":"wrap up","isMaterialPivot":false,"reason":"objective met"}');
  assert.strictEqual(r.verdict, 'done');
  assert.strictEqual(r.nextDirective, 'wrap up');
  assert.strictEqual(r.isMaterialPivot, false);
});
test('extracts JSON embedded in prose', () => {
  const r = parseAdjustResult('Here is my decision:\n{"verdict":"revise","nextDirective":"try Y","isMaterialPivot":true,"revisedObjective":"Y"}\nThanks');
  assert.strictEqual(r.verdict, 'revise');
  assert.strictEqual(r.revisedObjective, 'Y');
  assert.strictEqual(r.isMaterialPivot, true);
});
test('garbage defaults to continue', () => {
  const r = parseAdjustResult('not json at all');
  assert.strictEqual(r.verdict, 'continue');
  assert.strictEqual(r.nextDirective, 'continue');
});
test('unknown verdict falls back to continue; missing directive defaults', () => {
  const r = parseAdjustResult('{"verdict":"explode"}');
  assert.strictEqual(r.verdict, 'continue');
  assert.strictEqual(r.nextDirective, 'continue');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-adjust-parse.test.js`
Expected: FAIL — `parseAdjustResult` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/mission-model.ts`:
```ts
export type AdjustVerdict = 'continue' | 'revise' | 'done' | 'blocked' | 'gate';
export interface AdjustResult {
  verdict: AdjustVerdict;
  revisedObjective: string | null;
  revisedNextSteps: string[] | null;
  isMaterialPivot: boolean;
  nextDirective: string;
  reason: string;
}

export const ADJUST_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['continue', 'revise', 'done', 'blocked', 'gate'] },
    revisedObjective: { type: ['string', 'null'] },
    revisedNextSteps: { type: ['array', 'null'], items: { type: 'string' } },
    isMaterialPivot: { type: 'boolean' },
    nextDirective: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'nextDirective'],
} as const;

const VERDICTS = new Set<AdjustVerdict>(['continue', 'revise', 'done', 'blocked', 'gate']);
const DEFAULT_ADJUST: AdjustResult = {
  verdict: 'continue', revisedObjective: null, revisedNextSteps: null,
  isMaterialPivot: false, nextDirective: 'continue', reason: 'default (unparseable adjust result)',
};

function extractJson(raw: string): string {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('no json');
  return raw.slice(s, e + 1);
}

/** Parse the adjust LLM output; never throws — defaults to a safe `continue`. */
export function parseAdjustResult(raw: string): AdjustResult {
  try {
    const j = JSON.parse(extractJson(raw)) as Record<string, unknown>;
    const verdict = VERDICTS.has(j.verdict as AdjustVerdict) ? (j.verdict as AdjustVerdict) : 'continue';
    const directive = typeof j.nextDirective === 'string' && j.nextDirective.trim() ? (j.nextDirective as string) : 'continue';
    return {
      verdict,
      revisedObjective: typeof j.revisedObjective === 'string' ? (j.revisedObjective as string) : null,
      revisedNextSteps: Array.isArray(j.revisedNextSteps) ? (j.revisedNextSteps as unknown[]).filter((x) => typeof x === 'string') as string[] : null,
      isMaterialPivot: j.isMaterialPivot === true,
      nextDirective: directive,
      reason: typeof j.reason === 'string' ? (j.reason as string) : '',
    };
  } catch {
    return { ...DEFAULT_ADJUST };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-adjust-parse.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-model.ts core/src/__tests__/mission-adjust-parse.test.ts
git commit -m "feat(mission): adjust-result schema + defensive parser"
```

---

### Task 5: Mission store over the data service

**Files:**
- Create: `core/src/mission/mission-store.ts`
- Test: `core/src/__tests__/mission-store.test.ts`

**Interfaces:**
- Consumes: `Mission` (Task 1); `getDataService` from `../data/data-service`; `getHubConfig` from `../hub-client/hub-config`.
- Produces: `MissionDataPort`; async `getMission`/`listMissions`/`listActiveMissions`/`putMission`/`deleteMission`/`findMissionBySession`/`bindExecutor`/`recordAdjustment`/`mirrorProgress`, each taking an optional `port` (defaults to the live data-service adapter). Consumed by the controller (Task 8), routes (Task 9), and worker mirroring (Task 10).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-store.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import {
  MissionDataPort, getMission, listMissions, listActiveMissions, putMission,
  bindExecutor, recordAdjustment, mirrorProgress, findMissionBySession,
} from '../mission/mission-store';

function fakePort(): MissionDataPort {
  const map = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    put: async (m) => { map.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id) => { map.delete(id); },
  };
}
const mk = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});

test('put + get round-trip', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a', objective: 'X' }), p);
  const got = await getMission('a', p);
  assert.strictEqual(got?.objective, 'X');
});
test('listActiveMissions filters to active+waiting', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a', status: 'active' }), p);
  await putMission(mk({ id: 'b', status: 'done' }), p);
  await putMission(mk({ id: 'c', status: 'waiting' }), p);
  const ids = (await listActiveMissions(p)).map((m) => m.id).sort();
  assert.deepStrictEqual(ids, ['a', 'c']);
});
test('bindExecutor sets binding', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a' }), p);
  await bindExecutor('a', { sessionId: 'sid1', node: 'h', kind: 'worker' }, p);
  assert.strictEqual((await getMission('a', p))?.binding?.sessionId, 'sid1');
});
test('mirrorProgress + recordAdjustment append', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a' }), p);
  await mirrorProgress('a', { percent: 50, summary: 'half', updatedAt: 1 }, [{ at: 1, ref: 'r1' }], p);
  await recordAdjustment('a', { at: 2, trigger: 'revise', change: 'narrowed', by: 'controller' }, p);
  const got = await getMission('a', p);
  assert.strictEqual(got?.progress?.percent, 50);
  assert.strictEqual(got?.results.length, 1);
  assert.strictEqual(got?.adjustments.length, 1);
});
test('findMissionBySession matches binding', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a', binding: { sessionId: 'sX', node: 'h', kind: 'worker' } }), p);
  assert.strictEqual((await findMissionBySession('sX', p))?.id, 'a');
  assert.strictEqual(await findMissionBySession('nope', p), null);
});
test('listMissions returns all', async () => {
  const p = fakePort();
  await putMission(mk({ id: 'a' }), p);
  await putMission(mk({ id: 'b' }), p);
  assert.strictEqual((await listMissions(p)).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-store.test.js`
Expected: FAIL — `../mission/mission-store` not found.

- [ ] **Step 3: Write minimal implementation**

`core/src/mission/mission-store.ts`:
```ts
/** Cross-node mission store backed by the data service (dataset `missions`, syncMode:'full'). */
import type { Mission, MissionBinding, MissionProgress, MissionResult, MissionAdjustment } from './mission-model';
import { getDataService } from '../data/data-service';
import type { CallCtx, DataRecord } from '../data/data-service';
import { getHubConfig } from '../hub-client/hub-config';

const DATASET = 'missions';

/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export interface MissionDataPort {
  isEnabled(): boolean;
  get(id: string): Promise<Mission | null>;
  list(): Promise<Mission[]>;
  put(m: Mission): Promise<void>;
  del(id: string): Promise<void>;
}

function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

function missionToRecord(m: Mission): DataRecord {
  const now = new Date().toISOString();
  return { id: m.id, version: 0, fields: { ...m } as Record<string, unknown>, createdAt: now, updatedAt: now };
}
function recordToMission(fields: Record<string, unknown>): Mission {
  return fields as unknown as Mission;
}

let ensured = false;
async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (ensured) return;
  try {
    await svc.createDataset(systemCtx(), {
      id: DATASET, backend: 'cache', title: 'Missions',
      visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' },
    } as any);
  } catch { /* already exists — fine */ }
  ensured = true;
}

/** The live adapter over getDataService(). dataServiceEnabled off => isEnabled() false => no-op/empty. */
function livePort(): MissionDataPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    get: async (id) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return null;
      await ensureDataset(svc);
      const r = await svc.get(systemCtx(), DATASET, id);
      return r.ok && r.value ? recordToMission(r.value.fields) : null;
    },
    list: async () => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      await ensureDataset(svc);
      const r = await svc.query(systemCtx(), DATASET, { limit: 10000 } as any);
      return r.ok ? r.value.records.map((rec) => recordToMission(rec.fields)) : [];
    },
    put: async (m) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureDataset(svc);
      await svc.put(systemCtx(), DATASET, missionToRecord(m));
    },
    del: async (id) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureDataset(svc);
      await svc.del(systemCtx(), DATASET, id);
    },
  };
}

let _default: MissionDataPort | null = null;
function defaultPort(): MissionDataPort { return _default ?? (_default = livePort()); }

/** This node's id, for stamping `ownerNode` on new missions. */
export function thisNode(): string { return getHubConfig().gatewayId ?? 'unknown'; }

export async function getMission(id: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return port.get(id);
}
export async function listMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  return port.list();
}
export async function listActiveMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  return (await port.list()).filter((m) => m.status === 'active' || m.status === 'waiting');
}
export async function putMission(m: Mission, port: MissionDataPort = defaultPort()): Promise<Mission> {
  m.updatedAt = Date.now();
  await port.put(m);
  return m;
}
export async function deleteMission(id: string, port: MissionDataPort = defaultPort()): Promise<void> {
  await port.del(id);
}
export async function findMissionBySession(sessionId: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return (await port.list()).find((m) => m.binding?.sessionId === sessionId) ?? null;
}
export async function bindExecutor(id: string, binding: MissionBinding, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.binding = { ...binding, boundAt: Date.now() };
  return putMission(m, port);
}
export async function recordAdjustment(id: string, adj: MissionAdjustment, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.adjustments.push(adj);
  return putMission(m, port);
}
export async function mirrorProgress(id: string, progress: MissionProgress, results: MissionResult[] = [], port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  const m = await port.get(id);
  if (!m) return null;
  m.progress = progress;
  if (results.length) m.results.push(...results);
  return putMission(m, port);
}
```

> Note: `CallCtx`/`DataRecord` are exported from `core/src/data/data-service.ts` (verified). If `DataRecord` is re-exported from `../data/types` instead, import it from there — confirm with `grep "export.*DataRecord" core/src/data/*.ts` before writing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-store.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-store.ts core/src/__tests__/mission-store.test.ts
git commit -m "feat(mission): cross-node mission store over data service"
```

---

### Task 6: The adjust step (LLM) — `mission-adjust.ts`

**Files:**
- Create: `core/src/mission/mission-adjust.ts`
- Test: `core/src/__tests__/mission-adjust.test.ts`

**Interfaces:**
- Consumes: `Mission`, `ExecutorOutput`, `AdjustResult`, `ADJUST_SCHEMA`, `parseAdjustResult` (Tasks 1/3/4); `createSdkRunner` from `../sdk-runner`.
- Produces: `AdjustRunner` (injectable), `buildAdjustPrompt(m, out): string`, `runAdjust(m, out, model, runner?): Promise<AdjustResult>`. Consumed by the controller (Task 8).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-adjust.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Mission, ExecutorOutput } from '../mission/mission-model';
import { buildAdjustPrompt, runAdjust, AdjustRunner } from '../mission/mission-adjust';

const mission: Mission = {
  id: 'm', title: 't', objective: 'Ship the widget', plan: 'step1; step2', nextSteps: ['do step2'],
  projects: [], dependsOn: [], env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0,
};
const out: ExecutorOutput = { cursor: 3, messages: ['finished step1, blocked on auth'], results: [{ ref: 'pr#1', summary: 'opened PR' }] };

test('buildAdjustPrompt includes objective and new output', () => {
  const p = buildAdjustPrompt(mission, out);
  assert.match(p, /Ship the widget/);
  assert.match(p, /finished step1, blocked on auth/);
  assert.match(p, /pr#1/);
});
test('runAdjust returns the parsed verdict from the runner', async () => {
  const fake: AdjustRunner = { execute: async () => ({ success: true, result: '{"verdict":"revise","nextDirective":"unblock auth","isMaterialPivot":false,"revisedObjective":null}' }) };
  const r = await runAdjust(mission, out, 'claude-opus-4-8[1m]', fake);
  assert.strictEqual(r.verdict, 'revise');
  assert.strictEqual(r.nextDirective, 'unblock auth');
});
test('runAdjust defaults to continue when the runner fails', async () => {
  const fake: AdjustRunner = { execute: async () => ({ success: false, result: '' }) };
  assert.strictEqual((await runAdjust(mission, out, 'm', fake)).verdict, 'continue');
});
test('runAdjust defaults to continue when the runner throws', async () => {
  const fake: AdjustRunner = { execute: async () => { throw new Error('boom'); } };
  assert.strictEqual((await runAdjust(mission, out, 'm', fake)).verdict, 'continue');
});
test('runAdjust passes adaptive thinking + high effort + json schema', async () => {
  let seen: any = null;
  const fake: AdjustRunner = { execute: async (_p, opts) => { seen = opts; return { success: true, result: '{"verdict":"continue","nextDirective":"go"}' }; } };
  await runAdjust(mission, out, 'claude-opus-4-8[1m]', fake);
  assert.deepStrictEqual(seen.extendedThinking, { enabled: true, type: 'adaptive' });
  assert.strictEqual(seen.outputConfig.effort, 'high');
  assert.strictEqual(seen.outputConfig.format.type, 'json_schema');
  assert.strictEqual(seen.model, 'claude-opus-4-8[1m]');
  assert.strictEqual(seen.maxTurns, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-adjust.test.js`
Expected: FAIL — `../mission/mission-adjust` not found.

- [ ] **Step 3: Write minimal implementation**

`core/src/mission/mission-adjust.ts`:
```ts
/** The Mission Controller's "adjust" reasoning step: one-shot, max-thinking LLM call. */
import type { Mission, ExecutorOutput, AdjustResult } from './mission-model';
import { ADJUST_SCHEMA, parseAdjustResult } from './mission-model';
import { createSdkRunner } from '../sdk-runner';

/** Minimal runner surface so tests can inject a fake (real impl = createSdkRunner). */
export interface AdjustRunner {
  execute(prompt: string, opts: Record<string, unknown>): Promise<{ result: string; success: boolean; error?: string }>;
}

export function buildAdjustPrompt(m: Mission, out: ExecutorOutput): string {
  return [
    `You are the Mission Controller's reasoning step. Read the mission and the executor's NEW output, then decide the next action as JSON.`,
    `# Mission objective\n${m.objective}`,
    m.plan ? `# Current plan\n${m.plan}` : '',
    m.nextSteps && m.nextSteps.length ? `# Next steps\n- ${m.nextSteps.join('\n- ')}` : '',
    `# NEW executor output since last check\n${out.messages.join('\n')}`,
    out.results.length ? `# New results\n${out.results.map((r) => `- ${r.ref}: ${r.summary ?? ''}`).join('\n')}` : '',
    [
      `# Decide — return ONLY JSON matching:`,
      `{ "verdict": "continue|revise|done|blocked|gate", "revisedObjective": string|null, "revisedNextSteps": string[]|null, "isMaterialPivot": boolean, "nextDirective": string, "reason": string }`,
      `- "done" ONLY if the objective is demonstrably met by the results.`,
      `- "revise" to refine the objective/plan; set isMaterialPivot=true ONLY for a direction change away from the original objective.`,
      `- "gate" if a human decision is required; "blocked" if stuck with no path forward.`,
      `- nextDirective: the exact instruction to send the executor next.`,
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export async function runAdjust(
  m: Mission,
  out: ExecutorOutput,
  model: string,
  runner?: AdjustRunner,
): Promise<AdjustResult> {
  const r: AdjustRunner = runner ?? (createSdkRunner({ trackChanges: false }) as unknown as AdjustRunner);
  try {
    const res = await r.execute(buildAdjustPrompt(m, out), {
      model,
      maxTurns: 1,
      extendedThinking: { enabled: true, type: 'adaptive' },
      outputConfig: { effort: 'high', format: { type: 'json_schema', schema: ADJUST_SCHEMA } },
    });
    if (!res.success) return parseAdjustResult('');
    return parseAdjustResult(res.result);
  } catch {
    return parseAdjustResult('');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-adjust.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-adjust.ts core/src/__tests__/mission-adjust.test.ts
git commit -m "feat(mission): adjust reasoning step (opus-4.8 max thinking)"
```

---

### Task 7: Project-settings — `missionController*` fields

**Files:**
- Modify: `core/src/project-settings.ts` (interface ~`:31`, DEFAULTS ~`:51`, read guard ~`:85`, write guard ~`:113`)
- Test: `core/src/__tests__/mission-settings.test.ts`

**Interfaces:**
- Produces: `ProjectSettings.missionControllerEnabled|missionControllerIntervalMin|missionControllerMaxNudges|missionControllerModel` with defaults `true / 5 / 6 / 'claude-opus-4-8[1m]'`. Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-settings.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULTS } from '../project-settings';

test('mission controller defaults exist', () => {
  assert.strictEqual(DEFAULTS.missionControllerEnabled, true);
  assert.strictEqual(DEFAULTS.missionControllerIntervalMin, 5);
  assert.strictEqual(DEFAULTS.missionControllerMaxNudges, 6);
  assert.strictEqual(DEFAULTS.missionControllerModel, 'claude-opus-4-8[1m]');
});
```

> If `DEFAULTS` is not currently exported from `project-settings.ts`, add `export` to its declaration as part of this task (it is needed by the test).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-settings.test.js`
Expected: FAIL — properties missing on `DEFAULTS` (or `DEFAULTS` not exported).

- [ ] **Step 3: Write minimal implementation**

In the `ProjectSettings` interface (after the `autoResume*` block ~`:38`):
```ts
  /** Enable the super Mission Controller scheduled job. Default true. */
  missionControllerEnabled: boolean;
  /** Base interval (minutes) between Mission Controller ticks. Default 5. */
  missionControllerIntervalMin: number;
  /** Max `continue` nudges to a parked mission before marking it blocked. Default 6. */
  missionControllerMaxNudges: number;
  /** Model for the adjust reasoning step. Default 'claude-opus-4-8[1m]'. */
  missionControllerModel: string;
```

In `DEFAULTS` (after the `autoResume*` defaults ~`:55`):
```ts
  missionControllerEnabled: true,
  missionControllerIntervalMin: 5,
  missionControllerMaxNudges: 6,
  missionControllerModel: 'claude-opus-4-8[1m]',
```

In `getProjectSettings` read guards (after the `autoResume*` guards ~`:88`):
```ts
      missionControllerEnabled: typeof data.missionControllerEnabled === 'boolean' ? data.missionControllerEnabled : DEFAULTS.missionControllerEnabled,
      missionControllerIntervalMin: typeof data.missionControllerIntervalMin === 'number' ? data.missionControllerIntervalMin : DEFAULTS.missionControllerIntervalMin,
      missionControllerMaxNudges: typeof data.missionControllerMaxNudges === 'number' ? data.missionControllerMaxNudges : DEFAULTS.missionControllerMaxNudges,
      missionControllerModel: typeof data.missionControllerModel === 'string' ? data.missionControllerModel : DEFAULTS.missionControllerModel,
```

In `saveProjectSettings` write guards (after the `autoResume*` guards ~`:116`):
```ts
    missionControllerEnabled: typeof partial.missionControllerEnabled === 'boolean' ? partial.missionControllerEnabled : current.missionControllerEnabled,
    missionControllerIntervalMin: typeof partial.missionControllerIntervalMin === 'number' ? partial.missionControllerIntervalMin : current.missionControllerIntervalMin,
    missionControllerMaxNudges: typeof partial.missionControllerMaxNudges === 'number' ? partial.missionControllerMaxNudges : current.missionControllerMaxNudges,
    missionControllerModel: typeof partial.missionControllerModel === 'string' ? partial.missionControllerModel : current.missionControllerModel,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-settings.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add core/src/project-settings.ts core/src/__tests__/mission-settings.test.ts
git commit -m "feat(mission): missionController* project settings"
```

---

### Task 8: Mission Controller tick + handler registration

**Files:**
- Create: `core/src/mission/mission-controller.ts`
- Test: `core/src/__tests__/mission-controller.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7; `cloudStart`/`cloudDrive`/`cloudRead`/`cloudListAccount` (`../terminal/ccr-cloud`); `amIMonitor` (`../monitor/stall-election`); `getProjectSettings` (`../project-settings`); `classifyScreenState`-equivalent for server-stall (reuse the monitor's classifier; see note).
- Produces: `MissionTickDeps`, `runMissionTick(deps): Promise<{acted: string[]; skipped: boolean; isMonitor: boolean}>`, `registerMissionController(jobs)`. Consumed by the scheduler (Task 9).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-controller.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Mission, ExecutorState, AdjustResult, PlacementDecision, MissionBinding } from '../mission/mission-model';
import { runMissionTick, MissionTickDeps } from '../mission/mission-controller';

const mk = (over: Partial<Mission>): Mission => ({
  id: 'm', title: 't', objective: 'o', projects: [], dependsOn: [],
  env: { isolation: 'cloud', resources: [] }, binding: null, progress: null,
  control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
  status: 'active', ownerNode: 'gw4-1', createdAt: 0, updatedAt: 0, ...over,
});
const deadState: ExecutorState = { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };

function deps(over: Partial<MissionTickDeps> & { missions: Mission[] }): MissionTickDeps {
  const saved: Record<string, Mission> = {};
  return {
    now: 1_000_000,
    cfg: { intervalMin: 5, maxNudges: 6, model: 'm' },
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'self' }),
    listAll: async () => over.missions,
    readExecutor: async () => deadState,
    adjust: async (): Promise<AdjustResult> => ({ verdict: 'continue', revisedObjective: null, revisedNextSteps: null, isMaterialPivot: false, nextDirective: 'continue', reason: '' }),
    startExecutor: async (): Promise<MissionBinding> => ({ sessionId: 'new-sid', node: 'h', kind: 'worker' }),
    drive: async () => {},
    save: async (m) => { saved[m.id] = m; (deps as any)._saved = saved; },
    ...over,
  };
}

test('non-monitor node skips entirely', async () => {
  let started = 0;
  const d = deps({ missions: [mk({ id: 'a' })], amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }), startExecutor: async () => { started++; return { sessionId: 's', node: 'h', kind: 'worker' }; } });
  const r = await runMissionTick(d);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(started, 0);
});

test('unbound mission gets started (placement go)', async () => {
  const saved: Record<string, Mission> = {};
  const d = deps({ missions: [mk({ id: 'a' })], save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].binding?.sessionId, 'new-sid');
  assert.strictEqual(saved['a'].status, 'active');
});

test('unmet dependency parks mission as waiting', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', dependsOn: ['b'] });
  const b = mk({ id: 'b', status: 'active' });
  const d = deps({ missions: [a, b], save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'waiting');
  assert.strictEqual(saved['a'].control.waitReason, 'dependency');
});

test('bound dead executor is rebound', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 'old', node: 'h', kind: 'worker' } });
  const d = deps({ missions: [a], readExecutor: async () => deadState, save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].binding?.sessionId, 'new-sid');
});

test('new output -> adjust done marks done', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const d = deps({
    missions: [a],
    readExecutor: async () => ({ alive: true, serverStalled: false, gate: null, idle: false, newOutput: { cursor: 2, messages: ['done it'], results: [] } }),
    adjust: async () => ({ verdict: 'done', revisedObjective: null, revisedNextSteps: null, isMaterialPivot: false, nextDirective: 'x', reason: 'met' }),
    save: async (m) => { saved[m.id] = m; },
  });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'done');
});

test('material pivot pauses without driving', async () => {
  const saved: Record<string, Mission> = {};
  let drove = 0;
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const d = deps({
    missions: [a],
    readExecutor: async () => ({ alive: true, serverStalled: false, gate: null, idle: false, newOutput: { cursor: 2, messages: ['hmm'], results: [] } }),
    adjust: async () => ({ verdict: 'revise', revisedObjective: 'totally new', revisedNextSteps: null, isMaterialPivot: true, nextDirective: 'go', reason: 'pivot' }),
    drive: async () => { drove++; },
    save: async (m) => { saved[m.id] = m; },
  });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'paused');
  assert.strictEqual(drove, 0);
  assert.strictEqual(saved['a'].adjustments.length, 1);
});

test('gate pauses the mission', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const d = deps({ missions: [a], readExecutor: async () => ({ alive: true, serverStalled: false, gate: { taskId: 't', reason: 'approve?' }, newOutput: null, idle: true }), save: async (m) => { saved[m.id] = m; } });
  await runMissionTick(d);
  assert.strictEqual(saved['a'].status, 'paused');
});

test('one mission throwing does not abort the tick', async () => {
  const saved: Record<string, Mission> = {};
  const a = mk({ id: 'a', binding: { sessionId: 's', node: 'h', kind: 'worker' } });
  const b = mk({ id: 'b' });
  const d = deps({
    missions: [a, b],
    readExecutor: async (m) => { if (m.id === 'a') throw new Error('boom'); return deadState; },
    save: async (m) => { saved[m.id] = m; },
  });
  const r = await runMissionTick(d);
  assert.ok(r.acted.includes('b'));
  assert.strictEqual(saved['b'].binding?.sessionId, 'new-sid');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-controller.test.js`
Expected: FAIL — `../mission/mission-controller` not found.

- [ ] **Step 3: Write minimal implementation**

`core/src/mission/mission-controller.ts`:
```ts
/** The super Mission Controller tick: election → per-mission liveness/adjust/placement. */
import {
  Mission, MissionBinding, ExecutorState, ExecutorOutput, AdjustResult, PlacementDecision,
  decideMission, place, planMissionNudge,
} from './mission-model';
import {
  listMissions, putMission, bindExecutor,
} from './mission-store';
import { runAdjust } from './mission-adjust';
import { getProjectSettings } from '../project-settings';
import { amIMonitor } from '../monitor/stall-election';
import { cloudStart, cloudDrive, cloudRead, cloudListAccount } from '../terminal/ccr-cloud';

export interface MissionTickDeps {
  now: number;
  cfg: { intervalMin: number; maxNudges: number; model: string };
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  listAll: () => Promise<Mission[]>;
  readExecutor: (m: Mission) => Promise<ExecutorState>;
  adjust: (m: Mission, out: ExecutorOutput) => Promise<AdjustResult>;
  startExecutor: (m: Mission, decision: PlacementDecision) => Promise<MissionBinding>;
  drive: (m: Mission, directive: string) => Promise<void>;
  save: (m: Mission) => Promise<void>;
}

function setWaiting(m: Mission, pd: Extract<PlacementDecision, { go: false }>): void {
  m.status = 'waiting';
  m.control.waitReason = pd.reason;
}
function addAdjustment(m: Mission, now: number, trigger: string, change: string): void {
  m.adjustments.push({ at: now, trigger, change, by: 'controller' });
}

async function processMission(m: Mission, all: Mission[], deps: MissionTickDeps): Promise<void> {
  m.control.lastTickAt = deps.now;
  const bound = !!m.binding?.sessionId;
  const st: ExecutorState = bound
    ? await deps.readExecutor(m)
    : { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const decision = decideMission(m, st);

  if (decision.kind === 'defer') { await deps.save(m); return; }

  if (decision.kind === 'gate') {
    m.status = 'paused';
    addAdjustment(m, deps.now, 'gate', `need_approval: ${decision.reason}`);
    await deps.save(m);
    return;
  }

  if (decision.kind === 'rebind') {
    const pd = place(m, all);
    if (!pd.go) { setWaiting(m, pd); await deps.save(m); return; }
    m.binding = await deps.startExecutor(m, pd);
    m.status = 'active';
    await deps.save(m);
    return;
  }

  if (decision.kind === 'adjust') {
    // fresh progress → reset the parked-nudge backoff
    m.control.nudgeCount = 0;
    m.control.backoffStep = 0;
    m.control.gaveUp = false;
    m.control.lastOutputCursor = decision.output.cursor;
    const res = await deps.adjust(m, decision.output);
    if (res.verdict === 'done') { m.status = 'done'; await deps.save(m); return; }
    if (res.verdict === 'blocked') { m.status = 'blocked'; addAdjustment(m, deps.now, 'blocked', res.reason); await deps.save(m); return; }
    if (res.verdict === 'gate') { m.status = 'paused'; addAdjustment(m, deps.now, 'gate', res.reason); await deps.save(m); return; }
    if (res.verdict === 'revise' && res.isMaterialPivot) {
      m.status = 'paused';
      addAdjustment(m, deps.now, 'material-pivot', res.reason);
      await deps.save(m);
      return; // gate the pivot — do NOT drive
    }
    if (res.verdict === 'revise') {
      if (res.revisedObjective) m.objective = res.revisedObjective;
      if (res.revisedNextSteps) m.nextSteps = res.revisedNextSteps;
      addAdjustment(m, deps.now, 'revise', res.reason);
    }
    await deps.drive(m, res.nextDirective);
    await deps.save(m);
    return;
  }

  // decision.kind === 'place' — start (unbound) or nudge (parked)
  const pd = place(m, all);
  if (!pd.go) { setWaiting(m, pd); await deps.save(m); return; }
  if (m.status === 'waiting') m.status = 'active'; // unblocked
  if (!bound) {
    m.binding = await deps.startExecutor(m, pd);
    m.status = 'active';
    await deps.save(m);
    return;
  }
  const np = planMissionNudge(m.control, { intervalMin: deps.cfg.intervalMin, maxNudges: deps.cfg.maxNudges }, deps.now);
  m.control = np.control;
  if (np.action === 'giveup') { m.status = 'blocked'; await deps.save(m); return; }
  if (np.action === 'nudge') { await deps.drive(m, 'continue'); }
  await deps.save(m);
}

export async function runMissionTick(deps: MissionTickDeps): Promise<{ acted: string[]; skipped: boolean; isMonitor: boolean }> {
  const { isMonitor } = await deps.amMonitor();
  if (!isMonitor) return { acted: [], skipped: true, isMonitor: false };
  const all = await deps.listAll();
  const active = all.filter((m) => m.status === 'active' || m.status === 'waiting');
  const acted: string[] = [];
  for (const m of active) {
    try {
      await processMission(m, all, deps);
      acted.push(m.id);
    } catch (e) {
      // per-mission isolation: never abort the tick for one mission's failure
      console.error(`[mission-controller] mission ${m.id} failed:`, (e as Error).message);
    }
  }
  return { acted, skipped: false, isMonitor: true };
}

// --- Real-deps wiring (cloud executors end-to-end; native start is phase-2, see spec §8) ---

const SERVER_STALL = /overloaded|rate.?limit|server error|529|503|502|500/i;

async function readCloudExecutor(m: Mission): Promise<ExecutorState> {
  const sid = m.binding?.sessionId;
  if (!sid) return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const account = await cloudListAccount(100).catch(() => [] as Array<{ sid: string; status: string }>);
  const live = account.find((a) => a.sid === sid);
  if (!live) return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const read = await cloudRead({ sid, lastN: 20 }).catch(() => ({ messages: [] as Array<{ text: string }>, pendingQuestion: null as unknown }));
  const cursor = read.messages.length;
  const prevCursor = m.control.lastOutputCursor ?? 0;
  const lastText = read.messages.length ? read.messages[read.messages.length - 1].text : '';
  const serverStalled = SERVER_STALL.test(lastText);
  const gate = read.pendingQuestion ? { taskId: 'cloud', reason: 'pending question / approval' } : null;
  const hasNew = cursor > prevCursor;
  const newOutput: ExecutorOutput | null = hasNew
    ? { cursor, messages: read.messages.slice(prevCursor).map((x) => x.text), results: [] }
    : null;
  return { alive: true, serverStalled, gate, newOutput, idle: !hasNew };
}

async function startCloudExecutor(m: Mission, decision: PlacementDecision): Promise<MissionBinding> {
  if (decision.go && decision.env === 'cloud') {
    const res = await cloudStart({
      prompt: `Mission: ${m.title}\n\nObjective:\n${m.objective}`,
      repo: m.env.repo,
      setup: true,
      role: m.binding?.kind === 'orchestrator' ? 'orchestrator' : 'worker',
      title: m.title,
    });
    return { sessionId: res.sid, node: m.env.host ?? 'cloud', kind: m.binding?.kind ?? 'worker', boundAt: Date.now() };
  }
  // Native (worktree/shared) auto-start is phase-2 (spec §8). Surface clearly; the
  // per-mission try/catch will keep the mission as-is rather than looping.
  throw new Error(`native executor auto-start not implemented for env=${decision.go ? (decision as any).env : 'n/a'} (assign manually for now)`);
}

async function driveExecutor(m: Mission, directive: string): Promise<void> {
  const sid = m.binding?.sessionId;
  if (!sid) return;
  await cloudDrive({ sid, text: directive });
}

/** Register the scheduled-job handler. Reads live config each run; assembles real deps. */
export function registerMissionController(jobs: { registerHandler: (t: string, fn: any) => void }): void {
  jobs.registerHandler('mission-controller', async (_config: any, _ctx: any) => {
    const s = getProjectSettings();
    if (!s.missionControllerEnabled) return { result: 'mission controller disabled', status: 'skipped' };
    const r = await runMissionTick({
      now: Date.now(),
      cfg: { intervalMin: s.missionControllerIntervalMin, maxNudges: s.missionControllerMaxNudges, model: s.missionControllerModel },
      amMonitor: () => amIMonitor().then((m) => ({ isMonitor: m.isMonitor, monitorNodeId: m.monitorNodeId })),
      listAll: () => listMissions(),
      readExecutor: (m) => readCloudExecutor(m),
      adjust: (m, out) => runAdjust(m, out, s.missionControllerModel),
      startExecutor: (m, d) => startCloudExecutor(m, d),
      drive: (m, directive) => driveExecutor(m, directive),
      save: (m) => putMission(m).then(() => undefined),
    });
    if (r.skipped) return { result: 'not the mission controller (skipped)', status: 'skipped' };
    return { result: `acted=${r.acted.length} missions`, status: 'ok' };
  });
}
```

> Note: `bindExecutor` is imported but the controller mutates `m.binding` then `save`s, so it is not called directly here — remove the unused import if the build warns, OR (cleaner) drop it from the import list. Keep only what's used (`listMissions`, `putMission`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-controller.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/mission-controller.ts core/src/__tests__/mission-controller.test.ts
git commit -m "feat(mission): controller tick (liveness/adjust/placement) + wiring"
```

---

### Task 9: Scheduler wiring — seed builtin job + register handler

**Files:**
- Modify: `core/src/scheduler/scheduled-jobs.ts` (`makeBuiltinJobs` ~`:240`, `registerDefaults` ~`:391`)
- Test: `core/src/__tests__/mission-scheduler.test.ts`

**Interfaces:**
- Consumes: `registerMissionController` (Task 8).
- Produces: a builtin `mission-controller` job (enabled, interval 5) and a registered handler of type `mission-controller`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-scheduler.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { makeBuiltinJobs } from '../scheduler/scheduled-jobs';

test('makeBuiltinJobs seeds an enabled mission-controller job at interval 5', () => {
  const jobs = makeBuiltinJobs(1000);
  const mc = jobs.find((j) => j.id === 'mission-controller');
  assert.ok(mc, 'mission-controller builtin present');
  assert.strictEqual(mc!.type, 'mission-controller');
  assert.strictEqual(mc!.enabled, true);
  assert.strictEqual(mc!.intervalMinutes, 5);
  assert.strictEqual(mc!.builtin, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-scheduler.test.js`
Expected: FAIL — no `mission-controller` job in `makeBuiltinJobs`.

- [ ] **Step 3: Write minimal implementation**

In `makeBuiltinJobs(nowMs)` (add a third entry to the returned array, after the `stall-monitor` object ~`:278`):
```ts
    {
      id: 'mission-controller',
      name: 'Super Mission Controller',
      description: 'Fleet-elected loop that reads each executor, adapts the mission, and pushes every mission toward done (liveness/adjust/placement).',
      type: 'mission-controller',
      enabled: true,
      intervalMinutes: 5,
      config: {},
      lastRunAt: null, lastResult: null, lastStatus: null,
      builtin: true, createdAt: at, updatedAt: at,
    },
```

In `registerDefaults()` (right after the `registerStallMonitor(this)` block ~`:393`):
```ts
  {
    const { registerMissionController } = require('../mission/mission-controller');
    registerMissionController(this);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-scheduler.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add core/src/scheduler/scheduled-jobs.ts core/src/__tests__/mission-scheduler.test.js core/src/__tests__/mission-scheduler.test.ts
git commit -m "feat(mission): seed builtin mission-controller job + register handler"
```

---

### Task 10: Mission REST routes + worker-status progress mirror

**Files:**
- Create: `core/src/routes/core/mission.routes.ts`
- Modify: `core/src/routes/core/index.ts` (import ~`:55`, spread ~`:108`)
- Modify: `core/src/routes/core/worker.routes.ts` (`POST /worker/status` handler ~`:61-82`)
- Test: `core/src/__tests__/mission-routes.test.ts`

**Interfaces:**
- Consumes: mission-store (Task 5), `newMission` (Task 1), `amIMonitor` (election), `getScheduledJobs` (scheduler), `getHubConfig`.
- Produces: `createMissionRoutes(ctx): RouteHandler[]` (`POST /mission`, `GET /mission`, `GET /mission/:id`, `PATCH /mission/:id`, `GET /mission/controller`). The worker-status handler now mirrors progress into a bound mission.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-routes.test.ts` (drive handlers directly with a fake port, like the store test):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import { MissionDataPort } from '../mission/mission-store';
import { handleCreate, handleList, handleGet, handlePatch } from '../routes/core/mission.routes';

function fakePort(): MissionDataPort {
  const map = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    put: async (m) => { map.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id) => { map.delete(id); },
  };
}

test('create -> list -> get -> patch round-trip', async () => {
  const port = fakePort();
  const created = await handleCreate({ title: 'Build X', objective: 'Make X work', projects: ['lm-assist'] }, 'gw4-1', port);
  assert.strictEqual(created.success, true);
  const id = (created.data as Mission).id;
  assert.match(id, /^mission_/);

  const listed = await handleList(port);
  assert.strictEqual((listed.data as Mission[]).length, 1);

  const got = await handleGet(id, port);
  assert.strictEqual((got.data as Mission).objective, 'Make X work');

  const patched = await handlePatch(id, { objective: 'Make X great', status: 'paused' }, port);
  assert.strictEqual((patched.data as Mission).objective, 'Make X great');
  assert.strictEqual((patched.data as Mission).status, 'paused');
});

test('get unknown id fails', async () => {
  const r = await handleGet('mission_nope', fakePort());
  assert.strictEqual(r.success, false);
});

test('create requires title and objective', async () => {
  const r = await handleCreate({ title: '' }, 'gw4-1', fakePort());
  assert.strictEqual(r.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-routes.test.js`
Expected: FAIL — `../routes/core/mission.routes` not found.

- [ ] **Step 3: Write minimal implementation**

`core/src/routes/core/mission.routes.ts`:
```ts
/** Mission CRUD + controller status. Bare {success,data}/{success,error} envelope (like worker.routes). */
import type { RouteHandler, RouteContext } from '../index';
import { randomBytes } from 'crypto';
import { newMission, Mission, MissionStatus, Isolation } from '../../mission/mission-model';
import {
  MissionDataPort, getMission, listMissions, putMission, deleteMission, thisNode,
} from '../../mission/mission-store';
import { amIMonitor } from '../../monitor/stall-election';
import { getScheduledJobs } from '../../scheduler/scheduled-jobs';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string }; }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });
const genId = () => 'mission_' + randomBytes(4).toString('hex');
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') { try { const j = JSON.parse(v); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : undefined; } catch { return undefined; } }
  return undefined;
};
const VALID_STATUS = new Set<MissionStatus>(['draft', 'active', 'waiting', 'paused', 'blocked', 'done', 'failed']);

// --- testable handlers (port-injected) ---

export async function handleCreate(b: Record<string, unknown>, ownerNode: string, port?: MissionDataPort): Promise<Envelope> {
  const title = str(b.title);
  const objective = str(b.objective);
  if (!title || !objective) return fail('INVALID_INPUT', 'title and objective are required');
  const env = (b.env && typeof b.env === 'object') ? b.env as Record<string, unknown> : {};
  const m = newMission({
    title, objective, ownerNode,
    projects: arr(b.projects), dependsOn: arr(b.dependsOn),
    plan: str(b.plan), nextSteps: arr(b.nextSteps),
    env: {
      isolation: (str(env.isolation) as Isolation) ?? 'cloud',
      host: str(env.host), repo: str(env.repo), branch: str(env.branch),
      resources: arr(env.resources) ?? [],
      exclusive: env.exclusive === true || env.exclusive === 'true',
    },
  }, Date.now(), genId);
  await putMission(m, port);
  return ok(m);
}
export async function handleList(port?: MissionDataPort): Promise<Envelope> {
  return ok(await listMissions(port));
}
export async function handleGet(id: string, port?: MissionDataPort): Promise<Envelope> {
  const m = await getMission(id, port);
  return m ? ok(m) : fail('NOT_FOUND', `no mission ${id}`);
}
export async function handlePatch(id: string, b: Record<string, unknown>, port?: MissionDataPort): Promise<Envelope> {
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  if (str(b.objective)) m.objective = str(b.objective)!;
  if (str(b.title)) m.title = str(b.title)!;
  if (str(b.plan) !== undefined) m.plan = str(b.plan);
  if (arr(b.nextSteps)) m.nextSteps = arr(b.nextSteps);
  if (arr(b.dependsOn)) m.dependsOn = arr(b.dependsOn)!;
  if (arr(b.projects)) m.projects = arr(b.projects)!;
  const sv = str(b.status) as MissionStatus | undefined;
  if (sv) { if (!VALID_STATUS.has(sv)) return fail('INVALID_INPUT', `invalid status "${sv}"`); m.status = sv; }
  if (b.env && typeof b.env === 'object') {
    const e = b.env as Record<string, unknown>;
    if (str(e.isolation)) m.env.isolation = str(e.isolation) as Isolation;
    if (str(e.host) !== undefined) m.env.host = str(e.host);
    if (str(e.repo) !== undefined) m.env.repo = str(e.repo);
    if (str(e.branch) !== undefined) m.env.branch = str(e.branch);
    if (arr(e.resources)) m.env.resources = arr(e.resources)!;
    if (e.exclusive !== undefined) m.env.exclusive = e.exclusive === true || e.exclusive === 'true';
  }
  m.adjustments.push({ at: Date.now(), trigger: 'user-edit', change: 'mission updated via API', by: 'user' });
  await putMission(m, port);
  return ok(m);
}

export function createMissionRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    { method: 'POST', pattern: /^\/mission$/, handler: async (req) => handleCreate((req.body || {}) as Record<string, unknown>, thisNode()) },
    { method: 'GET', pattern: /^\/mission$/, handler: async () => handleList() },
    { method: 'GET', pattern: /^\/mission\/controller$/, handler: async () => {
        const election = await amIMonitor();
        const job = getScheduledJobs().getJob('mission-controller');
        return ok({ election, job });
      } },
    { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handleGet(req.params.id) },
    { method: 'PATCH', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>) },
  ];
}
```

> Route ordering: `/mission/controller` is registered BEFORE `/mission/:id` so the literal wins over the param capture.

In `core/src/routes/core/index.ts` — import (next to `createWorkerRoutes`, ~`:55`):
```ts
import { createMissionRoutes } from './mission.routes';
```
and spread (next to `...createWorkerRoutes(ctx)`, ~`:108`):
```ts
    ...createMissionRoutes(ctx),
```

In `core/src/routes/core/worker.routes.ts` — add the mirror import (top, with the other imports):
```ts
import { findMissionBySession, mirrorProgress } from '../../mission/mission-store';
```
and modify the `POST /worker/status` handler to mirror progress after `putRecord` (replace `return ok(putRecord(rec));` with):
```ts
        const out = putRecord(rec);
        // Best-effort: mirror progress into a bound mission (cross-node source of truth).
        try {
          const m = await findMissionBySession(sessionId);
          if (m) {
            const task = rec.tasks.find((t) => t.id === taskId);
            await mirrorProgress(
              m.id,
              { percent: task?.status === 'done' ? 100 : 0, summary: task?.progress || task?.detail || '', updatedAt: Date.now() },
            );
          }
        } catch { /* mirroring must never fail the status report */ }
        return ok(out);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-routes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/routes/core/mission.routes.ts core/src/routes/core/index.ts core/src/routes/core/worker.routes.ts core/src/__tests__/mission-routes.test.ts
git commit -m "feat(mission): REST routes + worker-status progress mirroring"
```

---

### Task 11: MCP tools — `mission.ts` + wire into expanded + scopes

**Files:**
- Create: `core/src/mcp-server/tools/mission.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (import ~`:51`, defs spread ~`:908`, handlers spread ~`:1652`)
- Modify: `core/src/mcp-server/configure.ts` (`TOOL_SCOPES` ~`:248`)
- Test: `core/src/__tests__/mission-mcp.test.ts`

**Interfaces:**
- Consumes: `workerGet`/`workerPost` from `./_passthrough`.
- Produces: `MISSION_TOOL_DEFS`, `MISSION_HANDLERS` (`mission_create`, `mission_list`, `mission_update`, `mission_control_status`).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/mission-mcp.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_TOOL_DEFS } from '../mcp-server/tools/mission';

test('exposes the four mission tools', () => {
  const names = MISSION_TOOL_DEFS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['mission_control_status', 'mission_create', 'mission_list', 'mission_update']);
});
test('mission_create requires title + objective', () => {
  const def = MISSION_TOOL_DEFS.find((t) => t.name === 'mission_create')!;
  assert.deepStrictEqual([...def.inputSchema.required].sort(), ['objective', 'title']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-mcp.test.js`
Expected: FAIL — `../mcp-server/tools/mission` not found.

- [ ] **Step 3: Write minimal implementation**

`core/src/mcp-server/tools/mission.ts`:
```ts
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';

const S = { type: 'string' as const };
const SARR = { type: 'array' as const, items: { type: 'string' as const } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_TOOL_DEFS = [
  {
    name: 'mission_create',
    description: 'Create a Mission (durable WHAT-to-achieve). The fleet-elected Mission Controller will place an executor and push it to done. Spans any project(s).',
    inputSchema: obj(
      {
        title: S, objective: S,
        projects: SARR, dependsOn: SARR, plan: S, nextSteps: SARR,
        env: obj({ isolation: { ...S, enum: ['cloud', 'worktree', 'shared'] }, host: S, repo: S, branch: S, resources: SARR, exclusive: { type: 'boolean' as const } }),
      },
      ['title', 'objective'],
    ),
  },
  { name: 'mission_list', description: 'List all missions and their status/progress/binding.', inputSchema: obj({}) },
  {
    name: 'mission_update',
    description: 'Update a mission (objective/title/plan/nextSteps/status/env/dependsOn). Use to refine, pause, or unblock.',
    inputSchema: obj({ id: S, title: S, objective: S, plan: S, status: { ...S, enum: ['draft', 'active', 'waiting', 'paused', 'blocked', 'done', 'failed'] }, nextSteps: SARR, dependsOn: SARR, projects: SARR }, ['id']),
  },
  { name: 'mission_control_status', description: 'Who is the elected Mission Controller right now + its last tick result.', inputSchema: obj({}) },
] as const;

export const MISSION_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_create: async (a) => { try { return pretty(await workerPost('/mission', a)); } catch (e) { return err((e as Error).message); } },
  mission_list: async () => { try { return pretty(await workerGet('/mission')); } catch (e) { return err((e as Error).message); } },
  mission_update: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerPost(`/mission/${encodeURIComponent(id)}`, a));
    } catch (e) { return err((e as Error).message); }
  },
  mission_control_status: async () => { try { return pretty(await workerGet('/mission/controller')); } catch (e) { return err((e as Error).message); } },
};
```

> `mission_update` posts to `/mission/:id`, but the route is a `PATCH`. Add a `PATCH`-or-`POST` acceptance: in `mission.routes.ts`, duplicate the PATCH route as a `POST` on the same pattern (MCP `workerPost` only does POST). Add to `createMissionRoutes`:
> ```ts
> { method: 'POST', pattern: /^\/mission\/(?<id>[^/]+)$/, handler: async (req) => handlePatch(req.params.id, (req.body || {}) as Record<string, unknown>) },
> ```
> (Place it after the GET `/mission/:id` route. `/mission` POST = create; `/mission/:id` POST = update — distinct patterns.)

In `core/src/mcp-server/tools/expanded.ts`:
- import (next to the worker-role import ~`:51`): `import { MISSION_TOOL_DEFS, MISSION_HANDLERS } from './mission';`
- defs spread (next to `...WORKER_ROLE_TOOL_DEFS` ~`:908`): `  ...MISSION_TOOL_DEFS,`
- handlers spread (next to `...WORKER_ROLE_HANDLERS` ~`:1652`): `  ...MISSION_HANDLERS,`

In `core/src/mcp-server/configure.ts` `TOOL_SCOPES` (next to the worker-role entries ~`:248`):
```ts
  // mission controller
  mission_create: 'write',
  mission_list: 'read',
  mission_update: 'write',
  mission_control_status: 'read',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-mcp.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mcp-server/tools/mission.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/routes/core/mission.routes.ts core/src/__tests__/mission-mcp.test.ts
git commit -m "feat(mission): MCP mission tools (create/list/update/control_status)"
```

---

### Task 12: `guide("missions")` topic + full build & wiring verification

**Files:**
- Modify: `core/src/mcp-server/tools/guide.ts` (add a `missions` topic)
- Test: `core/src/__tests__/mission-guide.test.ts`

**Interfaces:**
- Consumes: the guide topic registry pattern already in `guide.ts`.
- Produces: a `missions` topic returned by the guide tool.

- [ ] **Step 1: Inspect the guide topic shape**

Run: `grep -n "topic\|TOPICS\|case '" core/src/mcp-server/tools/guide.ts | head -30`
Expected: reveals how topics are keyed (a `Record<string,string>` or a `switch`). Mirror that exact shape in Step 3.

- [ ] **Step 2: Write the failing test**

`core/src/__tests__/mission-guide.test.ts` (adapt the import/calling convention to whatever `guide.ts` exports — e.g. `getGuideTopic` or the handler):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';

test('guide("missions") returns mission-controller orientation', async () => {
  const res = await GUIDE_HANDLERS.guide({ topic: 'missions' });
  const text = JSON.stringify(res);
  assert.match(text, /Mission Controller/i);
  assert.match(text, /mission_create/);
});
```

> If `guide.ts` exposes topics differently (e.g. a `GUIDE_TOPICS` map), assert against that instead. The point: the `missions` topic exists and names `mission_create` + the controller.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-guide.test.js`
Expected: FAIL — no `missions` topic.

- [ ] **Step 4: Write minimal implementation**

Add a `missions` topic to `guide.ts` (matching its existing structure), with content:
```
# Missions — durable goals pushed to done by the fleet

A **Mission** is a durable record of WHAT to achieve (cross-project). The fleet-elected
**super Mission Controller** binds ONE executor (cloud/native, orchestrator/worker), reads its
feedback every few minutes, ADAPTS the mission (revises the objective/plan from results — not a
binary done/failed), and pushes it toward done. It places executors to avoid conflicts: isolated
(cloud > git worktree+branch) when possible, else serialized on shared resources; dependencies are
ordered (`dependsOn`). It NEVER auto-approves a human gate or a material pivot (those pause).

Tools: `mission_create` (title+objective, optional projects/dependsOn/env), `mission_list`,
`mission_update` (refine/pause/unblock), `mission_control_status` (who's elected + last tick).
Requires the data service enabled (cross-node mission store). Settings: missionControllerEnabled,
missionControllerIntervalMin, missionControllerMaxNudges, missionControllerModel.
```

- [ ] **Step 5: Run test + FULL build to verify everything wires**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/mission-guide.test.js
cd /home/ubuntu/lm-assist && ./core.sh build 2>&1 | tail -15
```
Expected: guide test PASS; `./core.sh build` completes with no TypeScript errors (full CJS build — proves `scheduled-jobs` lazy-require, routes registration, and MCP spreads all type-check).

- [ ] **Step 6: Run the whole mission test suite**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec 'dist-test/__tests__/mission-*.test.js'
```
Expected: all mission tests PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/mcp-server/tools/guide.ts core/src/__tests__/mission-guide.test.ts
git commit -m "feat(mission): guide(\"missions\") topic + full build verification"
```

---

## Self-Review (completed during planning)

**1. Spec coverage:**
- Mission living record (objective/plan/nextSteps/adjustments/results) → Task 1. ✅
- Cross-node store via data service `syncMode:'full'`, disabled→no-op → Task 5. ✅
- Election (one node acts) → Task 8 (`amIMonitor`). ✅
- Liveness (rebind/defer/gate) → Tasks 3 (`decideMission`) + 8. ✅
- Adjust (LLM, only on new output; verdicts incl. material-pivot pause; opus-4.8 max thinking) → Tasks 4/6/8. ✅
- Placement (dependency gate, isolate cloud>worktree, resource serialize, exclusive) → Tasks 2/8. ✅
- Parked nudge with capped backoff → Tasks 3/8. ✅
- Binding + progress mirroring (report_status → mission) → Tasks 5/10. ✅
- MCP surface + routes + settings + scheduler + guide → Tasks 7/9/10/11/12. ✅
- Per-mission try/catch isolation → Task 8. ✅
- Autonomy boundary (never auto-approve gate/pivot) → Tasks 8 (paused) verified in tests. ✅

**2. Placeholder scan:** No "TBD/handle errors/etc." — every code step is complete. The only deferred item (native executor auto-start) is an explicit spec §8 phase-2 scope boundary, implemented as a clear typed throw caught by per-mission isolation (cloud executors are fully end-to-end). ✅

**3. Type consistency:** `Mission`, `MissionControl`, `ExecutorState`, `ExecutorOutput`, `PlacementDecision`, `AdjustResult`, `MissionBinding`, `MissionDataPort`, `MissionTickDeps` are defined once (Tasks 1/3/4/5/8) and referenced with identical names/shapes throughout. `place(m, all)`, `decideMission(m, st)`, `planMissionNudge(control, cfg, now)`, `parseAdjustResult(raw)`, `runAdjust(m, out, model, runner?)` signatures match every call site. ✅

**Known confirm-before-writing items (flagged inline):** the exact export location of `DataRecord`/`CallCtx` (Task 5 note), whether `DEFAULTS` is exported (Task 7 note), and the `guide.ts` topic shape (Task 12 Step 1) — each task tells the implementer to grep/confirm first.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-mission-controller.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, spec+quality review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
