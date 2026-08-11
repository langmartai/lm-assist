import { test } from 'node:test';
import assert from 'node:assert';
import { runIdleStandbyAndReaperSweep, type IdleStandbyReaperSweepDeps } from '../mission/mission-controller';
import { createReaper } from '../mission/mission-session-reaper';
import type { Mission } from '../mission/mission-model';

// ---------------------------------------------------------------------------
// runIdleStandbyAndReaperSweep — leader-only idle-standby expiry + reaper sweep
//
// Regression coverage for the previous commit's refactor: a `listMissions()` throw
// (or a genuinely empty list — see the `livePort.list()` hazard noted in the
// function's own comment) must skip BOTH the idle-standby expiry AND the reaper
// sweep, not fall through with an empty `standbySids` veto. A standby mission's
// binding.sessionId is the reaper's ONLY protection; losing it closes the human's
// terminal, exactly the outcome this feature exists to prevent.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60_000;

function standbyMission(id: string, sid: string): Mission {
  return {
    id,
    manageMode: 'standby',
    binding: { sessionId: sid, kind: 'worker' },
  } as unknown as Mission;
}

function baseDeps(over: Partial<IdleStandbyReaperSweepDeps>): IdleStandbyReaperSweepDeps {
  return {
    now: 60 * HOUR,
    listMissions: async () => [],
    putMission: async () => {},
    idleStandbyMin: 240,
    reaperIdleMin: 30,
    sweepIdle: async () => {},
    closeSession: async () => {},
    ...over,
  };
}

test('listMissions() throwing skips the reaper sweep entirely — the standby session survives', async () => {
  const reaper = createReaper();
  reaper.trackResumedNative('uuid-human', 'mission_x', 0);       // idle since t=0

  const closed: string[] = [];
  const r = await runIdleStandbyAndReaperSweep(baseDeps({
    listMissions: async () => { throw new Error('store unreachable'); },
    sweepIdle: reaper.sweepIdle,
    closeSession: async (sid) => { closed.push(sid); },
  }));

  assert.equal(r.skipped, true);
  assert.deepEqual(closed, [], 'a listMissions() failure must not let the reaper sweep run with no veto');
});

test('listMissions() succeeding with a real standby mission vetoes the reaper as before (control case)', async () => {
  const reaper = createReaper();
  reaper.trackResumedNative('uuid-human', 'mission_x', 0);       // idle since t=0

  const closed: string[] = [];
  const r = await runIdleStandbyAndReaperSweep(baseDeps({
    listMissions: async () => [standbyMission('mission_x', 'uuid-human')],
    sweepIdle: reaper.sweepIdle,
    closeSession: async (sid) => { closed.push(sid); },
  }));

  assert.equal(r.skipped, false);
  assert.deepEqual(closed, [], 'the standby veto (from the real mission list) protects the session');
});

test('an empty mission list also skips the sweep (livePort.list() swallow hazard)', async () => {
  const reaper = createReaper();
  reaper.trackResumedNative('uuid-human', 'mission_x', 0);

  const closed: string[] = [];
  const r = await runIdleStandbyAndReaperSweep(baseDeps({
    listMissions: async () => [],
    sweepIdle: reaper.sweepIdle,
    closeSession: async (sid) => { closed.push(sid); },
  }));

  assert.equal(r.skipped, true);
  assert.deepEqual(closed, [], 'an empty list is treated the same as an unreachable store — never trusted as "nothing to reap"');
});

test('a non-standby idle session IS reaped when listMissions succeeds with a non-empty, non-standby fleet', async () => {
  const reaper = createReaper();
  reaper.trackResumedNative('uuid-other', 'mission_y', 0);

  const closed: string[] = [];
  const otherMission = { id: 'mission_z', manageMode: 'handoff', binding: null } as unknown as Mission;
  const r = await runIdleStandbyAndReaperSweep(baseDeps({
    listMissions: async () => [otherMission],
    sweepIdle: reaper.sweepIdle,
    closeSession: async (sid) => { closed.push(sid); },
  }));

  assert.equal(r.skipped, false);
  assert.deepEqual(closed, ['uuid-other'], 'the sweep still functions normally for a genuinely non-empty, non-standby fleet');
});
