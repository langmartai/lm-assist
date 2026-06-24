# Mission Native Executor (`--remote-control`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Mission Controller launches a LOCAL worktree executor with `claude --remote-control` (auto-registers a cloud `cse`), then reads it from its local transcript and drives it via the cloud relay.

**Architecture:** Harden the local launcher (wire `--remote-control` on Linux + dismiss onboarding prompts), add pure helpers (`cse_→session_`, native-binding detection, new-session discovery), extend `MissionBinding` with `ccr`, implement `startNativeExecutor` (worktree → launch → discover cse → bind), and add a native read/drive branch to the controller. Spike-validated.

**Tech Stack:** TypeScript (CommonJS), Node `node:test`, tmux, ccr-cloud, the Claude Code OAuth bridge (native `--remote-control`).

## Global Constraints

- **Spike-validated facts (do not re-derive):** `claude --remote-control` self-registers a cloud `cse_<suffix>` (status `active`, in `cloudListAccount`); drive via `cloudDrive({ sid })` where `sid = 'session_'+suffix` (convert `cse_`→`session_`); **read the LOCAL `.jsonl`** (`/sessions/:uuid/conversation`) — cloud teleport is empty for RC sessions; a fresh launch shows a **"fullscreen renderer?"** onboarding prompt that must be dismissed (`"2"`+Enter) or the REPL hangs; ready REPL footer shows `/rc active`.
- Tests = Node `node:test` in `core/src/__tests__/*.test.ts`; run `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<name>.test.js`. Build with `./core.sh build`.
- Core is CommonJS. Do NOT static-import the ESM Agent SDK. Don't touch the chokidar pin.
- **Quota-aware:** the host's Claude Code OAuth is near its weekly limit — the live verification (Task 7) launches exactly ONE RC session, drives ONE turn, then cleans up. No loops.
- **Never `--resume`** an existing transcript here — we always LAUNCH a fresh session (new UUID), so no append-only-jsonl corruption risk.
- Branch: `feat/mission-controller`. Commit after each task. `git add` only the task's files (the tree has unrelated uncommitted files — no `git add -A`).

---

## File Structure

| File | Responsibility |
|---|---|
| `core/src/terminal/types.ts` (mod) | `CCLaunchInput.remoteControl?: boolean` |
| `core/src/terminal/validate.ts` (mod) | `parseCCLaunch` accepts `remoteControl` |
| `core/src/terminal/cc.ts` (mod) | `buildLaunchCmd` appends `--remote-control`; `launch` dismisses onboarding prompts |
| `core/src/terminal/tmux-backend.ts` (mod) | `tmuxCcController.launch` threads `remoteControl` |
| `core/src/terminal/onboarding-prompts.ts` (new) | pure `decideOnboardingKeys(screen)` — what to send to clear a known startup prompt |
| `core/src/mission/mission-native.ts` (new) | pure helpers: `cseToSessionSid`, `isNativeBinding`, `pickNewSession` |
| `core/src/mission/mission-model.ts` (mod) | `MissionBinding.ccr` field |
| `core/src/mission/mission-controller.ts` (mod) | `startNativeExecutor` wiring + native read/drive branch; replace the `throw` |

---

### Task 1: Launch flag — `--remote-control` through the Linux launcher

**Files:** Modify `core/src/terminal/types.ts`, `core/src/terminal/validate.ts`, `core/src/terminal/cc.ts`, `core/src/terminal/tmux-backend.ts`. Test: `core/src/__tests__/launch-remote-control.test.ts`.

**Interfaces:**
- Produces: `CCLaunchInput.remoteControl?: boolean`; `buildLaunchCmd` emits `--remote-control` when set.

- [ ] **Step 1: Read the current shape.** `grep -n "buildLaunchCmd\|skipPermissions\|extraFlags" core/src/terminal/cc.ts core/src/terminal/types.ts core/src/terminal/validate.ts core/src/terminal/tmux-backend.ts` — confirm where `skipPermissions` is threaded (mirror it for `remoteControl`). Note: `buildLaunchCmd` may be private — to unit-test it, EITHER export it, OR add a tiny exported pure `remoteControlFlags(remoteControl?: boolean): string[]` returning `remoteControl ? ['--remote-control'] : []` and call it inside `buildLaunchCmd`.

- [ ] **Step 2: Write the failing test** (`launch-remote-control.test.ts`):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { remoteControlFlags } from '../terminal/cc';
test('remoteControlFlags emits the flag', () => {
  assert.deepStrictEqual(remoteControlFlags(true), ['--remote-control']);
  assert.deepStrictEqual(remoteControlFlags(false), []);
  assert.deepStrictEqual(remoteControlFlags(undefined), []);
});
```

- [ ] **Step 3: Run → fail** (`cd core && npm run build:test 2>&1 | tail -5 && node --test --test-reporter=spec dist-test/__tests__/launch-remote-control.test.js`). Expected: `remoteControlFlags` not exported.

- [ ] **Step 4: Implement.** In `cc.ts`: add `export function remoteControlFlags(rc?: boolean): string[] { return rc ? ['--remote-control'] : []; }` and splice `...remoteControlFlags(opts.remoteControl)` into the `buildLaunchCmd` flags array (after `skipPermissions`). Add `remoteControl?: boolean` to `CCLaunchInput` (`types.ts`). In `parseCCLaunch` (`validate.ts`), add `remoteControl: b.remoteControl === true` (mirror the bool fields). In `tmuxCcController.launch` (`tmux-backend.ts`), pass `remoteControl: opts.remoteControl` into the `cc.launch` opts. (`CcLaunchOpts.remoteControl` already exists on the controller type.)

- [ ] **Step 5: Run → pass.** Same command → PASS. Then `./core.sh build 2>&1 | tail -3` → exit 0.

- [ ] **Step 6: Commit** (`git add core/src/terminal/types.ts core/src/terminal/validate.ts core/src/terminal/cc.ts core/src/terminal/tmux-backend.ts core/src/__tests__/launch-remote-control.test.ts`).

---

### Task 2: Onboarding-prompt dismissal in the launcher

**Files:** Create `core/src/terminal/onboarding-prompts.ts`; modify `core/src/terminal/cc.ts` (`launch` wait loop). Test: `core/src/__tests__/onboarding-prompts.test.ts`.

**Interfaces:**
- Produces: `decideOnboardingKeys(screen: string): { keys: string; enter: boolean } | null` — pure; given a captured tmux screen, returns the keystrokes to clear a known startup prompt, or `null` if none.

- [ ] **Step 1: Write the failing test** (`onboarding-prompts.test.ts`):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { decideOnboardingKeys } from '../terminal/onboarding-prompts';
test('dismisses the fullscreen renderer prompt with "2"', () => {
  const s = 'Try the new fullscreen renderer?\n  1. Yes, try it\n  2. Not now\n  Enter to confirm';
  assert.deepStrictEqual(decideOnboardingKeys(s), { keys: '2', enter: true });
});
test('returns null for a normal idle screen', () => {
  assert.strictEqual(decideOnboardingKeys('some normal repl  ctx:0%  /rc active'), null);
});
```

- [ ] **Step 2: Run → fail.** Expected: module not found.

- [ ] **Step 3: Implement** `onboarding-prompts.ts`:
```ts
/** Decide keystrokes to clear a known Claude Code startup onboarding prompt. Pure. */
export function decideOnboardingKeys(screen: string): { keys: string; enter: boolean } | null {
  const s = screen || '';
  if (/fullscreen renderer\?/i.test(s) && /Not now/i.test(s)) return { keys: '2', enter: true }; // decline the renderer
  return null;
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Wire into `cc.launch`.** In `cc.ts` `launch`, inside the loop that waits for `readyPattern`/idle (near the existing `autoAcceptTrust` handling): each poll, capture the pane (`tmux capture-pane -p`), call `decideOnboardingKeys(screen)`, and if non-null `sendKeysUnlocked(session, { keys, enter })` then continue waiting. Keep the existing trust-prompt handling. Do NOT change the function signature. (No new unit test for the tmux wiring — it's covered by the live verification in Task 7; the pure decision is unit-tested above.)

- [ ] **Step 6:** `./core.sh build 2>&1 | tail -3` → exit 0. **Commit** (`onboarding-prompts.ts`, `cc.ts`, the test).

---

### Task 3: Pure mission-native helpers

**Files:** Create `core/src/mission/mission-native.ts`. Test: `core/src/__tests__/mission-native.test.ts`.

**Interfaces:**
- Produces: `cseToSessionSid(id: string): string`; `isNativeBinding(b: MissionBinding | null): boolean`; `pickNewSession(baseline: string[], current: Array<{sid:string;status?:string}>): {sid:string} | null`.

- [ ] **Step 1: Write the failing test:**
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { cseToSessionSid, isNativeBinding, pickNewSession } from '../mission/mission-native';
test('cseToSessionSid converts cse_ to session_', () => {
  assert.strictEqual(cseToSessionSid('cse_01ABC'), 'session_01ABC');
  assert.strictEqual(cseToSessionSid('session_01ABC'), 'session_01ABC');
});
test('isNativeBinding true only when ccr present', () => {
  assert.strictEqual(isNativeBinding({ sessionId: 'uuid', node: 'n', kind: 'worker', ccr: { cse: 'cse_x', sid: 'session_x' } } as any), true);
  assert.strictEqual(isNativeBinding({ sessionId: 'session_x', node: 'n', kind: 'worker' } as any), false);
  assert.strictEqual(isNativeBinding(null), false);
});
test('pickNewSession returns the session not in baseline (prefer active)', () => {
  const base = ['cse_a', 'cse_b'];
  assert.deepStrictEqual(pickNewSession(base, [{ sid: 'cse_a' }, { sid: 'cse_c', status: 'active' }]), { sid: 'cse_c' });
  assert.strictEqual(pickNewSession(base, [{ sid: 'cse_a' }, { sid: 'cse_b' }]), null);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `mission-native.ts`:
```ts
import type { MissionBinding } from './mission-model';
export function cseToSessionSid(id: string): string { return (id || '').replace(/^cse_/, 'session_'); }
export function isNativeBinding(b: MissionBinding | null): boolean { return !!b && !!b.ccr; }
export function pickNewSession(baseline: string[], current: Array<{ sid: string; status?: string }>): { sid: string } | null {
  const base = new Set(baseline);
  const fresh = current.filter((s) => !base.has(s.sid));
  const active = fresh.find((s) => (s.status || '').toLowerCase() === 'active');
  const hit = active || fresh[0];
  return hit ? { sid: hit.sid } : null;
}
```

- [ ] **Step 4: Run → pass.** **Commit.**

---

### Task 4: `MissionBinding.ccr` field

**Files:** Modify `core/src/mission/mission-model.ts`. Test: `core/src/__tests__/mission-binding-ccr.test.ts`.

**Interfaces:**
- Produces: `MissionBinding.ccr?: { cse: string; sid: string; webUrl?: string | null; tmuxSession?: string }`.

- [ ] **Step 1: Write the failing test:**
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { MissionBinding } from '../mission/mission-model';
test('MissionBinding carries optional ccr', () => {
  const b: MissionBinding = { sessionId: 'uuid', node: 'n', kind: 'worker', ccr: { cse: 'cse_x', sid: 'session_x', webUrl: 'https://claude.ai/code/session_x' } };
  assert.strictEqual(b.ccr?.sid, 'session_x');
});
```

- [ ] **Step 2: Run → fail** (compile error: `ccr` not on `MissionBinding`).

- [ ] **Step 3: Implement.** Add to the `MissionBinding` interface:
```ts
  ccr?: { cse: string; sid: string; webUrl?: string | null; tmuxSession?: string };
```

- [ ] **Step 4: Run → pass.** **Commit.**

---

### Task 5: `startNativeExecutor` — worktree → launch → discover → bind

**Files:** Modify `core/src/mission/mission-controller.ts`. Test: `core/src/__tests__/mission-native-start.test.ts`.

**Interfaces:**
- Consumes: `tmuxCcController.launch` (`../terminal/tmux-backend`), `cloudListAccount` (`../terminal/ccr-cloud`), `gitCommand` (`../checkpoint/git-utils`), `pickNewSession`/`cseToSessionSid` (Task 3).
- Produces: `startNativeExecutor(m, decision, deps): Promise<MissionBinding>` where `deps = { launch, listAccount, ensureWorktree, drive }` (all injectable for tests).

- [ ] **Step 1: Write the failing test** (inject fakes; no real tmux/cloud):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { startNativeExecutor } from '../mission/mission-controller';
const mission = { id: 'mission_x', title: 'T', objective: 'do it', env: { isolation: 'worktree', repo: 'r', host: 'h', resources: [] }, binding: null } as any;
test('startNativeExecutor launches, discovers the cse, returns a native binding', async () => {
  const deps = {
    ensureWorktree: async () => '/wt/mission_x',
    launch: async () => ({ sessionId: 'uuid-123', tmuxSession: 'lmcc-1' }),
    listAccount: async () => [{ sid: 'cse_NEW', status: 'active' }],
    baseline: ['cse_OLD'],
    drive: async () => {},
  };
  const b = await startNativeExecutor(mission, { go: true, env: 'worktree', host: 'h', repo: 'r', branch: 'mission/mission_x' }, deps);
  assert.strictEqual(b.sessionId, 'uuid-123');
  assert.strictEqual(b.kind, 'worker');
  assert.strictEqual(b.ccr?.cse, 'cse_NEW');
  assert.strictEqual(b.ccr?.sid, 'session_NEW');
});
test('no new cse discovered -> binding without ccr (local-only fallback)', async () => {
  const deps = { ensureWorktree: async () => '/wt', launch: async () => ({ sessionId: 'uuid-9', tmuxSession: 't' }), listAccount: async () => [{ sid: 'cse_OLD' }], baseline: ['cse_OLD'], drive: async () => {} };
  const b = await startNativeExecutor(mission, { go: true, env: 'worktree', host: 'h', repo: 'r', branch: 'b' }, deps);
  assert.strictEqual(b.sessionId, 'uuid-9');
  assert.strictEqual(b.ccr, undefined);
});
```

- [ ] **Step 2: Run → fail** (`startNativeExecutor` not exported).

- [ ] **Step 3: Implement** `startNativeExecutor` (exported, deps-injected so it's testable; the real wiring assembles the deps):
```ts
export interface NativeStartDeps {
  ensureWorktree: (repo: string, dir: string, branch: string) => Promise<string>;
  launch: (cwd: string) => Promise<{ sessionId: string | null; tmuxSession: string }>;
  listAccount: () => Promise<Array<{ sid: string; status?: string }>>;
  baseline: string[];
  drive: (sid: string, text: string) => Promise<void>;
}
export async function startNativeExecutor(m: Mission, decision: any, deps: NativeStartDeps): Promise<MissionBinding> {
  const branch = decision.branch || `mission/${m.id}`;
  const dir = decision.env === 'shared' ? (decision.repo || '.') : `.claude/worktrees/mission-${m.id}`;
  const cwd = decision.env === 'shared' ? (decision.repo || '.') : await deps.ensureWorktree(decision.repo, dir, branch);
  const launched = await deps.launch(cwd);
  const uuid = launched.sessionId;
  if (!uuid) throw new Error('native launch did not resolve a session id');
  const cur = await deps.listAccount().catch(() => []);
  const hit = pickNewSession(deps.baseline, cur);
  const kind = m.binding?.kind === 'orchestrator' ? 'orchestrator' : 'worker';
  const binding: MissionBinding = { sessionId: uuid, node: decision.host || 'local', kind, boundAt: Date.now() };
  if (hit) {
    const sid = cseToSessionSid(hit.sid);
    binding.ccr = { cse: hit.sid, sid, webUrl: `https://claude.ai/code/${sid}`, tmuxSession: launched.tmuxSession };
    await deps.drive(sid, `Mission: ${m.title}\n\nObjective:\n${m.objective}`).catch(() => {});
  }
  return binding;
}
```
(Import `pickNewSession`, `cseToSessionSid` from `./mission-native`.)

- [ ] **Step 4: Run → pass.** **Commit.**

---

### Task 6: Native read/drive branch + replace the `throw` + UI handle

**Files:** Modify `core/src/mission/mission-controller.ts` (the `startCloudExecutor` throw → native branch; `readCloudExecutor`/drive deps gain the native branch via `isNativeBinding`). Test: `core/src/__tests__/mission-native-readdrive.test.ts`.

**Interfaces:**
- Consumes: `isNativeBinding` (Task 3), `startNativeExecutor` (Task 5); `cloudDrive` (`../terminal/ccr-cloud`); the conversation read (`GET /sessions/:id/conversation` via the control API) — confirm the in-process call (`api.sessions.getConversation` / the session-cache) by grep.
- Produces: `readNativeExecutor(m, deps)` + the drive-branch helper; the assembled deps for `registerMissionController` now route by binding shape.

- [ ] **Step 1: Write the failing test** (pure branch selection + readNativeExecutor over a stubbed conversation):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { readNativeExecutor } from '../mission/mission-controller';
test('readNativeExecutor builds newOutput from the local conversation', async () => {
  const m = { binding: { sessionId: 'uuid', node: 'n', kind: 'worker', ccr: { cse: 'cse_x', sid: 'session_x' } }, control: { lastOutputCursor: 1 } } as any;
  const deps = { verdict: () => ({ driveable: true }), readConversation: async () => ({ messages: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }) };
  const st = await readNativeExecutor(m, deps);
  assert.strictEqual(st.alive, true);
  assert.strictEqual(st.newOutput?.messages.length, 2); // slice from cursor 1
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `readNativeExecutor(m, deps)` (deps-injected): liveness via `deps.verdict(uuid).driveable`; read via `deps.readConversation(uuid)` → reuse `computeNewOutput(messages, m.control.lastOutputCursor||0)`; return `{ alive, serverStalled:false, gate:null, newOutput, idle: !newOutput }`. Then:
  - In `startCloudExecutor` (rename concept to `startExecutor` or add the branch): replace the `throw` for `worktree`/`shared` with `return startNativeExecutor(m, decision, <real deps>)` where the real deps wire `ensureWorktree` (= `gitCommand(['worktree','add', dir, '-b', branch], repoRoot)` guarded for "already exists"), `launch` (= `tmuxCcController.launch({ cwd, remoteControl:true, skipPermissions:true, autoTrust:true })`), `listAccount` (= `cloudListAccount`), `baseline` (snapshot `cloudListAccount` sids just before launch), `drive` (= `cloudDrive`).
  - In the registered handler's `readExecutor` dep: `isNativeBinding(m.binding) ? readNativeExecutor(m, realNativeReadDeps) : readCloudExecutor(m)`.
  - In `driveExecutor`: `isNativeBinding(m.binding) ? cloudDrive({ sid: m.binding.ccr.sid, text }) : <cloud drive>`.

- [ ] **Step 4: Run → pass** (the unit test for `readNativeExecutor`); `./core.sh build 2>&1 | tail -3` → exit 0 (full build proves the wiring type-checks). **Commit.**

---

### Task 7: Live verification + UI accessibility + full build

**Files:** Possibly a tiny `web/src/components/missions/MissionsPage.tsx` tweak so a native binding's `ccr.sid` feeds the existing `/^session_/` Connect branch (if not already — the session list comes from `/mission/:id/sessions`, so confirm `handleSessions` returns `binding.ccr.sid` as the primary sid for native missions). Test: live.

- [ ] **Step 1:** If a native mission's primary connectable id should be `binding.ccr.sid` (the cloud-reachable form), update `handleSessions` (`mission.routes.ts`) so the primary session's `sid` = `binding.ccr?.sid || binding.sessionId`. (So the UI Connect — which mounts `CcrCloudView` on `session_…` — works for native executors via their RC `cse`.) Add/extend the `mission-sessions` test for a binding with `ccr`.
- [ ] **Step 2: Full build:** `./core.sh build 2>&1 | tail -5` (exit 0) and `cd core && npm run build:test && node --test --test-reporter=spec 'dist-test/__tests__/*.test.js' 2>&1 | tail -8` (all pass).
- [ ] **Step 3: ONE live e2e (quota-aware), driven by the controller path:** a small node script (LM_ASSIST_DATA_DIR isolated) that: creates a worktree mission, calls the real `startNativeExecutor` deps (or runs a controller tick with native deps) → confirm a local session launches with `/rc active`, a `cse` registers, the objective is delivered, and the local transcript shows the executor responding. Then STOP (cloudStop the cse + `git worktree remove` + kill tmux). Capture the output. **Exactly one session, one drive — respect the weekly limit.**
- [ ] **Step 4: Commit** any UI/route tweak + record the live-verification result in the SDD ledger.

---

## Self-Review notes
- Spec coverage: launch flag (T1), prompt dismissal (T2), pure helpers (T3), binding.ccr (T4), native start (T5), read/drive branch + throw-replacement (T6), UI handle + live verify (T7). ✅
- The integration-heavy steps (cc.launch tmux wiring, the controller's real native deps) are verified by the full build + the Task 7 live e2e, with the pure sub-logic unit-tested (decideOnboardingKeys, pickNewSession, cseToSessionSid, isNativeBinding, startNativeExecutor orchestration, readNativeExecutor).
- Confirm-before-writing: the exact `buildLaunchCmd` privacy (T1 Step 1), the in-process conversation-read call (T6 Step 1), and whether `handleSessions` already prefers `ccr.sid` (T7 Step 1).

## Execution
Use superpowers:subagent-driven-development.
