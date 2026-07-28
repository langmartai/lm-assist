/**
 * Unit tests for tmux-server-guard.ts — the regression guard on `lm-assist restart`.
 *
 * The 2026-07-28 prod incident looked like a CLEAN restart: services came back
 * healthy and the CLI printed success, while the tmux server and every Claude Code
 * pane on the node had been reaped. The guard exists so that can never again be
 * reported as a clean restart.
 *
 * Pure function; pids are injected.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { describeTmuxServerChange } from '../../terminal/tmux-server-guard';

test('same pid: the server survived — ok', () => {
  const v = describeTmuxServerChange(2283276, 2283276);
  assert.equal(v.ok, true);
  assert.equal(v.reaped, false);
  assert.match(v.message, /survived/i);
});

test('pid VANISHED: not ok, and named as a reap', () => {
  const v = describeTmuxServerChange(3951402, null);
  assert.equal(v.ok, false);
  assert.equal(v.reaped, true);
  assert.match(v.message, /3951402/, 'the dead pid must be in the message');
});

test('pid CHANGED: not ok — the old server was reaped and a new one took its place', () => {
  const v = describeTmuxServerChange(3951402, 2014687);
  assert.equal(v.ok, false);
  assert.equal(v.reaped, true);
  assert.match(v.message, /3951402/);
  assert.match(v.message, /2014687/);
});

test('a reap message says what was LOST, not just that a pid moved', () => {
  // The whole point: "pid changed" is not actionable; "every pane died" is.
  for (const v of [describeTmuxServerChange(1, null), describeTmuxServerChange(1, 2)]) {
    assert.match(v.message, /pane|session/i, `not actionable: ${v.message}`);
  }
});

test('no server before, none after: ok (nothing to protect)', () => {
  const v = describeTmuxServerChange(null, null);
  assert.equal(v.ok, true);
  assert.equal(v.reaped, false);
});

test('no server before, one after: ok — a server STARTING is not a reap', () => {
  const v = describeTmuxServerChange(null, 2014687);
  assert.equal(v.ok, true);
  assert.equal(v.reaped, false);
});

test('the verdict carries both pids for the caller to log', () => {
  const v = describeTmuxServerChange(111, 222);
  assert.equal(v.before, 111);
  assert.equal(v.after, 222);
});
