# Auto-Resume Sessions Stalled on Server Errors — Design

**Date:** 2026-06-24
**Status:** Approved (design)
**Goal:** Detect Claude Code sessions that STALLED on a non-user **server** error (HTTP 500, 529 "overloaded", server-side rate limiting — **not** the user's own usage/rate limit) and auto-resume them by sending `continue`, every ~5 minutes, with a capped backoff. Cover both **local** running sessions (each node manages its own) and **remote** cloud CCR sessions (only ONE elected monitor node in the fleet handles those, to avoid duplicate nudges).

---

## 1. Motivation

When the Anthropic API returns a transient server error (529 overloaded, 5xx, or server-side throttling), a Claude Code session often stops and waits — the work stalls until a human types `continue`. This wastes wall-clock on long autonomous runs. The recovery is mechanical and safe to automate **for server-side errors only**: the user's own usage/rate limit must NOT be auto-poked (continuing does nothing and is noise). lm-assist already has every primitive needed (see §9); this feature wires them into a small monitor.

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Monitor election (remote CCR scan) | **Automatic**, via convention over the hub's existing `list_nodes` (lowest online gateway-id self-elects; auto-failover when it drops) + a shared dedupe marker. **No hub-side changes.** |
| Retry / give-up | **Capped + backoff, then flag.** Nudge ~every 5 min, widen the interval after repeated no-progress, cap at N attempts (default 6), then mark `gaveUp` and stop. |
| Default state | **On by default** (a toggle exists but defaults true). Server-stalls only; never user-usage-limits. |
| Local vs remote | Every node auto-resumes its OWN local sessions; only the elected monitor scans+resumes remote cloud CCRs. |

---

## 3. The server-vs-user boundary (the safety-critical rule)

Reuse the existing ordered classifier in `core/src/terminal/cc-classify.ts`, which already separates the exact states:

- **Retryable (auto-`continue`):** `overloaded` (529 / "Overloaded" / "Waiting for capacity"), `server_error` (`API Error: 5xx` / "Internal server error"), `rate_limit_server` ("Server is temporarily limiting requests (not your usage limit)").
- **Never touched:** `rate_limit_user` ("usage limit reached" / "5-hour limit" / "You've been rate limited"), `auth_error`.

We extract a small pure helper `isServerStall(text: string) → { retryable: boolean, category: ScreenState }` from the matchers in `cc-classify.ts` so the same logic backs local detection, remote detection, and (optionally) both status engines — eliminating the documented duplication drift between `session-cache.ts` and `agent-session-store.ts`.

---

## 4. Architecture

```
                          scheduled-jobs.ts handler "stall-monitor" (intervalMinutes: 5, enabled by default)
                                                   │  every tick:
                 ┌─────────────────────────────────┼───────────────────────────────────┐
                 ▼                                  ▼                                   ▼
        (1) refresh election               (2) LOCAL detect+resume            (3) REMOTE detect+resume
        list_nodes (hub) → online           (every node, always)              (ONLY if this node is monitor)
        lowest gatewayId == me?             scan this node's live CC          list account cloud sessions
        → amMonitor                         sessions; classify last           (/v1/code/sessions); cloudRead
                                            error; if server-stall →           each active; classify; if
                                            sendMessage("continue")            server-stall → cloudDrive("continue")
                                                   │                                   │
                                                   └────────── retry-state store ───────┘
                                              ~/.lm-assist/stall-monitor.json
                                              { [key]: {attempts,lastNudgeAt,category,backoffStep,gaveUp} }
                                              + shared dedupe marker (cross-node data service) for remote keys
```

**Units (each one job, testable in isolation):**
- `stall-classify.ts` — pure `isServerStall(text)` (extracted from cc-classify matchers).
- `stall-state.ts` — pure retry-state machine: `planAction(state, now, seenProgress, cfg) → {action:'nudge'|'wait'|'giveup'|'reset', nextState}`. No IO.
- `stall-election.ts` — pure `electMonitor(onlineNodes, selfId) → boolean` (lowest gatewayId wins); IO wrapper `amIMonitor()` calls `list_nodes`.
- `stall-detect-local.ts` — find this node's server-stalled local sessions (IO: cc-sessions + session-cache).
- `stall-detect-remote.ts` — find the account's server-stalled cloud CCRs (IO: cloud session list + cloudRead).
- `stall-resume.ts` — resume one session (local → sendMessage; remote → cloudDrive); records the dedupe marker.
- `stall-monitor.ts` — the scheduled-job handler tying it together; owns the store + config reads.

---

## 5. Detection details

**Local (every node, each tick):**
1. `GET /terminal/cc-sessions` → sessions with `driveable===true`; for each, `GET /terminal/cc-sessions/:id/screen` → `state`. A session is a server-stall if `state ∈ {overloaded, server_error, rate_limit_server}`.
2. Cross-check session-cache: the last response has `isApiError:true` and its text classifies retryable, and there is no newer assistant/user turn (it's genuinely waiting). This catches CLI hangs that the live screen may not show.
3. The set = sessions to resume locally.

**Remote (monitor node only, each tick):**
1. List the **account's** cloud code sessions (`GET /v1/code/sessions?limit=N` — fleet-wide, not just this node's local `ccr-cloud.json` registry).
2. For each active/non-terminal session: `cloudRead(sid)` → scan the teleport transcript's last assistant text (and `cloudStatus` `worker_status`); classify. `requires_action` (blocked on a question) is **not** a server-stall — skip it.
3. The set = remote CCRs to resume.

---

## 6. Resume + retry state machine

- **Local resume:** `sendMessage(sessionId, "continue")` via the `injectViaChain` chain (remote-control → cc-session → tmux). Respects the idle-gate (`cc.ts` asserts `idle` before send); a `pending`/no-driver result counts as "not delivered" → recorded, retried next tick.
- **Remote resume:** `cloudDrive({ sid, text: "continue" })` (plain user turn; `reBootstrap:false`).
- **Per-session key:** local = `local:<sessionId>`; remote = `ccr:<sid>`. State in `~/.lm-assist/stall-monitor.json` (atomic write, 0600, mirrors `worker-store.ts`).
- **State machine (`planAction`, pure):**
  - First detection of a server-stall → `nudge` (attempt 1), record `lastNudgeAt`, `category`.
  - Still stalled next tick, `now - lastNudgeAt ≥ interval(backoffStep)` → `nudge` (attempt++), widen `backoffStep` (e.g. 5, 5, 10, 10, 15, 15 min).
  - `attempts ≥ maxAttempts` → `giveup` (set `gaveUp:true`, stop nudging, keep the record for surfacing).
  - **Progress seen** (a new assistant turn / state left the stall after a nudge) → `reset` (clear the record; it recovered).
  - Not yet due → `wait`.
- **Dedupe (remote, split-brain guard) — BEST-EFFORT, not a hard dependency:** the single-monitor guarantee comes from the deterministic election (§7); the dedupe marker is an *optional hardening* for the brief window where two nodes' `list_nodes` views disagree. **If** the cross-node data service is enabled (`dataServiceEnabled`), the handler checks/refreshes a `cache` key `stall-nudge:ccr:<sid>` (TTL ≈ interval) and skips a remote nudge already claimed within the window. If the data service is **off** (the default), dedupe is skipped and we accept the residual: at most one extra `continue` during a rare election-flux tick — harmless (a duplicate `continue` to an already-resumed or still-stalled session is a no-op or a single redundant nudge, never destructive). Local keys never need cross-node dedupe (only the owning node drives its own locals).

---

## 7. Election (Approach ①)

- Each tick the handler calls `list_nodes` (hub-mediated) → the set of **online** nodes with their gateway-ids; `electMonitor(online, selfGatewayId)` returns true iff `selfGatewayId === min(online ids)` by a deterministic ordering.
- Self-identity from `getHubConfig().gatewayId` (`hub-client/`).
- **Failover is implicit:** when the current monitor goes offline it leaves `list_nodes`, so the next-lowest elects itself on its next tick (≤5 min gap). No lease, no hub change.
- **Degenerate cases:** if `list_nodes` returns only self (no hub / single node), self is monitor (correct — a lone node monitors its own remotes). If `list_nodes` errors, skip the remote scan this tick (local still runs); do **not** assume monitor (avoids every-node-scans on a hub blip).
- **Cloud-creds requirement:** the remote scan needs Claude Code OAuth (for `GET /v1/code/sessions` + `cloudDrive`). An elected monitor that lacks usable cloud creds logs a one-line notice and skips the remote scan (local resume still runs) rather than failing the tick. (Election stays simple — lowest-id — and is not gated on creds; a credless monitor simply degrades to local-only, and a fleet with cloud work will normally have creds on its lowest-id node.)
- The best-effort dedupe marker (§6) covers the brief window where two nodes' `list_nodes` views disagree; absent the data service, a rare duplicate `continue` is tolerated as harmless.

---

## 8. Config, surfacing, safety

- **`core/src/project-settings.ts`** (mirror `dataServiceEnabled`/`memorySyncEnabled`): `autoResumeStalledEnabled` (default **true**), `autoResumeIntervalMin` (default 5), `autoResumeMaxAttempts` (default 6), `autoResumeRemoteScan` (default true; gates the monitor-only remote scan). Live-applied: a `PUT /project-settings` change re-reads in the handler (no restart).
- **Surfacing:** `GET /monitor/stalls` → `{ amMonitor, monitorNodeId, local:[{sessionId,attempts,category,lastNudgeAt,gaveUp}], remote:[…] }`. A read-only MCP tool (`stall_status`) wraps it for cross-node visibility. (A web panel is out of scope for v1.)
- **Safety:** never nudge `rate_limit_user`/`auth_error`; `continue` is the only injected text; the cap bounds noise; the dedupe marker bounds duplication; disabling the toggle stops all nudging immediately.

---

## 9. Reuse map

| Need | Reuse |
|---|---|
| server-vs-user classification | `core/src/terminal/cc-classify.ts` (`classifyScreen` / its matchers) → extract `isServerStall` |
| local live state | `GET /terminal/cc-sessions` + `/terminal/cc-sessions/:id/screen` |
| local API-error signal | `session-cache.ts` `responses[].isApiError` (the `isApiErrorMessage` parse) |
| local resume | `core/src/session-messaging/` `sendMessage` / `injectViaChain` |
| remote list | account cloud sessions `GET /v1/code/sessions` (as in `ccr-cloud.ts`) |
| remote read/classify | `ccr-cloud.ts` `cloudRead` / `cloudStatus` |
| remote resume | `ccr-cloud.ts` `cloudDrive({sid,text})` |
| 5-min loop | `core/src/scheduler/scheduled-jobs.ts` (`registerHandler` + a seeded job; auto-started at `cli.ts`) |
| fleet/online nodes + self id | `list_nodes` (hub) + `getHubConfig().gatewayId` |
| cross-node dedupe marker | the generic data service (`cache` backend) |
| config toggle | `core/src/project-settings.ts` |
| per-node JSON state | `~/.lm-assist/*.json` (atomic write pattern from `worker-role/worker-store.ts`) |

---

## 10. Testing

- **Unit (pure):** `isServerStall` on the exact strings (`Overloaded`, `API Error: 529`, `API Error: 500`, `Internal server error`, `Server is temporarily limiting requests (not your usage limit)` → retryable; `usage limit reached`, `5-hour limit`, `You've been rate limited`, auth → NOT). `planAction` state machine: first-nudge, backoff widening, cap→giveup, progress→reset, wait. `electMonitor`: lowest-id wins, self-only→true, ties deterministic.
- **Integration (mocked IO):** a mocked server-stalled local session → one `continue` sent; a mocked `rate_limit_user` session → NO send; cap reached → `gaveUp`, no further sends; a mocked stalled cloud session on the monitor → `cloudDrive("continue")`; on a non-monitor node → remote scan skipped; dedupe marker present → remote nudge skipped.
- **e2e (real, isolated — must not disturb the live fleet):** (a) drive a real local Claude Code session into a stall (or inject a synthetic `isApiError` transcript) and confirm the handler sends `continue`; (b) on the elected monitor, confirm a genuinely overloaded/5xx cloud CCR receives a `continue` and that a user-usage-limited one does not. Run the monitor loop on demand via `POST /scheduler/jobs/:id/run` rather than waiting 5 min.

---

## 11. Out of scope (YAGNI)

- Hub-side lease election (Approach ③) — only if convention+dedupe proves insufficient.
- A web dashboard panel (v1 is REST + MCP read).
- Auto-resuming anything other than server-stalls (no user-limit, no auth, no "blocked on a question").
- Resuming with anything other than the literal `continue`.
- Changing the existing status engines beyond extracting the shared `isServerStall` helper.

---

## 12. Build/execution note

Once the implementation plan is written, this feature is built by a **cloud CCR lm-assist worker** (created + bootstrapped via the connector's `ccr_cloud_start` + the bootstrap self-heal), assigned the worker role, implementing the plan task-by-task under this session's orchestration + review. Merge/publish remain user-gated.
