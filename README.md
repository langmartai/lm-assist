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

Real-time execution tracking via REST API.

- Session list with slug names, live status, running process detection
- Per-session and per-project cost tracking with per-model token breakdown
- SSE event stream for real-time updates (`GET /stream`)
- Multi-machine fleet dashboard via LangMart Hub
- Statusline: context %, rate limits (5h/7d), cost, RAM, PID

**Key endpoints:** `GET /monitor/executions` · `GET /stream` · `GET /sessions` · `GET /projects/sessions`

### 2. Debug

15 data dimensions per session, all accessible via API.

- Conversation, thinking blocks, tool calls, subagent hierarchy, DAG
- File changes, git operations, plans, tasks, team coordination
- Fork tracking, session summaries, skill traces

**Key endpoints:** `GET /sessions/:id` · `GET /sessions/:id/dag` · `GET /sessions/:id/subagents` · `GET /sessions/:id/conversation`

### 3. Control

Full runtime management API.

- Start and abort agent executions
- SDK runner for programmatic headless execution
- Session cache warm/clear
- Web terminal (ttyd) from any browser
- Remote access via LangMart Hub

**Key endpoints:** `POST /monitor/abort/:executionId` · `POST /ttyd/start` · `POST /agent/execute` · `POST /hub/connect`

### Web Dashboard

See [claude-code-webui](https://github.com/langmartai/claude-code-webui) for the full web dashboard with 15 insight tabs, web terminal, task kanban, and mobile support.

<a href="https://langmart.ai/images/assist/session-browser.png"><img src="https://langmart.ai/images/assist/session-browser.png" alt="Session Browser" width="700"></a>

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

---

## Install

### Quick start

```bash
npm install -g lm-assist
```

The postinstall script automatically starts services, installs the statusline, and installs the [Claude Code Multisession](https://github.com/langmartai/claude-code-multisession) plugin.

**Open a new Claude Code session** and type `/sessions` to verify.

### Plugin marketplace

Add the marketplace once — then install any combination of plugins:

```
/plugin marketplace add langmartai/lm-assist
```

Three packages work together:

```
┌─────────────────────────────────────────────────────────┐
│  claude-code-multisession          (Claude Code plugin) │
│  Skills: observe, route                                 │
│  Commands: /projects /sessions /summary /run            │
├─────────────────────────────────────────────────────────┤
│  claude-code-webui                 (Claude Code plugin) │
│  Skill: dashboard                                       │
│  Commands: /web /web-sessions /web-tasks                │
├─────────────────────────────────────────────────────────┤
│  lm-assist                              (npm package)   │
│  Foundation: 155+ API endpoints, Next.js web dashboard, │
│  session engine, cost tracking, statusline              │
│  Commands: /assist /assist-setup /assist-status ...     │
└─────────────────────────────────────────────────────────┘
```

**lm-assist** is the foundation — the API server and web dashboard that powers everything. The plugins add skills and commands on top.

| Install command | Layer | What you get |
|----------------|-------|-------------|
| `npm install -g lm-assist` | Foundation | API server (:3100), web dashboard (:3848), statusline, 155+ endpoints |
| `/plugin install claude-code-multisession@langmartai` | Skills | observe + route skills, `/projects` `/sessions` `/summary` `/run` |
| `/plugin install claude-code-webui@langmartai` | Web access | dashboard skill, `/web` `/web-sessions` `/web-tasks` |
| `/plugin install lm-assist@langmartai` | Setup & diagnostics | `/assist-setup` `/assist-status` `/assist-search` `/assist-logs` |

Install all three for the full experience, or pick what you need.

### Install from source

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install && npm run build
./core.sh start
```

Then in Claude Code: `/plugin install .`

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

Skills and commands are provided by the [Claude Code Multisession](https://github.com/langmartai/claude-code-multisession) plugin — installed automatically via `/assist-setup`.

### Skills (auto-triggered via Claude Code Multisession)

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

## Related

- [claude-code-multisession](https://github.com/langmartai/claude-code-multisession) — Skills plugin: cross-project session routing, `/projects`, `/sessions`, `/summary`, `/run`
- [claude-code-webui](https://github.com/langmartai/claude-code-webui) — Web dashboard plugin: 15 insight tabs, web terminal, `/web`, `/web-sessions`, `/web-tasks`
- [Knowledge system](https://databunny.medium.com/your-claude-sessions-are-gold-stop-paying-twice-for-the-same-knowledge-7632ac6ddb88) — Optional: auto-extract knowledge from sessions, MCP tools, context injection. Off by default, enable in Settings > Data Loading

## License

[AGPL-3.0-or-later](LICENSE)
