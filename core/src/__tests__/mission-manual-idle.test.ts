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
