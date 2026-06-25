import { test } from 'node:test';
import assert from 'node:assert';
import {
  createReaper,
  trackResumedNative,
  touchActivity,
  sweepIdle,
} from '../mission/mission-session-reaper';

// ── createReaper (isolated instance) ────────────────────────────────────────

test('sweepIdle: idle > idleMin → close called + untracked', async () => {
  const r = createReaper();
  const now = 1_000_000;
  r.trackResumedNative('native-abc', 'mission_1', now - 31 * 60_000); // last activity 31 min ago
  const closed: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed.push(sid); } });
  assert.deepEqual(closed, ['native-abc'], 'should close the idle session');
  // After sweep, the sid should be untracked (next sweep should not close again)
  const closed2: string[] = [];
  await r.sweepIdle({ now: now + 60_000, idleMin: 30, close: async (sid) => { closed2.push(sid); } });
  assert.deepEqual(closed2, [], 'untracked sid should not be swept again');
});

test('sweepIdle: fresh session (not yet expired) → not closed', async () => {
  const r = createReaper();
  const now = 1_000_000;
  r.trackResumedNative('native-fresh', 'mission_2', now - 5 * 60_000); // only 5 min ago
  const closed: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed.push(sid); } });
  assert.deepEqual(closed, [], 'fresh session should NOT be closed');
});

test('touchActivity: refreshes lastActivityAt so expired → not closed', async () => {
  const r = createReaper();
  const now = 1_000_000;
  const ago31 = now - 31 * 60_000;
  r.trackResumedNative('native-touched', 'mission_3', ago31); // initially expired
  // Touch it — updates lastActivityAt to `now`
  r.touchActivity('native-touched', now);
  const closed: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed.push(sid); } });
  assert.deepEqual(closed, [], 'touched session should NOT be closed (refreshed)');
});

test('sweepIdle: multiple tracked sids — only idle ones closed', async () => {
  const r = createReaper();
  const now = 1_000_000;
  r.trackResumedNative('idle-1', 'mission_a', now - 31 * 60_000); // idle
  r.trackResumedNative('idle-2', 'mission_b', now - 45 * 60_000); // idle
  r.trackResumedNative('fresh-3', 'mission_c', now - 10 * 60_000); // fresh
  const closed: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed.push(sid); } });
  assert.deepEqual(closed.sort(), ['idle-1', 'idle-2'].sort(), 'only idle sessions should be closed');
  // fresh-3 should still be tracked
  r.touchActivity('fresh-3', now - 9 * 60_000); // still within idleMin
  const closed2: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed2.push(sid); } });
  assert.deepEqual(closed2, [], 'fresh-3 should not be closed after second sweep');
});

test('sweepIdle: boundary — exactly at idleMin → NOT expired (strict >)', async () => {
  const r = createReaper();
  const now = 1_000_000;
  r.trackResumedNative('boundary-sid', 'mission_b', now - 30 * 60_000); // exactly 30 min
  const closed: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed.push(sid); } });
  assert.deepEqual(closed, [], 'exactly at boundary should NOT be closed (uses >)');
});

test('sweepIdle: close error is best-effort — other sids still swept', async () => {
  const r = createReaper();
  const now = 1_000_000;
  r.trackResumedNative('fail-sid', 'mission_f', now - 31 * 60_000);
  r.trackResumedNative('ok-sid', 'mission_g', now - 32 * 60_000);
  const closed: string[] = [];
  await r.sweepIdle({
    now,
    idleMin: 30,
    close: async (sid) => {
      if (sid === 'fail-sid') throw new Error('close failed');
      closed.push(sid);
    },
  });
  // ok-sid should still be closed even if fail-sid's close threw
  assert.deepEqual(closed, ['ok-sid'], 'error in close should not prevent other sids from being swept');
});

test('trackResumedNative: calling twice overwrites lastActivityAt (idempotent re-track)', async () => {
  const r = createReaper();
  const now = 1_000_000;
  r.trackResumedNative('re-tracked', 'mission_r', now - 35 * 60_000); // initially expired
  // Re-track with a fresh timestamp (simulates a re-resume)
  r.trackResumedNative('re-tracked', 'mission_r', now - 5 * 60_000); // overwritten to fresh
  const closed: string[] = [];
  await r.sweepIdle({ now, idleMin: 30, close: async (sid) => { closed.push(sid); } });
  assert.deepEqual(closed, [], 're-tracked session should use the latest timestamp');
});

test('touchActivity: for untracked sid — no-op (does not throw)', () => {
  const r = createReaper();
  // Should not throw even though the sid was never tracked
  assert.doesNotThrow(() => r.touchActivity('untracked-sid', Date.now()));
});

// ── module-level singletons (default export) ────────────────────────────────

test('module-level trackResumedNative + sweepIdle work', async () => {
  // Use module-level functions with a unique sid to avoid interference
  const sid = 'singleton-test-' + Math.random().toString(36).slice(2);
  const now = Date.now();
  trackResumedNative(sid, 'mission_singleton', now - 31 * 60_000);
  touchActivity(sid, now - 31 * 60_000); // keep it expired
  const closed: string[] = [];
  await sweepIdle({ now, idleMin: 30, close: async (s) => { closed.push(s); } });
  assert.ok(closed.includes(sid), `module-level sweep should close ${sid}`);
});
