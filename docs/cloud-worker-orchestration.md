# Cloud-worker orchestration

How lm-assist turns ephemeral cloud Claude Code sessions into **role-aware workers** that an
orchestrator can drive, with the worker-role tools available and a hard agree-gate. This is the
process that was built and proven end-to-end (substrate → bootstrap → enroll → keystone → agree-gate).

## The pieces

- **Platform** — lm-assist + its MCP tool surface (the `/mcp` endpoint: `set_role`, `report_status`,
  `decide_gate`, `worker_status`, `list_workers`, `bootstrap`, `guide`, plus the search/data/memory
  families).
- **Infra** — cloud Claude Code sessions (BYOC, `environment_kind: anthropic_cloud`). Ephemeral VMs:
  on resume the **disk persists** but **processes die**; `lm-assist start` recovers Core in ~12 s from
  the on-disk build (no reinstall).
- **Processes** — bootstrap/self-heal, enrollment, and the decomposed-orchestration control loop.

## Lifecycle of a cloud worker

1. **Create** — `ccr_cloud_start` (`POST api.anthropic.com/v1/sessions`, **Claude Code OAuth**,
   `anthropic-beta: ccr-byoc-2025-07-29`). Optional `role` (`worker`/`orchestrator`) and
   `setup: true` prepend the bootstrap self-heal instruction.
2. **Bootstrap self-heal** — we actively SEND `buildBootstrapInstruction({role, primaryRepo})` at the
   top of every START + RESUME turn (`cloudStart`, `cloudDrive({reBootstrap:true})`). The agent
   health-checks lm-assist and restarts/installs it locally as needed (Case A: the repo *is*
   lm-assist → build from it; Case B: another repo → install lm-assist as a separate tool, then return
   to the task).
3. **Enroll** — `lm-assist login <keypack>` redeems a one-time keypack → the hub mints a long-term
   `sk-langassist` node key (stored in `~/.lm-assist/hub.json`). No hub key is ever embedded in a
   prompt/transcript.
4. **Keystone (get the worker-role tools)** — on enroll, `lm-assist login` also writes a Claude Code
   MCP config (`~/.claude.json` → `mcpServers["lm-assist-hub"]`) pointing at the always-up
   `https://mcp.langmart.ai/mcp`, authed by the node's `sk-key` as a `Bearer`. The node's **next**
   Claude Code session then loads the full worker-role toolset. (`--no-mcp` opts out; the file is
   written `0600`.)

## Why the keystone (and not the account connector)

A cloud worker created via `ccr_cloud_start` gets **no** claude.ai account connector — only the repo's
`github` MCP. Connector-injection is a **claude.ai cookie / web-account** feature of the web-UI
launcher (`claude.ai/v1/code/sessions`); it is NOT triggered by OAuth, the endpoint path, or our BYOC
create. (Verified: OAuth `POST /v1/code/sessions` → a `cse_` session with tools = "None".) And even a
web-UI session's connector is filtered by the account's `enabled_mcp_tools` — it lacks
`set_role`/`report_status`.

The keystone sidesteps all of that: a **local** `--mcp-config` http server pointed at the hub `/mcp`
gets the **raw full tool list** (incl `set_role`), is **always-up** (no startup-ordering problem like
local Core, which only binds mid-first-turn), and uses **OAuth + sk-key only — no cookie**.

## Auth map (cloud-session ops)

| Host / endpoint | Auth | Used for |
|---|---|---|
| `api.anthropic.com/v1/sessions`, `/v1/code/sessions/{sid}/...` | **Claude Code OAuth** (`~/.claude/.credentials.json`, auto-refresh on 401/403) | our create / drive / read / status / stop |
| `https://mcp.langmart.ai/mcp` | **node `sk-key`** Bearer | the keystone MCP a worker's agent calls |
| `claude.ai/*` | cookie (`~/.claude/claudeai-session.json`) | claude.ai account ops; **the web-UI connector-injecting create** (not used by us) |

Rule of thumb: `api.anthropic.com/*` → OAuth; `claude.ai/*` → cookie. Our cloud tooling is **OAuth +
sk-key only, no cookie**, by design.

## The orchestration control loop

- **Roles** — one active role per session (`worker` / `orchestrator`), surfaced via `bootstrap`.
- **Worker-owned task list** — hierarchical (groups / sub-tasks); a worker reports its *own* tasks,
  not only ones an orchestrator assigned.
- **Agree-gate (universal)** — before any sensitive step (commit / push / PR / destructive action) a
  worker emits `report_status status:need_approval` and STOPS until the orchestrator calls
  `decide_gate`.
- **Three status channels** — Way 1: print a `⟦WORKER-STATUS⟧` block every turn (fundamental, needs no
  infra); Way 2: the worker calls `send_session_message` itself; Way 3: `report_status` → the local
  `~/.lm-assist/workers.json` store (read by `worker_status` / `list_workers`).

Until the keystone is in place on a worker, a cloud agent has no `report_status`/`decide_gate`, so the
control plane (a node that *does* have the tools, e.g. via the connector) drives via Way-1 text + the
cloud drive/answer API. With the keystone, the worker self-runs the real agree-gate.

## Gotchas

- A cloud worker without the worker-role tools falls back to Claude Code's built-in `AskUserQuestion`
  for its gate. Clearing it via `POST /ccr/cloud/:sid/answer` needs the **explicit `toolUseId`** — the
  auto-find first attempt may not resume the session, and a plain `/drive` does not unblock a session
  blocked on a tool_use.
- After any `refresh_connector_tools` / reconnect, re-run **auto-approve** — always-allow is
  version-pinned, so a reload silently reverts tools to "ask".
- Keep cloud tooling on **OAuth + sk-key**; do not introduce a cookie dependency.
