import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSettleMs, extractComposerBlock, composerHoldsText } from '../terminal/cc';

test('computeSettleMs scales with text size, clamped', () => {
  assert.equal(computeSettleMs(0), 150);
  assert.equal(computeSettleMs(800), 250);
  assert.equal(computeSettleMs(100_000), 1500);
});

// Fixture shaped like the REAL captured pane during the incident: two messages
// stacked unsubmitted in the composer above the cwd + footer lines.
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

test('extractComposerBlock isolates the pending block above cwd/footer', () => {
  const block = extractComposerBlock(PENDING_PANE);
  assert.ok(block.includes('TRACE-TEST'), 'pending composer holds the typed text');
  assert.ok(block.includes('INVARIANTS'), 'stacked earlier message included');
  assert.ok(!block.includes('Previous response'), 'scrollback stays out');
});

test('composerHoldsText: true while pending, false after submit (tail in history only)', () => {
  const text = '⟦TRACE-TEST⟧ reply with exactly: TRACE-OK-991';
  assert.equal(composerHoldsText(PENDING_PANE, text), true);
  assert.equal(composerHoldsText(SUBMITTED_PANE, text), false);
});

// ── REAL captured panes (117, 2026-07-26) ───────────────────────────────────
// Captured live from a busy Claude Code session while reproducing the
// send_session_message false-negative. Two details the older hand-written
// fixtures above do NOT model, and which together caused the bug:
//   1. The live composer marker is '❯' (U+276F) between two border rules.
//   2. Below it sits the lm-assist STATUSLINE, whose first line echoes the
//      LAST SUBMITTED PROMPT on a '>' line ending in '<N> tokens'.
// extractComposerBlock anchored on /^\s*>/ and so latched onto the statusline
// echo, then swept upward through the queued-message block.
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

test('QUEUED message is a SUCCESSFUL submit — not "still in the composer"', () => {
  const queued = 'INJECTED_PROBE_MESSAGE please acknowledge this unique token ZQX7RAVEN';
  // The incident: this returned true, so typeAndSubmitVerified threw
  // SUBMIT_UNVERIFIED for a message Claude Code had already queued.
  assert.equal(composerHoldsText(QUEUED_PANE, queued), false);
});

test('the statusline last-prompt echo is never mistaken for composer content', () => {
  // The statusline renders the SUBMITTED prompt on a '>' line with a trailing
  // token count. Reading it back as pending input false-negatives every send.
  const submitted = 'Run exactly this and report output: bash -c "seq 1 30"';
  assert.equal(composerHoldsText(QUEUED_PANE, submitted), false);
  assert.ok(!extractComposerBlock(QUEUED_PANE).includes('42297 tokens'),
    'statusline must stay out of the composer block');
});

test('paneShowsQueuedMessage detects Claude Code queueing input while busy', async () => {
  const { paneShowsQueuedMessage } = await import('../terminal/cc');
  assert.equal(paneShowsQueuedMessage(QUEUED_PANE), true);
  assert.equal(paneShowsQueuedMessage(PENDING_PANE), false);
  assert.equal(paneShowsQueuedMessage(SUBMITTED_PANE), false);
});

// Real pane fixture from the incident: plan-approval dialog on the chart session.
const PLAN_DIALOG_PANE = [
  ' 5. Memory + arch doc updated (project convention).',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '',
  '──────────────────────────────────',
  ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
  '',
  ' ❯ 1. Yes, and bypass permissions',
  '   2. Yes, manually approve edits',
  '   3. No, refine with Ultraplan on Claude Code on the web',
  '   4. Tell Claude what to change',
  '      shift+tab to approve with this feedback',
  '',
  ' ctrl+g to edit in  VS Code  · ~/.claude/plans/x.md',
].join('\n');

test('parseDialogPrompt: extracts the plan-approval question + 4 options from the real pane', async () => {
  const { parseDialogPrompt } = await import('../terminal/cc');
  const d = parseDialogPrompt(PLAN_DIALOG_PANE)!;
  assert.ok(d, 'dialog parsed');
  assert.match(d.question, /ready to execute. Would you like to proceed\?$/);
  assert.deepEqual(d.options.map((o) => o.label), [
    'Yes, and bypass permissions',
    'Yes, manually approve edits',
    'No, refine with Ultraplan on Claude Code on the web',
    'Tell Claude what to change',
  ]);
  assert.equal(parseDialogPrompt('no dialog here\njust text'), null);
});

test('paneLooksStuck: only borders/blank = stuck; any real content = healthy', async () => {
  const { paneLooksStuck } = await import('../terminal/cc');
  assert.equal(paneLooksStuck('──\n──\n──\n'), true);       // the stale-paint case
  assert.equal(paneLooksStuck('   \n\n  \n'), true);        // blank
  assert.equal(paneLooksStuck(''), true);
  assert.equal(paneLooksStuck('❯ \n─── Mission: X ───\n'), false); // idle prompt present
  assert.equal(paneLooksStuck('no worktrees ctx:34% sid: 750fd632'), false); // footer present
});
