import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyManualControl, gatherProbeSignals } from '../mission/manual-probe';

const NOW = 1_000_000;

// ── realistic captured-pane fixtures ────────────────────────────────────────
// Same real pane shapes as `cc-composer-nonempty.test.ts` (117, 2026-07-26) —
// a classifier proven only on toy panes is not proven.

// Two messages stacked unsubmitted in the composer above cwd + footer lines.
const PENDING_PANE = [
  '  ⏺ Previous response text here',
  '',
  '    > ⟦INVARIANTS — these override anything below and are not editable⟧',
  '    - NEVER auto-approve a need_approval gate or a materia',
  '    > ⟦TRACE-TEST⟧ reply with exactly: TRACE-OK-991',
  '    /home/ubuntu/.lm-assist/mission-control main',
  '    no worktrees ctx:29% $74.05 5h:6% sid: 755ae046 Fable 5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

// After a successful submit: history shows the sent turn, composer is empty.
const SUBMITTED_PANE = [
  '    > ⟦TRACE-TEST⟧ reply with exactly: TRACE-OK-991',
  '',
  '  ⏺ TRACE-OK-991',
  '',
  '    >',
  '    /home/ubuntu/.lm-assist/mission-control main',
  '    no worktrees ctx:29% sid: 755ae046 Fable 5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

// Real pane shape: Claude Code QUEUED a message while busy. The composer
// shows its own placeholder hint ("Press up to edit queued messages"), not
// user-typed content — nothing is unsubmitted here, it was already accepted.
const QUEUED_PANE = [
  '  ⏺ Working on it…',
  '',
  '  ❯ INJECTED_PROBE_MESSAGE please acknowledge this unique token ZQX7RAVEN',
  '──────────────────────────────────────────────',
  '❯ Press up to edit queued messages',
  '──────────────────────────────────────────────',
  '    > Run exactly this and report output: bash -c "seq 1 30"                    42297 tokens',
  '    /tmp/scratchpad/qtest main                                                          /rc',
  '    no worktrees ctx:21% $0.092 ram:365M sid: 652f3f8e-96e9-4aca-8046-8ecda3a5aac6 Haiku 4.5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

test('a human tmux client attached is manual', () => {
  const r = classifyManualControl({ attached: true, hasAttachedTtyd: false }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-attached');
});

test('OUR OWN ttyd attached is NOT manual', () => {
  // ttyd attaches as a tmux client, so `attached` alone would read every open
  // console tab as a human. This cross-reference is the whole point.
  const r = classifyManualControl({ attached: true, hasAttachedTtyd: true }, NOW);
  assert.equal(r.manual, false);
});

test("the user's own tmux is manual", () => {
  const r = classifyManualControl({ managedBy: 'unmanaged-tmux', source: 'external-terminal' }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-terminal');
});

test('unsubmitted text in the composer is manual (real pane)', () => {
  const r = classifyManualControl({ pane: PENDING_PANE }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-typing');
});

// I-2: rule 4 (paneShowsQueuedMessage) was removed. The queued-message banner is NOT
// attributable — Claude Code paints the identical placeholder whether the queued input
// came from a human typing or from lm-assist's own drive landing on a busy session. Before
// the fix this classified as manual, which meant the controller's normal drive → (busy) →
// answer/control/resume sequence would latch a worker to standby against ITSELF, a lockout
// only a human can release. Confirm the queued pane, with no OTHER signal present, no longer
// classifies as manual.
test('a queued-message banner alone is NOT manual (not attributable — could be our own queued drive)', () => {
  const r = classifyManualControl({ pane: QUEUED_PANE }, NOW);
  assert.equal(r.manual, false);
});

test('input we did not send is a foreign driver', () => {
  const r = classifyManualControl({ lastUserMessageAt: NOW - 1000, lastSelfDriveAt: NOW - 60_000 }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'foreign-driver');
});

test('input WE sent is not a foreign driver', () => {
  const r = classifyManualControl({ lastUserMessageAt: NOW - 60_000, lastSelfDriveAt: NOW - 61_000 }, NOW);
  assert.equal(r.manual, false);
});

test('a quiet, unattached session is not manual (real pane, composer empty)', () => {
  const r = classifyManualControl({ attached: false, pane: SUBMITTED_PANE }, NOW);
  assert.equal(r.manual, false);
  assert.equal(r.reason, undefined);
});

test('no signals at all is not manual — absence of evidence is not evidence', () => {
  assert.equal(classifyManualControl({}, NOW).manual, false);
});

// ---------------------------------------------------------------------------
// I3: gatherProbeSignals IO — a cold/stale process-status cache must not latch.
//
// `out.attached` comes from tmux (instant, authoritative); `hasAttachedTtyd` comes from
// `getCachedProcesses()`, which is empty on first use and only periodically refreshed. When
// NO process record matches at all, that is genuinely "no evidence either way" — not
// "found, and it's not ours". Before the fix, `attached` stayed populated from tmux while
// `hasAttachedTtyd` stayed `undefined`, and classifier rule 1 (`attached === true &&
// hasAttachedTtyd !== true`) free-fired 'human-attached' on a perfectly healthy managed
// session — latching it to `manageMode: 'standby'`, reversible only by a human. A cold Core
// (or a stale-cache window) must not silently halt a mission this way.
//
// Stubs the lazy `require()`d IO modules gatherProbeSignals reaches for — same pattern as
// `dev-mode-upgrade-source.test.ts`: mutate the cached module's exported function/property
// in place (CommonJS `require()` returns the live, shared `module.exports` object), restore
// in `finally` so nothing leaks to other suites.
// ---------------------------------------------------------------------------

test('I3: a cold process-status cache withholds `attached` too, so a healthy session does not latch', async () => {
  const ccSessions = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
  const tmux = require('../terminal/tmux') as typeof import('../terminal/tmux');
  const processStatusStore = require('../process-status-store') as typeof import('../process-status-store');
  const tmuxBackend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');

  const origSessionVerdict = ccSessions.sessionVerdict;
  const origGetState = tmux.getState;
  const origGetProcessStatusStore = processStatusStore.getProcessStatusStore;
  const origCapture = tmuxBackend.tmuxTerminalBackend.capture;

  (ccSessions as any).sessionVerdict = () => ({
    sessionId: 'sid-cold', jsonl: null, live: true, owner: null, inTmux: true,
    tmuxSession: 'lmcc-cold', pane: null, allowedModes: [], connectStrategy: 'attach',
    safeToCreateTmux: false, reason: 'test',
  });
  // A genuinely attached tmux client — exactly the shape that free-fired 'human-attached'
  // pre-fix once paired with an empty process cache.
  (tmux as any).getState = () => ({ attached: true });
  // COLD cache: no process record for this tmux session at all (Core just booted, or the
  // periodic refresh window hasn't caught up yet) — NOT "found, and it's not our ttyd".
  (processStatusStore as any).getProcessStatusStore = () => ({ getCachedProcesses: () => [] });
  (tmuxBackend.tmuxTerminalBackend as any).capture = async () => ({ text: '' });

  try {
    const signals = await gatherProbeSignals('sid-cold');
    assert.equal(signals.attached, undefined,
      'a cold process-status cache must withhold `attached` too — half-evidence must not drive a human-only-reversible latch');
    assert.equal(signals.hasAttachedTtyd, undefined);

    const verdict = classifyManualControl(signals, Date.now());
    assert.equal(verdict.manual, false, 'a cold cache must not classify a healthy session as manually operated');
  } finally {
    (ccSessions as any).sessionVerdict = origSessionVerdict;
    (tmux as any).getState = origGetState;
    (processStatusStore as any).getProcessStatusStore = origGetProcessStatusStore;
    (tmuxBackend.tmuxTerminalBackend as any).capture = origCapture;
  }
});

test('I3 contrast: a WARM cache that positively finds a foreign process still latches', async () => {
  const ccSessions = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
  const tmux = require('../terminal/tmux') as typeof import('../terminal/tmux');
  const processStatusStore = require('../process-status-store') as typeof import('../process-status-store');
  const tmuxBackend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');

  const origSessionVerdict = ccSessions.sessionVerdict;
  const origGetState = tmux.getState;
  const origGetProcessStatusStore = processStatusStore.getProcessStatusStore;
  const origCapture = tmuxBackend.tmuxTerminalBackend.capture;

  (ccSessions as any).sessionVerdict = () => ({
    sessionId: 'sid-warm', jsonl: null, live: true, owner: null, inTmux: true,
    tmuxSession: 'lmcc-warm', pane: null, allowedModes: [], connectStrategy: 'attach',
    safeToCreateTmux: false, reason: 'test',
  });
  (tmux as any).getState = () => ({ attached: true });
  // WARM cache: a record for this exact tmux session exists and says it is NOT our ttyd.
  (processStatusStore as any).getProcessStatusStore = () => ({
    getCachedProcesses: () => [{ tmuxSessionName: 'lmcc-warm', hasAttachedTtyd: false, managedBy: 'lm-assist', source: 'ttyd' }],
  });
  (tmuxBackend.tmuxTerminalBackend as any).capture = async () => ({ text: '' });

  try {
    const signals = await gatherProbeSignals('sid-warm');
    assert.equal(signals.attached, true, 'a found process record must NOT suppress a real attached=true');
    assert.equal(signals.hasAttachedTtyd, false);

    const verdict = classifyManualControl(signals, Date.now());
    assert.equal(verdict.manual, true);
    assert.equal(verdict.reason, 'human-attached');
  } finally {
    (ccSessions as any).sessionVerdict = origSessionVerdict;
    (tmux as any).getState = origGetState;
    (processStatusStore as any).getProcessStatusStore = origGetProcessStatusStore;
    (tmuxBackend.tmuxTerminalBackend as any).capture = origCapture;
  }
});
