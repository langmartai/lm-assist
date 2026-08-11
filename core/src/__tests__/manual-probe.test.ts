import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyManualControl } from '../mission/manual-probe';

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

test('a queued-message banner is manual (real pane)', () => {
  const r = classifyManualControl({ pane: QUEUED_PANE }, NOW);
  assert.equal(r.manual, true);
  assert.equal(r.reason, 'human-typing');
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
