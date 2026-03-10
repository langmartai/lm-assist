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

### Web UI (`web/`)

Next.js 16 with Turbopack, React 19, Zustand for state, Tailwind CSS v4 for styling. Renders sessions, terminals, tasks, knowledge, and settings pages. Communicates with the core API (dev :3200 / prod :3100).

### MCP Server (`core/src/mcp-server/`)

Provides 3 tools via stdio transport (server name: `lm-assist`):

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge and file history |
| `detail` | Progressive disclosure for any item by ID (K001, sessionId:index) |
| `feedback` | Quality feedback on context sources (outdated, wrong, useful, etc.) |

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
