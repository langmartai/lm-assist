/**
 * The Critical finding on Task 7: `latchOnHumanActivity`'s `touchActivity` call
 * (manual-mode.ts) has exactly one production caller, gated on `m.origin ===
 * 'onboarded'` — and the reaper only ever tracks sids that are NOT onboarded
 * (`trackResumedNative` is skipped for onboarded missions in
 * `handleSessionResume`). So that call is a guaranteed no-op in production; a test
 * that calls `touchActivity` directly on a fresh `createReaper()` instance (as
 * `mission-session-reaper-manual.test.ts` does) proves the reaper mechanics work
 * but never proves the WIRING reaches a tracked sid, and would stay green even if
 * the wiring were deleted entirely.
 *
 * This test exercises the REACHABLE path end to end, through the actual
 * module-level singleton `assertDriveable` talks to (not a fresh `createReaper()`):
 *   1. track a sid (as handleSessionResume does for a non-onboarded/native session)
 *   2. drive a manual-control verdict through `assertDriveable` (as every
 *      session-write route does) — this is the fix under test: assertDriveable
 *      must touch the reaper's timer as a side effect of that verdict
 *   3. sweep and prove the sid survives past its ORIGINAL idle deadline
 *
 * Uses unique, random sids (module-level singleton state is shared across this
 * whole test file/process — see the existing convention in
 * `mission-session-reaper.test.ts`'s "module-level singletons" section).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { assertDriveable } from '../mission/manual-probe';
import { trackResumedNative, sweepIdle } from '../mission/mission-session-reaper';
import type { Mission } from '../mission/mission-model';

function uniqueSid(tag: string): string {
  return `probe-touch-${tag}-${Math.random().toString(36).slice(2)}`;
}

test('assertDriveable: a standby refusal refreshes the reaper timer for a tracked sid', async () => {
  const sid = uniqueSid('standby');
  const t0 = Date.now();
  // Tracked at t0, as handleSessionResume would for a non-onboarded native session.
  trackResumedNative(sid, 'mission_x', t0);

  // 25 minutes later, a write route calls assertDriveable and the mission is
  // already latched standby — a confirmed human-presence observation.
  const tTouch = t0 + 25 * 60_000;
  const guard = await assertDriveable(sid, {
    now: tTouch,
    findMission: async () => ({ id: 'mission_x', manageMode: 'standby' } as unknown as Mission),
    gather: async () => { throw new Error('must not probe — the flag alone is enough'); },
    latch: async () => { throw new Error('already standby — latch must not be called again'); },
  });
  assert.equal(guard.ok, false);
  assert.equal((guard as { code: string }).code, 'STANDBY_MODE');

  // Sweep at t0+40min with idleMin=30. Without the touch, elapsed-since-track is
  // 40min > 30min and the sid would be reaped. With the fix, elapsed-since-touch
  // is 40-25=15min < 30min, so it must survive.
  const closed: string[] = [];
  await sweepIdle({ now: t0 + 40 * 60_000, idleMin: 30, close: async (s) => { closed.push(s); } });
  assert.deepEqual(closed, [], 'the reaper timer must have been refreshed by the standby-refusal touch');
});

test('assertDriveable: a manual-control verdict refreshes the reaper timer for a tracked sid', async () => {
  const sid = uniqueSid('manual');
  const t0 = Date.now();
  trackResumedNative(sid, 'mission_y', t0);

  const tTouch = t0 + 25 * 60_000;
  let latchedReason: string | undefined;
  const guard = await assertDriveable(sid, {
    now: tTouch,
    findMission: async () => ({ id: 'mission_y', manageMode: undefined } as unknown as Mission),
    gather: async () => ({ attached: true, hasAttachedTtyd: false }), // rule 1: human-attached
    latch: async (_m, reason) => { latchedReason = reason; },
  });
  assert.equal(guard.ok, false);
  assert.equal((guard as { code: string }).code, 'STANDBY_MODE');
  assert.equal(latchedReason, 'human-attached');

  const closed: string[] = [];
  await sweepIdle({ now: t0 + 40 * 60_000, idleMin: 30, close: async (s) => { closed.push(s); } });
  assert.deepEqual(closed, [], 'the reaper timer must have been refreshed by the manual-verdict touch');
});

test('assertDriveable: a driveable (no manual control) verdict does NOT touch — sanity control', async () => {
  const sid = uniqueSid('clean');
  const t0 = Date.now();
  trackResumedNative(sid, 'mission_z', t0);

  // No touch expected here: a clean/driveable verdict is not a human-presence
  // observation, so the write route itself (handleSessionDrive etc.) is what
  // legitimately refreshes activity, not the guard.
  const guard = await assertDriveable(sid, {
    now: t0 + 25 * 60_000,
    findMission: async () => ({ id: 'mission_z', manageMode: 'handoff' } as unknown as Mission),
    gather: async () => ({ attached: false }),
    latch: async () => { throw new Error('must not latch a clean session'); },
  });
  assert.equal(guard.ok, true);

  // Sweep at t0+40min, idleMin=30 — no touch occurred, so the ORIGINAL track time
  // (t0) is what matters and the sid must be reaped.
  const closed: string[] = [];
  await sweepIdle({ now: t0 + 40 * 60_000, idleMin: 30, close: async (s) => { closed.push(s); } });
  assert.deepEqual(closed, [sid], 'a clean verdict must not fabricate an activity touch');
});
