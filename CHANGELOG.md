# Changelog

## [0.2.0] - 2026-09-01

First npm publish since 0.1.70 (2026-04-03) — roughly 1,690 commits (728 feat, 443 fix). The project's
scope has grown from single-machine session observability into a **self-hosted control plane for
Claude Code**: observe, control, automate, and extend Claude Code across every machine you run it on.
Everything below this section down to [0.1.70] — including the blocks labeled `[Unreleased → 0.2.0]` —
ships in this release; versions 0.1.71–0.1.135 existed only as plugin/tarball builds and were never
published to npm.

### Packaging & upgrade — why this publish matters
- **`npm install -g lm-assist` works again.** npm's previous `latest` (0.1.70) shipped `chokidar ^5`,
  which is ESM-only: Core crashed on boot with `ERR_REQUIRE_ESM` and never bound its port. The pin is
  back at `^3.6.0` in both package files, and this publish makes plain `lm-assist upgrade` safe again.
- Node engine floor is **≥ 20.9** (the Next 16 web build requires it; `engines` enforces it).
- `./core.sh pack` produces the reproducible prebuilt tarball (`lm-assist-<ver>.tgz`) — the supported
  deploy artifact; `lm-assist upgrade --from <tgz|version|github:ref|url>` installs any chosen build.
- `upgrade.js` hardened: git-source-build warning (native postinstall trap), Windows EBUSY tarball
  fallback, kill → install → restart ordering.
- The `ccr/` bridge scripts and the real `core/scripts/upgrade.js` now actually ship in the package.

### MCP connector — the fleet in every Claude session
- **285 registered MCP tools** (scope-gated per caller) reachable from Claude Code or claude.ai via
  the hub connector: sessions, search, memory, terminal driving, missions, data, transfers, backups,
  GitHub, nodes, UI panes, service connectors, VMs, containers, desktop, and more.
- `bootstrap` + `guide(topic)` teach a connecting session the whole surface progressively; the tool
  catalogue was trimmed 87.6K → 64.7K tokens at connect time; a per-tool registry overlay allows
  fleet-synced description overrides and enable/disable; every result carries a provenance footer
  (`⟦lm-assist@hub · node · cluster⟧`); the worst unbounded outputs got size ceilings.

### Fleet — many machines, one surface
- Hub client + relay; **one-time keypack enrollment** (`lm-assist login <lmkp_…>`) for fresh nodes.
- Node clusters (scoped election/placement/sync), node selection registry (`node_select`,
  `node_profile`), per-node build/upgrade tracking (`node_builds`, `node_upgrade`), machine-access
  profiles, graceful lifecycle restarts.
- Cross-node data service (cache / vector / sql backends) with access keys and sync; bulk file
  transfer with resumable jobs; direct port-forward transport (~4× faster than relaying).
- Memory + rules sync across hosts: auto-converging user rules with per-OS scoping, cross-host
  memory search and mirror indexing.

### Missions & automation
- Mission graph (tags, relationships, history, provenance), fleet-elected mission controller,
  onboarding + workflow registries, placement and spawn, per-mission views.
- Scheduler jobs: one-time / recurring / trigger-only, full run capture (bounded stdout/stderr
  history), guard conditions, dry-run and test modes.
- Auto-resume of stalled sessions (network errors included), model-limit auto-fallback, stall
  status reporting.

### Sessions, search & knowledge
- Real full-text search: **bm25 FTS5 over user prompts** (the old scorer effectively matched every
  session), CJK sub-word search, deleted-session pruning, self-applying index rebuilds; memory
  search noise fixed (a query that used to hit 110/121 memory files now hits the 1 that matters).
- Sessions page first paint 7.6–10.7 s → 1.3–3.1 s; compact conversation payloads
  (`includeToolResults` / `includeSystemMessages`: 748 KB vs 7.8 MB raw); session DAG views;
  session footprints (one-call cross-fleet snapshot); `rename_session`; delta/conditional fetch.
- The knowledge pipeline remains optional and off by default.

### Claude Code & claude.ai integration
- **CCR**: drive Claude Code sessions from claude.ai/code — load / mirror / connect modes behind a
  safety gate, a `/ccr` page with claude.ai/code look and function, live-session remote-control
  connect, local + cloud restart, cloud worker lifecycle (ephemeral, resumable).
- claude.ai web-session proxy (28 endpoints) + Claude Code OAuth proxy (14 endpoints); conversation
  token measurement + fork; connector/marketplace/plugin management tools; auth monitor with
  proactive OAuth renew and guided login.
- **Voice**: browser voice for claude.ai conversations over HTTPS (`LM_HTTPS=1`), selectable voice,
  startup latency ~22 s → 2–4 s, transcript-to-conversation binding fixes.

### Service connectors (the operator's own logged-in browser, CDP-driven)
- **Gmail**, **LinkedIn**, **WhatsApp** connectors with MCP tools + loopback REST surfaces;
  per-connector Chrome profiles on separate debug ports so all of them run side by side.
- **VM management** (Hyper-V + KVM, both e2e-verified), **container management** (Docker, with
  managed-label guards and volume-root gating), **desktop automation** (screenshot / input / OCR /
  window control, Linux + Windows), GitHub query/mutate tools.

### Web UI
- Pluggable UI panes (gateway-hostable pages; bundled session-dashboard and search panes), shell
  sidebar grouping, memory/rules pages v2, mission dashboard, CCR Remote page, scheduler page.

### Extensibility — plugins as a first-class surface
- **MCP ext-plugin loader**: third-party plugins expose tools as `ext__<plugin>__<tool>`, with a
  documented contract (`docs/mcp-plugin-contract.md` + JSON schema).
- **Bundled first-party plugins** ship in the package (`core/data/mcp-plugins/`), seeded and trusted
  on boot, with checksum-pinned payloads and a sticky per-owner opt-out. First bundled plugin:
  `langmart-design` (LangMart platform read-only tools).
- Fleet-editable content registry: the bootstrap/guide prose is 25 editable docs, synced fleet-wide.

### Security & robustness
- MCP OAuth identity hardening (hub identity can no longer be impersonated via client-supplied ids).
- Elevated / VM / container command surfaces gated by strict input charsets and managed-resource
  labels; relay pane access is grant-scoped.
- Bounded MCP results (size ceilings with honest truncation envelopes), bounded single-flight slots,
  event-loop blocking fixes (`/health` p99 5 s → sub-ms), caller-identity latency fix (a 1.8 s
  synchronous sweep removed from the hot path).

## [Unreleased → 0.2.0] — Gmail CDP connector (9 MCP tools) (2026-07-29)

### Added
- **Gmail connector (CDP-only).** Drives the operator's OWN logged-in `mail.google.com` session in a real Chrome over the DevTools Protocol, mirroring the LinkedIn connector's shape. 9 MCP tools appear in any Claude Code / claude.ai session connected to the node: reads `gmail_status`, `gmail_list_threads`, `gmail_read_thread`, `gmail_search`, `gmail_labels`; writes `gmail_send`, `gmail_reply`, `gmail_draft`; admin `gmail_login`. REST surface under `/gmail/*` on loopback; 15-minute session keep-alive. Dedicated profile at `~/.lm-assist/gmail[-dev]/login-profile/<name>/` on debug port **9224** (distinct from WhatsApp's 9222 and LinkedIn's 9223, so all three run side by side).
- **Endpoint strategy decided by measurement, not assumption.** Gmail's internal feeds were probed from inside a logged-in page and rejected: `/mail/u/0/h/` (basic HTML) is retired and redirects to the SPA; `?ui=2&ik=…&view=tl&rt=j` no longer returns JSON (it serves the ~1.4 MB SPA shell); `/sync/u/0/i/fd` is binary protobuf. So the connector reads the rendered DOM — which, unlike LinkedIn, exposes REAL server ids (`data-legacy-thread-id`, `data-legacy-message-id`), so threads are keyed on Gmail's own ids rather than a display name. Navigation is hash-based, which makes **search a URL change rather than UI typing**. Full rationale in [`docs/gmail-connector.md`](docs/gmail-connector.md).
- **No local message store.** LinkedIn needs one because it cannot backfill history; Gmail can, and owns read-state server-side, so every read here is live.

### Changed
- **`CATALOG_BUDGET_BYTES` raised 240,000 → 252,000** (`__tests__/mcp-catalog-size.test.ts`). The connector landed 15 B over. The shared-boilerplate test still passes, so this is accumulated routine growth, not the re-inlining regression the guard exists to catch (~90 KB, which 252,000 still fails hard on). The new tools average ~530 B against a ~775 B surface mean, so there was nothing left to trim on the newest entries; `gmail_unread` was also dropped from the tool list as an exact duplicate of `gmail_search("is:unread")`. The raise restores ~10 average tools of headroom, at roughly 3 K extra tokens per conversation at connect time.

### Notes
- Verified on a real Workspace account (2026-07-29) that Google does **not** refuse an interactive sign-in in a Chrome launched with a custom `--user-data-dir` and an open `--remote-debugging-port`, on both a Windows and a Linux host, and that the session survives a restart — a headed one-time login followed by **headless** operation against the same profile lands back in the inbox. Headless must force a normal User-Agent or Google serves the degraded `WebLiteSignIn` flow.
- `gmail_send` / `gmail_reply` / `gmail_draft` are implemented but were deliberately **not** exercised live, since they write to a real mailbox.

## [Unreleased → 0.2.0] — Windows browser-launch fix + prebuilt-tgz deploy path (2026-07-27)

### Fixed
- **Headless/headed browser launch on Windows** (`claudeai-browser-launch.ts`): the post-spawn `isPidAlive(child.pid)` guard treated Chrome's normal Windows self-relaunch (the spawned process exits while the real browser keeps running on the debug port) as a failure, returning `SPAWN_FAILED` even though the browser was up. It now accepts a re-parented PID as long as the debug port is still live (the foreign-Chrome risk is already excluded by the pre-spawn port-free check). This is what broke `linkedin_login` on the Windows node despite a working session.

### Changed
- **Deploy path is now explicitly "prebuilt tarball, never a git ref."** Building lm-assist from a git remote (`npm install -g github:…`, `lm-assist upgrade --from github:…`, `node_upgrade({ref})`) runs a full dependency install that trips onnxruntime-node's native postinstall and fails; the running Core is then restarted on the *old* build. `upgrade.js` now detects a git source-build and logs an up-front warning plus an actionable failure hint; the `node_upgrade` tool description steers callers to a prebuilt `.tgz`.
- **`./core.sh pack`** — new target that produces the supported prod artifact `lm-assist-<ver>.tgz` (`npm install --ignore-scripts && npm pack`, building core + web). `./core.sh` dependency installs now use `--ignore-scripts` so a fresh checkout doesn't die on the onnxruntime postinstall.
- Docs: `guide("install")`, CLAUDE.md (commands list + bootstrapping gotcha) now state the git-source-build hazard and the `./core.sh pack` → tarball deploy flow.

## [Unreleased → 0.2.0] — LinkedIn CDP connector (16 MCP tools) (2026-07-27)

### Added
- **LinkedIn connector (CDP-only).** LinkedIn has no usable personal messaging/posting API, so this connector drives the operator's OWN logged-in linkedin.com session in a real Chrome over the DevTools Protocol and mirrors messaging into the shared store — same shape as the WhatsApp connector. 16 MCP tools appear in any Claude Code / claude.ai session connected to the node: reads `linkedin_status`, `linkedin_list_conversations`, `linkedin_read_messages`, `linkedin_search`, `linkedin_read_feed`, `linkedin_read_notifications`, `linkedin_search_people`; writes `linkedin_send_message`, `linkedin_post`, `linkedin_publish_article`, `linkedin_follow`, `linkedin_connect`, `linkedin_message_profile`, `linkedin_comment`, `linkedin_delete_post`; admin `linkedin_login`. REST surface under `/linkedin/*` on loopback; 15-minute session keep-alive.
- **`userDataDir` launch option** on the shared `claudeai-browser-launch` launcher: an explicit persistent user-data-dir that takes precedence over `profile`, so a connector can own a durable Chrome profile (LinkedIn uses `~/.lm-assist/linkedin[-dev]/` on debug port 9223) whose one-time password/2FA login survives restarts, rather than colliding with `isolated` (shared) or `Default` (the user's own Chrome).
- Docs: [`docs/linkedin-connector.md`](docs/linkedin-connector.md).

## [0.1.110] — node_upgrade MCP tool (2026-06-26)

node_upgrade MCP tool: trigger a per-node lm-assist upgrade to a specified prebuilt source (.tgz/URL/github:ref) via the relay, then confirm with node_builds. Refuses to default to npm latest (would downgrade — we don't publish).

## [0.1.109] — per-node build/upgrade tracking (2026-06-26)

Node build/upgrade tracking: each node records its lm-assist build version (and detects upgrades) on Core start; new `node_builds` MCP tool + `GET /node/build` show the fleet's builds + when each last upgraded — confirm a deploy landed across all nodes.

## [0.1.108] — cookie TTL surfacing (2026-06-26)

Cookie TTL surfacing: the browser capture now persists the claude.ai cookies' expiry; auth_status / bootstrap / claudeai_login show when the sessionKey expires (when a browser re-login is due). Existing sessions show 'TTL unknown' until the next capture/login.

## [0.1.107] — proactive OAuth auto-renew (2026-06-26)

Proactive Claude Code OAuth auto-renew: the auth-monitor now refreshes the token a full interval before expiry (keeps the rotating refresh_token alive even when Claude Code is never run); new `POST /claude-code/oauth-renew` API + `claudeai_login which=oauth` triggers a renew.

## [0.1.106] — auth-monitor + guided login + allNodes sweep (2026-06-26)

### Added
- Auth monitor: a browser-free periodic job refreshes the Claude Code OAuth token and tracks claude.ai cookie health into a per-node snapshot (`~/.lm-assist/auth-status.json`); `authMonitorEnabled`/`authMonitorIntervalMin` settings.
- bootstrap now reports the local node's auth status; `auth_status(allNodes:true)` sweeps the fleet.
- `claudeai_login` MCP tool + `guide("login")` — guided cookie (browser-capture/manual) + OAuth re-login, per node.

## [0.1.103] — missions sidebar search/filter/pagination + resumed-session idle-timeout setting (2026-06-26)

- **Missions sidebar** is now searchable, filterable, scrollable, and paginated:
  - **Keyword search** across title/objective/id/status; **space = AND** (every space-separated term
    must match).
  - **Status**, **transport** (cloud/native), and **recency** (Any time / 1 day / 3 days / 7 days)
    filters, all ANDed with the search.
  - Missions **sorted by recency** (most recent first); **top 50 shown** with a **"Load N more (X/Y)"**
    button for the rest. Pagination resets to 50 whenever a filter/search changes.
- **Configurable resumed-session idle timeout:** `PUT /project-settings` now accepts
  `missionSessionIdleCloseMin` (validated, clamped **1–1440** min), and a new **"Mission Control"**
  card in **Settings → Experiment** exposes it (default 30). The reaper reads it live, so a change
  applies on the next supervisor sweep — no restart.

## [0.1.102] — resume a mission's worker session in place (2026-06-26)

- **A mission's bound worker (executor) session can now be RESUMED in place**, preserving its
  context, instead of being status-checked (cloud) or replaced by a fresh session (native).
  - **Native** worker → `claude --resume <sid> --remote-control` in the same worktree — **keeps the
    original `sessionId`** (transcript continues) and re-bridges to the cloud relay. (Was: a brand-new
    session, losing context.) The `--resume` + `--remote-control` composition + sid-preservation are
    live-proven.
  - **Cloud** worker → wakes an idle worker (re-drive + `reBootstrap`); reports `gone` if terminal.
  - **Resume-only:** a terminal/unrecoverable session reports `gone` (or `conflict` for a native session
    that's live-but-unattachable); spawning a fresh worker stays a separate explicit action.
- Surfaces: the REST `POST /mission/session/:sid/resume` route now truly resumes; a new
  **`mission_session_resume`** MCP tool; the **controller agent's playbook** (system prompt +
  `guide("missions")`) now resumes-first before respawning; and the **Missions web UI** handles
  `ok`/`alive`/`conflict`/`gone` (with a "Start fresh worker" button on `gone`).
- New `core/src/mission/mission-resume.ts` (`decideCloudResume`/`decideNativeResume` + `resumeWorker`);
  `handleSessionResume` delegates to it. 42 tests across 4 suites.

## [0.1.101] — mission page: expand large UI elements to a full-screen overlay (2026-06-26)

- **Any large element on the mission page can now be maximized to a full-screen overlay** for
  comfortable viewing/editing, and collapsed back (Esc or a Collapse button). One reusable
  `FullScreenOverlay` (portal to `document.body`, covers the viewport incl. the nav; body scroll
  locked) serves every element; a `Maximize2` `ExpandIconButton` is the affordance.
- **Text fields (Objective / Plan / Next steps)** expand into a `MarkdownSplitEditor` — an
  Edit / Split / Preview toggle with a large textarea + a live `react-markdown` preview. The editor
  binds to the SAME draft state as the inline field, so Save, dirty-tracking, and edit persistence
  are unchanged; Next steps previews as a bullet list. Save + the "saved" indicator live in the
  overlay header.
- **Mission chat** and the **executor/session view** expand to full-screen too (reusing
  `MissionSessionChat` / `CcrCloudView`); `CcrCloudView` gained an optional `fill` prop so it grows
  to fill the overlay (inline rendering unchanged).
- Web-only change. Browser-verified on the dev web: split editor + live preview, live edit → preview
  update, Save persisted, Esc + Collapse, Next steps `<ul>`, full-screen chat.

## [0.1.100] — cloud-worker AskUserQuestion answer goes to the CLIENT control_response channel (2026-06-25)

- **Root-cause fix: a cloud mission worker (`ccr_cloud_start`, `/v1/sessions` BYOC) blocked on
  AskUserQuestion never proceeded after being answered.** `cloudAnswer` keyed off the teleport
  `tool_use_id` first and POSTed a `tool_result` to the `/v1/sessions/{sid}/events` **drive** channel —
  but such a worker's AskUserQuestion is a `can_use_tool` **control_request** that resolves ONLY via a
  `control_response` on the CLIENT channel `/v1/code/sessions/{sid}/events` (the web-UI path; the backend
  relays it to the worker). The drive-channel `tool_result` was silently ignored → the worker idle-suspended
  → the mission stuck `blocked` (mis-attributed to a "cloud infra bug"). Verified live on 123: a
  control_response wakes the worker and it writes its file; a drive `tool_result` does nothing.
- **Fix:** `cloudAnswer` now reads the client events channel first and prefers the control_response path
  whenever a client control_request is pending (or an explicit `requestId` is given) — regardless of a
  teleport tool_use. Falls back to the drive-channel `tool_result` only for a legacy teleport-only tool_use.
  Extracted the decision into a pure, unit-tested `chooseAnswerTransport()`. This makes the Mission
  Controller's `ccr_cloud_answer` actually resolve a worker's question so the mission completes.
- A worker answered LATE (already idle-suspended) wakes and re-asks a fresh question; the controller's
  next engage answers that one while connected and the worker proceeds — self-healing in ≤2 rounds.

## [0.1.105] — live-session remote-control connect (2026-06-26)

### Added
- Live-session remote-control connect: `ccr_connect` / `mission_session_resume` now
  reconnect a LIVE local session in place by injecting `/remote-control` (tmux on
  Linux, AttachConsole on Windows). Headless/unreachable live sessions are
  kill-and-resumed only when idle ≥ missionSessionIdleCloseMin, or with `force:true`;
  never resumed over a running process. New `force` param on both surfaces.

## [Unreleased → 0.2.0]

### CCR — bootstrap/guide now teaches operating Claude Code Remote sessions + the `ccr/` deploy fix (2026-06-21)

- **`guide(topic="ccr")` + bootstrap** now include a CCR playbook: the three modes (`ccr_load` read-only
  replay, `ccr_mirror` one-way live view, `ccr_connect` two-way drive), the operate flow
  (`cc_sessions`/`list_recent_sessions` → `ccr_preflight` → pick a mode by `allowedModes` → open the
  `claude.ai/code` webUrl → `ccr_remote_list`/`ccr_remote_stop`), and the connect SAFETY GATE
  (attach-existing / create-tmux / refuse-CONFLICT — never double-write a live session's append-only
  transcript). New `ccr` topic in TOPIC_TOOLS/GUIDES/BLURB/bootstrap-order + keyword aliases, so an LLM
  connecting over the langmart connector learns CCR without reverse-engineering the tool descriptions.
- **Fix: the `ccr/` bridge scripts were never shipped.** They weren't in package.json `files`, so the npm
  package (and every prod install) lacked `ccr/` — `ccr_load`/`mirror`/`connect` failed with
  `MODULE_NOT_FOUND` on prod. Added `ccr` to `files`; deploys must sync `ccr/` alongside `core/dist`.
  Verified end-to-end on prod after deploying it (load → claude.ai/code URL → list → stop).
- **Web UI — a new "CCR Remote" page** (sidebar): lists active CCR bridges (mode badge, session, URL,
  **Copy URL**, **Open**, Stop) and the host's Claude Code sessions (project, status, tmux, connectStrategy
  verdict) with per-session **Load / Mirror / Connect** buttons (Mirror/Connect gated by `allowedModes`;
  Connect is confirm-gated and shows the strategy; a `refuse` verdict is surfaced). Browser-verified.
- **Embedded session view + drive (`CcrSessionView`).** claude.ai sends `x-frame-options: SAMEORIGIN`, so the
  `claude.ai/code` page CANNOT be iframed cross-origin (and the OS deep-links it to the Claude app). Instead,
  **View here** renders the bridged session NATIVELY inside the CCR page — a live conversation (auto-refresh
  from `/sessions/:id/conversation`, tool calls shown) plus a **Drive** box, gated on the session being
  driveable. Same content the claude.ai page mirrors, no iframe/app. Browser-verified end-to-end.
- **Clear CCR error handling.** A failed Load/Mirror/Connect no longer shows a raw `API 409: {…}` blob — the structured error is parsed and turned into an actionable per-session message: **CONFLICT** → "a live process owns this session; use Load/Mirror instead"; **SESSION_NOT_FOUND** → "this session isn't on this host — CCR runs on the session's own machine; a remote session can't be connected from here"; **TIMEOUT** → "couldn't reach claude.ai/code; check the cookie". Errors render inline on the session card (dismissible); a started bridge with no claude.ai/code URL is flagged "couldn't reach claude.ai/code — Stop & retry".
- **Rich render like claude.ai/code (`CcrSessionView`).** The embedded view now renders the transcript richly: assistant/user text via **markdown** (`react-markdown`+`remark-gfm`, `.prose`), **thinking blocks** (collapsible, interleaved by line position), and **tool cards** — `formatToolCallString(name,input)` header (e.g. `Bash(cd …)`, `Browser.JavaScript(…)`) with a red **error** badge for failures and a collapsible result (`toolDetail=full`). Suppresses the `[N tool call(s)]` placeholder. Browser-verified.
- **Drive parity with the real claude.ai/code (captured via lm-proxy on 123).** The real CCR loop: claude.ai
  pushes/receives Claude Code transcript events over `…/worker/events` (+ SSE `…/worker/events/stream` for
  client prompts), and the bridge drives by **typing the prompt into the session's tmux** (`send-keys`, a
  clean USER turn). So the embedded Drive box now does the same — `POST /terminal/tmux/:name/send-keys
  {keys, literal, enter}` when the session is in a tmux (falls back to the `send_session_message` inject
  otherwise). The protocol is recorded in memory ([[reference-claudeai-web-ui-ccr]]).

### Scheduler — the built-in delete job is now DIRECT-ID-ONLY (no matching of any kind) (2026-06-21)

The built-in `cleanup-test-conversations` job now deletes **only the exact conversation ids in its verified
list** (`config.ids`), by **direct uuid match**. The handler does **NO name / pattern / TTL matching
whatsoever** — a conversation is deleted only if its exact id was added to the list; an empty list deletes
nothing. ids are uuid-validated; a 404 counts as "already gone", not a failure. Renamed to "Delete verified
conversation IDs"; seed config is `{ dryRun:true, ids:[] }` (unit-tested: empty id list, no patterns). This
makes an armed/scheduled run incapable of ever deleting a conversation that wasn't explicitly verified by id.
(Earlier iterations allowed name patterns, then TTL markers; this removes all fuzzy matching.)

### Scheduler — one-time jobs + MCP scheduling modes (one-time / recurring / trigger; dry/real/test) (2026-06-21)

- **One-time jobs** — `config.runAt` (ISO) makes a job run ONCE at/after that time, then complete (`isJobDue`
  fires once, `nextRunAtMs` points at runAt then null; `isOneTime`/`parseRunAt` helpers, unit-tested).
- **MCP `scheduler_jobs`** — three create modes, all in one call: ONE-TIME (`run_at="…ISO…"` or
  `in_minutes=N`, auto-enables), RECURRING (`interval_minutes` + `auto_run`), TRIGGER-ONLY (omit schedule →
  runs only via `run`/`test`). Run modes spelled out: `run` = real, `run`+`dry_run=true` = preview,
  `test` = capture-only verify (no schedule effect). State shows `one-time @ <time>` → `one-time · done`.
- **Web** — a "run once in (min)" create field (→ a one-time job); state badge `one-time` / `one-time · done`;
  fixed the next-run line to use the server's `nextRunAt` (one-time jobs now show their scheduled time).

### Scheduler — richer jobs: name/description, full run capture, conditions, easy MCP create/test (2026-06-21)

Substantial upgrade to the scheduled-jobs system:

- **Name + description** per job (display in UI / MCP listing; the built-in cleanup job is named).
- **Full run capture** — every run records a `JobRunRecord` (status, exit code, duration, stdout, stderr,
  trigger), surfaced as `lastRun` plus a bounded `runLog` history (newest-first ring, 20). The web card shows
  the last run (colored status · exit · duration · trigger) with an expandable stdout/stderr + history panel;
  output/stderr bounded to 8 KB/stream for storage.
- **Execution conditions** — `config.runIf` is a guard command: a SCHEDULED run only fires if it exits 0
  (logged as a `skipped` record otherwise). `config.maxRuns` stops auto-running after N real runs
  (`isJobDue` honors it; `runCount` tracks). Conditions gate scheduled runs; an explicit run/test bypasses them.
- **Test runs** — a `test` trigger executes once and captures full output but does NOT advance the schedule
  clock or run count (verification without side effects on scheduling).
- **REST** — create/PUT accept `name`/`description`; `POST /run` body `{test:true}`; new
  `GET /scheduler/jobs/:id/logs`; `/run` returns the full `lastRun`.
- **MCP `scheduler_jobs`** — flat params (`command`, `interval_minutes`, `auto_run`, `run_if`, `max_runs`,
  `cwd`, `timeout_ms`, `name`, `description`) folded into config so an LLM creates an auto-run job in one call;
  new actions `test` (returns status · exit · duration · stdout · stderr clearly) and `logs`. Tool description
  spells out "create an auto-run job" and "test-run + verify".
- New pure helpers unit-tested: `truncate`, `pushRunLog`, `reachedMaxRuns`, `applyRun`, `formatShellResult`
  capture fields (24 scheduler tests total).

### Scheduler — lm-assist's own internal scheduled-jobs system (not OS cron) (2026-06-21)

A self-contained job scheduler that runs INSIDE Core — no crontab/systemd-timers. Periodic Node timers, a
JSON-persisted job store (`<dataDir>/scheduled-jobs[-dev].json`), and a handler registry. It ticks once a
minute and compares timestamps (so a long interval is just "elapsed ≥ interval", never an oversized
`setTimeout` that would overflow Node's 32-bit timer cap). Starts on boot (`cli.ts`), stops on SIGINT/SIGTERM.

- **REST:** `GET /scheduler/jobs`, `GET/PUT/DELETE /scheduler/jobs/:id`, `POST /scheduler/jobs` (create),
  `POST /scheduler/jobs/:id/run` (manual trigger; `{dryRun:true}` forces a non-destructive preview).
- **MCP:** `scheduler_jobs` (action = list | get | run | update | create | delete) — connector-string args
  coerced (enabled/interval_minutes/dry_run); config accepts an object or JSON string.
- **Web UI:** a new **Scheduler** page (sidebar) — per-job card with enable/disable, interval, Preview run,
  and (for the cleanup job) an **Arm deletion** toggle gated behind an explicit confirm. Browser-verified.
- **Built-in job `cleanup-test-conversations`** (runs the `cleanup-test` sweep on a schedule). Ships
  **DISABLED + `dryRun:true`** — SAFE BY DEFAULT. A dry-run reports what WOULD be deleted; the default match
  set is only expired-TTL markers + explicit ids. Arming deletion (`enabled:true`, `config.dryRun:false`) is
  a deliberate operator action. Built-in jobs can't be deleted, only disabled. Pure scheduling logic
  (`isJobDue`/`nextRunAtMs`/`applyJobResult`/`makeBuiltinJobs`) is unit-tested, incl. the safety invariant.
- **Scripted (`shell`) jobs** — a generic handler that runs a command on the schedule (a true cron
  replacement). `config.command` as a STRING runs via a shell (cron-style pipes/`&&`/redirects); as an
  ARRAY `[bin, ...args]` runs via `execFile` (no shell, injection-safe). The command is OPERATOR input via
  the api-token-gated surface — same trust as a crontab line. Bounded timeout (`config.timeoutMs`, clamped
  1s–10m), 1 MB output cap, truncated one-line result; a dry-run preview reports the command without running
  it. Create from the web UI (type `shell` + a command textarea) or MCP/REST; jobs start disabled. The web
  card gains an inline command editor + a confirm-gated **Run now**. `formatShellResult`/`clampTimeoutMs`
  unit-tested.
- **Dry-run toggle for scripted jobs** — a `shell` command containing a `{{dryRun}}` placeholder is
  substituted with `config.dryRun` (default `true` = safe) at run time, so dry-run⟷armed flips from a
  **button** (the same Arm/Disarm control the cleanup job uses) instead of hand-editing the script. A forced
  preview always substitutes `true`; the job runs (safely) in preview when templated. `applyShellTemplate`
  unit-tested. The web card shows the Arm/Disarm toggle + `dry-run · safe`/`armed` badge for any job with the
  toggle (cleanup, or a templated shell job).

### claude.ai — conversation TTL (`autoDeleteHours`) + `cleanup-test` sweeper (safe-by-default) (2026-06-21)

Create-time AND update-time auto-deletion for throwaway conversations, plus the sweep that realizes it:

- **Set a TTL at create:** `createConversation({ autoDeleteHours })` — REST `POST /claude-ai/conversations`
  body `autoDeleteHours`; MCP `claudeai_create_conversation` arg `auto_delete_hours` — tags the name with a
  `[lm-autodel:<expiryMs>]` marker. It only TAGS the conversation; it deletes nothing.
- **Set / update / CLEAR the TTL on an EXISTING conversation:** `POST /claude-ai/conversations/:uuid/auto-delete`
  body `{ autoDeleteHours }` — `>0` (re)arms the TTL; `0` / null / omitted CLEARS it (strips the marker → the
  conversation will never be auto-deleted). Renames the conversation.
- **`POST /claude-ai/conversations/cleanup-test`** sweeps. **Two safety guarantees:** (1) `dryRun` is TRUE
  unless `dryRun:false` is passed — it only reports matches and deletes nothing; (2) the DEFAULT match set is
  ONLY conversations with a VALID, EXPIRED `[lm-autodel:…]` TTL (plus explicit `ids`). **A conversation with
  no / empty / invalid TTL is NEVER swept** unless the caller explicitly opts in via `patterns`. (A TTL value
  must be a plausible epoch-ms ≥ ~2020; `0`/empty/garbage → treated as no TTL.) Pure `matchTestConversations`
  + `withAutoDeleteMarker`/`parseAutoDeleteMs`/`stripAutoDeleteMarker` are unit-tested.

lm-assist's own approval probe now carries a 2h TTL backstop so a lingering probe self-cleans via the sweep.
Together: create (or update) a conv with a TTL, schedule the sweep (`dryRun:false`) daily, and it self-cleans.
The operator arms (`dryRun:false`) and schedules the sweep — i.e. owns the actual deletion.

### claude.ai — `claudeai_completion` tool-drive now works end-to-end (the `backend_execution` flag) (2026-06-21)

The driven flow (`claudeai_completion` / `POST /completion` with `enable_connector_tools`) now COMPLETES:
the claude.ai model calls the connector tool, it's auto-approved, and the result comes back. **Fix:** the
SPA-shaped tools array (`buildConnectorToolsArray`) was missing the registration flags claude.ai's own web
app sends — **`backend_execution: true`** (+ `needs_approval: false`, `is_mcp_app: false`). Without
`backend_execution`, claude.ai never routes the call to the connector and the tool's `/tool_approval`
returns 404 ("Tool result could not be submitted"); with it, the identical call returns **200 with the real
result** (verified end-to-end via the REST route: `data_catalog` → "OK — 5 datasets"). This resolves the
"does NOT unblock the programmatic drive" caveat in the two entries below.

### claude.ai — `set_connector_auto_approve`: enable "always approve" for a connector's tools (2026-06-21)

New API + MCP tool to turn ON (or off) per-version "always approve" auto-approval for ALL (or named) of a
claude.ai connector's MCP tools, so they don't prompt for per-call approval — **`set_connector_auto_approve`**
(MCP) / **`POST /claude-ai/mcp/servers/:uuid/auto-approve`** (REST). lm-assist reads each tool's CURRENT
always-approved key (`<uuid>:<tool>-<contentHash>`) from the live bootstrap so it matches claude.ai's current
tool defs, then read-modify-writes `enabled_mcp_tools` (preserving every other setting; refuses an empty
read). Default target: the langmart connector; default scope: all its tools. Pure core `buildAutoApproveMap`
is unit-tested.

Note: this smooths approval in the claude.ai web UI. It does NOT by itself unblock the *programmatic*
`claudeai_completion` drive — verified that even with always-approved set in both the account AND the
conversation, a script-driven connector-tool `/tool_approval` still 404s (claude.ai's internal `tool_search`
approves at 204; connector tools don't), an open claude.ai-backend behavior best resolved by one "Allow
always" in the real web UI.

### claude.ai — drive connector tool calls from `claudeai_completion` (+ approval bare-key fallback) (2026-06-20)

The MCP `claudeai_completion` tool (and the REST `/claude-ai/conversations/:uuid/completion` route) can
now DRIVE a claude.ai conversation to CALL lm-assist connector tools, not just chat:

- New params **`enable_connector_tools`** (true = all the langmart connector's tools, or a list of tool
  names), **`auto_approve_tools`** (default ON when enabling), and a raw **`tools`** passthrough.
  lm-assist builds the claude.ai SPA tools array from the worker's own tool defs + the discovered
  connector identity (`listMcpRemoteServers` + `buildConnectorToolsArray`), so callers don't hand-craft
  it. Previously the tool sent `tools:[]`, so a driven model replied *"those tools aren't exposed to me
  here."*
- **Approval bare-key fallback:** `approveToolUse` now retries `/tool_approval` with the bare
  `<srv>:<tool>` key when the hash-suffixed key 4xxs (a stale content-hash — e.g. after a connector
  refresh changes tool defs) — previously a stale hash dead-ended with no recovery.

Known limitation: connector-tool auto-approval needs claude.ai's CURRENT per-tool content-hash; a
`refresh_connector_tools` invalidates the account's always-approved hash until the connector re-syncs (or
a one-off UI approval re-establishes it), so a driven tool call can 404 at the approval step until then.

### MCP connector skill + precise session identification — bootstrap / guide / session_status (2026-06-20)

The langmart MCP connector now ships its own "skill" so an LLM is proactively capability-aware even when
local skills / CLAUDE.md aren't loaded in the conversation (the connector is always reachable). **Unreleased
/ ships in `main` for review; rolled out to the fleet by syncing `core/dist`.**

- **`bootstrap`** (call once, no args) loads ALL use cases in one response; the server `instructions`
  direct the LLM to call it first on connect. **`guide(topic)`** re-reads a single playbook (single-node +
  cross-node recipes for every feature, plus combination workflows). Framed as COMPLEMENTING local
  CLAUDE.md / memory / skills, not replacing them.
- **Precise caller identification (`session_status` + bootstrap):** the connector tags each `tools/call`
  with `_meta["claudecode/toolUseId"]` — the calling conversation's `tool_use` block id. lm-assist matches
  it against the session cache to pin the EXACT Claude Code session driving the call (deterministic), and
  hands the id back so the session becomes self-aware. Falls back to recency (most-recent claude.ai
  conversation + Claude Code session, "pick your runtime") when no id is present. Threaded via a
  per-request `McpCallContext.toolUseId` ALS.
- claude.ai-web callers use the same `toolu_…` id format, but whether they forward it in `_meta` is not yet
  confirmed (the capture needs a successful tool-approval), so they remain recency-resolved by design.

### Data service — type-aware records, partial retrieval, richer queries, non-blocking SQLite (2026-06-20)

Refinement passes over the generic data service (below), all live-verified through the connector.
**Unreleased / opt-in (`dataServiceEnabled`); ships in `main`, rolled out by syncing `core/dist`.**

- **Type-aware records:** `detectType` classifies values as bin / text / json / code (+ language); record
  summaries report type/size/lang. **Partial retrieval** in `data_get`: field / part-id / JSON-path, `grep`
  (line numbers) and `lines` (ranges), with offset/limit in the type's natural unit.
- **Richer queries:** `regex` / `wildcard` / `nin` / `exists` operators alongside the existing set.
- **Security hardening:** ReDoS guard + input cap on regex, `lines` set-bomb guard, boolean-SQL-bind crash
  fix, prototype-path block, 1 MiB record cap.
- **Perf / non-blocking / disk:** bounded cache scan, SQL default-LIMIT + busy_timeout, audit-log
  ring-buffer (avoids the 256 MB `MDB_MAP_FULL` cliff), `-lock` leak cleanup, and **better-sqlite3 moved to
  a `worker_thread`** so it no longer blocks the `:3100` event loop.

### claude.ai — `create_conversation → completion` works on the first turn (2026-06-20)

A freshly-created (empty) conversation has no `current_leaf_message_uuid`, so `claudeai_completion`
dead-ended with *"no current_leaf_message_uuid (empty thread?)"*. Both completion paths (the cookie-file
`sendMessage` and the via-chrome browser-JS snippet) now fall back to claude.ai's first-message ROOT parent
(`00000000-0000-4000-8000-000000000000`), so the documented create→completion flow works on the first
message. Verified live (HTTP 200).

### Windows terminal-driving / `send_session_message` — fix silent failure under Session 0 isolation (2026-06-19)

`send_session_message` (and every terminal-drive op) to a Windows Claude session failed with "no driver
delivered" / `driveable:false`. **Root cause: Windows Session 0 isolation.** When the Core is started
over SSH (or as a Session-0 service) it runs in **Session 0**, but the user's Windows Terminal + claude
sessions run in the interactive **Session 1**. A Session-0 process cannot `AttachConsole` to a Session-1
console (`ACCESS_DENIED`), so screen-capture / title-locate / key-injection all fail. The old `driveable`
gate keyed on a non-empty console title and mis-reported this as "no title" — the title only read empty
*because the attach failed*. `lm-assist restart` over SSH silently regressed this every time.

- **Diagnostics** (`terminal/windows-terminal.ts`, `windows-cc.ts`): `mapPidsToWindows` now bases
  `driveable` on the Windows-**session match** between the target pid and the Core (the accurate
  condition) rather than the fragile non-empty-title proxy, and emits `sessionId`/`coreSessionId` + a
  `reason` (e.g. *"cross-session: target in session 1 but lm-assist Core runs in session 0 (Session 0
  isolation) — run the Core in the interactive desktop session"*). `GET /terminal/cc-sessions` and the
  capture error now surface this instead of failing silently / misleadingly ("pid has no console?").
- **Operational fix**: the Windows Core must run in the interactive Session 1 to drive the user's
  terminals — established a durable interactive auto-start (`LmAssistCoreInteractive`, `LogonType
  Interactive`). After moving the Core to Session 1: **11/12 live sessions `driveable:true` (was 0/12)**,
  titles readable, delivery path restored. Verified on 192.0.2.7.

### Generic data service — multi-backend data/RAG with access control, sync, REST + MCP (2026-06-18)

A new generic data service (`core/src/data/`) exposing pluggable storage backends through a uniform
REST (`/data/*`) and MCP (`data_*`) surface, with access-key control, secret redaction, and engine-level
cross-node sync. **Unreleased / opt-in:** gated behind `dataServiceEnabled` and not yet published to npm;
the feature ships in `main` for review and is rolled out to the fleet by syncing `core/dist`.

- **Backends:** `cache` (LMDB), `vector` (LanceDB + 384-dim embedder, RRF hybrid search), `sql`
  (better-sqlite3 + FTS5, parameterized QuerySpec→SQL compiler, lazy-required so Core boots where the
  native binary is absent), plus read adapters over existing stores (`knowledge`, `vectors`) and a
  read-only `file` tracker (allow-listed logs/JSON, content-scrubbed).
- **Access + safety:** scoped, expiring access keys; principal model (loopback/stdio = `local` root vs
  hub-relayed = `cloud`, unspoofable — the relay strips client trust headers); field-name + inline-secret
  redaction on every record-return surface; hard-exclusion of credential paths (incl. LIVE trading creds).
- **Cross-node sync:** engine-level full/partial replication with version + LWW reconciliation, batched
  change events; node-targeting is hub-routed.
- **Management (local-only, LLM-legible):** REST `POST/DELETE /data/datasets`, `GET /data/keys`,
  `POST /data/sync`; MCP `data_create_dataset`/`drop_dataset`/`keys`/`revoke_key`/`sync`/`sync_status`,
  all gated to a local principal with an actionable remote-denial message; `data_catalog` reports
  `you.{principal, canManage}` so a session knows whether it can manage. A remote/cloud session cannot
  create/drop datasets, manage keys, or trigger sync.
- **Web `/data` page:** Datasets (list/create/drop), Access Keys (list/revoke), and Sync
  (status/reconcile) tabs, capability-gated to mirror the local-only model.
- **Fix — MCP `/mcp` build no longer crashes Core:** every advertised MCP tool now has a `TOOL_SCOPES`
  entry. `data_search`/`data_admin` and the management tools previously lacked scopes, so
  `assertScopesCoverTools()` threw inside the StreamableHTTP `/mcp` server build on the first hub-relayed
  request — crashing the worker. Added the missing scopes + a regression guard.
- **Fix — server binds the resolved `--host`:** `cli.ts` resolved `--host` (default `0.0.0.0`) and printed
  it in the banner but never passed it to `startServer`, so `rest-server.ts` always fell back to
  `127.0.0.1`. The host is now threaded through.

### MCP cross-host tools — fix categorical failures on non-`/home/ubuntu` and Windows workers (2026-06-16)

The langmart MCP's cross-host / multi-node tools failed wholesale when targeting a worker whose home
isn't `/home/ubuntu` (node-b `/home/yi`, Windows `C:\Users\yi`), or when running a command on a Windows
node. Surfaced by a cross-host test session (`ee045a79` on 192.0.2.23) where every failure clustered in
the multi-node path.

- **cwd allowlist no longer hardcodes `/home/ubuntu`** (`utils/cwd-allowlist.ts`): `isCwdAllowed` now
  gates on the EXECUTING worker's own home dir (`os.homedir()`) — the correct basis, since these tools
  run on the node they target (the hub relays the call there). Fixes `agent_execute` / `terminal_open_tab`
  being rejected on every non-ubuntu worker. `home` is injectable for tests; messages + schema text updated.
- **`terminal_open_tab` works on Windows and forwards all params** (`mcp-server/tools/open-tab-plan.ts`,
  new pure planner): omit `kind` → routes to the platform-neutral `/terminal/local` (tmux on Linux, wt on
  Windows — the Windows path); an explicit `kind` → `/terminal/tabs` with `sshTarget`/`tmuxSession` now
  forwarded. Previously the handler dropped them, so `wt-ssh`/`tmux` always failed "requires X" even when
  supplied. Schema documents `sshTarget`/`tmuxSession` and the optional, platform-aware `kind`.
- **MCP loopback errors now include the response body** (`mcp-server/tools/_passthrough.ts`): a non-2xx
  without a structured `error.message` surfaced only "`<route> returned 400`" — the body (the actual
  reason) was dropped, making `fs_list` / `transfer_send_file` failures undiagnosable. The 4 duplicated
  parse-and-throw blocks are consolidated into one `unwrapEnvelope` that carries the body.
- Unit tests added for all three (`cwd-allowlist`, `open-tab-plan`, `passthrough-unwrap`).

### Worker API token — rotation timer no longer overflows Node's 32-bit cap (2026-06-15)

The API-token rotation interval now defaults to **30 days** (was 24h). 30 days in ms (2,592,000,000)
exceeds `setTimeout`/`setInterval`'s signed-32-bit cap (~24.8 days, `MAX_TIMER_MS` = 2,147,483,647);
Node silently clamps an over-cap delay to ~1 ms, so the daemon rotated the token in a tight loop and
every client's cached token aged out instantly → a storm of `401`s. Fixed by replacing the single
`setInterval` with a self-rescheduling `setTimeout` that counts the window down in `<= MAX_TIMER_MS`
chunks and only rotates once the full `ROTATE_MS` window has elapsed, then re-arms. Works for any
interval; keeps the 30-day default and the `LM_ASSIST_API_TOKEN_ROTATE_MS` override.

- `core/src/auth/api-token.ts`: `ROTATE_MS` default `30 * 24 * 60 * 60 * 1000`; chunked countdown via
  the `MAX_TIMER_MS`-capped `setTimeout` loop.

### CLI `start` defers to systemd when a unit manages the worker (2026-06-15)

`startCore()` no longer spawns a competing worker when an `lm-assist.service` systemd unit already
manages the host. The systemd service runs `serve` directly with no PID file, so it is invisible to
the health probe during its startup/restart window — the CLI would otherwise spawn a second instance
that crash-loops on `EADDRINUSE`. Now, if the worker isn't yet health-responsive, `start` checks
systemd first and bows out with guidance (`sudo systemctl restart lm-assist`); if some other
non-systemd instance already holds the API port, it reports that instead of duplicating.

- `core/src/service-manager.ts`: `isManagedBySystemd(unit)` (queries `systemctl is-active` /
  `is-enabled`, Windows-safe no-op) + a port guard in `startCore()` before spawning.

### Generic terminal route is platform-neutral — backend auto-picked (2026-06-10)

The generic terminal route no longer carries the backend in its URL. It was `/terminal/wt/*`, which
forced the caller to know the host's OS. lm-assist already knows its own platform, so the route is now
`/terminal/local/*` and dispatches through `getTerminalBackend()` — tmux on Linux, wt on Windows —
resolved per request. The Claude-Code layer (`/terminal/cc-sessions/*`) already auto-picked via
`getCcController()`; this brings the generic layer to parity.

- `terminal-std.routes.ts`: `/terminal/wt` → `/terminal/local` (GET list, POST create, GET `:id/capture`,
  POST `:id/send-keys`, DELETE `:id`); dropped the hardcoded `wtTerminalBackend` import. `NOT_SUPPORTED`
  reports the resolved backend id.
- MCP `expanded.ts`: the pid-path of `windows_terminal_capture`/`_state` and `windows_terminal_launch`
  now hit `/terminal/local/*`.
- The richer tmux-native low-level routes stay at `/terminal/tmux/*` (Linux only) — unchanged.

### Session-messaging: unified sessionId-keyed cc-session injection driver (2026-06-10)

Follow-on to the standardized terminal interface. The cross-node session-messaging injection layer was
platform-split (`cc-prompt` for Linux tmux, `windows-terminal` for Windows). Merged into ONE
`cc-session` driver that is **sessionId-keyed and cross-platform**, driving via the unified
`/terminal/cc-sessions/*` API (the CcController resolves the Claude sessionId to a tmux pane on Linux or
a WT tab on Windows).

- `InjectionDriverName`: `cc-prompt` + `windows-terminal` → `cc-session`. Chain is now
  `[remote-control, cc-session, tmux-send-keys]`.
- `cc-session.available` = the session is `driveable` in `GET /terminal/cc-sessions`; `deliver` =
  `POST /terminal/cc-sessions/:id/prompt`. `tmux-send-keys` stays the raw tmux-NAME fallback.
- `send_session_message.toSession` is now a Claude sessionId for the cc-session/remote-control drivers
  (or a raw tmux name for the send-keys fallback) — updated the tool description.
- The tmux-native low-level layer `/terminal/cc/:name/*` (and the `terminal_*` MCP tools) is kept as the
  name-keyed generic CC access, parallel to `/terminal/tmux/*` — not forced onto sessionId, since it is
  a tmux-native handle.
- Verified: 117 (Linux) deploy + runtime smoke of the unified routes passed (cc-sessions list+verdict,
  sessionId→tmux bridge, screen capture+classify); Windows full CC cycle. tsc clean both.

### Standardized terminal interface + unified cross-platform routes (2026-06-10)

Unify the Windows and Linux terminal / Claude-Code surface at the INTERFACE level (not just URLs), so
the same grammar behaves identically on both. Foundation for any future terminal backend.

- **Shared interfaces** (`terminal/backend.ts`): `TerminalBackend` (generic list/create/capture/sendKeys/
  close, opaque id) and `CcController` (Claude ops keyed by the cross-platform Claude sessionId:
  list/verdict/launch/prompt/screen/auto-handle/interrupt/close) + a registry that picks the platform
  backend. `tmux-backend.ts` adapts tmux.ts + cc.ts; `wt-backend.ts` adapts windows-terminal.ts +
  windows-cc.ts. `cc-classify.ts` is the shared screen classifier both use.
- **Unified routes** (`terminal-std.routes.ts`), dispatch through the interfaces:
  - `GET/POST /terminal/cc-sessions`, `GET/DELETE /terminal/cc-sessions/:id`,
    `POST /terminal/cc-sessions/:id/{prompt,auto-handle,interrupt}`, `GET /terminal/cc-sessions/:id/screen`
    — sessionId-keyed, SAME on Linux and Windows.
  - `GET/POST /terminal/local`, `GET /terminal/local/:id/capture`, `POST /terminal/local/:id/send-keys`,
    `DELETE /terminal/local/:id` — platform-neutral generic terminal; lm-assist auto-picks its own
    backend via `getTerminalBackend()` (tmux on Linux, wt on Windows). The caller never names the OS.
    The richer tmux-native low-level routes remain at `/terminal/tmux/*` (Linux only).
- **Hard rename (Windows):** removed `/terminal/windows/sessions/*`, `/terminal/windows/{windows,launch,
  capture,state,auto-handle}` — replaced by `/terminal/cc-sessions/*` + `/terminal/local/*`. Updated the
  session-messaging `windows-terminal` injection driver and the 8 MCP `windows_terminal_*` tools to the
  new paths. The legacy Linux `/terminal/tmux/*` and `/terminal/cc/:name/*` routes are unchanged (their
  consumers — the `cc-prompt`/`tmux-send-keys` drivers and MCP `terminal_*` tools — are tmux-NAME-keyed;
  re-keying that chain to sessionId is a separate, 117-tested migration).
- Web reviewed: the dashboards use ttyd + process-status, not these control routes — unaffected.
- Verified e2e on windows-desk: `GET /terminal/cc-sessions` (8 sessions), full CC cycle
  (create/screen/prompt/auto-handle/delete), generic `/terminal/local` list + capture + close, old routes
  now 404. tsc clean (Linux adapter compiles; 117 runtime smoke pending).

### Windows terminal — split into a GENERIC driver + a Claude Code layer (2026-06-10)

Refactor so the Windows terminal control is a generic primitive (drive ANY console program), with
Claude Code as one layer on top — mirroring the Linux split (`cc.ts` on `tmux.ts`).

- **`terminal/windows-terminal.ts` (generic, Claude-free):** the PowerShell engine + `mapPidsToWindows`,
  `locateWindow`, `focusAndSend` (text/keys/paste by pid|rid), `captureScreen`, `listTabIds`, the tab-rid
  cache (`get/set/forgetTabRid`), `closeWindow`, and now **`spawnTerminal({cwd,command,mode})`** +
  **`launchWindow({command,…})`** — launch and handle for *any* command.
- **`terminal/windows-cc.ts` (Claude Code layer, NEW):** imports the generic driver and adds the
  Claude-specific bits — `listWindowsSessions` (cc-sessions → windows), `launchSession` (claude +
  resume + auto-trust), `classifyScreen`, `autoHandle`. Other terminal apps reuse the generic driver
  without any of this.
- **Generic routes added:** `GET /terminal/windows/windows` (raw WT/conhost tab list) and
  `POST /terminal/windows/launch {command,cwd?,mode?}` (run any command). The Claude session routes
  (`/terminal/windows/sessions/*`) are unchanged.
- **Generic MCP tool added:** `windows_terminal_launch` (run any command); the 7 Claude tools unchanged.
- **Dependency review (done before the change):** the only consumer is the `session-messaging`
  `windows-terminal` injection driver, which uses the HTTP routes `GET /terminal/windows/sessions/:id`
  and `POST …/:id/send` (no direct module import) — both preserved. One behavior note: `/send` now
  returns `success:false` when it can't truly focus (instead of silently losing the keystrokes), so the
  messaging layer correctly falls through to its `remote-control` driver.
- Verified e2e after the split: session-messaging contract (`GET :id` driveable, `POST :id/send`),
  generic `launchWindow` (ran a plain `cmd`), generic window list (13 tabs), Claude auto-trust create
  (`trustHandled:true`, registered driveable), classifier, and MCP tools/list (8 windows tools).

### Windows terminal — screen-state classifier + auto-handlers + reliable input + MCP (2026-06-10)

Builds on screen capture: classify what a Windows Claude Code session is showing and react
automatically (most importantly auto-accepting the folder-trust prompt), plus a focus-free input path
and MCP tools for the whole Windows terminal surface.

- **`classifyScreen(text)`** → one of: `folder_trust`, `await_question`, `rate_limit_user`,
  `rate_limit_server` ("Server is temporarily limiting requests (not your usage limit)"), `overloaded`
  (529 / "Waiting for capacity"), `server_error` (5xx), `auth_error` (invalid key / expired OAuth /
  credit too low / needs `/login`), `busy`, `idle`, `unknown` — with `detail`, `options`, `retryHint`.
  Patterns derived from the real Claude Code CLI strings. (9/9 synthetic cases pass.)
- **Auto-handlers**: `autoHandle(pid,{trust,answer})` — auto-accepts folder trust (default) or answers a
  numbered prompt; other states (rate limits, server/auth errors) are reported, not actioned. **Create
  now auto-trusts** by default: if registration is blocked, it finds the new claude pid, confirms the
  trust screen, and accepts it — `create` returns `trustHandled:true` and the session registers.
- **Reliable, focus-free key injection** (the important fix): `WScript.Shell` SendKeys does NOT reach a
  Windows Terminal pane from a background service even when "focused", so menu answers were silently
  lost. Keys now go straight into the console input buffer via `AttachConsole` + `WriteConsoleInput`
  (CONIN$) — delivered to claude as typed input regardless of focus. Text *paste* still uses
  foreground+clipboard, but now verifies foreground (disable foreground-lock timeout + Alt-nudge +
  check) and returns an error instead of misfiring into the wrong window.
- **Routes**: `GET …/:sessionId/state` and `GET /terminal/windows/state?pid=N`; `POST …/:sessionId/auto-handle`
  and `POST /terminal/windows/auto-handle?pid=N` (`{trust?,answer?}`).
- **MCP tools** (7, via the expanded catalog): `windows_terminal_list`/`_capture`/`_state` (read),
  `windows_terminal_create`/`_send`/`_auto_handle`/`_close` (write). Verified over the loopback `/mcp`:
  tools/list advertises all 7; tools/call `windows_terminal_list` round-trips.
- Verified e2e on windows-desk: created in an UNTRUSTED dir → auto-trust accepted the prompt → session
  registered driveable; auto-handle flipped a stuck session `folder_trust`→`idle`; classifier 9/9.
- Finding (unchanged): `skipPermissions` does NOT bypass folder trust — that's exactly why auto-trust
  via the trust prompt is needed.

### Windows terminal — screen capture (tmux capture-pane equivalent) (2026-06-10)

Read the visible text of any console-hosted process's terminal — the missing observability piece for
the Windows terminal driver (you could focus/type/close a session but not see what it was showing,
e.g. a claude stuck at the folder-trust prompt that never registers a session).

- Engine `capture` action: `AttachConsole(pid)` + open `CONOUT$` + `ReadConsoleOutputCharacterW` over
  the viewport rows (with ConPTY, the hidden conhost's screen buffer mirrors what Windows Terminal
  renders). Passive — no focus change, no input. Text returned base64 to survive the JSON/console hop.
- `captureScreen(pid)` in `terminal/windows-terminal.ts`.
- Routes: `GET /terminal/windows/sessions/:sessionId/capture` (registered sessions) and
  `GET /terminal/windows/capture?pid=N` (raw pid — for pre-registration processes like a trust-prompt
  stuck claude, or any console program).
- **Engine encoding fix**: the materialized `.ps1` is now written with a UTF-8 BOM, and the embedded
  engine is kept strictly ASCII. PowerShell 5.1 parses BOM-less files as the ANSI codepage (cp950 on
  zh-TW systems), where a multi-byte char's tail byte can swallow a closing quote and break the whole
  script — an em-dash inside a quoted string did exactly that.
- Verified e2e on windows-desk against the rotating-token gate (401 without `x-api-key`, 200 with):
  captured a live Claude session's screen (prompt + status bar) and read a folder-trust prompt
  verbatim off a stuck, never-registered claude by raw pid. Also re-validated the full CRUD on latest
  main: create/read/send-via-RuntimeId/focus/delete (single-tab window close + multi-tab sibling
  survival) and resume (returns the resumed sessionId). Finding: `skipPermissions`
  (`--dangerously-skip-permissions`) does NOT bypass the folder-trust prompt — an untrusted-cwd launch
  still sticks pre-registration; use the capture endpoint to see it.

### Worker API — rotating token security gate + localhost bind (2026-06-09)

Every worker API route now requires a rotating API token — a separate secret from the langmart hub
key, never exposed to the LLM/MCP (read from disk and attached server-side).

- **Worker-owned token**: generated on boot, written to `<dataDir>/api-token` (mode 0600), rotated
  (default 30 days) keeping a **ring of the last N (default 3) tokens valid at once** — grace so rotation
  never 401s an in-flight client; an aged-out token gets `401` and the client re-reads the file +
  retries. Sent as `x-api-key` (or `?apiKey=`). `/health` is the only exempt route. Kill-switch
  `LM_ASSIST_API_AUTH=0`; tune via `LM_ASSIST_API_TOKEN_RING` / `LM_ASSIST_API_TOKEN_ROTATE_MS`.
- **All in-process loopback callers inject it** — the hub-relay forwarder (covers all connector /
  remote-control traffic), MCP `_passthrough` + `api-client`, console-relay, session-cache-sync,
  knowledge/*.
- **Worker API binds `127.0.0.1` by default** (was `::` / all interfaces); `LM_ASSIST_API_HOST` to
  override. The connector keeps working — it reaches the worker over the outbound hub WS + loopback
  dispatch, not the bound port.
- **`LM_ASSIST_API_AUTH_EXEMPT_LOCAL=1`** — trust `is-local` requests (a local-desk browser whose
  prebuilt web can't carry the token); LAN/remote callers still require it.
- **lm-assist web** injects the token into the page (`window.__LM_API_TOKEN__`, server-side in the
  root layout) so browser calls carry it.

### Filesystem inspect interface + `fs_list` filter + absolute-path copy (2026-06-09)

- `fs_drives` / `fs_list` / `fs_stat` over the node-to-node transport — browse drives → directories →
  files on any owned node (whole filesystem; the hub same-user gate is the trust boundary). In-memory
  TTL cache with explicit dirty-on-write + per-call `refresh`; shallow + entry-capped (never recurses).
  New `FT_FS` wire op + `requestFs` peer helper; REST `POST /storage/{drives,list,stat}`.
- `transfer_send_file` accepts an **absolute** destination (single file → that path, directory →
  entries under it); a relative path still lands under the receive-root.
- `fs_list` optional `pattern` — shell glob (`*`, `?`) by default, JS regex with `regex:true`; filters
  names **before** the per-entry stat, so it's cheaper on huge directories.

### Node-to-node transport, file/dir transfer + firehose (2026-06-04 … 06-09)

- **Transport**: ICE-style ladder (host/static direct → public-IP STUN punch → relay), RELAY/ONEWAY/
  BIDI state machine, hybrid relay-floor + opportunistic per-direction direct, type-based control/data
  plane split (control always relay + priority), peer-endpoint roaming (NAT rebind), fixed-port mode.
- **File/dir transfer**: size-adaptive (tiny relay one-shot, large 256K reads), typed errors +
  retry-with-backoff, relay fallback if a direct channel stalls.
- **Firehose** (default-on for large single-file direct paths; `LM_FIREHOSE=0` to disable):
  Aspera/UDT-style unreliable rate-paced data plane + out-of-band NACK repair; delay-based rate control
  (FASP/LEDBAT) driven by receiver-measured queuing delay.
- **Stats + latency**: per-transfer data-plane stats (bytes/elapsed/instant+avg MB/s, mode/via, p2p
  RTT via a clock-independent echo probe) at `GET /transport/stats`; async **send queue**
  (`POST /transport/send-file` enqueues + returns a jobId, `wait:true` for sync; `GET /transport/queue`;
  `LM_SEND_CONCURRENCY`); per-forward traffic stats + ping/pong RTT at `GET /port-forward/stats`.
- **Port-forward**: node-to-node TCP over the hub WS; opt-in `exposeLan` (LAN-IP bind, default loopback).
- **MCP tools**: `transfer_send_file`, `transfer_list_remote`, `transfer_stats`, `transfer_queue`,
  `port_forward_stats` (+ `exposeLan` on `open_port_forward`).

### Cross-node session messaging + drivers (2026-06-08)

Session-to-session messaging across nodes (`send_session_message` / `list_session_messages` /
`get_message_status`) with remote-control (claude.ai RC) and Windows-terminal injection drivers.

### Record-level memory + rules map (2026-06-06)

Record-level, project/node-aware MEMORY + RULES map: detect/register (snapshot + delta) with graded
confirmation, Opus deep-validation (code + session verified), reconciliation/dedup, an apply pipeline
(frontmatter-aware, preview-first write), cross-node autosync (observe-default) + harvest daemon
(default-off). MCP tools `memory_map` / `memory_record` / `rule_map`; HTTP `/memory/map`.

### Windows terminal control — query + drive Claude Code sessions (2026-06-05)

The Windows substitute for the Linux tmux send-keys API. Windows has no tmux, so interactive Claude
Code sessions run directly in Windows Terminal tabs. This lets lm-assist enumerate those live sessions
and drive a specific one by PID — bringing its window/tab to the front and pasting text.

- New module `core/src/terminal/windows-terminal.ts`: maps a live session's pid to the exact WT window
  + tab (or conhost window) and drives it (focus + paste). The pid→tab match is **authoritative, not a
  guess**: rather than reading the tab title (which Claude Code owns and rewrites as the conversation
  summary — it drifts and races), the engine WRITES a unique marker into the target pid's console title
  (`AttachConsole` + `SetConsoleTitle` — verified to propagate through ConPTY to the WT tab strip),
  finds the tab showing that marker via UI Automation, selects it, and restores the original title.
  Drive-time resolution is therefore drift-proof. Supporting pieces: parent-chain walk (Toolhelp32) to
  the terminal host for `kind`/`driveable`; non-destructive console-title read for listing
  (child/subagent pids inherit the hosting tab's console); UIA window enumeration by class
  (`CASCADIA_HOSTING_WINDOW_CLASS`/`ConsoleWindowClass`), not `MainWindowHandle` (WT puts many windows
  in one process); foreground preserves maximized state (`IsIconic`-gated `SW_RESTORE`).
- Full CRUD over WT tab sessions via `core/src/routes/core/windows-terminal.routes.ts`:
  - `POST   /terminal/windows/sessions` — **create**: launch a new Claude session in a WT window
    (`mode:'window'|'tab'`, optional `cwd`, `resume`); correlates the new sessionId from the registry.
    On `resume`, matches the resumed id specifically — `claude --resume <id>` briefly registers a
    transient startup id before settling onto `<id>`, so the diff-by-new-id would otherwise return the
    transient. Resume a NON-live session only (live resume would double-write the transcript).
  - `GET    /terminal/windows/sessions` — **read** all: live CC sessions + window mapping + `driveable`
  - `GET    /terminal/windows/sessions/:sessionId` — **read** one (Linux verdict + Windows window mapping)
  - `POST   /terminal/windows/sessions/:sessionId/focus` — bring its window/tab to the front
  - `POST   /terminal/windows/sessions/:sessionId/send` — **update**: focus + paste `{ text, submit? }`
  - `DELETE /terminal/windows/sessions/:sessionId` — **delete**: terminate the session
    (`?closeTab=true` also closes the tab/window). Closes through the WT UI — `WM_CLOSE` for a
    single-tab window, select-tab + `Ctrl+Shift+W` for a multi-tab window (closes only that tab,
    siblings survive) — then a WMI-free process-tree kill (parent map + `Stop-Process`) as a backstop.
    Just killing the process is NOT enough: WT's default `closeOnExit:graceful` keeps an
    abnormally-exited pane on screen as "[process exited]", so the window must be closed via the UI.
  - Non-Windows hosts return `NOT_SUPPORTED` (use the tmux API there).
- Two-tier tab targeting: for sessions we **create**, the new tab's UIA `RuntimeId` is captured at launch
  (diff the tab set) and cached — a title-independent handle that drives even a freshly-launched session
  whose title is still animating. For pre-existing sessions, the console-title **marker** method
  (`AttachConsole`+`SetConsoleTitle` → propagates through ConPTY to the WT tab strip → UIA match →
  select → restore) is the drift-proof fallback. Foreground preserves maximized state
  (`IsIconic`-gated `SW_RESTORE`).
- **Gotcha fixed:** the launch must pass `windowsHide:false` — the shared `spawn` wrapper defaults
  `windowsHide:true`, which opens the terminal window hidden (`IsWindowVisible=false`) so it never enters
  the UIA tree and can't be located/driven.
- Supporting pieces: parent-chain walk (Toolhelp32) to the terminal host for `kind`/`driveable`;
  non-destructive console-title read for listing (child/subagent pids inherit the hosting tab's console);
  UIA window enumeration by class (`CASCADIA_HOSTING_WINDOW_CLASS`/`ConsoleWindowClass`), not
  `MainWindowHandle` (WT puts many windows in one process).
- Reuses the cross-platform `listLiveSessions`/`sessionVerdict` from `cc-sessions.ts`.

Verified e2e on windows-desk (lm-assist :3199): full CRUD cycle — **create** a session (new WT window,
sessionId + RuntimeId captured), **read** it in the list (driveable), **update** it immediately via the
captured RuntimeId while its title was still animating (HTTP 200, title-independent), **delete** it with
`closeTab` (whole subtree killed, window closed, session GONE). Separately: the marker method drives
pre-existing sessions including one whose summary had drifted (which passive title-matching had missed);
8 driveable WT tabs listed (subagent/SDK sessions correctly excluded).
### claude.ai marketplaces + plugins -- cookie-path routes + MCP tools (2026-06-03)

Mirrors the claude.ai web UI's plugin-marketplace screen on the cookie-file `/claude-ai/*` surface so a
headless caller can manage marketplaces (each a GitHub repo with `.claude-plugin/marketplace.json` at its
root) and the plugins within them. Verified end-to-end against live claude.ai.

- **New cookie WRITE helpers** in `claudeai-session.ts` -- `claudeaiPost`/`claudeaiPut`/`claudeaiDelete` share
  one `buildBrowserHeaders()` (extracted from `claudeaiGet`) so writes carry an IDENTICAL browser fingerprint,
  differing only by HTTP method + JSON body. Plus typed helpers `listMarketplaces`, `createAccountMarketplace`,
  `deleteAccountMarketplace`, `listAccountMarketplacePlugins`, `listPlugins`, `setPluginEnabled`,
  `deleteMarketplacePlugin`, and `normalizeGithubSourceUrl` (accepts `owner/repo`, full URL, or SSH form).
- **7 routes** under `/claude-ai/marketplaces` + `/claude-ai/plugins` (list/create/delete marketplaces,
  list/delete marketplace plugins, list default-marketplace plugins, enable/disable a plugin). Route order is
  first-match-wins: `/:id/plugins[/:pid]` precede the bare `DELETE /:id`.
- **6 MCP tools** wrapping them (`claudeai_list_marketplaces`, `claudeai_add_marketplace`,
  `claudeai_remove_marketplace`, `claudeai_list_marketplace_plugins`, `claudeai_list_plugins`,
  `claudeai_set_plugin_enabled`) with read/write scopes registered in `configure.ts`; new `workerPut` loopback
  helper in `_passthrough.ts`. Documented in `docs/claude-ai-routes.md`.

### Claude Code Routines / Triggers (CCR) CRUD (2026-06-03)

Full CRUD over the Claude Code Routines (a.k.a. Triggers) surface on the OAuth `/claude-code/*` family,
extending the pre-existing `GET /claude-code/routines/run-budget`. Validated live against `api.anthropic.com`.

- **8 OAuth helpers** in `claude-oauth.ts` -- generalized `anthropicOAuthGet` into `anthropicOAuthRequest`
  (method + optional JSON body) with `anthropicOAuthGet`/`Post`/`Delete` wrappers; added `getOrganizationUuid`
  (memoized from `/api/oauth/profile`) and `listRoutines`/`getRoutine`/`createRoutine`/`updateRoutine`/
  `runRoutine`/`deleteRoutine`/`listRoutineEnvironments`. All carry the `ccr-triggers-2026-01-30` beta +
  `anthropic-version` + `x-organization-uuid` fingerprint.
- **8 routes** under `/claude-code/routines` + `/claude-code/environments` (list/get/create/update/delete a
  routine, run-now, list environments). Ordering: static `run-budget`/list precede the `:id` catch-all;
  `:id/run` precedes the `:id` update. Standard `{success,data}` / `UPSTREAM_<status>` / `OAUTH_UNAVAILABLE`
  envelope. Documented in `docs/claude-code-routes.md`.

### ttyd console — tmux-only writable attach + external-session lifecycle (2026-06-03)

Hardens the ttyd "console connect to Claude" + process-awareness surface so a writable console
is **only ever attached to a Claude session hosted inside tmux**. A Claude process running outside
tmux (a plain terminal, or a `--chrome` full window) has no tmux pane to share, so the only thing
the code could do to "connect" is launch a second `claude --resume <sessionId>` — two live processes
writing the same session JSONL, which corrupts it. The non-tmux/tmux distinction comes straight from
the live-PID detector (ancestor-walk against `#{pane_pid}`): a process has `tmuxSessionName` only when
its ancestor chain hits a tmux pane.

- **New chokepoint guard in `startTtyd` (force-proof).** Before the "create new tmux + `claude --resume`"
  / direct-mode branches, refuse with new code `SESSION_NOT_IN_TMUX` if a **live** non-tmux process is
  already running this `sessionId` — regardless of `force`. RECONNECT (attach ttyd to an existing tmux
  via `new-session -t`) and `--fork-session` (new session file) are exempt; they never duplicate.
- **`POST /ttyd/session/:id/start`** — `force:true` can no longer bypass a live non-tmux `activeInstance`
  (it could before, launching a duplicate). It now returns `SESSION_NOT_IN_TMUX` with the blocking PID,
  a `killUrl`, and `canFork:true`. force still bypasses reconnectable-tmux instances + unmanaged-process warnings.
- **`connectPid`** — when the supplied PID does not resolve to a tmux pane (i.e. it's a non-tmux session),
  the start no longer silently falls through to a fresh (duplicate) start: it returns `SESSION_NOT_IN_TMUX`
  when the PID is alive, or proceeds with a clean fresh start when the PID is already dead.
- **`POST /ttyd/start-all`** — skips sessions running outside tmux instead of force-launching duplicates,
  and reports them in a new `skipped[]` array (`{sessionId, pid, reason}`) + `summary.skipped`.
- **Dead external sessions never block (kill/term).** `getSessionStatus` re-checks `isProcessAlive` before
  setting `activeInstance` / counting unmanaged processes, so a dead/zombie process can't keep blocking a
  fresh start. `killProcess` is now dead-safe: a PID that's already gone returns `{success:true, alreadyDead:true}`
  and cleans up stale ttyd-instance tracking, instead of "not a Claude-related process". Live, non-Claude PIDs
  are still refused (no arbitrary-kill).
- **New pure module `core/src/terminal-attach-policy.ts`** (`isNonTmuxProcess`, `findLiveNonTmuxSession` with
  injectable liveness) holds the rule so it is deterministically unit-testable; `ttyd-manager` + `ttyd.routes`
  both call it. RECONNECT mode and the default (no-force) block were already correct and are unchanged.

Verified: `tsc --noEmit` clean; new `attach-policy.test.ts` (9 cases: live non-tmux blocks, tmux-backed allowed,
dead does-not-block, id-scoping, mixed-list) + existing inspector tests = 35/35 pass under Node 20. (The
`cc-integration` E2E file is unrelated and only fails without a live `:3201` server / under Node 18's
chokidar-ESM limitation.) Not yet deployed — source change only.

### GitHub repo/list + fork + directory-aware git ops (2026-06-03)

Follow-up to the github endpoint + MCP tools. Adds three capabilities and makes the git backend
directory-aware under the existing operator allowlist.

- New actions: `repo/list` (read — the account's own repos via `/user/repos`, or a user/org's via
  `/users/{owner}/repos`; returns compact fields), `fork` (write — `POST /repos/{owner}/{repo}/forks`).
- `git/clone` and `git/commit-push` gain an optional `dir` parameter that targets a **real directory**,
  gated by the **shared lm-assist allowlist** (`/home/ubuntu/*` — the same gate `agent_execute` uses,
  extracted to `core/src/utils/cwd-allowlist.ts`, re-exported from `mcp-server/tools/_passthrough.ts`).
  Safety: only the default managed scratch dir is ever wiped; a caller `dir` is refused if non-empty
  (clone) and must be an existing `.git` checkout operated in place (commit-push). New error codes
  `FORBIDDEN_DIR`, `DIR_NOT_EMPTY`, `NOT_A_REPO`.
- MCP: `github_query` gains `repo/list` (+`visibility`/`sort`/`per_page`); `github_mutate` gains
  `fork`, `git/clone` (+`organization`/`dir`/`depth`).

Verified on 117: allowlisted clone into `/home/ubuntu/*` succeeds; `/tmp/*` is refused (`FORBIDDEN_DIR`,
directory never created); `repo/list` returns a compact list. Deployed to 117 + 123, synced to Windows.

### GitHub MCP tools — `github_query` / `github_mutate` (2026-06-03)

The `/github/*` action endpoint is now exposed over MCP via two scope-classified tools, added through the
existing expanded-catalog framework (def in `EXPANDED_TOOL_DEFS`, scope in `TOOL_SCOPES`, handler in
`EXPANDED_HANDLERS`) — no new transport or protocol plumbing.

- `github_query` (read tier — auto-approved): `auth/status`, `accounts/list`, `whoami`, `repo/get`, `pr/list`.
- `github_mutate` (write tier — per-call approval): `pr/create`, `pr/close`, `issue/create`, `issue/close`,
  `branch/delete`, `file/put`, `git/commit-push`.

Both dispatch to `POST /github/<action>` on loopback (new `workerPostRaw` preserves the structured
`{ok, backend, data|error}` envelope), so the endpoint's guarantees carry over for free: multi-account
(`account` param), fail-closed on an unresolved account, and deep-redaction — no credential crosses the
MCP boundary, and `accounts/list` returns names + sources, never tokens. The raw `gh`/`api` passthrough
actions are intentionally NOT exposed over MCP (structured, scope-classified actions only). Both transports
(StreamableHTTP `/mcp` and stdio `/mcp-call`) advertise + dispatch them via the shared `configureMcpServer`.

Files: `core/src/mcp-server/tools/github.ts` (defs + handlers), wired in `tools/expanded.ts`, scopes in
`configure.ts`, helper in `tools/_passthrough.ts`.

**Verified** on 117: `tools/list` advertises both (28 tools total); real `tools/call`
`github_query(whoami, account=YiHuangDB)` → YiHuangDB via the api backend; access differentiation
(private `YiHuangDB/lm-unified-trade` → `NOT_FOUND` as `langmartai`); `github_mutate` rejects read actions;
scopes resolve to read / write.

### GitHub endpoint — multi-account + credential-exposure hardening (2026-06-03)

The `/github/*` action endpoint (api/gh/git backends) gained multi-account support and a hard guarantee
that no credential can leave the endpoint.

- **Multiple accounts.** Every action takes an optional `"account": "<login>"`; new `accounts/list`
  enumerates the accounts available on the host (names + sources, never tokens). Per-account resolver
  (first hit wins, portable across gh versions): env `LM_ASSIST_GITHUB_TOKEN_<ACCOUNT>` →
  `~/.lm-assist/github-accounts.json` → `gh auth token --user <account>` (modern gh) → `hosts.yml`
  (new multi-user `users:` block or old single-user `user:`). `auth/status` takes an optional `account`.
- **Fail-closed.** A requested account with no resolvable credential returns `AUTH_MISSING` — it never
  silently falls back to the host's ambient gh/SSH auth (which would act as a *different* account).
- **No credential leaves the endpoint.** `runAction` deep-redacts every response (HTTP endpoint + CLI):
  token-shaped values (`gh*_…`, `github_pat_…`) and secret-bearing keys (`temp_clone_token`,
  `oauth_token`, `access_token`, `refresh_token`, `client_secret`, `authorization`, `token`) become
  `<REDACTED>`. The `gh` passthrough is blocked from *reading* credentials (`gh auth …` /
  `gh config get … token` → `FORBIDDEN_PASSTHROUGH`). Tokens are used only to authenticate inside the service.

**Verified end-to-end** on two hosts: Windows (gh keyring with two accounts → distinct identities +
private-repo access differentiation) and 117 (single-account `hosts.yml` + a second account supplied via
`github-accounts.json`). `gh auth token` blocked, GitHub's `temp_clone_token` redacted, zero token-shaped
strings in any response, core logs show only `token=present(len=N)`.

Files: `core/src/github/github-service.ts`, `core/src/routes/core/github.routes.ts` (registered in
`routes/core/index.ts`). Full reference: `docs/github-routes.md`.

### MCP server — single source of truth for both transports (2026-05-28)

lm-assist's MCP server is exposed via two transports: **stdio** (spawned by Claude Code / Claude Desktop as a subprocess; forwards each tool call over HTTP to the running core API) and **StreamableHTTP** (`POST /mcp` on the core API itself; runs tool handlers in-process). Until now, the MCP protocol wiring — the tool list, the `ListToolsRequestSchema` registration, the `CallToolRequestSchema` switch + try/catch + `logToolCall` plumbing — was duplicated in both transport entry files. Adding or modifying a tool meant editing two places.

This refactor extracts the shared protocol surface into a single helper:

- New module: `core/src/mcp-server/configure.ts`
  - `LM_ASSIST_TOOL_DEFS`: the canonical 8-tool array (search, detail, feedback, list_recent_sessions, list_projects, search_memory, list_claudeai_conversations, read_conversation)
  - `LM_ASSIST_TOOL_NAMES`: their names in the same order
  - `configureMcpServer(server, dispatch)`: wires `ListTools` (returns the array) and `CallTool` (calls `dispatch(name, args)` with the standard try/catch + `logToolCall` envelope)
  - `McpToolDispatcher`: caller-supplied `(toolName, args) => Promise<McpToolResult>`
  - `McpToolResult`: the `{content, isError?}` shape every handler returns

Each transport keeps its own dispatcher (the architectural difference is intentional):

- **stdio** dispatches over HTTP via `api-client.ts` (`mcpSearch`, `mcpDetail`, …) — the stdio entry stays a thin client, the heavy work runs in the core API.
- **StreamableHTTP** dispatches in-process directly to the handlers in `mcp-server/tools/*.ts` (`handleSearch`, `handleDetail`, …) — no HTTP hop.

After the refactor each transport file is ~30 lines of "build server + provide dispatcher + connect transport"; the protocol wiring is in one place.

**Verified end-to-end** by running both transports against the same prompt:
- `POST /mcp` `tools/list` → 8 tools in canonical order.
- Subprocess `node mcp-server/index.js` initialize + `tools/list` → identical 8 tools, same order.
- `tools/call list_recent_sessions` against both → byte-identical results (same `isError`, same content, same 472-char text).
- `tools/call does_not_exist` against both → identical `{isError: true, content: [{type:'text', text:'Unknown tool: does_not_exist'}]}`.

Adding a 9th tool now means: write the handler, add the def to `definitions.ts`, append both to `LM_ASSIST_TOOL_DEFS` in `configure.ts`, add the case to each transport's dispatcher (different impl, same name). The protocol wiring stays untouched.

### Browser endpoint reorganization — generic primitives moved out of `/claude-ai/*` (2026-05-27)

Followup to the banner generalization. Promotes browser-agnostic primitives from `/claude-ai/browser/*` to `/browser/*` so they're available as a first-class generic surface — claude.ai use is one case among many. Pure rename; old paths no longer exist (callers were on `[Unreleased]` and warned).

**Moved (path rename only — request/response shape unchanged):**

| Before | After |
|---|---|
| `GET  /claude-ai/browser/installed`         | `GET  /browser/installed` |
| `GET  /claude-ai/browser/profiles`          | `GET  /browser/profiles` |
| `POST /claude-ai/browser/launch`            | `POST /browser/launch` |
| `POST /claude-ai/browser/close`             | `POST /browser/close` |
| `POST /claude-ai/browser/switch-to-headless`| `POST /browser/switch-to-headless` |

**File-relocated (path was already `/browser/banners`, handler moved out of `claude-ai.routes.ts` into `browser.routes.ts`):**

- `POST /browser/banners`
- `GET  /browser/banners`
- `DELETE /browser/banners/:id`

**Stays under `/claude-ai/*`** (genuinely claude.ai-specific):

- `POST /claude-ai/browser/capture-session` — writes `~/.claude/claudeai-session.json`
- `POST /claude-ai/browser/launch-and-capture` — composite for the claude.ai login flow
- `POST /claude-ai/browser/install-idle-banner` — thin preset over `POST /browser/banners` with claude.ai host match + redirect-back-to-claude.ai on mismatch
- `POST /claude-ai/browser/via-chrome/identify` — fetches `/api/organizations` from claude.ai to identify the logged-in org

Internal references (doc comments in `browser-control.ts`, error message hints in `claudeai-browser-launch.ts`, CHANGELOG entries from earlier today) updated to the new paths.

### Browser banners — generic on-page banner system with URL matching (2026-05-27)

Promotes the lm-assist managed-browser banner from a single-purpose CDP injection (`/claude-ai/browser/install-idle-banner`) to a first-class endpoint family that can install any caller-defined banner on any spawned browser:

- `POST /browser/banners` — body `{port, id, title, status, statusKind?, note?, theme?, closable?, match?, onMismatch?}`. Adds (or replaces by `id`) a banner that survives navigations and re-installs on new tabs the user opens. `theme` is `'dark'` (default, claude-orange accent), `'warning'` (red), or `'info'` (blue). DOM is built node-by-node (createElement + textContent, no innerHTML) so caller-supplied text can't inject markup.
- `GET /browser/banners?port=N` — lists currently-registered banner configs for a port.
- `DELETE /browser/banners/:id?port=N` — drops a single banner (removes the `Page.addScriptToEvaluateOnNewDocument` registration on every target + cleans up the DOM node).

**Per-banner URL matching.** `match: { include: [<hostPattern>, …] }` gates rendering by `location.hostname`. Patterns:
- `claude.ai` — exact host
- `*.claude.ai` — host or any subdomain
- `*` — wildcard (no gating)

`onMismatch.action`:
- `'hide'` (default for new banners) — render nothing when host doesn't match
- `'redirect'` (default for the lm-assist-idle preset) — show a brief warning banner with the off-target host name, then `location.replace(redirectTo)` after `redirectAfterMs` (default 1800)
- `'warn'` — render the banner with `err` styling but don't redirect

Multiple banners coexist on the same page (each gets its own `#__lm-assist-banner-<id>` div). They stack at `top:0` by document order — caller's responsibility to use a single active banner if visual stacking would be confusing.

`POST /claude-ai/browser/install-idle-banner` is now a thin convenience wrapper that calls `installBanner()` with the "managed-browser idle" preset (id `lm-assist-idle`, host match `[claude.ai, *.claude.ai, *.anthropic.com, accounts.google.com]`, `onMismatch: redirect → https://claude.ai/`). All previous behavior preserved.

CDP session-management state moved from per-route module-level Maps into `claudeai-banner.ts`. `switch-to-headless` now calls `closeAllBanners(oldPort)` for cleanup instead of poking at internal Maps. New file: `core/src/utils/claudeai-banner.ts` (~350 lines) houses the banner script generator + CDP attach/poller/teardown lifecycle.

### claude.ai via-chrome — feature parity with cookie-file `/completion` + managed-browser banner + GUI→headless switch (2026-05-27)

A batched set of additions that bring the `/claude-ai/via-chrome/*` family up to par with the cookie-file path, plus two new endpoints that turn a launched browser into a clearly-labelled "managed" surface and let it transition from login-time-visible to runtime-headless without losing the session.

**`POST /claude-ai/via-chrome/conversations/:uuid/completion` — three new body fields.**

- `tools: [...]` — SPA-shaped MCP tool definitions to pass through to claude.ai. Previously hardcoded to `[]`, which meant the model had no way to see any connector's tools when called through this path; the only workaround was to embed the array client-side. Now pass-through.
- `autoApproveTools: boolean` — mirror of the cookie-file path's behavior. When `true`, the generated snippet does the full gate dance inside the browser: track every `tool_use` content_block as it streams, fire `POST /tool_approval` the moment `content_block_stop` arrives for it (NOT `message_delta` — that event doesn't fire until after approval lands, so waiting for it deadlocks), then poll the conversation until the assistant message has the `tool_result` block + post-tool text + non-`tool_use` `stop_reason`, and merge the final text into the snippet's return value. Approval key resolution is the same three-tier fallback (caller override → hash-suffixed key learned from the conv's `enabled_mcp_tools` → bare `<srv>:<tool>` key for first-time approval), with the same `<integration>:<tool>` ↔ `<tool>` name normalization. Validated end-to-end at 7–10 s for a real MCP tool call.
- `showOverlay: boolean` — when `true`, the snippet installs a managed-browser banner at the top of the page (`#__lm-assist-via-overlay`, z-index 2147483647), updates its status as the flow progresses (`"Sending prompt…"` → `"Calling claude.ai /completion (streaming)…"` → `"Done."`), installs a `beforeunload` warning, and intercepts clicks on `<a href>` pointing to non-claude.ai hosts (blocked + banner turns red with "Blocked navigation to {host}"). DOM is built node-by-node (`createElement` + `textContent`, no `innerHTML`) so the markup is XSS-safe by construction. A `MutationObserver` re-installs the banner if claude.ai's SPA wipes the node during a route change.

**`POST /claude-ai/browser/install-idle-banner` (new endpoint).** Body: `{port?, baseText?, noteText?}`. Attaches via CDP to every page target on a spawned browser, registers a `Page.addScriptToEvaluateOnNewDocument` script with the same overlay DOM, and stashes the live `CDPSession` objects in a module-level Map so the script registration survives subsequent navigations (CDP clears registrations when the session disconnects; a poller every 3 s also picks up new tabs the user opens). Initial state is green "Idle. Waiting for next lm-assist request." Survives across SPA route changes via `MutationObserver`. The via-chrome `/completion` snippet's `showOverlay: true` is idempotent against this banner — if it sees `window.__lmAssistViaOverlay` already installed, it updates the existing status rather than tearing down + recreating, and resets to "Idle" instead of removing the banner on completion. So the user gets a single persistent banner across the browser's lifetime, with status that ticks through what's happening.

**Off-site navigation detection.** The installer script checks `location.hostname` on every doc load. If the user lands on a host that isn't `claude.ai`, `*.claude.ai`, `*.anthropic.com`, or `accounts.google.com` (the last for Google SSO during login), it installs a red variant of the banner — "You navigated to {hostname} — this browser is reserved for claude.ai. Returning…" — and `location.replace('https://claude.ai/')`s after 1.8 s. The user briefly sees the banner explaining why they're being bounced. Verified by navigating the managed Chrome to `example.com` and watching the red banner render, then the auto-redirect fire, then the normal green idle banner restore on return.

**`POST /browser/switch-to-headless` (new endpoint).** Body: `{pid, profile?, port?, oldPort?, browser?}`. Closes the currently-running visible Chrome and re-launches it against the SAME profile directory in headless mode. Cookies + login state survive because Chrome's profile storage (cookies, localStorage, IndexedDB) lives on disk in the profile dir, not in the process. The new launch forces `--user-agent=Mozilla/5.0 ... Chrome/145.0.0.0 Safari/537.36` (no `HeadlessChrome`) because Cloudflare gates the default headless UA with an "Almost there… Just a moment…" challenge that 403s every API call regardless of cookies. After the switch, `/api/account_profile` from the new headless Chrome returns 200 against the same logged-in session. Companion idle-banner state for the old port is cleaned up automatically. Caller's typical sequence:

```
1. POST /browser/launch                {headless:false, profile:'isolated', port:9555}
2. POST /claude-ai/browser/install-idle-banner   {port:9555}                                ← banner shows "Idle, waiting…"
3. user logs in claude.ai inside the visible window
4. POST /claude-ai/browser/capture-session       {port:9555}                                ← proves session is live
5. POST /browser/switch-to-headless    {pid:<from-launch>, oldPort:9555, port:9777}
                                                                                            ↳ visible window closes
                                                                                            ↳ headless Chrome on :9777 inherits session via shared profile dir
6. POST /claude-ai/via-chrome/conversations/<uuid>/completion  ...  (runs silently)
```

The visible-mode behaviors (idle banner, snippet status updates, link/nav guards, off-site auto-redirect) only apply in non-headless launches — they're a courtesy for the user's eyes. Headless skips them entirely.

### claude.ai completion — server-side MCP tool-approval (`autoApproveTools`) (2026-05-27)

`POST /claude-ai/conversations/:uuid/completion` now accepts an `autoApproveTools` body field. When `true`, lm-assist intercepts the per-call approval gate that claude.ai's SPA normally shows the user ("Claude wants to use *foo* from *bar*") and resolves it automatically server-side. Caller gets a single response with `text`, `events`, `approvals: [{toolUseId, toolName, status, ok}, ...]`, and the post-tool continuation merged in. Default `false` — opt-in only, no behavior change for existing callers.

**Why this is a thing.** When a connector's tool doesn't have `account.settings.enabled_mcp_tools["<srv>:<tool>-<hash>"]` set (i.e. never previously `approval_option:'always'`-approved on this account), claude.ai's `/completion` SSE pauses after the model emits the `tool_use` block and waits for the SPA to `POST /tool_approval`. Without an interactive SPA, the SSE just hangs until timeout. The autoApprove path closes that loop: detect, approve, wait for continuation, return one merged response.

**Trigger point is non-obvious.** The first attempt waited for `message_delta { stop_reason: 'tool_use' }`. That event never arrives during the pause — claude.ai backend holds the SSE open BEFORE the message_delta, waiting for approval first. Fix: fire approval the moment `content_block_stop` arrives for a tool_use block. Verified against a live capture: backend resumes within ~500ms of the approval landing, then emits `tool_result` + post-tool text + `message_delta` + `message_stop` in that order on the same SSE.

**`approval_key` construction is three-tier.** claude.ai's `/tool_approval` body wants `approval_key: "<srv_uuid>:<tool>-<contentHash>"`. The hash is a content hash of the tool's current name + description + input_schema. Each conv's `settings.enabled_mcp_tools` carries any always-approved tools as `<srv>:<tool>-<hash>` keys; tools that have never been always-approved are only present as the bare `<srv>:<tool>` form. lm-assist now resolves in this order:

  1. Explicit `approvalKey` from the caller (highest priority, escape hatch).
  2. Hash-suffixed key learned from a one-off probe conversation that inherits `account.settings.enabled_mcp_tools` (cached 5 min per orgUuid).
  3. **Bare `<srv>:<tool>` key** as a fallback — claude.ai accepts this on first-time approval and computes the current hash server-side. This is what makes new tools work without a manual `always-allow` setup first.
  4. Tool not exposed by any connector (e.g. the SPA's internal `tool_search`) → synthetic 204; caller moves on.

**Integration-prefix stripping.** claude.ai's SSE delivers tool names as `<integration>:<tool>` (e.g. `lm-assist:search_memory`), but the conv's `enabled_mcp_tools` indexes by bare `<tool>` only. Lookup tries both shapes — `entry.hashKeys[fullName] || entry.hashKeys[strippedName] || entry.bareKeys[fullName] || entry.bareKeys[strippedName]` where `strippedName = fullName.split(':').pop()`. Forgetting this step costs about 90 seconds per failed test run before the SSE aborts.

**Post-SSE conv poll.** After approval, the model's continuation arrives by extending the SAME assistant message on claude.ai's side — not on a new SSE stream. The /completion stream closes with `message_stop`; lm-assist then polls `GET /chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` every 1500ms (up to `min(timeoutMs, 60s)`) until the assistant message has both a `tool_result` block AND non-empty final text AND a non-`tool_use` `stop_reason` — at which point `text` in the response is the model's post-tool message (not just the pre-tool intro that the SSE captured). End-to-end wall time: ~9-10s for `search_memory` against the lm-assist MCP connector.

**Companion endpoint additions on `POST /claude-ai/conversations`** (so the gate can be FORCED for testing without changing account settings): `enabledMcpTools: {"<srv>:<tool>": true}` REPLACES inherited account settings on that conv — pass only the bare key to ensure no `alwaysApprovedKey` slips in via inheritance and the gate must fire. `toolSearchMode: "off"` is also passed through (advisory — claude.ai backend sometimes overrides).

**New exports in `core/src/utils/claudeai-session.ts`:** `discoverApprovalKeys(orgUuid?) → {hashKeys, bareKeys, expiresAt}`, `approveToolUse({orgUuid, convUuid, toolUseId, toolName, approvalOption?, approvalKey?, timeoutMs?})`, `clearApprovalKeyCache(orgUuid?)`. The first two are also reachable indirectly via `/completion?autoApproveTools=true`; the third is for tests + post-deploy hash-invalidation after the connector's tool descriptions are edited.

**Debug logging gated.** The per-stage `[autoApprove] ...` console traces (tool_use detection, approval HTTP result + latency, SSE-drained event count, conv-poll iterations) are off by default. Export `LM_ASSIST_DEBUG_AUTOAPPROVE=1` (or `=true`) to enable when investigating a gated flow that isn't completing as expected. ~8 log lines per /completion call when on.

**Validated end-to-end on 2026-05-27** — 9-10s round-trip for a gated `lm-assist:search_memory` invocation. Stock `undici`-backed `fetch` in lm-assist passes Cloudflare's bot scoring on every endpoint in the flow; no TLS-impersonation client is needed for this surface.

### claude.ai completion — attachments / files / sync_sources pass-through (2026-05-23)

The completion routes on both paths (`/claude-ai/conversations/:uuid/completion` and `/claude-ai/via-chrome/conversations/:uuid/completion`) previously hardcoded `attachments: []`, `files: []`, `sync_sources: []` in the body sent to claude.ai. Callers could not attach anything; the only workaround was to bypass lm-assist and call claude.ai directly with the cookie. These three fields are now pass-throughs from the request body.

**Text content goes via `attachments`, not `files`.** The two channels are not interchangeable:

- `attachments: [{file_name, file_type, file_size, extracted_content, origin:"user_upload", kind:"file"}]` — sent inline with the prompt. The assistant sees `extracted_content` in context immediately. This is the right channel for markdown, source code, transcripts.
- `files: ["<file_uuid>"]` — file_uuid strings from `POST /api/{org}/upload` on claude.ai. Files land in the sandbox at `/mnt/user-data/uploads/` as `file_kind:"blob"`. Text extraction from blob uploads is unreliable — the assistant often reports "the file came through empty" even when the bytes are on the server. Use this only for binaries.

A separate session attached a 169 KB transcript via `files: [uuid]` and saw the assistant report empty content; re-sending the same bytes via `attachments` with `extracted_content` inline worked immediately. The documentation in `docs/claude-ai-routes.md` now spells out the distinction.

**No upload route added in this change.** Getting a `file_uuid` still requires calling `POST /api/{org}/upload` on claude.ai directly (the lm-voice webapp does this for images; markdown/source doesn't need it). Adding an upload route to lm-assist is a separate piece of work.

**Body field naming.** Accepts both `syncSources` (camelCase, matches the existing `parentMessageUuid` style) and `sync_sources` (snake_case, matches the wire format). Forwards as `sync_sources`. `attachments` and `files` are the same name in both directions.

### Browser control surface — generic CDP + claude.ai cookie capture (2026-05-20)

Two coupled additions that turn lm-assist into a Chrome DevTools Protocol fallback for environments where claude-in-chrome MCP isn't loaded.

**`/browser/*` family — 24 generic browser-control endpoints.** Tabs CRUD, navigate, JS eval, cookies (read/write/delete), text/HTML inspection, click/type/hover/wait-for/find, storage (local/session), viewport, key dispatch, screenshots, plus page-script-injection taps for console messages and network requests. Targets any browser launched with `--remote-debugging-port` (default 9222). Mirrors most of claude-in-chrome MCP's surface so the same workflows can run without MCP.

**`/claude-ai/browser/*` family — 6 composite endpoints for cookie-file capture.** `launch-and-capture` (the headline) spawns Chrome with an isolated profile dir (`~/.claude/claudeai-browser-profile/`), injects a persistent in-page overlay explaining what the user must do and why, polls Chrome's cookie store until `sessionKey` appears, then writes both the per-profile session file (`~/.claude/claudeai-session.<profile>.json`) and the canonical `~/.claude/claudeai-session.json` so the existing cookie-file routes can pick it up without further setup. Stage-aware overlay messages ("Sign in with Google", "Approve OAuth", "Returning to claude.ai") drive the overlay text via per-target persistent CDP sessions, so hard navigations within the login flow (e.g. `/` → `/login` → `accounts.google.com` → `/new`) don't reset the status banner.

**Multi-browser detection + Firefox best-effort.** `GET /browser/installed` enumerates Chrome, Edge, Brave, Vivaldi, Chromium, Opera, and Firefox across Windows/macOS/Linux. `POST /browser/launch` accepts `{"browser": "<kind>"}` to pick which to launch. Firefox launches with `--remote-debugging-port` but uses WebDriver-BiDi internally; only a subset of CDP methods are honored — caller should treat Firefox as best-effort. Chromium-family browsers (Chrome/Edge/Brave/Vivaldi/Chromium/Opera) all share the full CDP feature set.

**Linux GUI autodetect.** When `headless` is false on Linux and lm-assist's process env has no `DISPLAY`, the launcher probes `/tmp/.X11-unix/X0` and auto-sets `DISPLAY=:0` so Chrome can render on the user's running X session. If no display is reachable at all, returns a structured error pointing the caller to `{"headless": true}`.

**Implementation notes worth flagging:**
- The overlay's status text is preserved across hard navigations by re-registering `Page.addScriptToEvaluateOnNewDocument` on every status update (a new registration carries the latest initial-render text). Without this, claude.ai's `/` → `/new` redirect resets the banner to "Waiting for sign-in" even after capture completes.
- `Storage.getCookies` is the browser-level cookie dump (works on Chrome 115+); `Network.getAllCookies` is the fallback for older Chromes. `Network.deleteCookies` is page-level only — the delete route routes through any open page target.
- The `CDPSession` primitive (one WebSocket, many commands) is required for `Page.addScriptToEvaluateOnNewDocument` — Chrome auto-removes the registration when the registering client disconnects, so the open-and-close `sendCDP` helper is unsafe for that command.

### `parseBody` reads DELETE bodies (2026-05-20)

`rest-server.ts#parseBody` previously returned `{}` for any DELETE request, dropping JSON bodies silently. RFC 7231 §4.3.5 allows DELETE bodies and the new `/browser/*` cookie/storage filtered-delete routes need them. No existing handlers read `req.body` on DELETE, so the change is additive.

### claude.ai conversation create + delete (2026-05-19)

The claude.ai surface could list/read conversations and write (completion, title) but had no way to **create** or **delete** a conversation. The generic via-chrome escape hatch (`POST /claude-ai/via-chrome` `{path}`) is GET-only — `buildViaChromeSnippet` hardcodes a GET fetch with no method/body — so it could not substitute. Both operations are now first-class across both families.

| Route | claude.ai path | Notes |
|---|---|---|
| **`POST /claude-ai/conversations`** | POST `…/chat_conversations` | **WRITE** — create empty conversation; body `{name?,uuid?}`; client-generated UUIDv4 (server echoes it); returns `{…conversation, uuid}`; HTTP 201 |
| **`DELETE /claude-ai/conversations/:uuid`** | DELETE `…/chat_conversations/{uuid}` | **WRITE (destructive)** — UUID validated host-side; HTTP 204 |
| **`POST /claude-ai/via-chrome/conversations/create`** | POST `…/chat_conversations` | snippet generates the UUID in-page and returns it; WRITE note in `instructions` |
| **`POST /claude-ai/via-chrome/conversations/:uuid/delete`** | DELETE `…/chat_conversations/{uuid}` | UUID validated host-side; destructive-WRITE note in `instructions` |

`createConversation()` / `deleteConversation()` model the existing `setConversationTitle` write (same header fingerprint, timeout, return shape). The via-chrome `create` route is registered **before** the `/conversations/:uuid` read route — the rest-server router is first-match-wins and the literal `create` would otherwise be captured as a `:uuid` (the old server returned `INVALID_REQUEST` for that path because the read route's UUID check rejected `"create"`).

**Verified end-to-end** against real claude.ai with the exact route-emitted snippets: create 201 → query 200 → delete 204 → readback 404, with a pre/post safety baseline (all 62 existing conversation UUIDs) confirming zero collateral change. Deployed live to `:3100`.

### Endpoint expansion — 28 new routes across Claude Code OAuth + claude.ai

A batched expansion of the catalog-backed endpoints. Each fingerprint was either captured live via `lm-proxy` (2026-05-10..14) or extracted from the leaked Claude Code source (`claude-code-2.1.88/source/src/`), so every new route ships with a verified header/auth/body shape rather than a guess.

**New Claude Code OAuth routes** (all `GET`, OAuth bearer with the appropriate `anthropic-beta`):

| Route | Anthropic path | Fingerprint source |
|---|---|---|
| `/claude-code/roles` | `/api/oauth/claude_cli/roles` | source: `services/oauth/client.ts` — Bearer **without** `anthropic-beta` |
| `/claude-code/account-settings` | `/api/oauth/account/settings` | live capture |
| `/claude-code/cli-bootstrap` | `/api/claude_cli/bootstrap?entrypoint=&model=` | live capture |
| `/claude-code/grove` | `/api/claude_code_grove` | live capture |
| `/claude-code/penguin` | `/api/claude_code_penguin_mode` | live capture |
| `/claude-code/policy-limits` | `/api/claude_code/policy_limits` | source: `services/policyLimits/index.ts` |
| `/claude-code/settings` | `/api/claude_code/settings` | source: `services/remoteManagedSettings/index.ts` |
| `/claude-code/user-settings` | `/api/claude_code/user_settings` | source: `services/settingsSync/index.ts` |
| `/claude-code/team-memory?repo=` | `/api/claude_code/team_memory` | source: `services/teamMemorySync/index.ts` (`?repo=owner/repo[&view=hashes]`) |
| `/claude-code/mcp-servers` | `/v1/mcp_servers` | live capture — uses `anthropic-beta: mcp-servers-2025-12-04` + `anthropic-version: 2023-06-01` |
| `/claude-code/mcp-registry` | `/mcp-registry/v0/servers` | live capture — **no auth** (public) |

`anthropicOAuthGet()` extended with `extraHeaders`, `query`, and `skipAuth` to support the per-endpoint header variations (alternative `anthropic-beta` values, the no-auth `mcp-registry` case, etc.).

**New claude.ai cookie-file + via-chrome routes** (all read-only `GET` except where noted):

| Route | claude.ai path | Notes |
|---|---|---|
| `/claude-ai/account-profile` | `/api/account_profile` | Standalone (was internal to healthz) |
| `/claude-ai/org` | `/api/organizations/{org}` | Org metadata |
| `/claude-ai/org/subscription` | `…/subscription_details?cached=true` | |
| `/claude-ai/org/usage` | `…/usage` | claude.ai-side usage (differs from `/claude-code/usage`) |
| `/claude-ai/org/skills` | `…/skills/list-skills` | |
| `/claude-ai/org/mcp-bootstrap` | `…/mcp/v2/bootstrap` | **SSE response** — helper drains stream, returns parsed events |
| `/claude-ai/org/styles` | `…/list_styles` | |
| `/claude-ai/org/model-config/:model` | `…/model_configs/{model}` | |
| `/claude-ai/org/memory-settings` | `…/memory/settings` | |
| `/claude-ai/org/cowork-settings` | `…/cowork_settings` | |
| `/claude-ai/org/sync-settings` | `…/sync/settings` | |
| `/claude-ai/org/sync/gdrive-progress` | `…/sync/ingestion/gdrive/progress` | |
| `/claude-ai/org/notifications` | `…/notification/preferences` | |
| `/claude-ai/account/invites` | `/api/accounts/{account}/invites` | |
| `/claude-ai/user-access` | `/api/bootstrap/{org}/current_user_access` | Per-user permissions/roles |
| `/claude-ai/sessions-active` | `/api/auth/sessions/list-active` | **Live sessions across devices** — useful security view |
| **`POST /claude-ai/conversations/:uuid/title`** | POST `…/title` | **WRITE** — rename/auto-title (omit body for auto-title) |

Each cookie-file route has a matching `POST /claude-ai/via-chrome/...` variant that returns the equivalent JS snippet for `mcp__claude-in-chrome__javascript_tool`. The via-chrome snippets reuse the existing `baseHeaders` block (full claude.ai fingerprint).

**Smoke-tested live** against the OAuth-authenticated account:
- 10/11 Claude Code routes → 200 (only `grove` returned 403, which is the server denying Grove access for this Max account — call shape verified correct)
- Each returns the expected data: roles (admin), account-settings (onboarding flags), cli-bootstrap (full org config), penguin (fast mode disabled), policy-limits (restrictions), settings, user-settings (with checksum), mcp-servers (Google Drive entry), mcp-registry (public, no auth)

### claude.ai web-session integration — health-check interface

Adds a uniform "is the integration ready?" surface so callers don't have to discover failure mode by failure mode. All claude.ai routes can now be preceded by a single health check that distinguishes config errors, expired sessions, Cloudflare blocks, and network problems.

**New routes:**

- `GET /claude-ai/healthz` — one-glance verdict. Combines file-based status with an active `/api/account_profile` probe. Returns `{ ok, reason, hint, sessionConfigured, identity, cookieFreshness, probe }`.
- `GET /claude-ai/session-status?probe=true` — opt-in active probe attached to the existing file-based status.
- `POST /claude-ai/via-chrome/health-check` — returns a snippet the agent runs in any tab. Verifies the active tab is `claude.ai`, identity cookies are present, and `/api/account_profile` returns 200. Returns `{ ok, reason, hint, pageUrl, identity, account? }`.

**Stable `reason` codes** the UI can branch on:

| Code | Both paths | Meaning |
|---|---|---|
| `ok` | ✓ | Ready to proceed |
| `session_not_configured` | cookie-file | No `~/.claude/claudeai-session.json` |
| `session_expired` | both | `sessionKey` invalid (401) |
| `cloudflare_blocked` | both | `cf_clearance`/`__cf_bm` expired or IP mismatch (403/503) |
| `network_error` | both | `fetch` threw |
| `upstream_error` | both | other 4xx/5xx |
| `wrong_tab` | via-chrome | active tab isn't `claude.ai` |
| `not_logged_in` | via-chrome | `lastActiveOrg` cookie absent |

**Better failure responses** on existing routes: distinguishes `CLAUDEAI_SESSION_NOT_CONFIGURED` (with a hint pointing at `/claude-ai/healthz`) from generic `CLAUDEAI_SESSION_UNAVAILABLE`. Live-tested against the Windows host (no config file) and the real claude.ai tab (returns `ok: true` with identity).

### claude.ai web-session integration — via-chrome header fingerprint hardening

Bare `fetch()` inside the claude.ai page bypasses claude.ai's own fetch interceptor — so the application-level headers its web app normally adds were missing from our via-chrome snippets. The browser was only filling transport-level headers (UA, `Accept-Encoding`, `sec-ch-ua-*`, `Sec-Fetch-*`, `Origin`, `Referer`, `Cookie`).

`buildViaChromeSnippet` and `snippetSendMessage` now emit a `baseHeaders` block at the top of every snippet and spread it into every `fetch()`:

| Header | Source | Value |
|---|---|---|
| `anthropic-client-platform` | pinned | `web_claude_ai` |
| `anthropic-client-version` | pinned | `1.0.0` |
| `anthropic-client-sha` | pinned (observed) | `8a753cbf88e19be0f5f67efefb1b07840b6402e9` |
| `anthropic-device-id` | from cookie `anthropic-device-id` | per-session UUID |
| `anthropic-anonymous-id` | from cookie `ajs_anonymous_id` | `claudeai.v1.<uuid>` |
| `x-activity-session-id` | from cookie `activitySessionId` | per-session UUID |

Identity values are extracted from non-HttpOnly cookies, so callers don't need to supply anything extra. `x-datadog-*` and `traceparent` remain intentionally omitted (random per-request, easier to skip than to forge wrongly).

Affected snippet generators: list/read/projects/memory/bootstrap/artifacts (via `buildViaChromeSnippet`) **and** `snippetSendMessage`'s two inner fetches (the read pre-flight and the actual `/completion` POST).

Live-tested through Chrome MCP:
- `GET /api/account_profile` with full `baseHeaders` → 200
- `POST /completion` with full `baseHeaders` → 200, 7 events, text `" HDR_OK"`

### claude.ai web-session integration — POST /completion (write op)

Both families now support sending messages:

- `POST /claude-ai/conversations/:uuid/completion` (cookie-file path) — Node `fetch` posts the message with `Accept: text/event-stream`, the helper drains the SSE stream and returns aggregated `{ status, text, events, eventTypes, humanMessageUuid, assistantMessageUuid }`. Auto-resolves `parent_message_uuid` from the conversation's `current_leaf_message_uuid`.
- `POST /claude-ai/via-chrome/conversations/:uuid/completion` (via-chrome path) — returns a JS snippet that does the read-conv + POST + stream-drain inside the page, returning the same aggregated result via `mcp__claude-in-chrome__javascript_tool`.

Request body shape mirrors a captured browser call: `prompt`, `timezone`, `personalized_styles`, `locale`, `model`, `tools`, fresh client-generated `turn_message_uuids` (UUIDv4), `attachments`/`files`/`sync_sources` empty, `rendering_mode: 'messages'`, `parent_message_uuid` from the conversation's leaf.

**Live-tested end-to-end** against the "Greeting" thread on 2026-05-14:
- `prompt: "Reply with exactly: PARSER_OK"` → `text: " PARSER_OK"`, 7 events drained
- Observed event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_limit`, `message_stop`
- The `message_limit` event carries `{ representativeClaim, windows: { '5h': {...}, '7d': {...} } }` — useful for surfacing rate-limit headroom

**Discoveries during the live test** (folded into the SSE parser):
1. claude.ai uses **CRLF separators** (`\r\n\r\n`), not bare `\n\n`. First attempt returned `eventCount: 0` despite a successful 200 because the parser only looked for LF. Parser now accepts both. Documented in `docs/claude-ai-routes.md`.
2. **`turn_message_uuids` is advisory.** The server assigns its own UUIDv7s (visible in `message_start.message.uuid`) and ignores the client UUIDv4s we sent. The client UUIDs are useful only as request-correlation handles. Doc updated.

`POST /completion` is the only **write** in the current surface — creates real message history and consumes tokens. The via-chrome snippet's `instructions` warns explicitly; the cookie-path handler validates `prompt` presence.

The other observed write endpoint (`POST .../title`) remains unimplemented.

### claude.ai web-session integration — via-chrome path + additional read endpoints

Adds a second route family `/claude-ai/via-chrome/*` that returns ready-to-paste JS snippets for `mcp__claude-in-chrome__javascript_tool`. Snippets run inside an authenticated `claude.ai` tab, so the browser auto-attaches every cookie (including HttpOnly `sessionKey` / `cf_clearance` / `__cf_bm` that page JS can't read). No cookie file, no refresh chore, real-Chrome TLS fingerprint. Full design notes in [`docs/claude-ai-routes.md`](./docs/claude-ai-routes.md).

New routes (cookie-file path):
- `GET /claude-ai/memory` — Claude's persistent memory for the org
- `GET /claude-ai/bootstrap` — `/edge-api/bootstrap/{org_uuid}/app_start`, the highest-leverage single call (≈500 KB: account, feature flags, recent conversations, system prompts, user access in one shot)
- `GET /claude-ai/artifacts/:uuid/versions` — artifact version history

New routes (via-chrome path):
- `POST /claude-ai/via-chrome` — generic snippet generator for any `/api/`, `/edge-api/`, `/v1/` path. Path whitelist blocks other prefixes.
- `POST /claude-ai/via-chrome/conversations`, `…/conversations/:uuid`, `…/projects` — mirrors of the cookie-file convenience routes
- `POST /claude-ai/via-chrome/memory`, `…/bootstrap`, `…/artifacts/:uuid/versions` — same for the new endpoints

End-to-end verified against a real Chrome tab via Chrome MCP:
- `via-chrome/conversations` (limit 3) → **200**, 3 conversations
- `via-chrome/conversations/36a5ab7b-…` → **200**, full transcript, 38 messages
- `via-chrome/bootstrap` → **200**, 516 KB JSON with 10 top-level keys (`account`, `org_statsig`, `org_growthbook`, `system_prompts`, `current_user_access`, etc.)

Bug fix during testing: the `bootstrap` path takes the **org_uuid** (`lastActiveOrg`), not the user uuid (`ajs_user_id`) — the user-uuid form returns 404. Initial snippet helper guessed wrong; corrected in both helpers (`getBootstrapAppStart`, `snippetBootstrapAppStart`).

New helper module: `core/src/utils/claudeai-via-chrome.ts` — `buildViaChromeSnippet`, `snippetListConversations`, `snippetReadConversation`, `snippetListProjects`, `snippetGetMemory`, `snippetBootstrapAppStart`, `snippetArtifactVersions`.

### claude.ai web-session integration

Four new routes that operate on claude.ai's web backend — the cookie-authenticated API behind `claude.ai/chat/...`. Endpoint inventory in [`lm-claude-endpoint:pages/claude-ai/`](https://github.com/langmartai/lm-claude-endpoint/tree/main/pages/claude-ai).

- **New: `GET /claude-ai/session-status`** — reports presence of `~/.claude/claudeai-session.json`, validates that the cookie string contains `sessionKey`, `cf_clearance`, `__cf_bm`, and surfaces the auto-derived identity (`org_uuid`, `anthropic-device-id`, `anonymous-id`, `activity-session-id`, `user_id`). No raw cookie values returned.
- **New: `GET /claude-ai/conversations`** — proxies `GET claude.ai/api/organizations/{org_uuid}/chat_conversations_v2`. Supports `?limit=`, `?starred=true|false`, `?consistency=eventual|strong`, `?project_uuid=`.
- **New: `GET /claude-ai/conversations/:uuid`** — proxies `GET claude.ai/api/organizations/{org_uuid}/chat_conversations/{conv_uuid}` with the same default query the web app sends (`tree=True`, `rendering_mode=messages`, `render_all_tools=true`). Returns the full message tree with `chat_messages[]` (`content` blocks: `text`, `tool_use`, `tool_result`, attachments).
- **New: `GET /claude-ai/projects`** — proxies `GET claude.ai/api/organizations/{org_uuid}/projects`.
- **New helper: `core/src/utils/claudeai-session.ts`** — `readClaudeAISession()`, `getClaudeAISessionStatus()`, `parseCookieString()`, `deriveIdentity()`, `claudeaiGet()`, plus per-endpoint wrappers (`listConversations`, `readConversation`, `listProjects`).

#### Configuration

User pastes their browser Cookie header once into `~/.claude/claudeai-session.json` (mode 0o600 enforced on write):

```json
{
  "cookie": "<paste full Cookie: header from a captured claude.ai request>",
  "userAgent": "Mozilla/5.0 ... (optional — defaults to observed Chrome 146 Linux)"
}
```

`orgUuid`, `anthropic-device-id`, `anonymous-id`, `activity-session-id`, `user_id` are auto-derived from the cookie itself (claude.ai stores them as cookies *and* sends them as headers). The user shouldn't need to maintain those separately.

Why config-file rather than auto-extract from Chrome / Claude Desktop:
- Browser cookie stores are encrypted per platform (DPAPI on Windows, libsecret on Linux, Keychain on macOS). Decryption is fragile and fights with the browser's own write locks.
- `cf_clearance` / `__cf_bm` rotate every ~30 min and are IP-bound — auto-extraction wouldn't keep them fresh anyway.

#### Wire-fingerprint hardening

`claudeaiGet()` sends the same header set captured from real claude.ai web traffic (lm-proxy capture, 2026-05-10..2026-05-14):

- `Host`, `Connection: keep-alive`
- `anthropic-anonymous-id`, `x-activity-session-id`, `anthropic-device-id` — derived from cookies
- `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` — pinned to observed Chrome 146 Linux values (overridable)
- `anthropic-client-sha`, `anthropic-client-platform: web_claude_ai`, `anthropic-client-version: 1.0.0`
- `content-type: application/json`, `Accept: */*`
- `Sec-Fetch-{Site,Mode,Dest}: same-origin, cors, empty`
- `Referer` set per operation: `https://claude.ai/` for list, `https://claude.ai/chat/{conv_uuid}` for read, `https://claude.ai/new` for projects
- `Accept-Encoding: gzip, deflate, br` — note: real Chrome 146 sends `..., zstd` but Node's `fetch` can't decode zstd responses, so we drop it. Still matches older Chrome / Edge fingerprints.

Headers intentionally omitted: `x-datadog-{origin,trace-id,parent-id,sampling-priority}`, `traceparent`, `tracestate`. They're random per request and easier to forge wrongly than to skip. claude.ai accepts the request without them.

**Caveats** (documented in the helper):
- `cf_clearance` and `__cf_bm` are tied to the source IP and expire (~30 min for `__cf_bm`). When they expire, requests get 403 / interstitial — the user must refresh the cookie from a fresh browser request.
- Node's TLS fingerprint (JA3/JA4) differs from Chrome's. Cloudflare can detect this. Low-frequency reads on a fresh `cf_clearance` succeed; tight polling will trip detection regardless of header correctness.
- macOS Keychain note doesn't apply here — this is a config-file integration on all platforms.

#### Live test (2026-05-14, against yi@192.0.2.23's captured cookie)

| Call | Status | Result |
|---|---|---|
| `listConversations({ limit: 5 })` | 200 | 5 conversations: "Weekly trading insights summary", "Deepgram speech-to-text pricing", ... |
| `readConversation("36a5ab7b-…")` | 200 | `name: "Weekly trading insights summary"`, `model: claude-opus-4-7`, `chat_messages: 38` |
| `listProjects({ limit: 5 })` | 200 | 0 items (no projects shared with this account) |

### Claude Code OAuth integration

Three new routes that let any local caller — UI dashboard, CLI tool, scheduled job — read the same usage and profile data Claude Code itself reads, without re-implementing the OAuth dance.

- **New: `GET /claude-code/oauth-status`** — surfaces presence and expiry of Claude Code's OAuth credentials (`~/.claude/.credentials.json`) without exposing the tokens. Reports platform, storage backend, scopes, subscription type, rate limit tier, and ms-until-expiry.
- **New: `GET /claude-code/usage`** — proxies `GET https://api.anthropic.com/api/oauth/usage` using Claude Code's OAuth access token. Returns the `Utilization` payload (rate-limit windows: 5-hour, 7-day, 7-day-opus, 7-day-sonnet, plus `extra_usage`). Auto-refreshes the access token via `POST platform.claude.com/v1/oauth/token` when within 5 minutes of expiry and persists the new token atomically back to the credentials file.
- **New: `GET /claude-code/profile`** — proxies `GET https://api.anthropic.com/api/oauth/profile`. Returns account / organization / application info.
- **New helper: `core/src/utils/claude-oauth.ts`** — `readClaudeOAuth()`, `getValidAccessToken()` (refresh-when-needed), `anthropicOAuthGet(path)` (auth + single 401 retry), `getOAuthStatus()`, `detectClaudeCodeVersion()`, `getClaudeCodeUserAgent()`.
- **Limitation:** macOS is not yet supported — Claude Code stores credentials in the Keychain rather than the plain file used on Linux/Windows. `getOAuthStatus()` reports `storage: 'keychain'` and `present: false` on Darwin.

#### Wire-fingerprint hardening

`anthropicOAuthGet()` was originally sending the fetch defaults plus a `lm-assist/0.1` User-Agent. A review of real Claude Code traffic captured by `lm-proxy` (see [`lm-claude-endpoint:get-api-oauth-usage.md`](https://github.com/langmartai/lm-claude-endpoint/blob/main/pages/api-anthropic-com/get-api-oauth-usage.md)) showed three deviations from the real-client pattern; all are fixed:

| Header | Before | After |
|---|---|---|
| `User-Agent` | `lm-assist/0.1 (claude-code-oauth-proxy)` | `claude-code/<version>` from `detectClaudeCodeVersion()`, fallback `2.1.137` |
| `Accept-Encoding` | fetch default (`gzip, deflate, br`) | `gzip, compress, deflate, br` (axios pattern Claude Code inherits) |
| `Connection` | fetch default | `keep-alive` (explicit) |

Other Claude Code endpoints carry `anthropic-client-platform`, `anthropic-client-version`, `anthropic-version`, and `x-organization-uuid` headers, but `/api/oauth/usage` does **not**. We deliberately omit them — adding them here would itself be a deviation from the observed fingerprint.

`detectClaudeCodeVersion()` reads the installed `@anthropic-ai/claude-code` package by scanning common install locations (Windows: nvm4w `node_modules`, `%APPDATA%\npm`; Unix: `/usr/lib/node_modules`, `/usr/local/lib/node_modules`, `~/.local`). The result is memoized for the process lifetime.

`anthropicOAuthGet()` gains an optional `betaHeader: null` opt-out for endpoints (such as the initial post-login `/api/oauth/profile` fetch) that Claude Code calls without `anthropic-beta`.

#### Polling recommendation

Real Claude Code hits `/api/oauth/usage` only on the user's `/usage` command and from the `useRateLimitWarningNotification` hook — observed cadence in 5 days of captured traffic is roughly one call. Automated callers of this lm-assist route should cache responses and poll no faster than every ~5 minutes; a tight-loop watcher would be the loudest abnormal-traffic signal regardless of header correctness.

### Terminal API

- **refactor: `core/src/terminal-manager.ts` (536 LOC, monolithic) → `core/src/terminal/` (10+ modules, ~1940 LOC, layered)** — types / errors / validate / mutex / audit / tmux / inspector / registry / cc / spawn-tabs / manager. Each layer addresses a class of bugs from the post-merge review (22 bugs in the original). See `docs/terminal-refactor.md` for the full record.
- **fix: 22 bugs structurally prevented** — flag-merge in `ccLaunch`, pivot race against pre-pivot `❯`, target-body-bypass on send-keys, sshTarget shell injection on wt-ssh, gnome command injection, idempotency drift on `tmuxCreate`, empty wait-for pattern matching anything, `lines=0` returning full screen, no post-create cwd verification, no per-session mutex, no registry reconciliation, in-memory cache never reloaded, non-atomic registry write, `tmuxList` parser corrupted on `\t` in names, and others. Full list in `docs/terminal-refactor.md` §3.
- **fix: visible gnome tabs now tracked + closable** — three bugs in the `kind:'gnome'` path discovered during live UI testing: (a) `tabPid` was always null because `pgrep -x gnome-terminal-server` matches against `/proc/PID/comm` which Linux truncates to 15 chars; rewritten to read `/proc/*/cmdline` directly. (b) The `command` field did nothing because `bash -c '"$1"; exec bash'` quoted `$1` as a single executable name; switched to `bash -c 'eval "$1"; exec bash'` so shell operators work as users expect. (c) DELETE didn't close non-tmux gnome tabs because interactive bash ignores `SIGTERM`; now uses `SIGHUP` (simulates terminal hangup). Also adds `cwd` existence pre-check and explicit `SPAWN_FAILED` when no display env is available.
- **feat: window grouping + maximize for gnome tabs** — new `windowGroup` option (default `'lm-assist'`) makes all tabs share ONE maximized gnome-terminal window as native tabs instead of N floating windows. First tab spawns `gnome-terminal --window --maximize`; subsequent tabs locate it via `wmctrl -l` title-prefix and add a tab via `xdotool key ctrl+shift+t`. Per-tab cwd/command/title injected via a self-deleting `/tmp/lm-assist-tab-setup-XXX.sh` so only one short visible `source` line appears (then `clear` erases it). Requires `wmctrl` + `xdotool`; falls back to fresh window if either is missing.
- **New: typed error union** — `TerminalError` with 11 codes (`INVALID_INPUT`, `SESSION_NOT_FOUND`, `PRECONDITION_FAILED`, `POSTCONDITION_FAILED`, `TIMEOUT`, etc.) and per-code HTTP status mapping. Replaces the previous flat `TERMINAL_ERROR(string)`.
- **New: 5 endpoints for CC interactive control** — `POST /terminal/cc/:name/interrupt` (Ctrl-C), `/slash` (typed slash commands like `/clear`, `/agents`, `/usage`, `/model`, `/memory`, `/status`, `/config`, `/logout`), `/accept-dialog`, `/reject-dialog`, `/select-choice` (numbered menu picker). Plus `POST /terminal/tabs/prune-dead` to clean stale registry entries.
- **New: `GET /terminal/cc/:name/status` enriched** — returns `currentMode` (normal/plan/bash), `pendingDialog` (trust/permission/compact/choice), `authState` (authenticated/unauthenticated/unknown — read from `~/.claude.json` with screen fallback), `contextPct` (0–100 from footer), `authEmail`.
- **New: `wait-for` outcome enum** — `{ outcome: 'matched' \| 'timeout' \| 'session-gone' }` instead of just `{ matched: boolean }`. Callers can distinguish "still working" from "session crashed".
- **New: every mutation produces an audit log line** at `~/.cache/lm-assist/terminal-audit-{date}.jsonl` with op, session, outcome, elapsedMs, caller (from `X-LM-Caller` header).
- **New: 72-test integration + unit suite** under `core/src/__tests__/terminal/`. 38 integration tests (13 against live CC + 5 against live GUI gnome tabs, gated by `RUN_LIVE_CC=1` and gnome presence), 26 inspector unit tests, 3 wt-ssh static tests. Runs in ~10s without live CC, ~63s with. Wired via `npm test` and `npm run test:live`.

### Agent API

- **New: `POST /agent/session/:sessionId/resume`** — Resume an existing Claude Code session with a new prompt. Wraps `api.agent.resume()` so callers don't need to re-supply full session state.

### Cross-Platform

- **fix: detached-runner Windows support** — `spawnDetached()` now branches on platform. On Windows it resolves `claude.cmd` from the npm prefix, spawns with `shell: true` and explicit stdio fds (cmd.exe drops inherited fds when detached), and pipes the prompt through stdin instead of `-p <text>` (cmd.exe mangles large or special-char prompts). Unix path keeps the `setsid + nohup` double-fork unchanged.

## [0.1.64] - 2026-03-22

### Session List

- **New: Command session filter** — Toggle button ("Cmds") in the session sidebar filters to show/hide command-only sessions (slash command executions like `/trade-analyze`). Preference persists in localStorage.
- **fix: command-only sessions missing from list** — Sessions where all user prompts are slash commands were excluded from the session list. `isRealUserPrompt` now treats `command` prompt type as a real prompt.

## [0.1.63] - 2026-03-19

### Skill & Command Tracing

- **New: Skills dashboard page** (`/skills`) — Three-panel layout with skill inventory grouped by plugin, detail view with stats and session list, and analytics panel with top skills, chain patterns, and success rates.
- **New: Skills tab in session detail** — Vertical timeline showing all Skill tool invocations within a session, with chain flow visualization, span attribution (tools, files, subagents), and expandable detail view.
- **New: Commands tab in session detail** — Tracks slash command invocations (e.g., `/trade-analyze`) extracted from `<command-name>` XML tags in session messages.
- **New: Skill execution tracing** — Full causal chain per skill invocation: what instructions loaded, what tools Claude called, what files were touched, what subagents were spawned. Deep trace follows into subagent sessions recursively.
- **New: Cross-session skill index** — Persistent JSON index that builds lazily as sessions are loaded. Tracks invocation frequency, success rates, and common skill chain patterns (sliding window detection).
- **New: Installed skill inventory** — Scans `~/.claude/plugins/installed_plugins.json` to discover installed skills with full descriptions from SKILL.md frontmatter.
- **New: 8 REST API endpoints** — `/skills`, `/skills/analytics`, `/skills/analytics/chains`, `/skills/detail/:skillName`, `/sessions/:id/skills`, `/sessions/:id/skills/:index/trace`, `/skills/reindex`, `/skills/refresh-inventory`.

### Session Detail Enhancements

- **Skills tab shows invocation count badge** — `skillInvocationCount` flows through the full API stack.
- **Commands tab shows invocation count badge** — `commandInvocationCount` flows through the full API stack.
- **Skill detail session list** — Shows rich session metadata (model, cost, turns, users, agents, file size) matching the Sessions sidebar format, with last message preview.
- **Subagent expansion** — Session cards in skill detail show expandable subagent lists with type, description, cost, last message, and clickable links.
- **Selected skill persists** — Selected skill in the Skills page persists in localStorage across refreshes.

### Bug Fixes

- **fix: detect `<command-message>` prefix in classifyUserPrompt** — Slash command messages start with `<command-message>` not `<command-name>`; now detects both prefixes.
- **fix: subagent session lookup by agentId** — Skills/commands endpoints now match subagent sessions by agentId from filename, not just internal sessionId.
- **fix: background execute returns sessionId** — `/agent/execute` with `background: true` now polls up to 5s for sessionId before returning, instead of always returning null.
- **fix: LAN auth retry for new tabs** — Dashboard layout retries `/auth/is-local` check once with 3s timeout to handle race condition when Core API is slow to respond in new tabs.

## [0.1.62] - 2026-03-16

### Bug Fixes

- **fix: subagent conversations not visible in web session viewer** — Agent tool invocations returned empty `agentId` values because the parser relied on `agent_progress` messages that aren't always present. Now extracts agentId from the Agent tool_result text as a fallback.
- **fix: agent files with long first lines silently skipped** — `getAgentParentSessionId()` and `getAgentFirstLineData()` used fixed-size buffers (2KB/4KB) too small for agent files with large system prompts (4600+ bytes). Increased buffer to 16KB with regex fallback for truncated JSON.
- **fix: missing parentUuid on subagent invocations** — Invocations now capture the parent assistant message UUID, enabling position mapping in the web UI timeline.
- **fix: unify tool_result content handling** — The `parseSessionMessages()` tool_result handler only processed string content, making array-content subagent matching dead code. Now extracts text from both formats uniformly.

## [0.1.60] - 2026-03-13

- fix: console tab connecting to wrong session when another Claude instance runs in same project
- fix: fork session not working — auto-detection hijacked fork requests into existing tmux sessions

## [0.1.59] - 2026-03-11

### Knowledge Pipeline

- **Fix: Support Claude Code's `Agent` tool** — Claude Code renamed the subagent dispatch tool from `Task` to `Agent`. Session cache and agent session store now recognize both names, enabling subagent extraction from all recent sessions.
- **Fix: Accept `general-purpose` subagent type** — The explore-agent identifier and knowledge generator now accept both `explore` and `general-purpose` agent types, matching Claude Code's current subagent naming.
- **Fix: Knowledge stats count all active entries** — The `/knowledge/generate/stats` endpoint now counts all active knowledge entries (not just agent-sourced ones), so the UI title bar shows the correct total.
- **Fix: Mark duplicate candidates as skipped** — Duplicate generation errors now properly mark candidates as `skipped` instead of leaving them as perpetually `candidate`, preventing inflated pending counts.
- **Fix: Scheduler respects project exclusions** — Pending candidate counts now filter out excluded projects, so the scheduler status accurately reflects only active projects.

### Settings UI

- **New: "Run Now" button** — Trigger immediate knowledge discovery + generation from the Settings page instead of waiting for the 5-minute scheduler interval. Polls and updates status in real time.

### CLI

- **New: `lm-assist storage clean` command** — Clean the `~/.lm-assist` data directory with double confirmation (or `-y` flag to skip). Stops all running services before cleaning.

### API

- **New: `POST /knowledge/scheduler/run`** — Trigger immediate discovery + generation, bypassing interval timers.

## [0.1.58] - 2026-03-10

- feat: add session ID to statusline and expand session API docs
- feat: add excluded projects feature
- feat: add `lm-assist setup --key` CLI command for cloud connection
- fix: Windows SSH detached process killed on session close
- feat: knowledge scheduler, UI improvements, and bug fixes
