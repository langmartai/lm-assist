# How lm-assist Works

A guide to how the pieces fit together — the Core API, Web UI, MCP server, hooks, statusline, and Claude Code itself.

---

## The Big Picture

lm-assist is a local service that sits alongside Claude Code. Its primary purpose is giving you **web-based access to your Claude Code terminals** — so you can monitor running sessions, resume work, and manage everything from a browser, even when you're away from your computer.

It also reads the session files Claude Code writes to disk, builds a searchable knowledge base from them, and feeds relevant context back into future sessions automatically via hooks and MCP tools.

You can access the Web UI two ways:
- **Local** — open `localhost:3848` in your browser (or any device on the same LAN/WiFi)
- **Cloud** — access through `langmart.ai` from anywhere, via the Hub proxy — monitor and resume your Claude Code sessions from any device

![Architecture diagram showing how you access lm-assist through either local browser or langmart.ai cloud proxy, how Claude Code's hooks and MCP server connect to the Core API, and how session files and knowledge flow between components](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-diagram.svg)

---

## Components

### 1. Core API (port 3100)

The backend. A Node.js HTTP server that reads Claude Code session files from disk, indexes them, and exposes everything via REST endpoints. There is no external database — it reads the JSONL files Claude Code already writes to `~/.claude/`.

**What it does:**
- Parses and caches session data (LMDB-backed)
- Runs the knowledge generation pipeline (extract from sessions, vector-index with LanceDB)
- Serves search results (BM25 full-text + vector similarity)
- Manages web terminals (ttyd)
- Optionally connects to LangMart Hub for cloud access

**Entry point:** `core/dist/cli.js` (compiled from `core/src/cli.ts`)

### 2. Web UI (port 3848)

A Next.js application that talks to the Core API. This is what you open in your browser. The primary purpose is **managing your Claude Code terminals** — you can monitor running sessions, open live terminals, and resume work from any browser, including remotely via langmart.ai when you're away from your computer.

**Pages:**
- **Web Terminal** — live terminal access to running Claude Code sessions via ttyd. Monitor output, resume work remotely.
- **Sessions** — browse all Claude Code sessions across all projects, with token counts, costs, model info
- **Session Detail** — full conversation timeline with tool calls, thinking blocks, and agent trees
- **Tasks** — Kanban board aggregating task lists from all active sessions
- **Knowledge** — browse, search, and manage extracted knowledge entries
- **Architecture** — auto-generated codebase structure documentation
- **Settings** — manage hooks, MCP server, statusline, hub connection, experiments

**Entry point:** `web/` directory (Next.js 16)

### 3. MCP Server (search, detail, feedback)

The MCP (Model Context Protocol) server gives Claude Code direct access to the knowledge base through three tools:

| Tool | What it does |
|------|-------------|
| `search` | Find knowledge entries by natural language query. Supports scope filters (24h, 7d, 30d, all) and project filtering. |
| `detail` | Expand a knowledge entry by ID (e.g., `K001`, `K001.2`) to get full content. Progressive disclosure — summary first, drill down as needed. |
| `feedback` | Flag a knowledge entry as outdated, wrong, irrelevant, or useful. Drives the self-improvement loop. |

The MCP server runs as a subprocess spawned by Claude Code (stdio transport). It forwards tool calls to the Core API via HTTP on port 3100.

**Entry point:** `core/dist/mcp-server/index.js` (compiled from `core/src/mcp-server/index.ts`)

### 4. Context Injection Hook

A hook that fires on every user prompt (`UserPromptSubmit` event). Before Claude sees your message, this hook injects relevant context from the knowledge base.

**How it works:**
1. You type a prompt in Claude Code
2. Claude Code fires the `UserPromptSubmit` hook
3. The hook script (`core/hooks/context-inject-hook.js`) runs
4. It reads your prompt preview and calls the Core API (`POST /context/suggest`)
5. The API searches the knowledge base for entries matching your prompt
6. Matching entries are injected as additional context alongside MCP tool instructions
7. Claude receives your prompt + the injected context and responds with that knowledge already available

**Modes** (configured in `~/.claude-code-config.json`):
- `"mcp"` (default) — injects instructions for Claude to use MCP search/detail tools
- `"suggest"` — pre-fetches and injects matching knowledge directly
- `"both"` — does both
- `"off"` — disabled

**Entry point:** `core/hooks/context-inject-hook.js` (pure Node.js, cross-platform)

### 5. Statusline Hook (optional)

Renders an informational status bar at the bottom of your Claude Code terminal showing session history, git branch, system info, and more.

**What it shows:**
- Last N user prompts (recent history at a glance)
- Current project directory and git branch
- System info: context usage %, RAM, process ID, model name

This is optional and not installed automatically by the plugin. Enable it via `/assist-setup --statusline` or through the Settings page.

**Entry point:** `core/hooks/statusline-worktree.js` (Node.js, cross-platform)

---

## Where Claude Code Stores Data

Claude Code writes everything to `~/.claude/` on your machine. lm-assist reads these files — it never modifies them.

```
~/.claude/
├── projects/
│   └── <url-encoded-project-path>/
│       └── sessions/
│           ├── <session-uuid>.jsonl    ← full conversation transcript
│           └── ...
├── tasks/
│   └── <session-id>/
│       ├── 1.json                      ← individual task files
│       ├── 2.json
│       └── ...
├── teams/
│   └── <team-name>.json                ← team configurations
└── plans/
    └── <plan-name>.md                  ← plan markdown files
```

Each session is a single JSONL file (one JSON object per line). Every message — your prompts, Claude's responses, tool calls with full inputs/outputs, extended thinking blocks, token usage — is recorded as a line in that file.

Sessions are append-only. Nothing is overwritten. The file grows as the conversation progresses.

---

## Where lm-assist Stores Data

lm-assist keeps its own data separate from Claude Code:

```
~/.lm-assist/
├── logs/
│   ├── context-inject-hook.log         ← hook execution log
│   └── mcp-calls.jsonl                 ← MCP tool call log (search/detail/feedback)
├── hub.json                            ← Hub gateway config (if connected)
├── milestone/
│   └── settings.json                   ← experiment settings
└── knowledge/                          ← knowledge database files
```

**Config file:** `~/.claude-code-config.json` — shared config for lm-assist settings (context injection mode, statusline preferences, dev mode toggle).

---

## Viewing Logs

### Hook Logs (context injection)

See what the context injection hook is doing on each prompt:

```bash
# Via slash command (in Claude Code)
/assist-logs

# Via curl
curl http://localhost:3100/assist-resources/log?file=context-inject-hook.log

# Direct file
cat ~/.lm-assist/logs/context-inject-hook.log
```

The log shows each prompt trigger, what knowledge entries were matched, how many tokens were injected, and any errors.

### MCP Tool Logs

See every `search`, `detail`, and `feedback` call Claude made:

```bash
# Via slash command (in Claude Code)
/assist-mcp-logs

# Via curl
curl http://localhost:3100/assist-resources/log?file=mcp-calls.jsonl

# Direct file
cat ~/.lm-assist/logs/mcp-calls.jsonl
```

Each line is a JSON object with the tool name, input parameters, result summary, and timestamp.

### Service Logs (Core API / Web UI)

```bash
# Via lm-assist CLI
lm-assist logs core    # Core API logs
lm-assist logs web     # Web UI logs

# Or via core.sh (if running from the repo)
./core.sh logs core
./core.sh logs web
```

### Viewing in the Web UI

Both hook logs and MCP logs are also available in the web UI. Navigate to the **Settings** page — the log viewers are built in with filtering and search.

---

## Viewing Knowledge

Knowledge entries are extracted from your Claude Code session history (specifically from completed Explore subagent results). Each entry is indexed for search.

**In the Web UI:**

Open `http://localhost:3848` and go to the **Knowledge** page. You can:
- Browse all entries with type labels (wiring, contract, schema, flow, etc.)
- Search by keyword or natural language
- Expand any entry to see its full content and source session
- Generate new knowledge from recent sessions

**Via slash command:**

```bash
# Search the knowledge base from Claude Code
/assist-search <your query>
```

**Via the MCP tools** (Claude uses these automatically when the hook is active):

```
search("authentication flow")     → ranked results
detail("K042")                    → full content of entry K042
detail("K042.3")                  → specific part 3 of entry K042
```

**Via REST API:**

```bash
# Search
curl "http://localhost:3100/knowledge/search?q=authentication"

# List all
curl http://localhost:3100/knowledge

# Generate from sessions
curl -X POST http://localhost:3100/knowledge/generate
```

---

## Install and Setup

### Option A: npm package (recommended)

```bash
npm install -g lm-assist
lm-assist start
```

This installs the `lm-assist` CLI globally. The `start` command launches both the Core API (port 3100) and Web UI (port 3848).

### Option B: Claude Code plugin

```bash
# From the lm-assist repo (or by name)
claude plugin install lm-assist@langmartai
```

The plugin auto-registers:
- The MCP server (search, detail, feedback tools)
- The context injection hook (UserPromptSubmit)
- Six slash commands (`/assist`, `/assist-logs`, `/assist-mcp-logs`, `/assist-search`, `/assist-status`, `/assist-setup`)

Then start services:

```bash
/assist-setup
```

### CLI Commands

```bash
lm-assist start       # Start Core API + Web UI
lm-assist stop        # Stop all services
lm-assist restart     # Restart all services
lm-assist status      # Show status of all components
lm-assist logs core   # View Core API logs
lm-assist logs web    # View Web UI logs
lm-assist upgrade     # Upgrade to latest version
```

### Slash Commands (inside Claude Code)

| Command | Description |
|---------|-------------|
| `/assist` | Open the Web UI in your browser |
| `/assist-status` | Show status of all components (API, web, MCP, hooks, hub) |
| `/assist-setup` | Install and verify all integrations |
| `/assist-search` | Search the knowledge base |
| `/assist-logs` | View context injection hook logs |
| `/assist-mcp-logs` | View MCP tool call logs |

---

## Ports

| Service | Default Port | What it serves |
|---------|-------------|----------------|
| Core API | 3100 | REST API — sessions, knowledge, tasks, search, MCP endpoints |
| Web UI | 3848 | Next.js frontend — the browser interface |
| ttyd terminals | 5900+ | One per active web terminal session |

Ports are configurable via `.env` in the project root:

```bash
API_PORT=3100
WEB_PORT=3848
```

---

## Local Mode vs Cloud Proxy Mode

lm-assist runs in pure local mode by default. Everything stays on your machine.

### Local Mode (default)

- Core API and Web UI run on your machine
- Access the web UI at `http://localhost:3848`
- Accessible from other devices on the same LAN/WiFi via your machine's IP (e.g., `http://192.168.1.100:3848`)
- No data leaves your machine
- No account or authentication required (localhost access is always trusted)

### Cloud Proxy Mode (via langmart.ai)

When connected to LangMart Hub, lm-assist becomes accessible from anywhere through `langmart.ai`. This is the primary way to **manage your Claude Code terminals remotely** — when you're away from your computer, you can still monitor running sessions, read their output, and resume work from any browser.

- The Hub Client (built into the Core API) connects to LangMart Hub via WebSocket
- Hub assigns your machine a gateway ID
- You can access the Web UI at `https://langmart.ai/w/{gateway-id}/assist/`
- **Live terminal access** — open a web terminal to your Claude Code session from any device
- **Session monitoring** — see what Claude is doing right now, check costs, review results
- API calls from the cloud are relayed through the WebSocket to your local Core API

**What changes:**
- Authentication is required (API key in `.env`)
- The Hub relays requests — your data passes through the relay but the Core API and data remain on your machine
- You can access your terminals, sessions, knowledge, and tasks from any browser, anywhere

**Setup:**

```bash
# Add to .env
TIER_AGENT_HUB_URL=wss://hub.langmart.ai/gateway
TIER_AGENT_API_KEY=sk-your-key-here

# Connect
lm-assist start        # Core API auto-connects if hub config is present
```

Or connect from the Web UI: **Settings** page has Hub connection controls.

**When to use which:**

| | Local Mode | Cloud Proxy Mode |
|---|---|---|
| Access | localhost or same network only | Anywhere via langmart.ai |
| Auth | None needed | API key required |
| Data path | Never leaves your machine | Relayed through Hub (data stored locally) |
| Setup | Just `lm-assist start` | Configure Hub URL + API key |
| Use case | Solo development, same machine | Remote terminal access, monitor sessions away from desk, multi-machine |

### Multi-Machine: Knowledge Sync Across Machines

If you run Claude Code on more than one machine — a desktop at the office, a laptop on the go, a cloud VM — each machine runs its own independent lm-assist instance with its own Core API, Web UI, session files, and knowledge base. Each machine extracts knowledge locally from its own sessions.

The Hub connects them all, so Claude Code on any machine sees knowledge from every connected host:

1. **Knowledge sync** — when you type a prompt on any machine, Claude Code's MCP tools and hook injection query knowledge from all connected machines via the Hub. Claude doesn't just see local knowledge — it sees what was learned everywhere.

2. **Remote terminal management** — access any machine's Claude Code terminal from a single browser via `langmart.ai`. Monitor running sessions, resume work from wherever you are.

**How cross-machine knowledge sync works:**

1. **You type a prompt** on Machine B (your laptop)
2. **Hook + MCP `search()`** queries local knowledge and the Hub
3. **Hub relays the query** to Machine A and Machine C's Core APIs
4. **Merged results injected** into Claude's context from all three machines

Each machine's sessions produce knowledge independently. But when the Hub connects them, Claude Code on any machine can query across the full set. A bug you debugged on the cloud VM last week can inform Claude's response on your laptop today.

**Session sync.** Each machine periodically sends a session cache summary to the Hub (session IDs, project paths, models, token counts, timestamps). The Hub knows what exists on each machine, enabling the Web UI to browse sessions from any connected host.

**Remote terminal.** Web terminal access (ttyd) works across the relay too. You can open a live terminal on Machine C from your browser at a coffee shop — the Hub relays the stdin/stdout through the WebSocket connection.

**Key points:**

- Claude Code on any machine sees knowledge from all connected machines via MCP + hook injection
- Each machine is fully independent — if the Hub goes down, local knowledge still works
- Machines can be on completely different networks (office LAN, home WiFi, cloud VPC)
- The Hub is a relay only — no session data or knowledge is stored on the Hub
- Each machine needs its own `TIER_AGENT_HUB_URL` and `TIER_AGENT_API_KEY` in `.env`

---

## How the Pieces Connect (end to end)

Here is what happens when you type a prompt in Claude Code with lm-assist running (matching the left side of the diagram):

**Step 1: You → Claude Code**
1. **You type a prompt** in Claude Code (CLI terminal)

**Step 2: Claude Code triggers knowledge retrieval**
2. **Context injection hook fires** — `context-inject-hook.js` runs, calls `POST /context/suggest` on the Core API
3. **Claude calls MCP tools** — uses `search()` and `detail()` to pull knowledge from the base

**Step 3: Knowledge base is searched**
4. **LanceDB + LMDB** return matching knowledge entries (semantic + BM25 full-text search)
5. **Results injected** into Claude's context before it writes its response

**Then the cycle continues:**
6. **Claude responds** informed by both your prompt and the accumulated knowledge
7. **The session is recorded** as a JSONL file in `~/.claude/projects/*/sessions/`
8. **Knowledge generation** — later, the Core API extracts knowledge from this session's Explore subagents (parse → embed → store in vector DB), adding to the knowledge base for future sessions
9. **The Web UI reflects it** — open `http://localhost:3848` to see the session, manage terminals, browse tasks

The cycle is: **sessions produce knowledge, knowledge improves future sessions.**

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `bin/lm-assist.js` | CLI entry point (`lm-assist start/stop/status/...`) |
| `core/dist/cli.js` | Core API server entry |
| `core/dist/mcp-server/index.js` | MCP server (spawned by Claude Code) |
| `core/hooks/context-inject-hook.js` | Context injection hook script |
| `core/hooks/statusline-worktree.js` | Statusline hook script (optional) |
| `.claude-plugin/plugin.json` | Plugin metadata (name, version) |
| `.mcp.json` | MCP server registration for Claude Code |
| `hooks/hooks.json` | Hook registration for Claude Code |
| `commands/` | Slash command definitions |
| `.env` | Port config, API keys, Hub connection |
| `~/.claude-code-config.json` | User preferences (injection mode, statusline, dev mode) |
| `~/.lm-assist/logs/` | Hook and MCP logs |
| `~/.claude/projects/*/sessions/*.jsonl` | Claude Code session files (read-only) |

---

## Resources

- **GitHub:** [github.com/langmartai/lm-assist](https://github.com/langmartai/lm-assist)
- **Issues:** [github.com/langmartai/lm-assist/issues](https://github.com/langmartai/lm-assist/issues)
- **Session File Format:** See `docs/claude-code-session-internals.md`
- **Knowledge Reuse Guide:** See `docs/session-knowledge-reuse.md`
- **Experimental Features:** See `docs/experimental.md`
- **API Reference:** See `CLAUDE.md` for the full endpoint list
