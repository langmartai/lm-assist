# lm-assist

Knowledge management, session inspector, and web terminal control for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Auto-build knowledge from your sessions and inject it as context. Inspect agents, tasks, teams, plans, and tool calls. Access and control all Claude Code terminals from any device via browser.

[![Discord](https://img.shields.io/discord/1475647234669543558?logo=discord&label=Discord&color=5865F2)](https://discord.gg/xb2BNnk4)

### Install

In Claude Code, run:

```
/plugin marketplace add langmartai/lm-assist

/plugin install lm-assist@langmartai
```

Then **open a new Claude Code session** and run:

```
/assist-setup
```

This automatically registers:
- **MCP server** — `search`, `detail`, `feedback` tools available in Claude Code
- **Context hook** — injects relevant knowledge into each prompt
- **Slash commands** — 6 commands for managing lm-assist

### How It Works

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-diagram.svg"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-diagram.svg" alt="How lm-assist Works — architecture diagram" width="700"></a>

> *Left: Any MCP-compatible IDE (Claude Code, VS Code, Cursor, Codex CLI, Gemini CLI, Antigravity) accesses the knowledge base via MCP. Right: You access the Web UI from localhost, LAN, or langmart.ai for terminal management, session inspection, and more. [Full details →](docs/how-it-works.md)*

> **Read:** [Your Claude Sessions Are Gold: Stop Paying Twice for the Same Knowledge](https://databunny.medium.com/your-claude-sessions-are-gold-stop-paying-twice-for-the-same-knowledge-7632ac6ddb88) — deep dive into session knowledge reuse, CLAUDE.md vs context injection, and token cost savings.

> **Read:** [Inside Claude Code: The Session File Format and How to Inspect It](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b) — technical breakdown of the JSONL session format, message types, subagent trees, and how lm-assist surfaces it all.

---

## Three Core Features

### 1. Access Your Sessions From Anywhere

lm-assist runs a web server on your local network. Open any browser on any device — laptop, tablet, phone — and browse all your Claude Code sessions in real time.

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-browsing.gif"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-browsing.gif" alt="Session Browsing" width="700"></a>

> *Terminal dashboard with 4 live sessions via langmart.ai, then browse into session detail with rich chat history — accessible from any browser, anywhere*

### 2. Deep Insight Views

Every session gets a full breakdown across **13 specialized tabs** — Chat, Thinking, Agents, Tasks, Plans, Team, Files, Git, Console, Summary, Meta, JSON, and DB.

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/deep-insight-views.gif"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/deep-insight-views.gif" alt="Deep Insight Views" width="700"></a>

> *Click through Chat, Agents, Plans, Files, Thinking, and Git tabs — each surfaces a different dimension of the session*

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

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/knowledge-base.gif"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/knowledge-base.gif" alt="Knowledge Base" width="700"></a>

> *Browse 667 knowledge entries, expand details with code snippets and file references, inspect context injection logs showing exactly what knowledge gets injected into each prompt*

**How it works:**
1. **Generate** — Analyzes your sessions and extracts reusable knowledge (patterns, decisions, debugging insights)
2. **Search** — Indexed with BM25 + vector similarity for fast retrieval
3. **Inject** — On every prompt, the context-injection hook finds relevant knowledge and injects it as context
4. **MCP tools** — Claude Code can also actively search and retrieve knowledge using `search`, `detail`, and `feedback` tools

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/context-injection-cli.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/context-injection-cli.png" alt="Context Injection in Claude Code CLI" width="700"></a>

> *Claude Code CLI — MCP tools search and inject knowledge before Claude responds*

### Settings

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/settings.png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/settings.png" alt="Settings" width="700"></a>

> *Settings — cloud sign-in, LAN access, connection status, and more*

### Mobile & Tablet Support

The web UI is fully responsive. Access everything from your phone or tablet — control terminals, browse sessions, review knowledge, and manage tasks on the go.

<table>
  <tr>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-terminal%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-terminal%20(mobile).png" alt="Terminal on mobile" width="180"></a><br><sub>Live Terminal</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-detail-chat%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/session-detail-chat%20(mobile).png" alt="Session detail on mobile" width="180"></a><br><sub>Session Detail</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/task-kanban%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/task-kanban%20(mobile).png" alt="Task kanban on mobile" width="180"></a><br><sub>Task Kanban</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/knowledge-list%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/knowledge-list%20(mobile).png" alt="Knowledge list on mobile" width="180"></a><br><sub>Knowledge Base</sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/knowledge-detail-full%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/knowledge-detail-full%20(mobile).png" alt="Knowledge detail on mobile" width="180"></a><br><sub>Knowledge Detail</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/context-hook-logs%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/context-hook-logs%20(mobile).png" alt="Context hook logs on mobile" width="180"></a><br><sub>Context Injection Logs</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-connection%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-connection%20(mobile).png" alt="Settings on mobile" width="180"></a><br><sub>Settings</sub></td>
    <td align="center"><a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-claude-code%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-claude-code%20(mobile).png" alt="Claude Code settings on mobile" width="180"></a><br><sub>Claude Code Config</sub></td>
  </tr>
</table>

### Bring Your Knowledge to Every IDE

lm-assist builds knowledge from your Claude Code sessions — but that knowledge isn't locked to Claude Code. Any MCP-compatible IDE can connect to the lm-assist MCP server and access the same knowledge base: search entries, view details, and provide feedback.

One-click activation from the Settings page:

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-ide-mcp%20(mobile).png"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshot/settings-ide-mcp%20(mobile).png" alt="IDE MCP Integration" width="280"></a>

**Supported IDEs:**

| IDE | MCP Config |
|-----|-----------|
| **Claude Code** | Auto-registered via plugin install |
| **VS Code** (Copilot) | `settings.json` — MCP server entry |
| **Cursor** | `.cursor/mcp.json` |
| **Windsurf** | `~/.windsurf/mcp.json` |
| **Codex CLI** (OpenAI) | `~/.codex/config.toml` |
| **Gemini CLI** (Google) | `~/.gemini/settings.json` |
| **Google Antigravity** | `~/.gemini/antigravity/settings.json` |

All IDEs get access to the same 3 MCP tools (`search`, `detail`, `feedback`) and the same knowledge base. Generate knowledge once in Claude Code, use it everywhere.

---

## Install

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
```

This clones the repo, builds, adds the marketplace, and installs the plugin. Then **open a new Claude Code session** and run:

```
/assist-setup
```

### Install from source

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install && npm run build
./core.sh start
```

Then in Claude Code, run `/plugin install .` to register the plugin. **Open a new Claude Code session** and run `/assist-setup`.

### Install via npm

```bash
npm install -g lm-assist
lm-assist start
```

Then in Claude Code, run `/assist-setup`.

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

The MCP server (`lm-assist`) provides 3 tools that any MCP-compatible IDE can use directly (Claude Code, VS Code, Cursor, Codex CLI, Gemini CLI, Antigravity):

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

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and release notes.

## Requirements

- Node.js >= 18
- Claude Code (for slash commands and MCP integration)

## License

[AGPL-3.0-or-later](LICENSE)
