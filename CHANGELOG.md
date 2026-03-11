# Changelog

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
