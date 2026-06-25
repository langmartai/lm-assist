# Wave 4 — Change-Detection Engagement (token-saving) — Design

**Goal:** Stop driving the Mission Controller LLM on a timer. Instead the non-LLM supervisor tick (modeled on `stall-monitor`) cheaply watches executor/mission state **via the API** and **engages the controller only on a material change** — saving tokens. Ongoing executor progress is surfaced as a lightweight, filtered "working — latest: …" update **without** engaging the controller.

**Why:** Wave 3 still drives the controller every idle interval (15 min) producing heartbeat passes (filtered from chat, but still LLM tokens + a little narration leak). The user wants: "detection of executor changes offloaded by a SCRIPT via API; once detected TRIGGER engage; not every time ask the controller (saving token)" — "similar to the monitor behaviour of Claude code" (= `stall-monitor`).

## Two-tier engagement model (the core decision, user-approved)

For each **active** mission, every supervisor tick (~1 min, non-LLM), read its executor state cheaply (`readExecutorState(m)` — transcript/verdict read, NO LLM) and classify:

- **MATERIAL change → ENGAGE** (drive the controller LLM). The detector is **token-free**, so it uses cheap proxies for "something material happened" (the controller determines the precise verdict once engaged):
  - executor **liveness drop**: was live, now died/finished/not-driveable (≈ the executor finished), or
  - a **new status marker** in the transcript since the last cursor: a `⟦WORKER-STATUS⟧` block or an agree-gate / `need_approval` / `blocked` / `done` marker (the worker-role-protocol signals the executor prints) — a cheap string scan of the new output, no LLM.
- **New or updated mission** (a mission with no/stale binding, or `updatedAt` advanced) → **ENGAGE** (the controller must place/re-place it). [Functional necessity — a new mission must not wait for the safety interval.]
- **Long safety interval** (default `missionControllerSafetyIntervalMin = 45`) elapsed since last engagement → **ENGAGE** (catch-all re-sync, near-zero cost).
- **Interim progress** (executor still running, **new transcript output** beyond the last cursor, but **no** material change) → **DO NOT engage**. Instead surface a **filtered** update on the mission record (token-free: the last meaningful non-empty output line, truncated). The controller sees it only when it next engages for a real reason.
- Otherwise → **idle** (no drive, no tokens).

User messages to the controller chat are immediate (the user drives directly) — outside the detector.

## Architecture (model on `stall-monitor.ts`)

- **Pure classifier** `classifyExecutorActivity(prev, cur)` → `{ material: boolean; reason?: string; interim?: { summary: string; cursor: number } }`. `prev` = last-seen record; `cur` = freshly read `{verdict, live, outputCursor, lastLine}`. Material on verdict/liveness change; interim when only the cursor advanced. Pure + unit-tested (like `planStallAction`).
- **Engagement store** (per-mission last-seen): `{ missionId: { verdict, live, cursor, lastEngagedAt, interim?: {summary, at} } }`. Persisted via the existing mission store (a reserved key, e.g. `__engagement__`) or a small sibling store — cross-node not required (only the leader runs this).
- **`shouldEngage(activity[], { now, lastEngagedAt, safetyIntervalMin, hasNewOrUpdatedMission })`** pure → boolean. Engage if any material, or a new/updated mission, or `now - lastEngagedAt ≥ safetyIntervalMin`.
- **Supervisor wiring** (`runSupervisorTick`): replaces the Wave-3 time-based `isDriveDue` gate. When monitor+live: read each active mission's executor (cheap), classify, persist interim updates to the mission record (no engage), and engage the controller only when `shouldEngage`. The controller lifecycle (launch/teardown, Wave 2) is unchanged. The idle 15-min cadence (`missionControllerIdleIntervalMin`) is removed/superseded by the safety interval.
- **Interim surface** on the mission record: `mission.progress.interim = { at, summary }` (additive; written by the supervisor, not the controller). Shown on the Missions UI mission item ("⏳ working — <summary>"). NOT in the controller chat.
- **Settings:** `missionControllerSafetyIntervalMin` (default 45). Keep `missionControllerIntervalMin` only as a floor on engage frequency if desired.

## Components / files
- `core/src/mission/mission-engagement.ts` (new) — pure `classifyExecutorActivity` + `shouldEngage` + the store shape.
- `core/src/mission/mission-controller.ts` — supervisor wiring (replace `isDriveDue` with the engagement gate; read executors + classify + persist interim + engage). `readExecutorState` already exists.
- `core/src/mission/mission-store.ts` — engagement store get/put (reserved key) + write `progress.interim` to a mission.
- `core/src/project-settings.ts` — `missionControllerSafetyIntervalMin` (default 45).
- `web/src/components/missions/MissionsPage.tsx` — show `progress.interim` on the mission item.

## Tests
- `classifyExecutorActivity`: verdict flip → material; liveness drop → material; only-cursor-advance → interim (summary = last line); no change → neither.
- `shouldEngage`: material→true; new/updated mission→true; safety elapsed→true; none + within interval→false.
- supervisor tick: monitor+live, 0 active missions, within safety → no engage (the token-saving case); a material change → engage + lastEngagedAt stamped; interim-only → no engage but interim persisted.
- web: a mission with `progress.interim` renders the "working — …" line; build-clean.

## Verification (e2e, on deploy)
- With 0 active missions and no change, the controller is NOT driven for up to the safety interval (transcript shows no new `Run a controller pass` for ~45 min) — confirm via the transcript timestamps. (Token-saving proven.)
- Start a mission → the controller engages within ~1 min (new mission), places it. While the executor runs, the mission item shows "working — <latest line>" updating, with NO controller drives. When the executor finishes (verdict change), the controller engages once to advance/close it.

## Out of scope
- LLM summarization of interim output (must stay token-free — a cheap text extract).
- Changing the controller's own reasoning when engaged (it still does full liveness/adjust/placement).
- Cross-node engagement store (only the leader runs the supervisor).
