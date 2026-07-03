// core/src/__tests__/fabric/restoration.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideSwitch, applyProbe, PathSupervisor, type FlapState } from '../../fabric/restoration';

const fresh = (): FlapState => ({ consecutiveOk: 0, lastSwitchAt: 0, flapCount: 0 });

test('needs 2 consecutive confirmations to climb', () => {
  const s = fresh();
  assert.equal(decideSwitch({ ...s, consecutiveOk: 1 }, true, { now: 60_000 }).switch, false);
  assert.equal(decideSwitch({ ...s, consecutiveOk: 2 }, true, { now: 60_000 }).switch, true);
});

test('respects the min interval between switches', () => {
  const s: FlapState = { consecutiveOk: 5, lastSwitchAt: 50_000, flapCount: 0 };
  assert.equal(decideSwitch(s, true, { now: 60_000 }).switch, false); // only 10s since last switch (<30s)
  assert.equal(decideSwitch(s, true, { now: 90_000 }).switch, true);  // 40s later
});

test('a flapper needs exponentially more confirmations', () => {
  const flapper: FlapState = { consecutiveOk: 2, lastSwitchAt: 0, flapCount: 2 }; // needs 2*2^2 = 8
  assert.equal(decideSwitch(flapper, true, { now: 100_000 }).switch, false);
  assert.equal(decideSwitch({ ...flapper, consecutiveOk: 8 }, true, { now: 100_000 }).switch, true);
});

test('applyProbe folds results: success accrues, a switch bumps flapCount + resets', () => {
  let s = fresh();
  s = applyProbe(s, true, { now: 1000 }).state;   // ok=1, no switch
  const r = applyProbe(s, true, { now: 60_000 }); // ok=2 → switch
  assert.equal(r.switched, true);
  assert.equal(r.state.flapCount, 1);
  assert.equal(r.state.consecutiveOk, 0);
  assert.equal(r.state.lastSwitchAt, 60_000);
  const miss = applyProbe(r.state, false, { now: 61_000 }); // better path gone → reset streak
  assert.equal(miss.state.consecutiveOk, 0);
});

// --- Supplemental tests (beyond the brief's 4 given tests above, which cover only
// the pure decideSwitch/applyProbe functions). These close the gap against the task's
// own TDD list: repeat-flap compounding across TWO switches (the given tests only ever
// drive one switch), PathSupervisor.tick()'s decision-folding, and PathSupervisor's
// timer cadence — all driven by the injected clock/fakes, no real 30s/10min sleeping. ---

test('applyProbe: repeat flapping compounds flapCount 0->1->2, and the second climb needs a proportionally larger confirm streak', () => {
  let s = fresh();
  // First climb: flapCount=0 needs 2*2^0=2 confirms.
  s = applyProbe(s, true, { now: 40_000 }).state;   // ok=1, no switch
  let r = applyProbe(s, true, { now: 80_000 });      // ok=2 -> switches, flapCount 0->1
  assert.equal(r.switched, true);
  assert.equal(r.state.flapCount, 1);
  s = r.state; // { consecutiveOk: 0, lastSwitchAt: 80_000, flapCount: 1 }

  // Second climb: flapCount=1 now needs 2*2^1=4 confirms, not 2.
  s = applyProbe(s, true, { now: 120_000 }).state;   // ok=1
  s = applyProbe(s, true, { now: 160_000 }).state;   // ok=2 -- would have switched pre-flap, not now
  assert.equal(decideSwitch(s, true, { now: 160_000 }).switch, false);
  s = applyProbe(s, true, { now: 200_000 }).state;   // ok=3
  r = applyProbe(s, true, { now: 240_000 });          // ok=4 -> switches, flapCount 1->2
  assert.equal(r.switched, true);
  assert.equal(r.state.flapCount, 2);
  assert.equal(r.state.consecutiveOk, 0);
});

test('PathSupervisor.tick(): folds each probe through applyProbe and fires onSwitch on the confirming tick, driven entirely by an injected clock', async () => {
  let clock = 0;
  const now = () => clock;
  let switches = 0;
  const sup = new PathSupervisor({ probeBetter: async () => true, onSwitch: () => { switches++; }, now });

  clock = 1_000;
  await sup.tick(); // ok=1 -> no switch (also short of the 30s min-interval from lastSwitchAt=0)
  assert.equal(switches, 0);
  assert.deepEqual(sup.counters(), { upgrades: 0, downgrades: 0, flaps: 0 });

  clock = 60_000;
  await sup.tick(); // ok=2, 60s since lastSwitchAt=0 -> switch
  assert.equal(switches, 1);
  assert.deepEqual(sup.counters(), { upgrades: 1, downgrades: 0, flaps: 1 });
});

test('PathSupervisor.start(): schedules the probe on the configured cadence and stop() clears it -- no real sleeping', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let capturedCallback: (() => void) | null = null;
  let capturedMs: number | undefined;
  let clearedHandle: unknown = 'unset';
  const fakeHandle = { unref: () => fakeHandle } as unknown as NodeJS.Timeout;
  (global as unknown as { setInterval: typeof setInterval }).setInterval =
    ((cb: () => void, ms?: number) => { capturedCallback = cb; capturedMs = ms; return fakeHandle; }) as typeof setInterval;
  (global as unknown as { clearInterval: typeof clearInterval }).clearInterval =
    ((h: unknown) => { clearedHandle = h; }) as typeof clearInterval;
  try {
    let probeCalls = 0;
    const sup = new PathSupervisor({ probeBetter: async () => { probeCalls++; return false; }, onSwitch: () => {}, intervalMs: 12_345 });

    sup.start();
    assert.equal(capturedMs, 12_345); // the configured cadence, not the 30s production default
    assert.equal(typeof capturedCallback, 'function');

    sup.start(); // idempotent: a second start() must not re-register
    assert.equal(probeCalls, 0);

    capturedCallback!(); // manually fire the "interval elapsed" callback -- zero real wait
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(probeCalls, 1); // the registered callback really does drive a probe

    sup.stop();
    assert.equal(clearedHandle, fakeHandle);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
