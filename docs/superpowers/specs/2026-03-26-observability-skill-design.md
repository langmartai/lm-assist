# lm-assist Observability Skill Design

**Date:** 2026-03-26
**Status:** Approved

## Summary

A Claude Code skill (`observe.md`) and two slash commands (`/sessions`, `/run`) that expose lm-assist's 155+ REST API endpoints as a natural language observability interface. Covers three pillars: Monitor, Debug, Control.

## Problem

lm-assist has a full REST API and web dashboard but zero CLI-level observability. The 6 existing `/assist-*` commands cover setup and knowledge — none expose session browsing, cost tracking, execution management, or debugging. Users must open the web UI or write raw curl commands.

## Approach

**Approach A: Single Monolithic Skill + 2 Commands** (chosen over split skills or MCP tools)

- One skill file handles all three pillars via natural language routing
- Two slash commands for the most frequent actions
- No backend changes — skill calls existing REST APIs via curl
- No MCP tools added — avoids context bloat since MCP tools load by default

## Components

### 1. Skill: `skills/observe.md`

**Trigger description:** "Use when the user asks about Claude Code sessions, running executions, agent status, session costs, token usage, subagent trees, or wants to run/monitor agent executions"

**Frontmatter:**
```yaml
---
description: "Use when the user asks about Claude Code sessions, running executions, agent status, session costs, token usage, subagent trees, or wants to run/monitor agent executions"
allowed-tools: Bash
---
```

**Port:** Hardcode `:3100` (production). All existing `/assist-*` commands use `:3100`. The `devModeEnabled` flag controls MCP/hook/statusline port routing only — not slash commands or skills.

**Content structure — three sections:**

#### Monitor
- `GET /projects/sessions` — all sessions across projects (supports `?ifModifiedSince=`)
- `GET /projects/:path/sessions` — sessions for a specific project
- `GET /monitor/executions` — running executions with live status (executionId, sessionId, status, turnCount, costUsd, elapsedMs)
- `GET /monitor/summary` — aggregated counts by status/tier
- `GET /projects` — list all projects with session counts

#### Debug
- `GET /sessions/:id` — full session data (15 dimensions: userPrompts, toolUses, responses, thinkingBlocks, tasks, todos, subagents, plans, skillInvocations, commandInvocations, teamOperations, teamMessages, slug, customTitle, forkedFromSessionId)
- `GET /sessions/:id/conversation?toolDetail=summary&lastN=20` — formatted chat
- `GET /sessions/:id/subagents` — subagent hierarchy
- `GET /sessions/:id/dag` — message DAG with branch info
- `GET /sessions/:id/session-dag` — cross-session DAG (subagents, teams)
- `GET /sessions/:id/related` — parent, forks, siblings

#### Control
- `POST /agent/execute` — launch new execution (see request body below)
- `POST /monitor/abort/:executionId` — abort running execution
- `POST /monitor/abort-all` — abort all executions
- `POST /session-cache/warm` — pre-load sessions into memory
- `POST /session-cache/clear` — clear cache (optional `?sessionId=` for specific)

### Agent Execution Request Body

`POST /agent/execute` accepts:

```json
{
  "prompt": "Review the authentication module for security issues",
  "cwd": "/home/ubuntu/my-project",
  "model": "opus",
  "permissionMode": "default",
  "maxTurns": 50,
  "systemPrompt": "You are a security reviewer...",
  "env": {},
  "background": false
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `prompt` | Yes | — | The execution prompt |
| `cwd` | No | Server's project path | Working directory |
| `model` | No | Server default | "opus", "sonnet", "haiku" or full model ID |
| `permissionMode` | No | "default" | "default", "plan", "autoAcceptEdits", "bypassPermissions" |
| `maxTurns` | No | — | Max conversation turns |
| `background` | No | false | Run detached |

### Smart Routing

The skill routes user intent to the right API call:

| User intent | API call |
|-------------|----------|
| "what's running?" / "any active sessions?" | `GET /monitor/executions` |
| "show me recent sessions" / "session list" | `GET /projects/sessions` (current project) |
| "show all projects" / "sessions across all projects" | `GET /projects` then per-project sessions |
| "how much did that cost?" / "session costs" | `GET /projects/sessions` → format cost column |
| "show me session abc123" / "details for silly-plotting" | `GET /sessions/:id` with ID resolution |
| "show the subagent tree" / "agent hierarchy" | `GET /sessions/:id/subagents` |
| "what did that agent do?" / "show conversation" | `GET /sessions/:id/conversation` |
| "show the DAG" / "message graph" | `GET /sessions/:id/dag` |
| "run code review on this project" | Check executions → `POST /agent/execute` |
| "abort that execution" / "stop it" | `POST /monitor/abort/:executionId` |
| "clear the cache" | `POST /session-cache/clear` |

### Session ID Resolution

When user references a session by name or partial ID, resolve in order:

1. **Slug match** — query `GET /projects/sessions`, match `slug` field (e.g., "silly-plotting-parasol"). Partial prefix match allowed ("silly-plot" matches).
2. **Short UUID prefix** — match first 6-8 chars of sessionId against session list (e.g., "abc123" → "abc12345-...").
3. **Relative reference** — "last session" / "previous" / "most recent" → sort by lastModified, take first.
4. **Running reference** — "the running one" / "current execution" → `GET /monitor/executions`, take the one for current project.
5. **Ambiguous** — if multiple matches, list them and ask user to pick.

### Skill vs Command Boundary

| `/sessions` command | `/run` command | `observe.md` skill |
|---------------------|----------------|---------------------|
| Quick list, last 10 | Simple execute with prompt | Complex queries |
| One API call | Check + execute + confirm | Multi-step analysis |
| Table output | Status report | Natural language response |
| No session detail | No debugging | Full 15-tab inspection |
| — | — | Cross-pillar ("cost of running session") |
| — | — | Abort, cache, fleet management |

Commands are thin wrappers for the two most common actions. The skill handles everything else.

### Error Handling

| Error | Response |
|-------|----------|
| API not running (connection refused) | "lm-assist API is not running. Start with `lm-assist start` or `/assist-setup`." |
| Session not found | "Session not found. Did you mean one of these?" + list similar slugs |
| Execution already running | "Execution already running on this project (ID: xxx, T:15, $2.34). Abort first or run in parallel?" |
| Execute validation error | Show the error message from API response |
| No sessions for project | "No sessions found for this project." |

---

### 2. Command: `commands/sessions.md`

**Trigger:** `/sessions [project-name]`

**Behavior:**
1. Call `GET http://localhost:3100/projects/sessions` (filter by project if arg provided)
2. Show last 10 sessions sorted by last modified
3. Each row: slug/name, project, model, cost, turns, time ago, status
4. Highlight running executions at top with status indicator

**Output format example:**
```
Recent Sessions (10 of 415)
───────────────────────────────────────────────────────────────────
  Status  Slug                        Project          Model   Cost     Turns  Modified
  [RUN]   silly-plotting-parasol      lm-unified-trade opus    $146.54  807    2m ago
  [RUN]   elegant-knitting-scone      lm-unified-trade opus    $107.43  516    8m ago
          anti-kelly-analysis         lm-unified-trade opus    $35.49   433    12m ago
          declarative-hugging-eclipse lm-unified-trade opus    $16.03   184    13m ago
          refactored-twirling-karp    lm-assist        opus    $12.87   95     1h ago
          ...
```

### 3. Command: `commands/run.md`

**Trigger:** `/run <prompt>` or `/run --project /path <prompt>`

**Behavior:**
1. Detect target project: use `--project` arg if provided, else current working directory
2. Check `GET http://localhost:3100/monitor/executions` for running executions on target
3. If running: report them with ID, turns, cost, elapsed — ask user to abort or proceed
4. Auto-format the user's prompt: expand casual intent into clear, actionable instructions
5. Call `POST http://localhost:3100/agent/execute` with `{ prompt, cwd }`
6. Poll `GET /monitor/executions` once after 3s to confirm started
7. Report: execution ID, status, and how to check progress

**Default project:** Current working directory (`$PWD`). Override with `--project /path/to/project`.

**Prompt auto-format example:**
- User: `/run review the auth module`
- Formatted prompt: "Review the authentication module for security vulnerabilities, code quality issues, and test coverage gaps. Report findings with severity ratings and specific file/line references."

## File Structure

```
lm-assist/
├── skills/
│   └── observe.md          ← Main skill (auto-triggered on observability questions)
├── commands/
│   ├── sessions.md         ← /sessions — quick session list
│   └── run.md              ← /run — execute agent on project
│   ├── assist.md           (existing)
│   ├── assist-status.md    (existing)
│   ├── assist-setup.md     (existing)
│   ├── assist-search.md    (existing)
│   ├── assist-logs.md      (existing)
│   └── assist-mcp-logs.md  (existing)
```

Auto-discovered by Claude Code plugin system — no `plugin.json` changes needed.

## No Backend Changes

All functionality uses existing REST API endpoints via curl on `localhost:3100`. No new routes, MCP tools, or TypeScript changes required.

## Trade-offs

- **Skill file size (~300-400 lines):** Acceptable — skills load on demand, not every session
- **curl-based:** Slightly slower than MCP tools but avoids default context loading
- **Generic command names (`/sessions`, `/run`):** Risk of collision with other plugins — accepted for cleaner UX
- **Single skill vs split:** Cross-pillar queries work naturally; slight over-loading for simple queries
- **Hardcoded port `:3100`:** Consistent with existing commands; dev users must have prod running
