import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composerIsNonEmpty } from '../terminal/cc';

// ── toy panes (illustrative, from the task brief) ──────────────────────────
const footer = '\n~/lm-assist\n  ctx:42%  sid: 0a1b2c3d-e4f5-6789-abcd-ef0123456789\n';

test('toy: empty composer reads as empty', () => {
  assert.equal(composerIsNonEmpty(`some output\n\n> ${footer}`), false);
});

test('toy: typed-but-unsubmitted text reads as non-empty', () => {
  assert.equal(composerIsNonEmpty(`some output\n\n> fix the parser${footer}`), true);
});

test('toy: a bare prompt marker with only whitespace is empty', () => {
  assert.equal(composerIsNonEmpty(`some output\n\n>    ${footer}`), false);
});

// ── real captured-pane fixtures ─────────────────────────────────────────────
// Shaped like the fixtures in cc-verified-submit.test.ts (PENDING_PANE /
// SUBMITTED_PANE / QUEUED_PANE) — same incident, same real pane structure.

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

// Real pane shape (117, 2026-07-26): live composer marker is '❯', and the
// statusline directly below echoes the LAST SUBMITTED prompt on a '>' line
// ending in '<N> tokens'. The composer itself here holds genuinely
// unsubmitted text.
const LIVE_TYPED_PANE = [
  '  ⏺ Working on it…',
  '',
  '  ❯ INJECTED_PROBE_MESSAGE please acknowledge this unique token ZQX7RAVEN',
  '    > Run exactly this and report output: bash -c "seq 1 30"                    42297 tokens',
  '    /tmp/scratchpad/qtest main                                                          /rc',
  '    no worktrees ctx:21% $0.092 ram:365M sid: 652f3f8e-96e9-4aca-8046-8ecda3a5aac6 Haiku 4.5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

// Same real shape, but idle: composer marker is bare, and the statusline
// still echoes the LAST SUBMITTED prompt (with trailing "<N> tokens") right
// below it. This is the exact false-positive shape that would make a guard
// anchored on '>' refuse every injection forever — the composer here holds
// NOTHING; only history is being echoed by the statusline.
const IDLE_WITH_STATUSLINE_ECHO_PANE = [
  '  ⏺ Response text',
  '',
  '  ❯',
  '    > Run exactly this and report output: bash -c "seq 1 30"                    42297 tokens',
  '    /tmp/scratchpad/qtest main                                                          /rc',
  '    no worktrees ctx:21% $0.092 ram:365M sid: 652f3f8e-96e9-4aca-8046-8ecda3a5aac6 Haiku 4.5',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
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

test('real pane: two stacked unsubmitted messages read as non-empty', () => {
  assert.equal(composerIsNonEmpty(PENDING_PANE), true);
});

test('real pane: composer emptied after a successful submit reads as empty', () => {
  assert.equal(composerIsNonEmpty(SUBMITTED_PANE), false);
});

test('real pane: genuinely typed unsubmitted text reads as non-empty even with a statusline echo below it', () => {
  assert.equal(composerIsNonEmpty(LIVE_TYPED_PANE), true);
});

test('real pane: statusline echoing a previously-submitted prompt over a genuinely empty composer reads as empty', () => {
  assert.equal(composerIsNonEmpty(IDLE_WITH_STATUSLINE_ECHO_PANE), false);
});

test('real pane: a queued-message placeholder is not typed content — reads as empty', () => {
  assert.equal(composerIsNonEmpty(QUEUED_PANE), false);
});
