# Node Clusters — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending spec review → plan

## Goal

Partition a hub's fleet into named **clusters** that each behave like an independent mini-fleet — own leader election, own mission controller, own within-cluster DB sync — so you can develop/release on one cluster while another runs unaffected. Memory and the knowledge base stay shared fleet-wide. Add MCP management (assign/remove a node, list clusters), and make `bootstrap` + the mission controller aware of the cluster topology and the shared-vs-within split.

## Background — how "the fleet" is defined today

All three subsystems derive the node set from the LangMart hub endpoint `/api/tier-agent/machines` (each record: `gatewayId|machineId|id`, `hostname`, `platform/os`, `status`), filtered to `status:'online'`:

- **Leader election** — `monitor/stall-election.ts`: `amIMonitor()` calls `listOnlineNodeIds()` (in `data/peer-client.ts`) and is leader iff `selfId` (this node's `gatewayId`, a `gw4-…`) is the lowest. Used by the stall-monitor AND the mission-controller election.
- **Mission control** — `routes/core/mission.routes.ts`: `realLeaderAnchor()` → `amIMonitor()` for election; `anchorToLeader()` proxies all mission writes/reads to the elected leader. `mission/mission-controller.ts` runs the controller loop on the elected leader.
- **DB sync** — `data/sync-engine.ts` pulls `'full'`/`'partial'` datasets from `data/peer-client.ts` `listPeers()` → `selectSyncPeers(machines, selfId)` (all online except self).

Separate fleet-wide paths that must STAY fleet-wide (do NOT cluster-filter):
- **Memory** — `memory/mcp-transport.ts` uses `getHubPeerClient().listPeers()`; `routes/core/memory-sync.routes.ts`.
- **Knowledge** — `knowledge/remote-sync.ts` iterates `/api/tier-agent/machines/…/proxy` directly.
- **Node build/upgrade fan-out** — `mcp-server/tools/node-builds.ts` `selectFleetNodes()` (this one becomes cluster-aware with an opt-out to `all`).

There is **no group/cluster field** on nodes today.

## Approved decisions

- **Name:** cluster. The whole node set is still "the fleet".
- **Membership store:** lm-assist-only — a fleet-wide-synced map; no LangMart hub change.
- **A node is in exactly one cluster.** Unassigned ⇒ implicit `default` cluster.
- **Backward-compatible:** with everyone in `default`, cluster-scope ≡ fleet-wide — today's behavior, byte-for-byte.
- **Within-cluster (isolated):** leader election, mission control (missions/controller/scheduling/views/worker-roles), auto-resume, data-service datasets, build/upgrade fan-out (default).
- **Fleet-wide (shared):** the cluster map, node identity/enrollment, node visibility (`list_nodes`/proxy), sessions/projects, claude.ai account/connector, per-node ops (terminal/transfer/port-forward), **memory**, **knowledge**.

## Architecture

### 1. Cluster identity + the membership map

- **Local identity (authoritative for self):** `~/.lm-assist/cluster.json` = `{ "cluster": "<name>" }`, default `"default"` (dev suffix: `cluster-dev.json` under the repo, mirroring the `-dev` convention in `hub-config.ts`). A new pure module `core/src/cluster/cluster-config.ts` reads/writes it: `getMyCluster(): string` (defaults `'default'`), `setMyCluster(name: string): void`, `clusterName(raw): string` (normalize: trim, lowercase, `[a-z0-9_-]`, fallback `'default'`).
- **The map (`node-clusters` dataset, `scope:'fleet'`):** each node publishes its own record keyed by `gatewayId`: `{ gatewayId, cluster, hostname, ts }`. Because the dataset is `scope:'fleet'` it syncs to ALL online peers regardless of cluster, so every node converges on the full `gatewayId → cluster` map. LWW by `ts`; a node's own record is re-published on identity change and on a periodic heartbeat (reuse the existing data-sync tick).
- **Resolver:** `core/src/cluster/cluster-map.ts` — `clusterOf(gatewayId, records, selfId, selfCluster): string` (pure; self always resolves to the local identity even if the map is stale; unknown ⇒ `'default'`), and `sameClusterIds(onlineIds, records, selfId, selfCluster): string[]` (filter an online-id list to those in self's cluster, self always included).

### 2. Scoping the three subsystems

**A pure cluster filter, applied in three places:**

- **`listOnlineNodeIds()`** (`data/peer-client.ts`) — gains cluster scoping: after fetching online ids, return `sameClusterIds(onlineIds, map, selfId, myCluster)`. → leader election (stall-monitor) AND the mission-controller election/anchor become per-cluster with no change to *their* code. (All callers of `listOnlineNodeIds` are election; none need fleet-wide.)
- **Data `sync-engine.ts`** — for each dataset, choose the peer set by the dataset's `scope`: `'fleet'` → all `listPeers()`; `'cluster'` → `listPeers()` filtered to self's cluster via the map. `selectSyncPeers()` itself stays fleet-wide/unchanged (so MEMORY, which calls `listPeers()` directly, is unaffected and stays fleet-wide).
- **`selectFleetNodes()`** (`node-builds.ts`) — gains an optional `clusterFilter` (`{ map, selfId, selfCluster }`) + a `target: 'self-cluster' | 'all' | '<name>'` (default `'self-cluster'`). `node_builds`/`node_upgrade` MCP tools/routes pass a `cluster` arg (default self's cluster; `'all'` to span the fleet — for cross-cluster admin).

**The dataset `scope` field:**
- `core/src/data/types.ts` `Dataset`/`CreateDatasetInput` gain `scope?: 'cluster' | 'fleet'` (default `'cluster'`).
- `dataset-registry.ts` defaults `scope: input.scope ?? 'cluster'`.
- The `node-clusters` dataset is created `syncMode:'full', scope:'fleet'` — each node `data_put`s its own `{gatewayId,cluster,hostname,ts}` record; full-sync propagates every node's record to every node (LWW by `ts`), so the map converges fleet-wide.
- **Knowledge stays fleet-wide on whichever path it uses:** if the generic data service syncs knowledge (via `data/backends/knowledge-backend.ts` as a registered dataset), that dataset is marked `scope:'fleet'`; its standalone `knowledge/remote-sync.ts` path is already fleet-wide (it iterates `/machines` directly with no cluster filter — leave it). **Memory** likewise stays fleet-wide via `memory/mcp-transport.ts` `listPeers()` (no cluster filter added). Net: confirm during implementation which path is live and ensure it is NOT cluster-filtered / is `scope:'fleet'`.
- All other datasets (data-service user datasets, mission stores `mission`/`mission-views`/`mission-history`) default `'cluster'` ⇒ isolated per cluster.
- Backward-compat: default `'cluster'` with everyone in `default` ≡ fleet-wide; no migration.

### 3. MCP tools + routes

New `core/src/routes/core/cluster.routes.ts` + tools in a new `core/src/mcp-server/tools/cluster.ts` (registered in `expanded.ts`, scopes in `configure.ts`):

- **`cluster_list`** (scope `read`, `GET /cluster/list`) → `{ clusters: [{ name, leader, controller, members: [{ gatewayId, hostname, online }] }], myCluster }`. Built from the `node-clusters` map ∪ the live `/machines` online set; leader = lowest online id per cluster; controller = that cluster's mission controller (if any).
- **`cluster_assign`** (scope `write`, `POST /cluster/assign` `{ node, cluster }`) → resolves `node` (gatewayId or hostname via the map/machines), proxies to that node's `POST /cluster/self` `{ cluster }` (sets its local identity + republishes its record). Auto-creates the cluster (a cluster is just a name that ≥1 node claims). Returns the updated assignment.
- **`cluster_unassign`** (scope `write`, `POST /cluster/unassign` `{ node }`) → assign to `'default'`.
- **`POST /cluster/self`** `{ cluster }` (loopback/fleet-internal only, like the memory-sync routes) — the local setter the proxy hits; calls `setMyCluster` + republishes.
- Guard unknown node ⇒ `BAD_NODE`; invalid name ⇒ normalized (never errors).

### 4. Bootstrap + mission-controller awareness

- **`session_status` + `bootstrap`** report `cluster: '<myCluster>'` and a one-line shared-vs-within summary.
- **`guide("clusters")`** — new topic: what a cluster is, the shared-vs-within table, `cluster_assign`/`unassign`/`list`, and "build/release one cluster at a time" via `node_upgrade … cluster:'<name>'`.
- **Mission controller** — `mission-controller.ts` `CONTROLLER_SYSTEM_PROMPT` gains one line: "You control missions for YOUR cluster (`<name>`) only; other clusters have their own controller." Its election + anchor are already cluster-scoped via `listOnlineNodeIds`. The controller label includes the cluster: `Mission Controller · <hostname> · <cluster>`.

## Out of scope (YAGNI)

- No LangMart hub (assist-api) change.
- No multi-cluster membership (one cluster per node).
- No automatic rebalancing/scheduling of nodes across clusters; assignment is explicit.
- No per-cluster ACLs/permissions (any node can read the map; assignment is a `write`-scope tool).
- No cross-cluster mission migration.
- No web-UI surface in this spec (MCP + routes only; a Clusters page can come later).

## Testing

- **Pure unit (vitest/node tap as the repo uses):**
  - `cluster-config`: default `'default'`, normalize, round-trip.
  - `cluster-map`: `clusterOf` (self-from-local even if map stale; unknown ⇒ default), `sameClusterIds` (two clusters → disjoint sets; self always included; `default` fallback).
  - `electMonitor` over a cluster-filtered set: two clusters → two independent leaders; a single-cluster fleet unchanged.
  - `sync-engine` peer selection by `scope`: `'fleet'` → all peers; `'cluster'` → same-cluster only; existing fleet (all `default`) unchanged.
  - `selectFleetNodes` with `target` (`self-cluster`/`all`/named).
- **Route/tool tests:** `cluster_list` shape; `cluster_assign`/`unassign` resolve + proxy (mocked peer client); unknown-node guard.
- **Multi-node smoke (117/123/107 on the prod hub):** assign 117+123 → cluster `release`, 107 → cluster `dev`; verify (a) two independent leaders (`cluster_list`), (b) a mission created in `release` is invisible in `dev` and vice-versa, (c) memory written on 107 appears on 117 (shared), (d) `node_upgrade cluster:'dev'` touches only 107. Then reassign all → `default` and confirm fleet-wide behavior returns.

## Risks

- **Map propagation lag** (accepted): right after `cluster_assign`, other nodes briefly see the old cluster until the `node-clusters` dataset syncs (one tick). Self is always correct locally. Mitigation: `cluster_assign` republishes immediately and the resolver trusts local identity for self.
- **Empty-cluster election:** a node alone in its cluster is its own leader (correct). A node whose map is still empty resolves everyone to `default` until first sync — converges within a sync tick.
- **`scope` default flip:** defaulting existing datasets to `'cluster'` is safe only because the unclustered fleet is one `default` cluster; verified by the "all-default unchanged" tests.
