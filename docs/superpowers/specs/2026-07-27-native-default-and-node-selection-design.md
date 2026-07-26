# Native-by-default placement + LLM-taught node selection

**Date:** 2026-07-27 · **Node:** prod 117 · **Follows:** `bl_28543c78` (missions never started), `bl_1c861246` (unplaced work invisible to engagement)

## Problem

Two gaps, one cause.

1. **`env.isolation` defaults to `cloud`** (`mission-model.ts:247`). A cloud mission cannot be placed by `mission_spawn` or by the starvation safety net — `handleMissionSpawn` refuses it with `CLOUD_PLACEMENT` because cloud needs `ccr_cloud_start`. Since `cloud` is the *default*, the most common mission is the one the backstop cannot rescue. That hole was left open by the `bl_28543c78` pass and is the direct motivation here.

2. **Nothing knows which node a mission should run on.** Native placement needs a host, and the knowledge of which host is right — "117 holds the IP-pinned claude.ai cookie", "123's headless Chrome cannot navigate", "SG is hub-only, never install lm-assist there", "107 is Windows with the elevated worker" — exists only as prose in per-node memory files. It is not enumerable, not rankable, and not reachable by the controller at placement time.

The second is the interesting one. That knowledge is **learned**, and it keeps being re-learned: every one of those facts cost a session to discover. It must be writable by whatever agent learns it, and readable by whatever places work.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Node preference is **LLM-authored meta-reasoning**, not a fixed score | The reasons are qualitative and keep changing as the fleet is learned; a hardcoded scoring function cannot express "the cookie here is IP-pinned" |
| 2 | It lives in a **new fleet-synced `node-profiles` registry** keyed by hostId, versioned | Same shape as `backlog` / `mission-workflows` / `assist-content`; `machine_access` is node-local and never syncs, `cluster_describe` is keyed by cluster not node |
| 3 | Host+repo resolve **at placement time, by the controller** | Freshest signals — a node offline at create may be back at placement — and the controller is already an LLM in the loop |
| 4 | Repo-less missions get native **`shared`**; repo-bearing get **`worktree`**. `cloud` becomes explicit opt-in | Both native flavours are spawnable and net-coverable, closing gap 1 without blocking legitimately repo-less work |
| 5 | The registry carries **structured fields AND prose** | The controller reasons over prose; the deterministic safety net ranks on structured fields only, so prose can never silently change automated behaviour |
| 6 | Tool surface: **`node_profile` + `node_select`** | `node_select` answers the general "where should I do this work?", useful to any agent, not only missions |

## Architecture

### 1. `node-profiles` registry — the learned layer

Fourth instantiation of `createOverlayDocStore` (`doc-store.ts`), so versioning, rev history, validation and fleet sync come for free. Dataset `node-profiles`, cache backend, `scope:'fleet'`, reads never create it, writes origin-anchored.

Document key = **hostId** (gatewayId). State:

| field | type | meaning |
|---|---|---|
| `capabilities` | `string[]` | declared traits Core **cannot** observe — `claudeai-cookie`, `elevated-worker`, `browser-navigable` |
| `avoid` | `string[]` | what this node must not be used for — `browser-navigation`, `lm-assist-install` |
| `weight` | `number` | tie-break preference, default `0`, range `-100..100` |
| `notes` | `string` | the meta-reasoning prose — *why*. ≤4000 chars |

**Deliberately absent: anything Core can observe live.** Online status, platform, in-cluster membership, repos present, current conflicts and credential health are read fresh at selection. Declaring them would let them go stale, and a stale placement fact is worse than no fact — it is confidently wrong.

**This registry is written by LLMs, from MCP, as lessons are learned.** That is its purpose, not a side effect: when a session discovers that a node cannot do something, it calls `node_profile` and writes it back so the next placement already knows. The guide must say this explicitly.

### 2. Node facts — the observed layer

`core/src/fleet/node-facts.ts`, collected per selection:

- `online`, `hostId`, `hostname`, `platform` — from the node roster
- `cluster` + `inCluster` — from the cluster map (placement is cluster-scoped)
- `repos: string[]` — **new**: absolute paths of repos present on the node
- `conflicts` — from `session_footprints`: sessions occupying node/repo/branch/ports, `managed` vs unmanaged
- `credentials` — from `auth-status`: oauth + claude.ai cookie health

**Repo presence is the one genuinely missing signal.** `session_footprints` reports repos *in use*, not repos *present*. Sourced from the same project enumeration `list_projects` uses.

### 3. The ranker — one pure function, two consumers

`core/src/fleet/node-rank.ts`:

```
rankNodes(need: Need, facts: NodeFacts[], profiles: NodeProfile[]) -> Candidate[]

Candidate = { node, score, why: string[], blockers: string[] }

HARD (eliminate)  offline · out-of-cluster · `avoid` hits a required need
                  · repo absent when repo required · resource/exclusive conflict
SOFT (score)      capability match · weight · fewer footprint conflicts
                  · already holds the repo/branch
```

Pure: no IO, facts and profiles are injected. Every candidate carries `why[]`; every eliminated node carries `blockers[]`, so *"why not node X"* is always answerable. No silent filtering — the `bounded-is-not-honest` lesson.

Two consumers, deliberately asymmetric:

- **Controller (LLM)** — receives candidates **plus** `notes`. Reasons over the prose, may override the top pick, records why it differed.
- **Safety net (deterministic)** — takes `candidates[0]` computed with `notes` **excluded from scoring**. Prose cannot move automated placement.

### 4. Placement flow

```
mission_create  -> isolation defaults to 'worktree' if a repo is resolvable
                   from projects/env, else 'shared'.  host left UNSET.
                   status waiting (bl_28543c78), schedulable.

controller pass -> node_select({missionId}) -> ranked candidates + notes
                -> picks, mission_update({env:{host, repo?}}) + rationale tag
                -> mission_spawn -> bound, status active

safety net      -> if env.host unset, rank on structured fields only,
                   take candidates[0], journal the pick AND its why[]
                -> handleMissionSpawn (the proven path)
```

`cloud` is never chosen automatically; it is honoured when a caller asks for it explicitly.

### 5. Tools

| tool | mode | purpose |
|---|---|---|
| `node_profile` | read + write | get/list profiles; write `capabilities`/`avoid`/`weight`/`notes`. **The write path is how lessons get recorded.** |
| `node_select` | read | ranked candidates with reasons. `{missionId}` for a mission, or `{need:[...]}` standalone |

Both surfaces (stdio + `/mcp`). Registered at all five points (`configure.ts`, `registry/catalog.ts`, `tools/expanded.ts`, `tool-output-budget.ts`, `tool-topics.ts`). Output bounded per the tool-output-size audit.

`mission_place` gains a `candidates` field from the same ranker, so the existing pre-spawn call answers *where* as well as *whether*.

## Error handling

- `node_select` with **no eligible node** returns an empty `candidates` array **plus** `blockers` per rejected node — never a bare empty list (`bounded-is-not-honest`).
- Facts collection is **best-effort per source**: a `session_footprints` or `auth_status` failure degrades that signal and is reported in `degraded[]`, it never sinks selection. Placement must not stop because one probe timed out.
- A malformed/hand-edited profile is flagged and skipped, never fatal (the `machine_access` precedent).
- The safety net keeps its existing behaviour on refusal: journal + log every time, never a silent loop.

## Testing

- **Ranker** — pure, table-driven: hard filters each eliminate, soft ordering, `blockers[]` populated, `notes` provably excluded from the deterministic path (assert identical ranking with notes mutated).
- **Model/store** — validation bounds, rev/history, malformed profile tolerated.
- **Isolation default** — repo resolvable → `worktree`; none → `shared`; explicit `cloud` preserved; explicit env never overridden.
- **Placement** — controller resolution writes host+rationale; safety net picks deterministically when host unset.
- **Mutation-verify** the two load-bearing tests (default flavour, notes-exclusion), per the `bl_28543c78` discipline.

## Out of scope

- Auto-populating profiles from existing memory files (a migration; the registry starts empty and is taught).
- Cross-cluster placement — unchanged, still refused.
- Cloud placement automation (`ccr_cloud_start` from the safety net) — still a follow-up on `bl_1c861246`.
