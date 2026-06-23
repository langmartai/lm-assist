import { test } from 'node:test';
import assert from 'node:assert';
import { planStallAction, backoffMinutes, StallRecord, StallConfig } from '../monitor/stall-state';

const cfg: StallConfig = { intervalMin: 5, maxAttempts: 6 };
const MIN = 60_000;

test('backoffMinutes widens 5,5,10,10,15,15', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((s) => backoffMinutes(s, 5)), [5, 5, 10, 10, 15, 15]);
});

test('first detection nudges (attempt 1)', () => {
  const r = planStallAction(undefined, { now: 1000, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'nudge');
  assert.strictEqual(r.next!.attempts, 1);
  assert.strictEqual(r.next!.lastNudgeAt, 1000);
});

test('not yet due → wait', () => {
  const rec: StallRecord = { attempts: 1, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 0, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 4 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'wait');
});

test('due → nudge again, attempts++ and backoff widens', () => {
  const rec: StallRecord = { attempts: 1, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 0, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 5 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'nudge');
  assert.strictEqual(r.next!.attempts, 2);
  assert.strictEqual(r.next!.backoffStep, 1);
});

test('cap reached → giveup', () => {
  const rec: StallRecord = { attempts: 6, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 5, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 999 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'giveup');
  assert.strictEqual(r.next!.gaveUp, true);
});

test('progress seen → reset (clears record)', () => {
  const rec: StallRecord = { attempts: 3, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 1, gaveUp: false };
  const r = planStallAction(rec, { now: 9_999_999, stillStalled: false, seenProgress: true, cfg });
  assert.strictEqual(r.action, 'reset');
  assert.strictEqual(r.next, null);
});

test('no longer stalled (no progress flag) → wait, keep record', () => {
  const rec: StallRecord = { attempts: 2, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 1, gaveUp: false };
  const r = planStallAction(rec, { now: 1000 + 99 * MIN, stillStalled: false, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'wait');
});

test('already gaveUp → wait (never nudge again)', () => {
  const rec: StallRecord = { attempts: 6, lastNudgeAt: 1000, category: 'overloaded', backoffStep: 5, gaveUp: true };
  const r = planStallAction(rec, { now: 1000 + 999 * MIN, stillStalled: true, seenProgress: false, cfg });
  assert.strictEqual(r.action, 'wait');
});
