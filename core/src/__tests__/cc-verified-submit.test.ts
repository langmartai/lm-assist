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
