# Wave 7 — AskUserQuestion in the mission web chat (native sessions)

**Goal:** When a mission session (esp. the native controller) is blocked on an **AskUserQuestion**, the mission web chat surfaces the question + options and lets the user answer it — matching what `CcrCloudView` already does for cloud sessions.

**Why:** The controller is a native `--remote-control` session; an AskUserQuestion blocks it in its tmux REPL with no web way to answer (you'd have to be at the terminal). Cloud sessions already work (`ccr_cloud_read` → `pendingQuestion` → `CcrCloudView` → `/ccr/cloud/:sid/answer`). Native sessions are the gap. (Proven: tmux `send-keys "<digit>" Enter` selects an option + unblocks the REPL.)

## Components

### 1. Backend — surface `pendingQuestion` on the mission session read
`handleSessionRead` (`mission.routes.ts`) returns `pendingQuestion: PendingQuestion | null` alongside `messages`, where
`PendingQuestion = { toolUseId: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }> }` (SAME shape `CcrCloudView` consumes).
- **cloud** transport → pass through `cloudRead`'s existing `pendingQuestion` (it already computes it).
- **native** transport → parse the local transcript for the LATEST `AskUserQuestion` `tool_use` with NO following `tool_result` (unanswered). Reuse/adapt the cloud parser (`ccr-cloud.ts` ~line 199 `parsePendingQuestion`/`cloudAnswer` area) against the native `.jsonl` (tool_use blocks carry `.input` — see `session-identifier.ts:459`). A pure `extractPendingQuestion(rawMessages): PendingQuestion|null` (testable).

### 2. Backend — `POST /mission/session/:sid/answer { answer, toolUseId? }`
Leader-anchored (write). Resolve transport:
- **cloud** → `cloudAnswer({ sid, answer, toolUseId })` (existing).
- **native** → send the selection to the tmux pane WITHOUT the idle assertion (the pane is at a question prompt, not idle): if `answer` matches an option `label` → send that option's 1-based **index digit** then `Enter` (proven). Else (free text / "type something") → best-effort: send the free-text option's digit if present, then the text + `Enter`. Use a raw tmux send-keys (`tmux.sendKeysUnlocked`/the tmux backend), NOT `cc.prompt` (which asserts idle). A DI `nativeAnswer(sid, {answer, options})` dep for testing the index-resolution + key sequence (inject the send-keys).

### 3. Frontend — MissionSessionChat renders `pendingQuestion` + answer
When the read returns `pendingQuestion`, render (above the composer) the question/header + each option as a clickable button (label + description), plus a free-text input — exactly like `CcrCloudView` lines 115-160. Clicking an option / submitting text → `POST /mission/session/:sid/answer { answer, toolUseId, node }`, then re-poll. (The controller chat + any native session tab get this for free since both use MissionSessionChat.)

### 4. Verify CCR (cloud) unchanged
`CcrCloudView`'s existing AskUserQuestion flow already works — confirm it still renders + answers (no change expected).

## Tests
- `extractPendingQuestion`: a transcript with an unanswered AskUserQuestion tool_use → returns its questions/options/toolUseId; with a following tool_result → null; none → null.
- `handleSessionAnswer` (DI): native + an option label → resolves the 1-based index → sends `<digit>`+Enter via the injected send-keys; cloud → calls `cloudAnswer`; leader-anchored.
- `handleSessionRead`: native read includes `pendingQuestion` when the transcript has one (stub the raw read).
- Web: build-clean; pendingQuestion renders option buttons; clicking posts the answer.

## Verification (e2e)
- Drive the controller into an AskUserQuestion (or catch a real one) → the mission web chat shows the question + options; clicking an option answers it (the REPL advances, the question clears on the next poll).

## Out of scope
- Fixing the underlying cloud "fetch failed" on 123 (`--extra-ca lm-proxy` environment issue — reported separately).
- Multi-select submission UX beyond clicking (single-select + free text covers the common case).
