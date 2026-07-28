/**
 * The guard that stops Core starting where it can never drive anything.
 *
 * Measured on DESKTOP-GDKLATG 2026-07-28: `lm-assist start` over SSH put Core in
 * Windows session 0. It reported healthy, listed sessions, survived restarts —
 * and could not type into a single one. Moving it to session 1 fixed everything.
 *
 * The balance under test: refuse when a BETTER option exists, never when
 * refusing would just leave the node with no Core at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { planWindowsStart, windowsDriveHealth, describeRedirectOutcome, INTERACTIVE_TASK, type WindowsStartFacts } from '../windows-session-guard';

function facts(over: Partial<WindowsStartFacts> = {}): WindowsStartFacts {
  return { isWindows: true, mySessionId: 0, interactiveSessionId: 1, taskName: INTERACTIVE_TASK, ...over };
}

// ── the refusal ────────────────────────────────────────────────────────────

test('🔴 THE TRAP: session 0 + a desktop + the task => REDIRECT, not refuse', () => {
  // Session 0 can trigger the task, so APPLY the fix rather than print it.
  const v = planWindowsStart(facts());
  assert.equal(v.action, 'redirect');
  assert.equal(v.taskName, INTERACTIVE_TASK, 'the caller needs to know what to run');
});

test('the redirect explains that a direct start would look HEALTHY — the whole hazard', () => {
  const v = planWindowsStart(facts());
  assert.match(v.message!, /healthy/i);
  assert.match(v.message!, /session 0/i);
});

test('the redirect names SSH, the usual way people land here', () => {
  assert.match(planWindowsStart(facts()).message!, /SSH/i);
});

// ── when refusing would be worse than starting ─────────────────────────────

test('no task registered => WARN and start — a degraded Core beats no Core', () => {
  const v = planWindowsStart(facts({ taskName: null }));
  assert.equal(v.action, 'warn');
  assert.match(v.message!, /NOT be able to type/i);
});

test('nobody logged on => WARN and start — session 1 does not exist to move to', () => {
  const v = planWindowsStart(facts({ interactiveSessionId: null }));
  assert.equal(v.action, 'warn');
  assert.match(v.message!, /nobody logged on/i);
});

test('🔴 an UNKNOWN session id never blocks a start', () => {
  // A failed probe is not evidence of trouble; refusing on it would strand nodes.
  assert.equal(planWindowsStart(facts({ mySessionId: null })).action, 'proceed');
});

// ── the healthy paths ──────────────────────────────────────────────────────

test('already in the interactive session => proceed silently', () => {
  const v = planWindowsStart(facts({ mySessionId: 1 }));
  assert.equal(v.action, 'proceed');
  assert.equal(v.message, null);
});

test('non-Windows is untouched — this guard must not affect POSIX at all', () => {
  const v = planWindowsStart(facts({ isWindows: false, mySessionId: 0 }));
  assert.equal(v.action, 'proceed');
  assert.equal(v.message, null);
});

// ── the persistent signal ──────────────────────────────────────────────────

test('🔴 status reports NOT driveable while Core sits in session 0', () => {
  // The start-time message is seen once. This is what the next person finds.
  const h = windowsDriveHealth(facts());
  assert.equal(h.driveable, false);
  assert.match(h.reason!, /session 0/i);
  assert.match(h.reason!, /LmAssistCoreInteractive/);
});

test('status is clean once Core is in the interactive session', () => {
  const h = windowsDriveHealth(facts({ mySessionId: 1 }));
  assert.equal(h.driveable, true);
  assert.equal(h.reason, null);
});

test('status never reports a POSIX host as undriveable', () => {
  assert.equal(windowsDriveHealth(facts({ isWindows: false })).driveable, true);
});

// ── whose session are we asking about? ─────────────────────────────────────
//
// 🔴 `status` must inspect the RUNNING CORE, not the process running `status`.
// Over SSH the CLI is always in session 0 while Core may be correctly in
// session 1 — probing ourselves warns on a healthy node and, on the desktop,
// stays silent on a stranded one. Caught on 107 before shipping.

test('status is CLEAN when Core is in session 1, even though the CLI is in session 0', () => {
  // The facts a status run over SSH would gather about ITSELF are session 0;
  // what matters is Core's session, which is what gets passed in.
  const h = windowsDriveHealth(facts({ mySessionId: 1 }));
  assert.equal(h.driveable, true, 'a healthy Core must not be reported undriveable');
});

test('status WARNS when Core is in session 0, whoever asked', () => {
  const h = windowsDriveHealth(facts({ mySessionId: 0 }));
  assert.equal(h.driveable, false);
});

test('an unresolvable Core session is not reported as broken', () => {
  // Core not running, or the probe failed — absence of evidence, not evidence.
  assert.equal(windowsDriveHealth(facts({ mySessionId: null })).driveable, true);
});

// ── did the redirect actually work? ────────────────────────────────────────
//
// 🔴 Firing the task and reporting success would be the same false-confidence
// bug this branch fixed four times (`success:false`, `launched:true`,
// `submitted:true`, DRY-RUN `would-reap=0`). Only observed evidence counts.

test('redirect SUCCESS requires health AND a non-zero session', () => {
  const r = describeRedirectOutcome(true, 1, INTERACTIVE_TASK);
  assert.equal(r.success, true);
  assert.match(r.message, /session 1/);
});

test('🔴 Core never came up => NOT success, with the manual command', () => {
  const r = describeRedirectOutcome(false, null, INTERACTIVE_TASK);
  assert.equal(r.success, false);
  assert.match(r.message, /schtasks \/run \/tn LmAssistCoreInteractive/);
});

test('🔴 healthy but STILL in session 0 => NOT success — health is not driveability', () => {
  // The exact trap: a Core that answers perfectly and can drive nothing.
  const r = describeRedirectOutcome(true, 0, INTERACTIVE_TASK);
  assert.equal(r.success, false);
  assert.match(r.message, /still in Windows session 0/i);
  assert.match(r.message, /LogonType=Interactive/, 'name the misconfiguration to fix');
});

test('an unknown session on a healthy Core is accepted rather than failed', () => {
  // The probe can fail; that is not evidence the redirect did not work.
  assert.equal(describeRedirectOutcome(true, null, INTERACTIVE_TASK).success, true);
});
