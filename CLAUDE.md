# lm-assist

Monorepo for the LM Assistant — a web UI for managing Claude Code sessions, with a backend API for session management, knowledge, and hub connectivity.

## Structure

```
lm-assist/
├── core/                    ← Backend API (TypeScript, dev :3200 / prod :3100)
│   ├── src/
│   │   ├── api/             ← API helper implementations (sessions, agent, tasks)
│   │   ├── checkpoint/      ← Git checkpoint management
│   │   ├── hub-client/      ← Hub WebSocket client (relay, sync)
│   │   ├── knowledge/       ← Knowledge generation pipeline
│   │   ├── mcp-server/      ← MCP server + tools (search, detail, feedback)
│   │   ├── routes/core/     ← Route files and endpoints
│   │   ├── search/          ← BM25 + text scoring
│   │   ├── types/           ← Shared TypeScript types
│   │   ├── utils/           ← Git, JSONL, path utilities
│   │   └── vector/          ← Embeddings + Vectra vector store
│   ├── hooks/               ← Hook scripts (statusline, context-inject)
│   ├── scripts/             ← tmux-autostart.sh
│   ├── package.json
│   └── tsconfig.json
├── web/                     ← Web UI (Next.js 16, dev :3948 / prod :3848)
│   ├── src/
│   │   ├── app/             ← Next.js App Router pages
│   │   ├── components/      ← React components
│   │   ├── contexts/        ← React contexts
│   │   ├── hooks/           ← Custom React hooks
│   │   ├── lib/             ← API clients, utilities
│   │   └── stores/          ← Zustand stores
│   ├── package.json
│   └── next.config.ts
├── core.sh                  ← Service manager (start/stop/restart/status)
├── package.json             ← Workspace root
├── .env.example
└── CLAUDE.md
```

## Commands

```bash
./core.sh              # Interactive menu
./core.sh start        # Start API + Web (auto-builds if needed)
./core.sh stop         # Stop all services
./core.sh restart      # Restart all services
./core.sh status       # Show service status + health check
./core.sh build        # Compile TypeScript (core)
./core.sh clean        # Clean and rebuild
./core.sh test         # Test API endpoints
./core.sh hub start    # Connect Hub Client
./core.sh hub stop     # Disconnect Hub Client
./core.sh hub status   # Hub connection info
./core.sh logs [core|web]  # View logs
```

**IMPORTANT: Always use `./core.sh` to manage services. Do not use direct npm/node commands.**

After modifying TypeScript in `core/src/`, rebuild with `./core.sh build` (or `./core.sh restart` which auto-builds if outdated).

## Dev/Prod Port Separation

Dev (repo) and prod (npm package) use **separate port spaces** so both can run simultaneously:

| Mode | Core API | Web UI | Managed by |
|------|----------|--------|------------|
| **Dev** | 3200 | 3948 | `./core.sh start/stop` (this repo) |
| **Prod** | 3100 | 3848 | `lm-assist start/stop` (npm package) |

**Use `./core.sh` for development** — build, start, test, and iterate on this repo. Use `lm-assist` CLI for managing the prod npm-installed version. Never use `lm-assist` to manage dev services or `./core.sh` to manage prod.

`./core.sh status` shows both environments side-by-side.

**Port detection methods by component:**
- `core.sh` — hardcoded dev defaults (3200/3948)
- TypeScript (cli.ts, service-manager, rest-server, hub-client, etc.) — `__dirname.includes('node_modules')` → prod (3100), else dev (3200)
- Hook + MCP + Statusline — reads `devModeEnabled` from `~/.claude-code-config.json`; when `devModeEnabled=true`, these components talk to the dev API (:3200) instead of prod (:3100)
- Web UI SSR — `NEXT_PUBLIC_LOCAL_API_PORT` env var (set by core.sh at build + start time)
- Web UI client — `NEXT_PUBLIC_LOCAL_API_PORT` baked in at `next build` time, plus `window.location.port` for self-referencing URLs

**When adding new port references:** never hardcode `3100` or `3848`. Use the appropriate detection method for the component type. For core TypeScript, use the `__dirname.includes('node_modules')` pattern.

### Testing After Code Changes

After modifying and rebuilding (`./core.sh build`), restart **dev** services:
```bash
./core.sh restart          # Restarts on dev ports 3200/3948
./core.sh status           # Verify both dev and prod status
```

Test the dev API: `curl http://localhost:3200/health`
Test the dev web: open `http://localhost:3948`

**Prod stays untouched** — `./core.sh restart` only affects dev ports. To test prod, use `lm-assist restart`.

### Browser Testing (Remote / MCP)

The browser automation MCP (Claude in Chrome) may run on a **different machine** than the dev server. When testing the web UI via browser:

1. Get this machine's IP: `hostname -I | awk '{print $1}'`
2. Use the IP (not `localhost`) in browser URLs: `http://<IP>:3948`
3. The core API also binds to `0.0.0.0`, so `http://<IP>:3200/health` works for remote testing
4. When navigating in browser automation tools, always use the IP-based URL for cross-machine access

## Architecture

### Core API (`core/`)

The backend is a raw Node.js HTTP server (no Express/Hono runtime — Hono is a dependency but the server uses `http.createServer` directly). Routes are modular: each `*.routes.ts` file exports an array of `{ method, pattern, handler }` objects matched via regex.

**Key components:**
- `rest-server.ts` — HTTP server, SSE streaming, CORS, WebSocket upgrade for ttyd, route registration
- `control-api.ts` — Central API facade with sub-APIs: `monitor`, `sessions`, `agent`, `claudeTasks`
- `session-cache.ts` — LMDB-backed session cache with incremental JSONL parsing and file watching
- `sdk-runner.ts` — Claude Agent SDK runner for programmatic session execution
- `session-dag.ts` — Message DAG and cross-session DAG builder
- `hub-client/` — WebSocket client connecting to LangMart Hub for remote API relay

**Data sources (read from disk, not a database):**
- Claude Code sessions: `~/.claude/projects/*/sessions/*.jsonl`
- Claude Code tasks: `~/.claude/tasks/`
- Team configs: `~/.claude/teams/`

### Auto-resume stalled sessions (server errors)
A `scheduled-jobs` handler `stall-monitor` (5 min, on by default) resumes sessions stalled on SERVER errors (529/5xx/server-rate-limit — NEVER user usage-limits or auth) by sending `continue`, capped-backoff then flagged. Local sessions are handled per-node; remote cloud CCRs only by the single auto-elected monitor (lowest online gateway-id from the hub `/machines` list). Toggles in project-settings: `autoResumeStalledEnabled` (default true), `autoResumeIntervalMin`, `autoResumeMaxAttempts`, `autoResumeRemoteScan`. Status: `GET /monitor/stalls` / MCP `stall_status`. Run on demand: `POST /scheduler/jobs/stall-monitor/run`.

### Web UI (`web/`)

Next.js 16 with Turbopack, React 19, Zustand for state, Tailwind CSS v4 for styling. Renders sessions, terminals, tasks, knowledge, and settings pages. Communicates with the core API (dev :3200 / prod :3100).

**Deployment + hub auth state:** see [`docs/web-deployment-and-hub-auth.md`](docs/web-deployment-and-hub-auth.md) — one build serves prod (3848→3100→langmart) and dev (3948→3200→xeenhub) but ONLY if `LM_LOCAL_API_PORT` is set at launch (else dev silently hits the prod core); plus how the nav + settings must `refreshHubConnection()` after logout and why account switch clears the gateway-id.

### MCP Server (`core/src/mcp-server/`)

Provides 3 tools via stdio transport (server name: `lm-assist`):

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge and file history |
| `detail` | Progressive disclosure for any item by ID (K001, sessionId:index) |
| `feedback` | Quality feedback on context sources (outdated, wrong, useful, etc.) |

**Two MCP surfaces — both come up with Core, neither is a separate process or port:**

1. **stdio** (table above) — `core/src/mcp-server/index.ts`, server name `lm-assist`, loaded by a **local** Claude Code session through the plugin; it is an HTTP client to Core's `/mcp/search|detail|feedback` shims (`mcp-api.routes.ts`).
2. **HTTP `/mcp`** — the Model Context Protocol StreamableHTTP endpoint served by **Core itself** at `POST/GET/DELETE /mcp` (`core/src/rest-server.ts` → `core/src/routes/core/mcp.routes.ts`). This is the surface reached **remotely through the hub** (the `mcp__claude_ai_lm-assist_langmart__*` connector tools).

**How the remote MCP reaches Core (no extra process/port — it rides the outbound hub WebSocket):**

```
Claude Code / claude.ai connector
  -> mcp.langmart.ai                      (public MCP endpoint, OAuth)
  -> LangMart hub  (assist-api.langmart.ai)
  -> api_relay message over the worker WebSocket   (the same HubClient connection Core dialed out)
  -> Core HubClient -> ApiRelayHandler    (core/src/hub-client/api-relay-handler.ts; /mcp is on its allow-list)
  -> localhost:3100/mcp                   (mcp.routes.ts) -> response relayed back up
```

So the remote MCP is live as soon as **(a) Core is started** (prod via `lm-assist start` — the `/mcp` route binds with Core, there is no separate MCP daemon) **and (b) the HubClient is authenticated** to `assist-api.langmart.ai` (auto-connects on Core start when `~/.lm-assist/hub.json` has `hubUrl` + `apiKey`; `register -> register_ack -> auth_confirmed`). The hub **pushes** requests down the existing outbound socket — nothing listens on a separate inbound MCP port. If Core is down (e.g. the chokidar crash above) the relay has nowhere to land and the connector errors with "MCP down", even though `mcp.langmart.ai` and the hub are healthy.

## Key API Endpoints

### Health & Status
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Server status (uptime, project path) |

### Sessions (27 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sessions` | List Claude Code sessions |
| GET | `/sessions/:id` | Get full session data |
| GET | `/sessions/:id/conversation` | Get session conversation |
| GET | `/sessions/:id/from/:lineIndex` | Delta fetch — messages from JSONL line position |
| GET | `/sessions/:id/has-update` | Lightweight poll — check if session changed |
| GET | `/sessions/:id/exists` | Check if session file exists |
| GET | `/sessions/:id/messages/last/:count` | Last N messages (shorthand) |
| GET | `/sessions/:id/compact-messages` | Continuation/compaction messages |
| GET | `/sessions/:id/subagents` | All subagents spawned by session |
| GET | `/sessions/:id/subagents/:agentId` | Specific subagent session |
| GET | `/sessions/:id/forks` | Sessions forked from this one |
| GET | `/sessions/:id/related` | All related sessions (parents, forks, subagents, siblings) |
| GET | `/sessions/:id/dag` | Message DAG with branch info |
| GET | `/sessions/:id/session-dag` | Cross-session DAG (subagents, teams) |
| GET,POST | `/sessions/batch-check` | Check multiple sessions for updates in one request |
| POST | `/session-cache/warm` | Pre-load sessions into memory cache |
| POST | `/session-cache/clear` | Clear cache (specific session or all) |
| GET | `/monitor/executions` | Currently running executions with live status |
| GET | `/monitor/summary` | Aggregated execution counts by status/tier |
| POST | `/monitor/abort/:executionId` | Abort a specific execution |

### Querying Session Execution History

Sessions are stored as JSONL files in `~/.claude/projects/*/sessions/*.jsonl`. Each line is a message. The API provides three indexing dimensions for slicing into a session:

| Index | Type | Description |
|-------|------|-------------|
| `lineIndex` | 0-based | Raw JSONL line position in the file |
| `turnIndex` | 1-based | Conversation turn number (each user msg and each assistant msg is a turn) |
| `userPromptIndex` | 0-based | Sequential count of user messages only |

#### Common query patterns

**Get full session with all data:**
```
GET /sessions/:id?unlimited=true
```

**Get a specific user interaction (e.g., the 5th user prompt and its response):**
```
GET /sessions/:id?fromUserPromptIndex=4&toUserPromptIndex=4
```

**Get everything from turn 10 onwards:**
```
GET /sessions/:id?fromTurnIndex=10&unlimited=true
```

**Delta fetch — get only new messages since last poll:**
```
GET /sessions/:id/from/1523?limit=100
```
Use `fromLineIndex` alone (no other filters) for fast incremental updates via raw message cache.

**Conditional request — skip re-parse if unchanged:**
```
GET /sessions/:id?ifModifiedSince=2026-03-10T12:00:00Z
```
Returns `notModified: true` if the session hasn't changed since the timestamp.

**Formatted conversation (for display):**
```
GET /sessions/:id/conversation?toolDetail=summary&lastN=20
```
Query params: `lastN`, `beforeLine` (pagination), `toolDetail` (`none`|`summary`|`full`), `includeSystemPrompt`, `fromTurnIndex`/`toTurnIndex`.

**Batch check many sessions at once:**
```
POST /sessions/batch-check
Body: { "sessions": [{ "sessionId": "abc", "knownFileSize": 12345 }] }
```
Returns which sessions have changed, avoiding per-session polling.

**Monitor live executions:**
```
GET /monitor/executions
```
Returns `executionId`, `sessionId`, `status`, `isRunning`, `turnCount`, `costUsd`, `elapsedMs`.

**SSE stream for real-time updates:**
```
GET /stream?executionId=abc123
```
Server-sent events with `execution_update` events. Omit `executionId` for all events.

#### Key response fields from `GET /sessions/:id`

- **Metadata:** `sessionId`, `cwd`, `model`, `claudeCodeVersion`, `permissionMode`, `tools[]`, `mcpServers[]`
- **Execution:** `numTurns`, `durationMs`, `totalCostUsd`, `usage`, `modelUsage`, `isActive`, `status` (`running`|`completed`|`error`|`interrupted`|`idle`|`stale`)
- **Messages:** `userPrompts[]`, `toolUses[]`, `responses[]`, `thinkingBlocks[]`, `systemPrompt`
- **Operations:** `fileChanges[]`, `gitOperations[]`, `fileSummary`
- **Organization:** `todos[]`, `tasks[]`, `plans[]`, `subagents[]`
- **Team:** `teamName`, `allTeams[]`, `teamOperations[]`, `teamMessages[]`
- **Pagination:** `totalUserPrompts`, `totalTurns`, `lastLineIndex`, `lastTurnIndex`, `hasMore`
- **Fork tracking:** `forkedFromSessionId`

#### Additional query params for `GET /sessions/:id`

| Param | Default | Description |
|-------|---------|-------------|
| `cwd` | default project | Project directory to search in |
| `includeRawMessages` | false | Include raw JSONL lines |
| `includeReads` | false | Include read-only file operations |
| `fromLineIndex` / `toLineIndex` | — | Filter by JSONL line range |
| `fromTurnIndex` / `toTurnIndex` | — | Filter by turn range |
| `fromUserPromptIndex` / `toUserPromptIndex` | — | Filter by user prompt range |
| `lastNUserPrompts` | 50 | Last N user prompts (default limit) |
| `unlimited` | false | Return all data (no 50-message default limit) |
| `ifModifiedSince` | — | ISO timestamp for conditional requests |

### Projects (12 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects` | List all projects |
| GET | `/projects/:path/sessions` | Sessions for a project |
| GET | `/projects/:path/tasks` | Tasks with session mapping |

### Tasks (10 + 12 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tasks` | List task lists |
| GET | `/tasks/:listId` | Get tasks in a list |
| GET | `/task-store/tasks` | Aggregated tasks across sessions |
| GET | `/task-store/tasks/ready` | Ready (unblocked) tasks |

### Knowledge (21 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/knowledge` | List knowledge entries |
| GET | `/knowledge/search` | Search knowledge (BM25 + vector) |
| POST | `/knowledge/generate` | Generate knowledge from sessions |

### Web Terminal (13 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ttyd/start` | Start ttyd for a session |
| POST | `/ttyd/stop` | Stop ttyd server |
| GET | `/ttyd/status` | Get ttyd status |
| GET | `/ttyd/processes` | List session processes |

### Hub Client (6 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hub/status` | Connection status |
| POST | `/hub/connect` | Connect to Hub |
| POST | `/hub/disconnect` | Disconnect from Hub |
| PUT | `/hub/config` | Update Hub config (persists to .env) |

### Claude Code OAuth (14 endpoints)

**Full guide:** [`docs/claude-code-routes.md`](./docs/claude-code-routes.md).

Proxies `api.anthropic.com` endpoints that use Claude Code's OAuth token (from `~/.claude/.credentials.json`). Outbound headers match the real `claude-code/<version>` fingerprint observed in lm-proxy captures, with the appropriate `anthropic-beta` value per endpoint (source-verified against the leaked Claude Code source).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/claude-code/oauth-status` | Token presence + expiry (no secrets) |
| GET | `/claude-code/usage` | Live `Utilization` payload (rate-limit windows) |
| GET | `/claude-code/profile` | Account / org / application info |
| GET | `/claude-code/roles` | Org + workspace role for current OAuth (no beta header) |
| GET | `/claude-code/account-settings` | OAuth account settings (onboarding flags, dismissed banners) |
| GET | `/claude-code/cli-bootstrap?entrypoint=&model=` | Full CLI bootstrap config (account/org/model bundle) |
| GET | `/claude-code/grove` | Extended-thinking grove config |
| GET | `/claude-code/penguin` | Fast-mode config |
| GET | `/claude-code/policy-limits` | Org-level usage caps + compliance taints |
| GET | `/claude-code/settings` | Remote-managed Claude Code settings |
| GET | `/claude-code/user-settings` | User state with checksum |
| GET | `/claude-code/team-memory?repo=owner/repo[&view=hashes]` | Team-scoped memory |
| GET | `/claude-code/mcp-servers` | Anthropic-managed MCP servers (`anthropic-beta: mcp-servers-2025-12-04`) |
| GET | `/claude-code/mcp-registry` | Public MCP marketplace catalog (no auth) |

### claude.ai Web Integration (15 endpoints)

**lm-assist can introspect and operate on the user's claude.ai web account** — list conversations, read full message trees, list projects, read memory and artifacts, AND send new messages to existing conversations. Two parallel families:

| Path | Auth | Best for |
|---|---|---|
| `/claude-ai/...` | `~/.claude/claudeai-session.json` (cookie file) | Headless callers (cron, dashboards, scheduled jobs) |
| `/claude-ai/via-chrome/...` | Real Chrome via MCP | Interactive agents driven by Claude Code with Chrome MCP loaded |

**ALWAYS pre-flight with the health check** before driving these routes. Both families share a stable `reason` vocabulary (`ok`, `session_not_configured`, `session_expired`, `cloudflare_blocked`, `wrong_tab`, `not_logged_in`, `network_error`, `upstream_error`).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/claude-ai/healthz` | One-glance verdict (file status + live `/api/account_profile` probe) |
| GET | `/claude-ai/session-status[?probe=true]` | File status; optional active probe |
| POST | `/claude-ai/via-chrome/health-check` | Snippet the agent runs in a tab to verify it's on `claude.ai`, logged in, and reachable |
| GET | `/claude-ai/account-profile` | Standalone account profile read |
| GET | `/claude-ai/conversations` | List conversations |
| GET | `/claude-ai/conversations/:uuid` | Read full message tree of one conversation |
| GET | `/claude-ai/projects` | List Projects |
| GET | `/claude-ai/memory` | Claude's persistent memory for the org |
| GET | `/claude-ai/bootstrap` | High-leverage page-load: account + flags + recent conversations |
| GET | `/claude-ai/artifacts/:uuid/versions` | Artifact version history |
| GET | `/claude-ai/org` | Org metadata |
| GET | `/claude-ai/org/subscription` | Subscription details (`?cached=true` by default) |
| GET | `/claude-ai/org/usage` | claude.ai-side usage |
| GET | `/claude-ai/org/skills` | Installed skills |
| GET | `/claude-ai/org/mcp-bootstrap` | Connected MCP servers (**SSE** — events drained server-side) |
| GET | `/claude-ai/org/styles` | Chat styles |
| GET | `/claude-ai/org/model-config/:model` | Per-model capabilities |
| GET | `/claude-ai/org/memory-settings` | Memory feature flags + retention |
| GET | `/claude-ai/org/cowork-settings` | Team/cowork mode toggles |
| GET | `/claude-ai/org/sync-settings` + `/claude-ai/org/sync/gdrive-progress` | Drive sync config + ingestion status |
| GET | `/claude-ai/org/notifications` | Email/push prefs |
| GET | `/claude-ai/account/invites` | Pending org invites |
| GET | `/claude-ai/user-access` | Per-user permissions/roles |
| GET | `/claude-ai/sessions-active` | **Live sessions across devices** — security view |
| POST | `/claude-ai/conversations/:uuid/completion` | **WRITE** — send a message, drain SSE, return aggregated text + events |
| POST | `/claude-ai/conversations/:uuid/title` | **WRITE** — rename / auto-title (omit body for auto-title) |
| POST | `/claude-ai/via-chrome` | Generic snippet generator (path whitelist: `/api/`, `/edge-api/`, `/v1/`) |
| POST | `/claude-ai/via-chrome/...` | Convenience snippet generators mirroring every cookie-file route above |

**Header fingerprint** — both paths re-inject the application-level headers claude.ai's web app normally adds (`anthropic-client-platform`, `anthropic-client-version`, `anthropic-client-sha`, `anthropic-device-id`, `anthropic-anonymous-id`, `x-activity-session-id`). Identity values come from non-HttpOnly cookies. `x-datadog-*` and `traceparent` are intentionally omitted (random per request, not load-bearing).

**Full integration guide:** [`docs/claude-ai-routes.md`](./docs/claude-ai-routes.md) — covers cookie capture workflow, the via-chrome agent loop pattern, the SSE response shape, the reason-code table, and verified end-to-end test results.

**Endpoint inventory** (independent of lm-assist's wrapper): [`lm-claude-endpoint`](https://github.com/langmartai/lm-claude-endpoint).

### SSE Streams
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stream` | General event stream (optional `?executionId=` filter) |
| GET | `/tasks/events` | Real-time task file change events |

## Configuration

All configuration is via `.env` (see `.env.example`):

```bash
ANTHROPIC_API_KEY=your-key       # For AI features (knowledge generation, etc.)
API_PORT=3200                    # Core API port (dev default: 3200, prod: 3100)
WEB_PORT=3948                    # Web UI port (dev default: 3948, prod: 3848)
TIER_AGENT_HUB_URL=wss://...    # Hub gateway WebSocket URL (optional)
TIER_AGENT_API_KEY=sk-...       # Hub API key (optional)
```

The server also accepts CLI options: `node dist/cli.js serve --port 3200 --host 0.0.0.0 --project /path --api-key KEY`

## Hub Client

Connects to LangMart Hub for remote API relay, console relay, and session sync. Auto-connects on server start if `TIER_AGENT_HUB_URL` and `TIER_AGENT_API_KEY` are configured. Auto-reconnects with exponential backoff on disconnect.

```bash
./core.sh hub start    # Connect
./core.sh hub stop     # Disconnect
./core.sh hub status   # Connection info
./core.sh hub logs     # Hub log entries
```

## Hook Scripts (`core/hooks/`)

| Script | Platform | Description |
|--------|----------|-------------|
| `context-inject-hook.js` | All (Node.js) | Cross-platform context injection hook (Windows, macOS, Linux) |
| `statusline-worktree.sh` | Linux/macOS | Claude Code status line showing git branch, session info |

The **context-inject hook** is the primary hook. It uses Node.js for cross-platform support (no shell dependencies like jq, curl, or flock).

## Plugin / Slash Commands

lm-assist is packaged as a Claude Code plugin. On `claude plugin install .`, the plugin auto-registers:
- **MCP server** (`lm-assist`) — search, detail, feedback tools
- **Hook** — context injection (UserPromptSubmit) via cross-platform Node.js script
- **Slash commands** — 6 commands for managing lm-assist

The **statusline** is optional and not auto-installed by the plugin.

**Plugin structure:**
- `.claude-plugin/plugin.json` — Plugin metadata
- `.mcp.json` — MCP server auto-registration
- `hooks/hooks.json` — Hook auto-registration (context-inject only)
- `commands/` — Slash command definitions

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/assist` | Open the web UI — checks API health, opens browser or prints URL |
| `/assist-logs` | View context-inject hook logs (`GET /assist-resources/log?file=context-inject-hook.log`) |
| `/assist-mcp-logs` | View MCP tool call logs (`GET /assist-resources/log?file=mcp-calls.jsonl`) |
| `/assist-search` | Search the knowledge base (`GET /knowledge/search?q=...`) |
| `/assist-status` | Show status of all components — API, web, MCP, hooks, statusline, hub, knowledge |
| `/assist-setup` | Start services and verify integrations (statusline optional via `--statusline`) |

All commands call the existing REST API with `curl` on the active port (dev :3200, prod :3100). If the API is not running, commands advise the user to start it or run `/assist-setup`.

**Install methods:**
- Plugin: `claude plugin install .` (from repo root)
- npm global: `npm install -g lm-assist` then `/assist-setup`


**Effective hub config lives in saved files, not just `.env`.** The Core reads `~/.lm-assist/hub.json` (prod) / `~/.lm-assist/hub-dev.json` (dev) — `{ hubUrl, apiKey, apiPort, assistWebPort }`. `.env`'s `TIER_AGENT_HUB_URL` is only the fallback used when the saved file has none. The `-dev` suffix is applied automatically when running from the repo (`IS_DEV_REPO`).

**Which hub each env connects to (do not mix):**

| Env | `hubUrl` | meaning |
|-----|----------|---------|
| **Prod** (npm, :3100) | `wss://assist-api.langmart.ai` | LangMart **prod** hub (SG instance) |
| **Dev** (repo, :3200) | `wss://assist-api.xeenhub.com` | **xeenhub** dev/HMR hub |

The Core dials the hub **outbound** over WebSocket on start: register → `register_ack` → `auth_confirmed`. Verify: `curl -s localhost:3100/health` (Core up) and `curl -s localhost:3100/hub/status` → `{ configured, connected, authenticated, hubUrl, apiKeyConfigured }`. The public MCP path is `Claude Code → mcp.langmart.ai → langmart hub → this prod worker`; when prod is authenticated the `mcp__claude_ai_lm-assist_langmart__*` tools appear in the Claude Code session. A 502 from `assist-api.langmart.ai` means the SG hub origin is down (not a local problem); a crash-looped local `langmart-gateway.service` (xeenhub Type-3 gateway, :8083, needs a marketplace at :8081) is unrelated leftover and **not** in this path.
## Development

```bash
# Build core (TypeScript → dist/)
./core.sh build

# Watch mode (auto-recompile on change)
cd core && npm run dev

# Build web (Next.js production build)
cd web && npx next build

# Dev mode (web with Turbopack HMR)
cd web && npm run dev

# Run from root (npm workspaces)
npm install              # Install all deps (hoisted to root node_modules/)
npm run build:core       # Build core
npm run build:web        # Build web
```

### Workspace Notes

This project uses **npm workspaces**. Dependencies are hoisted to the root `node_modules/` directory. Run `npm install` from the project root, not from inside `core/` or `web/`.

### Dependency pin — chokidar MUST stay `^3.6.0` (do NOT bump)

chokidar 4.x/5.x are **ESM-only**. The core build is CommonJS (`core/tsconfig.json` → `"module": "commonjs"`), so `core/dist/*.js` does `require("chokidar")`. `require()` of an ESM-only module throws **`ERR_REQUIRE_ESM`** and **Core crashes on boot** — the Web UI still starts, but Core never binds `:3100` (prod) / `:3200` (dev). Symptom: services look half-up, `curl localhost:3100/health` fails, and anything the hub relays (the MCP) errors → "lm-assist MCP is down". Loaders that import it: `task-store.ts`, `rest-server.ts`, `session-cache.ts`, `memory-cache.ts`.

The source uses the v3 API (`import chokidar, { FSWatcher }` + `chokidar.watch(...)`), so **`^3.6.0`** (last CommonJS release) matches the code and can never resolve to the ESM v4/v5 line. Keep it pinned in BOTH `package.json` and `core/package.json`.

Recover if Core won't boot with `ERR_REQUIRE_ESM`:
1. `npm install chokidar@^3.6.0 --ignore-scripts` (the `prepare` hook runs `next build`; `--ignore-scripts` skips it).
2. `core` is a workspace — a nested `core/node_modules/chokidar@5` wins resolution from `core/dist`. Remove it so it hoists to root v3: `rm -rf core/node_modules/chokidar`.
3. Verify: `node -e "const p=require.resolve('chokidar',{paths:['./core/dist']}); require(p); console.log(require(p.replace(/index\.js$/,'package.json')).version)"` → prints `3.6.0`, no throw.

**⚠️ Upgrade hazard:** `lm-assist upgrade` / `npm install -g lm-assist@latest` reinstalls from npm. Until a version carrying `chokidar: ^3.6.0` is **published to npm** (npm `latest` still ships `^5.0.0`), every upgrade RE-BREAKS startup and needs the recovery above. A build/install from this repo is fine (pin committed here).

### Agent SDK (`@anthropic-ai/claude-agent-sdk`) is ESM-only — `import()` must survive tsc

`/agent/execute` (the agent runtime in `sdk-runner.ts`) loads `@anthropic-ai/claude-agent-sdk`, which is **ESM-only** (`type: module`, `exports.require: null`). The code imports it dynamically, but **tsc with `module: commonjs` downlevels `await import('pkg')` to `Promise.resolve().then(() => require('pkg'))`** — and `require()` of an ESM module throws **`ERR_REQUIRE_ESM`**. Result: every agent execution dies with **0 turns / empty result** on the dev build (`:3200`). Prod masks it only because its older npm-installed SDK is still `require`-able — a latent trap, same class as the chokidar one above.

**Fix (in `sdk-runner.ts`):** indirect the dynamic import through `Function` so tsc cannot see/downlevel it:
```
const esmImport: (m: string) => Promise<any> = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
// ...
const { query } = await esmImport('@anthropic-ai/claude-agent-sdk');
```
Type-only imports from the SDK are fine as `import type { ... }` (erased at compile). Verify: `POST :3200/agent/execute {"prompt":"reply OK","model":"haiku"}` → `turns>0`, no `ERR_REQUIRE_ESM`. (Note: `annotation/matcher.ts` + `annotation/annotator.ts` have the same downleveled `import()` and would need the same treatment if/when their feature is exercised on a CJS build with an ESM SDK.)

### Route Development

Routes live in `core/src/routes/core/`. Each file exports a `create*Routes(ctx: RouteContext)` function returning an array of `RouteHandler` objects:

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

Register new route files in `core/src/routes/core/index.ts`.

### Publishing / Version Bumps

When releasing a new version, update the version in **all three files** before committing:

| File | Field | Purpose |
|------|-------|---------|
| `package.json` | `"version"` | npm package version (what `npm view lm-assist version` reports) |
| `.claude-plugin/plugin.json` | `"version"` | Plugin version (shown in Claude Code plugin cache) |
| `.claude-plugin/marketplace.json` | `plugins[0].version` | Marketplace listing version (used by plugin registry) |

**Release steps:**

```bash
# 1. Bump version in all three files (keep them in sync)
# 2. Commit and push
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to X.Y.Z"
git push origin main

# 3. Publish to npm
npm publish

# 4. Verify
npm view lm-assist version   # Should show new version
```

**How each version is used:**
- `package.json` → npm registry, `GET /dev-mode/check-update` (current vs latest comparison)
- `.claude-plugin/plugin.json` → `claude plugin install lm-assist@langmartai` reads this for the version string stored in `~/.claude/plugins/installed_plugins.json`
- `.claude-plugin/marketplace.json` → Plugin marketplace/registry uses this to index the plugin

**Upgrade flow** (from web UI or CLI):
- Web UI: Settings → Experiment → "Check for Updates" → "Upgrade" (calls `POST /dev-mode/upgrade`, runs detached `core/scripts/upgrade.js`)
- CLI: `lm-assist upgrade` (runs `core/scripts/upgrade.js` in foreground)
- The upgrade script: plugin install → kill services → `npm install -g lm-assist@latest` → restart services
- Upgrade log: `~/.cache/lm-assist/upgrade.log`

### Running Modes: npm Package vs Dev Repo

lm-assist has two independent environments that can run simultaneously on separate ports:

- **Prod (npm package)**: Managed by `lm-assist start/stop/restart`. Runs on ports 3100/3848. Do not modify.
- **Dev (this repo)**: Managed by `./core.sh start/stop/restart`. Runs on ports 3200/3948. Use for development and testing.

The `devModeEnabled` flag in `~/.claude-code-config.json` controls which environment the **MCP server, hook, and statusline** talk to. The Settings → Experiment → Developer Mode toggle switches it.

| `devModeEnabled` | MCP/Hook/Statusline target | Effect |
|-------------------|---------------------------|--------|
| `false` (default) | Prod API (:3100) | Normal operation — plugin tools use the npm-installed prod services |
| `true` | Dev API (:3200) | Plugin tools switch to the dev repo services for testing |

**Important:** `devModeEnabled` only affects which API port the MCP/hook/statusline connect to. It does NOT change which services are running — prod and dev run independently on their own ports.

#### Component launch paths

| Component | Prod (`lm-assist start`) | Dev (`./core.sh start`) |
|-----------|--------------------------|-------------------------|
| **Core API** | `<npm-root>/lm-assist/core/dist/cli.js` → :3100 | `<repo>/core/dist/cli.js` → :3200 |
| **Web UI** | `<npm-root>/lm-assist/web/` → :3848 | `<repo>/web/` → :3948 |
| **MCP Server** | Always runs from plugin cache (`${CLAUDE_PLUGIN_ROOT}`) | Same binary — `devModeEnabled` switches target port |
| **Hook** | Always runs from plugin cache (`${CLAUDE_PLUGIN_ROOT}`) | Same binary — `devModeEnabled` switches target port |
| **Statusline** | `<npm-root>/lm-assist/core/hooks/statusline-worktree.js` | `<repo>/core/hooks/statusline-worktree.js` |

Where `<npm-root>` = e.g. `~/.nvm/versions/node/v20.19.6/lib/node_modules` and `<repo>` = e.g. `/home/ubuntu/lm-assist`.

#### How mode switching works

1. `bin/lm-assist.js` → `getProjectRoot()` checks `~/.claude-code-config.json`
2. If `devModeEnabled && devRepoPath` → uses repo path; otherwise → uses npm package path (`path.dirname(path.dirname(__filename))`)
3. `core/src/service-manager.ts` → same logic in `getRepoRoot()`
4. Both Core API and Web UI resolve their working directory from this root
5. The MCP server and hook always run from the plugin cache (`${CLAUDE_PLUGIN_ROOT}`); they read `devModeEnabled` from config to determine which API port to call (3200 dev / 3100 prod)

#### Upgrade methods

| Method | Command | What it does |
|--------|---------|-------------|
| **Web UI** | Settings → Experiment → "Check for Updates" → "Upgrade" | `POST /dev-mode/upgrade` → spawns detached `core/scripts/upgrade.js` |
| **CLI** | `lm-assist upgrade` | Runs `core/scripts/upgrade.js` in foreground with live output |

**Upgrade script steps** (`core/scripts/upgrade.js`):
1. `claude plugin install lm-assist@langmartai` — update plugin cache (MCP, hooks, slash commands)
2. `fuser -k 3100/tcp && fuser -k 3848/tcp` — kill prod services
3. `npm install -g lm-assist@latest` — update npm package
4. Wait 2s
5. `lm-assist start` — restart services

Log file: `~/.cache/lm-assist/upgrade.log`

### Bootstrapping from the repo on a fresh host (dev + prod)

**One-command (recommended), per OS** — both run `scripts/preflight.js` first (Node>=20.9, git/npm, chokidar pin) then a prod install (CLI + services :3100/:3848); add `--dev`/`-Dev` for the dev ports (3200/3948):
- Linux/macOS: `curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash`
- Windows: `irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex`
- Diagnose anytime: `lm-assist doctor` (runs the same preflight; `--json` for machine output).
- Node policy is **guidance-only**: too-old Node prints the nvm / nvm-windows / fnm upgrade command and stops — it never changes your Node.

Verified end-to-end in a clean cloud **CCR** container (Node 22). This is the same procedure the MCP ships through `guide(topic="install")` / `bootstrap` (see `core/src/mcp-server/tools/guide.ts`) so a connector-only host with **no local lm-assist** can self-install. It's an npm **workspace** monorepo (`core` = Node API, `web` = Next.js 16). Requires **Node ≥ 20.9** (the Next 16 web build fails on 18). **Run every `npm` command from the repo ROOT** — workspaces hoist deps; installing inside `core/` or `web/` nests a `node_modules` that shadows the hoist (e.g. the wrong chokidar then resolves from `core/dist`).

**Dev (repo ports — API :3200, Web :3948), from the repo root:**
```bash
npm install --ignore-scripts          # plain `npm install` DIES on onnxruntime-node's native postinstall
                                       # (transitive via @huggingface/transformers / @lancedb):
                                       # "Cannot find module .../global-agent/.../index.js"
node -e "require('chokidar');console.log(require('chokidar/package.json').version)"   # must print 3.6.0, no throw
./core.sh build                        # core TS -> core/dist
./core.sh start                        # Core :3200, then builds + starts Web :3948
curl -s localhost:3200/health          # -> "runningFrom":"dev-repo"
curl -so /dev/null -w '%{http_code}\n' localhost:3948   # -> 307 (= up; see gotcha #3)
```

**Prod (CLI ports — API :3100, Web :3848), also from the repo root:**
```bash
npm pack                               # the `prepare` script builds core+web -> lm-assist-<ver>.tgz (~28 MB)
npm install -g ./lm-assist-*.tgz       # installs the `lm-assist` CLI + compiles native better-sqlite3 (~46s)
                                       # (CLI already there? -> lm-assist upgrade --from ./lm-assist-*.tgz)
lm-assist start                        # Core :3100 + Web :3848
curl -s localhost:3100/health          # -> "runningFrom":"npm"
```

Dev + prod run **simultaneously** — separate port spaces (3200/3948 vs 3100/3848), no conflict (`./core.sh status` shows both).

**Gotchas (verified in the container):**

| # | Gotcha | Symptom | Fix |
|---|--------|---------|-----|
| 1 | `onnxruntime-node` native postinstall (transitive via `@huggingface/transformers` / `@lancedb`) | `npm install` dies: `Cannot find module .../global-agent/.../index.js` | **dev:** `npm install --ignore-scripts`. **prod** (`npm install -g ./tgz`) does NOT need it — the prod-only dep tree installs clean. |
| 2 | `--ignore-scripts` skips the better-sqlite3 native build | `better-sqlite3/build/Release/better_sqlite3.node` absent | Core still boots healthy (sqlite is lazy / worker-thread loaded); only matters if you use the SQL data backend. The prod global-install compiles it anyway. |
| 3 | `./core.sh` web "Failed to start" / "Not Running" | the probe wants 200 on `/`, but the app **307-redirects** `/` → `/sessions` | False negative — ignore it; `curl :3948` → 307 means it's up. |
| 4 | chokidar must be `^3.6.0` (see the pin section above) | v4/v5 are ESM-only → `ERR_REQUIRE_ESM` → Core never binds :3200/:3100 | the repo + its `npm pack` tgz carry the pin (safe). Only `npm install -g lm-assist@latest` from the registry re-breaks it. |
| 5 | `lm-assist upgrade` (no flag) reinstalls from npm | overwrites a local-tgz / source build with npm `latest` (possibly older / chokidar-broken) | use `lm-assist upgrade --from ./<tgz>` to keep your source build. |

The hub is a **separate, user-confirmed step**: bootstrapping writes no hub credentials and connects to nothing — `lm-assist setup --key <KEY>` runs only on explicit user instruction (both Core instances report Hub Client *Not configured* until then, and the local services still work).

### Key Types

```typescript
// Route system
interface RouteHandler {
  method: string;
  pattern: RegExp;
  handler: (req: ParsedRequest, api: TierControlApiImpl) => Promise<ApiResponse<any>>;
}

interface RouteContext {
  api: TierControlApiImpl;
  tierManager: TierManager;
  projectPath: string;
  getProjectManager(): ProjectManager;
  getSessionStore(): AgentSessionStore;
  getEventStore(): EventStore;
}

// API responses
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta: { timestamp: Date; requestId: string; durationMs: number };
}
```
