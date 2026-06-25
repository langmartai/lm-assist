# Mission Worker Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a mission's bound worker session be truly *resumed in place* (same session, preserved context) — cloud via re-drive/wake, native via `claude --resume` + re-bridge — exposed through the REST resume route, a new MCP tool, the autonomous controller, and the web UI.

**Architecture:** A new pure-core module `mission-resume.ts` holds two pure decision functions (`decideCloudResume`, `decideNativeResume`) and one injected-deps orchestrator (`resumeWorker`). `handleSessionResume` becomes a thin wrapper that builds real deps + calls `resumeWorker`. The MCP tool and the controller call the same backend. **Resume-only:** a terminal/unrecoverable session reports `gone`; spawning a fresh worker stays a separate explicit action.

**Tech Stack:** TypeScript (CommonJS), Node's built-in `node:test` runner, the existing injected-deps handler pattern in `core/src/routes/core/mission.routes.ts`, MCP tools in `core/src/mcp-server/tools/mission.ts` proxying routes, React/Next web UI.

## Global Constraints

- Build core with `cd /home/ubuntu/lm-assist && ./core.sh build` (Node ≥ 20.9: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 20`).
- Tests: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Run the FULL suite before any deploy (`cd core && npm test`) — a missing `TOOL_SCOPES` entry only fails there.
- Mission routes return bare `{ success, data }` envelopes via the `ok(...)` / `fail(code,msg)` helpers already in `mission.routes.ts` (NOT `wrapResponse`).
- Resume is a WRITE → stays leader-anchored (`anchorToLeader(..., true)`), already wired in `handleSessionResume`.
- Every new MCP tool advertised in `core/src/mcp-server/tools/mission.ts` MUST get a `TOOL_SCOPES` entry in `core/src/mcp-server/configure.ts` — a missing one throws in `assertScopesCoverTools()` and CRASHES Core on the first `/mcp` call.
- Branch: `feat/mission-worker-resume`. Frequent commits (one per task).
- Native resume MUST preserve the original `sessionId` (continuity); only `binding.ccr` (cse/sid/webUrl/tmuxSession) updates. Cloud resume never changes `sessionId`.
- Terminal cloud statuses are `['stopped','completed','failed','error','archived']` (reuse the existing `TERMINAL_CLOUD_STATUSES` constant; do not redefine a divergent list).
- `connectStrategy` literals from `core/src/terminal/cc-sessions.ts`: `'create-tmux' | 'attach-existing' | 'refuse' | 'none'`, plus `safeToCreateTmux: boolean`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `core/src/mission/mission-resume.ts` | **new** — pure `decideCloudResume`/`decideNativeResume` + the `resumeWorker(sid, missionId, deps)` orchestrator + types |
| `core/src/__tests__/mission-resume.test.ts` | **new** — unit tests for the pure decisions + the orchestrator (mocked deps) |
| `core/src/routes/core/mission.routes.ts` | `handleSessionResume` delegates to `resumeWorker`; default deps include the native `--resume` re-bridge that preserves `sessionId` |
| `core/src/__tests__/mission-session-resume.test.ts` | updated — native resumes SAME sid; cloud-idle wakes; `conflict`/`gone` |
| `core/src/mcp-server/tools/mission.ts` | new `mission_session_resume` tool def + handler |
| `core/src/mcp-server/configure.ts` | `mission_session_resume: 'write'` scope |
| `core/src/__tests__/mcp-tool-scopes.test.ts` | asserts the new tool has a scope |
| `core/src/mission/mission-controller.ts` | controller AGENT playbook (`CONTROLLER_SYSTEM_PROMPT` + `CONTROLLER_PASS_DIRECTIVE`) — resume-first via `mission_session_resume` |
| `core/src/mcp-server/tools/guide.ts` | `guide("missions")` step e2 — resume-first before respawn |
| `core/src/mission/__tests__` (`mission-guide.test.ts`) | asserts the resume-first playbook text |
| `web/src/components/missions/MissionsPage.tsx` | handle `ok`/`alive`/`conflict`/`gone` + "Start fresh worker" |

---

## Task 1: Pure resume-decision functions

**Files:**
- Create: `core/src/mission/mission-resume.ts`
- Test: `core/src/__tests__/mission-resume.test.ts`

**Interfaces:**
- Produces: `type ResumeReason = 'ok'|'alive'|'gone'|'conflict'|'status-unknown'`; `interface ResumeResult { resumed: boolean; transport: 'cloud'|'native'; sid: string; reason: ResumeReason; note?: string }`; `decideCloudResume(s: {status: string; workerStatus?: string}): 'noop'|'wake'|'gone'`; `decideNativeResume(v: {connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean}): 'attach'|'resume'|'conflict'|'gone'`.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/mission-resume.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { decideCloudResume, decideNativeResume } from '../mission/mission-resume';

// ── decideCloudResume ─────────────────────────────────────────────────────────
test('decideCloudResume: terminal status → gone', () => {
  for (const status of ['stopped', 'completed', 'failed', 'error', 'archived']) {
    assert.strictEqual(decideCloudResume({ status }), 'gone', status);
  }
});
test('decideCloudResume: alive + worker_status running → noop', () => {
  assert.strictEqual(decideCloudResume({ status: 'active', workerStatus: 'running' }), 'noop');
});
test('decideCloudResume: alive but idle/disconnected (not running) → wake', () => {
  assert.strictEqual(decideCloudResume({ status: 'active', workerStatus: 'idle' }), 'wake');
  assert.strictEqual(decideCloudResume({ status: 'active' }), 'wake');
});

// ── decideNativeResume ────────────────────────────────────────────────────────
test('decideNativeResume: attach-existing (alive in tmux) → attach', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'attach-existing', safeToCreateTmux: false, inTmux: true }), 'attach');
});
test('decideNativeResume: create-tmux + safeToCreateTmux (dead, jsonl present) → resume', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }), 'resume');
});
test('decideNativeResume: refuse (live but not in tmux) → conflict', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }), 'conflict');
});
test('decideNativeResume: none (no jsonl) → gone', () => {
  assert.strictEqual(decideNativeResume({ connectStrategy: 'none', safeToCreateTmux: false, inTmux: false }), 'gone');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -3`
Expected: a TS build error — `Cannot find module '../mission/mission-resume'` (the file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `core/src/mission/mission-resume.ts`:

```typescript
// Resume a mission's bound worker session IN PLACE (same session, preserved context).
// Pure decision functions here; the I/O orchestrator (resumeWorker) is added in Task 2.

/** Terminal cloud session statuses (mirrors mission-controller.ts / mission.routes.ts). */
export const TERMINAL_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived'];

export type ResumeReason = 'ok' | 'alive' | 'gone' | 'conflict' | 'status-unknown';

export interface ResumeResult {
  resumed: boolean;
  transport: 'cloud' | 'native';
  sid: string;
  reason: ResumeReason;
  note?: string;
}

/**
 * Decide what to do with a CLOUD worker, from its cloudStatus.
 *  'gone'  — terminal status, unrecoverable (respawn is a separate explicit action).
 *  'noop'  — alive and actively running; nothing to do.
 *  'wake'  — alive but idle/disconnected; re-drive with reBootstrap to continue.
 */
export function decideCloudResume(s: { status: string; workerStatus?: string }): 'noop' | 'wake' | 'gone' {
  if (TERMINAL_CLOUD_STATUSES.includes(s.status)) return 'gone';
  return s.workerStatus === 'running' ? 'noop' : 'wake';
}

/**
 * Decide what to do with a NATIVE worker, from its sessionVerdict.
 *  'attach'  — already live in a tmux; just re-read/attach.
 *  'resume'  — process dead but transcript present + safe → `claude --resume` + re-bridge.
 *  'conflict'— live but not in a tmux; a `--resume` would double-write the jsonl → refuse.
 *  'gone'    — no transcript; unrecoverable.
 */
export function decideNativeResume(v: { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean }): 'attach' | 'resume' | 'conflict' | 'gone' {
  if (v.connectStrategy === 'attach-existing' || v.inTmux) return 'attach';
  if (v.connectStrategy === 'create-tmux' && v.safeToCreateTmux) return 'resume';
  if (v.connectStrategy === 'refuse') return 'conflict';
  return 'gone';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-resume.test.js 2>&1 | grep -E "# (tests|pass|fail)"`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist
git add core/src/mission/mission-resume.ts core/src/__tests__/mission-resume.test.ts
git commit -m "feat(mission-resume): pure cloud/native resume decision functions"
```

---

## Task 2: `resumeWorker` orchestrator (injected deps)

**Files:**
- Modify: `core/src/mission/mission-resume.ts` (append the orchestrator)
- Test: `core/src/__tests__/mission-resume.test.ts` (append orchestrator tests)

**Interfaces:**
- Consumes: `decideCloudResume`, `decideNativeResume`, `ResumeResult` (Task 1).
- Produces: `interface ResumeWorkerDeps { resolve; cloudStatus; cloudWake; nativeVerdict; resumeNative }`; `resumeWorker(sid: string, missionId: string | undefined, deps: ResumeWorkerDeps): Promise<ResumeResult>`. `resumeNative(missionId, sid) => Promise<{ sid: string; boundAt: number }>` MUST return the SAME `sid` it was given (continuity).

- [ ] **Step 1: Write the failing test**

Append to `core/src/__tests__/mission-resume.test.ts`:

```typescript
import { resumeWorker } from '../mission/mission-resume';
import type { ResumeWorkerDeps } from '../mission/mission-resume';

function makeDeps(over: Partial<ResumeWorkerDeps> = {}): ResumeWorkerDeps {
  return {
    resolve: (sid) => ({ transport: sid.startsWith('session_') ? 'cloud' : 'native', missionId: null }),
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'running' } }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    resumeNative: async (_mid, sid) => ({ sid, boundAt: 1000 }),
    ...over,
  };
}

test('resumeWorker: cloud running → alive (no wake)', async () => {
  let woke = false;
  const r = await resumeWorker('session_a', undefined, makeDeps({ cloudWake: async () => { woke = true; } }));
  assert.deepStrictEqual({ resumed: r.resumed, reason: r.reason, sid: r.sid }, { resumed: true, reason: 'alive', sid: 'session_a' });
  assert.strictEqual(woke, false);
});
test('resumeWorker: cloud idle → wakes via cloudWake, reason ok', async () => {
  let woke = false;
  const r = await resumeWorker('session_b', undefined, makeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'idle' } }),
    cloudWake: async () => { woke = true; },
  }));
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(woke, true);
});
test('resumeWorker: cloud terminal → gone', async () => {
  const r = await resumeWorker('session_c', undefined, makeDeps({ cloudStatus: async (sid) => ({ sid, status: 'stopped', raw: {} }) }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'gone');
});
test('resumeWorker: cloud cloudStatus throws → status-unknown grace (resumed true)', async () => {
  const r = await resumeWorker('session_d', undefined, makeDeps({ cloudStatus: async () => { throw new Error('503'); } }));
  assert.strictEqual(r.resumed, true);
  assert.strictEqual(r.reason, 'status-unknown');
});
test('resumeWorker: native resume → same sid preserved, reason ok', async () => {
  const r = await resumeWorker('uuid-native', 'mission_x', makeDeps({ resumeNative: async (_m, sid) => ({ sid, boundAt: 2 }) }));
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(r.sid, 'uuid-native'); // SAME sid — continuity
});
test('resumeWorker: native attach-existing → alive (no resumeNative call)', async () => {
  let called = false;
  const r = await resumeWorker('uuid-live', 'mission_x', makeDeps({
    nativeVerdict: () => ({ connectStrategy: 'attach-existing', safeToCreateTmux: false, inTmux: true }),
    resumeNative: async (_m, sid) => { called = true; return { sid, boundAt: 0 }; },
  }));
  assert.strictEqual(r.reason, 'alive');
  assert.strictEqual(called, false);
});
test('resumeWorker: native refuse → conflict (no resumeNative call)', async () => {
  const r = await resumeWorker('uuid-conflict', 'mission_x', makeDeps({
    nativeVerdict: () => ({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }),
  }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'conflict');
});
test('resumeWorker: native none → gone', async () => {
  const r = await resumeWorker('uuid-gone', 'mission_x', makeDeps({
    nativeVerdict: () => ({ connectStrategy: 'none', safeToCreateTmux: false, inTmux: false }),
  }));
  assert.strictEqual(r.reason, 'gone');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -3`
Expected: TS error — `resumeWorker` / `ResumeWorkerDeps` not exported from `../mission/mission-resume`.

- [ ] **Step 3: Write the minimal implementation**

Append to `core/src/mission/mission-resume.ts`:

```typescript
export interface ResumeWorkerDeps {
  /** Resolve transport for a sid (pure). */
  resolve: (sid: string) => { transport: 'cloud' | 'native'; missionId: string | null };
  /** Read cloud session status. */
  cloudStatus: (sid: string) => Promise<{ sid: string; status: string; connectionStatus?: string; raw: any }>;
  /** Wake an idle cloud worker (cloudDrive with reBootstrap). Best-effort. */
  cloudWake: (sid: string) => Promise<void>;
  /** Native liveness/safety verdict (sessionVerdict). */
  nativeVerdict: (sid: string) => { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean };
  /** Resume a native worker IN PLACE: `claude --resume <sid>` + re-bridge + re-bind.
   *  MUST return the SAME sid (continuity); only the bridge cse changes. */
  resumeNative: (missionId: string | undefined, sid: string) => Promise<{ sid: string; boundAt: number }>;
}

/**
 * Resume a mission's bound worker IN PLACE. Resume-only: a terminal/unrecoverable session
 * returns { resumed:false, reason:'gone'|'conflict' } and does NOT spawn a replacement.
 */
export async function resumeWorker(sid: string, missionId: string | undefined, deps: ResumeWorkerDeps): Promise<ResumeResult> {
  const { transport } = deps.resolve(sid);

  if (transport === 'cloud') {
    let st: { status: string; raw: any };
    try {
      st = await deps.cloudStatus(sid);
    } catch {
      // Transient (429/5xx/network): NOT a confirmed terminal status → grace.
      return { resumed: true, transport: 'cloud', sid, reason: 'status-unknown' };
    }
    const action = decideCloudResume({ status: st.status, workerStatus: st.raw?.worker_status });
    if (action === 'gone') return { resumed: false, transport: 'cloud', sid, reason: 'gone' };
    if (action === 'noop') return { resumed: true, transport: 'cloud', sid, reason: 'alive' };
    try { await deps.cloudWake(sid); } catch { /* best-effort wake */ }
    return { resumed: true, transport: 'cloud', sid, reason: 'ok' };
  }

  // native
  let v: { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean };
  try {
    v = deps.nativeVerdict(sid);
  } catch {
    return { resumed: false, transport: 'native', sid, reason: 'gone' };
  }
  const action = decideNativeResume(v);
  if (action === 'attach') return { resumed: true, transport: 'native', sid, reason: 'alive' };
  if (action === 'conflict') return { resumed: false, transport: 'native', sid, reason: 'conflict' };
  if (action === 'gone') return { resumed: false, transport: 'native', sid, reason: 'gone' };
  const launched = await deps.resumeNative(missionId, sid); // resumeNative preserves sid
  return { resumed: true, transport: 'native', sid: launched.sid, reason: 'ok' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-resume.test.js 2>&1 | grep -E "# (tests|pass|fail)"`
Expected: `# pass 15`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist
git add core/src/mission/mission-resume.ts core/src/__tests__/mission-resume.test.ts
git commit -m "feat(mission-resume): resumeWorker orchestrator (cloud wake / native resume in place)"
```

---

## Task 3: Wire `handleSessionResume` to `resumeWorker` (native `--resume`, sid preserved)

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (the `SessionResumeDeps` interface, `defaultSessionResumeDeps`, `handleSessionResume`)
- Test: `core/src/__tests__/mission-session-resume.test.ts`

**Interfaces:**
- Consumes: `resumeWorker`, `ResumeResult`, `ResumeWorkerDeps` (Task 2); the existing `cloudDrive`, `sessionVerdict`, `tmuxCcController.launch`, `startNativeExecutor`, `cloudListAccount`, `pickNewSession`, `cseToSessionSid` (already imported via `require(...)` in the current `relaunch` dep at `mission.routes.ts:957-1018`).
- Produces: `handleSessionResume` returns `ok({ resumed, transport, sid, reason?, note?, autoCloseAt? })`. The route registration is UNCHANGED (already at `mission.routes.ts:1113-1117`).

> Context for the implementer: read `handleSessionResume` (`mission.routes.ts:1037-1077`) and its current `defaultSessionResumeDeps.relaunch` (`mission.routes.ts:957-1019`). You are REPLACING the cloud "status-only" branch and the native "fresh relaunch" with a `resumeWorker` call whose deps revive the SAME session. The native `resumeNative` is the old `relaunch` body with two changes: (a) pass `resume: sid` into `tmuxCcController.launch`, (b) set `binding.sessionId = sid` (the original), not the launched id.

- [ ] **Step 1: Update the resume tests to the new contract (failing)**

In `core/src/__tests__/mission-session-resume.test.ts`, replace the native test (`handleSessionResume: native → calls relaunch, returns new sid + autoCloseAt`, currently lines ~181-198) and the deps factory (`makeResumeDeps`, lines ~120-133) so native resume returns the SAME sid and cloud-idle wakes. The new `SessionResumeDeps` (Task 3 Step 3) replaces `relaunch` with `cloudWake`, `nativeVerdict`, `resumeNative`. Use:

```typescript
function makeResumeDeps(overrides: Partial<SessionResumeDeps> = {}): SessionResumeDeps {
  return {
    resolve: (sid) => ({ sid, transport: sid.startsWith('session_') ? 'cloud' : 'native', missionId: null, role: 'worker' as const }),
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'running' } }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    resumeNative: async (_missionId, sid) => ({ sid, boundAt: Date.now() }),
    idleMin: 30,
    ...overrides,
  };
}

test('handleSessionResume: native resume → SAME sid preserved + autoCloseAt', async () => {
  const sid = '4e15ac46-native-dead';
  const r = await handleSessionResume(sid, { missionId: 'mission_abc' }, makeResumeDeps());
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
  assert.strictEqual(d.sid, sid, 'native resume must preserve the original sessionId');
  assert.strictEqual(d.transport, 'native');
  assert.ok(typeof d.autoCloseAt === 'number');
});

test('handleSessionResume: native refuse → resumed=false, reason=conflict', async () => {
  const r = await handleSessionResume('uuid-conflict', { missionId: 'm' }, makeResumeDeps({
    nativeVerdict: () => ({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }),
  }));
  assert.strictEqual((r as any).data.resumed, false);
  assert.strictEqual((r as any).data.reason, 'conflict');
});

test('handleSessionResume: cloud idle → resumed=true, reason=ok, cloudWake called', async () => {
  let woke = false;
  const r = await handleSessionResume('session_idle', {}, makeResumeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'idle' } }),
    cloudWake: async () => { woke = true; },
  }));
  assert.strictEqual((r as any).data.reason, 'ok');
  assert.strictEqual(woke, true);
});
```

Keep the existing cloud-gone, cloud-throws-grace, leader-anchor, and missionId-forwarding tests — but update the cloud-alive test's deps to include `worker_status: 'running'` so it stays `alive`. (The `handleSessionResume: native relaunch uses missionId from body` test: rename the dep hook from `relaunch` to `resumeNative` capturing the missionId arg.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test 2>&1 | tail -5`
Expected: TS errors — `SessionResumeDeps` has no `cloudWake`/`nativeVerdict`/`resumeNative` (still the old `relaunch` shape).

- [ ] **Step 3: Implement**

In `core/src/routes/core/mission.routes.ts`:

(a) Add the import near the top imports:

```typescript
import { resumeWorker, type ResumeWorkerDeps } from '../../mission/mission-resume';
```

(b) Replace the `SessionResumeDeps` interface (currently `mission.routes.ts:938-948`) with:

```typescript
/** Deps for handleSessionResume — injected for testability. Mirrors ResumeWorkerDeps + idleMin. */
export interface SessionResumeDeps extends ResumeWorkerDeps {
  /** Idle minutes before auto-close (from project settings). */
  idleMin: number;
}
```

(c) Replace `defaultSessionResumeDeps` (currently `mission.routes.ts:950-1025`) with a version whose `resumeNative` resumes the SAME session. The body is the old `relaunch` (lines 957-1018) with the two marked changes:

```typescript
function defaultSessionResumeDeps(): SessionResumeDeps {
  return {
    resolve: (sid) => {
      const r = resolveMissionSession(sid, [], null);
      return { transport: r.transport, missionId: r.missionId };
    },
    cloudStatus: (sid) => {
      const { cloudStatus } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      return cloudStatus(sid);
    },
    cloudWake: async (sid) => {
      const { cloudDrive } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      await cloudDrive({ sid, text: 'Resume: continue your task where you left off.', reBootstrap: true });
    },
    nativeVerdict: (sid) => {
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const v = sessionVerdict(sid);
      return { connectStrategy: v.connectStrategy, safeToCreateTmux: v.safeToCreateTmux, inTmux: v.inTmux };
    },
    resumeNative: async (missionId, sid) => {
      const { getMission, putMission } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      const m = missionId ? await getMission(missionId) : null;
      if (!m) throw new Error(`mission ${missionId} not found for resume`);
      const { startNativeExecutor } = require('../../mission/mission-controller') as typeof import('../../mission/mission-controller');
      const { place } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
      const { listMissions: lm } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      const { cloudListAccount, cloudDrive } = require('../../terminal/ccr-cloud') as typeof import('../../terminal/ccr-cloud');
      const { tmuxCcController } = require('../../terminal/tmux-backend') as typeof import('../../terminal/tmux-backend');
      const { gitCommand } = require('../../checkpoint/git-utils') as typeof import('../../checkpoint/git-utils');
      const { missionSessionTitle } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
      const pathmod = require('path') as typeof import('path');
      const all = await lm();
      const pd = place(m, all);
      if (!pd.go) throw new Error(`mission ${missionId} not placeable for resume: ${(pd as any).reason}`);
      const baselineArr = await cloudListAccount().then((ss: Array<{ sid: string }>) => ss.map((s) => s.sid)).catch(() => [] as string[]);
      const nativeDeps = {
        ensureWorktree: async (repo: string, dir: string, branch: string): Promise<string> => {
          const absRepo = pathmod.isAbsolute(repo) ? repo : pathmod.resolve(process.cwd(), repo);
          const absDir = pathmod.isAbsolute(dir) ? dir : pathmod.resolve(absRepo, dir);
          try { gitCommand(['worktree', 'add', absDir, '-b', branch], absRepo); }
          catch (err) { if (!/already exists|already checked out|is already/i.test((err as Error).message || '')) throw err; }
          return absDir;
        },
        // CHANGE (a): pass resume: sid → `claude --resume <sid>` continues the SAME session.
        launch: async (cwd: string): Promise<{ sessionId: string | null; tmuxSession: string }> => {
          const res = await tmuxCcController.launch({ cwd, resume: sid, remoteControl: true, skipPermissions: true, autoTrust: true, name: missionSessionTitle(m) });
          return { sessionId: (res.sessionId as string | null) ?? null, tmuxSession: res.tmuxSession as string };
        },
        listAccount: cloudListAccount,
        baseline: baselineArr,
        drive: async (s: string, text: string) => { await cloudDrive({ sid: s, text }).catch(() => {}); },
      };
      const decisionAny = pd as any;
      const repoRaw: string = (pd.go ? decisionAny.repo : null) || process.cwd();
      const repoAbs = pathmod.isAbsolute(repoRaw) ? repoRaw : pathmod.resolve(process.cwd(), repoRaw);
      const binding = await startNativeExecutor(m, { ...(pd.go ? pd : {}), repo: repoAbs }, nativeDeps);
      // CHANGE (b): PRESERVE the original sessionId (continuity); only the bridge ccr is new.
      m.binding = { ...binding, sessionId: sid, boundAt: binding.boundAt ?? Date.now() };
      try { await putMission(m); } catch { /* best-effort persist */ }
      return { sid, boundAt: m.binding.boundAt ?? Date.now() };
    },
    idleMin: (() => {
      const { getProjectSettings } = require('../../project-settings') as typeof import('../../project-settings');
      return getProjectSettings().missionSessionIdleCloseMin ?? 30;
    })(),
  };
}
```

(d) Replace the body of `handleSessionResume` (the part AFTER the leader-anchor block, currently `mission.routes.ts:1048-1076`) with a `resumeWorker` delegation:

```typescript
  const d = deps ?? defaultSessionResumeDeps();
  const result = await resumeWorker(sid, body.missionId, d);
  // Stamp autoCloseAt + reaper tracking only for a freshly-resumed native session.
  if (result.transport === 'native' && result.resumed && result.reason === 'ok') {
    const now = Date.now();
    const autoCloseAt = now + d.idleMin * 60_000;
    try { trackResumedNative(result.sid, body.missionId, now); } catch { /* best-effort */ }
    return ok({ ...result, autoCloseAt });
  }
  return ok(result);
```

Keep the leader-anchor block (lines 1044-1046) unchanged at the top of the function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-session-resume.test.js 2>&1 | grep -E "# (tests|pass|fail)|not ok"`
Expected: `# fail 0` (all resume + status + isIdleExpired tests pass).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist
git add core/src/routes/core/mission.routes.ts core/src/__tests__/mission-session-resume.test.ts
git commit -m "feat(mission-resume): handleSessionResume resumes in place (native --resume, cloud wake)"
```

---

## Task 4: MCP `mission_session_resume` tool + scope

**Files:**
- Modify: `core/src/mcp-server/tools/mission.ts` (tool def in `MISSION_TOOLS`, handler in `MISSION_HANDLERS`)
- Modify: `core/src/mcp-server/configure.ts` (`TOOL_SCOPES`)
- Test: `core/src/__tests__/mcp-tool-scopes.test.ts`

**Interfaces:**
- Consumes: the `POST /mission/session/:sid/resume` route (Task 3). The existing `obj`, `S`, `workerPost`, `pretty`, `err`, `withActorHint`, `currentMcpContext` helpers in `mission.ts`.

- [ ] **Step 1: Write/extend the failing scope test**

In `core/src/__tests__/mcp-tool-scopes.test.ts`, add (or extend an existing "every tool has a scope" assertion) a case asserting `mission_session_resume` maps to `'write'`:

```typescript
test('mission_session_resume has a write scope', () => {
  const { TOOL_SCOPES } = require('../mcp-server/configure');
  assert.strictEqual(TOOL_SCOPES['mission_session_resume'], 'write');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test dist-test/__tests__/mcp-tool-scopes.test.js 2>&1 | grep -E "not ok|# fail"`
Expected: the new test FAILS (`undefined !== 'write'`).

- [ ] **Step 3: Implement**

(a) In `core/src/mcp-server/tools/mission.ts`, add to the `MISSION_TOOLS` array (after the `mission_session_control` entry, before the closing `] as const` at line ~143):

```typescript
  {
    name: 'mission_session_resume',
    description: 'Resume a mission\'s worker session IN PLACE, preserving its context. Native → `claude --resume` + re-bridge (SAME sessionId); cloud → wake an idle worker (re-drive). Returns {resumed, transport, sid, reason}. reason: ok (resumed) | alive (already running) | conflict (live elsewhere, unsafe to resume) | gone (terminal — spawn a fresh worker as a SEPARATE action; this tool never auto-replaces). Pass missionId for native. Write tool — leader-anchored.',
    inputSchema: obj({ sid: S, missionId: S }, ['sid']),
  },
```

(b) In `MISSION_HANDLERS` (after `mission_session_control`, before the closing `};` at line ~249):

```typescript
  mission_session_resume: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      const body: Record<string, unknown> = {};
      if (a.missionId) body.missionId = String(a.missionId);
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/resume`, body));
    } catch (e) { return err((e as Error).message); }
  },
```

(c) In `core/src/mcp-server/configure.ts`, add to `TOOL_SCOPES` (next to the other `mission_session_*` entries at lines 258-262):

```typescript
  mission_session_resume: 'write',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test dist-test/__tests__/mcp-tool-scopes.test.js 2>&1 | grep -E "# (tests|pass|fail)"`
Expected: `# fail 0`. Also confirm the whole MCP server builds the tool list without `assertScopesCoverTools` throwing:
Run: `node -e "const {assertScopesCoverTools}=require('./dist/mcp-server/configure'); assertScopesCoverTools(); console.log('scopes OK')"`
Expected: `scopes OK`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist
git add core/src/mcp-server/tools/mission.ts core/src/mcp-server/configure.ts core/src/__tests__/mcp-tool-scopes.test.ts
git commit -m "feat(mission-resume): mission_session_resume MCP tool + write scope"
```

---

## Task 5: Controller playbook — resume a dead/idle worker via `mission_session_resume` (resume-first)

**Files:**
- Modify: `core/src/mission/mission-controller.ts` (`CONTROLLER_SYSTEM_PROMPT` ~line 379, `CONTROLLER_PASS_DIRECTIVE` ~line 364)
- Modify: `core/src/mcp-server/tools/guide.ts` (the `missions` topic — the suspended-worker guidance, step e2)
- Test: `core/src/__tests__/mission-guide.test.ts` (existing — already asserts `missions`-topic + controller-prompt content)

**Why a playbook update, NOT an in-process supervisor change:** the PRODUCTION controller is an AGENT — a native `claude --remote-control` session launched + driven by `runSupervisorTick` (the in-process `runMissionTick`/`processMission` loop is LEGACY: `mission-controller.ts:534` says `runSupervisorTick` "replaces `runMissionTick`", and `runMissionTick` has NO production caller). The agent resumes a worker by calling the **`mission_session_resume` MCP tool** (Task 4). So the controller-resume capability is delivered by TEACHING the agent (its system prompt + pass directive + the `guide("missions")` playbook) to RESUME a dead/idle bound worker in place before spawning a fresh one. No in-process supervisor code changes; no `tryResumeBoundWorker`, no `MissionBinding.lastResumeAttempt`, no `processMission` edit.

**Interfaces:**
- Consumes: the `mission_session_resume(sid)` tool from Task 4 (`{resumed, transport, sid, reason}`, `reason ∈ ok|alive|gone|conflict|status-unknown`).
- Produces: updated prompt/guide constants + a regression test asserting the resume-first guidance is present.

- [ ] **Step 1: Write the failing regression test**

Read `core/src/__tests__/mission-guide.test.ts` first to match how it imports the controller prompt + reads the `missions` guide topic. Add two tests (adapt the topic-read to whatever helper that file already uses):

```typescript
test('controller system prompt teaches resume-first via mission_session_resume', () => {
  const { CONTROLLER_SYSTEM_PROMPT } = require('../mission/mission-controller');
  assert.ok(CONTROLLER_SYSTEM_PROMPT.includes('mission_session_resume'), 'system prompt must name mission_session_resume');
  assert.match(CONTROLLER_SYSTEM_PROMPT, /do NOT spawn a fresh|resume[^.]*before[^.]*(fresh|spawn)/i);
});

test('guide("missions") teaches resume via mission_session_resume', () => {
  // Use the SAME topic-read helper the rest of this file uses (read the file to confirm the import).
  const topicText = readMissionsGuideTopic(); // ← replace with this file's existing accessor
  assert.ok(topicText.includes('mission_session_resume'), 'missions guide must mention mission_session_resume');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && (export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null; npm run build:test && node --test dist-test/__tests__/mission-guide.test.js 2>&1 | grep -E "not ok|# fail")`
Expected: the two new tests FAIL (the prompt/guide don't mention `mission_session_resume` yet).

- [ ] **Step 3: Implement the playbook edits**

(a) `CONTROLLER_SYSTEM_PROMPT` (`mission-controller.ts`) — add a section right after the existing "ANSWERING A WORKER FAST" block (each line is a string element in the array, matching the surrounding style):
```
'RESUMING A DEAD / IDLE WORKER: if a BOUND worker reads as not-live (mission_session_read / ' +
'mission_executor_status shows it dead or idle) but you still have its sid, RESUME IT IN PLACE with ' +
'`mission_session_resume(sid)` FIRST — it revives the SAME session (cloud: wakes an idle worker; ' +
'native: `claude --resume` + re-bridge), preserving its transcript/context. Do NOT spawn a fresh ' +
'worker for a resumable one. ONLY if mission_session_resume returns reason `gone` (terminal / ' +
'unrecoverable) or `conflict` (the session is live elsewhere, unsafe to resume) do you spawn a FRESH ' +
'executor (the separate explicit step) via ccr_cloud_start + re-bind. Resume-first preserves context; respawn loses it.',
```

(b) `CONTROLLER_PASS_DIRECTIVE` (`mission-controller.ts`) — add a resume-first clause before the existing "drive/adapt/decide" clause (keep all existing wording; just insert):
```
'… mission_session_answer; if a BOUND worker is not live, FIRST mission_session_resume(sid) to revive it in place (spawn a fresh one ONLY on reason gone/conflict); drive/adapt/decide as needed; then await the next pass.'
```

(c) `guide("missions")` step e2 (`guide.ts`) — the current text tells a suspended worker case to "report honestly (blocked, NOT done) and respawn fresh." Refine it: FIRST try `mission_session_resume(sid)` to revive it in place (cloud wake / native `--resume`); report `blocked` + spawn fresh ONLY if it returns `gone`/`conflict`. Keep the "answer FAST / cloud idle-suspend timing" warning intact — resume-first is the addition, not a replacement of the answer-fast guidance.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command → `# fail 0` for the two new tests. Then `cd /home/ubuntu/lm-assist && ./core.sh build` → exit 0 (the prompt constants must compile). Also confirm you didn't break the file's existing assertions (run the whole `mission-guide.test.js` → `# fail 0`).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist
git add core/src/mission/mission-controller.ts core/src/mcp-server/tools/guide.ts core/src/__tests__/mission-guide.test.ts
git commit -m "feat(mission-resume): controller playbook resumes a dead worker via mission_session_resume (resume-first)"
```

---

## Task 6: Web UI — surface resume results + "Start fresh worker"

**Files:**
- Modify: `web/src/components/missions/MissionsPage.tsx`

**Interfaces:**
- Consumes: the resume route result `{ resumed, transport, sid, reason, autoCloseAt? }` (Task 3). The existing `checkAndHandleTabLiveness` / `confirmResumeNative` / `tabStates` machinery and the `'confirm-resume'` UI block.

> Context for the implementer: today `checkAndHandleTabLiveness` auto-calls resume for a dead cloud tab and shows a `'confirm-resume'` prompt for native; `confirmResumeNative` swaps the tab to the returned new sid. With the new backend: native resume returns the SAME sid (no swap needed); resume can now return `reason: 'conflict'` or `'gone'`. Read those functions, then handle the new reasons.

- [ ] **Step 1: Build the web (baseline) to confirm it compiles before changes**

Run: `cd /home/ubuntu/lm-assist && export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null; cd web && npx tsc --noEmit 2>&1 | grep -c "MissionsPage" || echo "0 MissionsPage errors"`
Expected: `0 MissionsPage errors` (pre-existing errors elsewhere are fine).

- [ ] **Step 2: Implement the result handling**

In `web/src/components/missions/MissionsPage.tsx`, in the resume-result handling (inside `checkAndHandleTabLiveness` for cloud and `confirmResumeNative` for native), branch on `data.reason`:
- `reason === 'gone'` → set the tab state to a new `'resume-gone'` UI state showing "Can't resume — this worker is gone." + a **"Start fresh worker"** button that calls the existing fresh-spawn path (the same action the controller's `mission_place`/spawn uses — reuse whatever the current "create executor" UI action is; if none exists in this view, the button calls `POST /mission/:id` patch to clear the binding so the controller spawns fresh, matching `mission_session_control restart` semantics for non-controllers).
- `reason === 'conflict'` → a `'resume-conflict'` state: "This session is live elsewhere and can't be safely resumed." (no fresh button — it's not gone).
- `reason === 'ok' | 'alive'` → render the session view as today. For native, keep the SAME `tab.sid` (do NOT swap — the backend preserved it).

Mirror the existing `tabStates` shape and the `'confirm-resume'`/`'gone'` rendering blocks (search `confirm-resume` and `'gone'` in the file) for the two new states.

- [ ] **Step 3: Type-check + build the web**

Run: `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep "MissionsPage" || echo "0 MissionsPage errors"`
Expected: `0 MissionsPage errors`.
Run: `cd /home/ubuntu/lm-assist && ./core.sh build 2>&1 | tail -2` (core unaffected; ensures nothing broke).

- [ ] **Step 4: Manual browser verification (dev web :3948)**

Per the dev-web-browser-testing note (LAN IP + inject `lanAccessToken` into `localStorage.assist_access_key`). With a mission that has a bound worker:
- Native: kill the worker's tmux on its node, click the worker tab → it resumes onto the **same sessionId** (transcript continues), re-bridged.
- Cloud idle worker: click → wakes (re-drive).
- A stopped cloud session → "Can't resume — gone" + "Start fresh worker".
Expected: each path matches; no duplicate worker spawned on resume.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist
git add web/src/components/missions/MissionsPage.tsx
git commit -m "feat(mission-resume): UI handles ok/alive/conflict/gone + Start-fresh-worker"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Task 1-2 = shared backend + decisions; Task 3 = REST + native `--resume` (sid preserved) + cloud wake; Task 4 = MCP tool + scope; Task 5 = controller resume-before-replace + loop guard; Task 6 = UI + the explicit "Start fresh worker". The spec's "resume-only / report gone / never auto-replace" is enforced in `resumeWorker` (no spawn) and Task 5 (controller does not auto-respawn).
- **Type consistency:** `ResumeResult.reason` ∈ `ok|alive|gone|conflict|status-unknown` is used identically in Tasks 2-6. `resumeNative` returns the SAME `sid` in Tasks 2 and 3. `connectStrategy` literals match `cc-sessions.ts`.
- **Risk callouts for review:** (1) Task 3 native `tmuxCcController.launch({resume, remoteControl:true})` — verify `claude --resume <id> --remote-control` actually composes (manual E2E in Task 6); (2) Task 5 changes controller autonomy (no silent respawn) — the highest-risk task, review the supervisor integration + loop guard carefully; (3) confirm `MissionBinding` type accepts `lastResumeAttempt?`.
