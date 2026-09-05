# Build · Pack · Install · Upgrade · Deploy — Full Process (every case)

Authoritative, surface-by-surface (**script / CLI / web**) reference for getting lm-assist code
built, packaged, installed, upgraded, and deployed. Synthesized from the actual installer/CLI/web
code + the fleet operational learnings. Companion to `CLAUDE.md` (## Development, ## Publishing).

> Last reconciled 2026-07-01 (after the rule-auto-sync + session_footprints work).

---

## 0. Mental model — the distinctions that matter

| Axis | A | B |
|---|---|---|
| **Environment** | **Dev** (repo, ports **3200/3948**, managed by `./core.sh`) | **Prod** (npm-global, ports **3100/3848**, managed by `lm-assist` CLI) — run **simultaneously**, separate port spaces |
| **Source kind** (`install-source.json`) | **published** (`lm-assist@<ver>` from npm) | **custom** (a `.tgz`, dir, `github:…#ref`, or release URL) |
| **Action** | BUILD (tsc→`core/dist` + `next build`) · PACK (`npm pack`→tgz) · INSTALL (fresh) · UPGRADE (replace) | **DEPLOY** = push new code onto an *existing* install (the ops path = **dist-sync**, NOT a reinstall) |

**Three load-bearing facts:**
1. **npm `latest` = 0.2.0** (published 2026-09-01, chokidar-pinned) — plain `lm-assist upgrade` is **safe again**. One nuance survives: local builds can run AHEAD of npm, and `upgrade.js` has no downgrade guard, so a no-flag upgrade would replace a newer local build with npm's older one — use `--from <tgz>` for local builds.
2. **chokidar must stay `^3.6.0`** (v4/v5 are ESM-only → `ERR_REQUIRE_ESM` → Core never binds `:3100/:3200`). The repo + every `npm pack` tgz + npm ≥0.2.0 carry the pin; only installs of **≤0.1.70** ship the broken `^5`.
3. **Three version files must stay in sync** for a release: `package.json`, `.claude-plugin/plugin.json`, and the **lm-assist entry** in `.claude-plugin/marketplace.json` (that file also lists `claude-code-multisession` + `claude-code-webui` — different projects, ignore them). Currently all three = **0.1.133**.

Always run `npm` from the **repo ROOT** — installing inside `core/`/`web/` nests a `node_modules` that shadows the chokidar hoist. Node **≥20.9** required (Next 16 build dies on 18).

---

## 1. BUILD

| Goal | Command (from repo root) | Notes |
|---|---|---|
| Install dev deps | `npm install --ignore-scripts` | plain `npm install` DIES on onnxruntime-node's postinstall; sqlite is lazy so `--ignore-scripts` is fine for dev |
| Verify chokidar | `node -e "require('chokidar');console.log(require('chokidar/package.json').version)"` | must print `3.6.0`, no throw |
| Core only | `./core.sh build` (= `npm run build:core`, tsc → `core/dist`) | pure cross-platform JS |
| Web | `npm run build:web` (`next build`, `output:standalone`) | **needs Node 20** (`PATH=~/.nvm/versions/node/v20.19.6/bin:$PATH`); under 18 it aborts with only a version warning and produces nothing |
| Both | `npm run build` | core + web |

**Core-only vs web changes** decides the deploy path (§5): core-only = dist-sync; web = standalone rebuild + static copy.

---

## 2. PACK — make the reproducible `.tgz` artifact

1. **Bump the 3 version files in sync** (see §0.3). 0.1.133 is already "spent" by the current base — a new artifact needs a new number (e.g. **0.1.134**).
2. `npm pack` → the **`prepare`** hook runs `build:core && build:web` first → **`lm-assist-<ver>.tgz`** (~28 MB).
3. `files` ships: `core/dist`, `core/data`, `core/hooks`, **`core/scripts`** (the REAL `upgrade.js`), `scripts/preflight.js` (single file), `ccr`, **`web/.next`**, `web/public`, `core.sh`, `bin`, `.claude-plugin`, `.mcp.json`, `commands`, `hooks`, `install.sh`, `install.ps1`. **NOT shipped:** `core/src`, `web/src`, `docs/`, and `scripts/upgrade.js` (that root file is a **test stub** — see §4c).
4. The tgz carries the chokidar pin → **re-break-safe**.

**npm publish** (separate): `prepublishOnly` builds `core`; needs (a) the version not already on npm and (b) publish auth. To publish the current features you must bump past 0.1.70's line (npm has ≤0.1.70 only, so 0.1.134 is free).

---

## 3. INSTALL (fresh host)

### 3a. One-command installer — `install.sh` / `install.ps1`
```bash
# prod (CLI + services :3100/:3848)
curl -fsSL https://raw.githubusercontent.com/langmartai/lm-assist/main/install.sh | bash
# dev (BUILD ONLY — see gotcha): add --dev
curl -fsSL …/install.sh | bash -s -- --dev
# windows
irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex
```
**Flow:** prereq gate (Node ≥20 **hard-fail**, git/npm/claude) → plugin install (`claude plugin install lm-assist@langmartai`) → clone/pull (skipped for `--published`) → `npm install --ignore-scripts` + `node scripts/preflight.js --phase=post-clone` (Node 20.9 / git / npm / **chokidar 3.6.x**, hard) → build/start by mode.

**Flags:** `--dev`/`-Dev` (build only), `--ref <tag|branch|commit>`/`-Ref` (pin), `--published [ver]`/`-Published` (npm registry), `--source-build`/`-SourceBuild` (skip prebuilt tgz), `LM_ASSIST_DIR` env (default `~/lm-assist`).

**Prod resolver (default, 3-way):** (1) **prebuilt GitHub-Release tgz** (preferred — HEAD-probes `releases/download/<tag>/lm-assist-<v>.tgz`, or the latest-release asset) → `npm i -g <url>` (`custom`); (2) **source-build** fallback → `npm pack` → `npm i -g ./tgz` (`custom`, `github:…#<branch>`); (3) **published** (`--published`) → `npm i -g lm-assist@<ver|latest>` (`published`).

**Auto-start:** the installer does **not** call `lm-assist start` — `bin/postinstall.js` (npm `postinstall` hook, global installs only) auto-starts prod + installs statusline + writes `install-source.json` (`published`). **GOTCHA:** `--dev` **builds but does not start** — run `./core.sh start` yourself.

### 3b. From the repo (manual; dev + prod side-by-side)
```bash
# DEV  (:3200/:3948)
npm install --ignore-scripts && ./core.sh build && ./core.sh start
curl -s localhost:3200/health     # "runningFrom":"dev-repo"   (web / → 307 = up; a "Failed to start" probe is a FALSE negative)
# PROD (:3100/:3848)
npm pack                          # prepare builds core+web → lm-assist-<ver>.tgz
npm install -g ./lm-assist-*.tgz  # NO --ignore-scripts (compiles better-sqlite3 ~46s); CLI already there → lm-assist upgrade --from ./tgz
lm-assist start
curl -s localhost:3100/health     # "runningFrom":"npm"
```

### 3c. From npm — **fine as of 0.2.0**
`npm i -g lm-assist@latest` → **0.2.0** (published 2026-09-01), chokidar-pinned, boots clean. Only explicitly installing a version **≤0.1.70** still hits `ERR_REQUIRE_ESM`.

### 3d. Join the fleet (enrollment) + hub — separate, user-confirmed
```bash
# on an already-authed node: mint a one-time keypack
lm-assist login --new-node          # POST :3100/hub/enroll/create → prints lmkp_…
# on the fresh node: redeem (auto-starts; writes ~/.claude.json hub MCP 0600 unless --no-mcp)
lm-assist login <lmkp_…>
# connect Core to the hub (NEVER embed a key; explicit go-ahead only)
lm-assist setup --key <KEY>         # default hubUrl wss://assist-api.langmart.ai
```

---

## 4. UPGRADE (replace an existing install)

### 4a. CLI — `lm-assist upgrade [--from <spec>]`
- `lm-assist upgrade` → npm `latest` (= **0.2.0** as of 2026-09-01 — safe; note it will replace a NEWER local build, no downgrade guard).
- `lm-assist upgrade --from <spec>` → a chosen build. Runs **synchronously** (foreground, live output); copies `upgrade.js` to tmpdir first (Windows EBUSY).
- **`--from` spec forms** (`resolveSource()`): local `.tgz`/`.tar.gz` path · unpacked dir · bare version `0.1.134` (→ `lm-assist@0.1.134`) · `github:org/repo#ref` · release URL · omitted/`latest` = published.

### 4b. Web — Settings → Experiment → Installation
- **"Check for Updates"** → `GET /dev-mode/check-update` → `{currentVersion (npm list -g), latestVersion (npm view), updateAvailable (latest>current STRICT), currentSource, isCustomBuild}`.
- **"Upgrade"** → `POST /dev-mode/upgrade {source?}` (source dropdown: `latest`/`version`/`github`/`tgz` — **custom upgrades ARE supported**). Spawns `upgrade.js` **detached**, returns immediately; UI polls `/health` (120s) then `/dev-mode/upgrade-log` (30s, completion = the string `"upgrade finished"`).
- Amber warning when `isCustomBuild && source=latest` ("…will REPLACE your custom build").

### 4c. The engine — **`core/scripts/upgrade.js`** (the root `scripts/upgrade.js` is a TEST STUB)
Ordered steps (same for CLI + web; log `~/.cache/lm-assist/upgrade.log`):
1. **Plugin install** `claude plugin install lm-assist@langmartai` — **skipped when custom** (`--from` non-latest) or no `claude` in PATH.
2. **Kill** ports 3100/3848/**3200/3948** — Linux `fuser -k`, macOS `lsof -ti`+`process.kill`, **Windows `netstat -ano`+`process.kill`** (NEVER `taskkill`); clean `.pid` files; Windows also `Stop-Process` every `node.exe` with `lm-assist` in cmdline. Wait 8s (Win) / 2s.
3. **`npm install -g <spec>`** — Windows EBUSY fallback `upgradeViaTarball()`: use the local `.tgz` (or `npm pack <spec>`), extract with `C:\Windows\System32\tar.exe` (git-tar misreads `C:` as a host), `robocopy /E /IS /IT /IM` in place (no rename, **no** `/XD node_modules`), `npm install --omit=dev --ignore-scripts`. 🔴 `/IS /IT /IM` are load-bearing (a list-only run on the Windows node classified `package.json` as "Modified" — same size, same mtime, different change time — which only `/IM` copies): npm normalizes every tarball mtime to one 1985 timestamp, so a change that keeps a file's size (`package.json` `0.2.2`→`0.2.3`, the plugin manifests, Next's `BUILD_ID`/build manifests — 29 files in 0.2.3) reads as "Same" and was silently skipped: the node ran the new code while reporting the old version, with a web build id that did not match its chunks. And a bare `/XD node_modules` also excluded `web/.next/standalone/node_modules` — the only `node_modules` a tarball ships — so once a failed `npm install -g` attempt had pruned the old copy the web died with `Cannot find module 'next'`. **Verify a Windows upgrade by content**: `/health` version, `web/.next/BUILD_ID` equal to the tarball's, `standalone/node_modules/next` present, `:3848` answering.
4. **Write `install-source.json`** + **`lm-assist restart`** — **`restart`, NOT `start`** (a mid-install self-heal can respawn Core with stale code; `start` would no-op it).

**No downgrade guard** in `upgrade.js` — it will happily downgrade. The strict-greater gate lives only in `lm-assist version` and `/dev-mode/check-update` (which therefore **never** offer an upgrade while installs > npm's 0.1.70).

### 4d. BOOTSTRAP trap + dormant-file shortcut
- The host's **already-installed** `upgrade.js` must support `--from`; if it's too old, run the new one straight from the tgz:
  `tar -xzO package/core/scripts/upgrade.js < x.tgz > /tmp/u.js && node /tmp/u.js --from <abs-tgz>`.
- `upgrade.js` is **dormant** (only read when an upgrade runs, never by the running server) → ship a fix to it fleet-wide with a plain `cp` into each global `core/scripts/upgrade.js`, **no restart**.

---

## 5. DEPLOY — push new code onto EXISTING installs (the ops path; what we actually use)

**This is NOT install/upgrade** — it overlays new code on running installs without npm. It's how the fleet got every feature this session. **Caveat up front:** a dist-sync leaves `package.json` version + `install-source.json` **stale** (they reflect the last real install, not the synced code), so `lm-assist version` / check-update misreport, and a future `lm-assist upgrade` (npm latest) would **revert** it. Use `upgrade --from <tgz>` for a durable rollout, or bump+pack+install a real version (§6).

### 5a. Core-only changes (the common case)
`./core.sh build` → sync `core/dist` (+ `core/scripts` if changed) per node → restart. No per-OS rebuild (pure JS).

| Node | Install root | Sync | Restart |
|---|---|---|---|
| **117** ubuntu (this box) | `~/.nvm/versions/node/v20.19.6/lib/node_modules/lm-assist` | `rsync -rc core/dist/ <root>/core/dist/` | `lm-assist restart` |
| **123** node-b (`ssh -i ~/.ssh/ssh-keys/id_rsa yi@192.0.2.23`) | `/usr/lib/node_modules/lm-assist` | **`rsync -rc -e "ssh -i …" --rsync-path="sudo rsync" core/dist/ yi@…:<root>/core/dist/`** (root-owned `/usr/lib`; plain rsync → `Permission denied (13)` and the restart loads STALE code) | `ssh … sudo systemctl restart lm-assist` (Core is **systemd**; do NOT use `lm-assist restart`) |
| **107** Windows (`ssh -i ~/.ssh/langmart_admin_key admin@192.0.2.7`) | `C:\nvm4w\nodejs\node_modules\lm-assist` | `zip -rq core/dist scripts` → `scp -i <key>` → on 107: stop the `:3100` owner via **`Stop-Process`/`process.kill`** (NEVER `taskkill` over SSH — it hangs), `Expand-Archive -Force <zip> -DestinationPath <root>\core` | **`schtasks /run /tn LmAssistCoreInteractive`** (Session 1; NEVER raw SSH `lm-assist restart` → Session 0, breaks terminal-driving) |

Graceful alt for the restart: **`node_lifecycle` / `POST /lifecycle/restart`** (self-respawn, no force-kill). Verify each node post-deploy by a unique marker in the running dist (e.g. `grep canonicalByWorktree …/session-footprint-collector.js`) + `/health`.

### 5b. Web changes
Build standalone (Node 20, `NEXT_PUBLIC_LOCAL_API_PORT=<port> next build`) → **copy `.next/static` → `.next/standalone/web/.next/static`** (NOT auto-bundled) + `public` → rsync the complete `…/standalone/web/` → restart web. (117's `lm-assist restart` does the static copy itself; 123/107 you do it.) A page returning 200/307 is NOT proof — verify a real `/_next/static/chunks/<x>.js` → 200.

---

## 6. Current fleet state (2026-07-01 snapshot) + how to make it clean

> **UPDATE 2026-09-01:** v0.2.0 is published to npm and as a GitHub Release
> (`releases/download/v0.2.0/lm-assist-0.2.0.tgz`); the three version files = 0.2.0.
> The snapshot below describes 2026-07-01; the clean-up recipe still applies — run it
> with 0.2.0.

- **`main` = `e7ccc5e`** (pushed to origin). 3 version files = **0.1.133**. **npm latest = 0.1.70; 0.1.133 is NOT on npm.**
- Fleet **runs `e7ccc5e` dist** (verified by marker) on these BASE npm-installs: **117 = 0.1.133, 123/107 = 0.1.127** → `lm-assist version` **misreports** (says 0.1.133/0.1.127; actually runs `e7ccc5e`). `install-source.json`: 117 `published@0.1.133` (really a local build — the label is misleading), 107 `published@0.1.126`, 123 absent.
- **No `.tgz` captures the deployed code** — it was dist-synced. Newest tgz on disk = 0.1.126 (117) / many ≤0.1.126 (123) / none (107).

**To get a reproducible, upgrade-safe, correctly-versioned fleet:**
1. **Bump** the 3 version files to **0.1.134** (distinguishes the features that sit on top of 0.1.133's base).
2. **`npm pack`** → `lm-assist-0.1.134.tgz` (captures `e7ccc5e`).
3. **commit + push** the bump.
4. *(optional, makes versions honest fleet-wide)* `lm-assist upgrade --from lm-assist-0.1.134.tgz` on each node → consistent 0.1.134 + correct `install-source.json` + accurate `version`/check-update + future-upgrade-safe (until 0.1.134+ is the npm `latest`).

---

## Gotchas index
- **chokidar `^3.6.0`** only (v4/v5 ESM → `ERR_REQUIRE_ESM`); fixed on npm as of 0.2.0 — only ≤0.1.70 installs re-break it.
- **Agent SDK** dynamic `import()` must survive tsc (`new Function('m','return import(m)')`).
- Run `npm` from **repo root**; Node **≥20.9**.
- **`taskkill` hangs** on Windows over SSH → `process.kill` / `Stop-Process`.
- **107 Core must run in Session 1** (`LmAssistCoreInteractive` scheduled task) or terminal-driving breaks; SSH restarts regress it.
- **123 Core = systemd** (`sudo systemctl restart lm-assist`); its web is a separate detached process.
- **LMDB session-cache** is dev/prod-separated (`session-cache` vs `session-cache-dev`).
- Root **`scripts/upgrade.js` is a stub**; the real engine is `core/scripts/upgrade.js`.
- **`install.sh` doesn't auto-start** (postinstall does); `--dev` starts nothing.
- **dist-sync** → stale `install-source.json` + `package.json` version → misreporting + revert-on-`upgrade` risk.
- **Web upgrade** has no post-spawn race guard (double-click = two detached upgrades).
