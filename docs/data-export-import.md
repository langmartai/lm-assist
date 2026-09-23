# Data export / import, backup, and dataset takeover

> Read before touching `core/src/data/bundle/`, the `/data/bundles*` routes, the `data_export` /
> `data_import` tools, dataset ownership (`origin`, `supersedes`, takeover, demotion), or before
> answering "is my data safe?".
>
> Design spec: `docs/superpowers/specs/2026-09-23-data-export-import-design.md`. Endpoint table:
> [api-endpoints](api-endpoints.md#data-bundles-export--import-backup).

## The verdict first: replication is not backup

A fleet-scoped dataset (backlog, the tool/content registries, node profiles, mission workflows)
has ONE writer, its **origin**, and read-only replicas on the other online nodes. That protects
against nothing you would restore from:

- **A replica is never re-served.** It is forced to `visibility: local-only`, `acl: []`, so a
  peer asking for it gets `PEER_NOT_SHAREABLE`. Before this feature it could not be promoted
  either (`update()` cannot clear `origin`; `dropDataset` refuses replicas).
- **Origin disk lost:** the first write on the rebuilt origin creates a NEW, EMPTY owned
  dataset. Every surviving copy is then a stranded read-only replica, silently.
- **A bad bulk write reaches every replica within one reconcile.** In-record history is capped
  at 20 revisions per item; there was no point-in-time copy anywhere.
- **Cluster-scoped datasets** (missions, mission-history, mission-views) are owned per
  cluster: a one-node cluster holds the ONLY copy.
- The backup subsystem (`backup_run`) tars `~/.claude` only; `~/.lm-assist` is deny-listed.

So "is the backlog safe?" — it is *replicated*, not *backed up*. The only point-in-time copies
are **bundles**. Turn on the `data-snapshot` scheduled job on each origin (and, if you want the
replicas copied too, on another node with `includeReplicas: true`).

## What is stored where

`<dataDir>` = `$LM_ASSIST_DATA_DIR` or `~/.lm-assist`. `{-dev}` = the suffix a dev Core uses.

| store | where | syncs? | in a bundle |
|---|---|---|---|
| dataset registry | `<dataDir>/data{-dev}/datasets.json` (atomic save + one `.bak`) | no — replica descriptors are written by the sync engine | each dataset's descriptor line |
| dataset records | `data{-dev}/cache/<id>.lmdb`, `sql/<id>.sqlite`, `vectors/ds_<id>` | per descriptor `scope` + `syncMode` | `datasets` (default: owned; replicas opt-in) |
| scheduled jobs | `<dataDir>/scheduled-jobs{-dev}.json` | no | config `scheduled-jobs` |
| machine-access profiles | `~/.lm-assist/machine-access{-dev}.json` (hard-coded homedir) | no | config `machine-access` |
| project settings | `<dataDir>/project-settings.json` (**shared** by dev and prod) | no | config `project-settings` |
| MCP access / tool profile | `mcp-access{-dev}.json`, `mcp-profile{-dev}.json` | no | config `mcp-access`, `mcp-profile` |
| knowledge base | `<dataDir>/knowledge/` (no dev suffix) | optional pull-only remote sync | opt-in `knowledge` |
| Claude project memory, own rules | `~/.claude/projects/<slug>/memory/`, `~/.claude/rules/` | memory mesh / rule autosync (mirrors, not backups) | opt-in `claude-memory`, `claude-rules` |
| bundles | `<dataDir>/bundles{-dev}/<bundleId>.lmbundle.gz` | no — moved explicitly | — |
| transfer inbox | `~/.lm-assist/received/` (hard-coded homedir, shared by dev and prod) | `transfer_send_file` target | importable as `received:<name>` |

## How datasets sync (the part that decides every import rule)

- The data service is gated by `dataServiceEnabled` (default **false**). Sync is **pull-only**:
  every `dataReconcileSec` (300 s) a node reads each ONLINE hub peer's manifest and pulls. A
  write also publishes a bus notify, which only same-cluster fabric peers act on at once, so
  cross-cluster convergence is bounded by the reconcile.
- A manifest lists only syncable, non-`local-only`, non-sensitive datasets. `scope: fleet`
  pulls from every online peer (whole dataset each time); `scope: cluster` only from
  same-cluster peers (updatedAt watermark). A missing scope counts as `cluster`.
- Apply is last-writer-wins by `isNewer`: `version`, then `updatedAt`, then `origin.machineId`.
- **One writer.** A replica's descriptor carries `origin`; a put returns `READ_ONLY_REPLICA`,
  and registry routes anchor writes to the origin over the hub (`ORIGIN_TIMEOUT` = may have
  landed, `ORIGIN_UNREACHABLE` = nothing written — see [backlog-registry](backlog-registry.md)).
  A write on a node with NO descriptor goes local and mints a **second owner** (split brain).
- Deletes are tombstones (`version + 1`), garbage-collected after 14 days on every synced
  descriptor. A node offline longer than that keeps a ghost record forever.
- A failed per-peer export is swallowed and reads as "applied 0" — a green
  `data_sync_status` does not prove replication.

## Bundles

A bundle is ONE file: gzip of UTF-8 JSON Lines, `lmb-<yyyymmdd>-<hhmmss>-<6hex>.lmbundle.gz`
(`^lmb-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$` — the only name a caller may give; paths are never taken
from a caller). No tar, so no member paths to traverse. Inspect one with
`zcat x.lmbundle.gz | head -1 | jq`.

```
{"t":"manifest","format":"lm-assist-bundle","formatVersion":1,"bundleId","createdAt","source":{nodeId,hostname,platform,lmAssistVersion,mode,cluster},"options","sections":[…],"totals","note"?}
{"t":"dataset","id","descriptor",…,"replicaOf"?}      then its {"t":"record","ds","r"} lines (raw, tombstones included)
{"t":"config","id","data"}                            {"t":"file","section","path","mtime","size","sha256","content"}
{"t":"end","entries":N,"sha256":"<hash of every preceding line>"}
```

- Plan, apply, upload, fetch and received-import verify the end line and every section hash; a
  damaged file is refused `BUNDLE_CORRUPT` naming the failed check (`end-hash`,
  `section-hash:dataset:backlog`, …). List and inspect read the manifest only (fast, unverified).
- Limits: 16 MiB per line, 1 GiB uncompressed (`BUNDLE_TOO_LARGE`); export refuses `DISK_LOW`
  below `max(512 MB, 3 × estimated size)` free.
- Written `0600` in a `0700` dir. **No encryption at rest** — a bundle holds private user data
  unredacted. Treat it like the data dir itself.
- Retention: exports and imports share the dir; the newest 20 are kept (`bundleRetention` in
  project-settings overrides; `PUT /project-settings {bundleRetention}` sets it, clamped 1–1000).
  An imported bundle is stored byte-for-byte under a NEW id with a `<id>.meta.json` sidecar
  (`importedFrom` = the manifest's original id, `via: upload|received|fetch`, and for a fetch
  `fromNode` + `sourceBundleId`, the id the peer stored it under).

## What travels, and what never does

**Default export** = every OWNED non-system dataset + the five sanitized config sections.
**Opt-in:** replicas (`includeReplicas`), `includeKnowledge`, `includeClaudeMemory` (memory AND
own rules, excluding `synced.*` mirrors). Datasets are read RAW (`DataService.exportRaw`):
unredacted, tombstones included, paged past the backend's 50k cap. An export that cannot prove
it read a dataset completely fails whole (`EXPORT_INCOMPLETE`) rather than stop short.

**Never exported:**
- secrets and identity — `api-token*`, `scoped-tokens.json`, `hub*.json`, `machine-id*`,
  `gateway-id*`, `tls*/`, `local-ui-secret`, `keys.lmdb`, `github-accounts.json`, browser
  profiles, harness provider keys, `controller*/`, `lanAccessToken`. Config keys matching
  `/(token|secret|password|api[-_]?key|cookie|credential|authorization|private[-_]?key)/i` are
  dropped and listed in the section's `redactedKeys` — visible, never silent.
- system and derived datasets (sql indexes, `knowledge`/`vectors` system datasets, `log-*`),
  the runtime datasets `node-clusters` and `mcp-bootstrap`, and missions' reserved ids
  `__controller__` / `__engagement__`.
- orphan LMDB/SQLite files with no descriptor (inventory lists them as `orphans[]`).
- session JSONL — `backup_run` owns `~/.claude`.

## Import: policies and ownership

`plan` is a dry run that writes nothing; `apply` needs `confirm: true` (the MCP tool without
it returns the plan and says so). Import **never deletes**: records present locally but absent
from the bundle are untouched.

| policy | absent locally | local older | local newer or identical |
|---|---|---|---|
| `merge` (default) | write verbatim | write verbatim | skip (`skipOlder` / `skipIdentical`) |
| `add-missing` | write verbatim | skip (`skipExists`) | skip |
| `replace` | write verbatim | write as a **new version** | new version unless identical content |

*Verbatim* keeps `version`, timestamps and `deleted`, and clears `origin` (the record becomes
locally owned). *New version* = `max(local, bundle) + 1` with `updatedAt = now`, so the restored
state out-LWWs every replica — that is what makes `replace` a rollback.

Ownership, per dataset (`bundleOwner` = the bundle descriptor's `origin.machineId ?? ownerNode`):

| local state | outcome |
|---|---|
| owned here | import per policy; warning `foreign-owner` when `bundleOwner` is another node |
| a replica here | refused `REPLICA_READ_ONLY` — import on the origin, or `takeOwnership: true` (runs the guarded takeover first) |
| absent, `syncMode: none` | created from the bundle descriptor, then imported |
| absent, synced, `bundleOwner` is this node or NOT online | created OWNED (`owner-offline` warning) — the rebuilt-origin / new-fleet path |
| absent, synced, `bundleOwner` online elsewhere | refused `OWNER_ONLINE` — it would mint a second owner |
| roster unreadable (hub down) | refused `ROSTER_UNAVAILABLE` unless `force: true` |

- Missions whose status is `active|waiting|blocked` land `paused` with `binding`,
  `control.spawnInFlight` and `lastSpawnRequest` cleared (counted `neutralized`), so the
  supervisor spawns nothing. A different source cluster adds a `cross-cluster` warning.
- Config: imported custom scheduled jobs land **disabled** (`importedDisabled` — a shell job
  is code execution); builtin overrides, differing project-settings keys and `mcp-profile`
  apply only under `replace`; `dataServiceEnabled`, `busEnabled` and `dataSyncViaFabric` are
  never flipped. Machine-access profiles whose key path is absent get `key-missing`.
- Files: `merge` behaves as `add-missing`; `replace` writes `<file>.bak-import-<ts>` first;
  Claude memory lands only where `~/.claude/projects/<slug>` exists (`unknown-project`).
- After an apply: one batched change-notify per dataset (peers pull promptly) and the tool /
  content overlay caches are invalidated.

## Takeover and auto-demotion

`takeover(dataset, {force?})` promotes a LOCAL replica to owner when its origin is gone:
refused `NOT_A_REPLICA`, refused `ORIGIN_ONLINE` while the origin is on the roster (**force
never overrides this**), refused `ROSTER_UNAVAILABLE` unless `force` (force covers exactly that
case). On success the descriptor loses `origin`, gets `ownerNode = this node`,
`visibility: cross-node-readable`, and a persisted `supersedes: {machineId, hostname, at}`;
same-cluster peers are notified and every other replica re-points on its next reconcile.

**Auto-demotion.** If the superseded origin comes back still owning the dataset, its reconcile
sees a peer manifest entry with `supersedes === <its own id>`. It pulls that peer's copy (LWW),
counts local records that are strictly newer or missing there, and:
- nothing stranded → demotes itself to a read-only replica of the new owner;
- something stranded → stays dual-owner and records
  `takeover <id> by <peer>: N local records not yet on <peer> — staying dual-owner until <peer> pulls them`
  in `status.errors`; the new owner pulls them next reconcile, then demotion completes.

Only an explicit `supersedes` marker naming THIS node demotes — timing never infers a takeover.

## Surfaces

- **REST** (`/data/bundles*`, relay-allowed via `/data`): inventory, create/list/inspect/delete,
  chunked download (≤ 512 KiB per chunk) and upload (≤ 700 KB base64 per chunk, idempotent per
  index, stale uploads swept after 1 h), fetch-from-peer, received-inbox import, plan, apply,
  and `POST /data/datasets/:id/takeover`. The route is the auth boundary (API token or hub
  relay); the work runs as the local principal. Full table:
  [api-endpoints](api-endpoints.md#data-bundles-export--import-backup).
- **MCP** (category `data` → extended + admin profiles):
  `data_export{action: inventory (default) | create | list | inspect | delete}` (scope `read`)
  and `data_import{action: plan | apply | fetch | takeover}` (scope `admin`). `bundle` is a
  bundleId or `received:<name>`; `apply` without `confirm: true` returns the plan and says so.
  Results are summaries and counts, never records.
- **Web:** `/data` → **Backup** tab — inventory health (owned/replica, origin online dot,
  Take over on an offline origin's replica), export, bundle list (download, plan, delete, copy
  to node) and import (upload / stored / fetch, policy, plan, confirmed apply).
- **Scheduled:** built-in job `data-snapshot` (`core/src/scheduler/data-snapshot.ts`) — every
  24 h, the default export with note `scheduled`, then retention. **Ships disabled** (it writes
  to disk on every node the build reaches). Its `lastResult` names the bundle, size and section
  counts; `DISK_LOW` and other refusals are a failed run starting with the code. Config opt-ins:
  `includeReplicas`, `includeKnowledge`, `includeClaudeMemory`. Enable it:
  `PUT /scheduler/jobs/data-snapshot {"enabled": true}` or `scheduler_jobs`; preview with
  `POST /scheduler/jobs/data-snapshot/run {"dryRun": true}` (writes and prunes nothing).

## Runbooks

**(a) The origin's disk is lost.** Pick ONE of:
1. *Rebuild the origin from a replica.* On a surviving node that holds the replica:
   `data_export{action:'create', includeReplicas:true}` (or `datasets:[…]` naming them — naming
   a replica opts it in). On the rebuilt origin, ideally before anything writes those datasets
   (the mission stores also create theirs on first READ):
   `data_import{action:'fetch', fromNode:<survivor>, bundleId}` → `plan` → `apply` with
   `confirm:true`. The bundle's owner is the old origin (this node, or an id no longer online),
   so the dataset is created OWNED. If a write already created an owned copy, the plan says
   `foreign-owner` and `merge` fills it by LWW.
2. *Promote a survivor.* `data_import{action:'takeover', dataset}` on the node with the most
   current replica (check `data_export` inventory: records, tombstones, origin online). If the
   old origin later returns with its disk, it demotes itself (above).

   Or restore from the newest `scheduled` bundle, if the origin ran `data-snapshot`: it holds
   the origin's own owned copy.

**(b) Roll back a bad bulk write.** On the ORIGIN: `data_export{action:'list'}` → pick the
last bundle from before the damage → `data_import{action:'plan', bundle, policy:'replace',
datasets:[…]}`. Read the `update` / `skipIdentical` counts and samples, then `apply` with
`confirm:true`. Every changed record comes back as a new version and propagates to the
replicas within one reconcile. Records CREATED after the bundle are not removed (import never
deletes) — remove those by hand. Without an older bundle there is nothing to roll back to:
that is what `data-snapshot` is for.

**(c) Move data to a new fleet.** On each source origin: `data_export{action:'create'}` (add
`includeKnowledge` / `includeClaudeMemory` as wanted). Move the bundle: `fetch` over the hub
if both sides share one; otherwise download it (Backup tab) and upload it on the target, or
`transfer_send_file` it into the target's `received/` and import `received:<name>`. On the
node that should OWN each dataset in the new fleet: `plan` → `apply`. The old owner ids are
not online in the new fleet, so datasets are created owned; missions arrive paused; custom jobs
arrive disabled; credentials are re-established the normal way.

## Traps

- **Import each dataset on ONE node** — its intended origin — and let replication carry it.
  The `OWNER_ONLINE` guard only knows the bundle's recorded owner: a second node importing the
  same bundle before the first node's copy has replicated to it creates a second owner.
- Importing onto a node that holds a **replica** is refused; importing onto a node with no
  descriptor **creates an owner**. Neither is a bug: that is the single-writer rule.
- `originOnline: null` in inventory means the roster is unavailable (hub down), NOT offline.
- Dev and prod Cores keep separate bundle dirs (`bundles-dev`), but share
  `project-settings.json`, the knowledge dir and `received/`.
- A bundle holds unredacted user data. It never holds secrets, so a restored node still needs
  its hub enrolment, API token and connector credentials.
