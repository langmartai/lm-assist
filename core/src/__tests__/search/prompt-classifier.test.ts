// core/src/__tests__/search/prompt-classifier.test.ts
// Boilerplate filtering is the highest-leverage part of the prompt index: measured over
// 552 transcripts / 2857 user-channel messages, ~88% were injected rather than typed.
// Every class below was observed in real transcripts on this fleet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPromptForIndex, stripEmbedded } from '../../search/prompt-classifier';

const SYNTHETIC: Array<[string, string]> = [
  ['invariants',        '⟦INVARIANTS — these override anything below and are not editable⟧ never stop'],
  ['core_restart',      '⟦CORE RESTARTED — REATTACH⟧ The lm-assist Core under you restarted'],
  ['envelope',          '⟦CMD cmd-1a2⟧ End your reply with the line DONE'],
  ['controller_pass',   'Run a controller pass now. FIRST call mission_changes — re-establish'],
  ['controller_pass',   'Run a controller pass. New mission mission_abc: make the thing'],
  ['security_review',   'Review this change for security vulnerabilities. Changed files: a.ts'],
  ['interrupt',         '[Request interrupted by user]'],
  ['teammate_message',  'Another Claude session sent a message: <teammate-message team="x">hi</teammate-message>'],
  ['skill_preamble',    'Base directory for this skill: /home/ubuntu/.claude/plugins/foo'],
  ['worker_preamble',   '# Worker preamble — lm-finance-entity-person You are a researcher'],
  ['worker_preamble',   'You are the executor (worker) for mission mission_9f'],
  ['compaction',        'This session is being continued from a previous conversation that ran out'],
  ['command_wrapper',   '<command-name>/compact</command-name>'],
  ['hook_feedback',     'Stop hook feedback:\n- the thing failed'],
  ['system_reminder',   '<system-reminder>The user named this session "x"</system-reminder>'],
  ['bootstrap',         '[lm-assist bootstrap] FIRST — before your task — make sure lm-assist'],
  ['task_notification', '<task-notification><task-id>a3496b8877a4</task-id> done</task-notification>'],
  ['banner',            '════════════════════════════ SECTION ════════════════════════════'],
];

for (const [cls, text] of SYNTHETIC) {
  test(`classifies ${cls} as synthetic: ${text.slice(0, 40)}…`, () => {
    const r = classifyPromptForIndex(text);
    assert.equal(r.synthetic, true, `expected synthetic, got class=${r.promptClass}`);
    assert.equal(r.promptClass, cls);
  });
}

test('task-notification is caught by SHAPE, not by repetition', () => {
  // Each of these embeds a unique id, so no two are byte-equal — a frequency scan over
  // prompt prefixes cannot see them at all. They only surfaced by inspecting indexed
  // output, which is why the rule keys on the opening tag.
  for (const id of ['a3496b8877a4a035f', 'ffffffffffffffff', '0000']) {
    const r = classifyPromptForIndex(`<task-notification> <task-id>${id}</task-id> <tool-use-id>toolu_01</tool-use-id>`);
    assert.equal(r.promptClass, 'task_notification');
  }
});

test('real operator prompts survive', () => {
  for (const text of [
    'check why https://langmart.ai/welcome returns Invalid model identifier',
    'Build a WeChat web client mirroring the existing WhatsApp web client',
    'index every session user prompt in sqlite fts and make it the preferred path',
  ]) {
    const r = classifyPromptForIndex(text);
    assert.equal(r.synthetic, false, `real prompt misclassified as ${r.promptClass}: ${text}`);
    assert.equal(r.promptClass, 'user');
    assert.ok(r.indexText.length > 0);
  }
});

test('short filler is synthetic — bm25 rewards brevity, so "Go" would outrank paragraphs', () => {
  for (const t of ['Go', 'continue', 'ok', 'Warmup', 'Continue from where you left off.']) {
    assert.equal(classifyPromptForIndex(t).synthetic, true, `${t} should be filler`);
  }
});

test('a prompt that only begins with a filler word is still real', () => {
  // The filler list is exact-match for exactly this reason.
  const r = classifyPromptForIndex('continue the WeChat client and wire up the message poller');
  assert.equal(r.synthetic, false);
});

test('injected blocks riding inside a real prompt are stripped from the indexed text', () => {
  const r = classifyPromptForIndex('fix the login redirect<system-reminder>session named alpha-beta</system-reminder>');
  assert.equal(r.synthetic, false);
  assert.ok(r.indexText.includes('fix the login redirect'));
  assert.ok(!r.indexText.includes('alpha-beta'), 'reminder text would make every prompt match the session name');
});

test('isMeta wins over the text rules', () => {
  assert.equal(classifyPromptForIndex('looks like an ordinary prompt', true).synthetic, true);
});

test('stripEmbedded removes each injected block type', () => {
  assert.equal(stripEmbedded('a<system-reminder>x</system-reminder>b'), 'a b');
  assert.equal(stripEmbedded('a<task-notification>x</task-notification>b'), 'a b');
  assert.equal(stripEmbedded('a<local-command-stdout>x</local-command-stdout>b'), 'a b');
});
