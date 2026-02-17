# Claude Code Hook Scripts

This directory contains hook scripts for logging Claude Code events and enforcing task workflows.

## Files

| File | Description |
|------|-------------|
| `hook-lib.sh` | Shared library for cross-platform PID detection and event logging |
| `hook-event-logger.sh` | Universal logger for all 12 Claude Code hook types |
| `hook-event-logger.ps1` | Windows PowerShell version of the event logger |
| `hook-event-logger-settings.json` | Project-level settings template |
| `global-hook-settings.json` | User-level settings template for ~/.claude/settings.json |
| `install-hook-logger.sh` | Installation script for global hook logging |
| `intent-task-hook.sh` | Injects task creation instructions on UserPromptSubmit |
| `task-enforcement.sh` | Enforces parent task completion on Stop |
| `statusline-worktree.sh` | Status line showing active worktree and available worktrees |

## Hook Event Logger

Logs all Claude Code hook events to `~/.claude/hook-events.jsonl` in JSONL format.

### Important: Project-Level Installation

**Claude Code loads hooks from PROJECT-LEVEL `.claude/settings.json` only.**
User-level `~/.claude/settings.json` hooks may not be loaded.

### Installation

```bash
# Install to current project (recommended)
cd /path/to/your/project
./tier-agent-core/hooks/install-hook-logger.sh

# Or specify project path
./install-hook-logger.sh /path/to/project

# Check installation status
./install-hook-logger.sh --check

# Remove installation
./install-hook-logger.sh --remove

# Install globally (may not work - not recommended)
./install-hook-logger.sh --global
```

### Manual Installation

Add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/tier-agent-core/hooks/hook-event-logger.sh"}]}],
    "PreToolUse": [{"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/tier-agent-core/hooks/hook-event-logger.sh"}]}],
    "PostToolUse": [{"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/tier-agent-core/hooks/hook-event-logger.sh"}]}]
  }
}
```

### Log Format

Each line is a JSON object:

```json
{"ts":1706745600000,"sid":"abc123","pid":12345,"hook":"PreToolUse","event":"tool_pre","target":"bash","tool":"Bash","tuid":"toolu_01ABC","ok":true}
```

| Field | Description |
|-------|-------------|
| `ts` | Unix timestamp (milliseconds) |
| `sid` | Session ID |
| `pid` | Claude Code process ID |
| `hook` | Hook type (one of 12 types) |
| `event` | Derived event type |
| `target` | Target category (bash, file, task, etc.) |
| `tool` | Tool name |
| `tuid` | Tool use ID (links Pre/Post events) |
| `agentId` | Subagent ID (for SubagentStart/Stop) |
| `agentType` | Subagent type (Bash, Explore, Plan, custom) |
| `ok` | Success (true) or failure (false) |
| `decision` | Hook decision (allow, deny, block, etc.) |
| `err` | Error message if failed |

### All 12 Hook Types

| Hook | When It Fires |
|------|---------------|
| `SessionStart` | Session begins or resumes |
| `SessionEnd` | Session terminates |
| `UserPromptSubmit` | User submits prompt |
| `PermissionRequest` | Permission dialog appears |
| `PreToolUse` | Before tool executes |
| `PostToolUse` | After tool succeeds |
| `PostToolUseFailure` | After tool fails |
| `Notification` | Claude sends notification |
| `SubagentStart` | Subagent spawned |
| `SubagentStop` | Subagent finishes |
| `Stop` | Main agent finishes |
| `PreCompact` | Before context compaction |

### Querying Events

```bash
# Watch events in real-time
tail -f ~/.claude/hook-events.jsonl

# Filter by session
jq 'select(.sid == "abc123")' ~/.claude/hook-events.jsonl

# Filter by hook type
jq 'select(.hook == "PreToolUse")' ~/.claude/hook-events.jsonl

# Filter by tool
jq 'select(.tool == "Bash")' ~/.claude/hook-events.jsonl

# Count events by hook type
jq -s 'group_by(.hook) | map({hook: .[0].hook, count: length})' ~/.claude/hook-events.jsonl

# Find failed tool calls
jq 'select(.ok == false)' ~/.claude/hook-events.jsonl

# Correlate Pre/Post by tool_use_id
jq 'select(.tuid == "toolu_01ABC")' ~/.claude/hook-events.jsonl
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_HOOK_EVENTS_FILE` | `~/.claude/hook-events.jsonl` | Log file path |
| `CLAUDE_HOOK_DEBUG` | `false` | Enable debug output |

### Cross-Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | ✅ Supported | Uses `ps` and perl/python for timestamps |
| Linux | ✅ Supported | Uses `/proc` filesystem |
| Windows (Git Bash) | ✅ Supported | Uses bash $PPID |
| Windows (PowerShell) | ✅ Supported | Use `hook-event-logger.ps1` |
| WSL | ✅ Supported | Behaves like Linux |

## Intent Task Hook

Injects instructions on `UserPromptSubmit` to create parent tasks with `isIntent: true` metadata.

### Usage

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/tier-agent-core/hooks/intent-task-hook.sh"
          }
        ]
      }
    ]
  }
}
```

## Worktree Status Line

Shows which worktree the current Claude Code session is working on and lists all available worktrees. Detects the active worktree by parsing the session transcript for file-path references.

See [docs/worktree-statusline.md](../../docs/worktree-statusline.md) for full documentation.

### Installation

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/ubuntu/tier-agent/tier-agent-core/hooks/statusline-worktree.sh",
    "padding": 2
  }
}
```

## Task Enforcement Hook

Runs on `Stop` to check if parent tasks (intent tasks) should be marked completed.

### Usage

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/tier-agent-core/hooks/task-enforcement.sh"
          }
        ]
      }
    ]
  }
}
```
