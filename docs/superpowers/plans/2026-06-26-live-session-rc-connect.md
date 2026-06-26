# Live-Session Remote-Control Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect/resume a **live** local Claude Code session to CCR by injecting `/remote-control` into its terminal in place; fall back to a gated kill-then-resume only when the input is unreachable or the inject fails.

**Architecture:** A new backend `core/src/terminal/live-rc-connect.ts` holds pure decision functions, no-throw safety primitives (kill / inject / poll), and the `ensureRemoteControlled` orchestrator (all I/O via injected deps). A thin factory `live-rc-connect-deps.ts` wires the real I/O (sessionVerdict, cloudListAccount, tmux send-keys, Windows `focusAndSend`, process kill). Two entry points call it for their live case: `ccr.connect()` and the mission `resumeWorker`.

**Tech Stack:** TypeScript (CommonJS), `node:test`, existing `core/src/terminal/*` helpers, raw Node HTTP routes, MCP stdio tools.

## Global Constraints

- **Never resume over a live process.** A `claude --resume` runs only when no live owner pid holds the transcript. If a kill is attempted and the process does not die, ABORT — do not resume.
- **No-throw orchestration.** Every I/O primitive (tmux exec, Windows PowerShell, `process.kill`, cloud `fetch`) is wrapped in try/catch, carries an explicit timeout, and returns a structured `{ ok, … , error? }`. `ensureRemoteControlled` returns a discriminated-union result and never rejects.
- **Toggle safety.** `/remote-control` is a TOGGLE. Never inject into a session confirmed already-connected. When prior RC state is uncertain, verify by OUTCOME (cloud session appears/active), re-snapshotting the cloud baseline before each of the (max 2) inject attempts so a stale-RC off→on toggle self-corrects.
- **No junk left behind.** If we inject and then decide NOT to kill, clear the injected input (tmux `Escape`+`C-u`; Windows `{ESC}`).
- **Kill is gated.** Auto-kill only when `idleMs >= idleThresholdMs` (default 30 min, from `missionSessionIdleCloseMin`). An actively-busy unreachable session is killed only with `force:true`; otherwise return `needs-force` with no side effects.
- **Leader-anchored writes.** The mission resume surface stays leader-anchored.
- Bare `{ success, data }` mission routes via `ok()`/`fail()`; `ccr` routes via `envelope()`/`TerminalError`. Adding a param to an existing MCP tool needs no new `TOOL_SCOPES` entry (`ccr_connect` and `mission_session_resume` already exist); do not remove their scopes.
- Build after TS edits: `./core.sh build`. **Test runner — `tsx` is NOT installed.** Use: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js` — `build:test` runs `tsc -p tsconfig.test.json` compiling `core/src/**/*.test.ts` → `core/dist-test/`. In a RED step (module/symbol not yet created) the failure surfaces as a tsc "Cannot find module"/"has no exported member" compile error — that is the expected failing state. The `node --test --import tsx …` lines inside the task steps are STALE; substitute this runner.

---

### Task 1: Pure decision functions

**Files:**
- Create: `core/src/terminal/live-rc-connect.ts`
- Test: `core/src/__tests__/live-rc-connect-decide.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `Reachability`, `LiveAction`, `DEAD_CLOUD_STATUSES`, `classifyReachability(v,platform)`, `idleMs(updatedAt,now)`, `killEligibility(i)`, `decideLiveAction(i)` — exact signatures in Step 3.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/live-rc-connect-decide.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyReachability, idleMs, killEligibility, decideLiveAction,
} from '../terminal/live-rc-connect';

// ── classifyReachability ──────────────────────────────────────────────────────
test('classifyReachability: not live → none', () => {
  assert.strictEqual(classifyReachability({ live: false, inTmux: true }, { isWindows: false }), 'none');
});
test('classifyReachability: linux + inTmux → tmux', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: true }, { isWindows: false }), 'tmux');
});
test('classifyReachability: linux + not tmux → none', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: false }, { isWindows: false }), 'none');
});
test('classifyReachability: windows driveable → windows', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: false }, { isWindows: true, windowsDriveable: true }), 'windows');
});
test('classifyReachability: windows NOT driveable → none', () => {
  assert.strictEqual(classifyReachability({ live: true, inTmux: false }, { isWindows: true, windowsDriveable: false }), 'none');
});

// ── idleMs ────────────────────────────────────────────────────────────────────
test('idleMs: missing/invalid → 0 (treat as just-active)', () => {
  assert.strictEqual(idleMs(undefined, 1_000_000), 0);
  assert.strictEqual(idleMs('not-a-date', 1_000_000), 0);
});
test('idleMs: computes now - updatedAt, floored at 0', () => {
  const updated = '2026-06-26T00:00:00.000Z';
  const now = Date.parse(updated) + 60_000;
  assert.strictEqual(idleMs(updated, now), 60_000);
  assert.strictEqual(idleMs(updated, Date.parse(updated) - 5_000), 0);
});

// ── killEligibility ───────────────────────────────────────────────────────────
test('killEligibility: force always → kill', () => {
  assert.strictEqual(killEligibility({ idleMs: 0, idleThresholdMs: 1000, force: true }), 'kill');
});
test('killEligibility: idle >= threshold → kill', () => {
  assert.strictEqual(killEligibility({ idleMs: 1000, idleThresholdMs: 1000, force: false }), 'kill');
});
test('killEligibility: idle < threshold, no force → needs-force', () => {
  assert.strictEqual(killEligibility({ idleMs: 999, idleThresholdMs: 1000, force: false }), 'needs-force');
});

// ── decideLiveAction ──────────────────────────────────────────────────────────
const base = { live: true, alreadyConnected: false, reachable: 'none' as const, idleMs: 0, idleThresholdMs: 1000, force: false };
test('decideLiveAction: not live → resume-dead', () => {
  assert.strictEqual(decideLiveAction({ ...base, live: false }), 'resume-dead');
});
test('decideLiveAction: alreadyConnected → already-connected (never inject)', () => {
  assert.strictEqual(decideLiveAction({ ...base, alreadyConnected: true, reachable: 'tmux' }), 'already-connected');
});
test('decideLiveAction: reachable tmux → inject-tmux', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'tmux' }), 'inject-tmux');
});
test('decideLiveAction: reachable windows → inject-windows', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'windows' }), 'inject-windows');
});
test('decideLiveAction: unreachable + idle → kill', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'none', idleMs: 2000 }), 'kill');
});
test('decideLiveAction: unreachable + busy, no force → needs-force', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'none', idleMs: 0 }), 'needs-force');
});
test('decideLiveAction: unreachable + busy + force → kill', () => {
  assert.strictEqual(decideLiveAction({ ...base, reachable: 'none', idleMs: 0, force: true }), 'kill');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/live-rc-connect-decide.test.ts`
Expected: FAIL — `Cannot find module '../terminal/live-rc-connect'`.
(If `tsx` is unavailable, use the repo's existing runner — check `core/package.json` `scripts.test` and mirror it; the import path/style matches `core/src/__tests__/mission-resume.test.ts`.)

- [ ] **Step 3: Write minimal implementation**

Create `core/src/terminal/live-rc-connect.ts`:

```ts
// Convert a LIVE local Claude Code session to remote-control IN PLACE by injecting
// the `/remote-control` slash command; gated kill-then-resume fallback when the
// input is unreachable (headless) or the inject fails. Pure decisions + no-throw
// I/O primitives + the ensureRemoteControlled orchestrator (injected deps).

export type Reachability = 'tmux' | 'windows' | 'none';

export type LiveAction =
  | 'resume-dead'
  | 'already-connected'
  | 'inject-tmux'
  | 'inject-windows'
  | 'kill'
  | 'needs-force';

/** Cloud statuses that are NOT an active connection (terminal/dead/unknown). */
export const DEAD_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived', 'unknown'];

export function classifyReachability(
  v: { live: boolean; inTmux: boolean },
  platform: { isWindows: boolean; windowsDriveable?: boolean },
): Reachability {
  if (!v.live) return 'none';
  if (platform.isWindows) return platform.windowsDriveable ? 'windows' : 'none';
  return v.inTmux ? 'tmux' : 'none';
}

export function idleMs(updatedAt: string | undefined, now: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now - t);
}

export function killEligibility(i: { idleMs: number; idleThresholdMs: number; force: boolean }): 'kill' | 'needs-force' {
  if (i.force) return 'kill';
  return i.idleMs >= i.idleThresholdMs ? 'kill' : 'needs-force';
}

export function decideLiveAction(i: {
  live: boolean;
  alreadyConnected: boolean;
  reachable: Reachability;
  idleMs: number;
  idleThresholdMs: number;
  force: boolean;
}): LiveAction {
  if (!i.live) return 'resume-dead';
  if (i.alreadyConnected) return 'already-connected';
  if (i.reachable === 'tmux') return 'inject-tmux';
  if (i.reachable === 'windows') return 'inject-windows';
  return killEligibility(i) === 'kill' ? 'kill' : 'needs-force';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/live-rc-connect-decide.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/live-rc-connect.ts core/src/__tests__/live-rc-connect-decide.test.ts
git commit -m "feat(live-rc): pure decision functions for live-session remote-control connect"
```

---

### Task 2: No-throw safety primitives

**Files:**
- Modify: `core/src/terminal/live-rc-connect.ts` (append primitives + interfaces)
- Test: `core/src/__tests__/live-rc-connect-primitives.test.ts`

**Interfaces:**
- Consumes: `DEAD_CLOUD_STATUSES` (Task 1).
- Produces:
  - `interface KillExec { isAlive(pid):boolean; signal(pid,sig):void; taskkill(pid):void; sleep(ms):Promise<void> }`
  - `killOwner(pid, opts:{isWindows;graceMs?;pollMs?}, exec:KillExec): Promise<{killed:boolean;wasAlive:boolean;method:'sigterm'|'sigkill'|'taskkill'|'none'}>`
  - `type InjectTarget = { via:'tmux'|'windows'; tmuxTarget?:string; pid?:number }`
  - `interface InjectExec { tmuxSend(target,keys,literal,enter):void; windowsSend(pid,opts):Promise<{ok:boolean;error?:string}> }`
  - `injectRemoteControl(target:InjectTarget, exec:InjectExec): Promise<{ok:boolean;via:'tmux'|'windows';error?:string}>`
  - `clearInjectedInput(target:InjectTarget, exec:InjectExec): Promise<void>`
  - `interface CloudSession { sid:string; status:string; title?:string }`
  - `pollForCloudConnection(match:{title?;excludeSids:Set<string>}, list:()=>Promise<CloudSession[]>, opts:{timeoutMs?;intervalMs?;sleep}): Promise<{connected:boolean;sid?:string}>`

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/live-rc-connect-primitives.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  killOwner, injectRemoteControl, clearInjectedInput, pollForCloudConnection,
  type KillExec, type InjectExec, type CloudSession,
} from '../terminal/live-rc-connect';

const noSleep = async () => {};

function killExec(aliveSeq: boolean[]): { exec: KillExec; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const exec: KillExec = {
    isAlive: () => (i < aliveSeq.length ? aliveSeq[i++] : aliveSeq[aliveSeq.length - 1]),
    signal: (_pid, sig) => calls.push(sig),
    taskkill: () => calls.push('taskkill'),
    sleep: noSleep,
  };
  return { exec, calls };
}

// ── killOwner ─────────────────────────────────────────────────────────────────
test('killOwner: not alive → killed, method none, no signals', async () => {
  const { exec, calls } = killExec([false]);
  const r = await killOwner(1, { isWindows: false }, exec);
  assert.deepStrictEqual(r, { killed: true, wasAlive: false, method: 'none' });
  assert.deepStrictEqual(calls, []);
});
test('killOwner: SIGTERM works (dies within grace) → method sigterm', async () => {
  // alive (initial check), then dead on first poll
  const { exec, calls } = killExec([true, false]);
  const r = await killOwner(1, { isWindows: false, graceMs: 1000, pollMs: 250 }, exec);
  assert.strictEqual(r.killed, true);
  assert.strictEqual(r.method, 'sigterm');
  assert.deepStrictEqual(calls, ['SIGTERM']);
});
test('killOwner: SIGTERM fails → escalates to SIGKILL', async () => {
  // alive for the SIGTERM grace window, then dead after SIGKILL
  const { exec, calls } = killExec([true, true, true, true, true, false]);
  const r = await killOwner(1, { isWindows: false, graceMs: 500, pollMs: 250 }, exec);
  assert.strictEqual(r.method, 'sigkill');
  assert.strictEqual(r.killed, true);
  assert.deepStrictEqual(calls, ['SIGTERM', 'SIGKILL']);
});
test('killOwner: never dies → killed false (caller ABORTS)', async () => {
  const { exec } = killExec([true]); // always alive
  const r = await killOwner(1, { isWindows: false, graceMs: 500, pollMs: 250 }, exec);
  assert.strictEqual(r.killed, false);
});
test('killOwner: windows uses taskkill', async () => {
  const { exec, calls } = killExec([true, false]);
  const r = await killOwner(1, { isWindows: true, graceMs: 1000, pollMs: 250 }, exec);
  assert.strictEqual(r.method, 'taskkill');
  assert.deepStrictEqual(calls, ['taskkill']);
});
test('killOwner: signal throwing is swallowed', async () => {
  const calls: string[] = [];
  let i = 0; const aliveSeq = [true, false];
  const exec: KillExec = {
    isAlive: () => (i < aliveSeq.length ? aliveSeq[i++] : false),
    signal: () => { throw new Error('EPERM'); },
    taskkill: () => calls.push('tk'),
    sleep: noSleep,
  };
  const r = await killOwner(1, { isWindows: false }, exec);
  assert.strictEqual(r.killed, true); // process died anyway
});

// ── injectRemoteControl ───────────────────────────────────────────────────────
test('injectRemoteControl: tmux sends /remote-control literal + Enter', async () => {
  const sends: Array<[string, string, boolean, boolean]> = [];
  const exec: InjectExec = {
    tmuxSend: (t, k, lit, ent) => sends.push([t, k, lit, ent]),
    windowsSend: async () => ({ ok: false }),
  };
  const r = await injectRemoteControl({ via: 'tmux', tmuxTarget: 'sess:0.0' }, exec);
  assert.deepStrictEqual(r, { ok: true, via: 'tmux' });
  assert.deepStrictEqual(sends, [['sess:0.0', '/remote-control', true, true]]);
});
test('injectRemoteControl: windows uses windowsSend with submit', async () => {
  let got: any = null;
  const exec: InjectExec = {
    tmuxSend: () => {},
    windowsSend: async (pid, opts) => { got = { pid, opts }; return { ok: true }; },
  };
  const r = await injectRemoteControl({ via: 'windows', pid: 42 }, exec);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(got, { pid: 42, opts: { text: '/remote-control', submit: true } });
});
test('injectRemoteControl: tmux throw → ok false with error', async () => {
  const exec: InjectExec = { tmuxSend: () => { throw new Error('no server'); }, windowsSend: async () => ({ ok: false }) };
  const r = await injectRemoteControl({ via: 'tmux', tmuxTarget: 't' }, exec);
  assert.strictEqual(r.ok, false);
  assert.match(r.error || '', /no server/);
});
test('injectRemoteControl: missing target → ok false', async () => {
  const exec: InjectExec = { tmuxSend: () => {}, windowsSend: async () => ({ ok: true }) };
  assert.strictEqual((await injectRemoteControl({ via: 'tmux' }, exec)).ok, false);
  assert.strictEqual((await injectRemoteControl({ via: 'windows' }, exec)).ok, false);
});

// ── pollForCloudConnection ────────────────────────────────────────────────────
test('pollForCloudConnection: finds a NEW active session not in baseline', async () => {
  const list = async (): Promise<CloudSession[]> => [
    { sid: 'old', status: 'running' },
    { sid: 'new', status: 'running', title: 'Mission X' },
  ];
  const r = await pollForCloudConnection(
    { title: 'Mission X', excludeSids: new Set(['old']) }, list,
    { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.deepStrictEqual(r, { connected: true, sid: 'new' });
});
test('pollForCloudConnection: a baseline session does NOT count', async () => {
  const list = async (): Promise<CloudSession[]> => [{ sid: 'old', status: 'running', title: 'Mission X' }];
  const r = await pollForCloudConnection(
    { title: 'Mission X', excludeSids: new Set(['old']) }, list,
    { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.strictEqual(r.connected, false);
});
test('pollForCloudConnection: dead-status new session does NOT count', async () => {
  const list = async (): Promise<CloudSession[]> => [{ sid: 'new', status: 'stopped' }];
  const r = await pollForCloudConnection(
    { excludeSids: new Set() }, list, { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.strictEqual(r.connected, false);
});
test('pollForCloudConnection: list throwing mid-poll is swallowed (returns not connected)', async () => {
  const list = async (): Promise<CloudSession[]> => { throw new Error('429'); };
  const r = await pollForCloudConnection(
    { excludeSids: new Set() }, list, { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.strictEqual(r.connected, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/live-rc-connect-primitives.test.ts`
Expected: FAIL — `killOwner` / `injectRemoteControl` / `pollForCloudConnection` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/terminal/live-rc-connect.ts`:

```ts
// ── No-throw safety primitives (all I/O injected) ─────────────────────────────

export interface KillExec {
  isAlive: (pid: number) => boolean;
  signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void;
  taskkill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
}

async function waitDead(pid: number, totalMs: number, pollMs: number, exec: KillExec): Promise<boolean> {
  let waited = 0;
  while (waited < totalMs) {
    let alive = true;
    try { alive = exec.isAlive(pid); } catch { return true; }
    if (!alive) return true;
    await exec.sleep(pollMs);
    waited += pollMs;
  }
  try { return !exec.isAlive(pid); } catch { return true; }
}

export async function killOwner(
  pid: number,
  opts: { isWindows: boolean; graceMs?: number; pollMs?: number },
  exec: KillExec,
): Promise<{ killed: boolean; wasAlive: boolean; method: 'sigterm' | 'sigkill' | 'taskkill' | 'none' }> {
  const graceMs = opts.graceMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;
  let wasAlive = false;
  try { wasAlive = exec.isAlive(pid); } catch { wasAlive = false; }
  if (!wasAlive) return { killed: true, wasAlive: false, method: 'none' };

  if (opts.isWindows) {
    try { exec.taskkill(pid); } catch { /* ignore */ }
    return { killed: await waitDead(pid, graceMs, pollMs, exec), wasAlive: true, method: 'taskkill' };
  }

  try { exec.signal(pid, 'SIGTERM'); } catch { /* ignore */ }
  if (await waitDead(pid, graceMs, pollMs, exec)) return { killed: true, wasAlive: true, method: 'sigterm' };
  try { exec.signal(pid, 'SIGKILL'); } catch { /* ignore */ }
  return { killed: await waitDead(pid, graceMs, pollMs, exec), wasAlive: true, method: 'sigkill' };
}

export type InjectTarget = { via: 'tmux' | 'windows'; tmuxTarget?: string; pid?: number };

export interface InjectExec {
  tmuxSend: (target: string, keys: string, literal: boolean, enter: boolean) => void;
  windowsSend: (pid: number, opts: { text?: string; keys?: string; submit?: boolean }) => Promise<{ ok: boolean; error?: string }>;
}

export async function injectRemoteControl(
  target: InjectTarget,
  exec: InjectExec,
): Promise<{ ok: boolean; via: 'tmux' | 'windows'; error?: string }> {
  try {
    if (target.via === 'tmux') {
      if (!target.tmuxTarget) return { ok: false, via: 'tmux', error: 'no tmux target' };
      exec.tmuxSend(target.tmuxTarget, '/remote-control', true, true);
      return { ok: true, via: 'tmux' };
    }
    if (!target.pid) return { ok: false, via: 'windows', error: 'no pid' };
    const r = await exec.windowsSend(target.pid, { text: '/remote-control', submit: true });
    return { ok: !!r.ok, via: 'windows', error: r.error };
  } catch (e) {
    return { ok: false, via: target.via, error: (e as Error).message };
  }
}

export async function clearInjectedInput(target: InjectTarget, exec: InjectExec): Promise<void> {
  try {
    if (target.via === 'tmux' && target.tmuxTarget) {
      exec.tmuxSend(target.tmuxTarget, 'Escape', false, false);
      exec.tmuxSend(target.tmuxTarget, 'C-u', false, false);
    } else if (target.via === 'windows' && target.pid) {
      await exec.windowsSend(target.pid, { keys: '{ESC}' });
    }
  } catch { /* best-effort cosmetic cleanup */ }
}

export interface CloudSession { sid: string; status: string; title?: string }

export async function pollForCloudConnection(
  match: { title?: string; excludeSids: Set<string> },
  list: () => Promise<CloudSession[]>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep: (ms: number) => Promise<void> },
): Promise<{ connected: boolean; sid?: string }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 1500;
  let waited = 0;
  for (;;) {
    let sessions: CloudSession[] = [];
    try { sessions = await list(); } catch { sessions = []; }
    const hit = sessions.find((s) =>
      !DEAD_CLOUD_STATUSES.includes((s.status || '').toLowerCase()) &&
      !match.excludeSids.has(s.sid) &&
      (match.title ? (s.title === match.title || (s.title || '').includes(match.title)) : true),
    );
    if (hit) return { connected: true, sid: hit.sid };
    if (waited >= timeoutMs) return { connected: false };
    await opts.sleep(intervalMs);
    waited += intervalMs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/live-rc-connect-primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/live-rc-connect.ts core/src/__tests__/live-rc-connect-primitives.test.ts
git commit -m "feat(live-rc): no-throw kill/inject/poll safety primitives"
```

---

### Task 3: ensureRemoteControlled orchestrator

**Files:**
- Modify: `core/src/terminal/live-rc-connect.ts` (append orchestrator + types)
- Test: `core/src/__tests__/live-rc-connect-orchestrator.test.ts`

**Interfaces:**
- Consumes: all Task 1/2 exports.
- Produces:
  - `interface EnsureResult { ok:boolean; state:'connected'|'already-connected'|'needs-force'|'gone'|'kill-failed'|'error'; sid:string; via?:'resume-dead'|'inject'|'kill-resume'; cse?:string; attempts?:number; reason:string }`
  - `interface EnsureDeps { now; verdict; isWindows; windowsDriveable; isConnected; listCloud; inject; clearInput; pollConnection; killOwner; resumeDead; verifyDriveable; bindCse }` (exact in Step 3)
  - `ensureRemoteControlled(sid, opts:{force?;idleThresholdMs?;title?}, deps:EnsureDeps): Promise<EnsureResult>`

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/live-rc-connect-orchestrator.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { ensureRemoteControlled, type EnsureDeps, type CloudSession } from '../terminal/live-rc-connect';

const LIVE_TMUX = { live: true, inTmux: true, connectStrategy: 'attach-existing', tmuxTarget: 'sess:0.0', pid: 100, updatedAt: undefined };
const LIVE_HEADLESS = { live: true, inTmux: false, connectStrategy: 'refuse', tmuxTarget: null, pid: 100, updatedAt: undefined };
const DEAD = { live: false, inTmux: false, connectStrategy: 'create-tmux', tmuxTarget: null, pid: null, updatedAt: undefined };

function deps(over: Partial<EnsureDeps> & { verdict: EnsureDeps['verdict'] }): EnsureDeps {
  return {
    now: () => 1_000_000,
    isWindows: false,
    windowsDriveable: async () => false,
    isConnected: async () => false,
    listCloud: async () => [],
    inject: async () => ({ ok: true }),
    clearInput: async () => {},
    pollConnection: async () => ({ connected: false }),
    killOwner: async () => ({ killed: true }),
    resumeDead: async () => ({ ok: true, cse: 'cse_dead' }),
    verifyDriveable: async () => true,
    bindCse: async () => {},
    ...over,
  };
}

test('gone: no transcript / no process', async () => {
  const r = await ensureRemoteControlled('s', {}, deps({ verdict: () => ({ ...DEAD, connectStrategy: 'none' }) }));
  assert.strictEqual(r.state, 'gone');
  assert.strictEqual(r.ok, false);
});

test('dead → resume-dead + connected', async () => {
  const r = await ensureRemoteControlled('s', {}, deps({ verdict: () => DEAD }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'resume-dead');
  assert.strictEqual(r.cse, 'cse_dead');
});

test('already-connected (verified driveable) → no inject', async () => {
  let injected = false;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_TMUX, isConnected: async () => true,
    inject: async () => { injected = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'already-connected');
  assert.strictEqual(injected, false);
});

test('inject tmux success on attempt 1', async () => {
  let n = 0;
  const r = await ensureRemoteControlled('s', { title: 'M' }, deps({
    verdict: () => LIVE_TMUX,
    inject: async () => { n++; return { ok: true }; },
    pollConnection: async () => ({ connected: true, sid: 'cse_new' }),
  }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'inject');
  assert.strictEqual(r.cse, 'cse_new');
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(n, 1);
});

test('stale-RC toggle: attempt 1 no connection, attempt 2 connects', async () => {
  let n = 0;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_TMUX,
    inject: async () => { n++; return { ok: true }; },
    pollConnection: async () => ({ connected: n >= 2, sid: n >= 2 ? 'cse_2' : undefined }),
  }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(n, 2);
});

test('inject fails twice + idle → kill-resume', async () => {
  const idleVerdict = { ...LIVE_TMUX, updatedAt: '2026-06-26T00:00:00.000Z' };
  const now = Date.parse(idleVerdict.updatedAt) + 60 * 60 * 1000; // 60 min idle
  let killed = false;
  const r = await ensureRemoteControlled('s', { idleThresholdMs: 30 * 60 * 1000 }, deps({
    now: () => now,
    verdict: () => idleVerdict,
    pollConnection: async () => ({ connected: false }),
    killOwner: async () => { killed = true; return { killed: true }; },
  }));
  assert.strictEqual(killed, true);
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'kill-resume');
});

test('inject fails + busy + no force → needs-force, clears input, no kill', async () => {
  let killed = false; let cleared = false;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_TMUX, // updatedAt undefined → idle 0 = busy
    pollConnection: async () => ({ connected: false }),
    clearInput: async () => { cleared = true; },
    killOwner: async () => { killed = true; return { killed: true }; },
  }));
  assert.strictEqual(r.state, 'needs-force');
  assert.strictEqual(killed, false);
  assert.strictEqual(cleared, true);
});

test('unreachable (headless) + busy + no force → needs-force, no inject', async () => {
  let injected = false;
  const r = await ensureRemoteControlled('s', {}, deps({
    verdict: () => LIVE_HEADLESS,
    inject: async () => { injected = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'needs-force');
  assert.strictEqual(injected, false);
});

test('unreachable + force → kill-resume', async () => {
  const r = await ensureRemoteControlled('s', { force: true }, deps({ verdict: () => LIVE_HEADLESS }));
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'kill-resume');
});

test('kill fails → kill-failed, NEVER resumes', async () => {
  let resumed = false;
  const r = await ensureRemoteControlled('s', { force: true }, deps({
    verdict: () => LIVE_HEADLESS,
    killOwner: async () => ({ killed: false }),
    resumeDead: async () => { resumed = true; return { ok: true }; },
  }));
  assert.strictEqual(r.state, 'kill-failed');
  assert.strictEqual(resumed, false);
});

test('resume after kill but not driveable → error', async () => {
  const r = await ensureRemoteControlled('s', { force: true }, deps({
    verdict: () => LIVE_HEADLESS,
    verifyDriveable: async () => false,
  }));
  assert.strictEqual(r.state, 'error');
});

test('verdict throws → error (no throw out)', async () => {
  const r = await ensureRemoteControlled('s', {}, deps({ verdict: () => { throw new Error('boom'); } }));
  assert.strictEqual(r.state, 'error');
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/live-rc-connect-orchestrator.test.ts`
Expected: FAIL — `ensureRemoteControlled` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/terminal/live-rc-connect.ts`:

```ts
// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface EnsureResult {
  ok: boolean;
  state: 'connected' | 'already-connected' | 'needs-force' | 'gone' | 'kill-failed' | 'error';
  sid: string;
  via?: 'resume-dead' | 'inject' | 'kill-resume';
  cse?: string;
  attempts?: number;
  reason: string;
}

export interface EnsureDeps {
  now: () => number;
  verdict: (sid: string) => {
    live: boolean; inTmux: boolean; connectStrategy: string;
    tmuxTarget: string | null; pid: number | null; updatedAt: string | undefined;
  };
  isWindows: boolean;
  windowsDriveable: (pid: number) => Promise<boolean>;
  isConnected: (sid: string, title?: string) => Promise<boolean>;
  listCloud: () => Promise<CloudSession[]>;
  inject: (target: InjectTarget) => Promise<{ ok: boolean; error?: string }>;
  clearInput: (target: InjectTarget) => Promise<void>;
  pollConnection: (excludeSids: Set<string>, title?: string) => Promise<{ connected: boolean; sid?: string }>;
  killOwner: (pid: number) => Promise<{ killed: boolean }>;
  resumeDead: (sid: string) => Promise<{ ok: boolean; cse?: string; error?: string }>;
  verifyDriveable: (sid: string) => Promise<boolean>;
  bindCse: (sid: string, cse: string) => Promise<void>;
}

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export async function ensureRemoteControlled(
  sid: string,
  opts: { force?: boolean; idleThresholdMs?: number; title?: string },
  deps: EnsureDeps,
): Promise<EnsureResult> {
  const force = !!opts.force;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  let v: ReturnType<EnsureDeps['verdict']>;
  try { v = deps.verdict(sid); }
  catch (e) { return { ok: false, state: 'error', sid, reason: `verdict failed: ${(e as Error).message}` }; }

  if (v.connectStrategy === 'none') {
    return { ok: false, state: 'gone', sid, reason: 'no transcript and no live process on this host' };
  }

  // DEAD → resume-dead (existing safe path)
  if (!v.live) return finishResume(sid, deps, 'resume-dead', 0);

  // ALREADY CONNECTED? (best-effort; toggle safety)
  const alreadyConnected = await deps.isConnected(sid, opts.title).catch(() => false);

  let windowsDriveable = false;
  if (deps.isWindows && v.pid) windowsDriveable = await deps.windowsDriveable(v.pid).catch(() => false);
  const reachable = classifyReachability(v, { isWindows: deps.isWindows, windowsDriveable });
  const idle = idleMs(v.updatedAt, deps.now());
  const action = decideLiveAction({ live: v.live, alreadyConnected, reachable, idleMs: idle, idleThresholdMs, force });

  if (action === 'already-connected') {
    const ok = await deps.verifyDriveable(sid).catch(() => false);
    return ok
      ? { ok: true, state: 'already-connected', sid, reason: 'session already remote-controlled and driveable' }
      : { ok: false, state: 'error', sid, reason: 'reported connected but not driveable' };
  }

  const target: InjectTarget = reachable === 'windows'
    ? { via: 'windows', pid: v.pid ?? undefined }
    : { via: 'tmux', tmuxTarget: v.tmuxTarget ?? undefined };

  if (action === 'inject-tmux' || action === 'inject-windows') {
    let attempts = 0;
    for (let i = 0; i < 2; i++) {
      attempts++;
      const baseline = new Set((await deps.listCloud().catch(() => [] as CloudSession[])).map((s) => s.sid));
      const inj = await deps.inject(target).catch((e) => ({ ok: false, error: (e as Error).message }));
      if (!inj.ok) continue;
      const r = await deps.pollConnection(baseline, opts.title).catch(() => ({ connected: false as const }));
      if (r.connected) {
        if (r.sid) await deps.bindCse(sid, r.sid).catch(() => {});
        return { ok: true, state: 'connected', sid, via: 'inject', cse: r.sid, attempts, reason: `connected via /remote-control inject (attempt ${attempts})` };
      }
    }
    // inject exhausted → kill policy
    if (killEligibility({ idleMs: idle, idleThresholdMs, force }) === 'needs-force') {
      await deps.clearInput(target).catch(() => {});
      return { ok: false, state: 'needs-force', sid, attempts, reason: 'inject failed and session is actively busy; pass force:true to kill-and-resume' };
    }
    return killThenResume(sid, v.pid, deps, attempts);
  }

  if (action === 'needs-force') {
    return { ok: false, state: 'needs-force', sid, reason: 'live session is unreachable (headless) and actively busy; pass force:true to kill-and-resume' };
  }

  // action === 'kill'
  return killThenResume(sid, v.pid, deps, 0);
}

async function killThenResume(sid: string, pid: number | null, deps: EnsureDeps, attempts: number): Promise<EnsureResult> {
  if (!pid) return { ok: false, state: 'error', sid, attempts, reason: 'no owner pid to kill' };
  const k = await deps.killOwner(pid).catch(() => ({ killed: false }));
  if (!k.killed) return { ok: false, state: 'kill-failed', sid, attempts, reason: 'owner process did not terminate; NOT resuming over a live process' };
  // re-verify the process is actually gone before resuming (invariant)
  let stillLive = false;
  try { stillLive = deps.verdict(sid).live; } catch { stillLive = false; }
  if (stillLive) return { ok: false, state: 'kill-failed', sid, attempts, reason: 'process still live after kill; aborting resume' };
  return finishResume(sid, deps, 'kill-resume', attempts);
}

async function finishResume(sid: string, deps: EnsureDeps, via: 'resume-dead' | 'kill-resume', attempts: number): Promise<EnsureResult> {
  const r = await deps.resumeDead(sid).catch((e) => ({ ok: false, error: (e as Error).message } as { ok: boolean; cse?: string; error?: string }));
  if (r.ok && await deps.verifyDriveable(sid).catch(() => false)) {
    if (r.cse) await deps.bindCse(sid, r.cse).catch(() => {});
    return { ok: true, state: 'connected', sid, via, cse: r.cse, attempts, reason: via === 'resume-dead' ? 'resumed dead session and connected' : 'killed idle/forced session and resumed' };
  }
  return { ok: false, state: 'error', sid, attempts, reason: `${via} failed: ${r.error || 'not driveable after resume'}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/live-rc-connect-orchestrator.test.ts`
Expected: PASS (all branches).

- [ ] **Step 5: Build + commit**

```bash
./core.sh build   # confirm the module type-checks under tsc CommonJS
git add core/src/terminal/live-rc-connect.ts core/src/__tests__/live-rc-connect-orchestrator.test.ts
git commit -m "feat(live-rc): ensureRemoteControlled orchestrator (inject-first, kill-gated, no-throw)"
```

---

### Task 4: Default-deps factory + wire mission resume

**Files:**
- Create: `core/src/terminal/live-rc-connect-deps.ts` (real-I/O factory)
- Modify: `core/src/mission/mission-resume.ts` (extend `ResumeReason`, `ResumeWorkerDeps`, `resumeWorker` signature + native-live branch)
- Modify: `core/src/routes/core/mission.routes.ts` (`defaultSessionResumeDeps`: add `ensureLive`; `handleSessionResume`: read `force`)
- Modify: `core/src/mcp-server/tools/mission.ts` (add `force` to `mission_session_resume` schema + handler)
- Test: `core/src/__tests__/mission-resume-live.test.ts`

**Interfaces:**
- Consumes: `ensureRemoteControlled`, `EnsureDeps`, `EnsureResult`, primitives (Task 1-3); `sessionVerdict` (`cc-sessions.ts`), `cloudListAccount` (`ccr-cloud.ts`), `focusAndSend` (`windows-terminal.ts`), `listWindowsSessions` (`windows-cc.ts`).
- Produces: `buildEnsureDeps(args:{ resumeDead:(sid)=>Promise<{ok;cse?;error?}>; bindCse?:(sid,cse)=>Promise<void>; isConnected?:(sid,title?)=>Promise<boolean> }): EnsureDeps`; extended `ResumeReason` adds `'needs-force'|'kill-failed'`; `resumeWorker(sid, missionId, deps, opts?:{force?:boolean})`; `ResumeWorkerDeps.ensureLive?`.

- [ ] **Step 1: Write the failing test** (resumeWorker live-native mapping — pure, injected deps)

Create `core/src/__tests__/mission-resume-live.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { resumeWorker, type ResumeWorkerDeps } from '../mission/mission-resume';

function nativeDeps(over: Partial<ResumeWorkerDeps>): ResumeWorkerDeps {
  return {
    resolve: () => ({ transport: 'native', missionId: 'm1' }),
    cloudStatus: async () => ({ sid: 's', status: 'active', raw: {} }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'attach-existing', safeToCreateTmux: false, inTmux: true }),
    resumeNative: async (_m, sid) => ({ sid, boundAt: 1 }),
    ...over,
  };
}

test('live native (attach-existing) routes through ensureLive → ok', async () => {
  let forced: boolean | undefined;
  const r = await resumeWorker('s', 'm1', nativeDeps({
    ensureLive: async (_sid, o) => { forced = o.force; return { ok: true, state: 'connected', sid: 's', reason: 'x' }; },
  }), { force: true });
  assert.strictEqual(r.resumed, true);
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(forced, true);
});

test('live native needs-force maps to reason needs-force (not resumed)', async () => {
  const r = await resumeWorker('s', 'm1', nativeDeps({
    nativeVerdict: () => ({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }),
    ensureLive: async () => ({ ok: false, state: 'needs-force', sid: 's', reason: 'busy' }),
  }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'needs-force');
});

test('dead native (create-tmux) still uses resumeNative, not ensureLive', async () => {
  let usedEnsure = false;
  const r = await resumeWorker('s', 'm1', nativeDeps({
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    ensureLive: async () => { usedEnsure = true; return { ok: true, state: 'connected', sid: 's', reason: '' }; },
    resumeNative: async (_m, sid) => ({ sid, boundAt: 2 }),
  }));
  assert.strictEqual(usedEnsure, false);
  assert.strictEqual(r.reason, 'ok');
});

test('kill-failed maps to conflict (cannot resume)', async () => {
  const r = await resumeWorker('s', 'm1', nativeDeps({
    ensureLive: async () => ({ ok: false, state: 'kill-failed', sid: 's', reason: 'stuck' }),
  }));
  assert.strictEqual(r.resumed, false);
  assert.strictEqual(r.reason, 'kill-failed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/mission-resume-live.test.ts`
Expected: FAIL — `ensureLive` not on `ResumeWorkerDeps`, `resumeWorker` ignores `opts`, reason `needs-force`/`kill-failed` not produced.

- [ ] **Step 3a: Extend `mission-resume.ts`**

In `core/src/terminal/`… no — in `core/src/mission/mission-resume.ts`:

Change the `ResumeReason` union (line 7) to add the two new reasons:

```ts
export type ResumeReason = 'ok' | 'alive' | 'gone' | 'conflict' | 'status-unknown' | 'needs-force' | 'kill-failed';
```

Add `ensureLive` to `ResumeWorkerDeps` (after `resumeNative`, before the closing brace ~line 56):

```ts
  /** Inject-first / kill-gated connect for a LIVE native worker. Provided by the
   *  route layer (wires ensureRemoteControlled). Optional: when absent, resumeWorker
   *  falls back to the legacy attach/conflict verdict mapping. */
  ensureLive?: (sid: string, opts: { force?: boolean; missionId?: string }) => Promise<{ ok: boolean; state: string; sid: string; reason: string }>;
```

Replace the native section of `resumeWorker` (the block from `// native` to the final `return`) and add the `opts` param. New signature + body:

```ts
export async function resumeWorker(
  sid: string,
  missionId: string | undefined,
  deps: ResumeWorkerDeps,
  opts?: { force?: boolean },
): Promise<ResumeResult> {
  const { transport } = deps.resolve(sid);

  if (transport === 'cloud') {
    // ... UNCHANGED cloud block ...
  }

  // native
  let v: { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean };
  try {
    v = deps.nativeVerdict(sid);
  } catch {
    return { resumed: false, transport: 'native', sid, reason: 'gone' };
  }
  const action = decideNativeResume(v);
  if (action === 'gone') return { resumed: false, transport: 'native', sid, reason: 'gone' };
  if (action === 'resume') {
    // dead, transcript present, safe → claude --resume + re-bridge (preserves sid)
    const launched = await deps.resumeNative(missionId, sid);
    return { resumed: true, transport: 'native', sid: launched.sid, reason: 'ok' };
  }
  // action is 'attach' or 'conflict' → a LIVE native worker → inject-first / kill-gated ladder
  if (deps.ensureLive) {
    const e = await deps.ensureLive(sid, { force: opts?.force, missionId });
    return mapEnsureToResume(e, sid);
  }
  // fallback (no ensureLive wired): legacy verdict mapping
  return action === 'attach'
    ? { resumed: true, transport: 'native', sid, reason: 'alive' }
    : { resumed: false, transport: 'native', sid, reason: 'conflict' };
}

/** Map an ensureRemoteControlled result onto the ResumeResult contract. */
function mapEnsureToResume(e: { state: string; sid: string }, sid: string): ResumeResult {
  switch (e.state) {
    case 'connected': return { resumed: true, transport: 'native', sid: e.sid || sid, reason: 'ok' };
    case 'already-connected': return { resumed: true, transport: 'native', sid: e.sid || sid, reason: 'alive' };
    case 'needs-force': return { resumed: false, transport: 'native', sid, reason: 'needs-force' };
    case 'kill-failed': return { resumed: false, transport: 'native', sid, reason: 'kill-failed' };
    case 'gone': return { resumed: false, transport: 'native', sid, reason: 'gone' };
    default: return { resumed: false, transport: 'native', sid, reason: 'status-unknown' };
  }
}
```

(Keep the existing cloud block verbatim; only the native tail and the signature change.)

- [ ] **Step 3b: Run the resumeWorker test → PASS**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/mission-resume-live.test.ts`
Expected: PASS.

- [ ] **Step 3c: Create the real-I/O factory `live-rc-connect-deps.ts`**

Create `core/src/terminal/live-rc-connect-deps.ts`:

```ts
// Wires the real I/O for ensureRemoteControlled. Surface-specific resumeDead /
// bindCse / isConnected are passed in by each caller (mission vs ccr).
import { execFileSync } from 'child_process';
import * as os from 'os';
import {
  type EnsureDeps, type CloudSession, type InjectTarget,
  killOwner as killOwnerPrim, injectRemoteControl, clearInjectedInput, pollForCloudConnection,
} from './live-rc-connect';
import { sessionVerdict } from './cc-sessions';
import { cloudListAccount } from './ccr-cloud';

const IS_WINDOWS = process.platform === 'win32';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tmuxTargetOf(v: { tmuxSession: string | null; pane: string | null }): string | null {
  if (!v.tmuxSession) return null;
  return v.pane ? `${v.tmuxSession}:${v.pane}` : v.tmuxSession;
}

async function listCloud(): Promise<CloudSession[]> {
  try {
    const ss = await cloudListAccount(50);
    return ss.map((s) => ({ sid: s.sid, status: s.status, title: s.title }));
  } catch { return []; }
}

export function buildEnsureDeps(args: {
  resumeDead: (sid: string) => Promise<{ ok: boolean; cse?: string; error?: string }>;
  bindCse?: (sid: string, cse: string) => Promise<void>;
  isConnected?: (sid: string, title?: string) => Promise<boolean>;
}): EnsureDeps {
  const injectExec = {
    tmuxSend: (target: string, keys: string, literal: boolean, enter: boolean) => {
      const a = ['send-keys', '-t', target];
      if (literal) a.push('-l');
      a.push(keys);
      execFileSync('tmux', a, { encoding: 'utf-8', timeout: 5000 });
      if (enter) execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 });
    },
    windowsSend: async (pid: number, opts: { text?: string; keys?: string; submit?: boolean }) => {
      const { focusAndSend } = require('./windows-terminal') as typeof import('./windows-terminal');
      return focusAndSend({ pid, ...opts });
    },
  };

  return {
    now: () => Date.now(),
    verdict: (sid) => {
      const v = sessionVerdict(sid);
      return {
        live: v.live, inTmux: v.inTmux, connectStrategy: v.connectStrategy,
        tmuxTarget: tmuxTargetOf(v), pid: v.owner?.pid ?? null, updatedAt: v.owner?.updatedAt,
      };
    },
    isWindows: IS_WINDOWS,
    windowsDriveable: async (pid) => {
      try {
        const { listWindowsSessions } = require('./windows-cc') as typeof import('./windows-cc');
        const list = await listWindowsSessions();
        return list.some((s: any) => s?.win?.pid === pid && s.driveable) || list.some((s: any) => s.owner?.pid === pid && s.driveable);
      } catch { return false; }
    },
    isConnected: args.isConnected ?? (async () => false),
    listCloud,
    inject: (target: InjectTarget) => injectRemoteControl(target, injectExec),
    clearInput: (target: InjectTarget) => clearInjectedInput(target, injectExec),
    pollConnection: (excludeSids, title) =>
      pollForCloudConnection({ title, excludeSids }, listCloud, { timeoutMs: 20000, intervalMs: 1500, sleep }),
    killOwner: async (pid) => {
      const r = await killOwnerPrim(pid, { isWindows: IS_WINDOWS }, {
        isAlive: (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
        signal: (p, sig) => process.kill(p, sig),
        taskkill: (p) => { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { encoding: 'utf-8', timeout: 8000 }); },
        sleep,
      });
      return { killed: r.killed };
    },
    resumeDead: args.resumeDead,
    verifyDriveable: args.isConnected ?? (async () => true),
    bindCse: args.bindCse ?? (async () => {}),
  };
}
```

Note: `windowsDriveable`'s exact field path (`s.win.pid` vs `s.owner.pid`) must be confirmed against `listWindowsSessions()`'s return shape in `windows-cc.ts` during implementation — adjust the predicate to match. `verifyDriveable` defaults to the `isConnected` probe when provided, else optimistic `true` (the cloud-poll already proved driveability for the inject/resume paths).

- [ ] **Step 3d: Wire `defaultSessionResumeDeps` + `handleSessionResume` (mission.routes.ts)**

In `core/src/routes/core/mission.routes.ts`, refactor `defaultSessionResumeDeps()` so the native-resume closure is a local const (`resumeNativeImpl`) reused by both the `resumeNative` property and the new `ensureLive`. Lift the existing `resumeNative: async (missionId, sid) => { … }` body out of the object literal into a `const` just above `return {`:

```ts
function defaultSessionResumeDeps(): SessionResumeDeps {
  // ... existing resolve / cloudStatus / cloudWake / nativeVerdict above ...

  // The existing native resume body (claude --resume <sid> --remote-control in the
  // mission worktree, preserves sid) — unchanged, just lifted to a named const.
  const resumeNativeImpl = async (missionId: string | undefined, sid: string): Promise<{ sid: string; boundAt: number }> => {
    /* ... the existing resumeNative body, verbatim ... */
  };

  return {
    resolve: /* unchanged */,
    cloudStatus: /* unchanged */,
    cloudWake: /* unchanged */,
    nativeVerdict: /* unchanged */,
    resumeNative: resumeNativeImpl,
    ensureLive: async (sid, o) => {
      const { buildEnsureDeps } = require('../../terminal/live-rc-connect-deps') as typeof import('../../terminal/live-rc-connect-deps');
      const { ensureRemoteControlled } = require('../../terminal/live-rc-connect') as typeof import('../../terminal/live-rc-connect');
      const { getProjectSettings } = require('../../project-settings') as typeof import('../../project-settings');
      const idleMin = getProjectSettings().missionSessionIdleCloseMin ?? 30;
      const ensureDeps = buildEnsureDeps({
        // If the process already died between verdict and now, resume it the normal
        // way (same worktree, --resume sid, re-bridge). cse is unknown here → null.
        resumeDead: async (s) => {
          await resumeNativeImpl(o.missionId, s);
          return { ok: true };
        },
      });
      return ensureRemoteControlled(sid, { force: o.force, idleThresholdMs: idleMin * 60 * 1000 }, ensureDeps);
    },
    idleMin: /* unchanged */,
  };
}
```

`ensureLive` receives `missionId` from `resumeWorker` (Step 3a passes `{ force, missionId }`), so `o.missionId` is in scope for `resumeDead`. No other threading needed.

In `handleSessionResume`, read `force` from the body and pass it to `resumeWorker`:

```ts
export async function handleSessionResume(
  sid: string,
  body: { missionId?: string; force?: boolean },
  deps?: SessionResumeDeps,
  node?: string,
  leader?: LeaderAnchorDeps,
) {
  // ... existing leader-anchor preamble ...
  const d = deps ?? defaultSessionResumeDeps();
  const result = await resumeWorker(sid, body.missionId, d, { force: !!body.force });
  // ... existing response wrapping ...
}
```

And the route that calls it (the `POST /mission/session/:sid/resume` handler, ~line 1083) passes the body through (it already passes `{ missionId }` — extend to include `force`):

```ts
        const body = (req.body || {}) as { missionId?: string; force?: boolean };
        return handleSessionResume(req.params.sid, body, undefined, undefined, realLeaderAnchor());
```

- [ ] **Step 3e: Add `force` to the MCP tool (mission.ts)**

In `core/src/mcp-server/tools/mission.ts`, update the `mission_session_resume` def schema (line ~146) to add `force`, and the handler (line ~255) to forward it:

```ts
    inputSchema: obj({ sid: S, missionId: S, force: B }, ['sid']),
```
(Import/confirm a boolean schema helper `B`; if none exists, inline `{ force: { type: 'boolean' } }` in an explicit `inputSchema` object like `ccr_drive` uses.)

Handler:
```ts
  mission_session_resume: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      const body: Record<string, unknown> = {};
      if (a.missionId) body.missionId = String(a.missionId);
      if (a.force !== undefined) body.force = a.force === true || a.force === 'true';
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/resume`, body));
    } catch (e) { return err((e as Error).message); }
  },
```
(Note the `a.force === 'true'` coercion — MCP connector args may arrive as strings.) Also extend the tool `description` to mention: "Pass force:true to kill-and-resume a live, unreachable, actively-busy worker (idle workers are auto-killed)."

- [ ] **Step 4: Build, run mission tests, smoke**

```bash
cd /home/ubuntu/lm-assist && ./core.sh build
node --test --import tsx core/src/__tests__/mission-resume-live.test.ts
node --test --import tsx core/src/__tests__/mission-resume.test.ts   # existing tests still pass
```
Expected: build clean, both PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/live-rc-connect-deps.ts core/src/mission/mission-resume.ts core/src/routes/core/mission.routes.ts core/src/mcp-server/tools/mission.ts core/src/__tests__/mission-resume-live.test.ts
git commit -m "feat(live-rc): wire ensureRemoteControlled into mission resume (force param, REST+MCP)"
```

---

### Task 5: Wire general `ccr.connect`

**Files:**
- Modify: `core/src/terminal/ccr-manager.ts` (`connect()` — live case runs `ensureRemoteControlled`; accept `force`)
- Modify: `core/src/routes/core/ccr.routes.ts` (`POST /ccr/connect` reads `force`)
- Modify: `core/src/mcp-server/tools/expanded.ts` (`ccr_connect` def + `handleCcrConnect` add `force`)
- Test: `core/src/__tests__/ccr-connect-live.test.ts`

**Interfaces:**
- Consumes: `buildEnsureDeps` (Task 4), `ensureRemoteControlled` (Task 3).
- Produces: `connect({ sessionId, force? })` — on a live verdict, returns the ensure result mapped into the existing connect response shape (or throws a typed `TerminalError` for `needs-force`/`kill-failed`/`gone`).

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/ccr-connect-live.test.ts`. Because `connect()` does heavy I/O, test the **decision wiring** via an exported pure helper `mapEnsureToConnectError(state)` that maps an ensure state to `{ code, message }` or null (success). Add this helper to `ccr-manager.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mapEnsureToConnectError } from '../terminal/ccr-manager';

test('connected → no error (null)', () => {
  assert.strictEqual(mapEnsureToConnectError('connected'), null);
});
test('already-connected → no error (null)', () => {
  assert.strictEqual(mapEnsureToConnectError('already-connected'), null);
});
test('needs-force → CONFLICT with force hint', () => {
  const e = mapEnsureToConnectError('needs-force');
  assert.strictEqual(e?.code, 'CONFLICT');
  assert.match(e?.message || '', /force/i);
});
test('kill-failed → CONFLICT', () => {
  assert.strictEqual(mapEnsureToConnectError('kill-failed')?.code, 'CONFLICT');
});
test('gone → SESSION_NOT_FOUND', () => {
  assert.strictEqual(mapEnsureToConnectError('gone')?.code, 'SESSION_NOT_FOUND');
});
test('error → INTERNAL_ERROR', () => {
  assert.strictEqual(mapEnsureToConnectError('error')?.code, 'INTERNAL_ERROR');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/ccr-connect-live.test.ts`
Expected: FAIL — `mapEnsureToConnectError` not exported.

- [ ] **Step 3: Implement the mapper + wire `connect()`**

In `core/src/terminal/ccr-manager.ts`, add the exported mapper:

```ts
export function mapEnsureToConnectError(state: string): { code: string; message: string } | null {
  switch (state) {
    case 'connected':
    case 'already-connected': return null;
    case 'needs-force': return { code: 'CONFLICT', message: 'live session is busy/unreachable; pass force:true to kill-and-resume (idle sessions auto-kill)' };
    case 'kill-failed': return { code: 'CONFLICT', message: 'owner process did not terminate; not resuming over a live process' };
    case 'gone': return { code: 'SESSION_NOT_FOUND', message: 'no transcript and no live process on this host' };
    default: return { code: 'INTERNAL_ERROR', message: 'remote-control connect failed' };
  }
}
```

Update `connect()` signature and the **live** branch. Today `connect()` (line ~301) throws `CONFLICT` on `refuse`. Replace the verdict-gate so that when `v.live` is true (strategy `attach-existing` or `refuse`), it runs the ladder; dead (`create-tmux`)/`none` keep today's behavior:

```ts
export async function connect({ sessionId, force }: { sessionId: string; force?: boolean }): Promise<CcrRecord> {
  const v = sessionVerdict(sessionId);
  if (v.connectStrategy === 'none') {
    throw new TerminalError('SESSION_NOT_FOUND', v.reason, { verdict: v });
  }

  // LIVE session → inject-first / kill-gated ladder (claude native /remote-control)
  if (v.live) {
    const { buildEnsureDeps } = require('./live-rc-connect-deps') as typeof import('./live-rc-connect-deps');
    const { ensureRemoteControlled } = require('./live-rc-connect') as typeof import('./live-rc-connect');
    const deps = buildEnsureDeps({
      // resumeDead here means: process already died between verdict and now → use the
      // existing create-tmux bridge path. Build it inline to avoid recursion into connect().
      resumeDead: async (sid) => {
        const rec = await connectDeadCreateTmux(sid); // refactor of today's create-tmux block (see below)
        return { ok: !!rec.webUrl, cse: cseFromWebUrl(rec.webUrl) ?? undefined };
      },
    });
    const e = await ensureRemoteControlled(sessionId, { force }, deps);
    const errMap = mapEnsureToConnectError(e.state);
    if (errMap) throw new TerminalError(errMap.code as any, errMap.message, { ensure: e });
    // success → return a CcrRecord describing the live connection
    return await recordForLiveConnection(sessionId, e); // registers/returns a CcrRecord (see below)
  }

  // DEAD (create-tmux) — unchanged path
  return connectDeadCreateTmux(sessionId);
}
```

Refactor today's `attach-existing`/`create-tmux` body into a helper `connectDeadCreateTmux(sessionId)` that contains the existing tmux-spawn + `ccr-bridge.js` + `pollForUrl` + `saveRegistry` logic (lines ~311-361), returning the `CcrRecord`. `recordForLiveConnection(sessionId, e)` builds/saves a `CcrRecord` with `mode:'connected'`, `sessionId`, `webUrl` derived from the new cse (`e.cse` → `https://claude.ai/code/${e.cse}` form used elsewhere), `strategy:'inject'`, `ownsTmux:false`. Keep it minimal and consistent with the existing `CcrRecord` shape.

Implementer note: confirm `cseFromWebUrl`/the cse→webUrl convention in this file; reuse them. Do not change the dead path's behavior.

- [ ] **Step 3b: Run the mapper test → PASS**

Run: `cd /home/ubuntu/lm-assist && node --test --import tsx core/src/__tests__/ccr-connect-live.test.ts`
Expected: PASS.

- [ ] **Step 3c: Route + MCP `force`**

`core/src/routes/core/ccr.routes.ts` `POST /ccr/connect` handler (line ~137): read `force`:

```ts
        const body = (req.body || {}) as { sessionId?: unknown; force?: unknown };
        const sessionId = parseSessionId(body.sessionId as string | undefined);
        const data = await ccr.connect({ sessionId, force: body.force === true });
        return ok(data);
```

`core/src/mcp-server/tools/expanded.ts` `ccr_connect` def — add `force` to properties:

```ts
    properties: {
      session_id: { type: 'string', description: 'Claude Code session UUID.' },
      force: { type: 'boolean', description: 'Kill-and-resume a live, unreachable, actively-busy session (idle sessions auto-kill). Default false.' },
    },
```

`handleCcrConnect` (find it near `ccr_connect: handleCcrConnect`): forward `force` (coerce string→bool) to the `POST /ccr/connect` body. Extend the tool description: "For a LIVE session it injects /remote-control to connect in place; if the input is unreachable (headless) it kill-and-resumes only when idle or force:true."

- [ ] **Step 4: Build + tests**

```bash
cd /home/ubuntu/lm-assist && ./core.sh build
node --test --import tsx core/src/__tests__/ccr-connect-live.test.ts
node --test --import tsx core/src/__tests__/ccr-cloud.test.ts core/src/__tests__/ccr-drive.test.ts   # adjacent suites still pass
```
Expected: build clean, PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/ccr-manager.ts core/src/routes/core/ccr.routes.ts core/src/mcp-server/tools/expanded.ts core/src/__tests__/ccr-connect-live.test.ts
git commit -m "feat(live-rc): wire ensureRemoteControlled into ccr.connect (force param, REST+MCP)"
```

---

### Task 6: Controller playbook, guide, docs, version, live smoke

**Files:**
- Modify: `core/src/mission/mission-controller.ts` (`CONTROLLER_SYSTEM_PROMPT` + `CONTROLLER_PASS_DIRECTIVE` resume playbook)
- Modify: `core/src/mcp-server/tools/guide.ts` (`missions` + `ccr` topics)
- Modify: `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (version bump)
- Test: live Linux tmux smoke (manual, documented below)

**Interfaces:** none (copy + docs).

- [ ] **Step 1: Controller playbook**

In `core/src/mission/mission-controller.ts`, find the existing "RESUMING A DEAD / IDLE WORKER" block in `CONTROLLER_SYSTEM_PROMPT` and extend it (do not duplicate):

```
RESUMING / RECONNECTING A WORKER (resume-only, inject-first):
• Always prefer mission_session_resume — it reconnects the SAME session in place.
• A LIVE worker is reconnected by injecting /remote-control into its terminal (no
  restart, context preserved). You do NOT need to do anything special — the tool
  handles it.
• If the worker is unreachable (headless) AND actively busy, the tool returns
  reason:"needs-force". Only then, and only if you are sure the work is stuck,
  re-call with force:true to kill-and-resume. An IDLE unreachable worker is
  auto-killed-and-resumed (no force needed).
• reason:"kill-failed" = the process would not die; do NOT keep retrying — surface it.
• reason:"gone" = terminal; spawn a FRESH worker as a separate, explicit action.
```

Add a one-line resume-first clause to `CONTROLLER_PASS_DIRECTIVE` if not already present: "To reconnect a worker, call mission_session_resume (force:true only after a needs-force)."

- [ ] **Step 2: guide topics**

In `core/src/mcp-server/tools/guide.ts`, in the `missions` topic resume line, append: "Resume is inject-first: a live worker reconnects via /remote-control in place; pass force:true only after a needs-force (idle workers auto-kill)." In the `ccr` topic, after the `ccr_connect` SAFETY GATE line, append: "For a LIVE session ccr_connect now injects /remote-control to connect in place; a headless live session is kill-and-resumed only when idle or force:true (never silently over a running process)."

- [ ] **Step 3: Live Linux smoke test (manual)**

```bash
# 1. start a throwaway claude in a tmux (NOT remote-controlled if your host doesn't auto-enable)
mkdir -p /tmp/lrc-smoke && tmux new-session -d -s lrcsmoke -x 200 -y 50 -c /tmp/lrc-smoke 'claude'
sleep 7
# 2. find its sessionId from the statusline / ~/.claude/sessions, then:
curl -s -X POST localhost:3200/ccr/connect -H 'content-type: application/json' \
  -d '{"sessionId":"<SID>"}' | head -c 400
# Expect: success with a webUrl (inject path), OR a structured CONFLICT/needs-force — NOT a crash.
# 3. cleanup
tmux kill-session -t lrcsmoke
```
Document the observed result in the task report. (Windows `focusAndSend`/`taskkill` path is code-reviewed against `windows-terminal.ts`; optional smoke on node 107 at deploy.)

- [ ] **Step 4: Version bump + CHANGELOG**

Bump the version in all three files (keep in sync) per `CLAUDE.md` → "Publishing / Version Bumps" (next patch after the current `package.json` version). Add a CHANGELOG entry under a new version heading:

```
### Added
- Live-session remote-control connect: `ccr_connect` / `mission_session_resume` now
  reconnect a LIVE local session in place by injecting `/remote-control` (tmux on
  Linux, AttachConsole on Windows). Headless/unreachable live sessions are
  kill-and-resumed only when idle ≥ missionSessionIdleCloseMin, or with `force:true`;
  never resumed over a running process. New `force` param on both surfaces.
```

- [ ] **Step 5: Build + commit**

```bash
cd /home/ubuntu/lm-assist && ./core.sh build
git add core/src/mission/mission-controller.ts core/src/mcp-server/tools/guide.ts CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(live-rc): controller playbook + guide + docs + version bump"
```

---

## Notes for the executor

- After every task: `./core.sh build` must be clean (CommonJS tsc). The new module uses only `import`/`require` of existing files — no ESM-only deps.
- The decision logic (Tasks 1-3) is the safety core and is fully unit-tested with injected deps; the real-I/O factory (Task 4) and the `connect()` refactor (Task 5) are integration-tested live on Linux + code-reviewed for Windows.
- Do NOT remove or alter the existing dead-resume / attach / create-tmux behavior — this feature only adds the LIVE-session ladder.
- Deploy (after merge) follows the repo's standard: `npm pack` under Node 20 → direct `npm install -g <tgz>` on 117/123/107 (NOT `lm-assist upgrade --from`), then the WEB static-copy step on 123/107. Out of scope for this plan's tasks.
