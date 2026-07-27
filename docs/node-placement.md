# Node clusters and machine-access profiles

> Read before changing placement, election, cluster scoping, or the SSH access registry.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Node Clusters

A **cluster** partitions a hub's fleet into independent mini-fleets so you can dev/release on one while another serves. A node belongs to exactly one cluster; unassigned ⇒ implicit `default` ⇒ today's fleet-wide behavior (zero change until you split). Membership is lm-assist-only: a local `~/.lm-assist/cluster.json` (authoritative for self) published into a **fleet-wide-synced** `node-clusters` dataset, so every node converges on the `gatewayId→cluster` map. The scoping lands in two pure filters — `listOnlineNodeIds()` (election: stall-monitor + mission controller) and the data **sync-engine** (per-dataset `scope:'cluster'|'fleet'`, default `cluster`) — plus `selectFleetNodes` (build fan-out).

| Within a cluster (isolated) | Shared fleet-wide |
|---|---|
| leader election; mission control (missions, controller, **executor placement** — `env.host` must be in-cluster, else `HOST_NOT_IN_CLUSTER` / `ctl:placement-error`); data-service datasets; `node_builds cluster:` fan-out (default self-cluster, `all`/`<name>`) | the cluster map; node identity/enrollment; `list_nodes` visibility + proxy reach; sessions/projects; claude.ai account/connector; per-node ops (terminal/transfer/port-forward); **memory**; **knowledge** |

MCP/routes: `cluster_list` (read) / `cluster_assign(node,cluster)` (write, auto-creates, proxies to the node's loopback-guarded `POST /cluster/self`) / `cluster_unassign(node)` (→`default`) / `cluster_describe(cluster?,description,status?)` (write — a cluster's advisory self-description in the fleet-wide `cluster-meta` dataset). `bootstrap`/`session_status` report this node's cluster + the other-cluster roster; `guide("clusters")` carries the full split + the **norm: respect each cluster's declared scope — don't touch another cluster's nodes/missions/data unless asked; `frozen`/`release`/`busy` = off-limits by default.** Note `node_upgrade` is single-node (no cluster arg).

### Machine Access Profiles

A **node-local** registry of how to reach OTHER machines FROM this node (SSH endpoint + user + key *path* + per-machine gotcha notes) so agents stop re-discovering access from prose memory. Storage is a plain file `~/.lm-assist/machine-access[-dev].json` (cluster.json precedent) — **not** a synced dataset; profiles never leave the node except when reported on demand. Access methods are a discriminated union on `type`: v1 implements `ssh` (reported with a derived ready-to-run `command`); unknown types (future `windows-account` remote exec, `elevated-worker`) round-trip verbatim and report `supported:false`. No secrets: `identityFile` is a path, validation rejects pasted key material, and there are no password fields.

Surfaces: `GET /machine-access` (report: node identity + machines + usage guidance; resilient — a hand-edited/malformed profile is flagged, never crashes the report) and **loopback-only** writes `PUT/DELETE /machine-access/machines/:id`, `POST /machine-access/machines/:id/check` (BatchMode ssh reachability probe → `lastCheck`; `StrictHostKeyChecking=yes` so it never mutates `known_hosts`), `POST /machine-access/import` (parse this node's `~/.ssh/config` → **dry-run** drafts by default; `{apply:true}` writes `enabled:false` `imported` drafts, never clobbering a curated id). Writes are node-owner actions — not reachable via LAN/hub relay. Injection-safe field grammar (host/user/identityFile reject a leading `-`, whitespace, metachars, key material); store file is `0600` with a one-deep `.bak`. MCP: `machine_access` (read; optional `id`/`tag`) on both stdio + `/mcp`; wired into `bootstrap` + `guide("machine-access")` so every session discovers it. Modules: `core/src/machine-access/{store,ssh-config,probe}.ts`; routes: `machine-access.routes.ts`; tool: `mcp-server/tools/machine-access.ts`.
