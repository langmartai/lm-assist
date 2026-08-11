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
