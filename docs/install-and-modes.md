# Install, upgrade, and dev-vs-prod running modes

> Read before installing on a new host, changing upgrade flow, or debugging which environment is serving. Per-case process detail: [build-pack-install-upgrade.md](./build-pack-install-upgrade.md).
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Install/upgrade sources (published vs custom)

Every surface supports both: **published** (`lm-assist@latest`/`@<ver>` from npm) and **custom** (a GitHub-Release tgz, `github:…#ref`, a local `.tgz`, or a source build). The current install is tracked in `~/.lm-assist/install-source.json` (`{kind:'published'|'custom',source,version}`) and shown by `lm-assist version`, `GET /dev-mode/check-update` (`currentSource`/`isCustomBuild`), and the Settings UI. `lm-assist version` only prompts an upgrade when npm latest is GREATER (no downgrade nudges) and warns when on a custom build. Installers (`install.sh`/`install.ps1`) prefer the prebuilt GitHub-Release tgz for the ref, fall back to source-build, and take `--published [<ver>]` for the registry. CLI: `lm-assist upgrade --from <tgz|dir|version|github:…#ref|release-url>`.

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
