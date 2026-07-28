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
import { planWindowsStart, windowsDriveHealth, INTERACTIVE_TASK, type WindowsStartFacts } from '../windows-session-guard';

function facts(over: Partial<WindowsStartFacts> = {}): WindowsStartFacts {
  return { isWindows: true, mySessionId: 0, interactiveSessionId: 1, taskName: INTERACTIVE_TASK, ...over };
}

// ── the refusal ────────────────────────────────────────────────────────────

test('🔴 THE TRAP: session 0 + a desktop + the task => REFUSE', () => {
  const v = planWindowsStart(facts());
  assert.equal(v.action, 'refuse');
});

test('the refusal gives the exact command, not just a diagnosis', () => {
  const v = planWindowsStart(facts());
  assert.match(v.message!, /schtasks \/run \/tn LmAssistCoreInteractive/);
});

test('the refusal explains that it would look HEALTHY — that is the whole hazard', () => {
  const v = planWindowsStart(facts());
  assert.match(v.message!, /healthy/i);
  assert.match(v.message!, /session 0/i);
});

test('the refusal names SSH, the usual way people land here', () => {
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
