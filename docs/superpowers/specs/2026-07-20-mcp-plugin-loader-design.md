# lm-assist Third-Party MCP Tool Plugin Loader ("MCP scriptball") — Design

**Goal:** Let a third party (e.g. the chart team) ship a TypeScript script that defines
MCP tools wrapping their own API, and have lm-assist **auto-load the tool definitions and
register them into its MCP surface** (both the stdio plugin and the hub `/mcp` connector),
executing them **safely** on demand.

**Coordination:** built by two sessions the mission controller coordinates —
Child A (lm-assist core loader, the "MCP tools" session `750fd632` / repo `lm-assist`) and
Child B (chart-API MCP plugin, the chart session `ce4cd7ce` / repo `lm-unified-trade`).

---

## Architecture — subprocess MCP aggregation (chosen)

The third-party "script" IS a **standard MCP stdio server** (the .ts the plugin author
writes). lm-assist becomes an **MCP aggregator/client**: it reads each enabled plugin's
manifest, registers its tools under an `ext__<plugin>__<tool>` namespace, and spawns the
server as a **child process** only when a tool is called (lazy) or kept warm if declared.

Rejected alternatives: **in-process dynamic import** (third-party code would run with
lm-assist's full privileges — OAuth tokens, hub keys, fs — unacceptable) and a **VM/worker
sandbox** (in-process, complex, JS sandboxes leak). A subprocess gives OS-level isolation
and a controllable environment — and it is how MCP is designed (servers are separate
processes).

## Plugin package

A directory under `~/.lm-assist/mcp-plugins/<name>/` (or a registered dataset entry):

- **`mcp-plugin.json` manifest** — the "definition auto-load" surface:
  - `name`, `version`, `description`, `author`
  - `tools[]`: `{ name, description, inputSchema }` — so lm-assist can list/register the
    tools **without executing anything**; the process spawns only on first call.
  - `entry`: the server command (e.g. `node dist/server.js`)
  - `capabilities`: `{ network: string[] (hosts), fs: string[] (paths), env: string[] }` —
    everything the plugin needs; undeclared access is denied.
  - `checksum`: hash of the plugin payload, pinned at enable time.
- the MCP stdio server itself.

## Security model (the core requirement)

1. **Discovery ≠ execution.** A dropped-in plugin lands **`disabled`**; nothing spawns.
   Its manifest is parsed and shown for review.
2. **Human enable gate.** Enabling is a **loopback-only / owner action** (like machine-access
   and cluster writes) — never via LAN/hub relay, never by the controller autonomously.
   Enabling records the approved **checksum**; a changed payload auto-reverts to `disabled`
   pending re-approval (the pin discipline of the tool/workflow/content registries).
3. **Isolation.** Spawned as a subprocess with a **minimal environment** — NO OAuth token,
   NO hub key, NO lm-assist api-token, NO `~/.lm-assist` creds — unless the manifest
   declares a specific need and the user grants that scope.
4. **Capability allow-list.** The manifest declares network hosts + fs paths; lm-assist
   enforces them; undeclared = denied.
5. **Namespacing / no shadowing.** Third-party tools are prefixed `ext__` so they can never
   impersonate or shadow a built-in lm-assist tool; callers always see it's third-party.
6. **Resource limits.** Per-call timeout, output-size cap, max concurrency, no unbounded
   child spawning; a hanging/crashing plugin is killed and marked unhealthy.
7. **Full audit.** Every third-party tool call is journaled (tool, arg-digest, duration,
   outcome) — reusing the control-journal tractability discipline.
8. **Kill switch.** `LM_MCP_PLUGINS=0` disables the whole subsystem; per-plugin disable is
   instant.
9. **Registry integration.** Plugins + their tools appear in the existing `/mcp-tools` page
   (mcp-tool-registry feature) with enable/disable, checksum, capability summary, health and
   audit tail — reusing the overlay + rev-history + protected-set machinery.

## The plugin contract (Child A's first milestone, Child B consumes)

Child A publishes, before deep implementation:
- the `mcp-plugin.json` **JSON schema** (manifest + tool defs + capabilities grammar), and
- the **server protocol** the plugin must speak (standard MCP stdio: `initialize`,
  `tools/list`, `tools/call`) + the namespace + env/capability contract.

The controller relays this contract from Child A to Child B so the chart plugin is built
against a frozen interface.

## Work split & sequence

- **Child A — core loader (lm-assist repo, session 750fd632):** manifest schema + validator,
  subprocess aggregator + lazy spawn, security controls (enable gate, checksum pin, minimal
  env, capability allow-list, resource limits, audit), `/mcp` + stdio registration, and
  `/mcp-tools` page integration. **Deliverable 1 = the published contract.**
- **Child B — chart plugin (lm-unified-trade repo, session ce4cd7ce):** an example
  third-party MCP plugin wrapping the chart API, built against Child A's contract; proves
  end-to-end load → register → call inside lm-assist. Builds on the chart's own
  view-state/data model (its prior mission).
- **Dependency:** B `dependsOn` A's contract. Controller serializes the contract hand-off,
  then drives both in parallel to an integration test.

## Human gates (encoded in the missions)

- A `need_approval` gate on the **security design + any code that executes third-party
  scripts** before merge — human-only, never controller-approved.
- **Enabling the real chart plugin in prod is a human action** (the loopback enable gate).
