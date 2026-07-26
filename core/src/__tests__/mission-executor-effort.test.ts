import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortFlags, buildLaunchCmd } from '../terminal/cc';
import { missionEffort } from '../mission/mission-model';

// Executors used to launch with NO --effort at all, so every worker silently ran at the
// CLI default while briefs claimed "max thinking". These lock the flag in.

test('valid levels are forwarded', () => {
  for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(effortFlags(lvl), ['--effort', lvl]);
  }
});

test('an INVALID level is dropped, never forwarded', () => {
  // claude warns + falls back to default on an unknown value, so forwarding it would
  // look like effort was applied when it was not.
  for (const bad of ['bogus', 'MAX', 'ultra', ' ', '']) {
    assert.deepEqual(effortFlags(bad), [], `should drop: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(effortFlags(undefined), []);
});

test('buildLaunchCmd emits --effort only when set', () => {
  const base = { cwd: '/tmp', model: null, extraFlags: [], skipPermissions: true, remoteControl: true,
    cols: 200, rows: 50, readyPattern: 'ctx:', readyTimeoutMs: 1000, autoAcceptTrust: true } as never;
  assert.match(buildLaunchCmd({ ...(base as object), effort: 'max' } as never), /--effort max/);
  assert.doesNotMatch(buildLaunchCmd(base), /--effort/);
  assert.doesNotMatch(buildLaunchCmd({ ...(base as object), effort: 'nope' } as never), /--effort/);
});

test('policy: explicit env.effort wins over priority', () => {
  assert.equal(missionEffort({ env: { effort: 'low' }, tags: { priority: ['critical'] } }), 'low');
});

test('policy: critical/high default to max, others inherit the CLI default', () => {
  assert.equal(missionEffort({ tags: { priority: ['critical'] } }), 'max');
  assert.equal(missionEffort({ tags: { priority: ['high'] } }), 'max');
  assert.equal(missionEffort({ tags: { priority: ['med'] } }), undefined);
  assert.equal(missionEffort({ tags: {} }), undefined);
  assert.equal(missionEffort(null), undefined);
});
