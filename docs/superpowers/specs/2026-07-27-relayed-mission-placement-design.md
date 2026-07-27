# Step B — a chosen node that actually receives the work

**Status: IMPLEMENTED, DEFAULT OFF (2026-07-28).** Approved and built as designed —
`core/src/mission/relay-spawn.ts` + the `placeStarvedMissions` branch, behind
`missionRelayedSpawnEnabled` (default `false`, confirmed `false` on prod 117). 22 tests,
the two safety properties mutation-verified. **NOT yet proven end-to-end**: the bar is a
binding whose node is not the leader, which is only reachable on `stage` — see §8.
Context: `bl_1c861246` / `bl_28543c78`. Step A (shipped separately) makes the node *choice*
reach the controller. This makes the choice *move the work*.

---

## 1. What is already true (measured today, from prod 117)

Step B is **not a new capability**. It is the leader using one that already exists.

| probe | result |
|---|---|
| `POST <hub>/api/tier-agent/machines/<stage-123>/proxy/mission/mission_probe_does_not_exist/spawn` | **HTTP 400**, body `{"success":false,"error":{"code":"MISSION_NOT_FOUND",…}}`, **107 ms** |
| `GET …/machines/<stage-123>/proxy/health` | HTTP 200, peer's own envelope (`yitest-Virtual-Machine`) |
| `GET …/machines/<bogus-id>/proxy/health` | **HTTP 404**, body `{"error":"Machine not found","message":"Worker not found"}` — **no `success` key** |

So: the relayed spawn reached stage 123's Core, executed `handleMissionSpawn`, and answered
in the peer's envelope. Nothing was created. `/mission` is **already** on
`ApiRelayHandler.ALLOWED_API_PREFIXES` (line 126) — **no allow-list change is needed**, and a
human's `mission_spawn(node: X)` already places on X today. The gap is only that the leader
never does it unattended.

## 2. The reliable three-way discriminator

🔴 **Not the HTTP status.** A peer *refusal* is 400 and a hub *failure* is 404 — both non-2xx,
opposite meanings. The discriminator is the **shape of the body**:

| body | meaning | retry |
|---|---|---|
| `success === true` | **PLACED.** `data.binding` is authoritative. | n/a |
| `success === false` | the **PEER refused** (`MISSION_NOT_FOUND` / `PLACEMENT_NOT_GO` / `CLOUD_PLACEMENT` / `ALREADY_BOUND`). Nothing spawned. | free, but pointless until the cause changes |
| hub 404 `Machine not found` | never dispatched — the worker is not connected | **free** |
| no `success` key / unparseable / our AbortController fired | **transport verdict, not a result** | **NEVER blind** — verify first |

`typeof body.success === 'boolean'` is the gate. A body without it must never be read as an
outcome. This is the exact hazard already on the record for the backlog write path — *a relay
504 body had no `success` key and slipped through as a successful write*, the worst possible
answer. The measured hub-404 body above has no `success` key, so this is live, not theoretical.

## 3. Verify, never guess

Everything that lands in the last row is `UNVERIFIED`, and `UNVERIFIED` is **resolved by
reading, never by re-sending**:

- Re-read `GET /mission/:id` **relayed to the target node** — not the local synced replica.
  The `missions` dataset syncs, and sync lag would make a landed binding look absent, which is
  precisely the state that would trigger a duplicate.
- Bounded: 3 reads over ~10 s (a spawn that has begun persists its binding well inside that).
- `binding.sessionId` present ⇒ **placed** — adopt it, do not re-send.
- Still absent ⇒ report `SPAWN_UNVERIFIED`, journal it, tag `ctl:spawn-unverified`, and stop.
  A human or a later tick resolves it by re-reading. Never by re-sending.

This mirrors the two outcome tables already in the codebase: `ORIGIN_TIMEOUT` vs
`ORIGIN_UNREACHABLE` (backlog writes) and `DELIVERY_UNVERIFIED` vs `TARGET_UNREACHABLE`
(session messaging). `unverified` is deliberately **not** `pending`, so no sweeper can
auto-redeliver it.

## 4. Duplicate-executor guard — three layers

The failure that matters: **two executors on one mission, on two machines.**

1. **`ALREADY_BOUND`.** `handleMissionSpawn` already refuses a bound mission unless
   `force:true`. **The automated path must never pass `force`.** Once the first binding is
   persisted on the target, a second attempt cannot spawn.
2. **Idempotency key** — closes the only window layer 1 does not: request in flight, binding
   not yet persisted, second request arrives. Add `requestId` to the spawn body; the target
   records it on the mission **inside the same persist as the binding**, and a repeat with the
   same key resolves to the stored binding (`idempotent:true`) instead of launching. Same
   shape as `POST /backlog`'s `requestId` and `send_session_message`'s `messageId`.
3. **In-flight marker.** Before relaying, the leader persists
   `control.spawnInFlight = {node, requestId, at}`. While it is set and younger than a TTL
   (5 min), nothing relays that mission again. Cleared on any settled outcome.

Ordering is load-bearing: **mark → relay → settle → clear.** A leader that dies mid-flight
leaves the marker; the next leader waits out the TTL and then **verifies by re-read** before
any re-send.

## 5. Binding provenance

`startNativeExecutor` writes `binding.node = decision.host || 'local'`, and `decision.host`
comes from `place()` = `m.env.host ?? ''`. So **`env.host` must be persisted BEFORE the
relay** — otherwise a remotely-spawned worker records `node:'local'`, a binding that claims
the leader for a session running elsewhere. Step A already records the host first, so the
order is inherited rather than newly invented.

Additionally the leader stamps, after a verified placement,
`binding.placedBy = {node:<leader>, via:'relay', requestId}` — so "who put this here" survives
in the record instead of being inferable only from a journal.

## 6. Race with the 15-tick starvation net

- **Exactly one relaying actor per cluster.** The net is the only thing that relays; Step A
  instructs the controller to *defer and tag*, never to spawn a mission it does not own.
- **The counter must not re-fire while a relay is outstanding.** The mission stays unbound, so
  it stays in `readyUnbound` and `advanceStarvation` would starve it every tick. The gate goes
  on `placeStarvedMissions` (via the in-flight marker), **not** on `readyUnbound` — the mission
  genuinely is unplaced and the controller should keep seeing it.
- **Failover mid-flight** is handled by §4.3: marker + TTL + verify-before-resend.

## 7. Blast radius

- **prod cannot reach this code.** Cluster `prod` has exactly one member (117), and
  `pickDeterministic` eliminates out-of-cluster nodes with a blocker — so the chosen node is
  always self and the relay branch is unreachable on prod.
- The exposure is **stage** (123 + 107). Worst realistic failure: a duplicate executor on a
  stage node, or a mission tagged `ctl:spawn-unverified` needing a human. No data loss, both
  visible in the journal and on the mission.
- **Recommendation: ship behind `missionRelayedSpawnEnabled`, default `false`.** Enable on
  stage, produce the evidence below, then decide about prod separately.

## 8. What would count as proof

Per the standing bar: **a mission whose `binding.node` is NOT the leader.** Concretely — a
mission created on stage, placed without human intervention, binding on the non-leader stage
node, `mission_executor_status alive:true` read through the relay, and the chosen host
attributable to `node_select` via the mission's own `adjustments` entry. A passing unit test
is not that, and I will say "not proven" rather than let a green suite stand in for it.

## 9. Explicitly out of scope

- `force:true` from any automated path, ever.
- Classifying an outcome from an HTTP status.
- Treating the locally-synced mission replica as proof of a remote spawn.
- Cloud (`isolation:'cloud'`) placement — still needs `ccr_cloud_start`; unchanged by this.
