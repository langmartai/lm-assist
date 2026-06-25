# Live-Session Remote-Control Connect — Design Spec

**Date:** 2026-06-26
**Branch:** `feat/live-rc-connect`
**Status:** approved (design signed off in chat 2026-06-26)

## Goal

When a caller asks to connect/resume a **live** local Claude Code session to CCR
(claude.ai Remote Control), prefer converting it **in place** by injecting the
`/remote-control` slash command into its terminal; only **kill-then-resume** when
its input is unreachable (headless) or the inject fails — and only kill under a
gated policy (idle → auto, actively-busy → requires `force`). Never resume over a
still-live process. Every external action is wrapped, bounded by a timeout, and
returns a structured outcome — it never throws past the orchestrator.

## Background — what already exists (verified)

- **`/remote-control` is a real in-session slash command** (empirically confirmed
  via the REPL slash autocomplete). It is a **TOGGLE**: off → connects, on →
  `Disconnect Remote Control`. Injecting it blindly into an already-connected
  session would *disconnect* it. (There is also `/remote-env` — unrelated.)
- **`sessionVerdict(sid)`** (`core/src/terminal/cc-sessions.ts`) → `{ live, owner,
  inTmux, tmuxSession, pane, connectStrategy, safeToCreateTmux, jsonl }`.
  `owner: { pid, updatedAt, status, kind, entrypoint, version, cwd }` from
  `~/.claude/sessions/<pid>.json`. `connectStrategy`: `create-tmux` (not live —
  safe `claude --resume`), `attach-existing` (live in tmux), `refuse` (live, NOT
  in tmux → today throws CONFLICT), `none` (no transcript).
- **Linux inject:** tmux `send-keys` via `core/src/terminal/cc.ts`
  (`sendKeysUnlocked`) / `tmux-backend.ts`. Target `tmuxSession` + `pane` from the
  verdict.
- **Windows inject:** `focusAndSend({ pid, text, submit })` in
  `core/src/terminal/windows-terminal.ts` — focus-free `AttachConsole(pid)` +
  `WriteConsoleInput`. Driveability per pid via `listWindowsSessions()` /
  `windows-cc.ts` (`driveable` flag — false for cross-Session-0/1 and non-hosted
  consoles; this IS the "headless/unreachable" signal on Windows).
- **Cloud observation:** `cloudListAccount(limit)` → `Array<{ sid, status, title }>`
  and `cloudStatus(sid)` → `{ sid, status, connectionStatus, raw }`
  (`core/src/terminal/ccr-cloud.ts`). A session that turns on native RC appears as
  a live cloud code-session.
- **Existing resume backend:** `resumeWorker` + pure `decideCloudResume` /
  `decideNativeResume` (`core/src/mission/mission-resume.ts`); the dead-native
  path `claude --resume <sid> --remote-control` preserves the sessionId
  (`mission.routes.ts handleSessionResume` / `defaultSessionResumeDeps`).
- **General connect:** `ccr.connect({ sessionId })` (`core/src/terminal/ccr-manager.ts`)
  + `POST /ccr/connect` — today throws `CONFLICT` on a live non-tmux session.

## Global Constraints

- **Resume-only over dead processes.** A `claude --resume` MUST run only when no
  live owner pid holds the transcript. If a kill is attempted and the process does
  not die, ABORT — never resume on top of a live process (double-write corrupts
  the append-only `.jsonl`).
- **No-throw orchestration.** Every I/O primitive (tmux exec, Windows PowerShell,
  `process.kill`, cloud `fetch`) is wrapped in try/catch, carries an explicit
  timeout, and returns a structured `{ ok, … , error? }` value. The orchestrator
  returns a discriminated-union result and never rejects; callers always get a
  well-formed verdict with a `reason`.
- **Toggle safety.** Never inject `/remote-control` into a session confirmed
  already-connected. When prior RC state is uncertain, verify by **outcome** (cloud
  session appears/active) with a self-correcting second attempt — do not rely on a
  fragile local-state guess.
- **No junk left behind.** If we inject and then decide NOT to kill (e.g.
  `needs-force`), clear the injected input (send `Escape` / `Ctrl-U`) so the
  user's prompt is not left with stray `/remote-control` text.
- **Kill is gated.** Auto-kill only when idle ≥ threshold
  (`missionSessionIdleCloseMin`, default 30 min, from project-settings). An
  actively-busy (not idle) unreachable session is killed only with `force: true`;
  otherwise return `needs-force` without side effects.
- **Leader-anchored writes.** The mission resume surface stays leader-anchored
  (resume is a write).
- Bare `{ success, data }` mission routes via `ok()`/`fail()`; `ccr` routes via
  `envelope()`/`TerminalError`. New MCP tools/params need a `TOOL_SCOPES` entry or
  Core crashes on first `/mcp` call.

## Architecture

A new backend module **`core/src/terminal/live-rc-connect.ts`** holds the pure
decision functions and the `ensureRemoteControlled` orchestrator (all I/O via
injected deps). Two existing entry points call it for their "live session" case:
`ccr.connect()` (general) and the mission resume native branch (`resumeWorker`).

### Decision ladder (live session `sid`)

| State | Action |
|---|---|
| **dead** (no live owner) | `resumeDead` → `claude --resume <sid>` + bridge (existing) |
| **already-connected** (live cloud session for `sid`, active) | return `already-connected`; no inject |
| **live, reachable input** (Linux `inTmux`; Windows `driveable`) | **inject `/remote-control`**, verify by cloud outcome; on fail → kill policy |
| **live, unreachable** (Linux non-tmux `refuse`; Windows `!driveable`) | **kill policy**: idle ≥ threshold or `force` → kill → `resumeDead`; else `needs-force` |

### Pure decision functions (Task 1)

```ts
export type Reachability = 'tmux' | 'windows' | 'none';
export type LiveAction =
  | 'resume-dead' | 'already-connected'
  | 'inject-tmux' | 'inject-windows'
  | 'kill' | 'needs-force';

export function classifyReachability(v: {
  live: boolean; inTmux: boolean; connectStrategy: string;
}, platform: { isWindows: boolean; windowsDriveable?: boolean }): Reachability;
// not live → 'none' (caller handles resume-dead before this);
// Windows → windowsDriveable ? 'windows' : 'none';
// Linux   → inTmux ? 'tmux' : 'none'.

export function idleMs(updatedAt: string | undefined, now: number): number;
// now - Date.parse(updatedAt); NaN/missing → 0 (treat as just-active = NOT idle).

export function killEligibility(i: {
  idleMs: number; idleThresholdMs: number; force: boolean;
}): 'kill' | 'needs-force';
// force || idleMs >= threshold → 'kill'; else 'needs-force'.

export function decideLiveAction(i: {
  live: boolean; alreadyConnected: boolean; reachable: Reachability;
  idleMs: number; idleThresholdMs: number; force: boolean;
}): LiveAction;
// !live → 'resume-dead'; alreadyConnected → 'already-connected';
// reachable 'tmux' → 'inject-tmux'; 'windows' → 'inject-windows';
// reachable 'none' → killEligibility(...) === 'kill' ? 'kill' : 'needs-force'.
```

### Safety primitives (Task 2) — injected `exec`/`list`, never throw

```ts
killOwner(pid, opts, exec): Promise<{ killed: boolean; wasAlive: boolean; method: 'sigterm'|'sigkill'|'taskkill'|'none' }>
// Linux: SIGTERM → poll isProcessAlive up to graceMs (default 5000) → SIGKILL → re-poll.
// Windows: taskkill /PID <pid> /T /F. Returns killed=false if still alive (caller ABORTS).

injectRemoteControl(target, via, exec): Promise<{ ok: boolean; via: 'tmux'|'windows'; error?: string }>
// tmux: send-keys -l '/remote-control' then Enter to tmuxSession[:pane].
// windows: focusAndSend({ pid, text: '/remote-control', submit: true }).

clearInjectedInput(target, via, exec): Promise<void>  // Escape + Ctrl-U; best-effort.

pollForCloudConnection(matchTitle, baseline, list, opts): Promise<{ connected: boolean; sid?: string }>
// poll list() (cloudListAccount) up to timeoutMs (default 20000), intervalMs (default 1500);
// connected when an ACTIVE session matching title (not in the dead/terminal set) is present.
// Network/throw inside a poll iteration is swallowed and retried until timeout.
```

### Orchestrator (Task 3)

```ts
export interface EnsureResult {
  ok: boolean;
  state: 'connected' | 'already-connected' | 'needs-force' | 'gone' | 'kill-failed' | 'error';
  sid: string;
  via?: 'resume-dead' | 'inject' | 'kill-resume';
  cse?: string;
  attempts?: number;
  reason: string;
}

ensureRemoteControlled(sid, opts: { force?: boolean; idleThresholdMs?: number; title?: string }, deps): Promise<EnsureResult>
```

Flow (every step guarded):
1. `verdict = deps.verdict(sid)`; `connectStrategy==='none'` → `{ ok:false, state:'gone' }`.
2. `!live` → `deps.resumeDead(sid)` → verify driveable → `connected` / `error`.
3. `alreadyConnected = await deps.isConnected(sid, title)` (best-effort; cloud
   active match). True → verify driveable → `already-connected`.
4. `reach = classifyReachability(...)`, `idle = idleMs(owner.updatedAt, now)`,
   `action = decideLiveAction(...)`.
5. **inject path** (`inject-tmux|inject-windows`): up to **2 attempts** —
   `baseline = await deps.listCloud()`; `inject`; `pollForCloudConnection`. Connected
   → bind cse, `connected`. Not connected after attempt 1 → re-inject (self-corrects
   a stale-RC toggle: off→on). Both attempts fail → fall to kill policy
   (`killEligibility`): `needs-force` → `clearInjectedInput` + return `needs-force`;
   `kill` → step 6.
6. **kill path** (`kill`, or inject-exhausted+eligible): `killOwner`. `killed:false`
   → `{ ok:false, state:'kill-failed' }` (NO resume). `killed:true` → re-verify dead
   via `deps.verdict` → `deps.resumeDead(sid)` → verify driveable → `connected` (via
   `kill-resume`).
7. **needs-force** (unreachable, not eligible): `{ ok:false, state:'needs-force' }`,
   no side effects.

Post-connect verification (the "verify after connect" requirement): a `connected`
result is only returned after a positive driveable/active confirmation
(`pollForCloudConnection` active match or `deps.verifyDriveable`); otherwise
`state:'error'` with the reason — never a false positive.

## Wiring

- **Mission resume (Task 4):** `resumeWorker` native branch — replace the
  `decideNativeResume → 'conflict'`/`'resume'` handling so a **live** native worker
  routes through `ensureRemoteControlled` (inject-first / kill-gated); a **dead** one
  keeps the existing `resumeNative` (`claude --resume`). Thread `force` through
  `ResumeWorkerDeps` → `SessionResumeDeps` → `POST /mission/session/:sid/resume`
  body `{ missionId?, force? }` (leader-anchored) → MCP `mission_session_resume`
  gains optional `force`. Idle threshold from `missionSessionIdleCloseMin`.
- **General connect (Task 5):** `ccr.connect({ sessionId, force? })` — when the
  verdict is **live**, run `ensureRemoteControlled` instead of throwing `CONFLICT`;
  dead/attach/create-tmux keep today's behavior. `POST /ccr/connect` body gains
  `force?`; MCP `ccr_connect` gains optional `force` (TOOL_SCOPES already covers
  `ccr_connect`; a new param needs no new scope, but confirm).
- **Controller + docs (Task 6):** `CONTROLLER_SYSTEM_PROMPT` /
  `CONTROLLER_PASS_DIRECTIVE` resume playbook → "inject-first, force only when you
  must"; `guide("missions")` / `guide("ccr")` note the inject-or-kill ladder + the
  `force` flag; CHANGELOG + version bump.

## Testing strategy

- **Pure functions (Task 1):** exhaustive `node:test` in
  `core/src/__tests__/` — every `LiveAction` branch; toggle-safety
  (`alreadyConnected` ⇒ never inject); idle/force gating boundaries
  (idle==threshold, idle<threshold+force, missing updatedAt).
- **Primitives (Task 2):** injected `exec`/`list` fakes — SIGTERM-then-SIGKILL
  escalation, kill-fails path, inject tmux vs windows dispatch, poll timeout vs
  success vs mid-poll throw (swallowed).
- **Orchestrator (Task 3):** fully injected deps — dead→resume, already-connected,
  inject success (1 attempt), stale-RC toggle (attempt-1 disconnects → attempt-2
  reconnects), inject-fail→idle→kill→resume, inject-fail→busy→needs-force
  (+clears input), unreachable→idle→kill, unreachable→busy→needs-force,
  kill-fails→abort (no resume), resume-after-kill verify-fail→error.
- **Live (Linux):** real tmux smoke — launch a throwaway `claude`, drive the
  inject path, confirm driveable, clean up. Windows path is code-reviewed against
  the existing `focusAndSend`/`taskkill` helpers and best-effort smoke-tested on
  node 107 during deploy.

## Out of scope

- A cloud-worker (`session_`) analog of inject (cloud workers have no local TTY;
  their resume stays the existing `cloudWake`/`decideCloudResume`).
- Auto-discovery/bulk connect of every live session.
- Changing the existing ccr-bridge screen-scrape transport (this feature uses
  claude's **native** RC, a distinct, cleaner channel).
