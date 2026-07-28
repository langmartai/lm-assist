/**
 * `launched: true` must mean "something observably appeared" — not "I called spawn".
 *
 * Measured on DESKTOP-GDKLATG 2026-07-28: windows_terminal_create returned
 *
 *   { launched: true, sessionId: null, win: null, tabRid: null, trustHandled: false }
 *
 * and NOTHING had been created — the box showed only the two pre-existing claude
 * processes (15 Jul, 18 Jul) and their terminal hosts. The spawn is
 * `spawn('wt.exe', …, {detached:true, stdio:'ignore'})` + `unref()`, so nothing
 * was ever checked. The real cause is Session 0 isolation: Core runs as a service
 * in Windows session 0 and cannot create a window on the interactive desktop.
 *
 * Same false-positive class as `success:false is not proof that nothing happened`
 * (be20ea1) — inverted: a hardcoded `true` is not proof that something did.
 *
 * Pure function; every fact is injected.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { describeWindowsLaunch, type LaunchEvidence } from '../../terminal/windows-launch-verdict';

function ev(over: Partial<LaunchEvidence> = {}): LaunchEvidence {
  return {
    sessionRegistered: false,
    tabAppeared: false,
    processAppeared: false,
    coreSessionId: null,
    desktopSessionId: null,
    spawnError: null,
    ...over,
  };
}

// ── the bug ───────────────────────────────────────────────────────────────

test('NO evidence at all => launched:false (the exact 107 false positive)', () => {
  const v = describeWindowsLaunch(ev());
  assert.equal(v.launched, false);
});

test('no evidence AND Core in session 0 => names Session 0 isolation and the remedy', () => {
  const v = describeWindowsLaunch(ev({ coreSessionId: 0, desktopSessionId: 1 }));
  assert.equal(v.launched, false);
  assert.match(v.note!, /[Ss]ession 0/);
  assert.match(v.note!, /interactive desktop/i, 'must state the remedy, not just the symptom');
});

test('Core in session 0 is enough to diagnose even when the desktop session is unknown', () => {
  // The failure path often has no pid to map, so desktopSessionId stays null.
  const v = describeWindowsLaunch(ev({ coreSessionId: 0, desktopSessionId: null }));
  assert.equal(v.launched, false);
  assert.match(v.note!, /[Ss]ession 0/);
});

test('a spawn error is surfaced verbatim, not swallowed', () => {
  const v = describeWindowsLaunch(ev({ spawnError: 'ENOENT wt.exe' }));
  assert.equal(v.launched, false);
  assert.match(v.note!, /ENOENT wt\.exe/);
});

// ── positive evidence ─────────────────────────────────────────────────────

test('a registered session is conclusive => launched:true', () => {
  const v = describeWindowsLaunch(ev({ sessionRegistered: true, tabAppeared: true, processAppeared: true }));
  assert.equal(v.launched, true);
});

test('a new TAB alone counts, even if the session has not registered yet', () => {
  const v = describeWindowsLaunch(ev({ tabAppeared: true }));
  assert.equal(v.launched, true);
});

test('a new PROCESS alone counts (tab diff can be ambiguous under concurrent launches)', () => {
  const v = describeWindowsLaunch(ev({ processAppeared: true }));
  assert.equal(v.launched, true);
});

test('process but no registered session => launched, with the trust-prompt hint', () => {
  const v = describeWindowsLaunch(ev({ processAppeared: true, tabAppeared: true }));
  assert.equal(v.launched, true);
  assert.match(v.note!, /trust/i);
});

test('a fully successful launch carries no warning note', () => {
  const v = describeWindowsLaunch(ev({ sessionRegistered: true, tabAppeared: true, processAppeared: true }));
  assert.equal(v.note, undefined);
});

test('Session 0 is NOT blamed when something actually appeared', () => {
  // Core can sit in session 0 and still have a working launch path; do not
  // attach a scary diagnosis to a success.
  const v = describeWindowsLaunch(ev({ sessionRegistered: true, tabAppeared: true, coreSessionId: 0, desktopSessionId: 1 }));
  assert.equal(v.launched, true);
  assert.ok(!/[Ss]ession 0/.test(v.note || ''), `session-0 blamed on a success: ${v.note}`);
});

test('a non-zero Core session is not blamed on Session 0 isolation', () => {
  const v = describeWindowsLaunch(ev({ coreSessionId: 1, desktopSessionId: 1 }));
  assert.equal(v.launched, false);
  assert.ok(!/[Ss]ession 0/.test(v.note || ''), 'session 0 blamed when Core is in session 1');
});
