# Cowork Chat UI — Spec 1: Cowork Foundation (2026-07-12)

## Overview

Build a **claude.ai-look-alike Cowork surface** in the lm-assist web UI: a new `/cowork` page with the
home composer (`Chat | Cowork` toggle), the unified "Chats and tasks" list, and the cowork **task-detail
view** (transcript + right rail + in-task composer), backed by a new **`/cowork/*`** Core API family that
drives `api.anthropic.com /v1/code/sessions` headlessly via the Claude Code OAuth token, with live updates
over SSE (polling fallback).

This is **Spec 1 of a 4-spec program** toward full claude.ai Chat+Cowork parity (chosen by the user):

| Spec | Scope | Status |
|---|---|---|
| **1 — Cowork foundation** | page shell + composer + list + task detail + right rail + SSE live updates + task actions | **this spec** |
| 2 — Chat surface | the Chat half of the toggle (claude.ai conversations via `/claude-ai/*`) | later |
| 3 — Scheduled + Projects | Scheduled page, Schedule action, Project selector / add-to-project | later |
| 4 — Attachments, connectors, settings | file attach/staging, connector attach, `cowork_settings` (Manual/Auto persistence), Customize | later |

Prior work this builds on: `docs/cowork-web-endpoints.md` (full endpoint map, verified 2026-07-11),
`core/src/cowork/cowork-tasks.ts` (`POST /cowork/tasks` create+send, merged), `core/src/terminal/ccr-cloud.ts`
(drive/answer/status/stop/list helpers for the same `/v1/code/sessions` runtime), and
`web/src/components/ccr/CcrCloudView.tsx` (transcript + drive + AskUserQuestion approval UI).

## Captured UI reference (what "exactly like claude.ai" means, observed live 2026-07-12)

Captured logged-in on the user's account (composer, list, and a throwaway task `cse_01829Zqy…` created via
our own `POST /cowork/tasks`, screenshotted, then deleted — DELETE 200, GET-after 404).

**Home composer** (`claude.ai/new`): headline "How can I help you today?"; input card with a
**`Chat | Cowork`** segmented toggle inside the input; left `+` (attach); right model selector
(`Opus 4.8` + effort `Max`); mic. Below the input: a **`Project`** dropdown, a **`Manual`** execution-mode
dropdown, and a usage hint (`2× more usage until …`). A **`Beta`** badge sits top-right. "Ideas for you"
suggestion cards fill the empty state.

**"Chats and tasks" list** (`claude.ai/chats`): page title + `Select` / `Filter by …` / `New` controls; a
search box; a flat list of rows (title + right-aligned date). The **Filter** dropdown offers
**All / Chat / Shared / Cowork / Archived**. Filtering to Cowork with no tasks shows "No activity yet."

**Cowork task detail** (`claude.ai/cowork/{cse}`): three regions —
- **Header**: cloud icon + task title + a **title▾ menu** (`Schedule`, `Turn into skill`, `Pin` `P`,
  `Rename` `R`, `Add to project ›`, `Archive` `A`, `Delete` `D`) and a right-rail toggle icon.
- **Center transcript**: the user prompt in a light rounded card; assistant turns as plain text; tool use
  shown as a summary line ("Ran a command, created a file"); an action row under each assistant turn
  (copy / read-aloud / thumbs up / thumbs down); the orange sunburst spinner while a turn is running.
- **Right rail** (collapsible sections): **Progress** (a row of step circles — "See task progress for
  longer tasks"), **Outputs N** (files the task wrote, e.g. `capture.md`), **Context** ("Track tools and
  referenced files used in this task").
- **In-task composer** (bottom): "Write a message…" + `+` (attach) + **Manual** + model/effort
  (`Sonnet 5` / `Medium`) + mic. The **Manual** dropdown offers **Manually approve** ("Claude pauses so
  you can approve each action") vs **Skip all approvals** ("Claude never pauses, even for unsafe actions")
  — this is the `cowork_settings.auto_mode_enabled` toggle.

**Chat detail** (`claude.ai/chat/{uuid}`, for reference / Spec 2): single-column transcript, **no** right
rail; header has a **Share** button; composer has attach + model/effort + mic + voice, but **no**
Manual/Project. Confirms the Chat vs Cowork structural difference.

**Shared shell**: left sidebar (`Home | Code` tabs; `New`, `Chats and tasks`, `Projects`, `Artifacts`,
`Scheduled`, `Customize`; Pinned; Recents), the model selector (Opus 4.8 / Sonnet 5 / Haiku 4.5 ×
low/medium/high/max), message-bubble styling, and the "Claude is AI and can make mistakes" footer.

## Goals

1. A new `/cowork` nav page that visually matches claude.ai's Cowork surface (composer + list + task detail
   + right rail), built as a reusable shell so the Chat renderer (Spec 2) slots into the same composer and
   list.
2. A `/cowork/*` Core API family that lists, reads, drives, approves, and manages cowork tasks headlessly
   over the OAuth `/v1/code/sessions` runtime, reusing `ccr-cloud.ts` helpers.
3. Live task-detail updates over **SSE**, with an automatic **5s polling fallback** where SSE can't stream
   (hub-relayed / remote nodes; see Data flow).
4. The cowork right rail (Progress / Outputs / Context) driven from the parsed event stream.

## Non-goals (Spec 1 — deferred to later specs)

- The **Chat** half of the toggle (Spec 2). In Spec 1 the toggle renders with Chat present but disabled
  ("coming soon"); Cowork is the active side.
- **Scheduled** tasks + the `Schedule` action; **Projects** + `Add to project` (Spec 3). The `Project`
  dropdown renders disabled in Spec 1.
- **Attachments** / file upload / staging; **connector attach**; `cowork_settings` **persistence**
  (Manual/Auto is display + create-time only in Spec 1); **Turn into skill**; **Customize** (Spec 4).
- No new persistence in Core — the tasks live on the Anthropic side; we proxy them.

## Architecture

One new page, one new API family. The page is a two-state shell (home vs task-open) that reuses transcript
+ approval rendering extracted from `CcrCloudView`.

```
web /cowork (CoworkPage)                Core /cowork/* routes            api.anthropic.com
  CoworkComposer (Chat|Cowork) ───────► POST /cowork/tasks ────OAuth───► POST /v1/code/sessions (+ /events)
  CoworkList (filter)          ───────► GET  /cowork/tasks   ────OAuth───► GET  /v1/code/sessions?tags=cowork
  CoworkTaskView               ───────► GET  /cowork/tasks/:cse ─OAuth──► GET  /v1/code/sessions/{cse}/events
    ├─ transcript + drive      ───────► POST /cowork/tasks/:cse/events ─► POST …/events   (user turn)
    ├─ approval widget         ───────► POST /cowork/tasks/:cse/answer ─► POST …/events   (control_response)
    ├─ title▾ manage           ───────► POST /cowork/tasks/:cse/{rename,archive,delete,pin}
    ├─ right rail              ◄─ parsed from the same /events payloads (active_goal / outputs / context)
    └─ live                    ◄─────── GET  /cowork/tasks/:cse/stream (SSE)  ─OAuth─► GET …/events/stream
                                              (poll fallback: repeat GET /cowork/tasks/:cse every 5s)
  Outputs download             ───────► GET  /cowork/tasks/:cse/outputs/:file ─(cookie)─► claude.ai wiggle
```

### Design for isolation

- **`core/src/cowork/cowork-read.ts`** — pure parsing; `parseCoworkEvents(eventsBody)` → structured
  transcript + rail data. No HTTP, no routing. Independently unit-testable against captured fixtures.
- **`core/src/cowork/cowork-tasks.ts`** — task operations (existing `createCoworkTask`; add `listCoworkTasks`,
  `getCoworkTask`, `driveCoworkTask`, `answerCoworkTask`, `manageCoworkTask`). Delegates to `ccr-cloud.ts`
  helpers + `claude-oauth.ts`; knows nothing about routing.
- **`core/src/routes/core/cowork.routes.ts`** — HTTP surface only; validates, calls the above, wraps.
- **SSE proxy** — a special-cased path in `rest-server.ts` (SSE cannot use the buffered route-handler
  contract; see Data flow).
- **`web/src/components/cowork/*`** — presentation; each component has one job (composer, list, task view,
  right rail). Shared transcript/approval/live-hook extracted to `web/src/components/shared/` (or
  `cowork/shared`) and consumed by both `CoworkTaskView` and the refactored `CcrCloudView`.

## Backend — `/cowork/*` API family

Extends the existing `core/src/routes/core/cowork.routes.ts`.

| Method | Endpoint | Purpose | Reuse / notes |
|---|---|---|---|
| POST | `/cowork/tasks` | *(exists)* create + send initial prompt | `createCoworkTask` |
| GET | `/cowork/tasks?filter=&limit=&cursor=` | list account cowork tasks → `{ sid, title, status, model, lastEventAt, statusCategory }[]` + `nextCursor` | `cloudListAccount` (filter to cowork tags: `product:cowork-remote` / `tags:["cowork"]`) |
| GET | `/cowork/tasks/:cse` | task detail: session obj + `messages[]` + `activeGoal` + `outputs[]` + `context` + `pendingQuestion` | **new** `parseCoworkEvents()` over `GET …/{cse}/events?limit=` |
| POST | `/cowork/tasks/:cse/events` | drive (user turn) → `{ delivered, eventId }` | `cloudDrive` (already POSTs to `/events`) |
| POST | `/cowork/tasks/:cse/answer` | answer AskUserQuestion / approval → `{ answered, transport }` | `cloudAnswer` / `buildControlResponse` |
| POST | `/cowork/tasks/:cse/rename` | `{ title }` → PUT session title | `anthropicOAuthPut /v1/code/sessions/{cse}` |
| POST | `/cowork/tasks/:cse/archive` · `/unarchive` | archive / unarchive | `anthropicOAuthPost …/{archive,unarchive}` |
| POST | `/cowork/tasks/:cse/pin` | `{ pinned }` pin/unpin | session PUT (pin flag) |
| DELETE | `/cowork/tasks/:cse` | delete the task | `anthropicOAuthDelete /v1/code/sessions/{cse}` (verified 200 → 404) |
| GET | `/cowork/tasks/:cse/stream` | **SSE** live event proxy | special-cased in `rest-server.ts`; see Data flow |
| GET | `/cowork/tasks/:cse/outputs/:file` | download an output file | claude.ai `wiggle/download-file` via the `/claude-ai` cookie path (cookie required) |

All non-SSE handlers wrap with `wrapResponse` / `wrapError` and carry `httpStatus` for non-2xx (the pattern
already in `cowork.routes.ts`). Register nothing new in `index.ts` beyond the existing `createCoworkRoutes`
(the new routes are added inside it).

### `parseCoworkEvents(eventsBody)` — the one genuinely new parser

Reads the July events shape **`{ data: [event…], resume_cursor }`** (each event
`{ event_id, event_type, sequence_num, source, payload, created_at }`) and returns:

| Field | Built from |
|---|---|
| `messages[]` | `event_type:user` (prompt) · `assistant` text · `tool_use`/`tool_result` → tool cards · the **reply extracted from the `SendUserMessage` tool_use** (cowork replies arrive as a tool_use, not a plain assistant text block) |
| `activeGoal` | the `active_goal` payload (steps + current) → **Progress** step tracker |
| `outputs[]` | `system` `subtype:task_notification` `output_file` + tool_uses that write under `/mnt/user-data/outputs` → **Outputs** panel (filenames) |
| `context` | distinct tool names + referenced file paths across `tool_use` events → **Context** panel |
| `pendingQuestion` | `findPendingQuestion` (reused) over the event payloads |
| `statusCategory` | `post_turn_summary.status_category` (`review_ready` / `needs_action` / …) from the session object → list + header badge |

Incremental use: the SSE path feeds new events into the same reducer so the hook can append without a full
re-parse.

## Frontend — `/cowork` page + `web/src/components/cowork/`

New sidebar entry in `web/src/components/layout/Sidebar.tsx` (`{ href: '/cowork', icon: <Sparkles/CloudCog>,
label: 'Cowork' }`) and a route `web/src/app/(dashboard)/cowork/page.tsx`.

| Component | Role (claude.ai analog) |
|---|---|
| `CoworkPage.tsx` | shell + state: home (composer + list) vs task-open (detail); routes `/cowork` and `/cowork/:cse` |
| `CoworkComposer.tsx` | "How can I help you today?" + **`Chat\|Cowork`** toggle (Chat disabled "soon") + model/effort selector + `Project` (disabled → Spec 3) + `Manual/Auto` + `+` (disabled → Spec 4) + send → `POST /cowork/tasks` then open the new task |
| `CoworkList.tsx` | "Chats and tasks" list + **Filter** (All / Cowork / Archived active; Chat / Shared disabled) + search + `New`; rows = title, date, **status badge** (`review_ready` / `needs_action`) |
| `CoworkTaskView.tsx` | detail: transcript + **title▾ menu** (Rename / Archive / Delete / Pin — Schedule/Skill/Add-to-project disabled) + in-task composer (drive) + Manual + model; live via `useLiveTranscript` |
| `CoworkRightRail.tsx` | collapsible **Progress** (step circles from `activeGoal`) / **Outputs N** (files; click → download via the outputs endpoint) / **Context** (tools + referenced files) |
| `ModelEffortSelector.tsx` | Opus 4.8 / Sonnet 5 / Haiku 4.5 × low/medium/high/max → `config.model` + `config.effort_level` |

**DRY refactor (improve code we're working in):** extract from `CcrCloudView.tsx` into shared components —
`TranscriptMessage` (markdown + tool cards), `ApprovalWidget` (the AskUserQuestion option/free-text UI),
and a `useLiveTranscript` hook (the `seqRef` stale-guard + live/pause + auto-scroll logic). `CcrCloudView`
is refactored to consume them so there is one implementation; `CoworkTaskView` reuses them. Keeps the
proven behaviors (stale-response guard, `gone`/ended state, bottom-stick scroll).

## Data flow, auth, live updates

- **Create** → composer `POST /cowork/tasks` → returns `cse` → navigate `/cowork/:cse`.
- **List** → `GET /cowork/tasks?filter=` (poll on focus / interval).
- **Read (initial)** → `GET /cowork/tasks/:cse` → `parseCoworkEvents`.
- **Live** → `useLiveTranscript` opens **SSE** `GET /cowork/tasks/:cse/stream`; on each frame it merges new
  events. **Fallback to 5s polling** when: (a) the target is a **hub-relayed remote node** (the `_coreapi`
  relay buffers responses, so SSE can't stream — this is why the app polls today), or (b) SSE yields no
  first frame within ~4s / errors. Local/LAN (direct core) gets true SSE.
- **Drive** → in-task composer `POST /cowork/tasks/:cse/events`.
- **Approve** → `ApprovalWidget` → `POST /cowork/tasks/:cse/answer`.
- **Manage** → title menu → `POST /cowork/tasks/:cse/{rename,archive,pin}` or `DELETE`.
- **Outputs download** → `GET /cowork/tasks/:cse/outputs/:file` (cookie/wiggle).

**Core SSE proxy** (`rest-server.ts`): matched before normal route dispatch (like `/stream`,
`/tasks/events`). Opens an OAuth fetch to `api.anthropic.com/v1/code/sessions/{cse}/events/stream` (with
`ccr-byoc-2025-07-29` beta + `x-organization-uuid`, via `claude-oauth.ts`), and pipes each SSE frame to the
browser as `text/event-stream`, resumable via `last-event-id` → upstream `resume_cursor`. Closes the
upstream on client disconnect.

**Web SSE client**: a **fetch + `ReadableStream` reader** (not `EventSource`, which cannot send the
`x-api-key` header) that streams `data:` frames; sends `x-api-key` + the `${basePath}/_coreapi` proxy prefix
via the existing `apiFetch`/worker-fetch conventions (`web_core_fetch_rules`). This is the web app's first
streaming consumer; keep it small and behind the `useLiveTranscript` hook.

**Auth**: browser→Core uses `x-api-key` (worker-fetch) + cloud-proxied via `${basePath}/_coreapi`; Core→
Anthropic uses the Claude Code OAuth token with auto-refresh (`ensureFreshAccessToken`). Cookie (via
`/claude-ai`) is used **only** for output download.

## Error handling

| Case | Result |
|---|---|
| missing `prompt` on create | `400 COWORK_BAD_REQUEST` (existing) |
| OAuth unrecoverable | `401 COWORK_AUTH`; UI shows "sign in to Claude Code" |
| read of deleted/ended task (404) | clean **"task ended"** state, stop polling (the `gone` pattern from `CcrCloudView`) |
| SSE cannot stream (relayed/remote) or errors | silent fallback to 5s polling; no user-visible error |
| output download without a valid cookie | inline hint "sign in to claude.ai to download outputs" (reason from `/claude-ai/healthz`) |
| out-of-order responses | dropped via the `seqRef` stale-guard in `useLiveTranscript` |

## Testing

- **Unit — `parseCoworkEvents`**: fixtures captured from the 123 lm-proxy audit log (real cowork event
  streams: `user` / `assistant` / `tool_use` / `SendUserMessage` reply / `active_goal` / `task_notification`
  with `output_file` / `control_request`). Assert `messages`, `activeGoal`, `outputs`, `context`,
  `pendingQuestion`. Added to the core `node --test` suite (`core/src/cowork/__tests__/`).
- **Route tests**: mock the `ccr-cloud` / `claude-oauth` helpers (node:test `mock.method` on the required
  exports); assert list / get / drive / answer / manage request+response shapes and `httpStatus` mapping.
- **E2E (dev `:3200`, from the worktree build)**: create → read → drive → approve → rename → **delete** one
  throwaway cowork task; verify right-rail data (Outputs shows a written file; Progress reflects
  `active_goal`). Same create-and-clean-up discipline used to capture the UI (delete after; assert GET →
  404). Prod (`:3100`) untouched.
- **Web**: `next build` stays green; manual dev browser check via LAN IP (`http://<ip>:3948/cowork`) with
  `assist_access_key` injected (`dev_web_browser_testing`). Compare against the captured claude.ai
  screenshots for visual parity.
- **Typecheck/build**: `npx tsc --noEmit -p core/tsconfig.json` + `./core.sh build` green.

## File changes (implementation map)

| File | Change |
|---|---|
| `core/src/cowork/cowork-read.ts` | **new** — `parseCoworkEvents()` + rail/message types |
| `core/src/cowork/cowork-tasks.ts` | **extend** — `listCoworkTasks`, `getCoworkTask`, `driveCoworkTask`, `answerCoworkTask`, `manageCoworkTask` (delegate to `ccr-cloud.ts`) |
| `core/src/routes/core/cowork.routes.ts` | **extend** — list / get / events / answer / rename / archive / pin / delete / outputs handlers |
| `core/src/rest-server.ts` | **extend** — special-cased SSE path `GET /cowork/tasks/:cse/stream` (mirror `/tasks/events`) |
| `core/src/cowork/__tests__/cowork-read.test.ts` | **new** — parser unit tests + fixtures |
| `web/src/app/(dashboard)/cowork/page.tsx` | **new** — route |
| `web/src/components/cowork/{CoworkPage,CoworkComposer,CoworkList,CoworkTaskView,CoworkRightRail,ModelEffortSelector}.tsx` | **new** |
| `web/src/components/shared/{TranscriptMessage,ApprovalWidget}.tsx` + `web/src/hooks/useLiveTranscript.ts` | **new** — extracted from `CcrCloudView` |
| `web/src/components/ccr/CcrCloudView.tsx` | **refactor** — consume the shared components (no behavior change) |
| `web/src/components/layout/Sidebar.tsx` | **extend** — add the `/cowork` nav entry |
| `web/src/lib/api-client.ts` (as needed) | streaming helper for the SSE reader, if not already present |

## Where the work happens

The existing worktree `.claude/worktrees/feat+cowork-task-creation` (branch
`worktree-feat+cowork-task-creation`, currently at `main` HEAD `a448aab`). This spec is committed there.

## Open questions / risks

- **SSE over the hub relay**: confirmed the relay buffers, so SSE is local-only with a poll fallback. If a
  future need is live updates for *remote* cowork tasks in the UI, that requires a relay-level streaming
  change (out of scope here).
- **Cowork reply extraction**: replies arrive as a `SendUserMessage` tool_use — the parser must special-case
  this (verified in captures); a plain `assistant` text fallback is kept for robustness.
- **List tag filter**: server auto-adds `product:cowork-remote` + `config:cowork-remote` on create; the list
  filter keys on these (verify the exact tag(s) returned by `GET /v1/code/sessions` during implementation).
