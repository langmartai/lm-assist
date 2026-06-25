# Wave 5 — CCR remote-control session visibility + source naming

**Goal:** The CCR view lists local `--remote-control`-connected sessions — the Mission Controller + mission executors (named reliably from the mission store) AND any other local remote-control session (from the account list) — and the controller/executors are **titled at the source** (`claude -n <name>`) so they're named on claude.ai too.

**Why (from investigation):** The CCR page's "Cloud sessions" list calls only `GET /ccr/cloud` (our local cloudStart registry); the native `claude --remote-control` controller is never there. It leaks into `GET /terminal/cc-sessions` un-named. `cloudListAccount` (`/v1/code/sessions`, includes RC sessions + titles) is wired to no route/UI. The launch sets no title.

## Decisions (user-approved)
- Scope: **mission sessions + other local RC** (mission ones named from the store; others from the account list).
- **Title at the source:** `claude` supports `-n, --name <name>` ("display name for this session") and `--remote-control [name]`. Use `-n <name>` (general, independent of the RC flag).

## Components

### 1. Source titling (`core/src/terminal/*`)
- `CcLaunchOpts` (`backend.ts`) + `CCLaunchInput` (`types.ts`): add `name?: string`.
- `buildLaunchCmd` (`cc.ts`): when `opts.name`, append `['-n', opts.name]` (shell-quoted).
- `tmuxCcController.launch` (`tmux-backend.ts`): forward `name`.
- `mission-controller.ts`: the supervisor `launch` passes `name: \`Mission Controller · ${hostname}\``; the native-executor `launch` (`startNativeExecutor`) passes `name: missionSessionTitle(m)`.

### 2. `GET /ccr/remote-control` route (`core/src/routes/core/ccr.routes.ts`)
Returns `{ controller, executors, accountRc }`:
- `controller`: from `getControllerSession()` → `{ sid: sessionId, cse, tmux, title: 'Mission Controller', node, startedAt }` or null.
- `executors`: from `listMissions()` with a binding → `{ sid: binding.sessionId, cse: binding.ccr?.sid ?? null, title: missionSessionTitle(m), missionId, status }`.
- `accountRc`: `await cloudListAccount()` → `[{ sid, title, status }]` (other account RC/code sessions; the UI dedups against controller/executor sids).
- Handler is DI-testable (inject `getController`, `listMissions`, `listAccount`); bare `{success,data}` envelope; behind the worker token.

### 3. CcrPage (`web/src/components/ccr/CcrPage.tsx`)
- Add `/ccr/remote-control` to `fetchAll`. Render a **"Remote-control sessions"** section: the controller row (📡 Mission Controller, live dot, Open → `CcrCloudView` when a cse exists, else a note it's driven from the Missions page), the executor rows (named, Open), and other accountRc rows (title-first). Dedup accountRc by sid against controller/executor.

### 4. (Fold in Wave 4 Task 4) interim on the mission item (`MissionsPage.tsx`)
- Show `mission.interim?.text` as `⏳ working — {text}` on each active mission row.

## Tests
- `buildLaunchCmd`: `name` → `-n <name>` present + quoted; no name → absent.
- `handleRemoteControlList` (injected deps): returns the controller + executor rows with titles; accountRc passthrough; null controller → `controller:null`.
- web: build-clean; section renders (browser-verified post-deploy).

## Verify (e2e)
- Relaunch the controller → its `claude` argv has `-n 'Mission Controller · <host>'`; it appears titled in `cloudListAccount` / claude.ai.
- CCR page shows a "Remote-control sessions" section with the named Mission Controller + any executors; clicking the controller opens its live view (or points to the Missions chat).

## Out of scope
- Unifying the three session registries; changing how cloud executors are titled (already `missionSessionTitle`).
