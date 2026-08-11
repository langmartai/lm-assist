# Manual-operation guard for mission-controlled sessions

**Date:** 2026-08-11
**Status:** design, awaiting implementation plan

## Problem

Two distinct defects, found by measuring the live fleet on 2026-08-11.

### 1. Mission Control injects into sessions a human is operating

A mission session can be taken over by a person at any moment. Today nothing stops
Mission Control from writing into it. Worse, the one mechanism that detects human
presence is wired backwards: `mission-controller.ts:1896` converts detected human
activity into a `⟦WORKER-STATUS⟧ human-activity` line, which matches `STATUS_MARKER_RE`
and is therefore classified **material** — so a human typing *causes* an injection
instead of suppressing one.

`manageMode: 'handoff' | 'standby'` (`mission-model.ts:7`) already models the intent and
is already human-only to write (`mission.routes.ts:348` — the controller gets `FORBIDDEN`).
But it is restricted to `origin === 'onboarded'` missions (`:346`), only one of the four
session-write handlers consults it, and nothing ever sets it automatically.

### 2. Timer-driven passes burn tokens and change nothing

Measured across both controllers, 2026-08-04 → 2026-08-10:

| controller | node | injections | dominant gap |
|---|---|---|---|
| `ddd778da` | 117 | 58 | 30–50 min |
| `05898cc4` | 123 (leader) | 17 | 10–35 min |

Every tool those **75 passes** called, combined:

```
mission_schedule 63 · mission_changes 51 · mission_list 21 · bootstrap 11
mission_session_read 6 · guide 1 · ToolSearch 7 · Bash 5 · Write 1 · Edit 1
```

Zero `mission_place`, zero `mission_spawn`, zero `mission_update`, zero session drives.
**Not one of the 75 passes mutated anything.** Each pass costs a ~6.2 KB directive plus
its reads (`mission_list` alone returns 18 KB; `bootstrap` far more).

The two triggers responsible are both timers:

- `mission-engagement.ts:146` — the 45-min safety interval, whose `|| i.activeIds.length > 0`
  clause bypasses the "nothing changed" guard whenever any mission is non-terminal.
- `mission-engagement.ts:137` — the `readyUnbound` retry, re-engaging every 10 min, forever,
  with no ceiling.

Two stale missions keep both armed indefinitely: `mission_82998afe` (Gmail CDP connector —
work merged and deployed, mission never closed) and `mission_8984b299` (a June probe titled
"auto-close" that never closed).

## Design

Two layers of detection, one flag, and a hard split between timers and injections.

### Layer 1 — active pre-flight probe

`probeManualControl(sid)` runs immediately before any write into a mission session,
short-circuits on the first positive, and returns a reason.

| order | check | reason | cost |
|---|---|---|---|
| 1 | `attached && !hasAttachedTtyd` | `human-attached` | free — already collected |
| 2 | `managedBy:'unmanaged-tmux' && source:'external-terminal'` | `human-terminal` | free — already collected |
| 3 | composer holds unsubmitted text | `human-typing` | 1 `capture-pane` |
| 4 | `paneShowsQueuedMessage` (`cc.ts:225`) | `human-typing` | same capture |
| 5 | jsonl mtime newer than this sid's last `terminal-audit` entry | `foreign-driver` | `statSync` + file tail |

Signals 1 and 2 cost nothing new: `tmux.ts:138` already parses `#{session_attached}` and
`ttyd-manager.ts:938` already computes `hasAttachedTtyd`, both kept warm by
`process-status-store.ts:81` on a 1s→15s adaptive loop. `attached` currently has **zero
consumers** anywhere in the repo.

The cross-reference in signal 1 is essential, not incidental: lm-assist's own ttyd attaches
as a tmux client (`ttyd-manager.ts:1659`), so `attached` alone would read every open console
tab as a human.

Signal 5 is the takeover case. `audit.ts:46` already records every drive lm-assist performs;
nothing compares that log to the transcript. Input present in the jsonl but absent from the
audit log was sent by someone else — a person, another agent, or another node.

Probing before the write (rather than on a sweep) means the verdict cannot go stale between
check and injection. Cost is negligible: injections are rare by design after this change.

**Supporting refactors**, both paying down existing debt:

- Extract the busy-detection ladder from the closure at `ccr-manager.ts:553-578` so it is
  reusable. It is strictly better than `inspector.derivePhase`, which is known-broken —
  it returns `idle` while a Bash tool runs (documented at `ccr-manager.ts:544`).
- Add `composerIsNonEmpty()` over the existing `extractComposerBlock` (`cc.ts:235`).
  `composerHoldsText` only answers about known text.

### Layer 2 — passive latch

Invert the polarity at `mission-controller.ts:1896`: detected human activity latches
standby and returns **non-material**, producing no drive. Extend `detectHumanActivity`
(`mission-onboard.ts:61`) to non-onboarded missions, which compute no `humanActive` today.

This layer is the backstop for what the probe cannot see — chiefly cloud sessions, and
activity that occurred between injections.

### The flag

Widen `manageMode` to all missions by removing the `origin !== 'onboarded'` rejection at
`mission.routes.ts:346`. `undefined` ≡ `'handoff'`, so no existing mission changes behaviour.

Leave the human-only write guard at `:348` untouched. It already enforces that the
controller cannot release a session back to itself; release is the user's decision alone.

The latch records the probe's reason, so a mission carries *why* it went manual —
`human-attached`, `human-terminal`, `human-typing`, or `foreign-driver`.

### Enforcement — one choke point

All session-**write** paths route through a single `assertDriveable(sid)` that consults the
flag and runs the probe:

| write path | today |
|---|---|
| `handleSessionDrive` (`mission.routes.ts:1366`) | guarded, onboarded only — widens for free |
| `handleSessionAnswer` (`:1558`) | **unguarded** |
| `handleSessionControl` (`:1410`) | **unguarded** |
| `handleSessionResume` (`:2041`) | **unguarded** |

Two **read/selection** paths consult the flag directly rather than the probe, since neither
writes to a session and neither should pay a `capture-pane`:

| selection path | today | change |
|---|---|---|
| `listActiveMissions` (`mission-store.ts:197`) | standby counts toward the active set | exclude standby, so it stops arming the timers |
| `readyUnbound` / placement | could re-spawn over a manual session | exclude standby from placement |

A single helper also lets `send_session_message` and `terminal_send` adopt the same gate,
closing the route-around without duplicating logic.

### Timers never inject

`shouldEngage` stops returning a boolean and returns a verdict.

| trigger | today | revised |
|---|---|---|
| material change (liveness drop, gate transition, status marker) | inject | **inject** |
| active-set change, roster change, first-ever | inject | **inject** |
| 45-min safety interval | inject | **script check, record findings** |
| 10-min `readyUnbound` retry | inject | **script check, record findings** |

Timer ticks run deterministic checks and write findings to the mission and the control
journal. They never produce an injection. Only a genuine material change does.

The scripted checks answer questions that never needed an LLM:

- **Safety check:** for each active mission, is its bound session actually alive right now?
  Its stated purpose (`mission-engagement.ts:140-145`) is catching a material change the
  classifier missed — a deterministic question.
- **Placement check:** is the mission still ready and unbound? The deterministic path
  already exists in `placeStarvedMissions` + `advanceStarvation` (`STARVATION_TICKS = 15`)
  and continues to place missions in code. Placement is a spawn, not an injection, and is
  unaffected by this rule.

On a quiescent fleet the controller now receives zero injections. All 75 measured passes
would have been eliminated.

### Auto-inactive after prolonged absence of human input

A latch is sticky by design — the controller can never release it. Without an expiry,
every session a person ever touched accumulates as a permanently "active" mission,
which is the same stale-mission problem that armed the timers in the first place.

Track `lastHumanInputAt` on the mission's `control` field (excluded from `TRACKED_FIELDS`,
so writes are history-clean). It is set from the two detectors that already establish
human input: the passive transcript detector, and probe signal 5's unattributed-input
attribution.

After `manualIdleInactiveMin` minutes with no human input, set the mission's status to
`paused`. This reuses the existing `MissionStatus` (`mission-model.ts:5`) rather than
inventing a state, and it drops out of engagement for free: `listActiveMissions`
(`mission-store.ts:197`) already counts only `active | waiting`.

**Going inactive does not release the latch.** `manageMode` stays `standby`; waking the
mission remains a human-only action. An idle timer must never be the thing that hands a
session back to the controller — a person who stepped away for a day would return to find
it had been driven in their absence.

Default `manualIdleInactiveMin: 240` (4 hours), as a project setting alongside the
existing `missionSessionIdleCloseMin`. Long enough that stepping away does not flip it,
short enough that an abandoned session is dormant by the next day.

### Hazard this design introduces: the session reaper will kill manual sessions

`mission-session-reaper.ts` closes a tracked native session — **killing its tmux** — after
`missionSessionIdleCloseMin` (default 30) minutes of idle. Its idle timer is refreshed by
`touchActivity`, which is called from exactly two places: `handleSessionRead` and
`handleSessionDrive`. Both are lm-assist's own operations.

Once the guard blocks those paths for a standby mission, the session receives **zero
touches** and the reaper closes it roughly 30 minutes later. The feature as designed would
kill the terminal of the person it exists to protect.

Two required changes:

1. Exempt standby missions from `sweepIdle`.
2. Call `touchActivity` on **detected human input**, not only on lm-assist operations, so a
   session in active human use is never a reap candidate regardless of mode.

Change 2 is worth making independently of this feature: today a human can work in a
resumed mission session for an hour without the controller reading it, and the reaper will
kill it out from under them.

Related, and worth noting rather than fixing here: the reaper is in-memory and leader-only,
so a leader failover silently forgets every tracked session.

### Notify

- A mission history entry recording the latch, its reason, and its timestamp.
- A `MANUAL` badge with the reason on the mission card.
- The next event-driven pass directive lists missions that latched since the last pass, so
  the controller records them rather than silently finding them unreachable.

### Release

Human-only, via the existing `mission_update(id, manageMode:'handoff')`. No new surface.

## Risks

**No timer ever recovers a stall.** The 45-min heartbeat exists because of a real incident
(2026-07-15: every executor went quiet at once, native liveness lagged real death, and the
controller received no pass for hours). After this change nothing auto-recovers from a
blind spot in the material-change classifier — a stall becomes *visible* rather than
*silent*, but a person must act on it. This is a deliberate, accepted trade.

**A weak scripted check would be worse than the wasteful one it replaces.** If the safety
check reuses the same cached, lagging liveness read that missed the 2026-07-15 stall, it
will miss it again while appearing to cover it. The check must use an absolute read —
jsonl mtime plus `sessionVerdict` — not the per-tick delta signal.

**Cloud sessions get no automatic protection at all.** They have no tmux, so probe signals
1–4 do not exist. Signal 5 needs a local transcript, which a cloud session does not have on
this host. And the passive layer does not cover them either: `humanActive` is hard-coded
`false` on the cloud path (`mission-controller.ts:1561`) because cloud messages arrive as
plain strings rather than role-tagged, making human text indistinguishable from driven text.
The only cloud signal that exists is `classifyVia === 'remote-control-auto'`
(`ccr-live.ts:162`), a network call to api.anthropic.com costing hundreds of milliseconds —
unsuitable for pre-flight.

**For a cloud session, manual mode must therefore be set explicitly** via
`mission_update(manageMode:'standby')`. Neither layer will latch it for you. This is a real
hole, not a rough edge, and closing it requires fixing role-tagging on the cloud read path —
out of scope here and worth its own spec.

**`driveable` is defined inconsistently** — `s.inTmux` at `tmux-backend.ts:93` versus
`v.live` at `mission-controller.ts:1624`, the latter carrying a comment explaining that
`inTmux` falsely reported a user's plain-terminal session as dead. The probe must not
inherit the wrong one.

## Testing

- Pure-function tests per probe signal in isolation, including the ttyd cross-reference
  that stops our own console tab reading as a human.
- Regression test for the inverted polarity: detected human activity must produce **no**
  drive. This is the defect that motivated the work.
- Route tests asserting `STANDBY_MODE` on each newly-guarded handler.
- Seam test proving a latched mission drops out of `listActiveForEngage`.
- Regression test reproducing the 2026-07-15 shape — all executors quiet, liveness stale —
  asserting the scripted safety check records a finding.
- Test asserting a timer tick produces zero injections regardless of findings.
- Reaper tests: a standby mission is never swept; `touchActivity` fires on detected human
  input; and a session under continuous human use is never reaped despite lm-assist never
  reading or driving it.
- Auto-inactive tests: a latched mission goes `paused` after `manualIdleInactiveMin`, and
  its `manageMode` is still `standby` afterwards — the idle path must never release a latch.

## Out of scope

Closing the two stale missions that currently keep both timers armed. That is data hygiene,
needs no code, and is tracked separately.
