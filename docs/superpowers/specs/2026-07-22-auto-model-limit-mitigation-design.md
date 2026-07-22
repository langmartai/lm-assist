# Auto model-limit mitigation — design

**Date:** 2026-07-22
**Branch:** `feat/auto-model-limit-mitigation`
**Mission:** `mission_7ac56d4b`

## Problem

A Claude Code session (local session, mission executor, or cloud CCR) hits a **per-model
usage limit** and stalls forever:

```
⎿  You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.
```

lm-assist's stall-monitor only auto-resumes **SERVER/NETWORK** stalls (`overloaded`,
`server_error`, `rate_limit_server`, `connection_error`) by sending `continue`. A model
limit is none of those, so nothing fires and a human has to `/model opus` by hand. This
happened twice on our own executors on 2026-07-22.

Sending `continue` to a model-limited session is useless — the model is what's exhausted,
not the connection. Conversely, switching model on a 529 would be wrong. **These are two
distinct classes and must never share a code path.**

## Ground truth (measured, not assumed)

Captured from live sessions on node 117 before writing any code.

**1. The limit banner** (session `16946066`, a real stuck mission executor):

```
⎿ You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.
✻ Sautéed for 0s
```

**2. A near-miss that must NOT trigger** (session `7af7075c`) — the Fable promo notice:

```
▎ Through July 12, you can use up to 50% of your weekly usage limit on Fable 5. If you hit
▎ your limit, you can continue on Fable 5 with usage credits.
```

It contains "your limit" and "Fable 5" but the session is perfectly healthy.

**3. The status line carries the live model**, immediately after the session id:

```
no worktrees ctx:23% ... sid: 16946066-1a70-4a61-8b67-d346b50cd84a Fable 5
no worktrees ctx:0%  ... sid: 24259b9d-e1b3-46fe-af28-2ca0904e5366 Opus 4.8   ◈ max · /effort
```

This is the **verification signal** — after a switch, this token must no longer be the
limited model.

**4. `/model <arg>` works non-interactively** through the existing `cc.slash` path
(`POST /terminal/cc/:name/slash {cmd:'model', args:'opus'}`), verified in both directions:

```
❯ /model sonnet
  ⎿  Set model to Sonnet 5 and saved as your default for new sessions
```

⚠️ **Side effect:** `/model` also **saves the global default for new sessions**. Accepted:
when a model is exhausted, moving new sessions off it is the desired behavior. It is
journaled so the change is never silent.

**5. `classifyScreen` currently reports the limited session as `busy`.** The `⏵⏵` /`✻`
busy heuristic matches on essentially every bypass-mode session, so `state === 'idle'` is
not a usable gate. Two consequences:

- Detection must be a **banner pattern** (banners are ranked by recency and return before
  the busy heuristic), not a post-busy check.
- The action must gate on `cc.slash`'s own `assertPhase(['idle'])`, exactly like `/compact`.

## Design

### Components

| File | Responsibility |
|---|---|
| `terminal/cc-classify.ts` | new `model_limit` ScreenState + banner patterns |
| `monitor/model-limit.ts` | **pure**: `detectModelLimit`, `parseCurrentModel`, `normalizeModel`, `decideModelSwitch` |
| `monitor/model-fallback-store.ts` | switch journal `~/.lm-assist/model-fallback.json` (0600, atomic) |
| `monitor/model-fallback.ts` | `runModelFallbackTick(deps)` — find → decide → act → verify |
| `monitor/stall-monitor.ts` | runs the model-fallback tick alongside the resume tick |
| `mission/mission-controller.ts` | supervisor guard so the **controller** self-heals (mirrors `/compact`) |
| `project-settings.ts` | `autoModelFallback*` knobs |
| `routes/core/monitor-stalls.routes.ts` | surfaced in `/monitor/stalls` + MCP `stall_status` |

### The safety boundary (the whole point)

`SERVER_STALL_STATES` **does not** and must never include `model_limit`. That single fact
gives both guarantees:

- **never send `continue` on a usage-limit** — the resume tick only looks at
  `SERVER_STALL_STATES`, so a model-limited session is invisible to it.
- **never switch model on a server error** — the model-fallback tick only acts when
  `detectModelLimit` matches a model-named "reached your … limit" banner.

They are separate ticks, separate stores, separate config.

### Detection

Fires only when a **known model family** appears inside a "reached your … limit" phrase:

```
/(?:you(?:'|’)?ve|you have)\s+reached\s+your\s+((?:claude\s+)?(?:opus|sonnet|haiku|fable)[\w.\s-]{0,8}?)\s+limit\b/i
```

Requiring both `reached your` and a model token rejects ground-truth sample #2 (promo
notice: no "reached your") and the account-wide `rate_limit_user` banner ("Claude usage
limit reached" — no model token), which stays a `rate_limit_user` and is never
auto-switched.

`parseCurrentModel` reads the status line (`sid: <uuid> <Model>`, terminated by 2+ spaces
or EOL) and returns null unless the token normalizes to a known family.

### `decideModelSwitch` — ordered, pure, fully injected

| # | Condition | Action |
|---|---|---|
| 1 | `!enabled` | noop `disabled` |
| 2 | no limit banner | noop `no-model-limit` |
| 3 | limited family ∉ `from` | noop `not-a-from-model` |
| 4 | fallback family == limited family | noop `fallback-is-limited` |
| 5 | **current model ≠ limited model** | noop **`already-on-fallback`** / `not-on-limited-model` |
| 6 | within cooldown of last switch | noop `cooldown` |
| 7 | otherwise | **`switch`** to fallback |

Rule 5 is the load-bearing one: **you can only be blocked by the model you are actually
running on.** The banner is transcript history — it scrolls, it never clears, and it can
appear on screen for reasons that are not a live block. So the live status line decides,
not the presence of a banner. This single rule delivers both:

- **idempotency** — after a switch the banner remains, but the model has moved ⇒ no-op;
- **anti-false-positive** — a session merely *displaying* the text (reading a capture,
  editing these very tests, discussing the feature) is never switched.

### Action + verification

1. `cc.slash(tmux, {cmd:'model', args:<fallback>})` — throws if not idle → retry next tick.
2. **Settle the confirm dialog** (see "Found in live testing" below).
3. Re-read the screen (short settle delay) and re-`parseCurrentModel`.
4. `verified = currentModel !== limitedModel`. Journal either way; an unverified switch is
   retried after the cooldown rather than looped on.

Steps 1–2 live in one shared `sendModelSlash()` used by **both** the tick and the
mission-controller guard, so the controller and executors behave identically.

Remote (cloud CCR) mirrors this via `cloudDrive({text:'/model <fallback>'})`, monitor-node
only, gated by the existing `autoResumeRemoteScan`. Verification is best-effort (no status
line) — the next scan re-detects if it didn't take.

### Config (mirrors the `autoResume*` family)

| Setting | Default | Meaning |
|---|---|---|
| `autoModelFallbackEnabled` | `true` | master switch |
| `autoModelFallbackModel` | `'opus'` | model to switch **to** |
| `autoModelFallbackFrom` | `['fable']` | families whose limit triggers a switch |

Scope: local sessions per-node; cloud CCRs only by the single elected monitor — identical
to the auto-resume election.

## Found in live testing (not predictable from the code)

Three things only the live run against real sessions revealed. All three are now covered
by tests using the verbatim captures.

**1. `/model <x>` is not always one-shot.** On a conversation already cached for the
current model (the 233k-token executor), it opens a confirm dialog:

```
  Switch model?
  This conversation is cached for the current model. Switching to Opus 4.8 means the
  full history gets re-read on your next message.
  ❯ 1. Yes, switch to Opus 4.8
    2. No, go back
```

A fresh session applies it silently, so a scratch-session test would have shipped a
feature that opens a dialog and walks away — leaving the session *more* stuck. The action
polls for this dialog and answers only the option that both affirms **and** names the
model we asked for, so an unrelated permission prompt can never be answered by accident.

**2. The status line must be read from the BOTTOM.** `parseCurrentModel` originally took
the first `sid: <uuid> <model>` match. This feature's own dev session had fixture status
lines scrolled up its pane and parsed as `fable` while running on Opus. It now takes the
last match.

**3. A session displaying the banner is not a session blocked by it.** The dev session
writing these tests was detected as a switch candidate. Fixed by rule 5 above — the
strongest single guard in the design, and it came from being caught by it.

## Journal retention

The store is the switch **journal** `/monitor/stalls` surfaces, not merely a cooldown
latch, so a record is kept after the session recovers (an entry that vanished the moment
it worked would make the feature invisible). Entries age out after 7 days.

## Testing

Pure units, mirroring `stall-monitor` / `decideSupervisor` tests:

- **detector** — the real banner fires; the real promo notice does **not**; account-wide
  "usage limit reached" does not; model name extracted for opus/sonnet/haiku/fable.
- **parseCurrentModel** — all three real status-line shapes.
- **decideModelSwitch** — one case per table row above, injected deps only.
- **idempotency** — banner + already on fallback ⇒ noop.
- **tick** — switch only for a from-model limit, verification recorded, store journaled.
- **confirm dialog** — the real dialog is answered with option 1; a permission prompt and
  a mismatched-model dialog are both refused.

## Live acceptance (node 117, 2026-07-22)

Executor `16946066` (mission `mission_c5cb90cb`), genuinely wedged on Fable for 7h42m:

```
BEFORE  sid: 16946066-… Fable 5
TICK    {"event":"model-fallback-switch","from":"fable","to":"opus","verified":true}
AFTER   ⎿  Set model to Opus 4.8 and saved as your default for new sessions
        sid: 16946066-… Opus 4.8
2nd TICK  0 switches — reason `already-on-fallback`
```
