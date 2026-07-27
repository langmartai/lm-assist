# Architecture — Core API, Web UI, key types

> Orientation for the backend/frontend split and the shared route/response types.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

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

**Deployment + hub auth state:** see [`docs/web-deployment-and-hub-auth.md`](./web-deployment-and-hub-auth.md) — one build serves prod (3848→3100→langmart) and dev (3948→3200→xeenhub) but ONLY if `LM_LOCAL_API_PORT` is set at launch (else dev silently hits the prod core); plus how the nav + settings must `refreshHubConnection()` after logout and why account switch clears the gateway-id.

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
