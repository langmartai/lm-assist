# lm-assist

Session knowledge, milestones, and architecture context for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

lm-assist runs alongside Claude Code to build a searchable knowledge base from your coding sessions. It extracts milestones, generates architecture models, and injects relevant context back into new sessions — so Claude Code remembers what you've worked on before.

## Features

- **Knowledge Base** — Automatically generated knowledge entries from your Claude Code sessions, searchable via BM25 + vector similarity
- **Milestones** — Key achievements extracted from sessions with LLM-powered summaries
- **Architecture Models** — Auto-generated project architecture documentation from your codebase and session history
- **MCP Server** — 3 tools (`search`, `detail`, `feedback`) available directly inside Claude Code
- **Context Injection** — Hook that injects relevant knowledge/milestones into each Claude Code prompt
- **Web UI** — Dashboard for browsing sessions, knowledge, tasks, architecture, and terminal access
- **Slash Commands** — 6 commands for managing lm-assist from within Claude Code

## Install

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
```

This clones the repo, builds, adds the marketplace, and installs the plugin. Then in Claude Code:

```
/assist-setup
```

### Plugin marketplace install

```bash
# Add the marketplace
claude plugin marketplace add github:langmartai/lm-assist

# Install the plugin
claude plugin install lm-assist@langmartai
```

This automatically registers:
- **MCP server** — `search`, `detail`, `feedback` tools available in Claude Code
- **Hooks** — context injection (injects relevant knowledge into each prompt) and event logger
- **Slash commands** — 6 commands for managing lm-assist (see below)

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
claude plugin install .

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
| Context hook | Yes | Injects relevant knowledge into each prompt |
| Event logger | Yes | Logs hook events to `~/.claude/hook-events.jsonl` |
| Slash commands | Yes | 6 `/assist-*` commands |
| Statusline | No (optional) | Git branch, context %, process stats in status bar |

The statusline is optional — install via `/assist-setup --statusline` or the web UI settings page.

## Slash Commands

Use these from within any Claude Code session:

| Command | Description |
|---------|-------------|
| `/assist` | Open the web UI in your browser |
| `/assist-status` | Show status of all components (API, web, MCP, hooks, hub, knowledge) |
| `/assist-setup` | Start services and verify integrations (statusline optional via `--statusline`) |
| `/assist-search <query>` | Search the knowledge base |
| `/assist-logs` | View context-inject hook logs |
| `/assist-mcp-logs` | View MCP tool call logs |

## MCP Server

The MCP server (`lm-assist-context`) provides 3 tools that Claude Code can use directly:

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge, milestones, architecture, and file history |
| `detail` | Progressive disclosure — expand any item by ID (e.g., `K001`, `sessionId:index`, `arch:component`) |
| `feedback` | Flag context as outdated, wrong, irrelevant, or useful |

When installed as a plugin, the MCP server is registered automatically. For non-plugin installs:

```bash
# Via the API (requires services running)
curl -X POST http://localhost:3100/claude-code/mcp/install

# Or via Claude CLI directly
claude mcp add -s user lm-assist-context -- node /path/to/lm-assist/core/dist/mcp-server/index.js
```

## Services

lm-assist runs two services:

| Service | Port | Description |
|---------|------|-------------|
| Core API | 3100 | REST API — sessions, knowledge, milestones, architecture, tasks |
| Web UI | 3848 | Next.js dashboard |

Manage with `./core.sh` (or `lm-assist` CLI if installed via npm):

```bash
./core.sh start        # Start both services
./core.sh stop         # Stop all services
./core.sh restart      # Restart (auto-rebuilds if TypeScript changed)
./core.sh status       # Health check
./core.sh logs core    # View API logs
./core.sh logs web     # View web logs
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
ANTHROPIC_API_KEY=your-key       # Required for knowledge generation and architecture
API_PORT=3100                    # Core API port (default: 3100)
WEB_PORT=3848                    # Web UI port (default: 3848)
```

## Claude Code Integrations

When installed as a plugin, the MCP server and hooks are auto-registered. The statusline is optional.

| Integration | Auto-installed | What It Does |
|-------------|----------------|--------------|
| **MCP Server** | Yes (plugin) | Gives Claude Code the `search`, `detail`, and `feedback` tools |
| **Context Hook** | Yes (plugin) | Injects relevant knowledge/milestones on each prompt via `UserPromptSubmit` hook |
| **Event Logger** | Yes (plugin) | Logs all Claude Code hook events to `~/.claude/hook-events.jsonl` |
| **Statusline** | No (optional) | Shows git branch, session info, context %, and process stats in the status bar |

Install the statusline via `/assist-setup --statusline` or the web UI settings page.

## Web UI Pages

| Page | Description |
|------|-------------|
| Sessions | Browse and search Claude Code sessions with conversation view |
| Knowledge | View, search, and generate knowledge entries |
| Architecture | Auto-generated project architecture models |
| Tasks | Task lists from Claude Code sessions |
| Terminal | Web-based terminal access for session processes |
| Settings | Manage Claude Code integrations (MCP, hooks, statusline) |

## Project Structure

```
lm-assist/
├── core/                    ← Backend API (TypeScript)
│   ├── src/
│   │   ├── mcp-server/      ← MCP server (search, detail, feedback tools)
│   │   ├── routes/core/     ← REST API routes
│   │   ├── knowledge/       ← Knowledge generation pipeline
│   │   ├── milestone/       ← Milestone extraction pipeline
│   │   └── vector/          ← Embeddings + vector store
│   └── hooks/               ← Claude Code hook scripts
├── web/                     ← Web UI (Next.js)
├── commands/                ← Slash command definitions
├── hooks/                   ← Plugin hook registration (hooks.json)
├── .claude-plugin/          ← Claude Code plugin metadata
├── .mcp.json                ← MCP server auto-registration
├── core.sh                  ← Service manager
└── bin/lm-assist.js         ← CLI entry point
```

## Requirements

- Node.js >= 18
- Claude Code (for slash commands and MCP integration)
- Anthropic API key (for knowledge generation and architecture)

## License

[AGPL-3.0-or-later](LICENSE)
