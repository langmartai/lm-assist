# Manual-Operation Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Mission Control from injecting into a session a human is operating, detect that state actively rather than only after the fact, and expire the latch when the human goes away.

**Architecture:** One flag (`manageMode`, widened from onboarded-only to every mission) is the single source of truth. A pure classifier decides "is someone else on this session" from injected signals; a thin IO wrapper gathers them. Every session-write path funnels through one guard helper. Detection has two layers: an active pre-flight probe before each write, and a passive transcript latch as backstop.

**Tech Stack:** TypeScript (CommonJS), `node:test` + `node:assert`, tests in `core/src/__tests__/*.test.ts` compiled to `dist-test/__tests__`.

**Spec:** `docs/superpowers/specs/2026-08-11-manual-operation-guard-design.md`

## Global Constraints

- Build is CommonJS. Never add an ESM-only dependency; chokidar stays `^3.6.0`.
- Run the whole suite with `cd core && npm test` — never a single test file directly, and never two concurrent runs (they kill each other).
- `MissionStatus` values are exactly: `draft | active | waiting | paused | blocked | done | failed`. Do not invent a new one.
- `manageMode` values are exactly `handoff | standby`. `undefined` means `handoff`.
- Writes to `mission.control.*` are history-clean — `TRACKED_FIELDS` excludes `control`. Use that for high-frequency fields.
- A new MCP tool requires entries in BOTH the tool registry and `TOOL_SCOPES`; a missing `TOOL_SCOPES` entry crashes Core on boot. This plan adds no new MCP tool, so no registry work is required.
- Never anchor composer detection on `>` alone — the statusline echoes the last submitted prompt with the same marker.

## Spec correction adopted by this plan

The spec's probe signal 5 says "jsonl mtime newer than this sid's last `terminal-audit`
entry". **That is wrong and this plan does not implement it that way.** A driven turn keeps
appending to the transcript for the entire duration of the assistant's response — often
minutes — so mtime would read as `foreign-driver` during lm-assist's own long turns.

This plan attributes on the **timestamp of the last `user`-role message** in the transcript
instead. Assistant output is irrelevant; only submitted input can indicate another driver.
Update the spec to match when this lands.

---

### Task 1: Widen `manageMode` to all missions

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts:344-351`
- Test: `core/src/__tests__/mission-manual-mode.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `manageMode` is settable on any mission via `PATCH /mission/:id`, still human-only.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/mission-manual-mode.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { newMission, type MissionActor } from '../mission/mission-model';

const human: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const controller: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

test('manageMode is settable on a non-onboarded mission', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_x');
  assert.equal(m.origin, undefined, 'precondition: not an onboarded mission');
  const r = applyManageMode(m, 'standby', human);
  assert.equal(r.ok, true, 'a plain worker mission must accept standby');
  assert.equal(m.manageMode, 'standby');
});

test('manageMode stays human-only', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_y');
  const r = applyManageMode(m, 'handoff', controller);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN');
});

test('manageMode rejects an unknown value', () => {
  const m = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => 'mission_z');
  const r = applyManageMode(m, 'paused', human);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
});
```

Add the import at the top of the test file:

```typescript
import { applyManageMode } from '../mission/manual-mode';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 mission-manual-mode`
Expected: FAIL — `Cannot find module '../mission/manual-mode'`

- [ ] **Step 3: Write minimal implementation**

Create `core/src/mission/manual-mode.ts`:

```typescript
/**
 * Manual-operation mode: the flag that says "a human is running this session,
 * Mission Control must not write to it".
 *
 * `manageMode` was previously onboarded-only. It is now valid on every mission,
 * because any mission session can be taken over by a person. `undefined` means
 * 'handoff' so existing missions are unaffected.
 *
 * Writing it stays HUMAN-ONLY: the controller must never be able to hand a
 * session back to itself. That is the whole point of the flag.
 */
import { Mission, MissionActor, ManageMode } from './mission-model';

export type ApplyResult = { ok: true } | { ok: false; code: string; message: string };

function isControllerActor(who: MissionActor | undefined): boolean {
  return who?.kind === 'controller' || who?.channel === 'controller';
}

/** True when Mission Control must not write to this mission's session. */
export function isStandby(m: Pick<Mission, 'manageMode'>): boolean {
  return m.manageMode === 'standby';
}

/** Validate + apply a manageMode change. Mutates `m` only on success. */
export function applyManageMode(m: Mission, value: string, who: MissionActor | undefined): ApplyResult {
  if (value !== 'handoff' && value !== 'standby') {
    return { ok: false, code: 'INVALID_INPUT', message: 'manageMode must be handoff|standby' };
  }
  if (isControllerActor(who)) {
    return { ok: false, code: 'FORBIDDEN', message: 'manageMode is human-only — ask the user to switch it' };
  }
  m.manageMode = value as ManageMode;
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 mission-manual-mode`
Expected: PASS, 3 tests

- [ ] **Step 5: Route the existing handler through it**

In `core/src/routes/core/mission.routes.ts`, replace lines 344-351:

```typescript
  if (b.manageMode !== undefined) {
    const r = applyManageMode(m, String(b.manageMode ?? ''), who);
    if (!r.ok) return fail(r.code, r.message);
  }
```

Add to the imports at the top of that file:

```typescript
import { applyManageMode, isStandby } from '../../mission/manual-mode';
```

- [ ] **Step 6: Run the full suite**

Run: `cd core && npm test`
Expected: PASS. The onboarded-only assertion is gone, so any existing test asserting
`INVALID_INPUT` for a non-onboarded `manageMode` will now fail — delete that assertion,
it encodes the behaviour we are deliberately removing.

- [ ] **Step 7: Commit**

```bash
git add core/src/mission/manual-mode.ts core/src/routes/core/mission.routes.ts core/src/__tests__/mission-manual-mode.test.ts
git commit -m "feat(mission): manageMode applies to every mission, not just onboarded"
```

---

### Task 2: Standby missions leave the engagement set

**Files:**
- Modify: `core/src/mission/mission-store.ts:197-200`
- Test: `core/src/__tests__/mission-manual-mode.test.ts` (extend)

**Interfaces:**
- Consumes: `isStandby` from Task 1.
- Produces: `listActiveMissions()` excludes standby missions, so they stop arming the timers.

- [ ] **Step 1: Write the failing test**

Append to `core/src/__tests__/mission-manual-mode.test.ts`:

```typescript
import { selectActive } from '../mission/mission-store';

test('selectActive excludes standby missions', () => {
  const mk = (id: string, status: string, mode?: string) =>
    ({ id, status, manageMode: mode } as any);
  const all = [
    mk('mission_a', 'active'),
    mk('mission_b', 'active', 'standby'),
    mk('mission_c', 'waiting', 'standby'),
    mk('mission_d', 'waiting', 'handoff'),
    mk('mission_e', 'done'),
  ];
  const ids = selectActive(all).map((m) => m.id);
  assert.deepEqual(ids, ['mission_a', 'mission_d']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 "selectActive excludes"`
Expected: FAIL — `selectActive is not a function`

- [ ] **Step 3: Write minimal implementation**

In `core/src/mission/mission-store.ts`, add the pure selector above `listActiveMissions` and use it:

```typescript
/** Pure: the missions the supervisor should engage on. Standby is excluded — a
 *  human is running that session, so it must not arm the controller's timers. */
export function selectActive<T extends { id: string; status: string; manageMode?: string }>(all: T[]): T[] {
  return all.filter((m) =>
    !RESERVED_IDS.has(m.id)
    && (m.status === 'active' || m.status === 'waiting')
    && m.manageMode !== 'standby');
}

export async function listActiveMissions(port: MissionDataPort = defaultPort()): Promise<Mission[]> {
  return selectActive(await port.list());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 "selectActive excludes"`
Expected: PASS

- [ ] **Step 5: Exclude standby from placement too**

`readyUnbound` is computed in `evaluateEngagement` (`mission-controller.ts:963-971`) from
`computeSchedule(all).ready` filtered to missions with no `binding.sessionId`. A standby
mission is normally bound, so it usually cannot appear — but "usually" is not a guarantee,
and being re-placed would spawn a second executor onto a session a human is using.

Add the filter explicitly:

```typescript
      readyUnbound = computeSchedule(all).ready.filter((id) => {
        const m = byId.get(id);
        return !m?.binding?.sessionId && !isStandby(m ?? ({} as never));
      });
```

- [ ] **Step 6: Run the full suite**

Run: `cd core && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add core/src/mission/mission-store.ts core/src/mission/mission-controller.ts core/src/__tests__/mission-manual-mode.test.ts
git commit -m "feat(mission): standby missions leave the engagement and placement sets"
```

---

### Task 3: Fix the inverted polarity of human detection

This is the defect that motivated the work: today a human typing *causes* an injection.

**Files:**
- Modify: `core/src/mission/mission-controller.ts:1893-1903`
- Test: `core/src/__tests__/mission-manual-latch.test.ts` (create)

**Interfaces:**
- Consumes: `isStandby` (Task 1).
- Produces: `latchOnHumanActivity(m, sig, now)` → `{ latched: boolean; reason?: string }`, applied by `readSignal`.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/mission-manual-latch.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { latchOnHumanActivity } from '../mission/manual-mode';
import { classifyExecutorActivity } from '../mission/mission-engagement';

test('human activity latches standby and is NOT material', () => {
  const m: any = { id: 'mission_a', manageMode: undefined, control: {} };
  const sig = { alive: true, gated: false, cursor: 5, newLines: ['fix the parser please'], humanActive: true };

  const r = latchOnHumanActivity(m, sig, 1000);

  assert.equal(r.latched, true);
  assert.equal(m.manageMode, 'standby', 'the mission must be latched to standby');
  assert.equal(m.control.lastHumanInputAt, 1000);

  // The regression: this signal must not classify as material, or it drives the controller.
  const act = classifyExecutorActivity({ alive: true, gated: false, cursor: 4 }, r.signal);
  assert.equal(act.material, false, 'human activity must never produce a drive');
});

test('latch is idempotent — an already-standby mission does not re-latch', () => {
  const m: any = { id: 'mission_b', manageMode: 'standby', control: { lastHumanInputAt: 500 } };
  const sig = { alive: true, gated: false, cursor: 6, newLines: ['more input'], humanActive: true };
  const r = latchOnHumanActivity(m, sig, 2000);
  assert.equal(r.latched, false, 'already latched — no second history entry');
  assert.equal(m.control.lastHumanInputAt, 2000, 'but the idle clock still advances');
});

test('no human activity leaves the mission alone', () => {
  const m: any = { id: 'mission_c', manageMode: undefined, control: {} };
  const sig = { alive: true, gated: false, cursor: 7, newLines: ['tool output'], humanActive: false };
  const r = latchOnHumanActivity(m, sig, 3000);
  assert.equal(r.latched, false);
  assert.equal(m.manageMode, undefined);
  assert.equal(m.control.lastHumanInputAt, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 mission-manual-latch`
Expected: FAIL — `latchOnHumanActivity is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/manual-mode.ts`:

```typescript
export interface HumanSignal {
  alive: boolean;
  gated: boolean;
  cursor: number;
  newLines: string[];
  humanActive: boolean;
}

/**
 * Latch a mission to standby when a human is detected in its session.
 *
 * 🔴 POLARITY. Before 2026-08-11 this path did the opposite: it prepended a
 * '⟦WORKER-STATUS⟧ human-activity' line, which STATUS_MARKER_RE classifies as
 * MATERIAL — so a person typing DROVE the controller to inject on top of them.
 * The returned signal deliberately carries no marker and no newLines, so
 * classifyExecutorActivity sees nothing to act on.
 */
export function latchOnHumanActivity(
  m: Mission,
  sig: HumanSignal,
  now: number,
): { latched: boolean; reason?: string; signal: HumanSignal } {
  if (!sig.humanActive) return { latched: false, signal: sig };

  // Advance the idle clock on EVERY human message, latched or not — Task 6 expires
  // the latch off this timestamp, and a person still typing must never expire.
  m.control.lastHumanInputAt = now;

  const already = isStandby(m);
  if (!already) m.manageMode = 'standby';

  // Strip the output so this tick cannot classify as material.
  const quiet: HumanSignal = { ...sig, newLines: [] };
  return { latched: !already, reason: 'human-input', signal: quiet };
}
```

Add `lastHumanInputAt?: number;` to `MissionControl` in `core/src/mission/mission-model.ts:34-48`:

```typescript
  /** Last time a human was detected inputting to this mission's session. Drives the
   *  standby idle-expiry (Task 6). `control` is excluded from TRACKED_FIELDS, so
   *  writing this every tick does not spam the mission's edit history. */
  lastHumanInputAt?: number;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 mission-manual-latch`
Expected: PASS, 3 tests

- [ ] **Step 5: Replace the inverted callsite**

In `core/src/mission/mission-controller.ts`, replace lines 1893-1903:

```typescript
      readSignal: async (m) => {
        if (m.origin === 'onboarded') {
          const s = await readOnboardedSignal(m, defaultOnboardedReadDeps());
          const r = latchOnHumanActivity(m, s, Date.now());
          if (r.latched || s.humanActive) {
            try { await persistMissionControlAndMode(m); } catch { /* best-effort */ }
          }
          return r.signal;
        }
        return readExecutorSignal(m);
      },
```

Add to that file's imports:

```typescript
import { latchOnHumanActivity, isStandby } from './manual-mode';
```

`persistMissionControlAndMode` is the existing `persistMissionControl` dep — it calls
`putMission`, which persists both `control` and `manageMode`. Reuse it under its existing
name rather than adding a second persist path.

- [ ] **Step 6: Run the full suite**

Run: `cd core && npm test`
Expected: PASS. Any existing test asserting that human activity produces
`⟦WORKER-STATUS⟧ human-activity` must be **inverted**, not deleted — rewrite it to assert
no drive. That assertion is the bug.

- [ ] **Step 7: Commit**

```bash
git add core/src/mission/manual-mode.ts core/src/mission/mission-model.ts core/src/mission/mission-controller.ts core/src/__tests__/mission-manual-latch.test.ts
git commit -m "fix(mission): human activity must suppress injection, not cause it"
```

---

### Task 4: `composerIsNonEmpty` — detect typed-but-unsubmitted text

**Files:**
- Modify: `core/src/terminal/cc.ts` (after `composerHoldsText`, line ~264)
- Test: `core/src/__tests__/cc-composer-nonempty.test.ts` (create)

**Interfaces:**
- Consumes: existing `extractComposerBlock` (`cc.ts:235`).
- Produces: `composerIsNonEmpty(pane: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/cc-composer-nonempty.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { composerIsNonEmpty } from '../terminal/cc';

const footer = '\n~/lm-assist\n  ctx:42%  sid: 0a1b2c3d-e4f5-6789-abcd-ef0123456789\n';

test('empty composer reads as empty', () => {
  assert.equal(composerIsNonEmpty(`some output\n\n> ${footer}`), false);
});

test('typed-but-unsubmitted text reads as non-empty', () => {
  assert.equal(composerIsNonEmpty(`some output\n\n> fix the parser${footer}`), true);
});

test('a bare prompt marker with only whitespace is empty', () => {
  assert.equal(composerIsNonEmpty(`some output\n\n>    ${footer}`), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 cc-composer-nonempty`
Expected: FAIL — `composerIsNonEmpty is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/terminal/cc.ts` after `composerHoldsText`:

```typescript
/**
 * Pure: does the composer hold ANY unsubmitted text?
 *
 * `composerHoldsText` only answers about text WE typed. This answers the
 * different question the manual-operation probe needs: has somebody else typed
 * something and not sent it yet — the one state a transcript read can never see.
 *
 * Strips the composer marker itself before testing, so a bare '>' prompt with
 * nothing after it reads as empty.
 */
export function composerIsNonEmpty(pane: string): boolean {
  const block = extractComposerBlock(pane);
  if (!block) return false;
  const stripped = block
    .split('\n')
    .map((l) => l.replace(COMPOSER_MARKER_RE, '').trim())
    .join('')
    .trim();
  return stripped.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 cc-composer-nonempty`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/cc.ts core/src/__tests__/cc-composer-nonempty.test.ts
git commit -m "feat(terminal): composerIsNonEmpty — detect unsubmitted input"
```

---

### Task 5: The manual-control classifier

**Files:**
- Create: `core/src/mission/manual-probe.ts`
- Test: `core/src/__tests__/manual-probe.test.ts` (create)

**Interfaces:**
- Consumes: `composerIsNonEmpty` (Task 4), `paneShowsQueuedMessage` (`cc.ts:225`).
- Produces:
  - `type ManualReason = 'human-attached' | 'human-terminal' | 'human-typing' | 'foreign-driver'`
  - `interface ProbeSignals { attached?: boolean; hasAttachedTtyd?: boolean; managedBy?: string; source?: string; pane?: string; lastUserMessageAt?: number; lastSelfDriveAt?: number }`
  - `classifyManualControl(s: ProbeSignals, now: number): { manual: boolean; reason?: ManualReason }`

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/manual-probe.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyManualControl } from '../mission/manual-probe';

const footer = '\n~/x\n  ctx:10%  sid: 0a1b2c3d-e4f5-6789-abcd-ef0123456789\n';
const NOW = 1_000_000;

test('a human tmux client attached is manual', () => {
  const r = classifyManualControl({ attached: true, hasAttachedTtyd: false }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-attached');
});

test('OUR OWN ttyd attached is NOT manual', () => {
  // ttyd attaches as a tmux client, so `attached` alone would read every open
  // console tab as a human. This cross-reference is the whole point.
  const r = classifyManualControl({ attached: true, hasAttachedTtyd: true }, NOW);
  assert.equal(r.manual, false);
});

test("the user's own tmux is manual", () => {
  const r = classifyManualControl({ managedBy: 'unmanaged-tmux', source: 'external-terminal' }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-terminal');
});

test('unsubmitted text in the composer is manual', () => {
  const r = classifyManualControl({ pane: `out\n\n> half a thought${footer}` }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-typing');
});

test('a queued-message banner is manual', () => {
  const r = classifyManualControl({ pane: `press up to edit queued messages\n\n> ${footer}` }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-typing');
});

test('input we did not send is a foreign driver', () => {
  const r = classifyManualControl({ lastUserMessageAt: NOW - 1000, lastSelfDriveAt: NOW - 60_000 }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'foreign-driver');
});

test('input WE sent is not a foreign driver', () => {
  const r = classifyManualControl({ lastUserMessageAt: NOW - 60_000, lastSelfDriveAt: NOW - 61_000 }, NOW);
  assert.equal(r.manual, false);
});

test('a quiet, unattached session is not manual', () => {
  const r = classifyManualControl({ attached: false, pane: `out\n\n> ${footer}` }, NOW);
  assert.equal(r.manual, false);
  assert.equal(r.reason, undefined);
});

test('no signals at all is not manual — absence of evidence is not evidence', () => {
  assert.equal(classifyManualControl({}, NOW).manual, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 manual-probe`
Expected: FAIL — `Cannot find module '../mission/manual-probe'`

- [ ] **Step 3: Write minimal implementation**

Create `core/src/mission/manual-probe.ts`:

```typescript
/**
 * Active detection: is somebody OTHER than Mission Control on this session right now?
 *
 * Pure classifier over injected signals — the IO that gathers them lives in
 * `gatherProbeSignals` (Task 6) so this stays trivially testable.
 *
 * Ordered cheapest-first and short-circuits, because the caller runs it before
 * every session write.
 */
import { composerIsNonEmpty, paneShowsQueuedMessage } from '../terminal/cc';

export type ManualReason = 'human-attached' | 'human-terminal' | 'human-typing' | 'foreign-driver';

export interface ProbeSignals {
  /** tmux `#{session_attached}` for this session's tmux; undefined when not tmux-hosted. */
  attached?: boolean;
  /** true when one of OUR ttyd instances is bound to that tmux session. */
  hasAttachedTtyd?: boolean;
  managedBy?: string;
  source?: string;
  /** Captured pane text; undefined when the session is not capturable. */
  pane?: string;
  /** Timestamp of the last `user`-role message in the transcript. */
  lastUserMessageAt?: number;
  /** Timestamp of the last write lm-assist itself made to this session. */
  lastSelfDriveAt?: number;
}

/** How long after our own drive a user message still counts as ours. Covers the gap
 *  between the audit append and the transcript write. */
export const ATTRIBUTION_SKEW_MS = 10_000;

export function classifyManualControl(s: ProbeSignals, _now: number): { manual: boolean; reason?: ManualReason } {
  // 1 — a tmux client that is not our ttyd. Free: both values are already collected.
  if (s.attached === true && s.hasAttachedTtyd !== true) {
    return { manual: true, reason: 'human-attached' };
  }
  // 2 — a tmux we did not create. Free: same warm store.
  if (s.managedBy === 'unmanaged-tmux' && s.source === 'external-terminal') {
    return { manual: true, reason: 'human-terminal' };
  }
  // 3+4 — someone has typed, or submitted while we were busy. One capture-pane.
  if (s.pane) {
    if (composerIsNonEmpty(s.pane)) return { manual: true, reason: 'human-typing' };
    if (paneShowsQueuedMessage(s.pane)) return { manual: true, reason: 'human-typing' };
  }
  // 5 — attribution: input exists that we did not send.
  //
  // 🔴 Deliberately keyed on the last USER-role message, NOT on jsonl mtime. A driven
  // turn keeps appending to the transcript for the whole assistant response — often
  // minutes — so mtime would read as a foreign driver during our own long turns.
  if (s.lastUserMessageAt !== undefined) {
    const ours = s.lastSelfDriveAt !== undefined
      && s.lastUserMessageAt <= s.lastSelfDriveAt + ATTRIBUTION_SKEW_MS;
    if (!ours) return { manual: true, reason: 'foreign-driver' };
  }
  return { manual: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 manual-probe`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/manual-probe.ts core/src/__tests__/manual-probe.test.ts
git commit -m "feat(mission): manual-control classifier for active detection"
```

---

### Task 6: Gather the probe signals + the `assertDriveable` choke point

**Files:**
- Modify: `core/src/mission/manual-probe.ts` (add `gatherProbeSignals`, `assertDriveable`)
- Modify: `core/src/routes/core/mission.routes.ts` — `handleSessionDrive:1344`, `handleSessionAnswer:1558`, `handleSessionControl:1410`, `handleSessionResume:2041`
- Test: `core/src/__tests__/manual-probe-guard.test.ts` (create)

**Interfaces:**
- Consumes: `classifyManualControl` (Task 5), `isStandby` (Task 1).
- Produces: `assertDriveable(sid, deps): Promise<{ ok: true } | { ok: false; code: 'STANDBY_MODE'; message: string }>`

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/manual-probe-guard.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { assertDriveable } from '../mission/manual-probe';

const NOW = 1_000_000;

test('a standby mission refuses without probing', async () => {
  let probed = false;
  const r = await assertDriveable('sid-1', {
    now: NOW,
    findMission: async () => ({ id: 'mission_a', manageMode: 'standby' } as any),
    gather: async () => { probed = true; return {}; },
    latch: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal((r as any).code, 'STANDBY_MODE');
  assert.equal(probed, false, 'the flag alone is enough — do not pay for a probe');
});

test('an active probe hit refuses AND latches', async () => {
  let latched: string | undefined;
  const r = await assertDriveable('sid-2', {
    now: NOW,
    findMission: async () => ({ id: 'mission_b', manageMode: undefined } as any),
    gather: async () => ({ attached: true, hasAttachedTtyd: false }),
    latch: async (_m, reason) => { latched = reason; },
  });
  assert.equal(r.ok, false);
  assert.equal((r as any).code, 'STANDBY_MODE');
  assert.equal(latched, 'human-attached');
});

test('a clean session is driveable', async () => {
  const r = await assertDriveable('sid-3', {
    now: NOW,
    findMission: async () => ({ id: 'mission_c', manageMode: 'handoff' } as any),
    gather: async () => ({ attached: false }),
    latch: async () => { throw new Error('must not latch a clean session'); },
  });
  assert.equal(r.ok, true);
});

test('a session with no mission is driveable — the guard is mission-scoped', async () => {
  const r = await assertDriveable('sid-4', {
    now: NOW,
    findMission: async () => null,
    gather: async () => { throw new Error('must not probe an unmanaged session'); },
    latch: async () => {},
  });
  assert.equal(r.ok, true);
});

test('a probe failure fails OPEN', async () => {
  // A broken tmux read must not make every mission session permanently undriveable.
  const r = await assertDriveable('sid-5', {
    now: NOW,
    findMission: async () => ({ id: 'mission_e', manageMode: undefined } as any),
    gather: async () => { throw new Error('tmux exploded'); },
    latch: async () => {},
  });
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 manual-probe-guard`
Expected: FAIL — `assertDriveable is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/manual-probe.ts`:

```typescript
import { Mission } from './mission-model';
import { isStandby } from './manual-mode';

export interface GuardDeps {
  now: number;
  findMission: (sid: string) => Promise<Mission | null>;
  gather: (sid: string, m: Mission) => Promise<ProbeSignals>;
  latch: (m: Mission, reason: ManualReason, now: number) => Promise<void>;
}

export type GuardResult = { ok: true } | { ok: false; code: 'STANDBY_MODE'; message: string };

function refuse(reason: string): GuardResult {
  return {
    ok: false,
    code: 'STANDBY_MODE',
    message: `session is manually operated (${reason}) — switch manageMode to handoff to drive`,
  };
}

/**
 * The single gate every session WRITE passes through.
 *
 * Order matters: the flag is checked first because it is free and authoritative.
 * The probe only runs for a mission that is not already latched.
 *
 * 🔴 Fails OPEN. A probe that throws must never make every mission session
 * permanently undriveable — that would convert a transient tmux error into a
 * fleet-wide outage.
 */
export async function assertDriveable(sid: string, deps: GuardDeps): Promise<GuardResult> {
  let m: Mission | null = null;
  try {
    m = await deps.findMission(sid);
  } catch {
    return { ok: true };            // unknown ownership → not ours to refuse
  }
  if (!m) return { ok: true };      // no mission owns this session
  if (isStandby(m)) return refuse('standby');

  let verdict: { manual: boolean; reason?: ManualReason };
  try {
    verdict = classifyManualControl(await deps.gather(sid, m), deps.now);
  } catch {
    return { ok: true };            // fail open
  }
  if (!verdict.manual || !verdict.reason) return { ok: true };

  try { await deps.latch(m, verdict.reason, deps.now); } catch { /* best-effort */ }
  return refuse(verdict.reason);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 manual-probe-guard`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire the four write handlers**

In `core/src/routes/core/mission.routes.ts`, at the top of each of `handleSessionDrive`
(after the proxy branch at `:1348`), `handleSessionAnswer:1558`, `handleSessionControl:1410`,
and `handleSessionResume:2041`, insert:

```typescript
  const guard = await assertDriveable(sid, realGuardDeps());
  if (!guard.ok) return fail(guard.code, guard.message);
```

Then **delete** the now-redundant inline check at `mission.routes.ts:1366`:

```typescript
        if (m.manageMode === 'standby') return fail('STANDBY_MODE', 'mission is standby — the human runs this session; switch manageMode to handoff to drive');
```

Add `realGuardDeps` near the other real-deps builders in that file:

```typescript
function realGuardDeps() {
  return {
    now: Date.now(),
    findMission: async (sid: string) => (await listMissions()).find((x) => x.binding?.sessionId === sid) ?? null,
    gather: async (sid: string) => gatherProbeSignals(sid),
    latch: async (m: Mission, reason: ManualReason, now: number) => {
      m.manageMode = 'standby';
      m.control.lastHumanInputAt = now;
      // Do NOT hand-write history. `manageMode` is in TRACKED_FIELDS
      // (`mission-history.ts:6`), so putMission records the flip itself, with a
      // proper rev/actor/diff. MissionChange is a versioned diff record, not a
      // free-form event log — pushing to it by hand corrupts the revision chain.
      // The human-readable REASON goes in adjustments, which is what it is for.
      m.adjustments = m.adjustments ?? [];
      m.adjustments.push({
        at: now,
        trigger: 'manual-operation-detected',
        change: `went manual (${reason}) — Mission Control will not write to this session`,
        by: 'user',
        actor: { kind: 'user', channel: 'user', at: now },
      });
      await putMission(m);
    },
  };
}
```

- [ ] **Step 6: Implement `gatherProbeSignals`**

Append to `core/src/mission/manual-probe.ts`:

```typescript
/**
 * Collect the live signals for one session. Native/tmux only.
 *
 * 🔴 Cloud sessions (sid matching /^(cse_|session_)/) have no tmux and no local
 * transcript, so this returns {} for them and the classifier says "not manual".
 * Cloud protection is the explicit-flag path only — see the spec's Risks section.
 */
export async function gatherProbeSignals(sid: string): Promise<ProbeSignals> {
  if (/^(cse_|session_)/.test(sid)) return {};

  const { sessionVerdict } = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
  const v = sessionVerdict(sid);
  if (!v.tmuxSession) return {};

  const out: ProbeSignals = {};

  const { tmux } = require('../terminal/tmux') as typeof import('../terminal/tmux');
  try { out.attached = (await tmux.getState(v.tmuxSession))?.attached; } catch { /* leave undefined */ }

  try {
    const { getProcessStatus } = require('../process-status-store') as typeof import('../process-status-store');
    const proc = (getProcessStatus()?.processes ?? []).find((p: any) => p.tmuxSessionName === v.tmuxSession);
    if (proc) { out.hasAttachedTtyd = proc.hasAttachedTtyd; out.managedBy = proc.managedBy; out.source = proc.source; }
  } catch { /* leave undefined */ }

  try {
    const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
    out.pane = await backend.tmuxTerminalBackend.capture(v.tmuxSession);
  } catch { /* leave undefined */ }

  return out;
}
```

Note: `lastUserMessageAt` / `lastSelfDriveAt` are populated by the passive layer, which
already parses the transcript. Leave them undefined here rather than parsing twice — the
classifier treats an undefined pair as "no evidence".

- [ ] **Step 7: Run the full suite**

Run: `cd core && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add core/src/mission/manual-probe.ts core/src/routes/core/mission.routes.ts core/src/__tests__/manual-probe-guard.test.ts
git commit -m "feat(mission): one choke point guards every session write"
```

---

### Task 7: Reaper must not kill manually-operated sessions

This closes a hazard the guard itself creates, plus a bug that exists today.

**Files:**
- Modify: `core/src/mission/mission-session-reaper.ts` (add `skip` to `sweepIdle`)
- Modify: `core/src/mission/mission-controller.ts:2200-2224` (pass `skip`)
- Modify: `core/src/mission/manual-mode.ts` (`latchOnHumanActivity` touches the reaper)
- Test: `core/src/__tests__/mission-session-reaper-manual.test.ts` (create)

**Interfaces:**
- Consumes: `createReaper` (existing), `isStandby` (Task 1).
- Produces: `sweepIdle({ now, idleMin, close, skip? })` — `skip(sid)` vetoes a reap.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/mission-session-reaper-manual.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { createReaper } from '../mission/mission-session-reaper';

test('a skipped session is never reaped', async () => {
  const r = createReaper();
  r.trackResumedNative('sid-manual', 'mission_a', 0);
  const closed: string[] = [];
  await r.sweepIdle({
    now: 60 * 60_000,
    idleMin: 30,
    close: async (sid) => { closed.push(sid); },
    skip: (sid) => sid === 'sid-manual',
  });
  assert.deepEqual(closed, [], 'a manually-operated session must survive the sweep');
});

test('a skipped session stays tracked, so it is reaped once released', async () => {
  const r = createReaper();
  r.trackResumedNative('sid-manual', 'mission_a', 0);
  await r.sweepIdle({ now: 60 * 60_000, idleMin: 30, close: async () => {}, skip: () => true });

  const closed: string[] = [];
  await r.sweepIdle({ now: 120 * 60_000, idleMin: 30, close: async (s) => { closed.push(s); }, skip: () => false });
  assert.deepEqual(closed, ['sid-manual'], 'skipping must not untrack');
});

test('human input refreshes the idle timer', async () => {
  const r = createReaper();
  r.trackResumedNative('sid-busy', 'mission_b', 0);
  r.touchActivity('sid-busy', 50 * 60_000);          // a human typed at t=50min
  const closed: string[] = [];
  await r.sweepIdle({ now: 60 * 60_000, idleMin: 30, close: async (s) => { closed.push(s); } });
  assert.deepEqual(closed, [], 'only 10 min since the human typed — not idle');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 mission-session-reaper-manual`
Expected: FAIL — the first two tests fail; `skip` is not honoured

- [ ] **Step 3: Write minimal implementation**

In `core/src/mission/mission-session-reaper.ts`, change `sweepIdle`:

```typescript
  async function sweepIdle(opts: {
    now: number;
    idleMin: number;
    close: (sid: string) => Promise<void>;
    /** Veto: return true to spare a sid this sweep WITHOUT untracking it. Used to
     *  protect manually-operated sessions — the reaper's idle timer is refreshed by
     *  lm-assist's own reads/drives, and a standby session gets none of those, so
     *  without this it would kill the terminal of the person we are protecting. */
    skip?: (sid: string) => boolean;
  }): Promise<void> {
    const { now, idleMin, close, skip } = opts;
    const idleMs = idleMin * 60_000;
    const expired: string[] = [];
    for (const [sid, entry] of tracked.entries()) {
      if ((now - entry.lastActivityAt) > idleMs && !skip?.(sid)) {
        expired.push(sid);
      }
    }
    for (const sid of expired) {
      tracked.delete(sid);
      try {
        await close(sid);
      } catch (e) {
        console.debug(`[mission-session-reaper] close(${sid}) failed: ${(e as Error).message}`);
      }
    }
  }
```

Mirror the `skip` parameter on the module-level `sweepIdle` wrapper at the bottom of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 mission-session-reaper-manual`
Expected: PASS, 3 tests

- [ ] **Step 5: Pass `skip` from the supervisor**

In `core/src/mission/mission-controller.ts`, in the reaper block at `:2200-2224`, build a
standby set before the sweep and pass it:

```typescript
        const standbySids = new Set(
          (await listMissions())
            .filter((m) => isStandby(m) && m.binding?.sessionId)
            .map((m) => m.binding!.sessionId as string),
        );
        await sweepIdle({
          now: Date.now(),
          idleMin,
          skip: (sid) => standbySids.has(sid),
          close: async (sid: string) => { /* unchanged body */ },
        });
```

- [ ] **Step 6: Refresh the idle timer on human input**

In `core/src/mission/manual-mode.ts`, inside `latchOnHumanActivity`, after setting
`lastHumanInputAt`, add:

```typescript
  // A human working in this session must never look idle to the reaper. Today the
  // idle timer is refreshed ONLY by handleSessionRead/handleSessionDrive — lm-assist's
  // own operations — so a person working uninterrupted for 30 minutes is reapable.
  const sid = m.binding?.sessionId;
  if (sid) {
    try {
      const { touchActivity } = require('./mission-session-reaper') as typeof import('./mission-session-reaper');
      touchActivity(sid, now);
    } catch { /* best-effort */ }
  }
```

- [ ] **Step 7: Run the full suite**

Run: `cd core && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add core/src/mission/mission-session-reaper.ts core/src/mission/mission-controller.ts core/src/mission/manual-mode.ts core/src/__tests__/mission-session-reaper-manual.test.ts
git commit -m "fix(mission): reaper must not kill a session a human is using"
```

---

### Task 8: Auto-inactive after prolonged absence of human input

**Files:**
- Modify: `core/src/project-settings.ts:70`, `:123`, `:179`, `:230`
- Modify: `core/src/mission/manual-mode.ts` (add `expireIdleStandby`)
- Modify: `core/src/mission/mission-controller.ts` (call it from the tick)
- Test: `core/src/__tests__/mission-manual-idle.test.ts` (create)

**Interfaces:**
- Consumes: `isStandby` (Task 1), `control.lastHumanInputAt` (Task 3).
- Produces: `expireIdleStandby(missions, now, idleMin): Mission[]` — the missions it paused.

- [ ] **Step 1: Write the failing test**

Create `core/src/__tests__/mission-manual-idle.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { expireIdleStandby } from '../mission/manual-mode';

const HOUR = 60 * 60_000;

test('a long-quiet standby mission goes paused', () => {
  const m: any = { id: 'mission_a', status: 'active', manageMode: 'standby', control: { lastHumanInputAt: 0 } };
  const changed = expireIdleStandby([m], 5 * HOUR, 240);
  assert.deepEqual(changed.map((x) => x.id), ['mission_a']);
  assert.equal(m.status, 'paused');
});

test('going inactive does NOT release the latch', () => {
  const m: any = { id: 'mission_b', status: 'active', manageMode: 'standby', control: { lastHumanInputAt: 0 } };
  expireIdleStandby([m], 5 * HOUR, 240);
  assert.equal(m.manageMode, 'standby', 'an idle timer must never hand a session back to the controller');
});

test('a recently-active standby mission is untouched', () => {
  const m: any = { id: 'mission_c', status: 'active', manageMode: 'standby', control: { lastHumanInputAt: 4 * HOUR } };
  assert.deepEqual(expireIdleStandby([m], 5 * HOUR, 240), []);
  assert.equal(m.status, 'active');
});

test('a non-standby mission is never expired', () => {
  const m: any = { id: 'mission_d', status: 'active', manageMode: 'handoff', control: { lastHumanInputAt: 0 } };
  assert.deepEqual(expireIdleStandby([m], 99 * HOUR, 240), []);
});

test('an already-terminal mission is not re-paused', () => {
  const m: any = { id: 'mission_e', status: 'done', manageMode: 'standby', control: { lastHumanInputAt: 0 } };
  assert.deepEqual(expireIdleStandby([m], 99 * HOUR, 240), []);
});

test('a standby mission that never recorded human input is not expired', () => {
  // No timestamp means we never observed a human — expiring would be a guess.
  const m: any = { id: 'mission_f', status: 'active', manageMode: 'standby', control: {} };
  assert.deepEqual(expireIdleStandby([m], 99 * HOUR, 240), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 mission-manual-idle`
Expected: FAIL — `expireIdleStandby is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/manual-mode.ts`:

```typescript
/**
 * Expire the ACTIVITY of a long-quiet standby mission — not its latch.
 *
 * A latch is sticky by design, so without this every session anyone ever touched
 * accumulates as a permanently "active" mission. Pausing drops it from
 * `selectActive` for free.
 *
 * 🔴 `manageMode` is deliberately left at 'standby'. An idle timer must never be
 * the thing that hands a session back to the controller: someone who stepped away
 * for a day would return to find it had been driven in their absence. Waking a
 * mission stays a human action.
 */
export function expireIdleStandby(missions: Mission[], now: number, idleMin: number): Mission[] {
  const idleMs = idleMin * 60_000;
  const changed: Mission[] = [];
  for (const m of missions) {
    if (!isStandby(m)) continue;
    if (m.status !== 'active' && m.status !== 'waiting') continue;
    const last = m.control?.lastHumanInputAt;
    if (last === undefined) continue;          // never observed a human — do not guess
    if (now - last <= idleMs) continue;
    m.status = 'paused';
    changed.push(m);
  }
  return changed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 mission-manual-idle`
Expected: PASS, 6 tests

- [ ] **Step 5: Add the setting**

In `core/src/project-settings.ts`, add to the interface near line 70:

```typescript
  /** Minutes of no detected human input before a standby mission is paused. */
  manualIdleInactiveMin: number;
```

To `DEFAULTS` near line 123:

```typescript
  manualIdleInactiveMin: 240,
```

To the loader near line 179 and the merge near line 230, following the exact pattern of the
adjacent `missionSessionIdleCloseMin` lines:

```typescript
      manualIdleInactiveMin: typeof data.manualIdleInactiveMin === 'number' ? data.manualIdleInactiveMin : DEFAULTS.manualIdleInactiveMin,
```

```typescript
    manualIdleInactiveMin: typeof partial.manualIdleInactiveMin === 'number' ? partial.manualIdleInactiveMin : current.manualIdleInactiveMin,
```

- [ ] **Step 6: Call it from the supervisor tick**

In `core/src/mission/mission-controller.ts`, immediately before the reaper block at `:2200`:

```typescript
      try {
        const all = await listMissions();
        const paused = expireIdleStandby(all, Date.now(), getProjectSettings().manualIdleInactiveMin ?? 240);
        for (const m of paused) await putMission(m);
      } catch (e) {
        console.debug(`[mission-controller] idle-standby expiry failed: ${(e as Error).message}`);
      }
```

Add `expireIdleStandby` to the `./manual-mode` import.

- [ ] **Step 7: Run the full suite**

Run: `cd core && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add core/src/project-settings.ts core/src/mission/manual-mode.ts core/src/mission/mission-controller.ts core/src/__tests__/mission-manual-idle.test.ts
git commit -m "feat(mission): pause a standby mission after prolonged human absence"
```

---

### Task 9: Surface the latch

**Files:**
- Modify: `core/src/mission/workflow-defaults.ts:9-27` (pass directive)
- Modify: `web/src/components/` — the mission card component
- Test: `core/src/__tests__/mission-manual-mode.test.ts` (extend)

**Interfaces:**
- Consumes: `isStandby` (Task 1), `control.lastHumanInputAt` (Task 3).
- Produces: `manualBadge(m): { label: string; reason?: string } | null`

- [ ] **Step 1: Write the failing test**

Append to `core/src/__tests__/mission-manual-mode.test.ts`:

```typescript
import { manualBadge } from '../mission/manual-mode';

test('a standby mission carries a MANUAL badge', () => {
  const m: any = { manageMode: 'standby', control: { lastHumanInputAt: 42 } };
  assert.deepEqual(manualBadge(m), { label: 'MANUAL', reason: 'human input at 42' });
});

test('a handoff mission has no badge', () => {
  assert.equal(manualBadge({ manageMode: 'handoff', control: {} } as any), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test 2>&1 | grep -A3 "MANUAL badge"`
Expected: FAIL — `manualBadge is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/mission/manual-mode.ts`:

```typescript
/** Display badge for a manually-operated mission; null when the controller owns it. */
export function manualBadge(m: Mission): { label: string; reason?: string } | null {
  if (!isStandby(m)) return null;
  const at = m.control?.lastHumanInputAt;
  return { label: 'MANUAL', reason: at === undefined ? undefined : `human input at ${at}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test 2>&1 | grep -A3 "MANUAL badge"`
Expected: PASS

- [ ] **Step 5: Add the directive line**

In `core/src/mission/workflow-defaults.ts`, append to `PASS_BASE`:

```
Missions marked MANUAL are being run by a human right now. Do NOT drive, answer, resume,
or otherwise write to their sessions — every such call will refuse with STANDBY_MODE.
Do not plan around them and do not try to switch them back; only the user can release one.
```

- [ ] **Step 6: Un-gate the two existing badges**

Both surfaces already render a `manageMode` badge, but each is gated on
`origin === 'onboarded'` — so after Task 1 widens the flag, a latched worker mission would
show **nothing**. Remove the origin condition in both places.

`web/src/components/missions/MissionDetailView.tsx:315` — change:

```tsx
        {mission.origin === 'onboarded' && mission.manageMode && (
```

to:

```tsx
        {mission.manageMode && (
```

`web/src/components/missions/MissionsPage.tsx:1252` — change:

```tsx
            {m.origin === 'onboarded' && m.manageMode && (
```

to:

```tsx
            {m.manageMode && (
```

In both, make `standby` read as the manual state rather than a neutral chip: change the
label from `{mission.manageMode}` to `{mission.manageMode === 'standby' ? 'MANUAL' : 'handoff'}`
and the `title` for standby to `'a human is running this session — Mission Control will not write to it'`.

- [ ] **Step 7: Run the full suite and build the web app**

Run: `cd core && npm test && cd ../web && npx next build`
Expected: both PASS

- [ ] **Step 8: Commit**

```bash
git add core/src/mission/manual-mode.ts core/src/mission/workflow-defaults.ts core/src/__tests__/mission-manual-mode.test.ts web/src/components/
git commit -m "feat(mission): surface the MANUAL latch on the card and in the pass directive"
```

---

## Verification before merge

- [ ] `cd core && npm test` — full suite green (memory records ~327 test files; do not run files individually)
- [ ] `./core.sh build && ./core.sh restart` — dev Core boots on `:3200`, `curl localhost:3200/health` OK
- [ ] Manual e2e: onboard a live tmux session into a mission, type into it by hand, confirm
      (a) `mission_session_drive` refuses with `STANDBY_MODE`, (b) the mission shows `MANUAL`,
      (c) the session is NOT killed after `missionSessionIdleCloseMin` minutes.
- [ ] Confirm the polarity regression: with a human message present, the supervisor logs no
      `kind:'drive'` entry in `~/.lm-assist/mission-control/control-journal.jsonl`.

## Not in this plan

- **Timer demotion** (scripted checks, `shouldEngage` returning a verdict, timers never
  injecting). Independent subsystem, its own plan.
- **Cloud session coverage.** Requires role-tagging on the cloud read path; the spec's Risks
  section explains why cloud gets no automatic detection.
- **Closing the two stale missions** currently arming the timers — data hygiene, no code.
