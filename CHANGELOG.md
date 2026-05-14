# Changelog

## [Unreleased]

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
