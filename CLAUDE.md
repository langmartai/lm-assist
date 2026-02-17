# lm-assist

Monorepo for the LM Assistant — a web UI for managing Claude Code sessions, with a backend API for session management, milestones, knowledge, architecture, and hub connectivity.

## Structure

```
lm-assist/
├── core/              ← Backend API (TypeScript, port 3100)
│   ├── src/
│   ├── hooks/         ← Hook scripts (statusline, context-inject, event logger)
│   ├── scripts/       ← tmux-autostart.sh
│   ├── package.json
│   └── tsconfig.json
├── web/               ← Web UI (Next.js, port 3848)
│   ├── src/
│   ├── package.json
│   └── next.config.ts
├── core.sh            ← Service manager (start/stop/restart/status)
├── package.json       ← Workspace root
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

## Key API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/sessions` | List Claude Code sessions |
| GET | `/sessions/:id` | Get session data |
| GET | `/sessions/:id/dag` | Message DAG |
| GET | `/projects` | List projects |
| GET | `/tasks` | List task lists |
| GET | `/task-store/tasks` | Aggregated tasks |
| POST | `/ttyd/start` | Start web terminal |
| GET | `/hub/status` | Hub connection status |
| GET | `/knowledge` | Knowledge entries |
| GET | `/architecture` | Architecture data |
| GET | `/milestones/:sessionId` | Session milestones |

## Hub Client

Connects to LangMart Hub for remote API relay, console relay, and session sync.

```bash
# Configure in .env
TIER_AGENT_HUB_URL=wss://hub.example.com
TIER_AGENT_API_KEY=sk-langmart-...
```

## Development

```bash
# Build core
cd core && npm run build

# Watch mode
cd core && npm run dev

# Build web
cd web && npm run build

# Dev mode (web)
cd web && npm run dev
```
