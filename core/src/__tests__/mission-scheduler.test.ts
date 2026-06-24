import { test } from 'node:test';
import assert from 'node:assert';
import { makeBuiltinJobs } from '../scheduler/scheduled-jobs';

// The mission-controller builtin now seeds intervalMinutes=1 (lifecycle tick),
// decoupled from the 5-min drive cadence (which is gated inside the handler by driveDue).
test('makeBuiltinJobs seeds an enabled mission-controller job at interval 1 (lifecycle tick)', () => {
  const jobs = makeBuiltinJobs(1000);
  const mc = jobs.find((j) => j.id === 'mission-controller');
  assert.ok(mc, 'mission-controller builtin present');
  assert.strictEqual(mc!.type, 'mission-controller');
  assert.strictEqual(mc!.enabled, true);
  assert.strictEqual(mc!.intervalMinutes, 1, 'lifecycle tick interval must be 1 min for prompt failover');
  assert.strictEqual(mc!.builtin, true);
});
