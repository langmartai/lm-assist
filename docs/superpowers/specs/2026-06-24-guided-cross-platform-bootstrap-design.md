# Guided Cross-Platform Bootstrap — Design

**Date:** 2026-06-24
**Status:** Approved (design)
**Goal:** A *proper* guided bootstrap/install process for lm-assist that works on **Windows and Linux** across **different Node.js versions**, by reviewing and reusing the existing install/upgrade handling and filling the gaps. Backed by **one shared preflight** that is the single source of truth for environment requirements.

---

## 1. Motivation — what is broken today

Verified by inventory of the current install/upgrade/bootstrap surface:

1. **`install.sh` has the wrong Node gate.** It checks `node >= 18` (`install.sh:36,41-42`) but the Next 16 web build requires **Node ≥ 20.9**. A host on Node 18–20.8 passes the check, then fails at `npm run build` (`install.sh:81`) with a confusing error.
2. **`install.sh` uses a plain `npm install`** (`install.sh:78`) which dies on the `onnxruntime-node` native postinstall (pulled transitively via `@huggingface/transformers` / `@lancedb`: *"Cannot find module …/global-agent/…"*). The dev tree needs `--ignore-scripts`.
3. **`install.sh` never verifies the chokidar pin.** chokidar 4/5 are ESM-only → `require()` throws `ERR_REQUIRE_ESM` → Core won't boot. The pin (`^3.6.0`) must be confirmed to actually resolve to 3.6.0.
4. **There is no Windows installer.** Zero `*.ps1` / `*.cmd` / `*.bat` install files exist in the repo — every Windows helper is generated inline from TS/JS at runtime. Windows users have no guided path equivalent to `install.sh`.
5. **`engines` is inconsistent.** Root and `core/package.json` declare `node >= 18`; `web/package.json` declares nothing — all contradict the real `>= 20.9` requirement documented in `CLAUDE.md:635` and `guide.ts:113`.
6. **The guided text is Linux-centric.** `guide("install")` and `buildBootstrapInstruction()` (cloud self-heal) assume bash / `./core.sh` / `curl localhost`. A Windows node (the `claude-code-windows-setup` host) following them gets the wrong commands.

There is, however, a lot to **reuse**: `core/scripts/upgrade.js` already has cross-platform Windows handling (System32 `tar.exe`, `robocopy /E` overwrite-in-place, PowerShell process-kill, EBUSY fallback); `core/src/service-manager.ts` has Windows detached spawn (WMI `Win32_Process.Create` + `.cmd` wrapper) and Session-1 handling; and the `guide("install")` text is technically accurate for Linux.

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Bootstrap form | **Unified preflight + both installers + OS-aware guide.** One source of truth. |
| Node-too-old policy | **Guidance only.** Detect which manager is present (nvm / nvm-windows / fnm) and print the exact per-OS upgrade command, then hard-fail. **Never** install or switch Node automatically. |
| Installer interactivity | **Non-interactive** with flags (CI/agent-friendly). |
| `engines` | Reconcile to `>=20.9.0` (root + core + web) as **documentation**; **not** `engine-strict` (would hard-break `npm install`). |
| Windows installer | PowerShell **`install.ps1`** + an `irm …/install.ps1 | iex` one-liner, mirroring `install.sh`. Bash-free (no `core.sh` dependency). |
| Hub connection | Unchanged — remains a **separate, user-confirmed** step (`lm-assist setup --key …`). The installer connects to nothing and writes no hub key. |
| Testing | **Real Linux + Windows e2e** (plus unit tests for the preflight). |

---

## 3. Architecture

```
                       ┌───────────────────────────────┐
                       │  scripts/preflight.js          │  ← single source of truth
                       │  (dependency-free CommonJS;    │
                       │   runs on ANY Node, incl. old) │
                       │  checks env, emits human/JSON, │
                       │  exits non-zero + guidance     │
                       └───────────────────────────────┘
                          ▲          ▲            ▲
            post-clone    │          │            │  referenced by (text mirror)
          ┌───────────────┘          │            └───────────────────────────┐
          │                          │                                        │
  ┌───────────────┐         ┌─────────────────┐                     ┌───────────────────┐
  │  install.sh   │         │  install.ps1    │                     │  guide("install") │
  │  (Linux)      │         │  (Windows, new) │                     │  + buildBootstrap │
  │  bare gate +  │         │  bare gate +    │                     │  Instruction()    │
  │  preflight    │         │  preflight      │                     │  (OS-aware text)  │
  └───────────────┘         └─────────────────┘                     └───────────────────┘
          │                          │
          │   hand off to existing service start (by MODE, not OS):
          │     • prod (default) → npm pack → npm install -g ./tgz → postinstall/lm-assist start
          │                         → service-manager.ts (WMI / Session-1 on win32), ports :3100/:3848
          ▼                          ▼ • --dev → ./core.sh start (Linux) | node bin/lm-assist.js (Win), :3200/:3948

  Post-install:  lm-assist doctor ──► scripts/preflight.js  (diagnosis)
```

**Why a Node script is the source of truth, not shell:** the rich checks (chokidar resolution, workspace layout, structured guidance) are identical across OSes and must not drift across bash/PowerShell/TypeScript. A dependency-free CJS script runs on **any** Node — including a too-old one — so it can *itself* report "your Node is too old." The only thing the shells must do natively is the **bare** "is `node`/`git` on PATH and what major.minor" check, because that necessarily precedes the ability to run a Node script at all.

---

## 4. Components

### 4.1 `scripts/preflight.js` — the preflight / doctor engine

- **Language/constraints:** plain CommonJS, **zero dependencies**, only Node built-ins (`child_process`, `fs`, `os`, `process`). Must parse and run on Node ≥ ~14 (so it can diagnose a too-old Node). No optional chaining-on-call quirks that break old Node; keep it conservative.
- **Invocation:** `node scripts/preflight.js [--json] [--phase=pre-clone|post-clone] [--repo=<dir>]`.
- **Checks:**
  | Check | Phase | Hard? | Detail |
  |---|---|---|---|
  | `node` present & **≥ 20.9.0** | both | **hard** | Parse `process.version`. The Next-16 gate. |
  | `git` present | both | hard | `git --version`. |
  | `npm` present | both | hard | `npm --version`. |
  | OS / arch | both | info | `process.platform`, `process.arch`. |
  | **chokidar resolves to 3.6.0** | post-clone | **hard** | `require.resolve('chokidar', {paths:[<repo>/core/dist]})` then read its `package.json` version; must be `3.6.x` and must not throw. |
  | workspace root sane | post-clone | warn | repo has root `package.json` with `workspaces`, and no stray `core/node_modules/chokidar`. |
- **Output:**
  - Default: human-readable report, one line per check (`✓`/`✗`/`•`), then, on failure, a **Guidance** block.
  - `--json`: `{ ok:boolean, platform, arch, nodeVersion, checks:[{name, ok, hard, detail}], guidance:string|null }`.
- **Exit code:** `0` iff every **hard** check passes; otherwise non-zero.
- **Node-too-old guidance (policy = guidance only):** detect an installed version manager and print the exact command:
  - nvm (`$NVM_DIR` or `~/.nvm`): `nvm install 20 && nvm use 20`
  - fnm (`fnm` on PATH): `fnm install 20 && fnm use 20`
  - nvm-windows (`nvm` on PATH on win32, or `%NVM_HOME%`): `nvm install 20.19.6` then `nvm use 20.19.6`
  - none: link to `https://nodejs.org/` (LTS ≥ 20.9) with the platform-appropriate note.
  - **Never** runs any of these — it only prints them.

### 4.2 Install modes (both installers, symmetric)

To keep Linux and Windows on the **same logical flow** and to land a node on the **correct ports**, both installers default to a unified **prod** flow and offer a `--dev` opt-in:

- **prod (default)** — produces a working `lm-assist` CLI + services on the **prod** ports **:3100 / :3848**. This is the canonical "make this host a fleet node" target: the hub relay, the `mcp.langmart.ai` connector path, and "MCP down" detection all key off prod **:3100**. Flow: clone → preflight → `npm install --ignore-scripts` (root build-deps; the onnxruntime fix) → `npm pack` (its `prepare` builds core+web → `lm-assist-<ver>.tgz`, which **carries the chokidar `^3.6.0` pin** so it is registry-hazard-free) → `npm install -g ./lm-assist-*.tgz` (prod-only dep tree installs **clean**, compiles `better-sqlite3`; `postinstall.js` auto-starts services + installs the plugin) → verify `:3100` health + `:3848` 307. If a CLI already exists, the equivalent is `lm-assist upgrade --from ./lm-assist-*.tgz`.
- **`--dev`** — the repo/developer path on the **dev** ports **:3200 / :3948** for working *on* lm-assist itself: clone → preflight → `npm install --ignore-scripts` → build → start dev services (Linux: `./core.sh start`; Windows: `node bin/lm-assist.js` in dev mode). Runs side-by-side with prod (separate port spaces).

`--ignore-scripts` is required in **both** modes because both begin with a root install of the full (dev) dep tree, whose transitive `onnxruntime-node` postinstall is what dies; the *global* install in step `npm install -g ./tgz` uses the prod-only tree and installs clean without it.

### 4.3 `install.sh` (Linux) — corrected

Keep its overall shape (prereqs → plugin → clone → install/build → start → next steps). Changes:
1. Replace the `node >= 18` block (`install.sh:36,41-43`) with a **bare gate** (is `node`/`git`/`npm`/`claude` present; if `node` missing or clearly < 20, fail fast pointing at the Node guidance — a minimal inline major-version parse so we fail before cloning).
2. After clone/pull, run **`node scripts/preflight.js --phase=post-clone --repo="$INSTALL_DIR"`** as the authoritative gate; abort on non-zero (its guidance is already printed).
3. Change `npm install` → **`npm install --ignore-scripts`** (the onnxruntime fix); keep `--no-audit --no-fund`.
4. chokidar verification is now covered by the post-clone preflight (remove any ad-hoc check).
5. Run the **prod (default)** flow from §4.2 (`npm pack` → `npm install -g ./tgz` → verify), or the **`--dev`** flow (`./core.sh start`). "Next steps" output adapts to the chosen mode (prod → `lm-assist status` + new session + `/assist-setup`; dev → `./core.sh status`).

### 4.4 `install.ps1` (Windows) — new

PowerShell mirror of `install.sh`, invocable as `irm https://raw.githubusercontent.com/langmartai/lm-assist/main/install.ps1 | iex` (and runnable as a file). Same phases and the **same two modes** as §4.2:
1. **Bare gate:** `git`, `node`, `npm`, `claude` on PATH; minimal `node -v` major parse → fail fast with a pointer to the Node guidance if missing/too-old.
2. **Plugin:** `claude plugin marketplace add langmartai/lm-assist` + `claude plugin install lm-assist@langmartai` (best-effort, same as Linux).
3. **Clone/pull** to `$env:LM_ASSIST_DIR` (default `$env:USERPROFILE\lm-assist`).
4. **Authoritative preflight:** `node scripts\preflight.js --phase=post-clone --repo=<dir>`; abort on non-zero.
5. **`npm install --ignore-scripts`**.
6. **prod (default):** `npm pack` → `npm install -g .\lm-assist-*.tgz`. Service start is **handed off to the existing Windows-aware path** — `install.ps1` does **not** reimplement spawning; `postinstall.js` (or an explicit `lm-assist start`) drives `service-manager.ts` `spawnDetachedWin32()` (WMI `Win32_Process.Create` + `.cmd` wrapper, Session-1 aware). Where a running install must be replaced it reuses `upgrade.js`'s Windows primitives (System32 `tar.exe`, `robocopy /E`, PowerShell process-kill) by **calling `lm-assist upgrade --from`**, not duplicating them. **`--dev`:** build, then `node bin\lm-assist.js` dev start (no `core.sh`).
7. **Next steps** output adapted for Windows (`lm-assist start` / `lm-assist status` and `/assist-setup`).

> The spec fixes the **contract and the mode/port semantics** (bare gate → preflight → `--ignore-scripts` install → prod tgz global install (default) or `--dev` build → hand off to existing start/upgrade handling). Byte-exact commands are settled in the plan and proven by the e2e tests.

### 4.5 `lm-assist doctor` (CLI subcommand) — new

- Add `doctor` to `bin/lm-assist.js`'s command list and dispatch.
- It resolves the repo/install root (same resolution `bin/lm-assist.js` already does for `getProjectRoot`) and runs `node scripts/preflight.js --phase=post-clone --repo=<root>`, printing the report. Optional `--json` passthrough.
- Purpose: post-install self-diagnosis ("why won't Core boot?" → chokidar/Node check in one command), and the thing `guide()` tells an agent to run.

### 4.6 `engines` reconciliation

- Root `package.json` and `core/package.json`: `"engines": { "node": ">=20.9.0" }`.
- `web/package.json`: add `"engines": { "node": ">=20.9.0" }`.
- **Do not** add `.npmrc` `engine-strict=true` (it would convert the existing soft warning into a hard `npm install` failure on slightly-old Node, defeating the friendly preflight guidance). Enforcement stays with the preflight; `engines` is documentation/honesty.

### 4.7 OS-aware guide + cloud self-heal

- **`guide("install")`** (`core/src/mcp-server/tools/guide.ts`): branch the command examples by platform — Linux (`./core.sh`, `curl localhost`) vs Windows (`lm-assist start/status`, PowerShell `irm | iex`, `Invoke-WebRequest`/`curl.exe`), and point readers at `install.sh` / `install.ps1` and `lm-assist doctor`. Keep the Node ≥ 20.9, `--ignore-scripts`, and chokidar-pin facts (already correct) and make the Node-too-old remedy reference the manager-detection behavior.
- **`buildBootstrapInstruction()`** (`core/src/terminal/ccr-cloud.ts`): add the Windows branch so a Windows worker (e.g. `claude-code-windows-setup`) self-installs with the right commands instead of bash. Keep "hub is a separate user-confirmed step."

---

## 5. Data flow

- **Installer:** native bare gate → (clone) → `node scripts/preflight.js --json` → on `ok:false` print guidance + exit; on `ok:true` proceed to install/build/start → verify health endpoint.
- **`lm-assist doctor`:** → `preflight.js` → report (exit code mirrors `ok`).
- **`guide()` / bootstrap:** static OS-aware text that **mirrors** the preflight's requirements (no runtime call; it's guidance for an agent/human who may not have the repo yet).

The single source of truth for *requirements* is `preflight.js`; the guide text mirrors it and must be kept in sync (a self-review checklist item, same as the existing CLAUDE.md↔guide.ts sync convention).

---

## 6. Error handling

- **Missing prereq (git/npm/claude/node):** bare gate fails fast in the installer's native language with a one-line install pointer.
- **Node too old:** preflight prints the manager-specific upgrade command and exits non-zero; the installer stops (does not attempt the build that would fail confusingly). Nothing is auto-installed.
- **chokidar resolves to 4/5 (or throws):** preflight hard-fails post-clone with the documented recovery (`npm install chokidar@^3.6.0 --ignore-scripts`; remove nested `core/node_modules/chokidar`).
- **Windows service start fails / Session-0:** the existing `service-manager.ts` / `windows-terminal.ts` messaging applies ("run the Core in the interactive desktop session"); the installer surfaces it rather than masking it.
- **`install.sh` web "Failed to start" false-negative** (307 redirect on `/`): documented; the installer/verify step treats a 307 on `:3948`/`:3848` as healthy.

---

## 7. Testing (real Linux + Windows e2e)

- **Unit (`preflight.js`):** drive it with mocked `process.version` (`18.x`, `20.8.0`, `20.9.0`, `22.x`), `process.platform` (`linux`, `win32`), and manager-presence permutations (nvm / fnm / nvm-windows / none). Assert: exit code, `ok`, the specific `guidance` string per case, and the `--json` shape. (Runnable on the dev host with the project's `node --test`.)
- **Linux e2e:** run the corrected `install.sh` end-to-end on a clean-ish environment (fresh clone dir, node ≥ 20.9). **prod (default):** assert clone → preflight passes → `--ignore-scripts` install → `npm pack` → `npm install -g ./tgz` → services report healthy on prod ports (Core `:3100/health`; web `:3848` 307). Also exercise **`--dev`** once (services on `:3200/:3948` via `./core.sh start`). Separately, force a too-old Node (e.g. a shimmed `node` printing `v18`) and assert the guidance path prints the nvm/fnm command and aborts before build.
- **Windows e2e:** run `install.ps1` on the real Windows host (`claude-code-windows-setup` if reachable, else 107), **prod mode**: assert clone → preflight → `--ignore-scripts` install → `npm pack` → `npm install -g .\tgz` → services up via the WMI/Session-1 path on `:3100/:3848`, and that the Node-too-old guidance is the nvm-windows command. (Respects the documented Windows constraints: scp with `-i` key; Core in interactive Session 1; `robocopy`/`tar.exe` reuse only via `lm-assist upgrade --from` if replacing a running install.)

**Success criteria:** a fresh Windows *and* a fresh Linux host can go from "git + a Node (any version)" to "lm-assist services healthy" by following exactly one guided path, with a clear, correct, non-destructive message when their Node is too old — and the same requirements are stated identically by the installer, `lm-assist doctor`, and `guide("install")`.

---

## 8. Out of scope (YAGNI)

- Auto-installing or switching Node (explicitly rejected — guidance only).
- An interactive wizard / TUI.
- macOS-specific installer (the Linux `install.sh` + preflight already cover macOS bash; a dedicated mac path is not requested).
- Changing the hub connection flow (stays a separate user-confirmed step).
- Reworking `upgrade.js` internals (we *reuse* them; we don't rewrite them).

---

## 9. Reuse map

| Need | Reused from |
|---|---|
| Cross-platform service start (incl. Windows WMI / Session-1) | `core/src/service-manager.ts` (`startAll`, `spawnDetachedWin32`) via `lm-assist start` |
| Windows in-place update primitives (tar.exe, robocopy, PS kill) | `core/scripts/upgrade.js` via `lm-assist upgrade --from` |
| Canonical install recipe text | `core/src/mcp-server/tools/guide.ts` (`install` topic) |
| Cloud self-heal instruction | `core/src/terminal/ccr-cloud.ts` (`buildBootstrapInstruction`) |
| Linux prereq + clone/build shape | existing `install.sh` |
| In-Claude-Code setup | `commands/assist-setup.md` |
