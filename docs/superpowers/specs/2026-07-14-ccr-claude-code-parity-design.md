# CCR page → claude.ai/code parity — design

**Date:** 2026-07-14
**Branch/worktree:** `feat/ccr-claude-code-parity` (`.claude/worktrees/ccr-parity`)
**Scope (user-approved):** Full parity — UI reskin + backend status/rename/archive/model-control + compact grouped tool cards.

## Goal

Reshape `/ccr` ("CCR — Remote Control") to look and function as close to **claude.ai/code** as
possible, while keeping the capabilities that make lm-assist's page unique (Load / Mirror / Connect a
LOCAL session, RC / mission sessions, cloud sessions). Research was done live on host 123: browser MCP
against `claude.ai/code` + lm-proxy audit log (`~/lm-proxy/logs/http-audit.jsonl`).

## What claude.ai/code looks like (captured 2026-07-14)

**Code home (`/code`)**
- Greeting + a **Sessions** list + a bottom **composer**.
- Session row = **status pill** (e.g. orange ● "Needs input") · **title** · muted **status-detail** sentence
  · **repo** (right) · relative **time** · chevron ›.
- Composer: input "Describe a task or ask a question", a **pill row above** — environment `☁ Default`,
  project `</> lm-assist` (searchable GitHub repos), branch `⑂ main` (searchable) — and a **control row
  below**: permission `Accept edits`, attach `+`, mic; right side model `Opus 4.8`, effort `High`.
- **Environment picker** groups: **Local** (Desktop only), **Cloud** (Default + "Add cloud
  environment…"), **Remote Control** ("Run `claude rc` on your machine to code from here").
- **Permission modes**: Manual (1) · Accept edits (2) · Plan (3) · Auto (4).
- **Models**: Fable 5 (1) · Opus 4.8 (2) · Sonnet 5 (3) · Haiku 4.5 (4) · More models ›.
- **Effort**: a 5-stop **Faster ↔ Smarter** slider.

**Session detail (`/code/session_…`)**
- Header: monitor icon + **title** + **repo chip** + right icons (Artifacts, Share, kebab ⋮).
- **Kebab**: Artifacts · Background tasks · Open in › · Rename (R) · Transcript view › · Copy link (C)
  · Archive (A) · Delete (D).
- Full-width **transcript**: markdown text + inline **tool cards** as compact one-line summaries with a
  verb phrase + filename + diff stats, e.g. `Edited CoworkTaskView.tsx +4 -1 ›`, `Ran 2 commands, read
  a file ›`. No right rail (unlike cowork tasks).
- Bottom composer: "Type / for commands" + the same permission/model/effort controls.

**Status vocabulary (from the wire — `GET /v1/code/sessions`)**
- `status_bucket`: `working` | `review_ready` | `blocked` | `completed`
- `worker_status`: `running` | `idle` | `requires_action`
- `post_turn_summary.status_category`: `need_input` | `review_ready` (+ `status_detail` sentence)
- `connection_status`: `connected` | `disconnected`; `environment_kind`: `bridge` | `anthropic_cloud`
- Per-session repo/branch: `config.sources[].url` + `config.outcomes[].git_info.{repo,branches}` /
  `external_metadata.current_branches`.

## Current lm-assist CCR page (baseline)

`web/src/components/ccr/CcrPage.tsx` (571 lines): one scroll with four stacked sections — Active
remotes, Remote-control sessions, Cloud sessions (a card composer: prompt textarea + repo/branch text
inputs + "install lm-assist" checkbox), Claude Code sessions (Load/Mirror/Connect buttons). Embedded
viewers `CcrCloudView` (cloud, teleport transcript) and `CcrSessionView` (local, `/sessions/:id/
conversation`). Backend `core/src/routes/core/ccr.routes.ts` + `terminal/ccr-cloud.ts` + `terminal/
ccr-manager.ts`.

Endpoints today: `GET /ccr/cloud` (list), `/ccr/cloud/start|:sid/drive|answer|stop|status|:sid`,
`/ccr/{load,mirror,connect,drive,preflight,remote,remote-control,remote/:id,remote/:id/stop}`,
`/ccr/cloud/{repos,branches}`.

**Gaps vs claude.ai:** four-section scroll (not master-detail); card composer (not pills); rows show
badges+buttons (not status pills + detail sentence); `/ccr/cloud` list omits the status fields; no cloud
rename / archive / delete / model-permission-effort control; tool cards are per-tool (not grouped
one-liners).

## Design

Reshape `/ccr` into claude.ai/code's **master-detail** while preserving Load/Mirror/Connect + RC.

### Web components (`web/src/components/ccr/`)

- **`CcrPage`** (rewrite) — the shell. Left/top: unified **Sessions list**. Bottom (home) or in-detail:
  the **composer**. Selecting a session opens the **detail** view (full height). A refresh + filter bar
  at top. Reuses `useAppMode` apiFetch + `fetchAll` polling as today.
- **`CcrComposer`** (new) — claude.ai-style composer. Pills: **environment** (Cloud `Default` /
  **Remote Control** = local driveable sessions on this node / **Local** = read-only load), **project**
  (searchable repos via `/ccr/cloud/repos`), **branch** (searchable via `/ccr/cloud/branches?repo=`),
  **permission** (Manual/Accept edits/Plan/Auto), **model** (Fable 5/Opus 4.8/Sonnet 5/Haiku 4.5),
  **effort** (Faster↔Smarter slider). Submitting with Cloud env → `POST /ccr/cloud/start` (extended with
  model/effort/permissionMode); with a Remote-control target chosen → connect/drive that local session.
  Reuse `ModelEffortSelector` pattern from cowork where it fits.
- **`CcrSessionList` / `CcrSessionRow`** (new) — the claude.ai row: `CcrStatusPill` + title + status
  detail + repo + relative time + chevron. Groups: Cloud · Remote-control · Local. A segmented filter
  (All / Cloud / Remote-control / Local) + "show all" toggle.
- **`CcrStatusPill`** (new) — pure map from `{statusBucket, workerStatus, statusCategory, live}` →
  `{dot color, label}` (Working / Needs input / Review ready / Blocked / Completed / Running / Idle /
  Disconnected). One place, unit-testable.
- **`CcrDetailHeader`** (new) — monitor icon + title (inline-rename) + repo chip + kebab (Rename,
  Archive, Delete, Copy link, Open in claude.ai). Cloud actions call the new endpoints; local/RC actions
  degrade gracefully (only what has an endpoint).
- **Detail body** — reuse `CcrCloudView` (cloud) and `CcrSessionView` (local) transcript internals, but
  render them **full-height** inside the detail shell (both already take `fill`-like layout; unify).
  Keep the existing drive box + `ApprovalWidget`.
- **Tool-card polish** — add a compact **grouped** tool renderer. Consecutive tool calls collapse into
  one summary line: a verb phrase (`Read`, `Edited`, `Created`, `Ran N commands`, `Searched`) + primary
  filename + diff stat `+N -M` (computed from Edit/Write `old_string`/`new_string` line deltas) + chevron
  to expand. Implemented as a shared util `toolSummary(name, input)` + a `TranscriptMessage`
  enhancement **gated behind a `compact` prop** so the cowork page (also a consumer) is unchanged unless
  it opts in. Do NOT regress cowork rendering.

### Backend (`core/`)

- **Enrich `GET /ccr/cloud`** (`terminal/ccr-cloud.ts` `listCloudSessions`): add per item
  `statusBucket`, `workerStatus`, `statusCategory`, `statusDetail`, `unread`, `connectionStatus`,
  `environmentKind`, `branch`, `lastEventAt`, from the `/v1/code/sessions` list payload (already fetched
  — just surface more fields). Keep existing fields (`sid,title,model,repo,cwd,webUrl,createdAt`).
- **`POST /ccr/cloud/:sid/rename`** `{title}` → `PUT /v1/code/sessions/{cse}` `{title}` (reuse
  `anthropicOAuthPut` from `utils/claude-oauth.ts`, added in the cowork work).
- **`POST /ccr/cloud/:sid/archive`** `{archived?:bool}` → `POST /v1/code/sessions/{cse}/archive`
  (or `/unarchive`).
- **`DELETE /ccr/cloud/:sid`** → `DELETE /v1/code/sessions/{cse}` (the kebab "Delete"; distinct from the
  existing `/stop` which stops the container).
- **`POST /ccr/cloud/:sid/control`** `{model?, permissionMode?, effort?}` → `POST /v1/code/sessions/{cse}/
  events` with `control_request` `set_model` / `set_permission_mode` (+ effort via session `config` PUT if
  the wire supports it; otherwise omit effort control and keep it a create-time option only).
- **`POST /ccr/cloud/start`** accept `model`, `effort`, `permissionMode` (thread into the create/seed).

All new backend handlers get `node --test` coverage in `core/src/__tests__/` following the existing
`ccr-cloud.test.ts` mock style (mock the OAuth fetch; assert the outbound URL/method/body + the mapped
response). No live-account calls in tests.

## Data flow

`CcrPage` polls `GET /ccr/cloud` (+ `/ccr/remote`, `/ccr/remote-control`, `/terminal/cc-sessions`) →
normalizes into one `CcrSession[]` with `{kind:'cloud'|'remote'|'local', status fields, repo, branch,
title, sid, driveable}` → `CcrSessionList` renders `CcrStatusPill` rows → selecting one opens the detail
(cloud→`CcrCloudView`, local/RC→`CcrSessionView`) → composer/ kebab actions POST the `/ccr/*` endpoints →
re-`fetchAll`.

## Error handling

Keep the current `parseCcrError` / `friendlyCcrError` (CONFLICT / SESSION_NOT_FOUND / TIMEOUT / …).
New cloud actions surface failures inline in the detail header (rename/archive/delete) and composer
(start/control) with the same friendly-message pattern. Deleting a cloud session is destructive → a
two-step confirm in the kebab (matches the existing Connect confirm pattern; no `window.confirm`, which
blocks browser automation).

## Testing

- **Backend:** unit tests per new handler (mock OAuth fetch), plus a `CcrStatusPill`-equivalent mapping
  test if the mapping lands server-side. `cd core && npm run build:test && node --test dist-test/...`.
- **Web:** `next build` (worktree may need `--webpack`) + `tsc` grep gate (pre-existing 39-err baseline).
  Pure utils (`toolSummary`, status mapping) get light unit tests if a web test runner is present; else
  covered by the live browser check.
- **Live:** start dev services from the worktree (3200/3948) and browser-verify `/ccr` side-by-side with
  `claude.ai/code` on 123.

## Non-goals / preserve

- Keep Load / Mirror / Connect semantics + the refuse-on-live-process safety verdict.
- Keep RC / mission session monitoring (controller/executors/account-RC rows) — fold into the unified
  list as the "Remote Control" group.
- Don't regress the cowork page (shared `TranscriptMessage`): the compact tool renderer is prop-gated.
- Don't touch prod; all work in the worktree on dev ports. Merge/push is the user's call.
