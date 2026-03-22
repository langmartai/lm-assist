# Changelog

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
