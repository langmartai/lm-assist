# lm-assist

Monorepo for the LM Assistant — a web UI for managing Claude Code sessions, with a backend API for session management, knowledge, and hub connectivity.

> **This file is an INDEX.** It carries only what bites you when you are not thinking about it;
> everything else lives in a topic file below and is read on demand.

## Topic index — READ the matching file before you act

The prose that used to live here was moved into topic files so it is read ON DEMAND. That only
works if you actually go and read it, so:

1. **Match the triggers below against the task you were just given**, the file you are about to
   open, or the error you are staring at. Triggers are deliberately literal — paths, symbol
   names, tool names, error strings — so matching is mechanical, not a judgement call. They are
   written in BOTH vocabularies on purpose: what you would *see* (`up_error`, `SUBMIT_UNVERIFIED`)
   and what you would *ask* ("get one turn out of a session"). A trigger list written only in the
   words of the answer is unmatchable by someone who does not have the answer yet — measured: a
   row keyed on `fromUserPromptIndex` was skipped by a session asking "how do I fetch the 5th
   user prompt", because that is not how the question sounds.
2. **Read the file BEFORE you act**, not after you are stuck. A 3 KB topic file costs less than
   one wrong edit, and far less than a wrong edit shipped to prod.
3. 🔴 **A tripwire is a WARNING, not a summary.** Each row carries one trap so a reader who never
   opens the file is not completely blind. It is *not* the content of the file. Answering from
   the tripwire alone is how you ship the plausible-but-wrong version — and every one of these
   files exists because a real session did exactly that.
4. **If you are unsure, that IS the trigger.** About to answer a question about this repo from
   inference? Cannot name the file that told you something? Read. When no row matches, try
   `grep -rl "<term>" docs/` — `docs/` holds ~45 files and `docs/superpowers/specs/` holds the
   design specs; `ls docs/` is cheap.

🔴 **Use plain markdown links here, never `@docs/foo.md`.** An `@path` is an *import*: Claude Code
expands it into context at launch (recursive, 4 hops deep), which is exactly what this split exists to
stop. To mention a path without importing it, wrap it in backticks or use a `[link](path)`.

| topic | triggers — match these | the tripwire (a warning, not the answer) |
|---|---|---|
| [voice](docs/voice.md) | `core/src/voice/` · `useClaudeVoice.ts` · `claude-chrome.ts` · `LM_HTTPS` · voice · mic · TTS · `up_error` · `cf_clearance` · `{ready}` | Verify with **`up>0`**, never `{ready}` alone. Never regress the CF fix (real-Chrome UA + `GET /api/account` before the WS upgrade). claude.ai ACCEPTS any well-formed conversation uuid and silently discards the turns — a session must prove it owns the conversation before audio flows. |
| [claude.ai integration](docs/claude-ai.md) | `/claude-ai/*` · `core/src/claude-ai/` · `claudeai-session.ts` · rename a conversation · `conversation_tokens` · `conversation_fork` · claude.ai cookie | Rename is `PUT …/chat_conversations/:uuid {name}`; `/title` is the auto-title **generator** and 400s on a title. Naive token counting over-reports LIVE context by **3.8×**. |
| [mission control](docs/mission-control.md) | `core/src/monitor/` · stall · auto-resume · `/model` fallback · `stall_status` · `scheduled-jobs` · "reached your … limit" | An unbounded scheduled pass doesn't run long — it **silently disables the job forever**. Auto-resume runs first and unbounded; model-fallback second under a budget. Never reorder. |
| [node placement](docs/node-placement.md) | placement · `env.host` · cluster · election · `node_select` · `node_profile` · `machine_access` · `mission_spawn` | A display name is not an identity — route on **hostId**. Respect each cluster's declared scope; `frozen`/`release`/`busy` are off-limits by default. |
| [MCP surfaces](docs/mcp-surfaces.md) | adding/editing an MCP tool · `core/src/mcp-server/` · `mcp-session-resolver.ts` · `tools/list` · `_actor` · tool description | That resolver is on the hot path of **every** connector call — no store sweeps, no unbounded network, no timer-only deadlines. Shared boilerplate in a tool description costs length × tool count. |
| [session messaging](docs/session-messaging.md) | `send_session_message` · `core/src/terminal/cc.ts` · `SUBMIT_UNVERIFIED` · `DELIVERY_UNVERIFIED` · composer · queued input · `messageId` | Claude Code **queues** input while busy — that IS a successful submit. Never anchor composer detection on `>`. `unverified` is deliberately not `pending`. |
| [memory reads](docs/memory-reads.md) | `memory_file` · `search_memory` · `project_id` · `PROJECT_NOT_FOUND` · `memory-api.ts` | "Intermittent" was **deterministic per input** — sort failures by ARGUMENT, not by time. A dropped `error.code` manufactures phantom transport bugs. |
| [backlog + registry writes](docs/backlog-registry.md) | `backlog_*` tools · any fleet-synced registry WRITE · `UNSUPPORTED_FIELD` · `requestId` · `ORIGIN_TIMEOUT` | Coerce caller-plausible enums and refuse the rest LOUDLY, echoing what was sent. Strip transport keys before the unknown-field guard. `ORIGIN_TIMEOUT` **may** have landed; `ORIGIN_UNREACHABLE` did not. |
| [install + running modes](docs/install-and-modes.md) | `lm-assist upgrade` · `install.sh` · `npm pack` · fresh host · "dev or prod?" · which port is serving | `lm-assist upgrade` from npm **re-breaks the chokidar pin**; use `--from <tgz>` to keep a source build. |
| [API endpoints](docs/api-endpoints.md) | "which endpoint …?" · read/slice a stored session · get one turn / prompt / response out of a session · list sessions, projects, tasks, knowledge · delta or conditional fetch · `GET /sessions/:id` · `fromUserPromptIndex` | Reference only — no rules live here. |
| [architecture](docs/architecture.md) | "where does X live?" · `RouteHandler` · `RouteContext` · `ApiResponse` · Core/Web split | — |
| [plugin + hooks](docs/plugin-and-hooks.md) | `.claude-plugin/` · `hooks/hooks.json` · `commands/` · context-inject · statusline · slash command | — |
| [hub client](docs/hub-client.md) | `hub.json` · `/hub/status` · "the MCP is down" · `assist-api` · `TIER_AGENT_*` · `auth_confirmed` | Effective config is `~/.lm-assist/hub.json`, **not** `.env`. Dev dials xeenhub, prod dials langmart — never mix. |
| [Gmail connector](docs/gmail-connector.md) | `gmail_*` tools · `core/src/gmail/` · `/gmail/*` routes · `BROWSER_NOT_RUNNING` · gmail login · CDP port 9224 · "which node has Gmail?" | A Gmail tool only works on a node with its OWN signed-in browser — deploying the code does NOT make a node able to read mail, and every call routes to ONE node. Ask `gmail_status` per node; the tools are advertised whether signed in or not. Restarting Core KILLS the browser it launched. |
| [LinkedIn connector](docs/linkedin-connector.md) | `linkedin_*` tools · `core/src/linkedin/` · `/linkedin/*` routes · CDP · Chrome port 9223 | There is **no personal LinkedIn API** — every read and write drives a real logged-in browser. LinkedIn VIRTUALIZES its lists, so a read captures only what is currently RENDERED and accumulates across calls; there is no "fetch history". Writes act on the operator's real account. |
| [VM management](docs/vm-management.md) | `vm_*` tools · `core/src/vm/` · `/vm/*` routes · Hyper-V · KVM · virsh · `VM_NOT_MANAGED` · `UNSAFE_PATH` · create a VM · elevation | The input CHARSET regexes are the security boundary for elevated commands — widening one widens what reaches a privileged shell. Catalogue budget headroom is **95 bytes**: the next MCP tool must trim descriptions, not raise the budget. KVM backend is NOT yet e2e-verified. |

**Deeper single-subject docs** (referenced from the topics above, same on-demand rule):
[claude-ai-routes](docs/claude-ai-routes.md) · [claude-code-routes](docs/claude-code-routes.md) ·
[build-pack-install-upgrade](docs/build-pack-install-upgrade.md) · [voice-https-transport](docs/voice-https-transport.md) ·
[claude-ai-voice-protocol](docs/claude-ai-voice-protocol.md) · [web-deployment-and-hub-auth](docs/web-deployment-and-hub-auth.md) ·
design specs under `docs/superpowers/specs/`.

**When you add a new subject here:** put the prose in a topic file and add ONE row above. This file is
loaded into every session on this machine — it grew to 77 KB against a 40 KB limit by accreting incident
write-ups that already had a durable home.

## Build-breaking pins — read before touching dependencies

These two are here rather than in a topic file because nothing prompts you to look them up:
you hit them while doing something else entirely, and the symptom is a Core that will not boot.

### Dependency pin — chokidar MUST stay `^3.6.0` (do NOT bump)

**chokidar 5 is ESM-only.** The core build is CommonJS (`core/tsconfig.json` → `"module": "commonjs"`), so `core/dist/*.js` does `require("chokidar")`. `require()` of an ESM-only module throws **`ERR_REQUIRE_ESM`** and **Core crashes on boot** — the Web UI still starts, but Core never binds `:3100` (prod) / `:3200` (dev). Symptom: services look half-up, `curl localhost:3100/health` fails, and anything the hub relays (the MCP) errors → "lm-assist MCP is down". Six call sites `require` it: `rest-server.ts`, `task-store.ts`, `session-cache.ts`, `memory-cache.ts`, `memory/cross-project-signpost.ts`, `rules/autosync.ts`.

⚠️ **This note used to say "4.x/5.x are ESM-only". That is wrong about 4.x, and the error hid the real hazard.** Verified against the registry:

| version | module format | engines |
|---|---|---|
| `3.6.0` (pinned) | CJS | `>= 8.10.0` |
| `4.0.3` | **dual** — `exports["."].require = "./index.js"` | `>= 14.16.0` |
| `5.0.0` | `type: "module"`, `default` export only | **`>= 20.19.0`** |

So v4 would `require()` fine. **v5 is the one that breaks**, and it breaks *selectively*: `require(esm)` exists on Node ≥ 20.19, so a bump looks healthy on a modern dev box and dies on a Node 18 user. Never validate this pin only on the machine you are sitting at.

**Keep `^3.6.0` anyway.** The range cannot resolve to v4 or v5, so it is doing its job. v4 is *plausibly* compatible — all six call sites pass `ignored` as RegExp arrays, a function, or not at all, and none rely on the string globs v4 dropped — but nobody has validated a v4 build end-to-end here, so "plausible" is not a reason to move. Keep it pinned in BOTH `package.json` and `core/package.json`.

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
./core.sh pack         # Build a prebuilt prod tarball (lm-assist-<ver>.tgz) for deploy/upgrade
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
