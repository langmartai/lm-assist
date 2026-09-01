# lm-assist

## Full Observability & Control for the Claude Product Line

One self-hosted platform that sees and steers everything Claude does for you — **Claude Code sessions (local, remote, and cloud/CCR), claude.ai conversations, Cowork sessions, Agent SDK runs, your Claude memory, MCP connectors, and usage limits** — with three ways in: a **web dashboard**, a **REST API** (860+ endpoints), and **280+ MCP tools** that work from inside Claude itself: a claude.ai conversation, a Cowork session, or a Claude Code session. And it all extends **cross-node and cross-session** across your whole fleet.

[![Discord](https://img.shields.io/discord/1475647234669543558?logo=discord&label=Discord&color=5865F2)](https://discord.gg/xb2BNnk4)

### What's covered

| Claude surface | What lm-assist gives you |
|---|---|
| **Claude Code — local sessions** | 15 insight views, live web terminals, per-model costs, drive · resume · abort |
| **Claude Code — remote & cloud (CCR)** | bridge local sessions to claude.ai/code (load · mirror · connect); start, drive, and stop cloud code sessions |
| **claude.ai conversations** | list · read · create · rename · fork · token measurement · full-text search across the whole account |
| **Cowork sessions** | create and track Cowork tasks from any Claude session |
| **Agent SDK runs** | the same session engine — full inspection of programmatic agents, headless runner included |
| **Memory & rules** | every project, every machine: search, compare, import; rules auto-converge with per-OS scoping |
| **MCP connectors & tools** | 280+ tools with per-tool overrides and on/off; automatic connector upkeep on claude.ai |
| **Usage & limits** | live rate-limit/quota windows (5h · 7d), per-model token & cost breakdown, statusline |

**Everything above is cross-node and cross-session.** Enroll machines with a one-time keypack and every row of that table is reachable from every other machine — and from inside any Claude session: a claude.ai chat can read a code session running on your Windows box, drive a terminal on your Linux server, message another live session, or pull a different project's memory.

### Three doors, one Core

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/capability-map.svg"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/capability-map.svg" alt="lm-assist capability map — the Web UI, the MCP connector (the main door, used from claude.ai conversations, Cowork sessions, and local/remote Claude Code sessions), and the Claude Code skills plugin, all over one Core" width="900"></a>

### Install

```
/plugin marketplace add langmartai/lm-assist
/plugin install lm-assist@langmartai
```

Then **open a new Claude Code session** and run `/assist-setup`.

Or directly from npm:

```bash
npm install -g lm-assist
```

> **Read:** [Inside Claude Code: The Session File Format and How to Inspect It](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b) — technical breakdown of the JSONL session format, message types, subagent trees, and how lm-assist surfaces it all.

---

## Why lm-assist

The Claude products don't ship a unified dashboard: Claude Code lives in a terminal, claude.ai conversations in a browser tab, Cowork and cloud sessions in their own views, and the Agent SDK in your logs. lm-assist is a local service that runs beside Claude Code, reads the session files it already writes, proxies the claude.ai surfaces you're signed into, and turns everything into an API, a web UI, and MCP tools — so the visibility and control live wherever you are, including inside a Claude conversation.

| Without lm-assist | With lm-assist |
|-------------------|---------------|
| Each Claude surface is its own silo | Code, claude.ai, Cowork, cloud & SDK — one platform |
| Scroll through terminal output | 15 specialized views per session |
| No cost visibility | Per-model token & cost breakdown |
| Can't see what agents are doing | Real-time execution dashboard |
| One machine at a time | Enrolled fleet, one surface for all nodes |
| Sessions end when you walk away | Auto-resume, scheduling, mission control |
| Claude can't act on your infrastructure | 280+ MCP tools inside Claude Code & claude.ai |

---

## What It Does

### Observe

Real-time tracking of every session, from every source.

- Session list with live status and running-process detection; per-session and per-project cost tracking with per-model token breakdown
- 15 insight views per session: Chat, Thinking, Agents, Plans, Team, DAG, Files, Git & more; full subagent trees
- Real full-text search over your prompt history (bm25/FTS5, CJK-aware) plus vector search
- SSE event stream for live updates; statusline with context %, rate limits, cost

**Key endpoints:** `GET /monitor/executions` · `GET /stream` · `GET /sessions` · `GET /sessions/:id/dag` · `GET /search`

### Control

Your sessions, reachable from anywhere — and *session* means all three kinds of Claude work: **local Claude Code sessions**, **remote/cloud code sessions (CCR)**, and **claude.ai conversations** (list, read, create, rename, fork, measure tokens).

- Web terminal (ttyd) from any browser; drive a live session's prompt from the API or from Claude itself
- Start, resume, and abort agent executions; SDK runner for headless programmatic runs
- **CCR** — bridge a local Claude Code session to claude.ai/code and operate it from the claude.ai UI: read-only replay, one-way mirror, or full two-way drive behind a safety gate
- Proxied Claude Code OAuth surface (14 endpoints) and claude.ai web-session surface (28 endpoints) — see [`docs/claude-code-routes.md`](./docs/claude-code-routes.md) and [`docs/claude-ai-routes.md`](./docs/claude-ai-routes.md)
- **Voice** — talk to a claude.ai conversation from the browser, with selectable voices

### Fleet

Many machines, one surface. Connect nodes to the optional LangMart Hub and every enrolled machine's sessions, memory, and tools are reachable from anywhere — including from a claude.ai conversation.

- One-time keypack enrollment for fresh nodes (`lm-assist login <keypack>`)
- Node clusters, selection profiles, placement, per-node build/upgrade tracking
- Cross-node data service (cache / vector / sql) with access keys and sync; resumable bulk file transfer; direct port-forwarding
- Memory and rules that follow you across hosts: auto-converging user rules (per-OS scoping) and cross-host memory search

### Automate

- **Mission control** — a mission graph with a fleet-elected controller that spawns, watches, and re-engages worker sessions
- Scheduled jobs: one-time, recurring, or trigger-only, with full run capture and guard conditions
- Auto-resume stalled sessions (network failures included); automatic model fallback when a model hits its limit

### Extend

- **MCP connector** — 280+ scope-gated tools inside Claude Code or claude.ai: sessions, search, memory, terminal driving, missions, data, transfers, backups, GitHub, nodes, VMs, containers, desktop automation, and the service connectors below. A `bootstrap` tool teaches a connecting session the whole surface.
- **Service connectors** driving the operator's own logged-in browser via CDP: **Gmail**, **LinkedIn**, **WhatsApp** — plus **VM management** (Hyper-V/KVM), **container management** (Docker), and **desktop automation** (screenshot, input, OCR, window control)
- **MCP plugin system** — third-party plugins expose tools as `ext__<plugin>__<tool>` ([contract](./docs/mcp-plugin-contract.md)); first-party plugins ship bundled in the package, seeded and trusted on boot with checksum-pinned payloads
- **UI panes** — every dashboard is also a standalone page with its own gateway URL, so a Claude session can *show you UI* instead of describing it: ask for the mission graph in a claude.ai chat and get a live link ([example](./examples/ui-panes/)); pages run under per-page API grants and platform SSO

### Web Dashboard

The Next.js dashboard ships in the package: sessions browser, session detail with all insight views, live terminal, missions, memory & rules, CCR remote, scheduler, MCP tool registry, settings. Pluggable UI panes let additional pages be served through the hub gateway.

<a href="https://langmart.ai/images/assist/session-browser.png"><img src="https://langmart.ai/images/assist/session-browser.png" alt="Session Browser" width="700"></a>

---

## Architecture & Data Sources

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-observability.svg"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-observability.svg" alt="lm-assist architecture" width="700"></a>

How the pieces fit in depth: [`docs/how-it-works.md`](./docs/how-it-works.md) · [`docs/architecture.md`](./docs/architecture.md).

lm-assist reads the same JSONL session files regardless of how they were created:

| Source | What It Produces | lm-assist Coverage |
|--------|-----------------|-------------------|
| **Claude Code CLI** | Interactive sessions with subagents, teams, worktrees | Full parsing — all message types, tool calls, metadata |
| **Agent SDK** (Python/TypeScript) | Programmatic agent executions | Same JSONL format — full session inspection |
| **Headless mode** (`claude -p`) | Background/CI runs | Detected via process status store |
| **Running processes** | Live PID, tmux, terminal state | Real-time monitoring with zero polling overhead |

---

## Install

### Quick start

```bash
npm install -g lm-assist
```

The postinstall script starts the services, installs the statusline, and installs the [Claude Code Multisession](https://github.com/langmartai/claude-code-multisession) plugin. **Open a new Claude Code session** and type `/sessions` to verify.

### Plugin marketplace

Add the marketplace once — then install any combination of plugins:

```
/plugin marketplace add langmartai/lm-assist
```

| Install command | Layer | What you get |
|----------------|-------|-------------|
| `npm install -g lm-assist` | Foundation | Core API (:3100), web dashboard (:3848), MCP server, statusline |
| `/plugin install lm-assist@langmartai` | Setup & diagnostics | `/assist-setup` `/assist-status` `/assist-search` `/assist-logs` |
| `/plugin install claude-code-multisession@langmartai` | Skills | observe + route skills, `/projects` `/sessions` `/summary` `/run` |
| `/plugin install claude-code-webui@langmartai` | Web access | dashboard skill, `/web` `/web-sessions` `/web-tasks` |

**lm-assist** is the foundation — the API server, MCP server, and web dashboard that power everything. The plugins add skills and commands on top. Install all of them for the full experience, or pick what you need.

### Install from source

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install --ignore-scripts && npm run build
./core.sh start
```

Full build/pack/install/upgrade/deploy reference: [`docs/build-pack-install-upgrade.md`](./docs/build-pack-install-upgrade.md).

### Join a fleet

```bash
lm-assist login --new-node     # on an enrolled node: mint a one-time keypack
lm-assist login <lmkp_…>       # on the fresh node: redeem it
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| Core API | 3100 | REST API — sessions, monitor, agents, missions, memory, connectors |
| Web UI | 3848 | Next.js dashboard — insight views, terminal, missions, settings |

```bash
lm-assist start       # Start both services
lm-assist stop        # Stop all services
lm-assist status      # Health check + process info
lm-assist upgrade     # Upgrade to the latest published version
```

## Skills & Commands

Provided by the plugins above — auto-installed via `/assist-setup`.

| Command | Description |
|---------|-------------|
| `/sessions` | Session list with costs, turns, running status |
| `/summary` | Summarize the current session, generate a display name |
| `/run <prompt>` | Execute an agent with pre-flight checks |
| `/assist` | Open the web UI in your browser |
| `/assist-status` | Show status of all components |
| `/assist-setup` | Start services and verify integrations |
| `/assist-search` | Search prompts & knowledge |

The **observe** skill activates on questions like "what's running and what has it cost?"; the **route** skill detects when a prompt belongs to another project and recommends stay / resume / queue / new — and both learn from your usage over time (session summaries, prompt queue, routing signals).

---

## API Surface

860+ REST endpoints across the Core API. The broad map:

| Category | Highlights |
|----------|-----------|
| **Sessions & search** | List, detail, delta fetch, conversation, subagents, DAG, forks; bm25 + vector search |
| **Monitor & control** | Running executions, abort, SSE stream, agent execute/resume, terminal driving |
| **Missions & scheduler** | Mission graph, controller, workflows, scheduled jobs |
| **Fleet** | Nodes, clusters, enrollment, builds/upgrades, transfers, port-forwards, data service |
| **Memory & rules** | Cross-host memory, rule sync, knowledge (optional) |
| **Integrations** | Claude Code OAuth proxy, claude.ai web-session proxy, GitHub, connectors (Gmail/LinkedIn/WhatsApp), VM, container, desktop, voice |

All session endpoints support `ifModifiedSince` for efficient polling, and three indexing dimensions: `lineIndex` (JSONL position), `turnIndex` (conversation turn), and `userPromptIndex` (user message count). Full reference: [`docs/api-endpoints.md`](./docs/api-endpoints.md).

## Examples

Per-use-case walkthroughs with screenshots from a live deployment, in [`examples/`](./examples/):
[MCP connector install](./examples/mcp-connector-install/) ·
[claude.ai browser auth + automatic connector upkeep](./examples/claudeai-browser-auth/) ·
[full claude.ai conversation search](./examples/claudeai-conversation-search/) ·
[UI panes](./examples/ui-panes/) ·
[cross-node memory](./examples/cross-node-memory/) ·
[Gmail](./examples/gmail-connector/) · [WhatsApp](./examples/whatsapp-connector/) · [LinkedIn](./examples/linkedin-connector/)

| | |
|---|---|
| <a href="./examples/ui-panes/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/ui-panes/ui-pane-mission-graph-masked.png" alt="Mission graph pane on its own URL"></a><br><sub>**UI panes** — ask for the mission graph in chat, get a live dashboard URL</sub> | <a href="./examples/gmail-connector/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/gmail-connector/gmail-inbox-masked.png" alt="Gmail through the connector, content masked"></a><br><sub>**Gmail connector** — your own logged-in browser, driven over CDP (content masked)</sub> |
| <a href="./examples/whatsapp-connector/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/whatsapp-connector/whatsapp-masked.png" alt="WhatsApp Web through the connector, content masked"></a><br><sub>**WhatsApp connector** — reads and sends via the connector's own tab (content masked)</sub> | <a href="./examples/linkedin-connector/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/linkedin-connector/linkedin-feed-masked.png" alt="LinkedIn feed through the connector, content masked"></a><br><sub>**LinkedIn connector** — no personal API exists, so a real browser does the work (content masked)</sub> |
| <a href="./examples/mcp-connector-install/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/mcp-connector-install/mcp-tools-bootstrap.png" alt="MCP tool registry with bootstrap selected"></a><br><sub>**MCP tools** — 280+ tools, per-tool overrides and on/off, fleet-synced</sub> | <a href="./examples/cross-node-memory/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/cross-node-memory/memory-page-masked.png" alt="Memory page across all projects, content masked"></a><br><sub>**Cross-node memory** — every project's and every machine's Claude memory, one surface</sub> |

## Documentation

The docs are organized in [`docs/README.md`](./docs/README.md) — getting started, architecture, API references, feature guides, connector guides, and operations.

## Configuration

No API key needed — lm-assist works entirely with your local Claude Code session data. Optionally copy `.env.example` to `.env`:

```bash
API_PORT=3100                    # Core API port (default: 3100)
WEB_PORT=3848                    # Web UI port (default: 3848)
TIER_AGENT_HUB_URL=wss://...     # Optional hub gateway WebSocket URL
TIER_AGENT_API_KEY=sk-...        # Optional hub API key
```

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | Full | All features including web terminal |
| macOS | Full | All features including web terminal |
| Windows | Full core | Sessions, MCP, desktop automation, VM/container; no ttyd web terminal |
| Mobile / Tablet | Web UI | Monitor, debug, and control from any device on your network |

## Who It's For

- **Solo developers** using Claude Code — see and steer everything across all your sessions and machines
- **Teams building with the Agent SDK** — observability and control for agent pipelines
- **Operators running agent fleets** — enrollment, placement, upgrades, cost tracking, automation
- **AI product builders** — debug agent behavior with full session introspection

## Changelog

See [CHANGELOG.md](CHANGELOG.md) — v0.2.0 is the first npm publish since 0.1.70 and consolidates roughly 1,700 commits of features.

## Requirements

- Node.js >= 20.9
- Claude Code (for slash commands and MCP integration)

## Related

- [claude-code-multisession](https://github.com/langmartai/claude-code-multisession) — Skills plugin: cross-project session routing, `/projects`, `/sessions`, `/summary`, `/run`
- [claude-code-webui](https://github.com/langmartai/claude-code-webui) — Web dashboard plugin: insight tabs, web terminal, `/web`, `/web-sessions`, `/web-tasks`
- [Knowledge system](https://databunny.medium.com/your-claude-sessions-are-gold-stop-paying-twice-for-the-same-knowledge-7632ac6ddb88) — Optional: auto-extract knowledge from sessions, MCP tools, context injection. Off by default.

## License

[AGPL-3.0-or-later](LICENSE)
