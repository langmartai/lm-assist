# MCP Fleet / Connector Identity — Design

**Goal:** Make every lm-assist MCP surface (bootstrap, session_status, guide) and the Mission-Controller system prompt *dynamically* tell the LLM **which fleet this connector serves** — hub URL, this node, cluster, reachable nodes — and warn that other MCP connectors are other fleets, so an LLM with multiple lm-assist connectors stops cross-routing node-targeted calls. No hardcoded connector names.

## Problem

A claude.ai account can have several lm-assist MCP connectors, each pointing at a different hub → a different fleet (e.g. `lm-assist langmart` → the prod fleet on `assist-api.langmart.ai`; `lm-assist` → a dev node on `xeenhub.com`). When an LLM drives a node-targeted tool (e.g. `cluster_assign node="DESKTOP-GDKLATG"`), claude.ai resolves the ambiguous tool name to **one** connector. Nothing tells the LLM which connector reaches which nodes, so the call can land on the wrong fleet → `BAD_NODE`, and a hostname can collide across fleets. Observed live: a driven `cluster_assign` routed to the dev connector (which only sees its own node) and failed, looking like "split-brain".

Additionally, the current bootstrap/index text **hardcodes** "the langmart MCP connector" — wrong for any other hub and the exact thing to avoid.

## Principle

lm-assist knows **its own** fleet authoritatively (the hub it dials, its `list_nodes`, its cluster). It cannot see *other* connectors (separate lm-assist instances on other hubs). So each connector states "**I** am the connector for fleet X with these nodes," and the LLM disambiguates from that. lm-assist provides the identity from its API; the LLM does not guess.

## Design

### Component 1 — `fleetIdentity()` pure-ish helper

A single source of truth, reused by all surfaces (DRY). Derives entirely from lm-assist runtime config:

- `getHubConfig().hubUrl` → the fleet's worker-hub (e.g. `assist-api.langmart.ai`). Normalize `wss://…`/`ws://…` → bare host for readability; fall back to `"(no hub configured — local-only)"` when unset.
- `getHubConfig().hostname` + `gatewayId` → *this* node.
- `getMyCluster()` → this node's cluster.
- Optional online node count when cheaply available; otherwise instruct `list_nodes`. (The helper must never throw — wrap all lookups; degrade to a minimal block.)

Returns a compact text block, e.g.:

```
FLEET / CONNECTOR IDENTITY — this lm-assist MCP connector serves ONE fleet:
  hub: assist-api.langmart.ai   ·   this node: ubuntu-Virtual-Machine (gw4-332c…) · cluster: default
  Reachable nodes = this connector's `list_nodes` only.
  If you have OTHER lm-assist MCP connectors, EACH serves a DIFFERENT fleet (different hub):
  their nodes are NOT in this connector's `list_nodes`, and hostnames can collide across fleets.
  A node-targeted call routes to THIS fleet. Before a node-scoped WRITE, confirm the target is in
  this `list_nodes`; a BAD_NODE error = the node isn't in this fleet → you're on the wrong connector for it.
```

Placement: a new file `core/src/mcp-server/fleet-identity.ts` exporting `fleetIdentity(): Promise<string>` (async because the node-count/cluster lookups may touch the data service) and a small pure `formatFleetIdentity(parts)` for testability.

### Component 2 — Wire into the four surfaces

1. **`bootstrap`** (`guide.ts`): prepend `fleetIdentity()` to the bootstrap response (alongside the existing auth + cluster blocks). **Replace** the hardcoded "the langmart MCP connector" in the index/bootstrap copy with generic wording ("the lm-assist MCP connector") — the live hub URL carries the specificity.
2. **`session_status`** (`mcp-session-resolver.ts`): include the fleet-identity block in the session-status output (next to the existing cluster info) so any conversation knows which fleet it is on.
3. **`guide`** (`guide.ts`): a new `connectors` topic carrying the full multi-connector playbook (identity → list_nodes membership → BAD_NODE means wrong connector → cluster ops affect this fleet only), plus a one-line pointer added to the `cross-node` topic and the topic index.
4. **Mission-Controller system prompt** (`mission-controller.ts`): inject the fleet identity (hub + node + cluster) into `CONTROLLER_SYSTEM_PROMPT` so the controller knows its fleet/cluster boundary (it already guards executor placement to its cluster; this names the boundary).

### Cross-connector rule strength

**Awareness + verify-on-write** (chosen): inform that connectors are per-fleet; tell the LLM to confirm a target is in *this* `list_nodes` before a node-scoped **write**, and to read a `BAD_NODE` as "wrong connector for this node." No mandatory `list_nodes` before every call (low friction for the common single-fleet case).

## Data flow

`bootstrap` / `session_status` / `guide("connectors")` / controller-launch → call `fleetIdentity()` → reads `getHubConfig()` + `getMyCluster()` (+ best-effort node count) → returns the block → surface prepends/embeds it. No new state, no network beyond what those getters already do.

## Error handling

`fleetIdentity()` never throws: every lookup is guarded; on failure it emits a minimal block (`hub: (unknown)`, still carrying the multi-connector caveat). A missing hub URL yields the local-only fallback. Surfaces that already degrade gracefully (bootstrap/session_status) are unchanged in that respect.

## Testing

`node:test` (NOT vitest) in `core/src/__tests__/`:
- `formatFleetIdentity()` with a hub URL → block contains the bare hub host, the cluster, "OTHER lm-assist MCP connectors", "BAD_NODE", and **no** literal "langmart"/"xeenhub" hardcoded in the source template.
- hub URL unset → local-only fallback line present, caveat still present.
- `wss://assist-api.langmart.ai` normalizes to `assist-api.langmart.ai`.
- A guard test that the `bootstrap`/index copy no longer contains the hardcoded "langmart MCP connector" phrase.

## Out of scope (YAGNI)

- Forcing claude.ai to pick the right connector (it resolves tool names; lm-assist can't control that). This is awareness + clear failure.
- A cross-connector registry / discovery of other connectors.
- Renaming/removing the user's dev connector (a separate operational choice).
