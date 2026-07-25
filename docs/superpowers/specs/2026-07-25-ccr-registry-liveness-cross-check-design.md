# CCR registry liveness — cross-check, reap, and say where you looked

**Date:** 2026-07-25
**Backlog:** `bl_d29e16fb` (kept) · `bl_2ec8bf24` (retired duplicate)
**Status:** design

## The incident

A voice conversation asked what was running on the 117 host. The agent called
`ccr_remote_list`, got three entries all marked `alive: false`, and told the user nothing
was running. At that moment 43 Claude Code sessions were live in tmux — including the
mission controller, mid-turn.

Measured on 117 while writing this spec:

| registry entry | recorded pid | pid state | real session | real pid | tmux |
|---|---|---|---|---|---|
| `ccr-89mc8iuv` / `32c5294c` | 1319611 | **dead** | **live** | 1319220 | `ccr-32c5294c` exists |
| `ccr-5z15gcfx` / `9b43fd03` | 1339045 | **dead** | **live** | 1338505 | `ccr-9b43fd03` exists |
| `ccr-qlf1oji6` / `32c5294c` | `null` (inject) | — | **live** | 1319220 | — |

`ccr_remote_list` reported 3/3 dead while 3/3 pointed at live sessions.

## Root cause

`ccr-manager.ts:409` records `child.pid` — the pid of the detached **`ccr-bridge.js`
helper**, not of `claude`. `claude --resume` runs inside the tmux session created at
`ccr-manager.ts:382` under the tmux server, with a different pid entirely.

`list()` then computes `alive` from that pid and nothing else:

```ts
// ccr-manager.ts:577-579
export function list(): Array<CcrRecord & { alive: boolean }> {
  return Object.values(loadRegistry()).map((rec) => ({ ...rec, alive: isAlive(rec.pid) }));
}
```

So `alive` truthfully answers **"is the bridge helper up?"** while being presented under a
name every caller reads as **"is the session alive?"**. Those are different facts and they
diverge routinely — the bridge is a long-lived detached relay that exits on crash, on
`ccr_drive` teardown, or when its log fd closes, all while the session keeps running.

Three aggravating factors, all confirmed in the code:

1. **`strategy:'inject'` records are structurally `alive:false` forever.**
   `recordForLiveConnection` writes `pid: null` (`ccr-manager.ts:441`), and
   `isAlive(null)` returns `false` (`:95`). The most modern connect path — native
   `/remote-control` injection into a live session — can *never* report alive. It is
   the one path that only ever attaches to a session that is live by definition.

2. **Nothing ever reaps.** There is no TTL, no prune, no age-out — records are immortal
   until someone explicitly calls `stop()`. On the stage node `yitest` this has produced
   **8 dead entries dating to 2026-06-02**, ~2 months of accumulated garbage.
   (`terminal/registry.ts:181` has a `pruneDead()`; ccr-manager never got one.)

3. **The lie propagates.** `ccr-fleet.ts:60` feeds `list()` into `GET /fleet/ccr`, which
   the CCR web page polls every 5s. `web/src/lib/ccr-rows.ts:58-72` builds
   `bridgeBySession` with **no liveness filter at all**, so a 3-day-dead bridge still
   renders `connectionStatus: 'connected'`. It reads a field named `live`
   (`web/src/components/ccr/ccrTypes.ts:30-37`) that the server never emits — the server
   emits `alive` — so the UI silently ignores liveness entirely.

### Second-order: the caller could not tell where it had looked

The first query in the incident hit the hub's **default node**, which is on the `stage`
cluster, and returned nothing useful for a user whose sessions are on `prod`. The default
node is chosen **at the hub** (`assist-api` `/internal/mcp-relay`, by WS recency) — not in
this repo, so we cannot change the picker. What we can do is make a result *self-describing*:
an empty list that names the node and cluster it searched, and says how to widen, cannot be
mistaken for "nothing exists anywhere".

## Design

### 1. A new pure module: `core/src/terminal/ccr-liveness.ts`

All liveness reasoning moves into one dependency-injected module so it is testable without
spawning processes, following the `handleRemoteControlList` pattern already used in
`__tests__/ccr-remote-control-list.test.ts`.

```ts
export type LivenessSource = 'session-registry' | 'tmux' | 'bridge-pid' | 'none';

export interface CcrLiveness {
  alive: boolean;              // is the SESSION behind this entry live? (what callers mean)
  verifiedBy: LivenessSource;  // how `alive` was established
  unverified: boolean;         // true when nothing checkable existed — NOT an assertion of death
  bridgeAlive: boolean;        // the ccr-bridge.js helper (what `alive` used to mean)
  sessionAlive: boolean | null;// null = unknown
  tmuxAlive: boolean | null;
  sessionPid: number | null;   // the REAL owner pid, which is not rec.pid
  reason: string;              // human/agent-readable explanation
}
```

Resolution ladder — first checkable source wins, degrading gracefully:

| record has | check | `verifiedBy` | `alive` |
|---|---|---|---|
| `sessionId` | `sessionVerdict(sessionId).live` | `session-registry` | verdict's `live` |
| else `tmuxSession` | tmux has-session | `tmux` | session exists |
| else `pid` | `pidAlive(pid)` | `bridge-pid` | pid alive |
| none | — | `none` | `false`, `unverified: true` |

`sessionVerdict` is the authoritative source and is **already imported by ccr-manager**
(`ccr-manager.ts:20`) — it carries the pid-alive check, the `/proc` starttime pid-reuse
guard, and the tmux pane mapping. The fix is to use what the module already has.

`bridgeAlive` is always reported alongside, because "session live, bridge dead" is a real
and actionable state: the two-way relay is down and the entry should be reconnected, not
deleted. That state is precisely what the incident's three entries were in.

### 2. Reaping

```ts
export function isReapable(rec, liveness, { now, ttlMs }): boolean
```

Reap when `!liveness.alive` **and** `age > ttlMs` (default 24h, `CCR_REAP_AFTER_MS`).

Reaping is **bookkeeping only** — it removes a registry row and never signals a process or
kills a tmux. That is what makes it safe to do on read. An `unverified` row is reapable on
the same TTL because it has no `pid`, no `tmuxSession` and no resolvable session, so
`stop()` on it would already be a no-op — the row conveys nothing and can hold nothing.

`list()` reaps expired rows, persists only when something actually changed, and treats a
write failure as non-fatal: a read must never fail because a cleanup write did.

### 3. `list()` / `get()` / `pickConnectedBySession`

`list()` and `get()` return `CcrRecord & CcrLiveness`. `alive` keeps its name but changes
meaning to session liveness — safe, because nothing internal branches on it today (the web
type reads a non-existent `live`, and `pickConnectedBySession` calls `isAlive(rec.pid)`
directly rather than going through `list()`).

`pickConnectedBySession` (`ccr-manager.ts:628-633`) is upgraded to prefer a record whose
*session* is alive rather than whose *bridge* is alive, keeping its existing
`|| recs[0]` fallback. This is the `ccr_drive` target selector, so today a live session
with a dead bridge is treated as a last-resort fallback when it is in fact the best target.

### 4. Scope-aware result envelope

`GET /ccr/remote` returns:

```jsonc
{
  "remotes": [ /* records, each with the liveness block */ ],
  "searched": { "node": "yitest-Virtual-Machine", "cluster": "stage", "scope": "this node only" },
  "summary": { "total": 8, "alive": 0, "bridgeDown": 2, "unverified": 0, "reaped": 5 },
  "note": "CCR bridge registrations — NOT the list of running Claude Code sessions.",
  "hint": "…"   // present when nothing is alive
}
```

`searched` is built **in the route**, from `getHubConfig().hostname` and `getMyCluster()`,
so the node that actually served the request names itself. That is the only correct layer:
the MCP tool layer would name the local node even for a hub-relayed call, and the existing
origin footer — which does name node and cluster — is appended after the fact as
provenance, is skipped for error results, and reads as a signature rather than as an
instruction to widen the search.

The `hint`, emitted when the list is empty or nothing is alive, names the boundary and the
way out:

> No live CCR bridges on node `X` (cluster `Y`). This tool covers ONE node — other
> nodes and clusters are not included. For sessions running on this host use
> `cc_sessions`; across the fleet use `session_footprints(scope:'fleet')`; to target
> another node pass `node=<hostname>` (see `list_nodes` / `cluster_list`).

### 5. Pointing the agent at the right tool

The tool description is what made the wrong tool look right. Today
(`mcp-server/tools/expanded.ts:532-536`):

> "List **running** CCR remotes (load/mirror/connect bridges started via ccr_*), with liveness."

"running … with liveness" is a direct invitation to use it for "what is running". It becomes
an explicit disclaimer plus a redirect to `cc_sessions` / `session_footprints`, and the same
correction lands in `guide.ts:308`, which additionally documents the field as `live` when the
server emits `alive`.

### 6. Web: stop rendering dead bridges as connected

`web/src/lib/ccr-rows.ts` filters `bridgeBySession` to entries that are actually alive, so a
dead bridge no longer produces `connectionStatus: 'connected'`. Minimal change — the same
defect on the human surface.

## Deliberately out of scope

- **`session_footprints`' mtime-based `isActive`** disagrees with `cc_sessions`' pid-based
  `live` (a session can be `isActive:true` with a dead process and vice versa). Real, but a
  distinct question — `isActive` means "recently active", not "alive" — and changing it
  would reach into the fleet fan-out. Backlog it.
- **A pid-reuse guard for `bridgeAlive`.** `ccr-manager.isAlive` lacks the `/proc` starttime
  check `cc-sessions` has, so a recycled pid can report a dead bridge as alive. That is a
  false-*alive* risk, the opposite of this incident, and `alive` no longer depends on it.
  Backlog it.
- **The hub's default-node picker.** Not in this repo.

## Testing

New `core/src/__tests__/ccr-liveness.test.ts`, pure and dependency-injected — no processes,
no tmux, no filesystem:

1. **The incident, exactly** — dead bridge pid + live session ⇒ `alive:true`,
   `bridgeAlive:false`, `verifiedBy:'session-registry'`, `sessionPid` = the real pid.
   This is the regression that would have prevented the whole thing.
2. **inject record** (`pid:null`, live session) ⇒ `alive:true`, not the structural
   `false` it returns today.
3. **Genuinely dead** — dead bridge, dead session, no tmux ⇒ `alive:false`, and reapable
   once older than the TTL.
4. **Unverifiable** ⇒ `unverified:true` and `alive:false` — asserted as *unknown*, never
   reported as a confident death.
5. **tmux fallback** — no `sessionId`, tmux alive ⇒ `verifiedBy:'tmux'`.
6. **Reaping** — dead-and-old is removed; dead-but-fresh is kept; **live is never reaped
   regardless of age**; an unchanged map is not rewritten.
7. **Scope envelope** — empty list yields `searched.node` / `searched.cluster` and a hint
   naming both; a non-empty all-dead list also yields the hint.
8. **`pickConnectedBySession`** prefers the session-alive record over a bridge-alive one.
