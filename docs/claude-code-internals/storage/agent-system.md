# Agent System

Source: `tools/AgentTool/` (18 files), `utils/plugins/loadPluginAgents.ts`

## Agent Types

Three sources of agents:

### Built-In Agents

Hard-coded in the CLI binary. Loaded from `tools/AgentTool/builtInAgents.ts`:

| Agent Type | Model | Tools | Purpose |
|-----------|-------|-------|---------|
| `general-purpose` | default subagent model | `*` (all) | Multi-step tasks, code search |
| `Explore` | haiku (external), inherit (ant) | All except Edit/Write/Agent/ExitPlanMode | Fast read-only codebase search |
| `Plan` | inherit | All except Edit/Write/Agent/ExitPlanMode | Design implementation plans |
| `claude-code-guide` | — | — | Answer Claude Code usage questions |
| `statusline-setup` | — | Read, Edit | Configure statusline |
| `verification` (ant-only) | — | — | Adversarial code review |

Feature-gated: Coordinator workers (`COORDINATOR_MODE`), disabled via `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`.

### Custom Agents (user-defined)

Markdown files with frontmatter, loaded from:
- `~/.claude/agents/` (user scope)
- `.claude/agents/` (project scope)
- `/etc/claude/.claude/agents/` (policy scope)
- `{plugin}/agents/` (plugin scope)

### Plugin Agents

Loaded via `loadPluginAgents()` from installed plugins' `agents/` directories.

## Agent Definition Schema

Markdown file frontmatter:
```yaml
---
description: What this agent does (used as whenToUse)
tools: Read, Grep, Glob, Bash
disallowed-tools: Agent, ExitPlanMode
model: haiku
effort: high
skills: "skill1, skill2"
permission-mode: default
mcp-servers:
  - slack
  - name: { command: "node", args: ["server.js"] }
hooks:
  PreToolUse:
    - matcher: { tool_name: "Bash" }
      hooks:
        - type: command
          command: "validate.sh"
max-turns: 20
initial-prompt: "/setup"
memory: project
background: true
isolation: worktree
color: blue
---

System prompt for this agent goes here.
The body of the markdown file IS the system prompt.
```

JSON format also supported (in `agents.json` file):
```json
{
  "my-agent": {
    "description": "...",
    "prompt": "System prompt here",
    "tools": ["Read", "Grep"],
    "model": "haiku",
    "effort": "high",
    "mcpServers": ["slack"],
    "hooks": {...},
    "maxTurns": 20,
    "memory": "project",
    "background": true,
    "isolation": "worktree"
  }
}
```

## Agent Memory

Agents can have persistent memory (separate from main session memory):

| Scope | Path |
|-------|------|
| `user` | `~/.claude/agent-memory/{agentType}/` |
| `project` | `.claude/agent-memory/{agentType}/` |
| `local` | `.claude/agent-memory-local/{agentType}/` |

Uses the same MEMORY.md + topic files pattern as the main memory system.
`agentMemorySnapshot.ts` handles snapshot-based updates for remote agents.

## Agent Execution

### In-Process (Default)

`runAgent.ts` forks the conversation:
1. Inherits system prompt + env info via `enhanceSystemPromptWithEnvDetails()`
2. Gets its own `agentId` and writes to a separate JSONL (`agent-{agentId}.jsonl`)
3. Metadata sidecar: `agent-{agentId}.meta.json` with `{ agentType, worktreePath?, description? }`
4. Runs in same process with tool access filtered by `tools`/`disallowedTools`

### Worktree Isolation

`isolation: "worktree"`: Agent runs in a git worktree copy:
1. Create worktree: `git worktree add`
2. Agent CWD set to worktree path
3. On completion: if changes made, return worktree path + branch; else cleanup

### Remote (ant-only)

`isolation: "remote"`: Agent runs on CCR infrastructure.

### Background

`background: true`: Agent runs as a background task. User continues chatting while agent works. Results delivered via task output system.

### Fork Subagent

`feature('FORK_SUBAGENT')`: Alternative to standard subagent — runs as a context fork in background, keeps tool output out of main context window.

## Agent Colors

8 colors: `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `magenta`, `cyan`
Assigned via `agentColorManager.ts` — auto-assigns unique color per concurrent agent.

## Resume

On `--resume`, agent metadata is read from `.meta.json` sidecar to restore the correct `agentType` and `worktreePath`. Without this, resuming a fork degrades to general-purpose (wrong system prompt).

## Storage on Disk

```
~/.claude/projects/{key}/{sessionId}/
├── subagents/
│   ├── agent-{agentId}.jsonl          # Agent transcript (JSONL)
│   ├── agent-{agentId}.meta.json      # { agentType, worktreePath?, description? }
│   └── {runId}/                       # Grouped subagents (workflows)
│       ├── agent-{agentId}.jsonl
│       └── agent-{agentId}.meta.json
├── remote-agents/
│   └── remote-agent-{taskId}.meta.json  # { taskId, sessionId, title, ... }
└── tasks/
    └── {taskId}.output                # Task output (disk-backed)

~/.claude/agent-memory/               # User-scope agent memory
    └── {agentType}/
        ├── MEMORY.md
        └── *.md

.claude/agent-memory/                 # Project-scope agent memory
    └── {agentType}/
        ├── MEMORY.md
        └── *.md
```
