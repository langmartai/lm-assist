# Direct-MCP cross-node memory sync + persistence tiers

Status: IMPLEMENTED (2026-06-22). Branch `feat/direct-mcp-memory-sync`; plan
`docs/superpowers/plans/2026-06-22-direct-mcp-memory-sync.md`. 77 unit tests, clean prod build.

## Implementation notes (deviations from the original design, all deliberate)

- **`/memory/export` is a POST** (not GET): the access-key must ride in the body because the hub
  `/proxy` drops the `x-lm-access-key` header (same reason the data service POSTs its export).
- **Transport reuses the data-service pattern** (`core/src/data/peer-client.ts`): relay via
  `/api/tier-agent/machines/<id>/proxy<path>` with the node hub apiKey as Bearer + key in body.
  `pullFromHome`/`pushToHome` in `core/src/memory/mcp-transport.ts`.
- **Auth gate** for `/memory/export|ingest` is loopback-local **or** hub-relayed (`x-relay-source:hub`,
  relay-set + client-stripped) + a body key — fleet-internal trust. It is **not** the data-service
  AccessManager (memory is not a dataset); Core's api-token already guards non-loopback requests.
- **Two project slugs.** Memory dirs are keyed by the cwd-encoded project slug, which differs between
  the home node and a cloud clone. `memory-sync.json` carries `project` (this node's LOCAL slug, where
  pulled memory is written + local changes detected) and `homeProject` (the home node's slug, the
  export source / push target). `/memory/sync/enable` accepts the agent's `cwd` and encodes it.
- **Push-primary delivery.** Push-back writes directly to the home (`POST /memory/ingest`) for
  survival, then hub-notifies; the receiver's `onRemoteUpdate` registers/refreshes the peer's mirror in
  the cache (the data was already delivered) — it does not git-fetch. The git mirror+commit+push and
  git-fetch transport are removed.
- **Bootstrap pull is explicit:** `POST /memory/sync/enable` (loopback) writes the config and pulls
  now; the cloud bootstrap instruction emits this as a one-time background step. `memory_sync_status`
  MCP tool + `GET /memory/sync/status` surface state.
- **Safety unchanged:** `MEMORY_AUTOSYNC` defaults to **observe** (logs the plan, no transport).

---

## Original design (approved in brainstorming)

## Goal

Let cloud (ephemeral) and local (persistent) lm-assist nodes share a project's curated memory by
**direct node-to-node transport over the hub** — replacing the git-repo mirror — with a **persistence
tier** (persistent vs temporary) and **auto-managed bidirectional sync**: a fresh cloud worker
auto-pulls the project's persistent memory at bootstrap, and the new memory it produces auto-syncs
back to a persistent "home" node so it survives the ephemeral VM.

## Background (current state)

- Memory = on-disk files `~/.claude/projects/<project>/memory/*.md` (+ `MEMORY.md` index). The "memory
  map" is a derived, watcher-maintained index/view over those files — **not** a second store. Syncing
  memory = moving the actual files/records between nodes.
- Record model `MemoryRecord` (recordId, contentHash, node, project, source, file, kind, anchor, title,
  brief, complete, type, **shareability**, mtime) + the map + **read-only** MCP tools (`memory_map`,
  `memory_record`, `memory_cross_host`, `memory_import_candidates`, `memory_projects`). See
  `docs/plans/2026-06-06-record-level-memory-map-and-sync.md`.
- The designed §4 auto-sync uses **git mirror** (`memory/<host>/` + commit/push) for transport + a hub
  `memory-updated` event for notification. **This spec replaces the git transport with direct-MCP and
  adds persistence tiers.**
- Infra to reuse: `core/src/memory-cache.ts` (chokidar watcher + record extraction),
  `core/src/api/memory-api.ts` (`/memory/*`), `core/src/utils/memory-shareability.ts` (host-local vs
  project-domain classifier), `core/src/memory/autosync.ts` (the git autosync to retarget),
  `core/src/hub-client/` (the hub relay — the data-service already does cross-node transfer via
  **key-in-body** `POST /data/:ds/export`+`/fetch` because the hub `/proxy` drops the `x-lm-access-key`
  header), `core/src/terminal/ccr-cloud.ts` (`buildBootstrapInstruction`).

## Design

### 1. Persistence tier + node mode

- New file/record attribute `persistence: "persistent" | "temporary"` (frontmatter field, default
  `persistent`).
- Node **mode** `persistent | ephemeral`, read at Core startup from `~/.lm-assist/assist-config.json`
  (`nodeMode`, default `persistent`). The cloud bootstrap sets `nodeMode: ephemeral` on cloud workers.
- On an **ephemeral** node, lm-assist treats the memory dir as a **working copy**: new project-domain
  memory (shareability ∈ {project-domain, ambiguous}) auto-syncs back to the home node; a file marked
  `persistence: temporary` stays local-only and is never synced (dies with the VM).
- On a **persistent** node, memory is the durable canonical copy.

### 2. Direct-MCP transport (replaces git)

Memory moves over the existing hub relay (each node's outbound WebSocket), mirroring the data-service
pattern: relayed `POST` with the **access-key in the body** (the hub `/proxy` drops the header). New
Core endpoints (gated by the worker token / key-in-body when relayed):

- `GET /memory/export?project=&sinceMs=` → this node's **persistent** records for a project (full
  records) since a watermark.
- `POST /memory/ingest` → accept pushed records from a peer (writes them under that peer's mirror, §5).
- Reuse `/memory/changes?sinceMs=` for delta detection.

A peer is addressed by `hostId` (like the MCP tools' `node` param); the hub forwards to that node's
Core. The existing `memory-updated {project, host, recordIds[]}` hub event triggers incremental
`export` fetches — near-real-time, no polling, **no git**.

### 3. Bootstrap pull (cloud node ← home node)

- At `ccr_cloud_start`, the **home node** = the spawner (its `hostId`/`gatewayId`), recorded into the
  new worker's config during enroll/bootstrap (`~/.lm-assist/memory-sync.json {homeNode, project}`).
- `buildBootstrapInstruction` gains a **background** step: after enroll, lm-assist (not the agent)
  pulls project P's persistent memory from the home node via relayed `GET /memory/export` → writes the
  records as local `.md` files under `~/.claude/projects/<P>/memory/<homeHost>/` (the home node's
  **mirror** dir — same host-mirror convention used everywhere, just transported by MCP not git) → the
  watcher re-indexes → the map (live + mirrors) reflects them. Background, so the agent starts
  immediately. (Uniformity: all cross-node records live in `memory/<sourceHost>/` mirrors; only the
  transport changed from git to direct-MCP.)

### 4. Push-back (cloud node → home node)

- The ephemeral node's memory-cache watcher detects new/changed project-domain memory (excluding
  `persistence: temporary` + host-local) → debounced (≈1.5 s) → lm-assist relays `POST /memory/ingest`
  to the home node with those records (key-in-body).
- The home node writes them under `memory/<cloudHost>/` (host-owned mirror dir in its live memory area)
  → durable, owned-by-source, no overwrite of the home node's own memory. New memory survives the VM.

### 5. Conflict-free by construction

- **Per-host folder ownership**: a node only writes records under `<host>/` for its own `hostId` on a
  target; pulled records keep their source-node tag.
- **Dedup** by `recordId` + `contentHash` (skip unchanged).
- Same-record updates resolved by version + mtime (**LWW**) — rare, since each node owns its folder.

### 6. Surface changes

- Persistence mark = a `persistence: temporary` frontmatter field the agent writes (memory is
  file-based; no new write-tool). lm-assist reads it.
- Query tools (`memory_map`/`memory_cross_host`/`memory_import_candidates`/`memory_projects`) keep
  working over the now-MCP-synced local files + source tags — the map already aggregates by node.
  (`memory_cross_host`'s "every host mirror in the repo" becomes "every synced host mirror locally".)
- Add `memory_sync_status` (synced/pending per project + home node) + optional manual `memory_sync`
  (pull/push trigger). **Auto by default.**

### 7. Integration + guards

- Mode + home-node config in `~/.lm-assist`; bootstrap sets them for cloud workers.
- Guards (from the existing design): shareability classifier (**never** sync host-local),
  debounce/coalesce, a `MEMORY_SYNC` on/off flag (default **observe-mode** → logs the plan first),
  credential-pattern skip, valid-frontmatter requirement.
- **No git involvement for memory at all.**

## Files (create / modify)

- `core/src/memory/autosync.ts` — retarget transport from git → relayed `/memory/export`+`/ingest`
  (keep detect / classify / guards / notify).
- `core/src/api/memory-api.ts` + a route file — add `/memory/export`, `/memory/ingest`, ensure
  `/memory/changes`.
- `core/src/hub-client/api-relay-handler.ts` — allow the memory transport endpoints (relayed,
  key-in-body).
- `core/src/memory-cache.ts` — ensure record-level change events feed the syncer.
- `core/src/terminal/ccr-cloud.ts` (`buildBootstrapInstruction`) — home-node config + the background
  auto-pull step.
- config read for `nodeMode`/`homeNode` (`~/.lm-assist`).
- `core/src/mcp-server/tools/expanded.ts` — `memory_sync_status` (+ optional `memory_sync`).
- tests (see below).

## Testing

- **Unit**: shareability+persistence filter (host-local + `temporary` excluded); record dedup/LWW;
  export/ingest serialization.
- **Integration**: two-Core pull+push round-trip (relayed or direct); bootstrap-pull writes the
  expected files; `temporary`/host-local never transferred; observe-mode logs the plan without
  transferring.

## Out of scope (YAGNI)

- A central hub-aggregated memory store (we use peer-to-peer via the home node).
- Real-time streaming / CRDT merge (LWW + per-host ownership suffices).
- Migrating existing git mirrors (the new transport is additive; git autosync can be retired
  separately).
- Persistent↔persistent auto-sync between two always-on machines (same mechanism could extend later;
  the driving use case is cloud↔home).

## Decisions made (brainstorming)

- **Sync model**: notify + direct-fetch over the hub (not git, not full replicate, not pure
  pull-on-demand).
- **Source/target**: the persistent **home** node = the spawner; **bidirectional** (pull at bootstrap,
  push-back new memory).
- **Sync-back**: lm-assist **auto-manages**; new project-domain memory syncs back by default;
  `persistence: temporary` is the opt-out.
