# lm-assist

A web UI and knowledge engine for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Browse your sessions from any device on your network, get deep insights into every conversation, and auto-build a knowledge base that makes Claude Code smarter over time.

## Three Core Features

### 1. Access Your Sessions From Anywhere

lm-assist runs a web server on your local network. Open any browser on any device — laptop, tablet, phone — and browse all your Claude Code sessions in real time. No more being locked to the terminal where the session started.

<!-- Screenshot: Session browser showing list of sessions -->
> *Screenshot: Session Browser — coming soon*

### 2. Deep Insight Views

Every Claude Code session gets a full breakdown across **15 specialized tabs**:

| Tab | What You See |
|-----|-------------|
| **Chat** | Full conversation with syntax-highlighted code blocks |
| **Thinking** | Claude's extended thinking / chain-of-thought |
| **Agents** | Subagent tree — Explore, Plan, Bash, and custom agents |
| **Tasks** | Todo lists created during the session |
| **Plans** | Plan mode entries with approval status |
| **Team** | Team/swarm coordination (Opus 4.6 multi-agent) |
| **DAG** | Message dependency graph with branch visualization |
| **Files** | All files read, written, or edited during the session |
| **Git** | Commits, pushes, and diffs from the session |
| **Console** | Terminal output and process management |
| **Milestones** | Key achievements extracted from the session |
| **Summary** | AI-generated session summary |
| **Meta** | Session metadata — timing, model, token usage |
| **JSON** | Raw session JSONL data |
| **DB** | Internal cache and index data |

Plus dedicated dashboards for:
- **Session Dashboard** — real-time session monitoring with terminal access
- **Process Dashboard** — all running Claude Code processes
- **Task Dashboard** — aggregated tasks across all sessions
- **Search** — full-text search across all sessions and knowledge

<!-- Screenshot: Session detail view showing Chat tab -->
> *Screenshot: Session Detail — Chat tab — coming soon*

<!-- Screenshot: Session detail view showing Thinking tab -->
> *Screenshot: Session Detail — Thinking tab — coming soon*

<!-- Screenshot: Session detail view showing Agents tab -->
> *Screenshot: Session Detail — Agents tab — coming soon*

<!-- Screenshot: Session detail view showing DAG tab -->
> *Screenshot: Session Detail — DAG tab — coming soon*

<!-- Screenshot: Session detail view showing Team tab -->
> *Screenshot: Session Detail — Team tab — coming soon*

<!-- Screenshot: Task dashboard -->
> *Screenshot: Task Dashboard — coming soon*

### 3. Auto-Built Knowledge Base

lm-assist automatically generates knowledge entries from your Claude Code sessions. This knowledge is then injected back into future prompts — giving Claude Code memory of what you've worked on before.

**How it works:**
1. **Generate** — lm-assist analyzes your sessions and extracts reusable knowledge (patterns, decisions, architecture, debugging insights)
2. **Search** — Knowledge is indexed with BM25 + vector similarity for fast, relevant retrieval
3. **Inject** — On every prompt, the context-injection hook finds the most relevant knowledge entries and injects them as context — Claude Code sees them before processing your prompt
4. **MCP tools** — Claude Code can also actively search and retrieve knowledge using the `search`, `detail`, and `feedback` MCP tools

<!-- Screenshot: Knowledge page -->
> *Screenshot: Knowledge Base — coming soon*

<!-- Screenshot: Architecture page -->
> *Screenshot: Architecture Model — coming soon*

<!-- Screenshot: Settings page -->
> *Screenshot: Settings — coming soon*

---

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
- **Context hook** — injects relevant knowledge into each prompt
- **Slash commands** — 6 commands for managing lm-assist

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
| Slash commands | Yes | 6 `/assist-*` commands |
| Statusline | No (optional) | Git branch, context %, process stats in status bar |

The statusline is optional — install via `/assist-setup --statusline` or the web UI settings page.

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

The MCP server (`lm-assist-context`) provides 3 tools that Claude Code can use directly:

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge, milestones, architecture, and file history |
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
| Core API | 3100 | REST API — sessions, knowledge, milestones, architecture, tasks |
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
│   │   ├── milestone/       ← Milestone extraction pipeline
│   │   └── vector/          ← Embeddings + vector store
│   └── hooks/               ← Claude Code hook scripts
├── web/                     ← Web UI (Next.js, React 19)
├── commands/                ← Slash command definitions
├── hooks/                   ← Plugin hook registration
├── .claude-plugin/          ← Claude Code plugin metadata
├── .mcp.json                ← MCP server auto-registration
├── core.sh                  ← Service manager
└── bin/lm-assist.js         ← CLI entry point
```

## Requirements

- Node.js >= 18
- Claude Code (for slash commands and MCP integration)

## License

[AGPL-3.0-or-later](LICENSE)
