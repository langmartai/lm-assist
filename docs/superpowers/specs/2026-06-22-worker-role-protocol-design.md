# Worker Role Protocol — Design

- **Date:** 2026-06-22
- **Status:** Approved design (pre-implementation)
- **Branch:** `feat/worker-role-protocol` (lm-assist)
- **Repos touched:** `lm-assist` only (core MCP server + bootstrap)

## 1. Problem & Goal

lm-assist can already run, drive, and read Claude Code sessions across hosts (CCR read/drive,
`send_session_message`, the `data_*` service, `bootstrap`/`guide`). What it lacks is a **role
identity**: a session has no first-class notion of "I am a **worker** doing tracked work, and
here is who (if anyone) is orchestrating me." Today an observer reconstructs worker progress
ad-hoc by reading the raw transcript / `post_turn_summary` (exactly what the live "onetimelogin"
worker watch does by hand).

**Goal:** a lean, convention-first **worker-role layer** so that:

1. A session can take **one active role — `worker`** — assigned **by itself or by another party**,
   and becomes **aware of it via `bootstrap`**.
2. A worker owns and reports a **task list** (hierarchical: groups / sub-tasks), each task with its
   own status — **its own tasks, not necessarily ones an orchestrator created**.
3. A worker **prints structured progress into its own LLM output every turn** (the fundamental,
   always-available status channel) and *optionally* also pushes status via messaging and/or the
   shared data service.
4. Any **orchestrator** (a session, or a human) can read a worker's status three ways and drive it,
   while being a fully **optional** participant — `none` and `inactive` are first-class states.
5. Every worker supports a universal **agree-gate**: it can pause before a sensitive step and wait
   for agreement, resolved by an orchestrator programmatically or by a human typing into the session.

Non-goal: replacing Claude Code's own task/todo tooling, or building an orchestrator dashboard/UI.
This defines the **protocol + the minimal tools + the bootstrap awareness**; orchestrators are
whatever already calls the connector.

## 2. Model

### 2.1 Roles

- A session has **at most one active role**. The only modeled role is **`worker`** (absence of a
  role = a plain session). Setting a role **replaces** any prior one; clearing returns to plain.
- Role assignment is **symmetric**: a session may self-assign (`set_role`), or another party may
  stamp it at launch (the launcher writes the same record / a marker). No silent inference.

### 2.2 Worker record (the durable state)

One record per active worker, keyed by `sessionId`:

```
{
  sessionId, role: 'worker',
  tasks: [ Task ],                       // worker-OWNED; one or many; self- or other-originated
  orchestrator: { id?, lastContact? },   // optional coordinator; none/active/inactive derived
  updatedAt
}
```

`Task` (flat-with-links so updates are simple; the tree is derived from `group` + `parentId`):

```
Task = {
  id, title,
  group?,            // e.g. a phase label ("Phase 1 — Hub")
  parentId?,         // sub-task linkage
  status: 'todo' | 'working' | 'blocked' | 'need_approval' | 'done' | 'skipped',
  progress?,         // free-form, e.g. "3/5" or 0..1
  detail?,
  gate?: {           // present only when an agree-gate has been raised on this task
    state: 'open' | 'agreed' | 'rejected',
    reason, requestedAt,
    decidedBy?, decidedAt?, note?
  }
}
```

- **Home:** the `data_*` service, system dataset **`workers`** (this *is* "Way 3", and it is
  cross-node-readable so a remote orchestrator can query it). A local `~/.lm-assist/role.json`
  marker is a fast cache for bootstrap and survives a data-service outage.
- **Orchestrator liveness** is *derived*, never stored as a flag: `none` (no `id`) ·
  `active` (`lastContact` within a freshness window, default 5 min) · `inactive` (`id` set but stale).

### 2.3 The `⟦WORKER-STATUS⟧` block (Way 1 — the fundamental channel)

Every turn, a worker prints a greppable block into its **normal LLM output** so any reader (human or
orchestrator) sees progress directly in the session, with zero infrastructure:

```
⟦WORKER-STATUS⟧ task=<id> phase="<group>" status=working|blocked|need_approval|done progress=10/12
 last: <what I just did>
 next: <what I will do>
 gate: <reason>            # only when status=need_approval
⟦/WORKER-STATUS⟧
```

This generalizes the `post_turn_summary` the orchestrator already reads. It is the **canonical**
channel: Ways 2 and 3 are accelerators and may be absent; Way 1 always conveys the full state.

## 3. Bootstrap integration

The existing bootstrap **identity block** (`core/src/mcp-server/mcp-session-resolver.ts`,
`identityHeader`) gains a **ROLE section**, rendered from the caller's worker record/marker:

- **Worker:** prepend a **WORKER CONTRACT** — *"You are a WORKER. Your tasks: \<tree summary\>.
  Orchestrator: `<id | none | inactive>`. CONTRACT: every turn print a `⟦WORKER-STATUS⟧` block
  (Way 1, always). If an orchestrator is active you MAY also `report_status` (Way 3) and message it
  (Way 2). Before any gated step, raise a gate and STOP until it is `agreed`."*
- **No role:** a one-line note that the session can `set_role` if it is meant to be a worker
  (no guessing).

The `guide("install")`-style topic gains a sibling `guide("worker")` / `guide("orchestrator")`
playbook, and the bootstrap concatenation includes a short **roles** topic so every connecting
session learns the protocol.

## 4. The three status channels (end-to-end)

| # | Channel | Worker side | Reader (orchestrator/human) side | Required? |
|---|---------|-------------|----------------------------------|-----------|
| 1 | **Read the CCR session** | prints `⟦WORKER-STATUS⟧` each turn | session-read: `ccr_cloud_read` / `cc_sessions` / `post_turn_summary` | **Always** (fundamental) |
| 2 | **Messaging (push)** | `report_status` fans to the orchestrator via `send_session_message` | reads its mailbox / `get_message_status` | Optional; only when orchestrator `active` |
| 3 | **Data service (pull)** | `report_status` writes the record to the `workers` dataset (`data_put`) | `worker_status` / `list_workers` (→ `data_query`/`data_get`), cross-node | Optional; durable source of truth |

**Precedence:** Way 1 is canonical and always works; Ways 2 & 3 accelerate (push + queryable store).
If 2/3 are unavailable, the worker degrades to Way-1-only and never fails its turn.

## 5. Orchestrator → worker control + the agree-gate

**Drive a worker:** `send_session_message` (injected context), direct CCR (`ccr_connect` /
`ccr_cloud_drive`), or `decide_gate` (resolve a gate).

**Agree-gate flow (universal to all workers):**

1. Worker raises a gate: `report_status(taskId, status:'need_approval', reason)` sets
   `task.gate.state = open`, **prints it in the status block, and STOPS** at that step.
2. Someone agrees:
   - **Orchestrator (active):** `decide_gate(worker, taskId, decision:'agree'|'reject', note?)` →
     flips `gate.state` and stamps `decidedBy`/`decidedAt`.
   - **Human (orchestrator `none`/`inactive`, hybrid/manual mode):** types the decision into the
     worker's CCR session directly (Way 1). The worker updates its own gate state.
3. The worker re-reads its gate state and only proceeds when `agreed`; `rejected` halts and asks for
   redirection.

This is the same pattern the live "onetimelogin" worker already uses ("Shall I proceed with the prod
deploy?") — promoted to a first-class, audited mechanism.

## 6. Launch modes

- **Auto** — an orchestrator launches the worker (`agent_execute` / `ccr_cloud_start`) and stamps
  role + its own id at launch (initial `set_role`). Orchestrator = `active`; gates resolved by
  `decide_gate`; all three channels live.
- **Manual** — a human launches the session; it self-assigns (`set_role`, self-defined tasks).
  Orchestrator = `none`; **gates fall to the human** (read Way 1, type the decision in). Ways 2/3
  still record status for later or other readers.
- **Hybrid** — a human drives the worker's CCR session directly **and** an orchestrator may attach
  (reading the worker via `worker_status` stamps it as the active orchestrator). Either can
  drive/agree; the worker tracks orchestrator `active`/`inactive` via `lastContact`.

## 7. MCP tools (4 new) + scopes

| Tool | Who | Effect | Scope |
|------|-----|--------|-------|
| `set_role` | self or launcher | set/replace the active role; define/append worker-owned tasks (auto-id if none); `role:'none'` clears | `write` |
| `report_status` | worker | update a task's status/progress/detail; raise a gate (`status:'need_approval'`); write Way-3 record + (if orchestrator active) Way-2 message | `write` |
| `worker_status` / `list_workers` | orchestrator/human | read a worker's task tree + open gates + orchestrator state; **reading stamps the reader as orchestrator and refreshes `lastContact`** | `read` |
| `decide_gate` | orchestrator/human | resolve an open gate (`agree`/`reject`, note) — the "agree" action | `admin` |

**Invariant (must not skip):** every new tool MUST be added to `TOOL_SCOPES` in
`core/src/mcp-server/configure.ts`. `assertScopesCoverTools()` runs in `buildServer()` *outside* the
`/mcp` try/catch — a missing scope crashes the whole Core process on the first `/mcp` call.

Cross-node: all four take the standard optional `node=` (workers/orchestrators may live on different
hosts; the `workers` dataset reads cross-node, keys per-node per the data-service rules).

## 8. Error handling / edge cases

- **One active role:** `set_role` replaces the role; a `set_role` naming a *new task* appends to
  `tasks[]` (worker owns many tasks) rather than spawning a second role.
- **Data-service outage:** `report_status` degrades to Way-1-print-only; tools never hard-fail the
  worker's turn. The local marker keeps bootstrap role-aware.
- **Stale orchestrator:** `lastContact` past the window → `inactive`; the worker stops Way-2 pushes
  (no live reader) but keeps Way-1 + Way-3.
- **Gate safety:** a worker must **never** proceed past an `open` gate; only `agreed` unblocks;
  `rejected` halts. Decisions are audited (`decidedBy`, `decidedAt`).
- **Self-identification:** bootstrap reads role from marker/record; if absent it states how to
  `set_role` — it never silently guesses a role.
- **Task-tree integrity:** `parentId`/`group` reference existing tasks or are dropped to top-level;
  parent status/progress is a *derived roll-up*, never authored directly.

## 9. Builds on (reused, not rebuilt)

`bootstrap`/`guide` identity injection · `data_*` service (the `workers` dataset = Way 3) ·
`send_session_message`/`get_message_status` (Way 2) · CCR read/drive + `post_turn_summary` (Way 1) ·
the existing `tier === 'orchestrator'` notion and orchestrator-command plumbing · `TOOL_SCOPES`.

## 10. Testing (TDD, pure-first)

**Pure (unit):**
- `⟦WORKER-STATUS⟧` formatter + parser round-trip (incl. the `gate:` line).
- Task-tree roll-up: child statuses/progress → parent (group/sub-task aggregation).
- Orchestrator-liveness from `lastContact` → `none` / `active` / `inactive` (window boundary).
- Gate state machine: `open → agreed|rejected`; cannot pass `open`; audit fields set on decision.
- Role transitions: one active role; replace; append-task; clear.
- Bootstrap ROLE-section rendering: worker / no-role / gate-open variants.

**Integration:** `set_role` → bootstrap reflects it → `report_status` writes record + prints +
(orchestrator active) messages → `worker_status` reads tree + stamps orchestrator → `decide_gate`
flips a gate → worker reads `agreed`. Reuses the existing data-tools + `guide` test harness
(`core/src/__tests__`, `node --test`).

## 11. Out of scope (YAGNI)

- No orchestrator dashboard/UI; no scheduling/queueing of workers.
- No multi-role sessions (exactly one active role).
- No new transport — everything rides the existing connector + data service + messaging.
