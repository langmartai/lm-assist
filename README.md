# lm-assist

## The Observability Platform for Claude Code & Agent SDK

Monitor, debug, and control AI coding agents with full session visibility, real-time execution tracking, and 155+ REST API endpoints.

[![Discord](https://img.shields.io/discord/1475647234669543558?logo=discord&label=Discord&color=5865F2)](https://discord.gg/xb2BNnk4)

- **Monitor** — real-time execution tracking, per-model cost & token breakdown, SSE event stream
- **Debug** — 15 insight views per session: Chat, Thinking, Agents, Plans, Team, DAG, Files, Git & more
- **Control** — web terminal from any browser, start/abort agents via API, remote access from anywhere

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-observability.svg"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-observability.svg" alt="lm-assist Architecture — Observability Platform for Claude Code & Agent SDK" width="700"></a>

### Install

```
/plugin marketplace add langmartai/lm-assist
/plugin install lm-assist@langmartai
```

Then **open a new Claude Code session** and run `/assist-setup`.

> **Read:** [Inside Claude Code: The Session File Format and How to Inspect It](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b) — technical breakdown of the JSONL session format, message types, subagent trees, and how lm-assist surfaces it all.

---

## Why lm-assist

Claude Code and the Agent SDK have no built-in dashboard. You get a terminal or logs. When you're running multiple agents, debugging a failed execution, or tracking costs across a fleet of machines — you need full visibility into every session, every subagent, every tool call, every token spent.

| Without lm-assist | With lm-assist |
|-------------------|---------------|
| Scroll through terminal output | 15 specialized views per session |
| No cost visibility | Per-model token & cost breakdown |
| Can't see what agents are doing | Real-time execution dashboard |
| No way to inspect subagent trees | Full DAG visualization |
| Terminal-only access | Web UI from any device, anywhere |
| Agent SDK runs are black boxes | Same session inspection as CLI |

---

## Three Pillars

### 1. Monitor

Real-time execution dashboard with live session tracking, cost analytics, and multi-machine fleet management.

<a href="https://langmart.ai/images/assist/session-browser.png"><img src="https://langmart.ai/images/assist/session-browser.png" alt="Session Browser — live sessions with cost and token tracking" width="700"></a>

> *Browse all sessions with human-readable names, live status, per-model cost breakdown — from any browser, anywhere*

- Session list with human-readable names, live status, and running process detection
- Per-model cost and token breakdown (input, output, cache read, cache creation)
- SSE event stream for real-time updates
- Multi-machine fleet dashboard via LangMart Hub
- Rate limit tracking in statusline (5h/7d usage)

**Key endpoints:** `GET /monitor/executions` · `GET /stream` · `GET /sessions` · `GET /projects/sessions`

### 2. Debug

15 specialized views per session. Trace any decision through conversation flow, extended thinking, subagent hierarchy, tool calls, file changes, and git operations.

<table>
  <tr>
    <td><a href="https://langmart.ai/images/assist/agent-tree.png"><img src="https://langmart.ai/images/assist/agent-tree.png" alt="Agent Tree" width="340"></a><br><sub>Subagent hierarchy</sub></td>
    <td><a href="https://langmart.ai/images/assist/plan-view.png"><img src="https://langmart.ai/images/assist/plan-view.png" alt="Plan View" width="340"></a><br><sub>Plan mode tracking</sub></td>
  </tr>
  <tr>
    <td><a href="https://langmart.ai/images/assist/task-kanban.png"><img src="https://langmart.ai/images/assist/task-kanban.png" alt="Task Kanban" width="340"></a><br><sub>Task kanban board</sub></td>
    <td><a href="https://langmart.ai/images/assist/team-view.png"><img src="https://langmart.ai/images/assist/team-view.png" alt="Team View" width="340"></a><br><sub>Multi-agent team coordination</sub></td>
  </tr>
</table>

<details>
<summary><strong>All 15 tabs at a glance</strong></summary>

| Tab | What You See |
|-----|-------------|
| **Chat** | Full conversation with syntax-highlighted code blocks |
| **Thinking** | Claude's extended thinking / chain-of-thought |
| **Agents** | Subagent tree — Explore, Plan, Bash, and custom agents |
| **Skills** | Skill invocation timeline with chain flow, span attribution, and deep trace |
| **Commands** | Slash command invocations with args and timing |
| **Tasks** | Task lists with dependency tracking |
| **Plans** | Plan mode entries with approval status |
| **Team** | Team/swarm coordination (multi-agent teams) |
| **Files** | All files read, written, or edited during the session |
| **Git** | Commits, pushes, and diffs from the session |
| **Console** | Terminal output and process management |
| **Summary** | AI-generated session summary |
| **Meta** | Session metadata — slug, timing, model, token usage |
| **JSON** | Raw session JSONL data |
| **DB** | Internal cache and index data |

</details>

- Session DAG visualization (message graph + cross-session subagent/team graph)
- Fork tracking and branch visualization
- Tool call traces with full inputs and results

**Key endpoints:** `GET /sessions/:id` · `GET /sessions/:id/dag` · `GET /sessions/:id/subagents` · `GET /sessions/:id/conversation`

### 3. Control

Full runtime management API. Start, stop, and monitor agent executions from any device. Web terminal access to running Claude Code sessions.

<a href="https://langmart.ai/images/assist/session-terminal.png"><img src="https://langmart.ai/images/assist/session-terminal.png" alt="Web Terminal — control Claude Code from any browser" width="700"></a>

> *Live terminal access to running Claude Code sessions — from any browser, anywhere*

- Start and abort agent executions via REST API
- Web terminal (ttyd) from any browser — control Claude Code remotely
- SDK runner for programmatic headless execution
- Session cache warm/clear for performance tuning
- Remote access via LangMart Hub — no VPN or port forwarding needed

**Key endpoints:** `POST /monitor/abort/:executionId` · `POST /ttyd/start` · `POST /agent/execute` · `POST /hub/connect`

### Settings

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/settings.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/settings.png" alt="Settings" width="700"></a>

> *Settings — connection status, Claude Code config, knowledge kill switch, and more*

### Mobile & Tablet Support

The web UI is fully responsive. Monitor sessions, debug agents, and control terminals from your phone or tablet.

<table>
  <tr>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-terminal%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-terminal%20(mobile).png" alt="Terminal on mobile" width="180"></a><br><sub>Live Terminal</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-detail-chat%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-detail-chat%20(mobile).png" alt="Session detail on mobile" width="180"></a><br><sub>Session Detail</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/task-kanban%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/task-kanban%20(mobile).png" alt="Task kanban on mobile" width="180"></a><br><sub>Task Kanban</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-connection%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-connection%20(mobile).png" alt="Settings on mobile" width="180"></a><br><sub>Settings</sub></td>
  </tr>
</table>

---

## Data Sources

lm-assist reads the same JSONL session files regardless of how they were created:

| Source | What It Produces | lm-assist Coverage |
|--------|-----------------|-------------------|
| **Claude Code CLI** | Interactive sessions with subagents, teams, worktrees | Full parsing — all message types, tool calls, metadata |
| **Agent SDK** (Python/TypeScript) | Programmatic agent executions | Same JSONL format — full session inspection |
| **Headless mode** (`claude -p`) | Background/CI runs | Detected via process status store |
| **Running processes** | Live PID, tmux, terminal state | Real-time monitoring with zero polling overhead |

---

## Knowledge (Optional)

lm-assist includes an optional knowledge subsystem that auto-extracts reusable knowledge from your sessions and injects it into future prompts via MCP tools and a context hook. Enable or disable it at runtime from Settings — the kill switch unloads the embedder and vector store to save ~100MB of memory.

> **Read:** [Your Claude Sessions Are Gold: Stop Paying Twice for the Same Knowledge](https://databunny.medium.com/your-claude-sessions-are-gold-stop-paying-twice-for-the-same-knowledge-7632ac6ddb88)

When enabled, any MCP-compatible IDE can access the knowledge base:

| IDE | MCP Config |
|-----|-----------|
| **Claude Code** | Auto-registered via plugin install |
| **VS Code** (Copilot) | `settings.json` — MCP server entry |
| **Cursor** | `.cursor/mcp.json` |
| **Windsurf** | `~/.windsurf/mcp.json` |
| **Codex CLI** (OpenAI) | `~/.codex/config.toml` |
| **Gemini CLI** (Google) | `~/.gemini/settings.json` |

---

## Install

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
```

Then **open a new Claude Code session** and run `/assist-setup`.

### Install via npm

```bash
npm install -g lm-assist
lm-assist start
```

Then in Claude Code, run `/assist-setup`.

### Install from source

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install && npm run build
./core.sh start
```

Then in Claude Code, run `/plugin install .` and `/assist-setup`.

### What gets installed

| Component | Auto-installed | Purpose |
|-----------|---------------|---------|
| Core API + Web UI | Yes (via npm/source) | 155+ endpoint REST API + Next.js dashboard |
| MCP server | Yes (via plugin) | `search`, `detail`, `feedback` tools |
| Context hook | Yes (via plugin) | Knowledge injection (optional) |
| Slash commands | Yes (via plugin) | 6 `/assist-*` commands |
| Statusline | Optional | Git branch, context %, rate limits, process stats |

## Services

| Service | Port | Description |
|---------|------|-------------|
| Core API | 3100 | REST API — sessions, monitor, agents, tasks, knowledge |
| Web UI | 3848 | Next.js dashboard — 15 insight tabs, terminal, settings |

```bash
lm-assist start       # Start both services
lm-assist stop        # Stop all services
lm-assist status      # Health check + process info
lm-assist upgrade     # Upgrade to latest version
```

## Key API Endpoints

| Category | Endpoints | Highlights |
|----------|-----------|------------|
| **Sessions** | 27 | List, detail, delta fetch, batch-check, conversation, subagents, forks, DAG |
| **Monitor** | 6 | Running executions, summary, abort, SSE stream |
| **Projects** | 12 | List projects, sessions per project, git info, worktree detection |
| **Terminal** | 13 | ttyd start/stop/status, WebSocket proxy, tmux attach |
| **Tasks** | 22 | Task lists, aggregated tasks, ready tasks, dependency tracking |
| **Knowledge** | 21 | List, search, generate, review (optional — can be disabled) |
| **Vectors** | 6 | Semantic search, index, reindex (optional) |

All endpoints support `ifModifiedSince` for efficient polling. Session data supports three indexing dimensions: `lineIndex` (JSONL position), `turnIndex` (conversation turn), and `userPromptIndex` (user message count).

## Slash Commands

| Command | Description |
|---------|-------------|
| `/assist` | Open the web UI in your browser |
| `/assist-status` | Show status of all components |
| `/assist-setup` | Start services and verify integrations |
| `/assist-search <query>` | Search the knowledge base |
| `/assist-logs` | View context-inject hook logs |
| `/assist-mcp-logs` | View MCP tool call logs |

## Configuration

No API key needed — lm-assist works entirely with your local Claude Code session data. Optionally copy `.env.example` to `.env`:

```bash
API_PORT=3100                    # Core API port (default: 3100)
WEB_PORT=3848                    # Web UI port (default: 3848)
```

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | Full | All features including web terminal |
| macOS | Full | All features including web terminal |
| Windows | Partial | Everything except console/terminal access (ttyd not available) |
| Mobile / Tablet | Web UI | Monitor, debug, and control from any device on your network |

## Who It's For

- **Solo developers** using Claude Code — see what's happening across all your sessions
- **Teams building with Agent SDK** — observability for your agent pipelines
- **DevOps managing agent fleets** — multi-machine dashboard, cost tracking, process management
- **AI product builders** — debug agent behavior with 15 insight views

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and release notes.

## Requirements

- Node.js >= 18
- Claude Code (for slash commands and MCP integration)

## License

[AGPL-3.0-or-later](LICENSE)
