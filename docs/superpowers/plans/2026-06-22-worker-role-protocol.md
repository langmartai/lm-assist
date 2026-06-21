# Worker Role Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an lm-assist session a first-class **worker role** — self- or other-assigned, surfaced via `bootstrap` — that owns a hierarchical task list, prints a `⟦WORKER-STATUS⟧` block every turn (Way 1), optionally reports via messaging (Way 2) + a worker store (Way 3), and supports a universal agree-gate, all readable/drivable by an optional orchestrator (`none`/`active`/`inactive`).

**Architecture:** A pure model layer (`core/src/worker-role/`: status-block codec, liveness, gate FSM, task-tree roll-up, role transitions) over a local JSON store (`~/.lm-assist/workers.json`, keyed by sessionId — no data-access-key gate, always available). Five REST routes (`/worker/*`) behind the worker `x-api-key` expose it; five MCP tools proxy those routes; the bootstrap identity block reads the store to render a ROLE section.

**Tech Stack:** TypeScript (CommonJS, `tsc`), Node `node --test` (`dist-test/`), the raw-HTTP route system (`{method, pattern, handler}`), the existing MCP `EXPANDED_TOOL_DEFS`/`TOOL_SCOPES` aggregation, `getDataDir()` for the store path.

**Spec:** `docs/superpowers/specs/2026-06-22-worker-role-protocol-design.md` (read it first).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `core/src/worker-role/types.ts` | Shared types: `Task`, `Gate`, `WorkerRecord`, `StatusLine`, enums |
| `core/src/worker-role/status-block.ts` | Pure `⟦WORKER-STATUS⟧` format + parse (Way 1) |
| `core/src/worker-role/model.ts` | Pure model ops: `liveness`, `decideGate`/`canProceed`, `rollUp`, `applySetRole`, `applyReportStatus` |
| `core/src/worker-role/worker-store.ts` | Impure persistence: load/save `workers.json`, stamp orchestrator, list/get |
| `core/src/routes/core/worker.routes.ts` | REST: `POST /worker/role`, `POST /worker/status`, `GET /worker`, `GET /worker/:sessionId`, `POST /worker/:sessionId/gate` |
| `core/src/routes/core/index.ts` | Register the worker routes (modify) |
| `core/src/mcp-server/tools/worker-role.ts` | MCP defs + handlers (`set_role`, `report_status`, `worker_status`, `list_workers`, `decide_gate`) proxying the routes |
| `core/src/mcp-server/tools/expanded.ts` | Import the worker-role tool defs + handlers (modify) |
| `core/src/mcp-server/configure.ts` | `TOOL_SCOPES` entries for the 5 tools (modify) |
| `core/src/mcp-server/mcp-session-resolver.ts` | ROLE section in `identityHeader` (modify) |
| `core/src/mcp-server/tools/guide.ts` | `roles` guide topic + bootstrap `order` (modify) |
| `core/src/__tests__/worker-role-model.test.ts` | Tests for status-block + model |
| `core/src/__tests__/worker-role-store.test.ts` | Tests for the store |
| `core/src/__tests__/worker-role-routes.test.ts` | Route + e2e tests |

**Note (deviation from spec §2.2):** the worker record is persisted in a single local `~/.lm-assist/workers.json` map (keyed by sessionId) rather than a separate data-service dataset + `role.json` marker. The local JSON store is always available (no `dataServiceEnabled` dependency, no key dance) and serves as both the record store and bootstrap's fast cache. Surfacing it through the `data_*` service for unified cross-node querying is a later, out-of-scope enhancement; cross-node reads already work via the relayed `GET /worker/:sessionId` route.

---

## Task 1: Types + `⟦WORKER-STATUS⟧` codec (Way 1)

**Files:**
- Create: `core/src/worker-role/types.ts`
- Create: `core/src/worker-role/status-block.ts`
- Test: `core/src/__tests__/worker-role-model.test.ts`

- [ ] **Step 1: Write `types.ts`** (no test — pure type declarations consumed by later tasks)

```typescript
// core/src/worker-role/types.ts
export type TaskStatus = 'todo' | 'working' | 'blocked' | 'need_approval' | 'done' | 'skipped';
export type GateState = 'open' | 'agreed' | 'rejected';
export type OrchestratorLiveness = 'none' | 'active' | 'inactive';

export interface Gate {
  state: GateState;
  reason: string;
  requestedAt: number;            // epoch ms
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
}

export interface Task {
  id: string;
  title: string;
  group?: string;                 // phase label
  parentId?: string;              // sub-task linkage
  status: TaskStatus;
  progress?: string;
  detail?: string;
  gate?: Gate;
}

export interface OrchestratorRef {
  id?: string;
  lastContact?: number;           // epoch ms
}

export interface WorkerRecord {
  sessionId: string;
  role: 'worker';
  tasks: Task[];
  orchestrator: OrchestratorRef;
  updatedAt: number;
}

/** The one-block-per-turn status line the worker prints (derived from a task + narration). */
export interface StatusLine {
  taskId: string;
  phase?: string;
  status: TaskStatus;
  progress?: string;
  last?: string;
  next?: string;
  gate?: string;                  // reason; present when status === 'need_approval'
}
```

- [ ] **Step 2: Write the failing test for the status-block codec**

Add to `core/src/__tests__/worker-role-model.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatusBlock, parseStatusBlock } from '../worker-role/status-block';
import type { StatusLine } from '../worker-role/types';

test('status-block: format → parse round-trips a full line', () => {
  const s: StatusLine = { taskId: 't1', phase: 'Phase 1', status: 'working', progress: '3/5', last: 'wrote the codec', next: 'add the store' };
  const round = parseStatusBlock(formatStatusBlock(s));
  assert.deepEqual(round, s);
});

test('status-block: a need_approval line carries the gate reason', () => {
  const s: StatusLine = { taskId: 't9', status: 'need_approval', last: 'ready to deploy', gate: 'prod deploy — confirm?' };
  const text = formatStatusBlock(s);
  assert.match(text, /status=need_approval/);
  assert.match(text, /gate: prod deploy — confirm\?/);
  assert.deepEqual(parseStatusBlock(text), s);
});

test('status-block: parse ignores surrounding prose, returns null when absent', () => {
  const s: StatusLine = { taskId: 't1', status: 'done' };
  const wrapped = `Some narration above.\n${formatStatusBlock(s)}\nMore prose below.`;
  assert.deepEqual(parseStatusBlock(wrapped), s);
  assert.equal(parseStatusBlock('no block here'), null);
});
```

- [ ] **Step 3: Run it, verify it FAILS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: FAIL — `Cannot find module '../worker-role/status-block'`.

- [ ] **Step 4: Implement `status-block.ts`**

```typescript
// core/src/worker-role/status-block.ts
import type { StatusLine, TaskStatus } from './types';

const OPEN = '⟦WORKER-STATUS⟧';   // ⟦WORKER-STATUS⟧
const CLOSE = '⟦/WORKER-STATUS⟧'; // ⟦/WORKER-STATUS⟧
const STATUSES: TaskStatus[] = ['todo', 'working', 'blocked', 'need_approval', 'done', 'skipped'];

/** Render the one-per-turn status block a worker prints into its LLM output. */
export function formatStatusBlock(s: StatusLine): string {
  const head = [
    OPEN,
    `task=${s.taskId}`,
    s.phase ? `phase="${s.phase}"` : '',
    `status=${s.status}`,
    s.progress ? `progress=${s.progress}` : '',
  ].filter(Boolean).join(' ');
  const lines = [head];
  if (s.last) lines.push(` last: ${s.last}`);
  if (s.next) lines.push(` next: ${s.next}`);
  if (s.gate) lines.push(` gate: ${s.gate}`);
  lines.push(CLOSE);
  return lines.join('\n');
}

/** Extract the LAST status block from arbitrary text; null if none. */
export function parseStatusBlock(text: string): StatusLine | null {
  if (!text) return null;
  const start = text.lastIndexOf(OPEN);
  if (start < 0) return null;
  const end = text.indexOf(CLOSE, start);
  if (end < 0) return null;
  const block = text.slice(start, end);
  const headLine = block.slice(0, block.indexOf('\n') < 0 ? undefined : block.indexOf('\n'));
  const taskId = /\btask=(\S+)/.exec(headLine)?.[1];
  const statusRaw = /\bstatus=(\S+)/.exec(headLine)?.[1] as TaskStatus | undefined;
  if (!taskId || !statusRaw || !STATUSES.includes(statusRaw)) return null;
  const out: StatusLine = { taskId, status: statusRaw };
  const phase = /\bphase="([^"]*)"/.exec(headLine)?.[1];
  if (phase) out.phase = phase;
  const progress = /\bprogress=(\S+)/.exec(headLine)?.[1];
  if (progress) out.progress = progress;
  const grab = (label: string) => new RegExp(`^\\s${label}:\\s(.*)$`, 'm').exec(block)?.[1];
  const last = grab('last'); if (last) out.last = last;
  const next = grab('next'); if (next) out.next = next;
  const gate = grab('gate'); if (gate) out.gate = gate;
  return out;
}
```

- [ ] **Step 5: Run tests, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add core/src/worker-role/types.ts core/src/worker-role/status-block.ts core/src/__tests__/worker-role-model.test.ts
git commit -m "feat(worker-role): types + ⟦WORKER-STATUS⟧ block codec (Way 1)"
```

---

## Task 2: Orchestrator liveness (none/active/inactive)

**Files:**
- Create: `core/src/worker-role/model.ts`
- Test: `core/src/__tests__/worker-role-model.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { liveness } from '../worker-role/model';
import type { OrchestratorRef } from '../worker-role/types';

test('liveness: none when no id, active within window, inactive when stale', () => {
  const now = 1_000_000_000_000;
  const WIN = 5 * 60_000;
  assert.equal(liveness({}, now, WIN), 'none');
  assert.equal(liveness({ id: 'o1' }, now, WIN), 'inactive');                       // id but never contacted
  assert.equal(liveness({ id: 'o1', lastContact: now - 1000 }, now, WIN), 'active');
  assert.equal(liveness({ id: 'o1', lastContact: now - WIN - 1 }, now, WIN), 'inactive');
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: FAIL — `Cannot find module '../worker-role/model'`.

- [ ] **Step 3: Implement `liveness` in `model.ts`**

```typescript
// core/src/worker-role/model.ts
import type { OrchestratorRef, OrchestratorLiveness } from './types';

export const ORCHESTRATOR_WINDOW_MS = 5 * 60_000;

export function liveness(orch: OrchestratorRef, now: number, windowMs = ORCHESTRATOR_WINDOW_MS): OrchestratorLiveness {
  if (!orch || !orch.id) return 'none';
  if (typeof orch.lastContact !== 'number') return 'inactive';
  return now - orch.lastContact <= windowMs ? 'active' : 'inactive';
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/worker-role/model.ts core/src/__tests__/worker-role-model.test.ts
git commit -m "feat(worker-role): orchestrator liveness (none/active/inactive)"
```

---

## Task 3: Gate state machine

**Files:**
- Modify: `core/src/worker-role/model.ts`
- Test: `core/src/__tests__/worker-role-model.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { decideGate, canProceed } from '../worker-role/model';
import type { Task } from '../worker-role/types';

test('gate: canProceed true when no gate or agreed; false when open', () => {
  const base: Task = { id: 't1', title: 'x', status: 'working' };
  assert.equal(canProceed(base), true);
  assert.equal(canProceed({ ...base, status: 'need_approval', gate: { state: 'open', reason: 'r', requestedAt: 1 } }), false);
  assert.equal(canProceed({ ...base, gate: { state: 'agreed', reason: 'r', requestedAt: 1 } }), true);
  assert.equal(canProceed({ ...base, gate: { state: 'rejected', reason: 'r', requestedAt: 1 } }), false);
});

test('gate: decideGate flips an open gate and stamps the decider', () => {
  const t: Task = { id: 't1', title: 'x', status: 'need_approval', gate: { state: 'open', reason: 'deploy?', requestedAt: 1 } };
  const agreed = decideGate(t, 'agree', 'orch-1', 'go ahead', 2000);
  assert.equal(agreed.gate?.state, 'agreed');
  assert.equal(agreed.gate?.decidedBy, 'orch-1');
  assert.equal(agreed.gate?.decidedAt, 2000);
  assert.equal(agreed.gate?.note, 'go ahead');
  assert.equal(agreed.status, 'working');                       // agreeing unblocks the task
});

test('gate: decideGate throws when there is no open gate', () => {
  const t: Task = { id: 't1', title: 'x', status: 'working' };
  assert.throws(() => decideGate(t, 'agree', 'o', undefined, 1), /no open gate/i);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: FAIL — `decideGate`/`canProceed` not exported.

- [ ] **Step 3: Append to `model.ts`**

```typescript
import type { Task } from './types';

/** A worker may proceed past a task only when it has no gate, or its gate is agreed. */
export function canProceed(task: Task): boolean {
  if (!task.gate) return true;
  return task.gate.state === 'agreed';
}

/** Resolve an OPEN gate. Agreeing unblocks the task (need_approval → working). */
export function decideGate(task: Task, decision: 'agree' | 'reject', by: string, note: string | undefined, now: number): Task {
  if (!task.gate || task.gate.state !== 'open') throw new Error('no open gate to decide');
  const state = decision === 'agree' ? 'agreed' : 'rejected';
  const gate = { ...task.gate, state: state as 'agreed' | 'rejected', decidedBy: by, decidedAt: now, note };
  const status: Task['status'] = decision === 'agree' ? 'working' : 'blocked';
  return { ...task, gate, status };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/worker-role/model.ts core/src/__tests__/worker-role-model.test.ts
git commit -m "feat(worker-role): agree-gate state machine (canProceed/decideGate)"
```

---

## Task 4: Task-tree roll-up

**Files:**
- Modify: `core/src/worker-role/model.ts`
- Test: `core/src/__tests__/worker-role-model.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { rollUp } from '../worker-role/model';

test('rollUp: a parent is done only when all children are done/skipped', () => {
  const tasks: Task[] = [
    { id: 'p', title: 'phase', status: 'todo' },
    { id: 'a', title: 'a', parentId: 'p', status: 'done' },
    { id: 'b', title: 'b', parentId: 'p', status: 'skipped' },
  ];
  assert.equal(rollUp(tasks).find((t) => t.id === 'p')!.status, 'done');
});

test('rollUp: a parent is working when any child is working/need_approval', () => {
  const tasks: Task[] = [
    { id: 'p', title: 'phase', status: 'todo' },
    { id: 'a', title: 'a', parentId: 'p', status: 'done' },
    { id: 'b', title: 'b', parentId: 'p', status: 'working' },
  ];
  assert.equal(rollUp(tasks).find((t) => t.id === 'p')!.status, 'working');
});

test('rollUp: leaves (no children) are unchanged', () => {
  const tasks: Task[] = [{ id: 'a', title: 'a', status: 'blocked' }];
  assert.deepEqual(rollUp(tasks), tasks);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: FAIL — `rollUp` not exported.

- [ ] **Step 3: Append to `model.ts`**

```typescript
/** Derive each parent's status from its direct children (leaves keep their own status). */
export function rollUp(tasks: Task[]): Task[] {
  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentId) {
      const arr = childrenOf.get(t.parentId) ?? [];
      arr.push(t);
      childrenOf.set(t.parentId, arr);
    }
  }
  const derive = (kids: Task[]): Task['status'] => {
    if (kids.some((k) => k.status === 'working' || k.status === 'need_approval')) return 'working';
    if (kids.some((k) => k.status === 'blocked')) return 'blocked';
    if (kids.every((k) => k.status === 'done' || k.status === 'skipped')) return 'done';
    if (kids.some((k) => k.status !== 'todo')) return 'working';
    return 'todo';
  };
  return tasks.map((t) => {
    const kids = childrenOf.get(t.id);
    return kids && kids.length ? { ...t, status: derive(kids) } : t;
  });
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/worker-role/model.ts core/src/__tests__/worker-role-model.test.ts
git commit -m "feat(worker-role): task-tree status roll-up"
```

---

## Task 5: Role transitions (`applySetRole`, `applyReportStatus`)

**Files:**
- Modify: `core/src/worker-role/model.ts`
- Test: `core/src/__tests__/worker-role-model.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
import { applySetRole, applyReportStatus } from '../worker-role/model';
import type { WorkerRecord } from '../worker-role/types';

test('applySetRole: creates a worker record with a worker-owned task (auto-id)', () => {
  const rec = applySetRole(null, 'sess-1', { task: { title: 'do X' }, orchestrator: 'orch-9' }, 1000, () => 'task-aaa');
  assert.equal(rec.role, 'worker');
  assert.equal(rec.sessionId, 'sess-1');
  assert.equal(rec.tasks.length, 1);
  assert.equal(rec.tasks[0].id, 'task-aaa');
  assert.equal(rec.tasks[0].status, 'todo');
  assert.equal(rec.orchestrator.id, 'orch-9');
});

test('applySetRole: a second call appends a task, keeps ONE active role', () => {
  const r1 = applySetRole(null, 'sess-1', { task: { title: 'first' } }, 1000, () => 'task-1');
  const r2 = applySetRole(r1, 'sess-1', { task: { title: 'second' } }, 2000, () => 'task-2');
  assert.equal(r2.tasks.length, 2);
  assert.equal(r2.role, 'worker');
});

test('applyReportStatus: updates a task status; need_approval opens a gate', () => {
  const r1 = applySetRole(null, 'sess-1', { task: { title: 'deploy' } }, 1000, () => 'task-1');
  const r2 = applyReportStatus(r1, { taskId: 'task-1', status: 'need_approval', reason: 'prod?' }, 3000);
  const t = r2.tasks[0];
  assert.equal(t.status, 'need_approval');
  assert.equal(t.gate?.state, 'open');
  assert.equal(t.gate?.reason, 'prod?');
  assert.equal(r2.updatedAt, 3000);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: FAIL — `applySetRole`/`applyReportStatus` not exported.

- [ ] **Step 3: Append to `model.ts`**

```typescript
import type { WorkerRecord, Task } from './types';

export interface SetRoleInput { task?: { id?: string; title: string; group?: string; parentId?: string }; orchestrator?: string; }
export interface ReportInput { taskId: string; status?: Task['status']; progress?: string; detail?: string; reason?: string; }

/** Set/replace the active role and (optionally) append a worker-OWNED task. One active role only. */
export function applySetRole(prev: WorkerRecord | null, sessionId: string, input: SetRoleInput, now: number, genId: () => string): WorkerRecord {
  const rec: WorkerRecord = prev && prev.sessionId === sessionId
    ? { ...prev, role: 'worker', updatedAt: now }
    : { sessionId, role: 'worker', tasks: [], orchestrator: {}, updatedAt: now };
  rec.tasks = [...rec.tasks];
  if (input.orchestrator) rec.orchestrator = { ...rec.orchestrator, id: input.orchestrator };
  if (input.task) {
    rec.tasks.push({ id: input.task.id ?? genId(), title: input.task.title, group: input.task.group, parentId: input.task.parentId, status: 'todo' });
  }
  return rec;
}

/** Apply a worker's status report to one of its tasks. status=need_approval opens a gate. */
export function applyReportStatus(prev: WorkerRecord, input: ReportInput, now: number): WorkerRecord {
  const tasks = prev.tasks.map((t) => {
    if (t.id !== input.taskId) return t;
    const next: Task = { ...t };
    if (input.status) next.status = input.status;
    if (input.progress !== undefined) next.progress = input.progress;
    if (input.detail !== undefined) next.detail = input.detail;
    if (input.status === 'need_approval') next.gate = { state: 'open', reason: input.reason ?? 'approval required', requestedAt: now };
    return next;
  });
  return { ...prev, tasks, updatedAt: now };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/worker-role/model.ts core/src/__tests__/worker-role-model.test.ts
git commit -m "feat(worker-role): role transitions (applySetRole/applyReportStatus)"
```

---

## Task 6: Worker store (persistence + orchestrator stamping)

**Files:**
- Create: `core/src/worker-role/worker-store.ts`
- Test: `core/src/__tests__/worker-role-store.test.ts`

- [ ] **Step 1: Write the failing test** (uses a temp `LM_ASSIST_DATA_DIR`)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wrkstore-'));
process.env.LM_ASSIST_DATA_DIR = TMP;

import { putRecord, getRecord, listRecords, stampOrchestrator } from '../worker-role/worker-store';
import type { WorkerRecord } from '../worker-role/types';

const rec: WorkerRecord = { sessionId: 's1', role: 'worker', tasks: [{ id: 't1', title: 'x', status: 'working' }], orchestrator: {}, updatedAt: 1 };

test('store: put then get round-trips a record', () => {
  putRecord(rec);
  assert.deepEqual(getRecord('s1'), rec);
  assert.equal(getRecord('nope'), null);
});

test('store: list returns all records', () => {
  putRecord({ ...rec, sessionId: 's2' });
  const ids = listRecords().map((r) => r.sessionId).sort();
  assert.deepEqual(ids, ['s1', 's2']);
});

test('store: stampOrchestrator sets id + lastContact', () => {
  const updated = stampOrchestrator('s1', 'orch-7', 9999);
  assert.equal(updated?.orchestrator.id, 'orch-7');
  assert.equal(updated?.orchestrator.lastContact, 9999);
  assert.equal(getRecord('s1')?.orchestrator.lastContact, 9999);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-store.test.js`
Expected: FAIL — `Cannot find module '../worker-role/worker-store'`.

- [ ] **Step 3: Implement `worker-store.ts`** (reuse `getDataDir()` from the api-token module)

```typescript
// core/src/worker-role/worker-store.ts
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import type { WorkerRecord } from './types';

function dataDir(): string { return process.env.LM_ASSIST_DATA_DIR || getDataDir(); }
function storeFile(): string { return path.join(dataDir(), 'workers.json'); }

function readAll(): Record<string, WorkerRecord> {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as Record<string, WorkerRecord>; }
  catch { return {}; }
}

function writeAll(map: Record<string, WorkerRecord>): void {
  const f = storeFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
  fs.renameSync(tmp, f);                 // atomic replace
}

export function getRecord(sessionId: string): WorkerRecord | null {
  return readAll()[sessionId] ?? null;
}

export function listRecords(): WorkerRecord[] {
  return Object.values(readAll());
}

export function putRecord(rec: WorkerRecord): WorkerRecord {
  const map = readAll();
  map[rec.sessionId] = rec;
  writeAll(map);
  return rec;
}

export function deleteRecord(sessionId: string): void {
  const map = readAll();
  delete map[sessionId];
  writeAll(map);
}

/** Mark `orchestratorId` as the worker's orchestrator and refresh its lastContact. */
export function stampOrchestrator(sessionId: string, orchestratorId: string, now: number): WorkerRecord | null {
  const rec = getRecord(sessionId);
  if (!rec) return null;
  rec.orchestrator = { id: orchestratorId, lastContact: now };
  rec.updatedAt = now;
  return putRecord(rec);
}
```

`worker-store.dataDir()` checks `LM_ASSIST_DATA_DIR` first (so the test's temp dir is honored) and otherwise uses the shared `getDataDir()` from `core/src/utils/path-utils.ts` — no edit to `api-token.ts` is needed.

- [ ] **Step 4: Run, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-store.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add core/src/worker-role/worker-store.ts core/src/__tests__/worker-role-store.test.ts
git commit -m "feat(worker-role): local worker-store (workers.json) + orchestrator stamping"
```

---

## Task 7: REST routes (`/worker/*`)

**Files:**
- Create: `core/src/routes/core/worker.routes.ts`
- Modify: `core/src/routes/core/index.ts`
- Test: `core/src/__tests__/worker-role-routes.test.ts`

Read first: an existing route file (e.g. `core/src/routes/core/ccr.routes.ts`) for the `{ method, pattern, handler }` + envelope shape, and `core/src/routes/core/index.ts` for the registration pattern.

- [ ] **Step 1: Write the failing test** (drives the pure handlers directly — no live server)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wrkroutes-'));

import { createWorkerRoutes } from '../routes/core/worker.routes';

const routes = createWorkerRoutes({} as any);
const find = (method: string, urlPath: string) => {
  const r = routes.find((x) => x.method === method && x.pattern.test(urlPath));
  if (!r) throw new Error(`no route ${method} ${urlPath}`);
  const params = (r.pattern.exec(urlPath) as any)?.groups ?? {};
  return { r, params };
};
const call = async (method: string, urlPath: string, body?: any) => {
  const { r, params } = find(method, urlPath);
  return r.handler({ params, query: {}, body } as any, {} as any);
};

test('routes: set role → report status → read → decide gate', async () => {
  const set = await call('POST', '/worker/role', { sessionId: 's1', task: { title: 'deploy' } });
  assert.equal((set as any).success, true);
  const taskId = (set as any).data.tasks[0].id;

  await call('POST', '/worker/status', { sessionId: 's1', taskId, status: 'need_approval', reason: 'prod?' });
  const read = await call('GET', '/worker/s1', undefined);
  assert.equal((read as any).data.tasks[0].gate.state, 'open');

  const decided = await call('POST', '/worker/s1/gate', { taskId, decision: 'agree', by: 'orch-1', note: 'go' });
  assert.equal((decided as any).data.tasks[0].gate.state, 'agreed');
  assert.equal((decided as any).data.tasks[0].status, 'working');
});

test('routes: GET /worker/:id stamps the reader as orchestrator when ?orchestrator= is given', async () => {
  await call('POST', '/worker/role', { sessionId: 's2', task: { title: 't' } });
  const { r, params } = find('GET', '/worker/s2');
  const read = await r.handler({ params, query: { orchestrator: 'orch-9' }, body: undefined } as any, {} as any);
  assert.equal((read as any).data.orchestrator.id, 'orch-9');
  assert.equal(typeof (read as any).data.orchestrator.lastContact, 'number');
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js`
Expected: FAIL — `Cannot find module '../routes/core/worker.routes'`.

- [ ] **Step 3: Implement `worker.routes.ts`**

```typescript
// core/src/routes/core/worker.routes.ts
import type { RouteHandler, RouteContext } from '../index';
import { randomBytes } from 'crypto';
import { getRecord, listRecords, putRecord, stampOrchestrator } from '../../worker-role/worker-store';
import { applySetRole, applyReportStatus, decideGate, liveness } from '../../worker-role/model';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string }; }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });
const genId = () => 'task_' + randomBytes(4).toString('hex');
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Attach derived orchestrator liveness to a record for read responses. */
function withLiveness(rec: any, now: number) {
  return { ...rec, orchestratorLiveness: liveness(rec.orchestrator, now) };
}

export function createWorkerRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    { method: 'POST', pattern: /^\/worker\/role$/, handler: async (req) => {
      const b = (req.body || {}) as Record<string, unknown>;
      const sessionId = str(b.sessionId);
      if (!sessionId) return fail('INVALID_INPUT', 'sessionId is required');
      const task = b.task as { title?: string } | undefined;
      if (b.role === 'none') { putRecord({ sessionId, role: 'worker', tasks: [], orchestrator: {}, updatedAt: Date.now() }); return ok({ cleared: true }); }
      if (task && !task.title) return fail('INVALID_INPUT', 'task.title is required');
      const rec = applySetRole(getRecord(sessionId), sessionId, { task: task as any, orchestrator: str(b.orchestrator) }, Date.now(), genId);
      return ok(putRecord(rec));
    } },

    { method: 'POST', pattern: /^\/worker\/status$/, handler: async (req) => {
      const b = (req.body || {}) as Record<string, unknown>;
      const sessionId = str(b.sessionId); const taskId = str(b.taskId);
      if (!sessionId || !taskId) return fail('INVALID_INPUT', 'sessionId and taskId are required');
      const prev = getRecord(sessionId);
      if (!prev) return fail('NOT_FOUND', `no worker record for ${sessionId} (call /worker/role first)`);
      const rec = applyReportStatus(prev, { taskId, status: b.status as any, progress: str(b.progress), detail: str(b.detail), reason: str(b.reason) }, Date.now());
      return ok(putRecord(rec));
    } },

    { method: 'GET', pattern: /^\/worker$/, handler: async () => {
      const now = Date.now();
      return ok({ workers: listRecords().map((r) => withLiveness(r, now)) });
    } },

    { method: 'GET', pattern: /^\/worker\/(?<sessionId>[^/]+)$/, handler: async (req) => {
      const sessionId = req.params.sessionId;
      const orchestrator = str((req.query || {}).orchestrator);
      const now = Date.now();
      const rec = orchestrator ? stampOrchestrator(sessionId, orchestrator, now) : getRecord(sessionId);
      if (!rec) return fail('NOT_FOUND', `no worker record for ${sessionId}`);
      return ok(withLiveness(rec, now));
    } },

    { method: 'POST', pattern: /^\/worker\/(?<sessionId>[^/]+)\/gate$/, handler: async (req) => {
      const sessionId = req.params.sessionId;
      const b = (req.body || {}) as Record<string, unknown>;
      const taskId = str(b.taskId); const decision = b.decision;
      if (!taskId || (decision !== 'agree' && decision !== 'reject')) return fail('INVALID_INPUT', 'taskId and decision (agree|reject) are required');
      const prev = getRecord(sessionId);
      if (!prev) return fail('NOT_FOUND', `no worker record for ${sessionId}`);
      const idx = prev.tasks.findIndex((t) => t.id === taskId);
      if (idx < 0) return fail('NOT_FOUND', `task ${taskId} not found`);
      try {
        const tasks = [...prev.tasks];
        tasks[idx] = decideGate(tasks[idx], decision, str(b.by) ?? 'unknown', str(b.note), Date.now());
        return ok(putRecord({ ...prev, tasks, updatedAt: Date.now() }));
      } catch (e) { return fail('PRECONDITION_FAILED', (e as Error).message); }
    } },
  ];
}
```

- [ ] **Step 4: Register in `core/src/routes/core/index.ts`**

Add the import alongside the other `create*Routes` imports, and spread `...createWorkerRoutes(ctx)` into the returned route array exactly where the other route groups are spread (match the file's existing pattern):

```typescript
import { createWorkerRoutes } from './worker.routes';
// ... in the aggregation array, next to createCcrRoutes(ctx):
...createWorkerRoutes(ctx),
```

- [ ] **Step 5: Run tests + full build, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js && npm run build 2>&1 | tail -2`
Expected: route tests PASS; `npm run build` (tsc) prints no errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/routes/core/worker.routes.ts core/src/routes/core/index.ts core/src/__tests__/worker-role-routes.test.ts
git commit -m "feat(worker-role): /worker REST routes (role/status/list/read+stamp/gate)"
```

---

## Task 8: MCP tools + scopes

**Files:**
- Create: `core/src/mcp-server/tools/worker-role.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts`
- Modify: `core/src/mcp-server/configure.ts`
- Test: `core/src/__tests__/worker-role-routes.test.ts` (append a scopes test)

Read first: `core/src/mcp-server/tools/fs-inspect.ts` for the `*_TOOL_DEFS` + `*_HANDLERS` + `workerGet`/`workerPost` pattern, and `core/src/mcp-server/tools/_passthrough.ts`.

- [ ] **Step 1: Write the failing test (scope coverage)**

```typescript
import { TOOL_SCOPES } from '../mcp-server/configure';
import { WORKER_ROLE_TOOL_DEFS } from '../mcp-server/tools/worker-role';

test('every worker-role tool has a TOOL_SCOPES entry (else Core crashes on /mcp)', () => {
  for (const def of WORKER_ROLE_TOOL_DEFS) {
    assert.ok(def.name in TOOL_SCOPES, `${def.name} missing from TOOL_SCOPES`);
  }
});

test('worker-role advertises the five tools', () => {
  const names = WORKER_ROLE_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['decide_gate', 'list_workers', 'report_status', 'set_role', 'worker_status']);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js`
Expected: FAIL — `Cannot find module '../mcp-server/tools/worker-role'`.

- [ ] **Step 3: Implement `worker-role.ts`**

```typescript
// core/src/mcp-server/tools/worker-role.ts
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const S = { type: 'string' as const };

export const WORKER_ROLE_TOOL_DEFS = [
  { name: 'set_role', description: 'Take (or update) the WORKER role for a session and declare a worker-OWNED task. Self- or other-assigned; one active role. Pass role:"none" to clear.',
    inputSchema: obj({ sessionId: S, role: { ...S, enum: ['worker', 'none'] }, task: { type: 'object', properties: { title: S, group: S, parentId: S, id: S }, required: ['title'] }, orchestrator: S }, ['sessionId']) },
  { name: 'report_status', description: 'A worker reports progress on one of its own tasks (status/progress/detail). status:"need_approval" with a reason raises an agree-gate and the worker must STOP until decided.',
    inputSchema: obj({ sessionId: S, taskId: S, status: { ...S, enum: ['todo', 'working', 'blocked', 'need_approval', 'done', 'skipped'] }, progress: S, detail: S, reason: S }, ['sessionId', 'taskId']) },
  { name: 'worker_status', description: "Read a worker's role, task tree (with statuses + open gates), and orchestrator liveness. Reading STAMPS you as the worker's orchestrator (refreshes its lastContact).",
    annotations: { readOnlyHint: true }, inputSchema: obj({ sessionId: S, orchestrator: S }, ['sessionId']) },
  { name: 'list_workers', description: 'List all worker records on this node (sessionId, tasks, orchestrator liveness).',
    annotations: { readOnlyHint: true }, inputSchema: obj({}) },
  { name: 'decide_gate', description: 'Resolve a worker\'s open agree-gate: decision "agree" unblocks the gated task, "reject" halts it. The orchestrator/human "agree" action.',
    inputSchema: obj({ sessionId: S, taskId: S, decision: { ...S, enum: ['agree', 'reject'] }, by: S, note: S }, ['sessionId', 'taskId', 'decision']) },
] as const;

const j = (v: unknown) => ok(JSON.stringify(v, null, 2));

export const WORKER_ROLE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  set_role: async (a) => { try { return j(await workerPost('/worker/role', a)); } catch (e) { return err((e as Error).message); } },
  report_status: async (a) => { try { return j(await workerPost('/worker/status', a)); } catch (e) { return err((e as Error).message); } },
  worker_status: async (a) => { try { const q = a.orchestrator ? `?orchestrator=${encodeURIComponent(String(a.orchestrator))}` : ''; return j(await workerGet(`/worker/${encodeURIComponent(String(a.sessionId))}${q}`)); } catch (e) { return err((e as Error).message); } },
  list_workers: async () => { try { return j(await workerGet('/worker')); } catch (e) { return err((e as Error).message); } },
  decide_gate: async (a) => { try { return j(await workerPost(`/worker/${encodeURIComponent(String(a.sessionId))}/gate`, a)); } catch (e) { return err((e as Error).message); } },
};
```

- [ ] **Step 4: Wire into `expanded.ts`**

Add the import next to the other tool-module imports, and spread the defs/handlers into the exported aggregates exactly like `FS_INSPECT_TOOL_DEFS`/`FS_INSPECT_HANDLERS` are:

```typescript
import { WORKER_ROLE_TOOL_DEFS, WORKER_ROLE_HANDLERS } from './worker-role';
// ... where EXPANDED_TOOL_DEFS is assembled: add ...WORKER_ROLE_TOOL_DEFS
// ... where EXPANDED_HANDLERS is assembled: add ...WORKER_ROLE_HANDLERS
```

- [ ] **Step 5: Add `TOOL_SCOPES` entries in `configure.ts`**

In the `TOOL_SCOPES` object add:

```typescript
  set_role: 'write',
  report_status: 'write',
  worker_status: 'read',
  list_workers: 'read',
  decide_gate: 'admin',
```

- [ ] **Step 6: Run tests + full build, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js && npm run build 2>&1 | tail -2`
Expected: scope + tool-count tests PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/mcp-server/tools/worker-role.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/worker-role-routes.test.ts
git commit -m "feat(worker-role): 5 MCP tools (set_role/report_status/worker_status/list_workers/decide_gate) + scopes"
```

---

## Task 9: Bootstrap ROLE section

**Files:**
- Modify: `core/src/mcp-server/mcp-session-resolver.ts`
- Test: `core/src/__tests__/worker-role-routes.test.ts` (append)

Read first: `mcp-session-resolver.ts` `identityHeader` (it builds the string prepended to bootstrap) and how it knows the caller's `sessionId`.

- [ ] **Step 1: Write the failing test for the pure renderer**

```typescript
import { renderRoleSection } from '../mcp-server/mcp-session-resolver';
import type { WorkerRecord } from '../worker-role/types';

test('renderRoleSection: worker contract names role, task, orchestrator + the print rule', () => {
  const rec: WorkerRecord = { sessionId: 's1', role: 'worker', tasks: [{ id: 't1', title: 'deploy', status: 'working' }], orchestrator: { id: 'o1', lastContact: Date.now() }, updatedAt: Date.now() };
  const s = renderRoleSection(rec, Date.now());
  assert.match(s, /You are a WORKER/);
  assert.match(s, /WORKER-STATUS/);            // the print contract
  assert.match(s, /orchestrator/i);
  assert.match(s, /active/);                    // liveness reflected
});

test('renderRoleSection: no record → a one-line set_role hint, no guessing', () => {
  const s = renderRoleSection(null, Date.now());
  assert.match(s, /set_role/);
  assert.doesNotMatch(s, /You are a WORKER/);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js`
Expected: FAIL — `renderRoleSection` not exported.

- [ ] **Step 3: Add `renderRoleSection` to `mcp-session-resolver.ts` and call it from `identityHeader`**

```typescript
// add imports at the top of mcp-session-resolver.ts
import type { WorkerRecord } from '../worker-role/types';
import { liveness } from '../worker-role/model';

/** Pure: the ROLE section appended to the identity block. Exported for tests. */
export function renderRoleSection(rec: WorkerRecord | null, now: number): string {
  if (!rec || rec.role !== 'worker') {
    return '[lm-assist — role]\nThis session has no worker role. If you are meant to be a worker, call set_role({sessionId, task:{title}}).\n\n';
  }
  const live = liveness(rec.orchestrator, now);
  const tasks = rec.tasks.map((t) => `  - ${t.id} "${t.title}" [${t.status}]${t.gate?.state === 'open' ? ' (GATE OPEN: ' + t.gate.reason + ')' : ''}`).join('\n') || '  (none yet)';
  return [
    '[lm-assist — you are a WORKER]',
    `Tasks (worker-owned):\n${tasks}`,
    `Orchestrator: ${rec.orchestrator.id ?? 'none'} (${live}).`,
    'CONTRACT: every turn, print a ⟦WORKER-STATUS⟧ … ⟦/WORKER-STATUS⟧ block (Way 1 — always). If an orchestrator is active you MAY also report_status (Way 3) and message it (Way 2). Before any gated step, report_status(status:"need_approval", reason) and STOP until the gate is agreed.',
    '',
    '',
  ].join('\n');
}
```

Then wire it into `identityHeader(c: CallerCandidates): string`. That function has **multiple `return` statements**, so compute the section ONCE at the top and append it to each returned string. Use the same caller-id precedence the file already uses (see its `{ id: ... }` resolver near line 166):

```typescript
import { getRecord } from '../worker-role/worker-store';
// at the TOP of identityHeader(c), before its existing logic:
const callerId = (c.precise ? c.claudeCode?.id : undefined) ?? c.claudeAi?.id ?? c.claudeCode?.id;
const roleSection = renderRoleSection(callerId ? getRecord(callerId) : null, Date.now());
// then change EACH `return <string>;` in identityHeader to `return <string> + roleSection;`
```

- [ ] **Step 4: Run tests + full build, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js && npm run build 2>&1 | tail -2`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/mcp-server/mcp-session-resolver.ts core/src/__tests__/worker-role-routes.test.ts
git commit -m "feat(worker-role): bootstrap ROLE section (worker contract / set_role hint)"
```

---

## Task 10: `guide("roles")` topic

**Files:**
- Modify: `core/src/mcp-server/tools/guide.ts`
- Test: `core/src/__tests__/guide.test.ts` (append)

Read first: `guide.ts` (the `GUIDES`, `order`, `BLURB`, `ALIASES` structure — mirror how the `install` topic was added).

- [ ] **Step 1: Write the failing test**

```typescript
test('bootstrap + guide expose the roles topic', async () => {
  const b = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(b, /Guide: worker role/);
  const g = await text({ topic: 'roles' });
  assert.match(g, /⟦WORKER-STATUS⟧/);
  assert.match(g, /set_role/);
  assert.match(g, /decide_gate/);
  for (const syn of ['worker', 'orchestrator', 'agree-gate']) assert.match(await text({ topic: syn }), /Guide: worker role/, `alias ${syn}`);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/guide.test.js`
Expected: FAIL — no roles topic.

- [ ] **Step 3: Add the `roles` topic to `guide.ts`**

In `GUIDES`, add (before `data:`):

```typescript
  roles: `# Guide: worker role + orchestration (set_role / report_status / decide_gate)
A session can take ONE active role: WORKER. Assigned by itself OR by a launcher; it owns its OWN task list (groups/sub-tasks) — not necessarily orchestrator-created.
BECOME A WORKER: set_role({sessionId, task:{title, group?, parentId?}}). Appends a worker-owned task; one active role. set_role({role:'none'}) clears.
REPORT (3 ways): (1) ALWAYS print a ⟦WORKER-STATUS⟧ task=.. status=working|blocked|need_approval|done progress=.. block into your output each turn — anyone reads it via session-read. (2) optional report_status({sessionId, taskId, status, progress?, detail?}) → durable record (Way 3). (3) when an orchestrator is active, report_status also messages it (Way 2).
AGREE-GATE: before a sensitive step, report_status({status:'need_approval', reason}) → opens a gate; print it and STOP until agreed. An orchestrator agrees via decide_gate({sessionId, taskId, decision:'agree'|'reject'}); with no orchestrator, a human types the decision into your session.
ORCHESTRATOR (optional; none/active/inactive): reading a worker (worker_status / list_workers) STAMPS the reader as its orchestrator and refreshes lastContact (>5 min stale ⇒ inactive). Drive a worker via send_session_message or CCR; agree a gate via decide_gate.
CROSS-NODE: all five tools take node=<host>.`,
```

In the bootstrap `order` array, add `'roles'` after `'install'`. In `BLURB`, add:

```typescript
  roles: 'worker role + orchestration — set_role, the ⟦WORKER-STATUS⟧ print contract, the 3 report channels, and the agree-gate',
```

In `ALIASES`, add:

```typescript
  roles: 'roles', role: 'roles', worker: 'roles', orchestrator: 'roles', 'agree-gate': 'roles', gate: 'roles', set_role: 'roles', report_status: 'roles', worker_status: 'roles', list_workers: 'roles', decide_gate: 'roles',
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/guide.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/mcp-server/tools/guide.ts core/src/__tests__/guide.test.ts
git commit -m "feat(worker-role): guide('roles') topic wired into bootstrap"
```

---

## Task 11: End-to-end integration test

**Files:**
- Test: `core/src/__tests__/worker-role-routes.test.ts` (append)

- [ ] **Step 1: Write the e2e test (model + store + routes together; orchestrator liveness path)**

```typescript
import { liveness as live2 } from '../worker-role/model';

test('e2e: self-directed worker (orchestrator none) then an orchestrator attaches and agrees a gate', async () => {
  // 1) manual mode: worker self-assigns, orchestrator none
  const set = await call('POST', '/worker/role', { sessionId: 'e2e', task: { title: 'ship', group: 'Phase 1' } });
  const taskId = (set as any).data.tasks[0].id;
  assert.equal(live2((set as any).data.orchestrator, Date.now()), 'none');

  // 2) worker raises an agree-gate and stops
  await call('POST', '/worker/status', { sessionId: 'e2e', taskId, status: 'need_approval', reason: 'prod deploy?' });

  // 3) an orchestrator reads it → becomes active
  const read = await (async () => { const { r, params } = find('GET', '/worker/e2e'); return r.handler({ params, query: { orchestrator: 'orch-e2e' }, body: undefined } as any, {} as any); })();
  assert.equal((read as any).data.orchestratorLiveness, 'active');

  // 4) orchestrator agrees the gate → task unblocks
  const decided = await call('POST', '/worker/e2e/gate', { taskId, decision: 'agree', by: 'orch-e2e' });
  assert.equal((decided as any).data.tasks[0].gate.state, 'agreed');
  assert.equal((decided as any).data.tasks[0].status, 'working');
});
```

- [ ] **Step 2: Run, verify PASS** (all logic already implemented)

Run: `cd core && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/worker-role-routes.test.js`
Expected: PASS.

- [ ] **Step 3: Run the FULL test suite + build, verify nothing regressed**

Run: `cd core && npm test 2>&1 | tail -8 && npm run build 2>&1 | tail -2`
Expected: all suites pass; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add core/src/__tests__/worker-role-routes.test.ts
git commit -m "test(worker-role): end-to-end manual→attach→agree-gate flow"
```

---

## Task 12: Deploy to dev + prod & verify live

**Files:** none (deploy only)

- [ ] **Step 1: Build + restart dev**

Run: `export PATH=~/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist && ./core.sh build && ./core.sh restart`
Expected: dev Core :3200 healthy.

- [ ] **Step 2: Verify the tools live on dev `/mcp`**

```bash
TOK=$(cat ~/.lm-assist/api-token | head -1)
curl -s -X POST localhost:3200/mcp -H "x-api-key: $TOK" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_role","arguments":{"sessionId":"smoke-1","task":{"title":"smoke"}}}}' | grep -o '"role":"worker"'
```
Expected: prints `"role":"worker"`.

- [ ] **Step 3: Deploy to prod (worker-token-safe sync) + verify**

```bash
PC=/home/ubuntu/.nvm/versions/node/v20.19.6/lib/node_modules/lm-assist/core
rsync -a core/dist/ "$PC/dist/"
kill $(cat ~/.cache/lm-assist/core-prod.pid); sleep 1
~/.nvm/versions/node/v20.19.6/bin/lm-assist start
curl -s localhost:3100/health | grep -o '"status":"healthy"'
curl -s localhost:3100/hub/status -H "x-api-key: $(cat ~/.lm-assist/api-token|head -1)" | grep -o '"authenticated":true'
```
Expected: healthy + hub authenticated (MCP path live with the new tools).

- [ ] **Step 4: Refresh the connector tool list** so the 5 new tools surface in fresh sessions

Use the langmart connector: `refresh_connector_tools`, then confirm via `list_claudeai_connectors` the tool count rose by 5.

- [ ] **Step 5: Commit / push the branch + open PR** (only when the user asks)

---

## Self-Review

- **Spec coverage:** §2 model → Tasks 1,5; §2.3 status block → Task 1; §3 bootstrap → Task 9; §4 channels → Ways 1 (Task 1 print), 2/3 (Task 8 tools over Task 7 routes); §5 gate → Tasks 3,7,8; §6 launch modes → Task 11 e2e (manual→attach) + the routes' `orchestrator` stamping; §7 tools + scopes → Task 8; §8 errors → route guards (Task 7) + `decideGate` throw (Task 3) + degrade (store always-local); §10 inventory → Tasks 6–10; §11 testing → every task is TDD. No gaps.
- **Placeholders:** none — every code step is complete.
- **Type consistency:** `WorkerRecord`/`Task`/`Gate`/`StatusLine` defined once (Task 1) and imported everywhere; `applySetRole`/`applyReportStatus`/`decideGate`/`liveness`/`rollUp` signatures match across model (Task 2–5), store (Task 6), routes (Task 7), resolver (Task 9).
