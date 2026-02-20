# Inside Claude Code: The Session File Format and How to Inspect It

## What Actually Happens in a Claude Session?

When you ask Claude Code to implement a feature, fix a bug, or explore a codebase, a lot happens beneath the conversation surface. Claude reads files, executes searches, spawns specialized subagents, reasons through problems in a private thinking layer, and coordinates across a team of agents — all before writing a single line of reply.

Every step of that process is recorded.

Claude Code stores a complete, machine-readable transcript of every session as structured JSONL files on your local disk. Not summaries. Not logs. The full message-by-message record: tool calls with their exact inputs and outputs, extended thinking blocks, subagent spawning events, token usage per turn, model selection, working directory, git state snapshots — everything.

Most Claude Code users have never looked at these files directly. The raw format is dense and the signal is buried. That is the problem lm-assist solves: it reads, parses, indexes, and renders this data into a UI that surfaces what actually happened inside any session, including sessions you never ran yourself.

---

## Where the Files Live

Claude Code writes session data to a fixed directory structure on your machine:

```
~/.claude/
├── projects/
│   └── <url-encoded-project-path>/
│       └── sessions/
│           ├── <session-uuid>.jsonl        ← conversation transcript
│           └── ...
├── tasks/
│   └── <session-id>/                      ← one directory per task list
│       ├── 1.json                         ← individual task file
│       ├── 2.json
│       └── ...
├── plans/
│   └── <plan-name>.md                     ← plan markdown files
└── teams/
    └── <team-name>.json                   ← team configurations
```

The project path in the directory name is URL-encoded. A project at `/home/user/myapp` becomes `-home-user-myapp`. Each session gets its own JSONL file named by UUID. The file grows by one line per message as the session runs — it is purely append-only.

There is no database, no index, no metadata store. Everything is in these flat files.

---

## The JSONL Message Format

Each line in a session file is a JSON object (a "record") representing one message or event. Records have a shared envelope:

```json
{
  "type": "assistant",
  "uuid": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "parentUuid": "1a2b3c4d-...",
  "timestamp": "2025-02-20T09:14:32.441Z",
  "sessionId": "abc123",
  "cwd": "/home/user/myapp",
  "message": { ... }
}
```

The `parentUuid` field is what makes sessions a **directed acyclic graph**, not just a linear list. Every message points to the message it responded to. When a conversation branches — exploring alternatives, retrying a failed tool call, or running a subagent concurrently — each branch has its own chain of messages linked by `parentUuid`.

### Message Types

Claude Code defines seven core message types. Understanding them is the key to reading a session at depth.

---

### `user` — Your Prompts and Hook Results

The simplest type. A `user` record contains what was sent to Claude: your typed prompt, injected hook context, system caveats, or tool results being returned.

```json
{
  "type": "user",
  "uuid": "...",
  "parentUuid": "...",
  "timestamp": "2025-02-20T09:14:28.000Z",
  "message": {
    "role": "user",
    "content": "Add input validation to the createUser endpoint"
  }
}
```

LM Assist classifies user records further into sub-types:
- **user** — your actual typed prompt
- **command** — slash commands like `/help` or `/model`
- **command_output** — output injected back from a command
- **hook_result** — context injected by the UserPromptSubmit hook (lm-assist knowledge injection shows up here)
- **system_caveat** — internal system notes injected by Claude Code

---

### `assistant` — Claude's Responses with Content Blocks

The most information-dense type. An `assistant` record contains everything Claude said in a single turn, including its text response, any tool calls, and its internal reasoning. The content is an array of **content blocks**:

```json
{
  "type": "assistant",
  "uuid": "...",
  "parentUuid": "...",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-5-20251101",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants validation on createUser. I should check what validation library they already use..."
      },
      {
        "type": "text",
        "text": "I'll add input validation using the existing zod schema patterns in your codebase."
      },
      {
        "type": "tool_use",
        "id": "toolu_01abc",
        "name": "Read",
        "input": { "file_path": "/home/user/myapp/src/routes/users.ts" }
      }
    ],
    "usage": {
      "input_tokens": 12840,
      "output_tokens": 631,
      "cache_read_input_tokens": 8200,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 3600,
        "ephemeral_1h_input_tokens": 0
      }
    }
  }
}
```

Three content block types appear inside assistant messages:

**`text`** — The visible reply. Everything Claude writes to you.

**`tool_use`** — A tool call. Contains the tool name, a unique ID, and the exact input Claude constructed. Every Bash command, file read, web fetch, MCP call, and subagent spawn appears here with full inputs. Nothing is hidden.

**`thinking`** — Extended thinking. When Claude uses extended thinking (enabled automatically for Claude Opus models on complex tasks), its internal reasoning process is recorded verbatim in thinking blocks. This is the scratchpad Claude uses to work through problems before writing its response. Seeing it reveals exactly why Claude made each decision.

The `usage` field records token counts for that specific assistant turn: input tokens consumed, output tokens produced, cache hits (reads and writes), and the split between 5-minute and 1-hour ephemeral cache tiers.

---

### `tool_result` — What Tools Returned

After each `tool_use` block in an assistant message, the tool output comes back as a `tool_result` record. The correlation is by `tool_use_id`:

```json
{
  "type": "tool_result",
  "uuid": "...",
  "parentUuid": "...",
  "toolUseResult": {
    "tool_use_id": "toolu_01abc",
    "content": "import { z } from 'zod';\n\nexport const createUserSchema = z.object({\n  email: z.string().email(),\n...",
    "is_error": false
  }
}
```

Tool results can be error states (`is_error: true`) — which lm-assist surfaces with visual error indicators. Full output content is stored: the entire file content Claude read, the complete Bash stdout/stderr, the full MCP search results.

---

### `system` — The Initial Context

The first record in every session file is a `system` message containing the complete system prompt Claude received at session start: tool definitions, permission modes, project context, injected CLAUDE.md content, and any configured MCP server instructions. This shows you the exact starting state of any session.

---

### `summary` — Compaction Checkpoints

When a session's context window approaches its limit, Claude Code compacts the conversation: it summarizes older turns and replaces them with a compressed representation. The compaction summary is stored as a `summary` record. LM Assist renders these as clearly marked checkpoints in the message timeline, so you can see exactly where compaction happened and what was condensed.

---

### `result` — Session Completion Markers

The final record in a completed session. Contains the session outcome, whether the task succeeded or was interrupted, final cost summary, and any structured output Claude produced.

---

### `file-history-snapshot` — Git State

Recorded at session start, this captures the git state of the working directory: staged changes, unstaged changes, untracked files. It is the baseline against which all file changes during the session can be diffed.

---

## The Token Economy Per Turn

Every assistant turn has a `usage` block. This means lm-assist can show you per-turn token costs, not just session totals:

```
Turn 1 (exploration): 15,240 input | 842 output | 8,100 cache hit
Turn 2 (planning):     3,820 input | 1,240 output | 12,000 cache hit
Turn 3 (implementation): 4,100 input | 2,890 output | 13,500 cache hit
```

Cache read tokens are typically billed at 10% of base input price. When you see high cache hit numbers, Claude is efficiently reusing previously processed context — your CLAUDE.md, tool definitions, and early conversation turns that have not changed.

---

## Sessions as Trees: Subagents and Teams

Individual sessions are message chains via `parentUuid`. But the deeper structure is cross-session: Claude Code can spawn **subagents** — separate sessions that execute specialized tasks and report back. Each subagent runs in its own JSONL file with its own full message history.

LM Assist tracks these relationships through session metadata fields: `parentToolUseId` (the tool call that spawned a subagent), `agentId`, `agentType`, and `teamName`. Using these, it reconstructs the full execution tree and shows it as an agent tree view.

![Agent tree view — a single session spawns multiple specialized subagents (Explore, Search, Plan, Bash). Each shows its type, prompt, tool usage count, token cost, and result status. The tree makes the execution hierarchy immediately clear.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/agent-tree.png)

---

## How Claude Opus 4.5 Teams Work

With Claude Opus 4.5 and newer, Claude Code introduced **team mode** — a structured multi-agent pattern where a lead agent coordinates a set of specialist teammate agents to tackle complex tasks in parallel.

A team session looks like this in the file system:

```
sessions/
├── team-lead-uuid.jsonl         ← orchestrator
├── teammate-explore-uuid.jsonl  ← file exploration specialist
├── teammate-search-uuid.jsonl   ← code search specialist
├── teammate-plan-uuid.jsonl     ← plan generation specialist
└── teammate-bash-uuid.jsonl     ← execution specialist
```

Each session file is complete and independent. The coordination happens through tool calls in the team lead session: the lead spawns teammate agents via the Task tool, each runs autonomously in its own JSONL file, and returns a result back to the lead's `tool_result` records.

**What this means for inspection:** You can read any teammate session on its own and see exactly what it did — its thinking, its tool calls, what it found. You can also see from the team lead's perspective exactly what prompt each teammate received and what it returned. LM Assist surfaces both views.

```json
// Inside team-lead session: the spawn call
{
  "type": "tool_use",
  "name": "Task",
  "input": {
    "subagent_type": "Explore",
    "description": "Find all authentication middleware",
    "prompt": "Search for all middleware that validates JWT tokens..."
  }
}

// And the result, back in the lead session
{
  "type": "tool_result",
  "toolUseResult": {
    "tool_use_id": "toolu_spawn_01",
    "content": "Found 3 middleware files: src/middleware/auth.ts (line 24)..."
  }
}
```

The team configuration itself is stored in `~/.claude/teams/<team-name>.json`, which defines which models to use for each role, budget limits, and specialization instructions.

![Team view — the team session browser shows all sessions in a team run: the lead agent and each teammate with their individual token costs, tool call counts, and status. Select any member to drill into their full session.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/team-view.png)

---

## Plans, Tasks, and the Kanban Layer

Two more data types live alongside session files, each in their own directory.

### Plans — `~/.claude/plans/*.md`

When Claude enters plan mode (via the `EnterPlanMode`/`ExitPlanMode` tool calls), the plan is written as a standalone markdown file in `~/.claude/plans/`. Each file is named by the plan title and contains the full structured plan: goals, steps, approach, and any constraints.

```
~/.claude/plans/
├── implement-auth-middleware.md
├── refactor-session-cache.md
└── add-webhook-endpoints.md
```

These are plain markdown — readable on their own, and rendered in lm-assist with a visual plan view that links each step back to the session that created it.

![Plan view — a plan file rendered as a structured timeline. Each step shows its title, status, and the session context where it was created.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/plan-view.png)

### Tasks — `~/.claude/tasks/{session-id}/{id}.json`

Tasks are stored as individual JSON files, one file per task, organized into directories by session (or task list ID). Each task is a structured object with subject, description, status, and dependency links:

```json
{
  "id": "3",
  "subject": "Add input validation to createUser",
  "description": "Use zod schema to validate request body before database write",
  "status": "in_progress",
  "blocks": ["4", "5"],
  "blockedBy": ["1"],
  "metadata": {
    "type": "implementation",
    "priority": "high",
    "tags": ["validation", "api"]
  }
}
```

The `blocks` and `blockedBy` arrays create a dependency graph across tasks within a list. LM Assist reads all task directories, aggregates across sessions and projects, and renders the full set as a unified Kanban board — showing what every Claude agent is currently working on across your entire machine.

![Task Kanban — tasks from all active sessions as a live kanban board. Each card shows the session, project, priority, and dependency status. Every in-flight Claude Code task list across all your projects in one view.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/task-kanban.png)

---

## LM Assist: The Deep Inspection UI

Raw JSONL files are useful but not readable at scale. A complex team session with 8 agents, 400 messages, and 50 tool calls is not something you parse by hand. LM Assist reads all of these files, parses the structure, and renders it in a web UI designed specifically for session inspection.

Here is what you can do with it that you cannot do with raw files:

### Browse All Sessions Across All Projects

The session browser lists every Claude Code session on your machine: project name, session ID, model used, token count, cost in USD, duration, status (completed/running/error/interrupted), and the first user prompt as a summary. Filter by project, sort by cost or recency, search by content.

![Session browser — every Claude Code session across all projects. Status badges, token counts, cost in USD, model name, and first prompt visible at a glance. Click any session to open the full inspector.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-browser.png)

### Read the Full Conversation with Tool Call Details

The session detail view renders the full message timeline: your prompts, Claude's text responses, thinking blocks (collapsed by default, expandable), tool calls with formatted inputs, and tool results with full output content. Every message shows its timestamp and UUID.

Tool calls are rendered with their exact inputs formatted for readability — a Read tool call shows the file path and line range, a Bash call shows the command and description, a Task spawn shows the subagent type and full prompt.

![Session detail — the full conversation timeline showing user prompts, assistant responses, thinking blocks, tool calls with inputs, and tool results. The complete internal record of what happened.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-detail-chat.png)

### Inspect Extended Thinking

When a session used extended thinking, the thinking blocks are stored in the JSONL and rendered in lm-assist. You can read Claude's internal reasoning verbatim: the hypotheses it considered, why it chose one approach over another, what it noticed in the files it read.

This is not paraphrase or summary. It is the actual scratchpad Claude used to think through the problem.

### See the Full Subagent Tree

The agent tree view shows every agent spawned from a session as a hierarchical tree. Each node shows:
- Agent type (Explore, Bash, general-purpose, etc.)
- The prompt it received
- How many tool calls it made
- Token cost for that agent alone
- Status (completed, error, running)
- Time to first token and total duration

Click any agent node to jump to its session detail.

### Live Terminal for Running Sessions

For sessions that are still running, lm-assist opens a live terminal view via `ttyd`. You can watch tool calls execute in real time, see Claude's output as it streams, and connect to a live session without a separate terminal window.

![Session terminal — live terminal access to a running session. Watch tool calls, output, and Claude's responses stream in real time via ttyd.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-terminal.png)

### Per-Turn Token and Cost Breakdown

Every assistant turn is annotated with its token counts: input, output, cache reads (5m and 1h), and the estimated cost for that turn at current API pricing. Session totals aggregate these. You can see exactly which turns cost the most and why.

---

## Real Example: Inspecting GitHub Copilot's Claude Agent Mode

GitHub Copilot includes an agent mode that uses Claude (Sonnet or Opus) to perform multi-step coding tasks. When Copilot operates in Claude agent mode, it runs Claude Code under the hood — and that means every Copilot task creates session files in `~/.claude/projects/` on your machine.

LM Assist reads these sessions identically to any other Claude Code session. The result: you can inspect every Copilot task at the same level of detail as sessions you ran manually.

Here is what you see when you open a Copilot Claude agent session in lm-assist:

**The prompt Copilot sent to Claude.** The exact task description, including any context Copilot injected about your open files, recent changes, and workspace state.

**Every file read.** The Read and Glob tool calls show you precisely which files Claude examined and in what order. This tells you whether Copilot understood the right parts of your codebase.

**Every search performed.** Grep and Glob tool calls with their exact patterns. You can see whether Claude searched effectively or missed obvious locations.

**Every Bash command executed.** The exact commands Copilot ran on your system, their full stdout/stderr output, and whether they succeeded or failed.

**Claude's thinking.** If the Copilot task used a model with extended thinking enabled, you can read the full internal reasoning — including cases where Claude considered multiple approaches and chose the one it executed.

**Where it went wrong.** If a Copilot task produced unexpected output, the tool call sequence shows you exactly where the reasoning diverged. Did it read the wrong file? Make an incorrect assumption about the return type? Pass the wrong argument to a function? The session file has the answer.

**Token and cost breakdown.** The exact cost of the Copilot task, turn by turn.

This works because Copilot, like all Claude Code integrations, writes to the same `~/.claude/` directory structure. LM Assist does not need special Copilot integration. It just reads the files that are already there.

---

## What the Raw Files Cannot Show You (But LM Assist Can)

Some things require aggregation and cross-session analysis that raw JSONL inspection cannot provide:

**Subagent tree reconstruction.** Which sessions spawned which? How did a team of 5 agents coordinate on a single task? The parent-child tree is reconstructed from `parentToolUseId` and `agentId` metadata across multiple session files.

**Deduplication.** Claude Code sometimes writes the same message (same UUID) to multiple JSONL files during branching or resumption. Token counting without deduplication gives inflated totals. LM Assist deduplicates by UUID before summing.

**File change diff.** What did a session actually modify? LM Assist correlates `file-history-snapshot` records with file write tool calls to produce a clean diff of what changed.

**Unified task view.** Task files are per-session, spread across many directories. A unified Kanban view requires reading and merging all task files across all sessions and projects.

**Semantic search over session content.** Finding which sessions discussed a particular topic, function, or bug requires vector indexing across all session content.

---

## Getting Started

LM Assist is open source and runs entirely on your machine. Nothing leaves your environment.

**Project:** [github.com/langmartai/lm-assist](https://github.com/langmartai/lm-assist)

**Install as a Claude Code plugin:**
```bash
# From the lm-assist repo
claude plugin install .

# Or via npm
npm install -g lm-assist
```

**Start the services:**
```bash
./core.sh start
```

Open `http://localhost:3848` and your full session history is immediately available for inspection — including any Claude agent sessions from Copilot, Cursor, or any other tool that uses Claude Code on your machine.

**Settings page** exposes hook management (context injection, event logger), MCP server status, and the statusline configurator:

![Settings — hook configuration, MCP server status, statusline setup, and connection health. All managed from the same UI.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/settings.png)

---

## Summary

Claude Code stores complete, structured session transcripts in JSONL files under `~/.claude/`. Each file is a chain of typed message records linked by `parentUuid`: user prompts, assistant responses with content blocks (text, tool calls, thinking), tool results, system prompts, summaries, and git snapshots. Every tool call has its full input. Every assistant turn has token usage. Every subagent spawn links to a child session file.

The formats Claude Code uses:

| Record Type | What It Contains |
|-------------|-----------------|
| `user` | Your prompts, hook injections, tool results fed back |
| `assistant` | Text responses, tool calls, extended thinking blocks, token usage |
| `tool_result` | Tool output (file content, command output, search results) |
| `system` | Full system prompt including tool definitions and CLAUDE.md |
| `summary` | Compaction checkpoints — compressed conversation history |
| `result` | Session completion status and final output |
| `file-history-snapshot` | Git working tree state at session start |

And within assistant content blocks:

| Content Block | What It Contains |
|--------------|-----------------|
| `text` | Claude's written response |
| `tool_use` | A tool call with name, ID, and exact input |
| `thinking` | Extended thinking scratchpad (internal reasoning) |

LM Assist parses all of this into a web UI that makes every session inspectable: conversation timelines, agent trees, plan views, task Kanbans, per-turn token costs, and live terminals for running sessions. It works on any session written by any Claude Code integration — including GitHub Copilot's Claude agent mode, Cursor, and any other tooling that uses the Claude Code SDK.

The files are on your disk. The data is all there. LM Assist makes it readable.

---

## Resources

- **GitHub:** [github.com/langmartai/lm-assist](https://github.com/langmartai/lm-assist)
- **Issues and Feature Requests:** [github.com/langmartai/lm-assist/issues](https://github.com/langmartai/lm-assist/issues)
- **Knowledge Reuse Guide:** See `docs/session-knowledge-reuse.md` — how to extract and reuse knowledge from session history
- **API Reference:** See `CLAUDE.md` for complete endpoint documentation
