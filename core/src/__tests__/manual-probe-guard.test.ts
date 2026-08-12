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

// ── I-3: findMission retries once before failing open ──────────────────────────────────────
//
// A lookup that THREW is not evidence the session isn't ours — for a cloud sid, an explicit
// human-set standby is the ONLY protection that mission has (gatherProbeSignals returns {} for
// cse_/session_ sids). Failing open on a single transient store hiccup would silently drop that
// protection. Retry once; only fail open if the retry ALSO throws.

test('I-3: a single transient findMission failure still resolves the mission and still refuses a standby one', async () => {
  let calls = 0;
  let probed = false;
  const r = await assertDriveable('cse_transient', {
    now: NOW,
    findMission: async () => {
      calls++;
      if (calls === 1) throw new Error('transient store hiccup');
      return { id: 'mission_cloud', manageMode: 'standby' } as any;
    },
    gather: async () => { probed = true; return {}; },
    latch: async () => {},
  });
  assert.equal(calls, 2, 'findMission must be retried exactly once after the first throw');
  assert.equal(r.ok, false);
  assert.equal((r as any).code, 'STANDBY_MODE');
  assert.equal(probed, false, 'the standby flag alone is enough — do not pay for a probe');
});

test('I-3: findMission failing on BOTH attempts still fails open (never a fleet-wide outage)', async () => {
  let calls = 0;
  const r = await assertDriveable('cse_still-down', {
    now: NOW,
    findMission: async () => { calls++; throw new Error('store still down'); },
    gather: async () => { throw new Error('must not probe when ownership is unknown'); },
    latch: async () => {},
  });
  assert.equal(calls, 2, 'exactly one retry, not a retry loop');
  assert.equal(r.ok, true, 'still failing after the retry must fail open, not lock the fleet out');
});
