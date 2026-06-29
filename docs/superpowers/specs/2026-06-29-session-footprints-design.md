# `session_footprints` — Cross-Fleet Session/Resource Survey (Design)

**Date:** 2026-06-29
**Status:** Design — pending user review, then implementation plan.

## Goal

Give the Mission Controller (and any caller) a single server-composed call that returns **every recent session across the cluster/fleet and what each one occupies** — node, repo, branch, worktree, *open changes* (uncommitted + unpushed), and listening ports — so the controller can **avoid colliding** with unmanaged in-flight work on a resource or repo before it places a mission worker.

lm-assist composes this picture server-side in **one shot**, instead of the controller LLM fanning out and querying each session/node individually.

## Background — current state

- **Placement model already exists.** `core/src/mission/mission-model.ts` `place(m, all)` returns `PlacementDecision`, including `{ go:false, reason:'resource', conflictWith }` and `{ go:false, reason:'dependency', waitOn }`. Its resource check (step 2) only considers **other missions** (`all`), never unmanaged sessions. This feature does **not** modify `place()` (see Non-goals); it adds an *advisory* signal the controller reads.
- **Session data is per-node/local.** `core/src/mcp-server/tools/list-recent-sessions.ts` reads the local `getSessionCache().getAllSessionsFromCache()` (fields incl. `cacheData.cwd`, `cacheData.fileMtime`, `sessionId`). There is no cross-fleet aggregate today.
- **Per-node tool routing exists.** `mcp__…__*` tools with a `node:` arg are relayed by the hub to that node's Core and run there (see `core/src/hub-client/api-relay-handler.ts` allow-list; `/cluster`, `/node`, `/data` are already allow-listed). Online nodes are enumerable via the hub `/api/tier-agent/machines` list (pattern: `fetchAllOnlineIds()` in `core/src/routes/core/cluster.routes.ts`).
- **Identity/cluster helpers:** `thisNode()`, `getMyCluster()`, `getHubConfig().hostname`, `getClusterRecords()` (gatewayId→cluster map).

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| What to protect against | Both resource **and** repo/work conflict (each session is a holder of node + repo/branch/worktree + ports) |
| Gather model | **Hybrid** — cached per-node snapshot, live relay refresh when stale, short composed cache |
| Resource depth | **Listening ports only** (port + proto + pid + proc); no docker/k8s/db fingerprint |
| Enforcement | **Advisory/directive** — controller reads the survey; `place()` is NOT changed |
| Name | `session_footprints` (MCP) / `GET /fleet/session-footprints` (REST) |
| "Changed files" | **Open changes** = uncommitted ∪ unpushed-committed (everything not yet committed *and* pushed) |
| Performance | Collectors **async** (never block the `:3100` loop) + **layered cache** + single-flight + stale-while-revalidate |

## Architecture & components

Four independently-testable units:

1. **Per-node collector** — `core/src/fleet/session-footprint-collector.ts`. Builds this node's `NodeFootprint` by joining the local session cache with git, ports, and mission bindings. Pure assembly over injected IO (subprocess runner, session list, bindings list) so it unit-tests without spawning processes. Owns the per-node and per-cwd caches.
2. **REST routes** — `core/src/routes/core/fleet.routes.ts`:
   - `GET /fleet/session-footprints/local` → this node's `NodeFootprint` (recompute-if-stale).
   - `GET /fleet/session-footprints?scope=cluster|fleet` → **composed** result (self + relay fan-out). `/fleet` added to the api-relay allow-list.
   - Registered in `core/src/routes/core/index.ts`.
3. **MCP tool** — `session_footprints` (`core/src/mcp-server/tools/` + scope entry in `configure.ts` `TOOL_SCOPES` = `read`). Calls the composed endpoint on the handler node. Args: `scope` (default `cluster`), optional `node` (target a specific node's `/local`). Read-only (`readOnlyHint:true`).
4. **Controller directive** — one step appended to `CONTROLLER_PASS_DIRECTIVE` + a line in `CONTROLLER_SYSTEM_PROMPT` (`core/src/mission/mission-controller.ts`). Advisory only.

## Data model

```ts
interface GitState {
  branch: string | null;
  worktree: string | null;        // git rev-parse --show-toplevel
  upstream: string | null;        // e.g. "origin/main"; null ⇒ untracked branch
  ahead: number;                  // commits not pushed
  dirty: number;                  // uncommitted file count
  pushed: boolean;                // false ⇒ this branch's work is not on the remote at all
}

interface SessionFootprint {
  cluster: string;
  node: string;                   // gatewayId
  host: string;                   // hostname
  sessionId: string;
  title?: string;
  transport: 'native' | 'cloud';
  managed: string | null;         // missionId if bound to a mission, else null  ← the "unmanaged" flag
  cwd: string;
  repo: string | null;
  git: GitState;
  openChanges: string[];          // uncommitted ∪ untracked ∪ unpushed-committed, deduped, capped ~20
  openChangesTruncated: boolean;  // true if more than the cap
  lastActiveRel: string;          // "3m ago"
  isActive: boolean;
}

interface PortHold { port: number; proto: 'tcp' | 'udp'; pid: number | null; proc: string | null; }

interface NodeFootprint {
  node: string; cluster: string; host: string;
  snapshotAgeSec: number; reachable: boolean;
  warming: boolean;               // no snapshot computed yet (cold) — fills within seconds
  stale: boolean;                 // snapshot older than the TTL (a refresh has been kicked)
  sessions: SessionFootprint[];
  ports: PortHold[];              // node-level (ports-only decision), listening sockets
}

interface ComposedFootprints {
  generatedAt: number;
  scope: 'cluster' | 'fleet';
  nodes: NodeFootprint[];
  unreachable: string[];          // node ids that could not be refreshed and had no cached snapshot
  partial: boolean;               // true if any node is warming/stale/unreachable — picture is incomplete
}
```

Ports are **node-level** (the ports-only decision), not attributed per session.

## Freshness, caching, async (the hybrid)

### THE HARD RULE — the request path never awaits a collector

**The MCP tool and the REST handler MUST NOT `await` any `git`/`ss`/`Get-NetTCPConnection` subprocess.** A request only ever **reads the in-memory snapshot and returns** — instantly. All collector work (which can be slow: a large repo's `git status`, a busy index, resolving `origin/HEAD`) runs in a **background refresher**, decoupled from serving. This holds even when the snapshot is cold or stale: the handler returns what it has (possibly empty/`warming`) and *kicks* a background refresh it does not wait on. So no git/port command time is ever on the response path.

**Background refresher (where all subprocess work lives).** A per-node refresher recomputes the local `NodeFootprint` off the request path:
- **Lazy + keep-warm:** starts on the first access; while there is recent demand (last access < ~2 min) it re-runs every ~15s so the cache stays warm; it idles out when demand stops, so an unused node does no perpetual scanning.
- **On-access kick:** a request that finds the snapshot stale/cold also triggers a refresh (in addition to the timer), single-flight.
- **Single-flight:** a refresh already in progress is shared — concurrent requests never spawn duplicate `git`/`ss` processes.
- **Async + bounded:** every subprocess is promisified `execFile` (never `*Sync`), **~2s timeout**, per-session git scans bounded-parallel (~4); a timed-out/failed command yields an empty field, the snapshot still publishes (best-effort, never throws).

**Caches (all reads, never block):**
1. **Per-cwd/worktree git cache** (TTL ~10s) — N sessions in one repo ⇒ one git scan.
2. **Per-node snapshot** — the live in-memory `NodeFootprint` the refresher publishes; the request reads this.
3. **Composed-result cache** (TTL ~5s) on the handler node.
4. **Last-known peer snapshot retained** — a slow/unreachable peer is served from its last snapshot (flagged `reachable:false`, with `snapshotAgeSec`) rather than dropped; a peer with no prior snapshot lands in `unreachable[]`.

**Freshness metadata, always returned:** `snapshotAgeSec`, `stale` (older than TTL), `warming` (no snapshot computed yet). The first survey right after Core boot may be `warming` / local-only and fills within a few seconds — acceptable for the controller's ~1-min cadence, and the keep-warm timer makes it rare in practice.

**Composed call — also no git on the path.** Because every node's `/local` is a pure cache read, the composed handler only ever pays **bounded network**, never command time:
- Serve the ~5s composed cache when warm (instant).
- On a miss: fan out to online peers' `/local` (self in-process; peers via the relay proxy) with a **~2.5s per-node timeout** and `Promise.allSettled`, so one slow/dead node never blocks the result; merge → `ComposedFootprints`, cache it. Each peer `/local` returns its cached snapshot immediately, so this awaits only relay round-trips (async — other API/MCP requests keep being served), not git.
- `scope=cluster` (default): online ids from the hub `/machines`, filtered to my cluster via `getClusterRecords()`; `scope=fleet`: all online.

**Why not the dataset sync:** the cross-node data-service sync is pull-based (default ~300s reconcile) — far too stale for "what's running right now," and would couple freshness to a slow timer. Freshness comes from the **direct relay fan-out** to peers' already-warm `/local`. No persisted/synced snapshot is introduced.

## Collectors (per node; all degrade gracefully)

**Sessions.** `getSessionCache().getAllSessionsFromCache()`, filtered to *recent* (`isActive` OR `fileMtime` within 30 min), sorted newest-first, capped ~15/node. `cwd` from `cacheData.cwd`; `transport` from the sid shape (`session_`/`cse_` prefix ⇒ cloud, else native); `title`/`isActive`/`lastActiveRel` from cache.

**Git** — per unique worktree/cwd, cached (TTL ~10s), async `execFile`, 2s timeout, **`GIT_OPTIONAL_LOCKS=0` + `--no-optional-locks`** on every command (read-only; never takes/refreshes the index lock, so the survey cannot block, be blocked by, or disturb the observed session's own git):

1. Branch + upstream + ahead + uncommitted, one call:
   `git -C <dir> --no-optional-locks status --porcelain=v2 --branch --untracked-files=normal`
   Parse `# branch.head`, `# branch.upstream`, `# branch.ab +A -B`, and `1`/`2`/`?`/`u` lines (rename ⇒ new path) → branch, upstream, ahead, uncommitted+untracked paths.
2. Worktree root:
   `git -C <dir> --no-optional-locks rev-parse --show-toplevel`
3. Committed-but-unpushed files:
   - upstream present & ahead>0: `git -C <dir> --no-optional-locks diff --name-only @{upstream}..HEAD`
   - no upstream ⇒ `pushed:false`; base = `git -C <dir> rev-parse --abbrev-ref origin/HEAD` (else `origin/main`/`origin/master`); if base resolves: `git -C <dir> --no-optional-locks diff --name-only <base>...HEAD`; no remote ⇒ skip (dirty files only).

`openChanges` = (uncommitted ∪ untracked ∪ unpushed-committed), deduped, capped ~20 (`openChangesTruncated` when more). Non-git cwd: command 1 exits non-zero (`not a git repository`) → repo/branch/worktree null, `openChanges` empty, no error. Common pushed-branch case = **2 git calls**; with unpushed commits = **3**; shared across sessions in the same repo.

**Ports** — listening sockets only, owning pid/proc where resolvable; each node uses its own OS path:
- POSIX (117/123): `ss -H -tlnp` (and `-ulnp` for udp) → parse `LocalAddress:Port` + `users:(("proc",pid=N,…))`.
- Windows (107): `Get-NetTCPConnection -State Listen` → `LocalPort`,`OwningProcess`; resolve proc via `Get-Process -Id`.
- Timeout 2s, cached with the node snapshot. Unsupported/empty → `ports: []`.

**Managed tag.** Join each session's `sessionId` (and cloud `cse`/`sid`) against current mission bindings (mission store — every mission's `binding.sessionId` / `binding.ccr.{cse,sid}`). Match ⇒ `managed = missionId`; else `null`.

## Controller integration (advisory — the only behavior change)

Append to `CONTROLLER_PASS_DIRECTIVE`, before acting on `mission_schedule.ready`:

> Before you place/spawn an executor, call `session_footprints` (your cluster). For each candidate placement, AVOID a node/repo/branch/worktree that an **unmanaged** recent session occupies — especially one with `openChanges` overlapping the mission's repo/branch, or whose branch is `pushed:false` (its work isn't on the remote yet) — and avoid a port an exclusive service holds. If the only available placement collides, **defer**: leave the mission `ready`, tag it `ctl:deferred-contention` with the conflicting session, and revisit next pass rather than spawn into a conflict. Mission-managed sessions (`managed` set) are your own executors — not foreign; never treat them as conflicts. If the survey comes back `partial`/`warming` (a node not yet surveyed this boot), treat the unknown nodes as clear but re-check next pass — do not block all placement on incomplete data.

Add a one-line pointer in `CONTROLLER_SYSTEM_PROMPT` naming the tool. `place()` and the deterministic scheduler are unchanged.

## Error handling

- Every collector is best-effort: a failed/timed-out command yields empty/partial fields; the snapshot always returns.
- Composed call uses `Promise.allSettled` + per-node timeout; unreachable peers are reported (served stale if a prior snapshot exists), never fatal.
- The MCP tool returns a structured result even when some nodes are degraded (so the controller can still decide), with `unreachable[]` and per-node `reachable`/`snapshotAgeSec` surfaced.

## Testing

**Unit (pure, fixture-driven — no real subprocess):**
- `status --porcelain=v2 --branch` parsing → branch/upstream/ahead/dirty/files (incl. rename, untracked, no-upstream).
- unpushed-committed selection (upstream present vs no-upstream fallback to `origin/HEAD`/default base).
- `openChanges` union + dedupe + cap + `openChangesTruncated`.
- `ss -H -tlnp` parsing and `Get-NetTCPConnection` parsing → `PortHold`.
- managed/unmanaged tagging (native sid, cloud cse/sid) against bindings.
- **request handler never awaits a collector**: with a slow/blocking subprocess stub, the handler still returns synchronously from cache (cold ⇒ `warming:true` + a refresh is kicked but not awaited); the background refresher later publishes the snapshot.
- staleness/freshness flags (`warming`/`stale`/`snapshotAgeSec`), single-flight coalescing (one in-flight refresh shared), and keep-warm start-on-access + idle-out.
- composed merge: self + peers, per-node failure → `reachable:false` + last-known, no-snapshot → `unreachable[]`.

**Integration:**
- composed endpoint fans out over a mocked relay and merges; one peer times out → result still returns with that node flagged.

**Snapshot:**
- `CONTROLLER_PASS_DIRECTIVE` contains the `session_footprints` step and the `ctl:deferred-contention` instruction.

## Non-goals

- No change to deterministic `place()` / scheduler (advisory only).
- Ports only — no docker/k8s/db fingerprinting.
- No persisted/fleet-synced snapshot dataset (live relay fan-out + in-memory cache only).
- Default scope is the controller's cluster; `fleet` is opt-in via the `scope` arg.
- Not a continuous monitor/alert — it's a pull survey on demand (with caching).

## Deployment note

Core-only change (`core/dist` + the directive). Deploys to the worker fleet by syncing `core/dist` + restart (the established core-only fleet rollout); the new MCP tool surfaces after a connector `refresh_connector_tools` + `set_connector_auto_approve`. No web change.
