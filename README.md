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

- Session list with human-readable slug names, live status, and running process detection
- Per-session and per-project cost tracking — total cost in gold at a glance
- Per-model token breakdown (input, output, cache read, cache creation) in Meta tab
- SSE event stream for real-time updates
- Multi-machine fleet dashboard via LangMart Hub

**Statusline** — optional status bar showing context %, rate limits (5h/7d usage with time remaining), session cost, RAM, PID, and uptime. Color-coded: green < 50%, yellow 50-80%, red > 80%.

```
wt: no worktrees  ctx:42%  $12.34  5h:23% 2h14m left  7d:41%  ram:565M  free:6.1G  pid:12345  up:3h22m
```

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

## Knowledge (Off by Default)

lm-assist includes an optional knowledge subsystem that auto-extracts reusable knowledge from your sessions and injects it into future prompts via MCP tools and a context hook. **Disabled by default** to save ~100MB of memory. Enable it in Settings > Data Loading, then run `/assist-setup` to register the MCP server and context hook.

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

### Install

```bash
npm install -g lm-assist
```

That's it. The postinstall script automatically:
- Starts API (:3100) and Web UI (:3848)
- Installs the statusline
- Installs the [Claude One](https://github.com/langmartai/claude-one) plugin (skills + commands)

**Open a new Claude Code session** and type `/sessions` to verify.

### Alternative: plugin-only install

If you already have lm-assist running and just want the skills:

```
/plugin marketplace add langmartai/lm-assist
/plugin install claude-one@langmartai
```

### Install from source

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install && npm run build
./core.sh start
```

Then in Claude Code: `/plugin install .`

### What gets installed

| Component | Auto-installed | Source | Purpose |
|-----------|---------------|--------|---------|
| Skills (observe, route) | Yes | [Claude One](https://github.com/langmartai/claude-one) plugin | Session intelligence + cross-project routing |
| Commands (/sessions, /summary, /run) | Yes | Claude One plugin | Quick session list, summarize, execute |
| Commands (/assist-*) | Yes | lm-assist plugin | Setup, status, search, logs |
| Core API + Web UI | Yes | npm package | 155+ endpoint REST API + Next.js dashboard |
| Statusline | Yes | `/assist-setup` | Context %, rate limits, cost, process stats |
| MCP server | Optional | `/assist-setup --mcp` | Knowledge tools (search, detail, feedback) |
| Context hook | Optional | `/assist-setup --mcp` | Knowledge injection into prompts |
| Knowledge system | Off by default | Settings > Data Loading | Saves ~100MB when disabled |

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

## Skills & Commands

Skills and commands are provided by the [Claude One](https://github.com/langmartai/claude-one) plugin — installed automatically via `/assist-setup`.

### Skills (auto-triggered via Claude One)

Skills activate automatically when Claude detects relevant intent — no slash command needed.

| Skill | Triggers on | What it does |
|-------|------------|--------------|
| **observe** | "what's running?", "session costs", "show subagents", "run this on project X" | Full observability — monitor sessions, debug agents, control executions, manage summaries |
| **route** | Prompt mentions another project's features or codebase | Cross-project routing — evaluates whether to stay, resume, fork, queue, or start new |

### Commands

| Command | Description |
|---------|-------------|
| `/sessions` | Session list with costs, turns, running status |
| `/summary` | Summarize current session, generate display name, record learning |
| `/run <prompt>` | Execute an agent with pre-flight checks |
| `/assist` | Open the web UI in your browser |
| `/assist-status` | Show status of all components |
| `/assist-setup` | Start services and verify integrations |
| `/assist-search` | Search the knowledge base |
| `/assist-logs` | View context-inject hook logs |
| `/assist-mcp-logs` | View MCP tool call logs |

### Use Cases with Examples

**"What sessions are running and how much have they cost?"**
```
> /sessions
Sessions (3 running, 415 total)
───────────────────────────────────────────────────────────────────────
Status  Name                         Project            Model      Cost  Turns
───────────────────────────────────────────────────────────────────────
[RUN]   observability-platform-build  lm-assist          opus    $307.66  1462
[RUN]   trade-delta-analysis          my-trading-app   opus    $153.20   822
[RUN]   anti-kelly-system             my-trading-app   opus     $35.49   433
        two-track-dashboard           my-trading-app   opus    $107.43   516
        skill-validation-test         lm-assist          opus      $0.63    11
───────────────────────────────────────────────────────────────────────
Total cost: $604.41
```

**"Summarize what this session has been doing"**
```
> /summary
Session Summary
═══════════════
Name:    observability-platform-build
Project: lm-assist
Turns:   1462 | Cost: $307.66
Status:  in progress

What this session is about:
  Building the lm-assist observability platform — session summaries,
  cross-project routing, prompt queue, auto-learning.

What was accomplished:
  • Session slug/customTitle parsing from Claude Code JSONL
  • Knowledge system kill switch (saves ~100MB)
  • Observability skill + routing skill + 3 new commands
  • Persistent session summaries with delta tracking
  • Universal prompt queue with source/target context
  • Auto-learning signals that evolve routing over time
```

**"Fix the delta analysis bug in the trading pipeline"**

The route skill auto-detects this belongs to another project:
```
This task appears to belong to my-trading-app, not the current project.

Relevant session found: trade-delta-analysis
Summary: Implemented delta analysis mode for /analyze command...
Status: idle (not running)

Recommendation: RESUME
Reason: This session built all existing delta modes and knows the spec,
flag table, and pre-launch copy patterns.

To resume:  claude --resume def67890-session-id
```

**"Run a security review on this project"**
```
> /run review all API endpoints for security vulnerabilities
Checking running executions... OK: none running.

Execution started: agent-1774468578687-1p2cnh
  Session: nifty-wishing-boole
  Status: running
  Monitor with: /sessions
  Web UI: http://localhost:3848
```

**"What's the cost breakdown by project?"**

The observe skill activates:
```
Project costs:
  lm-assist              $308.29  (80 sessions)
  my-trading-app       $892.15  (440 sessions)
  my-web-platform          $45.20  (12 sessions)
  my-agent-framework              $23.50  (15 sessions)
```

### Session Intelligence

lm-assist learns from every interaction to route prompts smarter over time:

- **Session summaries** — LLM-generated descriptions stored with delta tracking. Updated incrementally as sessions grow.
- **Project summaries** — Comprehensive reference generated by agents that explore each project's CLAUDE.md, scripts, configs, and codebase.
- **Prompt queue** — When a session is busy, new work is queued with full context (original intent, formatted prompt, routing reason, context hint).
- **Auto-learning** — Keywords, commands, and routing patterns accumulate with frequency counts. After a few interactions, routing skips deep scans entirely.

```
Learning context for my-trading-app:
  Frequently mentioned: delta analysis(3x), anti-kelly(2x), regime analysis(1x)
  Areas worked in: analysis pipeline(1x)
  Routing patterns: delta analysis → trade-delta-analysis session
```

### Multi-Project Concurrent Development

lm-assist shines when you're working across multiple projects simultaneously. The routing skill, session summaries, and prompt queue work together to keep context organized.

**Scenario: You're building lm-assist while also maintaining a trading platform and a web gateway.**

**1. Start your day — see everything at a glance:**
```
> /sessions
Sessions (5 running, 547 total)
───────────────────────────────────────────────────────────────────
Status  Name                         Project            Model      Cost  Turns
───────────────────────────────────────────────────────────────────
[RUN]   observability-platform-build  lm-assist          opus    $355.84  1573
[RUN]   trade-delta-analysis          my-trading-app   opus    $153.20   843
[RUN]   anti-kelly-system             my-trading-app   opus     $35.49   433
        two-track-dashboard           my-trading-app   opus    $107.43   516
        gateway-ssl-upgrade           my-web-platform     opus     $12.30    85
───────────────────────────────────────────────────────────────────
Total cost: $664.26
```

**2. You're in lm-assist and say "fix the regime analysis stale data bug"**

The route skill detects this belongs to another project:
```
This task belongs to my-trading-app (regime analysis is part of the trading pipeline).

Relevant session: trade-delta-analysis
Summary: Implemented delta analysis mode for /analyze. Knows all delta
patterns, flag tables, and pre-launch copy rules.
Status: running (T:843, $153.20)

Recommendation: QUEUE (session is running)
Queued as high priority. Will process when current work completes.

Queue for trade-delta-analysis (2 pending):
  [high]   fix the regime analysis stale data bug
  [normal] add S/R interaction delta mode
```

**3. Back in lm-assist, you say "add error handling to the learning store"**

The route skill checks the current session summary:
```
STAY — "learning store" matches current session work (observability-platform-build).
The session summary mentions auto-learning, learning signals, and learning store.
```
No routing. Work continues in the current session.

**4. You say "the gateway SSL cert is expiring, renew it on SG"**

The route skill identifies this as a simple remote operation:
```
This involves my-web-platform (gateway) on the SG server.
But it's a simple operations task — can handle from here via SSH.

Running: ssh user@prod-server 'sudo certbot renew'
```
No project switch needed.

**5. You say "deploy the trading dashboard changes to production"**

Route skill identifies the target:
```
This belongs to my-trading-app (trading dashboard).

Relevant session: two-track-dashboard (completed, 516 turns)
Summary: Built two-track cross-product trading dashboard with spread
and cross-product opportunity tables.

Recommendation: RESUME
Reason: This session built the dashboard and knows the deployment process.

To resume: claude --resume abc12345-session-id
```

**6. End of day — summarize what happened:**
```
> /summary
Session Summary: observability-platform-build
  Today: added error handling to learning store, fixed 3 bugs,
  queued 2 tasks for trade-delta-analysis, deployed gateway cert.

> /sessions my-trading-app
  trade-delta-analysis: processed 2 queued prompts (regime fix, S/R delta)
  two-track-dashboard: deployed to production
  anti-kelly-system: idle since yesterday
```

**Key patterns for multi-project work:**

| Situation | What happens |
|-----------|-------------|
| Task for current project | Route skill says STAY — no context switch |
| Task for another project, relevant session running | QUEUE — prompt waits, processes when session is free |
| Task for another project, session idle | RESUME — switch to that session with full context |
| Simple cross-project operation (ssh, curl, read) | Handle locally — no project switch |
| Task for unknown project | Route skill asks for clarification |
| Same task mentioned again | Learning signals shortcut the routing — instant match |

**How learning makes it faster over time:**

First time: "fix delta analysis" → scan all project summaries → find my-trading-app → 4 API calls

After learning: "fix delta analysis" → signal says `delta analysis(5x) → my-trading-app` → 1 API call

The more you work across projects, the smarter routing gets. Keywords, commands, and routing patterns accumulate automatically.

---

## Key API Endpoints

| Category | Endpoints | Highlights |
|----------|-----------|------------|
| **Sessions** | 27 | List, detail, delta fetch, batch-check, conversation, subagents, forks, DAG |
| **Monitor** | 6 | Running executions, summary, abort, SSE stream |
| **Projects** | 12 | List projects, sessions per project, git info, worktree detection, costs |
| **Terminal** | 13 | ttyd start/stop/status, WebSocket proxy, tmux attach |
| **Tasks** | 22 | Task lists, aggregated tasks, ready tasks, dependency tracking |
| **Summaries** | 10 | Session summaries, project summaries, needs-update check |
| **Queue** | 10 | Prompt queue with source/target, priority, dispatch/complete lifecycle |
| **Learning** | 4 | Record signals, query by project, learning context generation |
| **Search** | 4 | Session content search, recent sessions, vector search |
| **Skills** | 9 | Skills analytics, chains, traces, per-session breakdown |
| **Knowledge** | 21 | List, search, generate, review (optional — can be disabled) |

All endpoints support `ifModifiedSince` for efficient polling. Session data supports three indexing dimensions: `lineIndex` (JSONL position), `turnIndex` (conversation turn), and `userPromptIndex` (user message count).

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
