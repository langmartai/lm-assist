# lm-assist

Knowledge management, session inspector, and web terminal control for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Auto-build knowledge from your sessions and inject it as context. Inspect agents, tasks, teams, plans, and tool calls. Access and control all Claude Code terminals from any device via browser.

> **Read:** [Your Claude Sessions Are Gold: Stop Paying Twice for the Same Knowledge](https://databunny.medium.com/your-claude-sessions-are-gold-stop-paying-twice-for-the-same-knowledge-7632ac6ddb88) — deep dive into session knowledge reuse, CLAUDE.md vs context injection, and token cost savings.

> **Read:** [Inside Claude Code: The Session File Format and How to Inspect It](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b) — technical breakdown of the JSONL session format, message types, subagent trees, and how lm-assist surfaces it all.

---

## Three Core Features

### 1. Access Your Sessions From Anywhere

lm-assist runs a web server on your local network. Open any browser on any device — laptop, tablet, phone — and browse all your Claude Code sessions in real time.

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-browser.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/session-browser.png" alt="Session Browser" width="700"></a>

> *Session Browser — view all your Claude Code sessions in one place*

Connect a live terminal to any running session directly from the web:

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-terminal.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/session-terminal.png" alt="Web Terminal" width="700"></a>

> *Web Terminal — connect to running Claude Code sessions from your browser*

### 2. Deep Insight Views

Every session gets a full breakdown across **13 specialized tabs** — Chat, Thinking, Agents, Tasks, Plans, Team, Files, Git, Console, Summary, Meta, JSON, and DB.

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-detail-chat.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/session-detail-chat.png" alt="Session Detail — Chat" width="700"></a>

> *Chat tab — full conversation with syntax-highlighted code blocks*

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/agent-tree.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/agent-tree.png" alt="Agent Tree" width="700"></a>

> *Agents tab — subagent tree showing Explore, Plan, Bash, and custom agents*

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/plan-view.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/plan-view.png" alt="Plan View" width="700"></a>

> *Plans tab — plan mode entries with structured implementation steps*

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/team-view.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/team-view.png" alt="Team View" width="700"></a>

> *Team tab — multi-agent coordination timeline (Opus 4.6 swarm)*

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/task-kanban.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/task-kanban.png" alt="Task Kanban" width="700"></a>

> *Task Dashboard — kanban board aggregating tasks across all sessions*

<details>
<summary><strong>All 13 tabs at a glance</strong></summary>

| Tab | What You See |
|-----|-------------|
| **Chat** | Full conversation with syntax-highlighted code blocks |
| **Thinking** | Claude's extended thinking / chain-of-thought |
| **Agents** | Subagent tree — Explore, Plan, Bash, and custom agents |
| **Tasks** | Todo lists created during the session |
| **Plans** | Plan mode entries with approval status |
| **Team** | Team/swarm coordination (Opus 4.6 multi-agent) |
| **Files** | All files read, written, or edited during the session |
| **Git** | Commits, pushes, and diffs from the session |
| **Console** | Terminal output and process management |
| **Summary** | AI-generated session summary |
| **Meta** | Session metadata — timing, model, token usage |
| **JSON** | Raw session JSONL data |
| **DB** | Internal cache and index data |

</details>

### 3. Auto-Built Knowledge Base

lm-assist automatically generates knowledge from your Claude Code sessions, then injects it back into future prompts — giving Claude Code memory of what you've worked on before.

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/knowledge-base.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/knowledge-base.png" alt="Knowledge Base" width="700"></a>

> *Knowledge Base — auto-generated entries from your sessions, searchable and editable*

**How it works:**
1. **Generate** — Analyzes your sessions and extracts reusable knowledge (patterns, decisions, debugging insights)
2. **Search** — Indexed with BM25 + vector similarity for fast retrieval
3. **Inject** — On every prompt, the context-injection hook finds relevant knowledge and injects it as context
4. **MCP tools** — Claude Code can also actively search and retrieve knowledge using `search`, `detail`, and `feedback` tools

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/context-hook-logs.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/context-hook-logs.png" alt="Context Hook Logs" width="700"></a>

> *Context Injection — hook logs showing knowledge injected into each prompt*

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/mcp-tool-logs.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/mcp-tool-logs.png" alt="MCP Tool Logs" width="700"></a>

> *MCP Monitor — Claude Code actively searching the knowledge base*

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/context-injection-cli.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/context-injection-cli.png" alt="Context Injection in Claude Code CLI" width="700"></a>

> *Claude Code CLI — MCP tools search and inject knowledge before Claude responds*

### Settings

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/settings.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/settings.png" alt="Settings" width="700"></a>

> *Settings — cloud sign-in, LAN access, connection status, and more*

---

## Install

### Plugin marketplace install

Start a new Claude Code session in the terminal and enter the following commands:

```
/plugin marketplace add langmartai/lm-assist

/plugin install lm-assist

/assist-setup
```

This automatically registers:
- **MCP server** — `search`, `detail`, `feedback` tools available in Claude Code
- **Context hook** — injects relevant knowledge into each prompt
- **Slash commands** — 6 commands for managing lm-assist


### Optional use One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
```

This clones the repo, builds, adds the marketplace, and installs the plugin. Then in Claude Code:

```
/assist-setup
```

Then clone, build, and start the services:

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install && npm run build
./core.sh start
```

### Install from source

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install && npm run build

# Install as Claude Code plugin (registers MCP, hooks, commands)
# In a Claude Code session, run:
# /plugin install .

# Start services
./core.sh start
```

### Install via npm

```bash
npm install -g lm-assist
lm-assist start

# Then in Claude Code:
/assist-setup
```

### What gets installed

| Component | Auto-installed by plugin | Purpose |
|-----------|-------------------------|---------|
| MCP server | Yes | `search`, `detail`, `feedback` tools in Claude Code |
| Context hook (Node.js) | Yes | Injects relevant knowledge into each prompt |
| Slash commands | Yes | 6 `/assist-*` commands |
| Statusline | No (optional) | Git branch, context %, process stats in status bar |

The context hook uses Node.js for cross-platform support (Windows, macOS, Linux). The statusline is optional — install via `/assist-setup --statusline` or the web UI settings page.

## Slash Commands

Use these from within any Claude Code session:

| Command | Description |
|---------|-------------|
| `/assist` | Open the web UI in your browser |
| `/assist-status` | Show status of all components |
| `/assist-setup` | Start services and verify integrations |
| `/assist-search <query>` | Search the knowledge base |
| `/assist-logs` | View context-inject hook logs |
| `/assist-mcp-logs` | View MCP tool call logs |

## MCP Server

The MCP server (`lm-assist`) provides 3 tools that Claude Code can use directly:

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge and file history |
| `detail` | Progressive disclosure — expand any item by ID (e.g., `K001`, `arch:component`) |
| `feedback` | Flag context as outdated, wrong, irrelevant, or useful |

When installed as a plugin, the MCP server is registered automatically. For non-plugin installs:

```bash
curl -X POST http://localhost:3100/claude-code/mcp/install
```

## Services

lm-assist runs two services:

| Service | Port | Description |
|---------|------|-------------|
| Core API | 3100 | REST API — sessions, knowledge, tasks |
| Web UI | 3848 | Next.js dashboard — accessible from any device on your network |

```bash
./core.sh start        # Start both services
./core.sh stop         # Stop all services
./core.sh restart      # Restart (auto-rebuilds if TypeScript changed)
./core.sh status       # Health check
./core.sh logs core    # View API logs
./core.sh logs web     # View web logs
```

## Configuration

No API key is needed — lm-assist works entirely with your local Claude Code session data. Optionally copy `.env.example` to `.env` to customize ports:

```bash
API_PORT=3100                    # Core API port (default: 3100)
WEB_PORT=3848                    # Web UI port (default: 3848)
```

## Project Structure

```
lm-assist/
├── core/                    ← Backend API (TypeScript)
│   ├── src/
│   │   ├── mcp-server/      ← MCP server (search, detail, feedback tools)
│   │   ├── routes/core/     ← REST API routes (155 endpoints)
│   │   ├── knowledge/       ← Knowledge generation pipeline
│   │   └── vector/          ← Embeddings + vector store
│   └── hooks/               ← Claude Code hook scripts (Node.js, cross-platform)
├── web/                     ← Web UI (Next.js, React 19)
├── commands/                ← Slash command definitions
├── hooks/                   ← Plugin hook registration
├── docs/screenshots/        ← Product screenshots
├── .claude-plugin/          ← Claude Code plugin metadata
├── .mcp.json                ← MCP server auto-registration
├── core.sh                  ← Service manager
└── bin/lm-assist.js         ← CLI entry point
```

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | Full | All features including web terminal |
| macOS | Full | All features including web terminal |
| Windows | Partial | Everything except console/terminal access (ttyd not available) |
| Mobile / Tablet | Web UI | Browse sessions, tasks, knowledge from any device on your network |

The web UI is fully responsive — optimized for phone, tablet, and desktop viewports.

## Requirements

- Node.js >= 18
- Claude Code (for slash commands and MCP integration)

## License

[AGPL-3.0-or-later](LICENSE)
