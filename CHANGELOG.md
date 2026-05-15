# Changelog

## [Unreleased]

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

#### Live test (2026-05-14, against yi@10.0.1.123's captured cookie)

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
