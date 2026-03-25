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

**Content structure — three sections:**

#### Monitor
- `GET /projects/sessions` — all sessions across projects
- `GET /monitor/executions` — running executions with live status
- `GET /monitor/summary` — aggregated counts
- `GET /projects` — list all projects

#### Debug
- `GET /sessions/:id` — full session data (15 dimensions)
- `GET /sessions/:id/conversation` — formatted chat
- `GET /sessions/:id/subagents` — subagent hierarchy
- `GET /sessions/:id/dag` — message DAG
- `GET /sessions/:id/related` — parent, forks, siblings

#### Control
- `GET /monitor/executions` — check before executing
- `POST /agent/execute` — launch new execution
- `POST /monitor/abort/:executionId` — abort running execution
- `POST /session-cache/warm` — pre-load sessions
- `POST /session-cache/clear` — clear cache

**Port detection:** Read `devModeEnabled` from `~/.claude-code-config.json` — if true use `:3200`, else `:3100`.

**Smart routing table:**

| User intent | API call |
|-------------|----------|
| "what's running?" | `GET /monitor/executions` |
| "show me recent sessions" | `GET /projects/sessions` (current project) |
| "show all projects" | `GET /projects` then `/projects/sessions` |
| "how much did that cost?" | `GET /projects/sessions` → format cost |
| "show me session abc123" | `GET /sessions/:id` with ID resolution |
| "show the subagent tree" | `GET /sessions/:id/subagents` |
| "run code review on this project" | Check → `POST /agent/execute` |
| "abort that execution" | `POST /monitor/abort/:executionId` |

**Session ID resolution:**
1. Slug name match ("silly-plotting-parasol")
2. Short ID prefix ("abc123")
3. "last session" / "previous" → most recent by timestamp
4. "the running one" → from `/monitor/executions`

### 2. Command: `commands/sessions.md`

**Trigger:** `/sessions [project-name]`

**Behavior:**
1. Call `GET /projects/sessions` (filter by project if arg provided)
2. Show last 10 sessions sorted by last modified
3. Each row: slug/name, project, model, cost, turns, time ago, status
4. Highlight running executions at top

**Output format:** Clean table, not JSON.

### 3. Command: `commands/run.md`

**Trigger:** `/run <prompt>` or `/run --project /path <prompt>`

**Behavior:**
1. Check `GET /monitor/executions` for running executions on target project
2. If found: report, ask to abort/parallel or proceed
3. Auto-format user's casual prompt into actionable execution prompt
4. Call `POST /agent/execute` with formatted prompt
5. Poll `GET /monitor/executions` to confirm started, report execution ID and status

**Default project:** Current working directory. Override with `--project`.

## File Structure

```
lm-assist/
├── skills/
│   └── observe.md          ← Main skill (auto-triggered)
├── commands/
│   ├── sessions.md         ← /sessions slash command
│   └── run.md              ← /run slash command
```

Auto-discovered by Claude Code plugin system — no `plugin.json` changes needed.

## No Backend Changes

All functionality uses existing REST API endpoints via curl. No new routes, MCP tools, or TypeScript changes required.

## Trade-offs

- **Skill file size (~300-400 lines):** Acceptable — skills load on demand, not every session
- **curl-based:** Slightly slower than MCP tools but avoids default context loading
- **Generic command names (`/sessions`, `/run`):** Risk of collision with other plugins but cleaner UX
- **Single skill vs split:** Cross-pillar queries work naturally; slight over-loading for simple queries
