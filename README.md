# lm-assist

**Full observability & control for the Claude product line** — one self-hosted platform that sees and steers every Claude surface, cross-node and cross-session, from a dashboard, an API, or inside Claude itself.

[![Discord](https://img.shields.io/discord/1475647234669543558?logo=discord&label=Discord&color=5865F2)](https://discord.gg/xb2BNnk4)

## The Goal

**Full observability and control for the Claude product line.** lm-assist is a self-hosted platform that sees and steers everything Claude does for you — Claude Code sessions (local, remote, and cloud/CCR), claude.ai conversations, Cowork sessions, Agent SDK runs, your Claude memory and rules, MCP connectors, and usage limits. It runs beside Claude Code, reads the session files Claude already writes, proxies the claude.ai surfaces you're signed into, and turns all of it into a web dashboard, a REST API, and MCP tools that work from inside Claude itself. Everything is cross-node and cross-session: enroll your machines once and every session, memory file, and tool on every machine is reachable from every other — including from inside any Claude conversation. And control is as first-class as observability: sessions can be driven, messaged, scheduled, auto-resumed after stalls, and moved off a rate-limited model — by you, or by Claude.

## The Landscape

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

### Four doors, one Core

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/capability-map.svg"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/capability-map.svg" alt="lm-assist capability map — four doors onto one Core: the MCP connector (the main door, used from claude.ai conversations, Cowork sessions, and local/remote Claude Code sessions), the Web UI, the Claude Code skills plugin, and the Core's own REST API" width="900"></a>

Every door lands on the same Core service — the web dashboard, the MCP connector, the Claude Code plugin, and the REST API itself are four views of one Core, so nothing you can see in one is invisible from another. Pick your angle:

### The MCP interface — the key entry

The connector is **installed for you**: once a node connects to the hub, *lm-assist langmart* appears under Connectors in the Claude app and at claude.ai, and Claude Code on that machine gets the same server locally. Claude runs in the cloud and your machines have no inbound ports, so the **hub relays** every MCP call over the node's own outbound WebSocket — that relay is what makes a claude.ai chat reach a session on any of your machines.

| | |
|---|---|
| <a href="./examples/mcp-connector-install/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/mcp-connector-install/claude-app-connectors.png" alt="Claude desktop app — Settings → Connectors showing lm-assist langmart connected"></a><br><sub>**Claude desktop app** — Settings → Connectors: *lm-assist langmart*, provisioned after the hub connect</sub> | <a href="./examples/mcp-connector-install/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/mcp-connector-install/claudeai-connector-menu-masked.png" alt="claude.ai conversation — the Connectors submenu with lm-assist langmart enabled"></a><br><sub>**In a claude.ai conversation** — the composer's Connectors submenu, per-tool access one click away</sub> |

How it works, what gets relayed, first call, governance, troubleshooting: [`docs/mcp-connector.md`](./docs/mcp-connector.md) · walkthrough with a real conversation: [`examples/mcp-connector-install`](./examples/mcp-connector-install/).

### If you're the human

You watch and drive from the **web dashboard**: a cross-node sessions browser with per-session insight views (chat, thinking, agents, git, files, and more), a live grid of every running session, real web terminals in the browser, and dedicated workspaces for missions, memory & rules, CCR remote sessions, Cowork chat, the scheduler, and MCP tool governance. From the terminal, the **Claude Code plugin** gives you the same platform as skills and slash commands — `/sessions`, `/summary`, `/run`, `/assist-status` — plus the statusline (context %, rate limits, cost) and hooks, all talking to the same Core API the dashboard uses. **UI panes** close the loop between the two: every dashboard is also a standalone page with its own URL, so a Claude session can hand you a live mission graph or session view mid-conversation instead of describing it. A machine switcher in the dashboard reaches every enrolled node through the hub relay, so one browser tab covers the whole fleet. The flagship automation — mission autopilot, auto-resume, model-limit fallback, the backlog graph — is all operated from these same pages. Feature-by-feature detail lives in [Functional documentation](#functional-documentation), the doc map in [docs/README.md](./docs/README.md), and the component-by-component breakdown in [docs/components.md](./docs/components.md).

### If you're the AI agent

The **MCP connector is the main door**: attach it to a claude.ai conversation, a Cowork session, or a Claude Code session (local or remote) and you reach 280+ scope-gated tools over one server — stdio for Claude Code and Desktop, streamable HTTP for claude.ai and Cowork, with the hub relay carrying calls to any enrolled node. A single `bootstrap` tool teaches a connecting session the entire surface in one response. From there an agent can search and read every session on every machine, drive and message live sessions, run the mission graph and backlog, read and write cross-node memory and rules, manage the operator's claude.ai conversations and account, and hand the human live dashboard URLs via the UI pane tools. The same door opens onto the extended, beyond-Claude surface: browser-driven service connectors (Gmail, LinkedIn, WhatsApp, mobile), GitHub, VMs, containers, desktop automation, the data service, and file transfer — plus third-party plugins exposed as `ext__<plugin>__<tool>`. Every tool dispatches into the same Core REST API the other doors use, under per-tool governance the operator controls. The tool families are covered in [Functional documentation](#functional-documentation), with the doc index in [docs/README.md](./docs/README.md) and per-component detail in [docs/components.md](./docs/components.md).

### If you're integrating systems

The **REST API** is the whole platform as endpoints: 860+ routes on the Core service (:3100), the same surface the web dashboard renders and the MCP tools dispatch into. Session history is served as sliceable JSONL — indexed three ways, with delta and conditional fetches — and an **SSE stream** pushes live execution updates so pollers don't have to. Agent execution endpoints run prompts headlessly through the Agent SDK runner and track cost per model; route families cover missions, scheduler, memory & rules, fleet operations, transfers, and every connector. Access is token-authenticated locally, and the same routes extend cross-node over the hub relay, so one integration point can address the whole fleet. Anything a door can do, your system can script. Start from the endpoint map in [API reference](#api-reference), the reference index in [docs/README.md](./docs/README.md), and the architecture-level component guide in [docs/components.md](./docs/components.md).

---

## Install

```
/plugin marketplace add langmartai/lm-assist
/plugin install lm-assist@langmartai
```

Then **open a new Claude Code session** and run `/assist-setup`.

Or directly from npm:

```bash
npm install -g lm-assist
```

All install paths — the plugin layers, installing from source, joining a fleet — are in [Build, release & deploy](#build-release--deploy).

> **Read:** [Inside Claude Code: The Session File Format and How to Inspect It](https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b) — technical breakdown of the JSONL session format, message types, subagent trees, and how lm-assist surfaces it all.

---

## Why lm-assist

The Claude products don't ship a unified dashboard: Claude Code lives in a terminal, claude.ai conversations in a browser tab, Cowork and cloud sessions in their own views, and the Agent SDK in your logs. lm-assist pulls them into one platform ([The Goal](#the-goal) above) so the visibility and control live wherever you are — including inside a Claude conversation.

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

## Functional documentation

The functional layer, in three groups: **everything Claude** (sessions, conversations, missions, memory), **extended capabilities** (beyond Claude, through the same MCP surface), and the **platform layer** (the plumbing that makes many machines one fleet). Everything in all three groups is reachable through the four doors — the **MCP connector** (the main door: from a claude.ai conversation, a Cowork session, or Claude Code itself), the **web dashboard** (watch and drive), the **Claude Code plugin** (terminal skills and commands), and the **REST API** (systems). One line per feature here; the details live behind the links at the end of each group.

> **Full-coverage registry:** [`docs/components.md`](./docs/components.md) — every component with its path, what it does, how it connects, and honest freshness (first built / last touched, including the aging and dormant ones this tour skips). This section is the guided tour; that file is the map.

### Everything Claude

Real-time observability and control for the whole Claude product line — Claude Code sessions (local, remote/CCR, and cloud), claude.ai conversations, Cowork, Agent SDK runs, memory and rules — cross-node and cross-session.

**Observe**

- Session list with live status and running-process detection; per-session and per-project cost tracking with per-model token breakdown
- 15 insight views per session: Chat, Thinking, Agents, Plans, Team, Files, Git, DAG (experiment-gated) & more; full subagent trees
- Real full-text search over your prompt history (bm25/FTS5, CJK-aware) — indexing your actual prompts, not injected boilerplate — plus vector search
- Live multi-session dashboard and process dashboard across machines; SSE event stream; statusline with context %, rate limits, cost
- Usage & limits: live rate-limit/quota windows (5h · 7d) and account status, from the API or from inside a Claude session

**Control**

- *Session* means all three kinds of Claude work: **local Claude Code sessions**, **remote/cloud code sessions (CCR)**, and **claude.ai conversations**
- Web terminal (ttyd) from any browser; drive a live session's prompt from the API or from Claude itself, with verified submit/delivery; session-to-session messaging between any two live sessions on any nodes
- Start, resume, and abort agent executions; SDK runner for headless programmatic runs (detached runs survive restarts)
- **CCR** — bridge a local Claude Code session to claude.ai/code and operate it from the claude.ai UI: read-only replay, one-way mirror, or full two-way drive behind a safety gate; start, drive, restart, and stop cloud code sessions
- **claude.ai conversations** — list, read, create, rename, fork, and measure tokens; plus **full-account conversation search and backup**: a local cache of every conversation, searchable and captured by the backup engine alongside the rest of your Claude estate (session history, memory, rules — with capture-time secret exclusion and search that never unpacks an archive)
- **Cowork** — create and drive Cowork tasks headlessly, with file attachments and a live transcript
- **Voice** — talk to a claude.ai conversation from the browser, with selectable voices
- Proxied Claude Code OAuth surface and claude.ai web-session surface — see [`docs/claude-code-routes.md`](./docs/claude-code-routes.md) and [`docs/claude-ai-routes.md`](./docs/claude-ai-routes.md)

**Automate**

- **Mission autopilot** — a mission graph with a fleet-elected controller (itself a Claude session) that spawns, watches, answers, and re-engages worker sessions across nodes; versioned workflow playbooks make the shapes repeatable and editable
- **Backlog graph** — a fleet-synced idea/issue graph (typed items, typed edges: `blocks` · `depends-on` · `parent-of`) that sessions file into and missions work from, with a visual canvas in the dashboard
- Scheduled jobs: one-time, recurring, or trigger-only, with full run capture; destructive built-ins ship disarmed until you arm them
- **Resilience** — sessions stalled on server/network errors auto-resume with capped backoff; a session that hits a model's usage limit is switched to a model with headroom (verified against the live status line) instead of idling through the window

**Memory & rules**

- **Cross-node memory** — record-level memory sync across the fleet: every project's and every machine's Claude memory, searchable and editable from one surface (or from inside any Claude session), with three-way merge on conflicts and home nodes staying canonical
- Rules auto-converge fleet-wide with per-OS scoping — write a user rule once, every machine picks it up
- Optional and off by default: the memory-harvest proposals daemon and the knowledge generation pipeline (session-to-knowledge extraction) — opt-in features, not core behavior

**Dashboards & UI panes**

The Next.js dashboard ships in the package: sessions browser, session detail with all insight views, live terminal, missions, memory & rules, CCR remote, Cowork chat, scheduler, MCP tool registry, settings.

<a href="https://langmart.ai/images/assist/session-browser.png"><img src="https://langmart.ai/images/assist/session-browser.png" alt="Session Browser" width="700"></a>

- **UI panes** — every dashboard is also a standalone page with its own gateway URL, so a Claude session can *show you UI* instead of describing it: ask for the mission graph in a claude.ai chat and get a live link ([example](./examples/ui-panes/)); a gallery of ~20 shipped panes (sessions, search, missions, backlog, memory, and more) runs under per-page API grants and platform SSO

*Freshness note:* a few of the earliest views — the tasks kanban, projects listing, skills analytics, and the older search page — still work but have not moved since early 2026; [`docs/components.md`](./docs/components.md) carries the per-component freshness.

**Go deeper:** [feature guides](./docs/README.md#feature-guides) · [API reference](./docs/README.md#api-reference) · [`docs/mission-control.md`](./docs/mission-control.md) · [`docs/claude-ai.md`](./docs/claude-ai.md) · [`docs/session-messaging.md`](./docs/session-messaging.md) · [`docs/memory-reads.md`](./docs/memory-reads.md) · [`docs/backlog-registry.md`](./docs/backlog-registry.md) · [`docs/ui-panes-deploy.md`](./docs/ui-panes-deploy.md) · [`docs/voice.md`](./docs/voice.md) · [`docs/terminal-api.md`](./docs/terminal-api.md) · [`docs/claude-code-session-internals.md`](./docs/claude-code-session-internals.md) — examples: [mission autopilot](./examples/mission-autopilot/) · [backlog tracking](./examples/backlog-tracking/) · [conversation search](./examples/claudeai-conversation-search/) · [cross-node memory](./examples/cross-node-memory/) · [UI panes](./examples/ui-panes/)

### Extended capabilities

Beyond Claude, through the same MCP surface — every tool routes to the node that actually holds the signed-in browser, hypervisor, or daemon, so a claude.ai conversation can read your mail on one machine and manage a VM on another.

- **Service connectors** driving the operator's own logged-in browser via CDP: **Gmail** (read, search, triage, compose/send with double-send guardrails and Sent-folder verification), **LinkedIn** (messaging, feed, posting, people search — no personal API exists, so a real browser does the work), and **WhatsApp** (hub-backed messaging with durable history)
- **GitHub** — multi-backend (REST API, `gh` CLI, git), multi-account action service; tokens are resolved internally and never logged or returned
- **VM management** (Hyper-V/KVM) with strict input validation as the security boundary, plus a Windows elevated-exec worker that avoids per-command UAC prompts; **container management** (Docker) with managed-label gates so fleet services can't be stopped by accident; **desktop automation** (screenshot, input, OCR, window control) on X11 and Win32
- **Generic data service** — a shared multi-backend data layer (cache / vector / sql datasets) with access keys, secret redaction, and cross-node sync; the store the backlog, missions, and fleet registries ride on
- **File transfer & remote filesystem** — cross-node push with per-file sha256 verification and resume, a durable job manager, a rate-adaptive UDP fast path, and capped remote FS inspection
- **MCP plugin system** — third-party plugins expose tools as `ext__<plugin>__<tool>` ([contract](./docs/mcp-plugin-contract.md)); first-party plugins ship bundled in the package, seeded and trusted on boot with checksum-pinned payloads; per-tool governance (enable/disable, description overrides) from the dashboard

**Go deeper:** [service connectors](./docs/README.md#service-connectors) · [MCP & plugins](./docs/README.md#mcp--plugins) · [`docs/gmail-connector.md`](./docs/gmail-connector.md) · [`docs/linkedin-connector.md`](./docs/linkedin-connector.md) · [`docs/whatsapp-connector.md`](./docs/whatsapp-connector.md) · [`docs/vm-management.md`](./docs/vm-management.md) · [`docs/container-management.md`](./docs/container-management.md) · [`docs/github-routes.md`](./docs/github-routes.md) — examples: [Gmail](./examples/gmail-connector/) · [WhatsApp](./examples/whatsapp-connector/) · [LinkedIn](./examples/linkedin-connector/) · [transfer & backup](./examples/transfer-and-backup/)

### Platform layer

The internal plumbing every feature above rides on — you mostly don't interact with it directly, but it is why everything is cross-node.

- **Hub client** — each node's single outbound WebSocket to the optional LangMart Hub: registration, API relay, binary console relay for remote terminals, and one-time enrollment; no inbound ports on any node
- One-time keypack enrollment for fresh nodes ([how to join](#build-release--deploy)); node clusters, selection profiles, placement ranking, and per-node build/upgrade tracking
- **Hybrid node-to-node transport** — an always-present relay floor over the hub, a NAT-traversing direct UDP path that promotes when both directions confirm, and kernel-TCP LAN upgrades; a peer-RPC fabric and a durable event bus on top; node-to-node port forwarding
- Local API auth: a rotating token ring with a grace window plus narrow revocable scoped tokens; web access via platform SSO/OIDC
- Service lifecycle: the `lm-assist` CLI (serve/start/stop/upgrade), an internal job scheduler replacing OS cron, an LMDB session cache as the zero-warmup read backbone, and an opt-in HTTPS terminator (`LM_HTTPS=1`) so the browser microphone works off-localhost

**Go deeper:** [architecture & internals](./docs/README.md#architecture--internals) · [`docs/architecture.md`](./docs/architecture.md) · [`docs/hub-client.md`](./docs/hub-client.md) · [`docs/cross-node-transport-map.md`](./docs/cross-node-transport-map.md) · [`docs/node-placement.md`](./docs/node-placement.md) · [`docs/web-deployment-and-hub-auth.md`](./docs/web-deployment-and-hub-auth.md) · [`docs/install-and-modes.md`](./docs/install-and-modes.md)

### Examples

Per-use-case walkthroughs with screenshots from a live deployment, in [`examples/`](./examples/):
[MCP connector install](./examples/mcp-connector-install/) ·
[claude.ai browser auth + automatic connector upkeep](./examples/claudeai-browser-auth/) ·
[full claude.ai conversation search](./examples/claudeai-conversation-search/) ·
[UI panes](./examples/ui-panes/) ·
[cross-node memory](./examples/cross-node-memory/) ·
[backlog tracking](./examples/backlog-tracking/) ·
[mission autopilot](./examples/mission-autopilot/) ·
[transfer & backup](./examples/transfer-and-backup/) ·
[build your own MCP plugin (advanced)](./examples/build-your-own-mcp-plugin/) ·
[Gmail](./examples/gmail-connector/) · [WhatsApp](./examples/whatsapp-connector/) · [LinkedIn](./examples/linkedin-connector/)

| | |
|---|---|
| <a href="./examples/ui-panes/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/ui-panes/ui-pane-mission-graph-masked.png" alt="Mission graph pane on its own URL"></a><br><sub>**UI panes** — ask for the mission graph in chat, get a live dashboard URL</sub> | <a href="./examples/gmail-connector/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/gmail-connector/gmail-inbox-masked.png" alt="Gmail through the connector, content masked"></a><br><sub>**Gmail connector** — your own logged-in browser, driven over CDP (content masked)</sub> |
| <a href="./examples/whatsapp-connector/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/whatsapp-connector/whatsapp-masked.png" alt="WhatsApp Web through the connector, content masked"></a><br><sub>**WhatsApp connector** — Meta Cloud API on main; the personal WhatsApp Web provider (open PR) shown here (content masked)</sub> | <a href="./examples/linkedin-connector/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/linkedin-connector/linkedin-feed-masked.png" alt="LinkedIn feed through the connector, content masked"></a><br><sub>**LinkedIn connector** — no personal API exists, so a real browser does the work (content masked)</sub> |
| <a href="./examples/mcp-connector-install/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/mcp-connector-install/claudeai-bootstrap-masked.png" alt="A real claude.ai conversation bootstrapping lm-assist and listing sessions across three machines"></a><br><sub>**The main door in action** — a claude.ai conversation bootstraps lm-assist and reaches sessions on all three machines</sub> | <a href="./examples/cross-node-memory/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/cross-node-memory/memory-page-masked.png" alt="Memory page across all projects, content masked"></a><br><sub>**Cross-node memory** — every project's and every machine's Claude memory, one surface</sub> |
| <a href="./examples/build-your-own-mcp-plugin/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/build-your-own-mcp-plugin/claudeai-e2e-masked.png" alt="A claude.ai conversation reconnecting the connector, setting permissions, and calling a freshly built plugin tool"></a><br><sub>**Build your own MCP plugin** — from a claude.ai chat: agent builds it on the node, owner enables it, Claude reconnects, sets permissions, and calls it end to end</sub> | <a href="./examples/mcp-connector-install/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/mcp-connector-install/claude-app-connectors.png" alt="Claude desktop app — Settings → Connectors showing lm-assist langmart"></a><br><sub>**The connector, installed for you** — Settings → Connectors in the Claude app after the hub connect</sub> |
| <a href="./examples/mission-autopilot/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/mission-autopilot/missions-page-masked.png" alt="Missions page with the controller conversation, content masked"></a><br><sub>**Mission autopilot** — a fleet-elected controller drives worker sessions; auto-resume + model-limit fallback underneath</sub> | <a href="./examples/backlog-tracking/"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/examples/backlog-tracking/backlog-page-masked.png" alt="Backlog graph with typed edges, content masked"></a><br><sub>**Backlog** — a fleet-synced issue/idea graph sessions and missions both work from</sub> |

---

## Technical architecture & build

### Architecture

<a href="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-observability.svg"><img src="https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/architecture-observability.svg" alt="lm-assist architecture" width="700"></a>

One Core, four doors. The **Core API** (`core/`) is a raw Node.js HTTP server — no framework runtime — with modular routes, an LMDB-backed session cache doing incremental JSONL parsing with file watching, a Claude Agent SDK runner for headless execution, and a hub client that holds an outbound WebSocket to the optional LangMart Hub for cross-node relay; its REST surface is the systems door. The **Web UI** (`web/`) is Next.js 16 (React 19, Zustand, Tailwind v4) talking to the Core API. The **MCP server** exposes the same Core over 280+ scope-gated tools to any Claude session, and the **Claude Code plugin** (skills, commands, hooks, statusline) is the terminal door onto the same API. There is no external database: everything is derived from the files Claude Code already writes to disk, plus live process state.

lm-assist reads the same JSONL session files regardless of how they were created:

| Source | What It Produces | lm-assist Coverage |
|--------|-----------------|-------------------|
| **Claude Code CLI** | Interactive sessions with subagents, teams, worktrees | Full parsing — all message types, tool calls, metadata |
| **Agent SDK** (Python/TypeScript) | Programmatic agent executions | Same JSONL format — full session inspection |
| **Headless mode** (`claude -p`) | Background/CI runs | Detected via process status store |
| **Running processes** | Live PID, tmux, terminal state | Real-time monitoring with zero polling overhead |

Deep dives:

- [`docs/architecture.md`](./docs/architecture.md) — the Core/Web split, key components, shared route and response types
- [`docs/how-it-works.md`](./docs/how-it-works.md) — how Core, Web UI, MCP server, hooks, and statusline fit together end to end
- [`docs/claude-code-session-internals.md`](./docs/claude-code-session-internals.md) — the Claude Code JSONL session format itself: message types, subagent trees, thinking blocks, token accounting
- [`docs/cross-node-transport-map.md`](./docs/cross-node-transport-map.md) — every path bytes take between nodes: hub relay, direct peer fabric, the file-transfer job manager, and the sync layers on top

### API reference

860+ REST endpoints across the Core API. The broad map:

| Category | Highlights |
|----------|-----------|
| **Sessions & search** | List, detail, delta fetch, conversation, subagents, DAG, forks; bm25 + vector search |
| **Monitor & control** | Running executions, abort, SSE stream, agent execute/resume, terminal driving |
| **Missions & scheduler** | Mission graph, controller, workflows, scheduled jobs |
| **Fleet** | Nodes, clusters, enrollment, builds/upgrades, transfers, port-forwards, data service |
| **Memory & rules** | Cross-host memory, rule sync, knowledge (optional, off by default) |
| **Integrations** | Claude Code OAuth proxy, claude.ai web-session proxy, GitHub, connectors (Gmail/LinkedIn/WhatsApp), VM, container, desktop, voice |

All session endpoints support `ifModifiedSince` for efficient polling, and three indexing dimensions: `lineIndex` (JSONL position), `turnIndex` (conversation turn), and `userPromptIndex` (user message count). Full reference: [`docs/api-endpoints.md`](./docs/api-endpoints.md).

**Route conventions.** Routes live in `core/src/routes/core/` — one file per domain (`sessions`, `missions`, `gmail`, `vm`, …), each exporting a `create*Routes(ctx: RouteContext)` function that returns `{ method, pattern, handler }` objects matched by regex and registered in `core/src/routes/core/index.ts`:

```typescript
export function createMyRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/my-endpoint$/,
      handler: async (req, api) => {
        const start = Date.now();
        // ... logic ...
        return wrapResponse(data, start);
      },
    },
  ];
}
```

### Build, release & deploy

Full build → pack → install → upgrade → deploy reference: [`docs/build-pack-install-upgrade.md`](./docs/build-pack-install-upgrade.md).

#### Install

The quick start is [at the top of this README](#install). What `npm install -g lm-assist` does underneath: the postinstall script starts the services, installs the statusline, and installs the [Claude Code Multisession](https://github.com/langmartai/claude-code-multisession) plugin — **open a new Claude Code session** and type `/sessions` to verify.

The plugin marketplace (added with the quick start's `/plugin marketplace add langmartai/lm-assist`) hosts three plugins that layer on the npm foundation:

| Install command | Layer | What you get |
|----------------|-------|-------------|
| `npm install -g lm-assist` | Foundation | Core API (:3100), web dashboard (:3848), MCP server, statusline |
| `/plugin install lm-assist@langmartai` | Setup & diagnostics | `/assist` (open the web UI) · `/assist-setup` `/assist-status` `/assist-search` `/assist-logs` |
| `/plugin install claude-code-multisession@langmartai` | Skills | observe + route skills, `/projects` `/sessions` `/summary` `/run` |
| `/plugin install claude-code-webui@langmartai` | Web access | dashboard skill, `/web` `/web-sessions` `/web-tasks` |

**lm-assist** is the foundation — the API server, MCP server, and web dashboard that power everything. The plugins add skills and commands on top: the **observe** skill activates on questions like "what's running and what has it cost?", the **route** skill detects when a prompt belongs to another project and recommends stay / resume / queue / new — and both learn from your usage over time (session summaries, prompt queue, routing signals).

From source:

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install --ignore-scripts && npm run build
./core.sh start
```

To join a fleet:

```bash
lm-assist login --new-node     # on an enrolled node: mint a one-time keypack
lm-assist login <lmkp_…>       # on the fresh node: redeem it
```

#### Services

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

Development builds are managed by `./core.sh` instead (`start` · `stop` · `restart` · `status` · `build` · `pack` · `test` · `logs`) — it auto-builds when the TypeScript is out of date and packs prebuilt prod tarballs for deploys.

#### Tests

The Core carries a `node --test` suite of 500+ test files under `core/src/**/__tests__/`:

```bash
cd core && npm test    # compiles the test tsconfig, then runs the full suite
```

#### Releasing

A release bumps the version in **three files, kept in sync**: `package.json` (npm), `.claude-plugin/plugin.json` (plugin cache), and `.claude-plugin/marketplace.json` (marketplace listing). Then `npm publish`. The in-product upgrade path (`lm-assist upgrade`, or Settings → "Check for Updates" in the web UI) installs the latest published version and restarts services; upgrade logs land in `~/.cache/lm-assist/upgrade.log`.

### Ports & modes

Dev (repo checkout) and prod (npm package) run in **separate port spaces**, so you can hack on lm-assist while the production instance keeps watching your sessions:

| Mode | Core API | Web UI | Managed by |
|------|----------|--------|------------|
| **Prod** | 3100 | 3848 | `lm-assist start/stop` (npm package) |
| **Dev** | 3200 | 3948 | `./core.sh start/stop` (repo) |

Each component detects its mode its own way: core TypeScript checks `__dirname.includes('node_modules')`, hooks/MCP/statusline read `devModeEnabled` from `~/.claude-code-config.json`, and the Web UI gets its API port via `NEXT_PUBLIC_LOCAL_API_PORT` at build and launch time. Never hardcode a port. Details and mode-selection gotchas: [`docs/install-and-modes.md`](./docs/install-and-modes.md).

### Configuration

No API key needed — lm-assist works entirely with your local Claude Code session data. Optionally copy `.env.example` to `.env`:

```bash
API_PORT=3100                    # Core API port (default: 3100)
WEB_PORT=3848                    # Web UI port (default: 3848)
TIER_AGENT_HUB_URL=wss://...     # Optional hub gateway WebSocket URL
TIER_AGENT_API_KEY=sk-...        # Optional hub API key
```

### Security model

Everything that can act on your machines is gated, and the gates are documented:

- **Scope-gated MCP tools** — every tool declares scopes; per-tool description overrides and on/off switches live in a fleet-synced registry, and connector tool access is adjustable from inside a session. See [`docs/mcp-surfaces.md`](./docs/mcp-surfaces.md).
- **Per-page grants for UI panes** — the hub relay reaches authenticated node routes as the owner, so each published pane runs under an explicit allowlist of API routes plus platform SSO. Grants are the security boundary, not the UI. See [`docs/ui-panes-deploy.md`](./docs/ui-panes-deploy.md).
- **Charset boundaries for elevated execution** — VM management commands that reach a privileged shell pass through strict input-charset validation; those regexes *are* the security boundary. See [`docs/vm-management.md`](./docs/vm-management.md).
- **Container guardrails** — bind mounts are refused until a node explicitly declares `volumeRoots`, and lifecycle operations are gated on a managed-by-lm-assist label so real services can't be stopped by accident. See [`docs/container-management.md`](./docs/container-management.md).
- **Checksum-pinned bundled plugins** — first-party plugin payloads ship inside the package and are verified byte-for-byte on boot; provenance is recorded as a checksum, never as an upstream identity. Trust rules and disclosure policy: [`docs/mcp-plugins-bundled.md`](./docs/mcp-plugins-bundled.md).
- **Fleet enrollment** — fresh nodes join only by redeeming a one-time keypack minted on an already-enrolled node.

### Platform support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | Full | All features including web terminal |
| macOS | Full | All features including web terminal |
| Windows | Full core | Sessions, MCP, desktop automation, VM/container; no ttyd web terminal |
| Mobile / Tablet | Web UI | Monitor, debug, and control from any device on your network |

---

## Related

- [claude-code-multisession](https://github.com/langmartai/claude-code-multisession) — Skills plugin: cross-project session routing, `/projects`, `/sessions`, `/summary`, `/run`
- [claude-code-webui](https://github.com/langmartai/claude-code-webui) — Web dashboard plugin: insight tabs, web terminal, `/web`, `/web-sessions`, `/web-tasks`
- [Knowledge system](https://databunny.medium.com/your-claude-sessions-are-gold-stop-paying-twice-for-the-same-knowledge-7632ac6ddb88) — Optional: auto-extract knowledge from sessions, MCP tools, context injection. Off by default.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) — the 0.2 line (the first npm publish since 0.1.70) consolidates roughly 1,700 commits of features.

## Requirements

- Node.js >= 20.9
- Claude Code (for slash commands and MCP integration)

## License

[AGPL-3.0-or-later](LICENSE)
