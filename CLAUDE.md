# lm-assist

Monorepo for the LM Assistant — a web UI for managing Claude Code sessions, with a backend API for session management, milestones, knowledge, architecture, and hub connectivity.

## Structure

```
lm-assist/
├── core/                    ← Backend API (TypeScript, port 3100)
│   ├── src/
│   │   ├── api/             ← API helper implementations (sessions, agent, tasks)
│   │   ├── checkpoint/      ← Git checkpoint management
│   │   ├── hub-client/      ← Hub WebSocket client (relay, sync)
│   │   ├── knowledge/       ← Knowledge generation pipeline
│   │   ├── mcp-server/      ← MCP server + tools (search, detail, feedback)
│   │   ├── milestone/       ← Milestone extraction pipeline
│   │   ├── routes/core/     ← 20 route files, 155 endpoints
│   │   ├── search/          ← BM25 + text scoring
│   │   ├── types/           ← Shared TypeScript types
│   │   ├── utils/           ← Git, JSONL, path utilities
│   │   └── vector/          ← Embeddings + Vectra vector store
│   ├── hooks/               ← Hook scripts (statusline, context-inject, event logger)
│   ├── scripts/             ← tmux-autostart.sh
│   ├── package.json
│   └── tsconfig.json
├── web/                     ← Web UI (Next.js 16, port 3848)
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
- Hook events: `~/.claude/hook-events.jsonl`
- Team configs: `~/.claude/teams/`

### Web UI (`web/`)

Next.js 16 with Turbopack, React 19, Zustand for state, Tailwind CSS v4 for styling. Renders sessions, terminals, tasks, knowledge, architecture, and settings pages. Communicates with the core API on port 3100.

### MCP Server (`core/src/mcp-server/`)

Provides 3 tools via stdio transport (server name: `tier-agent-context`):

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge, milestones, architecture, file history |
| `detail` | Progressive disclosure for any item by ID (K001, sessionId:index, arch:name) |
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
| GET | `/sessions/:id/from/:lineIndex` | Get messages from position |
| GET | `/sessions/:id/dag` | Message DAG with branch info |
| GET | `/sessions/:id/session-dag` | Cross-session DAG (subagents, teams) |

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

### Architecture (4 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/architecture` | Get architecture model |
| POST | `/architecture/generate` | Generate architecture from codebase |

### Milestones
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/milestones/:sessionId` | Session milestones |
| GET | `/milestone-pipeline/status` | Pipeline status |
| POST | `/milestone-pipeline/extract` | Trigger extraction |

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
ANTHROPIC_API_KEY=your-key       # For AI summaries/architecture generation
API_PORT=3100                    # Core API port (default: 3100)
WEB_PORT=3848                    # Web UI port (default: 3848)
TIER_AGENT_HUB_URL=wss://...    # Hub gateway WebSocket URL (optional)
TIER_AGENT_API_KEY=sk-...       # Hub API key (optional)
```

The server also accepts CLI options: `node dist/cli.js serve --port 3100 --host 0.0.0.0 --project /path --api-key KEY`

## Hub Client

Connects to LangMart Hub for remote API relay, console relay, and session sync. Auto-connects on server start if `TIER_AGENT_HUB_URL` and `TIER_AGENT_API_KEY` are configured. Auto-reconnects with exponential backoff on disconnect.

```bash
./core.sh hub start    # Connect
./core.sh hub stop     # Disconnect
./core.sh hub status   # Connection info
./core.sh hub logs     # Hub log entries
```

## Hook Scripts (`core/hooks/`)

| Script | Description |
|--------|-------------|
| `statusline-worktree.sh` | Claude Code status line showing git branch, session info |
| `context-inject-hook.sh` | Injects relevant knowledge/milestones into Claude Code context |
| `hook-event-logger.sh` | Logs all Claude Code hook events to `~/.claude/hook-events.jsonl` |
| `hook-lib.sh` | Shared library for hook scripts |
| `install-hook-logger.sh` | Installer for the hook event logger |

Install hooks via: `./core/hooks/install-hook-logger.sh`

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
