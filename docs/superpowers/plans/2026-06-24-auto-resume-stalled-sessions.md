# Auto-Resume Sessions Stalled on Server Errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect Claude Code sessions stalled on a non-user **server** error (529/5xx/server-rate-limit) and resume them with `continue` every ~5 min (capped backoff, then flag) — local sessions per-node, remote cloud CCRs by a single auto-elected monitor node.

**Architecture:** A new `core/src/monitor/` module of small units (pure classifier / retry-state / election + IO detectors / resumer / store), tied together by one `stall-monitor` handler registered into the existing `scheduled-jobs.ts` cron (intervalMinutes 5, enabled by default, auto-started at boot). Reuses `cc-classify.ts` (server-vs-user), `session-messaging.sendMessage` (local resume), `ccr-cloud` (remote read/drive), the hub `/api/tier-agent/machines` list (election), and `project-settings.ts` (toggles). No hub-side changes.

**Tech Stack:** TypeScript (CommonJS core), `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-06-24-auto-resume-stalled-sessions-design.md`
**Branch:** `feat/auto-resume-stalled-sessions` (already created).

## Global Constraints

- **Safety rule (NEVER violate):** auto-`continue` ONLY when the classified state ∈ `{overloaded, server_error, rate_limit_server}`. NEVER on `rate_limit_user` or `auth_error` (and never on `await_question`/`folder_trust`).
- **Reuse, don't re-implement** the server-vs-user classification: wrap the existing `classifyScreen` from `core/src/terminal/cc-classify.ts` — do NOT copy its regexes.
- **core is CommonJS** (`module: commonjs`): no ESM-only deps, no un-guarded `await import()` of ESM. Tests live in `core/src/__tests__/*.test.ts`, built via `cd core && npm run build:test`, run via `node --test dist-test/__tests__/<f>.test.js`.
- **Pure units take injected inputs** (no IO) so they're unit-testable; IO units are thin wrappers. The orchestrator takes its detectors/resumers/election as **injectable deps** (default to the real ones) for testing.
- **On by default:** the seeded scheduled job ships `enabled: true, intervalMinutes: 5` (the deliberate deviation from other built-ins which ship disabled).
- **Per-node state** in `~/.lm-assist/stall-monitor.json` via `getDataDir()`, atomic write mode 0600 (mirror `worker-role/worker-store.ts`).
- **Dev host commands need Node ≥ 20.9:** prefix with `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH`.
- **🔴 e2e must not disturb the live fleet:** run the monitor tick on-demand via `POST /scheduler/jobs/stall-monitor/run`, against an isolated/synthetic session; never let an e2e send `continue` into a real production session you don't control, and never bind prod ports.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/monitor/stall-classify.ts` | pure `isServerStall(text)` — wraps `classifyScreen` |
| `core/src/monitor/stall-state.ts` | pure `planStallAction(...)` retry/backoff state machine + types |
| `core/src/monitor/stall-election.ts` | pure `electMonitor(ids, self)` + IO `amIMonitor()` |
| `core/src/monitor/stall-store.ts` | load/save `~/.lm-assist/stall-monitor.json` |
| `core/src/monitor/stall-detect-local.ts` | IO `findLocalStalls()` — this node's server-stalled local sessions |
| `core/src/monitor/stall-detect-remote.ts` | IO `findRemoteStalls()` — account cloud CCRs that are server-stalled |
| `core/src/monitor/stall-resume.ts` | IO `resumeLocal(id)` / `resumeRemote(sid)` |
| `core/src/monitor/stall-monitor.ts` | orchestrator `runStallMonitorTick(deps)` + `registerStallMonitor()` |
| `core/src/data/peer-client.ts` (modify) | add exported `listOnlineNodeIds()` |
| `core/src/terminal/ccr-cloud.ts` (modify) | add exported `cloudListAccount()` (GET /v1/code/sessions) |
| `core/src/scheduler/scheduled-jobs.ts` (modify) | seed the `stall-monitor` built-in + register its handler |
| `core/src/project-settings.ts` (modify) | 4 new fields |
| `core/src/routes/core/monitor-stalls.routes.ts` | `GET /monitor/stalls` |
| `core/src/routes/core/index.ts` (modify) | register the route factory |
| `core/src/mcp-server/tools/expanded.ts` (modify) | `stall_status` read tool |

---

### Task 1: `stall-classify.ts` — pure server-stall classifier

**Files:**
- Create: `core/src/monitor/stall-classify.ts`
- Test: `core/src/__tests__/stall-classify.test.ts`

**Interfaces:**
- Consumes: `classifyScreen(text): { state: ScreenState; ... }` and the `ScreenState` type from `core/src/terminal/cc-classify.ts`.
- Produces: `isServerStall(text: string): { retryable: boolean; category: ScreenState }` and `const SERVER_STALL_STATES: ScreenState[]`.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/stall-classify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { isServerStall } from '../monitor/stall-classify';

test('server errors are retryable', () => {
  for (const s of ['API Error: 529', 'Overloaded', 'Waiting for capacity', 'API Error: 500', 'Internal server error', 'Server is temporarily limiting requests (not your usage limit)']) {
    const r = isServerStall(s);
    assert.strictEqual(r.retryable, true, `expected retryable for: ${s} (got ${r.category})`);
  }
});

test('user usage-limit and auth are NEVER retryable', () => {
  for (const s of ['Claude usage limit reached', '5-hour limit reached', "You've been rate limited", 'OAuth token has expired', 'Invalid API key', 'Credit balance is too low']) {
    const r = isServerStall(s);
    assert.strictEqual(r.retryable, false, `expected NOT retryable for: ${s} (got ${r.category})`);
  }
});

test('idle/empty text is not retryable', () => {
  assert.strictEqual(isServerStall('').retryable, false);
  assert.strictEqual(isServerStall('> ready for input').retryable, false);
});

test('category is reported', () => {
  assert.strictEqual(isServerStall('API Error: 529').category, 'overloaded');
  assert.strictEqual(isServerStall('Claude usage limit reached').category, 'rate_limit_user');
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npm run build:test 2>&1 | tail -3 && node --test dist-test/__tests__/stall-classify.test.js`
Expected: FAIL — `Cannot find module '../monitor/stall-classify'`.

- [ ] **Step 3: Implement**

Create `core/src/monitor/stall-classify.ts`:

```ts
/**
 * Server-vs-user stall classification — the SAFETY boundary for auto-resume.
 * Wraps the existing ordered classifier so the regexes live in exactly one place.
 */
import { classifyScreen, ScreenState } from '../terminal/cc-classify';

/** States that mean "the SERVER hiccuped" — safe to auto-`continue`. */
export const SERVER_STALL_STATES: ScreenState[] = ['overloaded', 'server_error', 'rate_limit_server'];

/** Classify a screen/error text. `retryable` is true ONLY for server-side stalls
 *  (529 / 5xx / server throttle) — NEVER for the user's own usage limit or auth errors. */
export function isServerStall(text: string): { retryable: boolean; category: ScreenState } {
  const { state } = classifyScreen(text || '');
  return { retryable: SERVER_STALL_STATES.includes(state), category: state };
}
```

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-classify.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/monitor/stall-classify.ts core/src/__tests__/stall-classify.test.ts
git commit -m "feat(monitor): isServerStall classifier (reuses cc-classify)"
```

---

### Task 2: `stall-state.ts` — pure retry/backoff state machine

**Files:**
- Create: `core/src/monitor/stall-state.ts`
- Test: `core/src/__tests__/stall-state.test.ts`

**Interfaces:**
- Produces:
  - `interface StallRecord { attempts: number; lastNudgeAt: number; category: string; backoffStep: number; gaveUp: boolean }`
  - `interface StallConfig { intervalMin: number; maxAttempts: number }`
  - `type StallAction = 'nudge' | 'wait' | 'giveup' | 'reset'`
  - `function backoffMinutes(step: number, intervalMin: number): number` — schedule 5,5,10,10,15,15… = `(Math.floor(step / 2) + 1) * intervalMin`
  - `function planStallAction(rec: StallRecord | undefined, opts: { now: number; stillStalled: boolean; seenProgress: boolean; cfg: StallConfig }): { action: StallAction; next: StallRecord | null }`

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/stall-state.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { planStallAction, backoffMinutes, StallRecord, StallConfig } from '../monitor/stall-state';

const cfg: StallConfig = { intervalMin: 5, maxAttempts: 6 };
const MIN = 60_000;

test('backoffMinutes widens 5,5,10,10,15,15', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((s) => backoffMinutes(s, 5)), [5, 5, 10, 10, 15, 15]);
});

test('first detection nudges (attempt 1)', () => {
  const r = planStallAction(undefined, { now: 1000, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'nudge');
  assert.strictEqual(r.next!.attempts, 1);
  assert.strictEqual(r.next!.lastNudgeAt, 1000);
});

test('not yet due → wait', () => {
  const rec: StallRecord = { attempts: 1, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 0, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 4 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'wait');
});

test('due → nudge again, attempts++ and backoff widens', () => {
  const rec: StallRecord = { attempts: 1, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 0, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 5 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'nudge');
  assert.strictEqual(r.next!.attempts, 2);
  assert.strictEqual(r.next!.backoffStep, 1);
});

test('cap reached → giveup', () => {
  const rec: StallRecord = { attempts: 6, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 5, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 999 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'giveup');
  assert.strictEqual(r.next!.gaveUp, true);
});

test('progress seen → reset (clears record)', () => {
  const rec: StallRecord = { attempts: 3, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 1, gaveUp: false };
  const r = planStallAction(rec, { now: 9_999_999, stillStalled: false, seenProgress: true, cfg });
  assert.strictEqual(r.action, 'reset');
  assert.strictEqual(r.next, null);
});

test('no longer stalled (no progress flag) → wait, keep record', () => {
  const rec: StallRecord = { attempts: 2, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 1, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 99 * MIN, stillStalled: false, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'wait');
});

test('already gaveUp → wait (never nudge again)', () => {
  const rec: StallRecord = { attempts: 6, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 5, gaveUp: true };
  const r = planStallAction(rec, { now: 1000 + 999 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'wait');
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-state.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `core/src/monitor/stall-state.ts`:

```ts
/** Pure retry/backoff state machine for one stalled session. No IO. */

export interface StallRecord {
  attempts: number;
  lastNudgeAt: number; // epoch ms of the last `continue` sent
  category: string; // the classified ScreenState at last detection
  backoffStep: number; // index into the widening schedule
  gaveUp: boolean;
}

export interface StallConfig {
  intervalMin: number; // base interval (default 5)
  maxAttempts: number; // cap before giving up (default 6)
}

export type StallAction = 'nudge' | 'wait' | 'giveup' | 'reset';

/** Widening schedule: 5,5,10,10,15,15,… minutes. */
export function backoffMinutes(step: number, intervalMin: number): number {
  return (Math.floor(step / 2) + 1) * intervalMin;
}

export function planStallAction(
  rec: StallRecord | undefined,
  opts: { now: number; stillStalled: boolean; seenProgress: boolean; cfg: StallConfig },
): { action: StallAction; next: StallRecord | null } {
  const { now, stillStalled, seenProgress, cfg } = opts;

  // It recovered (a new turn appeared / left the stall after a nudge) → forget it.
  if (seenProgress) return { action: 'reset', next: null };

  // Not currently stalled and no record yet → nothing to do.
  if (!stillStalled) return { action: 'wait', next: rec ?? null };

  // Stalled, no record → first nudge.
  if (!rec) {
    return { action: 'nudge', next: { attempts: 1, lastNudgeAt: now, category: 'unknown', backoffStep: 0, gaveUp: false } };
  }

  if (rec.gaveUp) return { action: 'wait', next: rec };

  if (rec.attempts >= cfg.maxAttempts) {
    return { action: 'giveup', next: { ...rec, gaveUp: true } };
  }

  const dueAt = rec.lastNudgeAt + backoffMinutes(rec.backoffStep, cfg.intervalMin) * 60_000;
  if (now < dueAt) return { action: 'wait', next: rec };

  return {
    action: 'nudge',
    next: { ...rec, attempts: rec.attempts + 1, lastNudgeAt: now, backoffStep: rec.backoffStep + 1 },
  };
}
```

(Note: the orchestrator overwrites `next.category` with the freshly-classified category before persisting; the state machine itself only carries it.)

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-state.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/monitor/stall-state.ts core/src/__tests__/stall-state.test.ts
git commit -m "feat(monitor): stall retry/backoff state machine (pure)"
```

---

### Task 3: `stall-election.ts` — pure election + online-node fetch

**Files:**
- Create: `core/src/monitor/stall-election.ts`
- Modify: `core/src/data/peer-client.ts` (add exported `listOnlineNodeIds()`)
- Test: `core/src/__tests__/stall-election.test.ts`

**Interfaces:**
- Consumes: `getHubConfig()` from `../hub-client/hub-config` (`.gatewayId`); the existing private `hubFetch('/api/tier-agent/machines')` inside `peer-client.ts` (response `{ machines: [{ gatewayId, status, ... }] }`).
- Produces:
  - in `peer-client.ts`: `export async function listOnlineNodeIds(): Promise<string[]>` — all machine `gatewayId`s with `status === 'online'` (INCLUDING self).
  - in `stall-election.ts`: `export function electMonitor(onlineNodeIds: string[], selfId: string | null): boolean` (pure); `export async function amIMonitor(): Promise<{ isMonitor: boolean; monitorNodeId: string | null; selfId: string | null }>` (IO).

- [ ] **Step 1: Write the failing test (pure election only)**

Create `core/src/__tests__/stall-election.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { electMonitor } from '../monitor/stall-election';

test('lowest gateway-id self-elects', () => {
  assert.strictEqual(electMonitor(['gw4-aaa', 'gw4-bbb', 'gw4-ccc'], 'gw4-aaa'), true);
  assert.strictEqual(electMonitor(['gw4-aaa', 'gw4-bbb', 'gw4-ccc'], 'gw4-bbb'), false);
});

test('self not present in the list is still considered a candidate', () => {
  assert.strictEqual(electMonitor(['gw4-zzz'], 'gw4-aaa'), true); // aaa < zzz
  assert.strictEqual(electMonitor(['gw4-aaa'], 'gw4-zzz'), false);
});

test('single node (self only) is the monitor', () => {
  assert.strictEqual(electMonitor([], 'gw4-solo'), true);
  assert.strictEqual(electMonitor(['gw4-solo'], 'gw4-solo'), true);
});

test('null self never elects', () => {
  assert.strictEqual(electMonitor(['gw4-aaa'], null), false);
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-election.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3a: Add `listOnlineNodeIds()` to `peer-client.ts`**

In `core/src/data/peer-client.ts`, add this exported function at the end of the file, BEFORE the `getHubPeerClient` factory (it reuses the module-private `hubFetch` + `getHubConfig`):

```ts
/** All fleet machine gateway-ids currently `status:"online"` (INCLUDING this node). */
export async function listOnlineNodeIds(): Promise<string[]> {
  const json = (await hubFetch('/api/tier-agent/machines')) as any;
  const machines: any[] = Array.isArray(json) ? json : json.machines || json.data || [];
  return machines
    .filter((m) => (m.status || '').toLowerCase() === 'online')
    .map((m) => (m.gatewayId || m.machineId || m.id) as string)
    .filter((id): id is string => typeof id === 'string' && !!id);
}
```

- [ ] **Step 3b: Implement `stall-election.ts`**

Create `core/src/monitor/stall-election.ts`:

```ts
/** Single-monitor election by deterministic convention over the hub's online-node set. */
import { getHubConfig } from '../hub-client/hub-config';
import { listOnlineNodeIds } from '../data/peer-client';

/** Pure: true iff `selfId` is the lowest id among the online candidates (self always a candidate). */
export function electMonitor(onlineNodeIds: string[], selfId: string | null): boolean {
  if (!selfId) return false;
  const candidates = onlineNodeIds.includes(selfId) ? onlineNodeIds.slice() : [...onlineNodeIds, selfId];
  candidates.sort();
  return candidates.length > 0 && candidates[0] === selfId;
}

/** IO: resolve this node's id + the online set and decide. On hub error, NOT monitor
 *  (so a hub blip can't make every node scan remotes). */
export async function amIMonitor(): Promise<{ isMonitor: boolean; monitorNodeId: string | null; selfId: string | null }> {
  const selfId = getHubConfig().gatewayId;
  let online: string[];
  try {
    online = await listOnlineNodeIds();
  } catch {
    return { isMonitor: false, monitorNodeId: null, selfId };
  }
  const candidates = (online.includes(selfId || '') ? online.slice() : [...online, selfId || '']).filter(Boolean).sort();
  const monitorNodeId = candidates[0] ?? null;
  return { isMonitor: !!selfId && monitorNodeId === selfId, monitorNodeId, selfId };
}
```

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-election.test.js`
Expected: PASS (4 tests). Also confirm the whole core still compiles: `cd core && npm run build 2>&1 | tail -2` → no TS errors (peer-client edit).

- [ ] **Step 5: Commit**

```bash
git add core/src/monitor/stall-election.ts core/src/data/peer-client.ts core/src/__tests__/stall-election.test.ts
git commit -m "feat(monitor): monitor election (lowest online gateway-id) + listOnlineNodeIds"
```

---

### Task 4: `project-settings.ts` — auto-resume toggles

**Files:**
- Modify: `core/src/project-settings.ts`
- Test: `core/src/__tests__/auto-resume-settings.test.ts`

**Interfaces:**
- Produces (on `ProjectSettings`): `autoResumeStalledEnabled: boolean` (default **true**), `autoResumeIntervalMin: number` (default 5), `autoResumeMaxAttempts: number` (default 6), `autoResumeRemoteScan: boolean` (default true).

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/auto-resume-settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('auto-resume settings default on with sane numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arset-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../project-settings')];
  const ps = require('../project-settings');
  const s = ps.getProjectSettings();
  assert.strictEqual(s.autoResumeStalledEnabled, true);
  assert.strictEqual(s.autoResumeIntervalMin, 5);
  assert.strictEqual(s.autoResumeMaxAttempts, 6);
  assert.strictEqual(s.autoResumeRemoteScan, true);
  const saved = ps.saveProjectSettings({ autoResumeStalledEnabled: false, autoResumeMaxAttempts: 3 });
  assert.strictEqual(saved.autoResumeStalledEnabled, false);
  assert.strictEqual(saved.autoResumeMaxAttempts, 3);
  assert.strictEqual(saved.autoResumeIntervalMin, 5); // untouched
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/auto-resume-settings.test.js`
Expected: FAIL (`autoResumeStalledEnabled` is `undefined`).

- [ ] **Step 3: Implement**

In `core/src/project-settings.ts`:

(a) Add to the `ProjectSettings` interface (after `memorySyncEnabled`):
```ts
  /** Auto-resume sessions stalled on server errors (529/5xx/server-rate-limit). Default true. */
  autoResumeStalledEnabled: boolean;
  /** Base interval (minutes) between `continue` nudges. Default 5. */
  autoResumeIntervalMin: number;
  /** Max nudge attempts before giving up + flagging. Default 6. */
  autoResumeMaxAttempts: number;
  /** Whether the elected monitor scans remote cloud CCRs. Default true. */
  autoResumeRemoteScan: boolean;
```

(b) Add to `DEFAULTS`:
```ts
  autoResumeStalledEnabled: true,
  autoResumeIntervalMin: 5,
  autoResumeMaxAttempts: 6,
  autoResumeRemoteScan: true,
```

(c) Add to the read mapping in `getProjectSettings()` (after the `memorySyncEnabled` line):
```ts
      autoResumeStalledEnabled: typeof data.autoResumeStalledEnabled === 'boolean' ? data.autoResumeStalledEnabled : DEFAULTS.autoResumeStalledEnabled,
      autoResumeIntervalMin: typeof data.autoResumeIntervalMin === 'number' ? data.autoResumeIntervalMin : DEFAULTS.autoResumeIntervalMin,
      autoResumeMaxAttempts: typeof data.autoResumeMaxAttempts === 'number' ? data.autoResumeMaxAttempts : DEFAULTS.autoResumeMaxAttempts,
      autoResumeRemoteScan: typeof data.autoResumeRemoteScan === 'boolean' ? data.autoResumeRemoteScan : DEFAULTS.autoResumeRemoteScan,
```

(d) Add to the merge mapping in `saveProjectSettings()` (after the `memorySyncEnabled` line):
```ts
    autoResumeStalledEnabled: typeof partial.autoResumeStalledEnabled === 'boolean' ? partial.autoResumeStalledEnabled : current.autoResumeStalledEnabled,
    autoResumeIntervalMin: typeof partial.autoResumeIntervalMin === 'number' ? partial.autoResumeIntervalMin : current.autoResumeIntervalMin,
    autoResumeMaxAttempts: typeof partial.autoResumeMaxAttempts === 'number' ? partial.autoResumeMaxAttempts : current.autoResumeMaxAttempts,
    autoResumeRemoteScan: typeof partial.autoResumeRemoteScan === 'boolean' ? partial.autoResumeRemoteScan : current.autoResumeRemoteScan,
```

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/auto-resume-settings.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/project-settings.ts core/src/__tests__/auto-resume-settings.test.ts
git commit -m "feat(settings): auto-resume toggles (on by default)"
```

---

### Task 5: `stall-store.ts` — per-session retry-state persistence

**Files:**
- Create: `core/src/monitor/stall-store.ts`
- Test: `core/src/__tests__/stall-store.test.ts`

**Interfaces:**
- Consumes: `getDataDir()` from `../utils/path-utils`; `StallRecord` from `./stall-state`.
- Produces:
  - `function loadStallStore(): Record<string, StallRecord>`
  - `function saveStallStore(store: Record<string, StallRecord>): void` (atomic, 0600)
  - key helpers: `localKey(sessionId): string` → `local:<id>`; `remoteKey(sid): string` → `ccr:<sid>`.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/stall-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('round-trips records; keys are namespaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arstore-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../monitor/stall-store')];
  const s = require('../monitor/stall-store');
  assert.strictEqual(s.localKey('abc'), 'local:abc');
  assert.strictEqual(s.remoteKey('xyz'), 'ccr:xyz');
  assert.deepStrictEqual(s.loadStallStore(), {});
  s.saveStallStore({ 'local:abc': { attempts: 2, lastNudgeAt: 5, category: 'overloaded', backoffStep: 1, gaveUp: false } });
  const back = s.loadStallStore();
  assert.strictEqual(back['local:abc'].attempts, 2);
  // file is 0600
  const mode = fs.statSync(path.join(dir, 'stall-monitor.json')).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `core/src/monitor/stall-store.ts`:

```ts
/** Per-session stall retry state — ~/.lm-assist/stall-monitor.json (atomic, 0600). */
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import { StallRecord } from './stall-state';

function storeFile(): string {
  return path.join(getDataDir(), 'stall-monitor.json');
}

export function localKey(sessionId: string): string {
  return `local:${sessionId}`;
}
export function remoteKey(sid: string): string {
  return `ccr:${sid}`;
}

export function loadStallStore(): Record<string, StallRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveStallStore(store: Record<string, StallRecord>): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
  } catch {
    /* best effort — losing the store only resets attempt counters */
  }
}
```

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/monitor/stall-store.ts core/src/__tests__/stall-store.test.ts
git commit -m "feat(monitor): stall retry-state store (atomic, 0600)"
```

---

### Task 6: local detection + resume (loopback)

**Files:**
- Create: `core/src/monitor/loopback.ts` (tiny in-node HTTP client to this Core)
- Create: `core/src/monitor/stall-detect-local.ts`
- Create: `core/src/monitor/stall-resume.ts` (the `resumeLocal` half)
- Test: `core/src/__tests__/stall-detect-local.test.ts`

**Interfaces:**
- Consumes: `lmAuthHeaders()` from `../auth/api-token`; `SERVER_STALL_STATES` from `./stall-classify`.
- Produces:
  - `loopback.ts`: `coreGet(pathname): Promise<any>`, `corePost(pathname, body): Promise<any>` (loopback to 3100 prod / 3200 dev, with the api-token header).
  - `stall-detect-local.ts`: `interface LocalStall { sessionId: string; category: string }`; `async function findLocalStalls(deps?: { listDriveable?: () => Promise<{ sessionId: string }[]>; screenStateOf?: (id: string) => Promise<string> }): Promise<LocalStall[]>`.
  - `stall-resume.ts`: `async function resumeLocal(sessionId: string, deps?: { post?: (p: string, b: any) => Promise<any> }): Promise<boolean>`.

- [ ] **Step 1: Write the failing test (injected deps; no real HTTP)**

Create `core/src/__tests__/stall-detect-local.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { findLocalStalls } from '../monitor/stall-detect-local';
import { resumeLocal } from '../monitor/stall-resume';

test('findLocalStalls returns only server-stalled driveable sessions', async () => {
  const out = await findLocalStalls({
    listDriveable: async () => [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
    screenStateOf: async (id) => ({ a: 'overloaded', b: 'rate_limit_user', c: 'idle' } as any)[id],
  });
  assert.deepStrictEqual(out.map((s) => s.sessionId), ['a']); // b is user-limit, c is idle
  assert.strictEqual(out[0].category, 'overloaded');
});

test('resumeLocal posts continue and reports delivered', async () => {
  let sent: any = null;
  const ok = await resumeLocal('a', { post: async (p, b) => { sent = { p, b }; return { success: true, data: { delivered: true } }; } });
  assert.strictEqual(ok, true);
  assert.match(sent.p, /\/terminal\/cc-sessions\/a\/prompt$/);
  assert.strictEqual(sent.b.text, 'continue');
  assert.strictEqual(sent.b.submit, true);
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npm run build:test && node --test dist-test/__tests__/stall-detect-local.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `core/src/monitor/loopback.ts`:

```ts
/** Minimal loopback HTTP to THIS Core (prod :3100 / dev :3200), carrying the api-token. */
import { lmAuthHeaders } from '../auth/api-token';

function basePort(): number {
  return __dirname.includes('node_modules') ? 3100 : 3200;
}
function url(pathname: string): string {
  return `http://127.0.0.1:${basePort()}${pathname}`;
}

export async function coreGet(pathname: string): Promise<any> {
  const res = await fetch(url(pathname), { headers: { ...lmAuthHeaders() } });
  return res.json();
}
export async function corePost(pathname: string, body: any): Promise<any> {
  const res = await fetch(url(pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}
```

Create `core/src/monitor/stall-detect-local.ts`:

```ts
/** Find this node's local sessions stalled on a server error. */
import { coreGet } from './loopback';
import { SERVER_STALL_STATES } from './stall-classify';

export interface LocalStall { sessionId: string; category: string }

/** GET /terminal/cc-sessions → driveable sessions; GET …/:id/screen → state.
 *  deps are injectable for tests. */
export async function findLocalStalls(deps?: {
  listDriveable?: () => Promise<{ sessionId: string }[]>;
  screenStateOf?: (id: string) => Promise<string>;
}): Promise<LocalStall[]> {
  const listDriveable = deps?.listDriveable ?? (async () => {
    const r = await coreGet('/terminal/cc-sessions');
    const list: any[] = r?.data?.sessions ?? r?.sessions ?? r?.data ?? [];
    return list
      .filter((s) => s && s.driveable === true && (s.sessionId || s.id))
      .map((s) => ({ sessionId: (s.sessionId || s.id) as string }));
  });
  const screenStateOf = deps?.screenStateOf ?? (async (id: string) => {
    const r = await coreGet(`/terminal/cc-sessions/${encodeURIComponent(id)}/screen`);
    return (r?.data?.state ?? r?.state ?? 'unknown') as string;
  });

  const out: LocalStall[] = [];
  for (const s of await listDriveable()) {
    const state = await screenStateOf(s.sessionId);
    if (SERVER_STALL_STATES.includes(state as any)) out.push({ sessionId: s.sessionId, category: state });
  }
  return out;
}
```

Create `core/src/monitor/stall-resume.ts`:

```ts
/** Resume a stalled session by sending the literal `continue`. */
import { corePost } from './loopback';
import { cloudDrive } from '../terminal/ccr-cloud';

/** Local: POST /terminal/cc-sessions/:id/prompt {text:'continue', submit:true}
 *  (the cc-session driver — honors the idle-gate; returns delivered:false if not idle/no driver). */
export async function resumeLocal(sessionId: string, deps?: { post?: (p: string, b: any) => Promise<any> }): Promise<boolean> {
  const post = deps?.post ?? corePost;
  const r = await post(`/terminal/cc-sessions/${encodeURIComponent(sessionId)}/prompt`, { text: 'continue', submit: true });
  return !!(r?.data?.delivered ?? r?.delivered ?? r?.success);
}

/** Remote: cloudDrive a plain `continue` user turn. */
export async function resumeRemote(sid: string, deps?: { drive?: (o: { sid: string; text: string }) => Promise<{ delivered: boolean }> }): Promise<boolean> {
  const drive = deps?.drive ?? ((o) => cloudDrive(o));
  const r = await drive({ sid, text: 'continue' });
  return !!r?.delivered;
}
```

- [ ] **Step 4: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-detect-local.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/monitor/loopback.ts core/src/monitor/stall-detect-local.ts core/src/monitor/stall-resume.ts core/src/__tests__/stall-detect-local.test.ts
git commit -m "feat(monitor): local stall detection + resume (loopback cc-prompt)"
```

---

### Task 7: remote detection + account cloud-session list

**Files:**
- Modify: `core/src/terminal/ccr-cloud.ts` (add `cloudListAccount()`)
- Create: `core/src/monitor/stall-detect-remote.ts`
- Test: `core/src/__tests__/stall-detect-remote.test.ts`

**Interfaces:**
- Consumes: `anthropicOAuthGet`, `ccrOpts()`, `assertOk`, `cloudRead`, `getOAuthStatus` (from `ccr-cloud`/`claude-oauth`); `isServerStall` from `./stall-classify`.
- Produces:
  - in `ccr-cloud.ts`: `export async function cloudListAccount(limit?: number): Promise<Array<{ sid: string; status: string; title?: string }>>` — GET `/v1/code/sessions` (account-wide), normalized.
  - in `stall-detect-remote.ts`: `interface RemoteStall { sid: string; category: string }`; `async function findRemoteStalls(deps?: { hasCreds?: () => boolean; list?: () => Promise<{ sid: string; status: string }[]>; readText?: (sid: string) => Promise<string> }): Promise<RemoteStall[]>`.

> **Build-time validation:** the exact JSON field names of `GET /v1/code/sessions` are not documented. In Step 3, the implementer FIRST confirms the shape by calling it once through Core (or `anthropicOAuthGet`) and adjusts the `sid`/`status` field reads (`id`/`session_id`/`uuid`; `status`/`session_status`) to match the real payload, then keeps the defensive fallbacks. Record the observed shape in the task report.

- [ ] **Step 1: Write the failing test (injected deps)**

Create `core/src/__tests__/stall-detect-remote.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { findRemoteStalls } from '../monitor/stall-detect-remote';

test('no cloud creds → empty (degrades to local-only)', async () => {
  const out = await findRemoteStalls({ hasCreds: () => false, list: async () => { throw new Error('should not be called'); }, readText: async () => '' });
  assert.deepStrictEqual(out, []);
});

test('returns only server-stalled cloud sessions', async () => {
  const out = await findRemoteStalls({
    hasCreds: () => true,
    list: async () => [{ sid: 's1', status: 'running' }, { sid: 's2', status: 'running' }, { sid: 's3', status: 'running' }],
    readText: async (sid) => ({ s1: 'API Error: 529 Overloaded', s2: 'Claude usage limit reached', s3: 'working...' } as any)[sid],
  });
  assert.deepStrictEqual(out.map((s) => s.sid), ['s1']); // s2 user-limit, s3 healthy
  assert.strictEqual(out[0].category, 'overloaded');
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-detect-remote.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `core/src/terminal/ccr-cloud.ts` add (near `cloudList`, reusing the file's `anthropicOAuthGet`/`ccrOpts`/`assertOk`):

```ts
/** List the ACCOUNT's cloud code sessions (fleet-wide, not just ones we created). */
export async function cloudListAccount(limit = 50): Promise<Array<{ sid: string; status: string; title?: string }>> {
  const res = await anthropicOAuthGet('/v1/code/sessions', { ...(await ccrOpts()), query: `limit=${limit}` });
  assertOk(res, 'cloud list account');
  const arr: any[] = res.body?.sessions ?? res.body?.data ?? (Array.isArray(res.body) ? res.body : []);
  // field names confirmed against the live endpoint at build time; defensive reads kept.
  return arr.map((s) => ({
    sid: (s.id || s.session_id || s.uuid) as string,
    status: (s.status || s.session_status || '') as string,
    title: s.title,
  })).filter((s) => s.sid);
}
```

Create `core/src/monitor/stall-detect-remote.ts`:

```ts
/** Find the account's cloud CCR sessions stalled on a server error (monitor-node only). */
import { cloudListAccount, cloudRead } from '../terminal/ccr-cloud';
import { getOAuthStatus } from '../utils/claude-oauth';
import { isServerStall } from './stall-classify';

export interface RemoteStall { sid: string; category: string }

export async function findRemoteStalls(deps?: {
  hasCreds?: () => boolean;
  list?: () => Promise<{ sid: string; status: string }[]>;
  readText?: (sid: string) => Promise<string>;
}): Promise<RemoteStall[]> {
  const hasCreds = deps?.hasCreds ?? (() => {
    const st = getOAuthStatus();
    return !!st.present && !st.expired;
  });
  if (!hasCreds()) return []; // credless monitor degrades to local-only

  const list = deps?.list ?? (async () => {
    const sessions = await cloudListAccount();
    // skip clearly-terminal states; classify the rest
    return sessions.filter((s) => !/completed|stopped|failed|terminated|ended/i.test(s.status || ''));
  });
  const readText = deps?.readText ?? (async (sid: string) => {
    const r = await cloudRead({ sid, lastN: 6 });
    // last assistant text is where an API error surfaces
    const last = [...r.messages].reverse().find((m) => m.role === 'assistant');
    return last?.text || '';
  });

  const out: RemoteStall[] = [];
  for (const s of await list()) {
    const { retryable, category } = isServerStall(await readText(s.sid));
    if (retryable) out.push({ sid: s.sid, category });
  }
  return out;
}
```

- [ ] **Step 4: Build + run → verify it passes** (+ confirm the cloud-list shape)

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-detect-remote.test.js`
Expected: PASS (2 tests). Also: confirm the real `/v1/code/sessions` shape (the implementer calls it once via Core/`anthropicOAuthGet` on a host with Claude OAuth) and tighten the `sid`/`status` field reads; note the observed shape in the report. Confirm full core still builds: `cd core && npm run build 2>&1 | tail -2`.

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/ccr-cloud.ts core/src/monitor/stall-detect-remote.ts core/src/__tests__/stall-detect-remote.test.ts
git commit -m "feat(monitor): remote cloud-CCR stall detection + cloudListAccount"
```

---

### Task 8: `stall-monitor.ts` orchestrator + scheduled-job wiring

**Files:**
- Create: `core/src/monitor/stall-monitor.ts`
- Modify: `core/src/scheduler/scheduled-jobs.ts` (seed `stall-monitor` built-in in `makeBuiltinJobs`, register handler in `registerDefaults`)
- Test: `core/src/__tests__/stall-monitor.test.ts`

**Interfaces:**
- Consumes: `planStallAction`, `StallConfig`, `StallRecord` (`./stall-state`); `loadStallStore`, `saveStallStore`, `localKey`, `remoteKey` (`./stall-store`); `getProjectSettings` (`../project-settings`).
- Produces:
  - `interface TickDeps { now: number; cfg: StallConfig; amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>; findLocal: () => Promise<{ sessionId: string; category: string }[]>; resumeLocal: (id: string) => Promise<boolean>; findRemote: () => Promise<{ sid: string; category: string }[]>; resumeRemote: (sid: string) => Promise<boolean>; remoteScan: boolean; load: () => Record<string, StallRecord>; save: (s: Record<string, StallRecord>) => void }`
  - `async function runStallMonitorTick(deps: TickDeps): Promise<{ localNudged: string[]; remoteNudged: string[]; gaveUp: string[]; isMonitor: boolean }>`
  - `function registerStallMonitor(jobs: { registerHandler: (t: string, fn: any) => void }): void`

- [ ] **Step 1: Write the failing test (all deps injected — fully hermetic)**

Create `core/src/__tests__/stall-monitor.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { runStallMonitorTick } from '../monitor/stall-monitor';
import { StallRecord } from '../monitor/stall-state';

function baseDeps(over: any = {}) {
  let store: Record<string, StallRecord> = over.store ?? {};
  return {
    now: 1_000_000,
    cfg: { intervalMin: 5, maxAttempts: 6 },
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'self' }),
    findLocal: async () => [{ sessionId: 'L1', category: 'overloaded' }],
    resumeLocal: async () => true,
    findRemote: async () => [{ sid: 'R1', category: 'server_error' }],
    resumeRemote: async () => true,
    remoteScan: true,
    load: () => store,
    save: (s: any) => { store = s; },
    ...over,
  };
}

test('first tick nudges local + remote (monitor)', async () => {
  const d = baseDeps();
  const r = await runStallMonitorTick(d);
  assert.deepStrictEqual(r.localNudged, ['L1']);
  assert.deepStrictEqual(r.remoteNudged, ['R1']);
});

test('non-monitor skips remote scan', async () => {
  let remoteCalled = false;
  const d = baseDeps({ amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }), findRemote: async () => { remoteCalled = true; return []; } });
  const r = await runStallMonitorTick(d);
  assert.strictEqual(remoteCalled, false);
  assert.deepStrictEqual(r.remoteNudged, []);
  assert.deepStrictEqual(r.localNudged, ['L1']); // local still runs
});

test('remoteScan disabled → no remote even if monitor', async () => {
  let remoteCalled = false;
  const d = baseDeps({ remoteScan: false, findRemote: async () => { remoteCalled = true; return []; } });
  await runStallMonitorTick(d);
  assert.strictEqual(remoteCalled, false);
});

test('a session that recovered (no longer stalled) is reset out of the store', async () => {
  const store: Record<string, StallRecord> = { 'local:L1': { attempts: 2, lastNudgeAt: 1, category: 'overloaded', backoffStep: 1, gaveUp: false } };
  const d = baseDeps({ store, findLocal: async () => [], findRemote: async () => [] }); // L1 no longer stalled
  await runStallMonitorTick(d);
  assert.strictEqual(d.load()['local:L1'], undefined); // reset/cleared
});

test('cap reached → giveUp, not nudged', async () => {
  const store: Record<string, StallRecord> = { 'local:L1': { attempts: 6, lastNudgeAt: 1, category: 'overloaded', backoffStep: 5, gaveUp: false } };
  let resumed = false;
  const d = baseDeps({ store, resumeLocal: async () => { resumed = true; return true; } });
  const r = await runStallMonitorTick(d);
  assert.strictEqual(resumed, false);
  assert.deepStrictEqual(r.gaveUp, ['local:L1']);
  assert.strictEqual(d.load()['local:L1'].gaveUp, true);
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-monitor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `core/src/monitor/stall-monitor.ts`:

```ts
/** The stall-monitor tick: election → local resume (always) → remote resume (monitor only). */
import { planStallAction, StallRecord, StallConfig } from './stall-state';
import { loadStallStore, saveStallStore, localKey, remoteKey } from './stall-store';
import { getProjectSettings } from '../project-settings';
import { amIMonitor } from './stall-election';
import { findLocalStalls } from './stall-detect-local';
import { findRemoteStalls } from './stall-detect-remote';
import { resumeLocal, resumeRemote } from './stall-resume';

export interface TickDeps {
  now: number;
  cfg: StallConfig;
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  findLocal: () => Promise<{ sessionId: string; category: string }[]>;
  resumeLocal: (id: string) => Promise<boolean>;
  findRemote: () => Promise<{ sid: string; category: string }[]>;
  resumeRemote: (sid: string) => Promise<boolean>;
  remoteScan: boolean;
  load: () => Record<string, StallRecord>;
  save: (s: Record<string, StallRecord>) => void;
}

export async function runStallMonitorTick(deps: TickDeps) {
  const store = deps.load();
  const localNudged: string[] = [];
  const remoteNudged: string[] = [];
  const gaveUp: string[] = [];

  const { isMonitor } = await deps.amMonitor();

  // Build the current stall sets.
  const local = await deps.findLocal();
  const remote = isMonitor && deps.remoteScan ? await deps.findRemote() : [];

  const stalledKeys = new Set<string>([...local.map((s) => localKey(s.sessionId)), ...remote.map((s) => remoteKey(s.sid))]);

  // 1) Any tracked key NOT in the current stall set has recovered → reset it.
  for (const key of Object.keys(store)) {
    if (!stalledKeys.has(key)) {
      const res = planStallAction(store[key], { now: deps.now, stillStalled: false, seenProgress: true, cfg: deps.cfg });
      if (res.action === 'reset') delete store[key];
    }
  }

  // 2) Process each currently-stalled session.
  const act = async (key: string, category: string, resume: () => Promise<boolean>) => {
    const res = planStallAction(store[key], { now: deps.now, stillStalled: true, seenProgress: false, cfg: deps.cfg });
    if (res.action === 'giveup') { store[key] = { ...res.next!, category }; gaveUp.push(key); return; }
    if (res.action === 'nudge') {
      const ok = await resume();
      // Persist regardless (so we back off even if a single send didn't land); stamp the fresh category.
      store[key] = { ...res.next!, category };
      return ok;
    }
    if (res.next) store[key] = { ...res.next, category }; // wait — keep/refresh
    return false;
  };

  for (const s of local) {
    const ok = await act(localKey(s.sessionId), s.category, () => deps.resumeLocal(s.sessionId));
    if (ok) localNudged.push(s.sessionId);
  }
  for (const s of remote) {
    const ok = await act(remoteKey(s.sid), s.category, () => deps.resumeRemote(s.sid));
    if (ok) remoteNudged.push(s.sid);
  }

  deps.save(store);
  return { localNudged, remoteNudged, gaveUp, isMonitor };
}

/** Register the scheduled-job handler. Reads live config each run; assembles real deps. */
export function registerStallMonitor(jobs: { registerHandler: (t: string, fn: any) => void }): void {
  jobs.registerHandler('stall-monitor', async (_config: any, _ctx: any) => {
    const s = getProjectSettings();
    if (!s.autoResumeStalledEnabled) return { result: 'auto-resume disabled', status: 'skipped' };
    const r = await runStallMonitorTick({
      now: Date.now(),
      cfg: { intervalMin: s.autoResumeIntervalMin, maxAttempts: s.autoResumeMaxAttempts },
      amMonitor: () => amIMonitor().then((m) => ({ isMonitor: m.isMonitor, monitorNodeId: m.monitorNodeId })),
      findLocal: () => findLocalStalls(),
      resumeLocal: (id) => resumeLocal(id),
      findRemote: () => findRemoteStalls(),
      resumeRemote: (sid) => resumeRemote(sid),
      remoteScan: s.autoResumeRemoteScan,
      load: loadStallStore,
      save: saveStallStore,
    });
    return { result: `monitor=${r.isMonitor} localNudged=${r.localNudged.length} remoteNudged=${r.remoteNudged.length} gaveUp=${r.gaveUp.length}`, status: 'ok' };
  });
}
```

- [ ] **Step 4: Wire into the scheduler**

In `core/src/scheduler/scheduled-jobs.ts`:

(a) In `makeBuiltinJobs(nowMs)`, add a second entry to the returned array (after the `cleanup-test-conversations` object):
```ts
    {
      id: 'stall-monitor',
      name: 'Auto-resume stalled sessions',
      description: 'Resume sessions stalled on server errors (529/5xx/server-rate-limit) with `continue`; never user-usage-limits.',
      type: 'stall-monitor',
      enabled: true, // ON BY DEFAULT (deliberate deviation)
      intervalMinutes: 5,
      config: {},
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
```

(b) In `registerDefaults()`, after the existing `this.registerHandler('cleanup-test-conversations', …)` block, register the monitor (lazy require avoids an import cycle with the monitor module):
```ts
    {
      const { registerStallMonitor } = require('../monitor/stall-monitor');
      registerStallMonitor(this);
    }
```

- [ ] **Step 5: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-monitor.test.js`
Expected: PASS (5 tests). Confirm full build: `cd core && npm run build 2>&1 | tail -2` (scheduled-jobs edit compiles).

- [ ] **Step 6: Commit**

```bash
git add core/src/monitor/stall-monitor.ts core/src/scheduler/scheduled-jobs.ts core/src/__tests__/stall-monitor.test.ts
git commit -m "feat(monitor): stall-monitor tick + scheduled-job (on by default, 5 min)"
```

---

### Task 9: `GET /monitor/stalls` route + `stall_status` MCP tool

**Files:**
- Create: `core/src/routes/core/monitor-stalls.routes.ts`
- Modify: `core/src/routes/core/index.ts` (register the factory)
- Modify: `core/src/mcp-server/tools/expanded.ts` (add `stall_status` read tool + handler)
- Test: `core/src/__tests__/monitor-stalls-route.test.ts`

**Interfaces:**
- Consumes: `loadStallStore` (`../../monitor/stall-store`), `amIMonitor` (`../../monitor/stall-election`), `getProjectSettings`.
- Produces: route `GET /monitor/stalls` → `{ success, data: { enabled, amMonitor, monitorNodeId, attempts, gaveUp, sessions:[{key,attempts,category,lastNudgeAt,gaveUp}] } }`; helper `async function buildStallStatus(): Promise<...>` (so the MCP tool reuses it).

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/monitor-stalls-route.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('buildStallStatus reports store + monitor verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arstatus-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  ['../monitor/stall-store', '../routes/core/monitor-stalls.routes', '../project-settings'].forEach((m) => { try { delete require.cache[require.resolve(m)]; } catch {} });
  const store = require('../monitor/stall-store');
  store.saveStallStore({ 'local:L1': { attempts: 3, lastNudgeAt: 5, category: 'overloaded', backoffStep: 1, gaveUp: false }, 'ccr:R1': { attempts: 6, lastNudgeAt: 9, category: 'server_error', backoffStep: 5, gaveUp: true } });
  const { buildStallStatus } = require('../routes/core/monitor-stalls.routes');
  const s = await buildStallStatus(async () => ({ isMonitor: true, monitorNodeId: 'self' })); // inject election
  assert.strictEqual(s.attempts, 9);
  assert.strictEqual(s.gaveUp, 1);
  assert.strictEqual(s.amMonitor, true);
  assert.strictEqual(s.sessions.length, 2);
});
```

- [ ] **Step 2: Build + run → verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/monitor-stalls-route.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `core/src/routes/core/monitor-stalls.routes.ts`:

```ts
import type { RouteHandler, RouteContext } from '../index';
import { loadStallStore } from '../../monitor/stall-store';
import { amIMonitor } from '../../monitor/stall-election';
import { getProjectSettings } from '../../project-settings';

/** Shared builder so the MCP `stall_status` tool returns the same payload. */
export async function buildStallStatus(elect: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }> = amIMonitor) {
  const store = loadStallStore();
  const sessions = Object.entries(store).map(([key, r]) => ({ key, attempts: r.attempts, category: r.category, lastNudgeAt: r.lastNudgeAt, gaveUp: r.gaveUp }));
  const m = await elect();
  const s = getProjectSettings();
  return {
    enabled: s.autoResumeStalledEnabled,
    amMonitor: m.isMonitor,
    monitorNodeId: m.monitorNodeId,
    attempts: sessions.reduce((a, x) => a + x.attempts, 0),
    gaveUp: sessions.filter((x) => x.gaveUp).length,
    sessions,
  };
}

export function createMonitorStallsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/monitor\/stalls$/,
      handler: async () => ({ success: true, data: await buildStallStatus() }),
    },
  ];
}
```

In `core/src/routes/core/index.ts`: add `import { createMonitorStallsRoutes } from './monitor-stalls.routes';` near the other route imports, and add `...createMonitorStallsRoutes(ctx),` to the array returned by `createCoreRoutes`.

- [ ] **Step 4: Add the `stall_status` MCP read tool**

In `core/src/mcp-server/tools/expanded.ts`: add a tool definition (alongside the other read tools) and a handler entry that calls the route via the loopback or `buildStallStatus`. Tool def:
```ts
  {
    name: 'stall_status',
    description: 'Auto-resume monitor status: whether this node is the elected stall-monitor, and the per-session retry/gave-up state for sessions stalled on server errors. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: { node: { type: 'string' as const, description: 'Target host (omit for default).' } }, required: [] as string[] },
  },
```
Handler (in the handler map; mirror an existing read tool that proxies a GET route — e.g. how a tool calls the loopback `/monitor/...`): call `GET /monitor/stalls` through the same in-process/loopback path the other `expanded.ts` read tools use and return its `data`. Follow the exact proxy pattern of a neighboring read tool in `expanded.ts` (e.g. one that hits `/monitor/executions` or similar) so node-targeting works.

- [ ] **Step 5: Build + run → verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/monitor-stalls-route.test.js && cd .. `
Expected: PASS. Confirm full build: `cd core && npm run build 2>&1 | tail -2`.

- [ ] **Step 6: Commit**

```bash
git add core/src/routes/core/monitor-stalls.routes.ts core/src/routes/core/index.ts core/src/mcp-server/tools/expanded.ts core/src/__tests__/monitor-stalls-route.test.ts
git commit -m "feat(monitor): GET /monitor/stalls + stall_status MCP tool"
```

---

### Task 10: Integration, full suite, docs, deploy-readiness

**Files:**
- Test: `core/src/__tests__/stall-monitor-integration.test.ts`
- Modify: `CLAUDE.md` (document the feature)

- [ ] **Step 1: Integration test (end-to-end through the real units with mocked IO boundaries)**

Create `core/src/__tests__/stall-monitor-integration.test.ts` — drive `runStallMonitorTick` across THREE ticks with a stateful fake to prove the full lifecycle (nudge → backoff → recovery-reset; and a user-limit session is never nudged):

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { runStallMonitorTick } from '../monitor/stall-monitor';
import { isServerStall } from '../monitor/stall-classify';
import { StallRecord } from '../monitor/stall-state';

test('lifecycle: nudge → wait → recovery clears; user-limit never nudged', async () => {
  let store: Record<string, StallRecord> = {};
  // session "U" is a user-limit (must never nudge); "S" is overloaded then recovers.
  let sErrorText = 'API Error: 529';
  const mk = (now: number, sStalled: boolean) => ({
    now, cfg: { intervalMin: 5, maxAttempts: 6 },
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'x' }), // local-only
    findLocal: async () => {
      const out: { sessionId: string; category: string }[] = [];
      const u = isServerStall('Claude usage limit reached'); if (u.retryable) out.push({ sessionId: 'U', category: u.category });
      if (sStalled) { const s = isServerStall(sErrorText); if (s.retryable) out.push({ sessionId: 'S', category: s.category }); }
      return out;
    },
    resumeLocal: async () => true,
    findRemote: async () => [], resumeRemote: async () => true, remoteScan: false,
    load: () => store, save: (s: any) => { store = s; },
  });

  const t1 = await runStallMonitorTick(mk(0, true));
  assert.deepStrictEqual(t1.localNudged, ['S']);        // U never appears
  assert.ok(!('local:U' in store));
  assert.strictEqual(store['local:S'].attempts, 1);

  const t2 = await runStallMonitorTick(mk(4 * 60_000, true)); // not due yet
  assert.deepStrictEqual(t2.localNudged, []);
  assert.strictEqual(store['local:S'].attempts, 1);

  const t3 = await runStallMonitorTick(mk(99 * 60_000, false)); // recovered
  assert.ok(!('local:S' in store));
});
```

Run: `cd core && npm run build:test && node --test dist-test/__tests__/stall-monitor-integration.test.js`
Expected: PASS.

- [ ] **Step 2: Full script + core suite (0 new regressions)**

Run: `cd core && export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH && npm run build:test && node --test dist-test/__tests__/ 2>&1 | tail -25`
Expected: all new `stall-*`/`auto-resume-*`/`monitor-stalls-*` tests pass; the only failures are the pre-existing environmental baseline (better-sqlite3 `ERR_DLOPEN_FAILED`, network/OAuth/session-resolver) — **zero new regressions** attributable to this feature.

- [ ] **Step 3: Document in CLAUDE.md**

Add a short subsection under the API/architecture docs:
```markdown
### Auto-resume stalled sessions (server errors)
A `scheduled-jobs` handler `stall-monitor` (5 min, on by default) resumes sessions stalled on SERVER errors (529/5xx/server-rate-limit — NEVER user usage-limits or auth) by sending `continue`, capped-backoff then flagged. Local sessions are handled per-node; remote cloud CCRs only by the single auto-elected monitor (lowest online gateway-id from the hub `/machines` list). Toggles in project-settings: `autoResumeStalledEnabled` (default true), `autoResumeIntervalMin`, `autoResumeMaxAttempts`, `autoResumeRemoteScan`. Status: `GET /monitor/stalls` / MCP `stall_status`. Run on demand: `POST /scheduler/jobs/stall-monitor/run`.
```

- [ ] **Step 4: Commit**

```bash
git add core/src/__tests__/stall-monitor-integration.test.ts CLAUDE.md
git commit -m "test(monitor): stall-monitor lifecycle integration + docs"
```

- [ ] **Step 5: Live smoke (isolated, optional but recommended)**

On a dev Core (`:3200`), arm + run once and inspect — does NOT require a real stalled session (an empty store run is a valid smoke):
```bash
curl -s -H "x-api-key: $(cat ~/.lm-assist/api-token)" -X POST localhost:3200/scheduler/jobs/stall-monitor/run | head -c 300
curl -s -H "x-api-key: $(cat ~/.lm-assist/api-token)" localhost:3200/monitor/stalls | head -c 400
```
Expected: the run returns `status:ok` with a `monitor=… localNudged=… remoteNudged=…` result; `/monitor/stalls` returns the status payload. **Do not** point this at prod ports or a fleet you don't control.

---

## Self-Review

**1. Spec coverage:** §3 boundary → Task 1. §4 units → Tasks 1-8. §5 detection → Tasks 6,7. §6 resume+state → Tasks 2,5,6,7,8. §7 election → Task 3. §8 config/surfacing → Tasks 4,9. §10 testing → every task + Task 10. The best-effort data-service dedupe (§6) is INTENTIONALLY deferred — see note below. No other gaps.

**2. Placeholder scan:** All code steps carry real code. The two "validate at build time" notes (GET /v1/code/sessions field names in Task 7; the neighbor-tool proxy pattern for `stall_status` in Task 9 Step 4) are genuine external-shape confirmations, each with a concrete fallback + a named template to copy — not hand-waving. The dedupe deferral is called out explicitly here, not silently dropped.

**3. Type consistency:** `StallRecord`/`StallConfig`/`StallAction` (Task 2) are used verbatim in Tasks 5,8,9. `localKey`/`remoteKey` (Task 5) used in Task 8. `SERVER_STALL_STATES`/`isServerStall` (Task 1) used in 6,7. `amIMonitor` return `{isMonitor,monitorNodeId,selfId}` (Task 3) consumed in 8,9. `TickDeps` (Task 8) matches what `registerStallMonitor` assembles. `cloudListAccount`→`findRemoteStalls`→`runStallMonitorTick` chain consistent.

**Deferred from the spec (flagged, not silent):** the §6 best-effort cross-node dedupe marker is NOT implemented in these tasks — the deterministic election (Task 3) is the single-monitor guarantee, and per the spec a rare election-flux double-`continue` is harmless. If duplicate remote nudges are ever observed in practice, add a follow-up task: before a remote nudge in `runStallMonitorTick`, check/refresh a data-service `cache` key `stall-nudge:ccr:<sid>` (TTL≈interval) when `dataServiceEnabled`. Recorded here so the final review can decide whether to pull it into v1.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-auto-resume-stalled-sessions.md`.**

This plan is intended to be executed by a **cloud CCR lm-assist worker** (created + bootstrapped via the connector), under this session's orchestration + per-task review (subagent-driven-development). Merge/publish remain user-gated.

