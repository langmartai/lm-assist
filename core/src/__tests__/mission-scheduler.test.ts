import { test } from 'node:test';
import assert from 'node:assert';
import { makeBuiltinJobs } from '../scheduler/scheduled-jobs';

test('makeBuiltinJobs seeds an enabled mission-controller job at interval 5', () => {
  const jobs = makeBuiltinJobs(1000);
  const mc = jobs.find((j) => j.id === 'mission-controller');
  assert.ok(mc, 'mission-controller builtin present');
  assert.strictEqual(mc!.type, 'mission-controller');
  assert.strictEqual(mc!.enabled, true);
  assert.strictEqual(mc!.intervalMinutes, 5);
  assert.strictEqual(mc!.builtin, true);
});
