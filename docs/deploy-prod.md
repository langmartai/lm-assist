# Prod redeploy (`core/scripts/deploy-prod.sh`)

A safe, repeatable way to push a freshly-built `core/dist` into the **prod**
(npm-global) install and restart **only** the prod Core — the prod Web on
`:3848` keeps running. This is the scripted, guard-railed version of the manual
prod redeploy.

> **Scope:** PROD only (Core API `:3100`). It never touches the dev repo
> services (`:3200`/`:3948`). For dev, keep using `./core.sh`.

## What it does

1. **Build** `core/dist` from the target git ref — `./core.sh build`.
2. **Mirror** `core/dist` → `<prod>/core/dist` with `rsync --delete`, so prod
   matches the build **exactly**.
   - `--delete` is essential: prod accumulates **stale artifacts** from versions
     before a module was removed from `main` (e.g. `milestone/`,
     `architecture-llm`, `terminal-manager`, `source-scanner`,
     `hook-event-store`). A plain `rsync` without `--delete` orphans them on
     disk; `--delete` cleans them out.
3. **Core-only restart** — kill the prod core pid
   (`~/.cache/lm-assist/core-prod.pid`), then `lm-assist start`. The Web process
   is already up, so only Core comes back.
4. **Verify** `/health` (`status=healthy`, `runningFrom=npm`, fresh `uptime`,
   new pid, version) and `/hub/status` (`connected` + `authenticated`).
5. *(optional)* Remind you to refresh the claude.ai connector tool cache when
   MCP tool schemas changed.

## Safety checks (enforced **before** prod is touched)

| Guard | Behavior |
|-------|----------|
| **Clean tree + intended ref** | Refuses a dirty working tree (override `--allow-dirty`); confirms HEAD is on the `--ref` you asked for (checks it out if clean). |
| **Build first** | Runs the build before anything else and **aborts** if it fails. |
| **rsync dry-run** | Runs `rsync -ani --delete` and prints every add/update **and** every deletion. Deletions are split into **expected stale** (an allowlist of known-removed modules) vs **UNEXPECTED**. Any unexpected deletion **aborts** unless `--force`. |
| **No downgrade** | Compares built vs deployed `package.json` versions and **refuses a downgrade** unless `--force`. |
| **Dangling-require sanity** | After the sync, greps the deployed dist for `require()`s pointing at removed modules and warns if any remain (would break boot). |
| **Dynamic prod path** | Resolves the prod install via the `lm-assist` binary / `npm root -g` — never hardcodes the node version — and invokes `lm-assist` with the node PATH it lives under. |
| **Final confirm** | Prompts before mutating prod (skip with `--yes`). |

## Usage

```bash
# Standard redeploy from current HEAD, with an interactive confirm:
core/scripts/deploy-prod.sh

# Deploy a specific tag, non-interactive:
core/scripts/deploy-prod.sh --ref v0.1.73 --yes

# See exactly what WOULD happen, change nothing (great for review/CI):
core/scripts/deploy-prod.sh --dry-run

# Override the refusals (unexpected deletions / downgrade) — deliberately:
core/scripts/deploy-prod.sh --force
```

### Options

| Option | Meaning |
|--------|---------|
| `--ref <git-ref>` | Deploy from this ref (default: current HEAD). Checks it out if the tree is clean. |
| `--force` | Override the unexpected-deletion **and** downgrade refusals. |
| `--allow-dirty` | Skip the clean-working-tree check. |
| `--skip-build` | Deploy the existing `core/dist` as-is (must already be built). |
| `--no-restart` | Sync only; do not kill/restart prod core (no verify). |
| `--refresh-tools` | Print the connector tool-cache refresh reminder after deploy. |
| `--yes`, `-y` | Non-interactive: skip the final confirmation prompt. |
| `--dry-run` | Show the full plan + rsync dry-run; make **no** changes. |
| `-h`, `--help` | Help. |

### Exit codes

`0` success · `1` usage/precondition · `2` build failed ·
`3` unexpected deletions · `4` version downgrade · `5` verify failed

## When MCP tool schemas changed

If this deploy changes MCP tool definitions, the claude.ai connector caches the
old tool list. Refresh it (then start a **fresh** session to see the new tools):

- via the lm-assist MCP: `refresh_connector_tools(connector="langmart")`, or
- the claude.ai connector settings → **refresh tools** button.

Pass `--refresh-tools` to have the script print this reminder at the end.
