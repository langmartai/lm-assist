# Resume a mission's worker session in place

**Status:** Approved design (2026-06-26)

## Goal

Make a mission's bound worker (executor) session truly **resumable** — reviving the **same**
session (preserving its transcript/context) for both transports — exposed via three surfaces:
the web UI reopen, the autonomous Mission Controller, and an MCP tool. **Resume-only:** if the
session is terminal/unrecoverable, report `gone`; spawning a fresh worker stays a separate explicit
action (the controller's existing spawn path; a UI "Start fresh worker" button).

## Background — what exists today (the gap)

A mission binds to one executor session (`binding.{sessionId,node,kind,ccr?}`,
`core/src/routes/core/mission.routes.ts` `handlePatch`). Transport is by sid prefix:
`session_…`/`cse_…` → **cloud**, else **native** (`core/src/mission/mission-session-resolver.ts`).

- **Cloud** worker: spawned by `cloudStart` (`core/src/terminal/ccr-cloud.ts`), driven over HTTP.
- **Native** worker: `startNativeExecutor` (`core/src/mission/mission-controller.ts`) does
  `git worktree add .claude/worktrees/mission-<id>` then `tmuxCcController.launch({remoteControl:true})`
  (a fresh `claude --remote-control`), captures the new bridge `cse`. Binding stores the native
  UUID `sessionId` AND `ccr.{cse,sid,webUrl,tmuxSession}`.

Reopen today (`POST /mission/session/:sid/resume` → `handleSessionResume`):
- **cloud** → `cloudStatus` only; reports `resumed:true` (alive) or `gone`. **Never re-drives/wakes.**
- **native** → `relaunch` → `startNativeExecutor` = a **brand-new** `claude` session (no `--resume`).
  **NEW UUID + NEW cse; the old transcript/context is lost.** It's *replaced*, not *resumed*.

The real resume primitives already exist but aren't wired in:
- `tmuxCcController.launch` supports `resume` → `claude --resume <sid>` (`core/src/terminal/tmux-backend.ts`,
  `CcLaunchOpts.resume` in `core/src/terminal/backend.ts`).
- `sessionVerdict(sessionId)` (`core/src/terminal/cc-sessions.ts`) returns the safety strategy:
  `attach-existing` (live in tmux) / `create-tmux` + `safeToCreateTmux` (dead, jsonl present, safe to
  `--resume` as sole writer) / `refuse` (live but not in a tmux — a `--resume` would double-write the
  JSONL → corruption).
- `cloudDrive(sid, text, {reBootstrap:true})` (`ccr-cloud.ts`) wakes + self-heals a cloud worker.

## Core: one shared backend

New pure-ish function (new module `core/src/mission/mission-resume.ts`):

```
resumeWorker(mission, sid, deps) : Promise<ResumeResult>
ResumeResult = { resumed: boolean; transport: 'cloud'|'native'; sid: string; reason: Reason; note?: string }
Reason = 'ok' | 'alive' | 'gone' | 'conflict' | 'status-unknown'
```

`deps` are injected (cloudStatus, cloudDrive, sessionVerdict, launchNative, captureBridgeCse,
readMission, patchBinding) so the function is unit-testable without real I/O — mirrors the existing
`defaultSessionResumeDeps` injection pattern in `mission.routes.ts`.

### Cloud resume (transport === 'cloud')
1. `cloudStatus(sid)`.
2. terminal (`stopped|completed|failed|error|archived|deleted` — reuse the existing terminal check at
   `mission.routes.ts:871`) → `{resumed:false, reason:'gone'}`.
3. alive + actively running (`worker_status` running / `connection_status` connected) →
   `{resumed:true, reason:'alive'}` (no-op).
4. alive but idle/disconnected → `cloudDrive(sid, "Resume: continue your task.", {reBootstrap:true})`
   → `{resumed:true, reason:'ok'}`.
5. `cloudStatus` throws (transient) → `{resumed:true, reason:'status-unknown'}` (grace, matches today).
6. **sessionId unchanged** in all cases.

### Native resume (transport === 'native')
1. `sessionVerdict(sid)` → `connectStrategy`.
2. `attach-existing` → `{resumed:true, reason:'alive', sid}` (already live; the read/drive views attach).
3. `create-tmux` + `safeToCreateTmux` → relaunch as **`claude --resume <sid> --remote-control`** in the
   **same persisted worktree** (`tmuxCcController.launch({cwd: worktreeDir, resume: sid, remoteControl:true,
   skipPermissions:true, autoTrust:true})`); capture the new bridge `cse` (`pickNewSession` diff vs a
   pre-launch `cloudListAccount` baseline, as `startNativeExecutor` does); **patch `binding.ccr` only,
   keep `binding.sessionId = sid`** → `{resumed:true, reason:'ok', sid}`.
4. `refuse` (live but not in a tmux) → `{resumed:false, reason:'conflict'}` (never force — JSONL-corruption guard).
5. worktree missing OR `sessionVerdict` finds no jsonl → `{resumed:false, reason:'gone'}`.
6. **sessionId PRESERVED** (the continuity win); only `binding.ccr.{cse,sid,webUrl,tmuxSession}` updates.

The worktree dir is the persisted `.claude/worktrees/mission-<id>` (or the mission's shared repo) —
re-derive from the mission the same way `ensureWorktree` does; resume re-uses it (no `git worktree add`
of a new branch — the branch `mission/<id>` already exists).

## The three surfaces

1. **REST** — rewrite `handleSessionResume` (`mission.routes.ts`) to delegate to `resumeWorker`.
   Stays leader-anchored (resume is a write). The route keeps stamping `autoCloseAt`/`trackResumedNative`
   for a freshly-resumed native session.
2. **MCP** — new `mission_session_resume(sid)` tool (`core/src/mcp-server/tools/mission.ts`) that proxies
   `POST /mission/session/:sid/resume`. **MUST add `mission_session_resume: 'write'` to `TOOL_SCOPES`
   (`core/src/mcp-server/configure.ts`)** — a missing scope crashes Core on the first `/mcp` call
   (`assertScopesCoverTools`); add the `mcp-tool-scopes` regression coverage.
3. **Controller** — in the supervisor (`mission-controller.ts`), when a mission has a **bound-but-dead**
   worker (`isLive` false on a binding), call `resumeWorker` first. On `ok`/`alive` → keep driving the
   resumed worker. On `gone`/`conflict` → **do NOT auto-replace**; leave the binding/state for the
   controller LLM's existing separate spawn path to decide (decouples "resume" from today's auto-fresh
   relaunch). This is the behavioral change: a dead bound native worker is *resumed*, not silently
   replaced.
   - **Loop guard (required):** the supervisor attempts resume **at most once per dead-transition** —
     record `binding.lastResumeAttempt` (timestamp) and skip re-attempting on subsequent ticks while the
     binding is unchanged and the last result was `gone`/`conflict`. This prevents a resume-retry storm
     every ~1-min tick (the same failure class as the earlier controller-proliferation bug). A new
     binding (after an explicit fresh spawn) resets the guard.

## UI (`web/src/components/missions/MissionsPage.tsx`)

`checkAndHandleTabLiveness` / `confirmResumeNative` already call the resume route; now they get true
resume. After a native `ok`, the tab continues on the **same** sid (new bridge under the hood). For
`reason:'conflict'` → show "Session is live elsewhere and can't be safely resumed" + the read-only path;
for `reason:'gone'` → show "Can't resume — session is gone" + a **"Start fresh worker"** button (the
explicit respawn, calling the controller/`mission_place` spawn path). Cloud `ok` (woken) just renders.

## Files

| File | Change |
|------|--------|
| `core/src/mission/mission-resume.ts` | **new** — `resumeWorker` + pure `decideResume` mapping |
| `core/src/routes/core/mission.routes.ts` | `handleSessionResume` delegates to `resumeWorker` |
| `core/src/mission/mission-controller.ts` | supervisor resumes a bound-dead worker before considering replacement |
| `core/src/mcp-server/tools/mission.ts` | new `mission_session_resume` tool |
| `core/src/mcp-server/configure.ts` | `mission_session_resume: 'write'` scope |
| `web/src/components/missions/MissionsPage.tsx` | handle `ok`/`alive`/`conflict`/`gone` results + "Start fresh worker" |

## Testing

- **Pure `decideResume`** unit tests (node:test, `core/src/__tests__/`): every branch — cloud
  terminal/alive/idle/throw; native attach-existing/create-tmux/refuse/missing.
- **Route**: extend `core/src/__tests__/mission-session-resume.test.ts` (inject deps) — native now returns
  the **same** sid (not a fresh one) + patches `binding.ccr` only; cloud-idle calls `cloudDrive` with
  `reBootstrap`; `conflict`/`gone` shapes; leader-anchor proxy preserved.
- **MCP scope**: `mcp-tool-scopes` test covers `mission_session_resume`.
- **Manual E2E** on dev/prod: (a) native worker — kill its tmux, resume → **same `sessionId`** continues
  appending + re-bridged (new cse); (b) idle cloud worker → resume wakes it (re-drive); (c) a live-but-
  unattachable native session → `conflict` (no corruption); (d) a stopped cloud session → `gone` (no respawn).

## Out of scope

- Auto-respawn-on-resume-failure (explicitly declined — resume-only).
- Keepalive / worker-JWT refresh / preventing cloud idle-suspend (Anthropic-infra limitation; unchanged).
- Reviving a cloud worker that idle-suspended *while blocked on a question* (unrecoverable by design → `gone`).
