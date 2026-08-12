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
