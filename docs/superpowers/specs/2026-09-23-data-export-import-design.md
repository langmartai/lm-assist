# Data export / import bundles, and dataset takeover — design

Status: approved for implementation 2026-09-23. Branch `feat/data-export-import`.

## Why

lm-assist keeps its user data in two places, and neither has a point-in-time copy:

1. **Data-service datasets** (`<dataDir>/data{-dev}/`: `datasets.json` + LMDB/SQLite/Lance
   per dataset). Fleet-scoped datasets (backlog, tool/content registries, node profiles,
   mission workflows) have ONE writer, the origin node, and read-only replicas on every other
   online node, pulled every `dataReconcileSec` (300 s) and on bus notify within a cluster.
   Cluster-scoped datasets (missions, mission-history, mission-views) are owned per cluster,
   so a single-node cluster holds the ONLY copy.
2. **Host-local files** under `<dataDir>` (scheduled jobs, machine-access profiles, project
   settings, MCP access and profile, knowledge base). No sync, no backup:
   the backup subsystem deliberately skips `~/.lm-assist`.

Replication is not recovery:

- A replica is **never re-served**. It is forced to `visibility: local-only` and `acl: []`,
  so `PEER_NOT_SHAREABLE` applies.
- A replica is **never promoted**. `update()` cannot clear `origin`, and `dropDataset`
  refuses replicas.
- If the origin's disk is lost, the first write on the rebuilt origin creates a NEW empty
  owned dataset. Every other copy then survives only as a stranded read-only replica, and
  bringing it back means hand-copying LMDB directories and editing `datasets.json`.
- A bad bulk write reaches every replica within one reconcile. In-record history is capped
  at 20 revisions per item.

This feature adds:
- **Export / import bundles:** a faithful, portable snapshot of the node's lm-assist data,
  with a dry-run plan before any write.
- **Guarded dataset takeover:** promotes a local replica to owner when its origin is gone.
- **Safe auto-demotion:** a superseded origin that comes back online demotes itself.

## Decisions (user-approved)

| Question | Decision |
|---|---|
| Who may export / import | The node **owner**, including remote callers: LAN web, hub web, and the claude.ai connector. Same exposure as today's registry write routes. Every request still requires the API token or the hub relay. Import is a **dry-run plan unless `apply:true`**. |
| Scope of "export all" | **Default:** every OWNED non-system dataset, plus sanitized config. **Opt-in:** replica datasets, the knowledge base, Claude project memory and own rules. **Never:** secrets or node identity. |
| Disaster recovery | **Yes, guarded.** An explicit takeover promotes a replica to owner, refused while the origin is online. A returning superseded origin auto-demotes only when that strands nothing. |

## Non-goals

- **Secrets never travel.** This covers `api-token*`, `scoped-tokens.json`, `hub*.json`,
  `machine-id*`, `gateway-id*`, `tls*/`, `local-ui-secret`, `keys.lmdb`,
  `github-accounts.json`, WhatsApp, Gmail and panetest browser profiles, harness provider
  keys, `controller*/` configs, and `assist-config.json`'s `lanAccessToken`. Credentials
  are re-established on the target the normal way.
- **Derived stores are never exported; they rebuild.** These are the system SQL indexes
  (`session-prompts`, `memory-files`), `knowledge`/`vectors` system datasets, `log-*` file
  datasets, `lance-store`, `session-cache`, `memory-cache`, `rules-mirror`, the bus,
  `task-store`, and runtime monitor state.
- Session JSONL (`~/.claude/projects/*/*.jsonl`) is out of scope; `backup_run` owns `~/.claude`.
- There is no encryption at rest in v1. A bundle is written `0600` in a `0700` directory,
  and the manifest says it holds private user data.

## Bundle format

A bundle is a single file, `<dataDir>/bundles{-dev}/<bundleId>.lmbundle.gz`: a gzip of
UTF-8 **JSON Lines**. There is no tar, so there are no member paths to traverse.
- The file is streamable, so it reads line by line without a size ceiling.
- It is inspectable: `zcat x.lmbundle.gz | head -1 | jq`.

`bundleId` is `lmb-<yyyymmdd>-<hhmmss>-<6 hex>`, matching `^lmb-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$`.
It is the ONLY name accepted for a stored bundle; paths are never taken from the caller,
except the confined `received/` import described below.

```
line 1   {"t":"manifest", "format":"lm-assist-bundle", "formatVersion":1,
          "bundleId", "createdAt",
          "source":{"nodeId","hostname","platform","lmAssistVersion","mode":"prod|dev","cluster"},
          "options":{...export options...},
          "sections":[ SectionSummary... ],
          "totals":{"entries","uncompressedBytes"},
          "note"?: string}
line 2.. {"t":"dataset","id","descriptor":{...DatasetDescriptor...},"replicaOf"?:NodeOrigin}
         {"t":"record","ds":"<id>","r":{...DataRecord verbatim, tombstones included...}}
         {"t":"config","id":"<config section id>","data":{...sanitized...}}
         {"t":"file","section":"knowledge|claude-memory|claude-rules","path":"<relative posix path>",
          "mtime","size","sha256","content":"<utf8>"}
last     {"t":"end","entries":N,"sha256":"<sha256 of every preceding line incl. its \n>"}
```

`SectionSummary` has these fields:
- `kind`: `dataset | config | files`
- `id`, `title`
- `count`: records, entries or files
- `bytes`
- dataset sections only: `tombstones`, `owned` (bool), `origin?`, `scope`, `syncMode`, `backend`
- `sha256` over that section's lines
- `warnings[]`

On read the importer verifies the `end` line (count and hash) and each section hash. A
truncated or corrupted bundle is refused with `BUNDLE_CORRUPT`, naming the failed check.

Limits:
- Refuse to export when free disk space is below `max(512 MB, 3 × estimated size)`
  (`fs.statfsSync`), returning `DISK_LOW` with the numbers.
- An uncompressed bundle may not exceed 1 GiB (`BUNDLE_TOO_LARGE`).
- A single line may not exceed 16 MiB.
- File sections skip files over 5 MiB and list them in the section warnings. Binary files
  (a NUL byte in the first 8 KB) are skipped as well.

Retention: exports and uploads go in the same directory. The store keeps the newest 20 by
default; `bundleRetention` in project-settings overrides it, and pruning deletes the oldest.

## Sections

### 1. `datasets` (default ON)

**Enumeration.** Every descriptor in the registry is considered. A descriptor is EXCLUDED if:
- it is a system dataset (`system:true`, which covers `knowledge`, `vectors`, the `log-*`
  file datasets, `session-prompts` and `memory-files`);
- its backend is `file`, `knowledge` or `vectors`;
- it is in the runtime deny-list: `node-clusters` (node identity heartbeats that self-heal)
  and `mcp-bootstrap` (runtime state);
- it is a replica (`origin` set) and `includeReplicas` is false.

Every other descriptor is included, which covers user-created datasets too. Orphan LMDB
directories with no descriptor are reported in inventory as `orphans[]` and never exported.

**Reading.** Records are read RAW, straight from `backend.exportSince(ds)`, without
redaction and with tombstones. The exporter pages past the backend's 50k cap by looping on
the updatedAt watermark and dropping ids it has already seen, and it never stops short
silently. The `missions` dataset excludes the reserved ids `__controller__` and
`__engagement__`.

`DataService` gains:

```ts
/** Unredacted, tombstone-inclusive full read for bundles. Local principal only. */
exportRaw(ctx, datasetId): Promise<DataResult<DataRecord[]>>
/** Faithful import under the per-key locks; returns per-record outcome. Local principal only. */
importRaw(ctx, datasetId, records, opts: { policy: ImportPolicy; dryRun: boolean }):
  Promise<DataResult<ImportOutcome>>
```

Export and import run in the Core process with the internal `{type:'local'}` ctx, like
doc-store and mission-store do. The ROUTE is the auth boundary (see Surfaces).

**Import policies.** Records present locally but absent from the bundle are NEVER touched
(import never deletes). Incoming tombstones follow the same rules as live records.

| policy | absent locally | local older (`isNewer(bundle, local)`) | local newer or identical |
|---|---|---|---|
| `merge` (default) | write verbatim | write verbatim | skip (`older` / `identical`) |
| `add-missing` | write verbatim | skip (`exists`) | skip |
| `replace` | write verbatim | write **as a new version** | write **as a new version** unless identical content |

- *Verbatim* keeps `version`, `createdAt`, `updatedAt` and `deleted`, and sets `origin`
  to `undefined`: the record becomes locally owned.
- *As a new version* keeps the bundle's fields but sets
  `version = max(local.version, bundle.version) + 1` and `updatedAt = now`, so the restored
  state out-LWWs every replica.
- "Identical content" means equal `fields`, `text`, `metadata` and `deleted` under a
  canonical JSON compare.
- Records over `MAX_RECORD_BYTES` are skipped (`tooLarge`).
- After an apply, `notifyChange(d,'changed',ids)` fires once per dataset (batched) so peers
  pull promptly, and the registry caches that shadow datasets are invalidated:
  - `invalidateOverlayCache()` (tools),
  - `invalidateContentOverlayCache()` (assist content),
  - any node-profile or mission caches, plus the stores' `ensured` flags where a dataset
    was created by the import.

**Ownership rules at import.** These are checked per dataset. `bundleOwner` is
`descriptor.origin?.machineId ?? descriptor.ownerNode`.

| local state | outcome |
|---|---|
| local owns it (no `origin`) | import per policy. If `bundleOwner` ≠ this node, add the warning `foreign-owner` ("records from another owner are merged by LWW"). |
| local has a replica | `REPLICA_READ_ONLY`, refused. The plan points to *import on the origin `<hostname>`* or *take over first* (`takeOwnership:true` performs the takeover below and then imports). |
| absent locally, dataset not synced (`syncMode none`) | create it from the bundle descriptor, then import |
| absent locally, synced, and `bundleOwner` is this node OR not currently online | create an OWNED dataset from the bundle descriptor, then import. This is the rebuilt-origin and new-fleet path. |
| absent locally, synced, and `bundleOwner` is ONLINE and not this node | `OWNER_ONLINE`, refused, because it would mint a second owner (split brain). The plan says to import on `<hostname>` or wait for replication. |
| system / denied id in the bundle | skip, with a warning |

For a created dataset, the new descriptor keeps `id`, `backend`, `title`, `scope`,
`syncMode`, `config` and `sensitive` from the bundle. `visibility` and `acl` come from the
bundle when the bundle side was owned. When it was a replica, the defaults are
`visibility: 'cross-node-readable'` and `acl: []`, because a replica's local-only/empty
ACL is an artifact of replication, not the owner's choice.

The cluster-scoped mission datasets get two extra treatments:
- The plan warns `cross-cluster` when the bundle's `source.cluster` differs from this
  node's cluster.
- Imported missions whose status is `active`, `waiting` or `blocked` are written with
  `status:'paused'`, and their `binding`, `control.spawnInFlight` and `lastSpawnRequest`
  are cleared, so the supervisor does not spawn sessions on import. The count is reported
  as `neutralized`, and in `replace` mode the value is recorded in the record's own
  history. This is the only domain transform.

### 2. `config` (default ON): allow-listed, sanitized, host-local files

Each config source is an explicit provider with its own sanitizer and merge semantics.
Paths resolve through the module's own path helper, which respects dev/prod.

| id | source | export | import semantics |
|---|---|---|---|
| `scheduled-jobs` | the scheduler's jobs file | Custom (non-builtin) jobs in full, plus each builtin's `{id, enabled, intervalMinutes, config}` override. Run state is stripped: `lastRunAt`, `lastResult`, `lastStatus`, run logs and counters. | `merge`/`add-missing`: add custom jobs whose id is absent. `replace`: also overwrite matching ids. **Every imported custom job lands `enabled:false`** (a shell job is code execution) and is reported as `importedDisabled`. Builtin overrides apply only in `replace`. Write through the scheduler's own upsert API so the live scheduler adopts it. |
| `machine-access` | the machine-access store | profiles (key *paths* only; the store holds no key material) | Upsert via store functions: add absent ids; `replace` overwrites. Profiles whose `keyPath` does not exist on the target get the warning `key-missing`. |
| `project-settings` | `project-settings.json` | All keys except the node-bound deny-list (`devModeEnabled`) and anything matching the secret key regex (reported). | Keys ABSENT locally are added in `merge`/`add-missing`. **Differing keys are reported, not applied, unless `replace`.** `dataServiceEnabled`, `busEnabled` and `dataSyncViaFabric` are never flipped by import (warning only). |
| `mcp-access` | `mcp-access{-dev}.json` | as-is (no secrets) | add-missing by key; `replace` overwrites |
| `mcp-profile` | `mcp-profile{-dev}.json` | as-is | applies only in `replace` (a node-global budget choice) |

Keys that name a secret (`/(token|secret|password|api[-_]?key|cookie|credential|authorization|private[-_]?key)/i`)
are dropped from config sections. Their dotted paths are listed in the section's
`redactedKeys`, so the loss is visible and never silent.

### 3. Opt-in `files` sections

| option | section | source | import |
|---|---|---|---|
| `includeKnowledge` | `knowledge` | `<dataDir>/knowledge/` files: `*.md`, `index.json`, `comments/**`, `settings.json`. Excludes `remote/`. | `add-missing` by relative path (default); `replace` overwrites. A K-id collision surfaces as `exists`. Reload the knowledge store index afterwards if it caches one. |
| `includeClaudeMemory` | `claude-memory` | `~/.claude/projects/<slug>/memory/**/*.md` | Written only when `~/.claude/projects/<slug>` exists on the target; otherwise `unknown-project`. The `add-missing` default never overwrites. `replace` writes `<file>.bak-import-<ts>` first. |
| `includeClaudeMemory` | `claude-rules` | `~/.claude/rules/*.md`, excluding `synced.*` (those are mirrors of another node's rules) | same as `claude-memory` |

Paths are relative POSIX paths. On import they are joined with the house `safeJoin`
(refuse `..`, absolute paths, drive letters and NULs) and written tmp+rename.

## Takeover (replica → owner)

`takeover(datasetId, { force? })`:

1. Refuse `NOT_A_REPLICA` if the local descriptor has no `origin`.
2. Resolve the fleet roster (the same peer list the sync engine uses).
   - If `origin.machineId` is **online**, refuse `ORIGIN_ONLINE`, naming hostname and id.
   - If the roster cannot be fetched (hub down), refuse `ROSTER_UNAVAILABLE` unless
     `force:true`. Force covers exactly this case and nothing else.
3. Call `DatasetRegistry.promoteReplica(id, patch)`:
   - clear `origin`, set `ownerNode = thisNodeId()`, `visibility: 'cross-node-readable'`
     (or the bundle's, when called from import), keep `acl`, `scope`, `syncMode`, `config`;
   - stamp `supersedes: { machineId, hostname, at }`, which is persisted in the descriptor.
4. Fire `notifyChange` so same-cluster peers pull now. Everyone else re-points on the next
   reconcile: `pullOne` → `upsertReplica` re-points `origin` to the serving peer.
5. The result carries a record count, the superseded origin, and a reminder: if the old
   origin returns, it will demote itself once nothing would be stranded.

`syncManifest` adds `supersedes?: string` (a machineId) to each manifest entry whose
descriptor carries `supersedes`. Old builds ignore the unknown field.

### Auto-demotion of a returning superseded origin (sync-engine)

During `reconcile`, suppose a peer P's manifest entry for dataset X names
`supersedes === thisNodeId`, and this node OWNS X (no `origin`). Then:

1. Pull P's copy LWW into the local dataset (`importBatch`, the same as today's
   dual-owner merge), so nothing of P's is lost here.
2. Compare the local records with P's export. Local records that are strictly newer than
   P's copy, or missing on P, would be STRANDED by a demotion. If any exist, do NOT demote.
   Record `status.errors: "takeover X by P: N local records not yet on P — staying
   dual-owner until P pulls them"`. P pulls them on its next reconcile, because an owner
   still imports from a peer that lists the dataset.
3. Otherwise demote: `DatasetRegistry.demoteToReplica(X, originOf(P))` sets `origin`,
   `ownerNode = P`, `visibility: 'local-only'`, `acl: []`, and a log line.

This runs only on an explicit `supersedes` marker naming THIS node. It never infers a
takeover from timing, so the existing dual-owner behaviour for any other cause is unchanged.

## Surfaces

### REST (`core/src/routes/core/data-bundle.routes.ts`, registered BEFORE the data routes)

Every path sits under `/data/bundles`, which is already relay-allowed through the `/data`
prefix. `bundles` joins `RESERVED_DATASET_IDS`. Routing keys are stripped with
`stripRoutingKeys`.

| method | path | purpose |
|---|---|---|
| GET | `/data/bundles/inventory` | What an export would contain: sections, per-dataset owned/replica/origin, whether the origin is online, record and tombstone counts, sizes, orphans, secrets excluded. Also sync health (last reconcile, errors). This is the "is my data safe" view. |
| GET | `/data/bundles` | List stored bundles: id, createdAt, size, source, section summary, `imported?` (uploaded vs local). |
| POST | `/data/bundles` | Create an export `{sections?, datasets?, includeReplicas?, includeKnowledge?, includeClaudeMemory?, note?}`. Synchronous; seconds at current sizes. Returns the manifest plus `{bundleId, sizeBytes, sha256}`. |
| GET | `/data/bundles/:id` | The manifest (inspect). |
| GET | `/data/bundles/:id/chunk?offset=&length=` | `{offset,length,total,dataB64,done}`. `length` ≤ 512 KiB, so relayed callers stay under relay limits. |
| GET | `/data/bundles/:id/download` | Raw binary (`application/gzip`, attachment) for direct callers. |
| DELETE | `/data/bundles/:id` | Delete a stored bundle. |
| POST | `/data/bundles/upload` | Chunked upload `{uploadId?, index, total, name?, dataB64, sha256?}`. Each chunk is ≤ 700 KB base64, so it passes the relay's 1,000,000-char body cap. Chunks are idempotent per `(uploadId,index)`. The final chunk assembles the file, verifies it (manifest, end hash, optional whole-file sha256) and stores it under a NEW bundleId. The source bundleId is kept in `importedFrom`. Stale partial uploads are swept after 1 h. |
| POST | `/data/bundles/fetch` | `{fromNode, bundleId}`: pull a bundle from another node through the hub proxy, chunk by chunk, verify it, and store it locally. |
| POST | `/data/bundles/:id/plan` | Dry-run `{policy?, sections?, datasets?, takeOwnership?}` giving per section/dataset counts: `add, update, skipOlder, skipIdentical, skipExists, tooLarge, neutralized`, plus `refused{code,reason}`, `warnings`, and sample ids (≤ 10 per bucket). |
| POST | `/data/bundles/:id/apply` | The same body **plus `confirm:true` required**. Returns the plan's shape with `applied` counts. |
| POST | `/data/datasets/:id/takeover` | `{force?}` (see Takeover). |

`/data/bundles/received/<name>` imports ONE file from `<dataDir>/received/` (the
`transfer_send_file` inbox): it is copied into the store under a new bundleId and verified
first. The name must match `^[A-Za-z0-9._-]{1,128}$` and resolve inside that directory.

`parseBody` in `rest-server.ts` must accumulate `Buffer`s and decode once. Today
`body += chunk` corrupts multi-byte UTF-8 split across chunks, which a bundle upload would
trip on in the JSON wrapper.

### MCP (both surfaces). Two tools in category `data`, which puts them in the extended + admin profiles.

- `data_export` `{action: 'inventory'|'create'|'list'|'inspect'|'delete', ...}`: `create`
  takes the export options.
  - Results stay compact, well under the 64 KB MCP result cap: manifest section summaries
    and counts, never records.
  - `create` returns `bundleId`, `path`, size and sha256, plus how to move the bundle:
    `data_import{action:'fetch', fromNode, bundleId}` on the target node.
- `data_import` `{action: 'plan'|'apply'|'fetch'|'takeover', bundle, policy?, sections?,
  datasets?, takeOwnership?, confirm?, fromNode?, dataset?, force?}`.
  - `bundle` is a bundleId, or `received:<name>`.
  - `apply` requires `confirm:true`. Without it the tool returns the plan and says so.

Both tools get `TOOL_SCOPES` entries: `data_export: 'read'`, `data_import: 'admin'`. They
also need category-map entries, `EXPANDED_HANDLERS`, a `tool-output-budget` entry and guide
prose. Numeric and boolean args are coerced with `numArg`/`boolArg`. The handlers call Core
REST through the house loopback hop.

### Web: `/data`, a new **Backup** tab (owner-usable, not gated on `canManage`)

- **Health:** the inventory table. For each dataset:
  - owned or replica, and the origin with an online dot;
  - records and tombstones;
  - scope;
  - a **Take over** button on replica rows whose origin is offline, with a typed-confirm dialog.

  Also shows last reconcile and errors, orphans, and what is never exported.
- **Export:** section checkboxes (datasets and config on by default; replicas, knowledge and
  Claude memory opt-in), a note, and **Create bundle**.
- **Bundles:** the list for the selected node, with Download, Plan import, Delete and
  "Copy to node…" (target-side fetch). Download uses the chunk route and assembles a Blob.
- **Import:**
  - sources: file upload (chunked), a stored bundle, or "fetch from node";
  - a policy select (merge / add-missing / replace);
  - per-section and per-dataset checkboxes and a takeOwnership toggle;
  - **Plan** renders the dry-run table; **Apply** requires a confirm dialog and shows the
    result.

The tab follows the house fetch rules: `apiClient.fetchPath` for JSON and `workerFetch`
for binary. `useMachineContext().selectedMachineId` targets another node.

### Scheduled snapshot (built-in job, **disabled by default**)

`data-snapshot`: every 24 h it runs a default export with note `scheduled`, and retention
prunes old bundles. The user enables it on the Backup tab or through the scheduler.
Disabled by default because it writes to disk on every node the build reaches.

## Fix-alongside (small, durability-relevant)

1. `DatasetRegistry.save` becomes atomic: write `<file>.tmp`, fsync, then rename; keep
   one `<file>.bak`. A corrupt `datasets.json` today silently loads as `[]`, and the next
   save persists the loss.
2. `origin-anchor`: a hub `503` whose body says the machine is offline, or a failure that
   occurs before forwarding, maps to `ORIGIN_UNREACHABLE` ("nothing written, retry
   freely"), not `ORIGIN_TIMEOUT`. Any other ≥500 stays `ORIGIN_TIMEOUT`.

## Tests (hermetic)

Tests set `HOME` and `LM_ASSIST_DATA_DIR` to temp dirs BEFORE importing modules, because
several modules hard-code `os.homedir()`, and they inject `DatasetRegistry`/`CacheBackend`.
Coverage:
- **Bundle files:** round-trip; corruption detection (truncated file, flipped byte,
  wrong end count); line cap; paging past the 50k cap.
- **Policy matrix:** each policy × each local state; tombstones; replace bumps versions.
- **Ownership:** each row of the ownership table.
- **Missions:** neutralization.
- **Config providers:** sanitize and merge; scheduled jobs import disabled.
- **Files sections:** safeJoin refusal.
- **Takeover and demotion:** takeover guards (online / offline / roster unavailable ±
  force); promote and demote; auto-demotion both branches (stranded → stay dual; clean →
  demote).
- **Datasets file:** atomic save.
- **Routes:** the confirm gate, id validation, chunk bounds, upload assembly and
  idempotency, reserved id.
- **MCP:** the tools are registered with scopes (the scope test), output-budget entries
  exist, and the catalogue stays under budget.
