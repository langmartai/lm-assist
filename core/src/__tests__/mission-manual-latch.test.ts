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
