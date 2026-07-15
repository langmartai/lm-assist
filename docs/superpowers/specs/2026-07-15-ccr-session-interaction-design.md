# CCR sessions: full interaction — design (mission_7209a10a)

**Goal** — a session opened in `/ccr/[sid]` is fully interactive: composer delivers input on every listed transport, pending AskUserQuestions surface as a clickable banner, and interrupt/stop/resume management is visible and state-driven.

## Endpoint choice (architecture rule: reuse `/mission/session/:sid/*`)

All **interaction** goes through the existing mission session stack — sid-based, transport-resolving (`session_`/`cse_` → cloud, UUID → native), rails included. **No new core endpoints, no core changes.**

| Action | Endpoint | Why this one |
|---|---|---|
| send | `POST /mission/session/:sid/drive {text, node?}` | carries **STANDBY_MODE rejection + ⟦lm-assist⟧ marker auto-prefix** (onboarded rails); cloud→`cloudDrive` (with cse bridge fallback), native→tmux prompt |
| answer | `POST /mission/session/:sid/answer {answer, toolUseId?, requestId?, node?}` | the mission_session_answer paths: cloud→`cloudAnswer` (client control_response preferred), native→bridge worker/events, else tmux digit/text keys — **never plain drive** |
| interrupt/stop | `POST /mission/session/:sid/control {action, force?, node?}` | stop carries the **ONBOARDED_PROTECTED force-gate** |
| liveness | `GET /mission/session/:sid/status` → `{transport, alive}` | one check for both transports |
| resume | `POST /mission/session/:sid/resume {missionId?, force?}` | the resume-first ladder (cloud wake / `ensureRemoteControlled` inject-first / worktree relaunch) |

**Display reads stay on the existing richer endpoints** (unchanged): local → `/sessions/:id/conversation` (thinking + tool cards); cloud/remote → `/ccr/cloud/:sid` (already returns `pendingQuestion` from the same `cloudRead`). Local sessions additionally poll `/mission/session/:sid/read` on the same 5s tick — it is the **only** surface with native pendingQuestion extraction (jsonl AskUserQuestion + bridge worker/events fallback via `bridgeCseFor`).

**`node` param**: answer/resume are leader-anchored server-side; for **local** rows we pass `node` = this Core's `gatewayId` (fetched once from `/hub/status`; null when hub unconfigured → omitted, anchor is inert). Cloud rows omit it. **`missionId`**: resolved client-side from `GET /mission` (binding.sessionId / binding.ccr.sid match) and passed on resume — a dead *mission-bound* native relaunches in its worktree; a dead *non-mission* native gets an honest "not mission-managed — use Connect" notice (server would throw; we pre-empt with the lookup).

## Components (web only)

1. **`web/src/lib/ccr-interact.ts`** (new, pure — vitest): `parseEnvelopeError` (400-body → `{code,message}`), `deriveSessionState` (status/resume outcomes → `checking|live|idle|gone|conflict|needs-force`), `findMissionForSid`, `resumeNotice(reason)`.
2. **`web/src/components/ccr/CcrSessionControls.tsx`** (new): status pill + **Interrupt**/**Stop**/**Resume** strip rendered under `CcrDetailHeader` for all kinds. Stop = inline confirm; on `ONBOARDED_PROTECTED` → second explicit "user's own onboarded session — Force stop?" confirm → retry `force:true`. Resume handles reasons `ok/alive→live`, `gone`, `conflict`, `needs-force` (confirm → force retry). Status checked on mount + 20s + after actions (missions-page pattern).
3. **`CcrSessionView.tsx`** (local): + mission-read poll → `ApprovalWidget` banner above composer (option buttons + free-text) → mission answer. `send()` → mission **drive** (replaces the `/ccr/drive`→tmux→inject ladder). `STANDBY_MODE` surfaces verbatim and **never** falls back; only a "not in a tmux pane" failure degrades to the old `/session-messages` soft-inject (labeled as such).
4. **`CcrCloudView.tsx`**: `send()`/`answer()` switch to mission drive/answer (rails now apply to onboarded **cloud** sessions too). Read/polling unchanged.
5. **`CcrPage.tsx`**: renders `CcrSessionControls` in the detail column.

All calls via the existing `apiFetch` (`apiClient.fetchPath`, machineId-aware) — no raw fetch.

## State model

`checking → live | idle` (from `/status.alive`; row poll refreshes); `resume → resuming → live | gone | conflict | needs-force`. **live**: composer + Interrupt + Stop. **idle**: Resume + composer disabled hint. **gone/conflict**: terminal notice (CcrCloudView's existing 404-`gone` stays). Buttons show strictly by state.

## Question-answer flow

`pendingQuestion {toolUseId, requestId?, questions[{header,question,options[],multiSelect}]}` → banner; option click sends the **label**, free-text sends text → `/answer` with `toolUseId`+`requestId`(+`node`) → banner clears, re-poll ~1s. Shared `ApprovalWidget` (existing) gets an optional `who` label ("the session" vs "the cloud claude").

## Tests / e2e

- vitest: `ccr-interact.test.ts` (~12 cases: error parse, state derivation both transports, mission lookup, resume notices). `tsc`/`next build` within baseline; core suite untouched.
- E2E (this host; curl + DOM checks, exact UI-request replay): our **own** dev web on a free port (**:3971**) built from THIS worktree, pointed at the live core **:3100** (the pre-existing :3200/:3948 stack predates this worktree and is not ours to use). Scratch tmux claude session → open in CCR → **send** → reply in transcript; induce a real **AskUserQuestion** → banner → answer via option button; **interrupt**; **stop+resume**; cloud leg: mission drive/read on a `session_` sid. Rails against ONLY our own scratch session, onboarded by us on :3100: standby drive → `STANDBY_MODE`; handoff drive → marker prefix; stop → `ONBOARDED_PROTECTED` → force. Every mission/session record we create is cleaned up afterwards. No deploy.

**Known limits (documented, unchanged from missions page):** leader-anchored resume of a native session on a non-leader node of a multi-node cluster runs on the leader (mission-bound sessions unaffected); soft-inject fallback delivers on next user turn only.
