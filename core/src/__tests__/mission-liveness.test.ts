import { test } from 'node:test';
import assert from 'node:assert';
import { executorLiveness } from '../mission/mission-controller';
test('non-terminal status is alive', () => {
  assert.strictEqual(executorLiveness({ status: 'active', boundAt: 0, now: 9e12, graceMs: 1000 }), true);
});
test('terminal status past grace is dead', () => {
  assert.strictEqual(executorLiveness({ status: 'stopped', boundAt: 1000, now: 1000 + 600000, graceMs: 120000 }), false);
});
test('missing status within grace is alive (just-started / transient)', () => {
  assert.strictEqual(executorLiveness({ status: null, boundAt: 1000, now: 1000 + 5000, graceMs: 120000 }), true);
});
test('missing status past grace is dead', () => {
  assert.strictEqual(executorLiveness({ status: null, boundAt: 1000, now: 1000 + 600000, graceMs: 120000 }), false);
});
test('confirmed terminal status within grace is still dead (no grace for known-dead)', () => {
  assert.strictEqual(executorLiveness({ status: 'stopped', boundAt: 1000, now: 1000 + 5000, graceMs: 120000 }), false);
});
