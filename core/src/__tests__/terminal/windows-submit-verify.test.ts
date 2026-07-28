/**
 * `submitted` must be observed, not echoed.
 *
 * Real capture from DESKTOP-GDKLATG 2026-07-28, AFTER a send that reported
 * `submitted: true` — the prompt never left the composer and the session stayed
 * idle:
 *
 *   ❯ Reply with exactly this and nothing else: SESSION1_TYPING_WORKS
 *   ───────────────────────────────────────────────────────────────────
 *       C:\home\lm-assist feat/wechat-kf
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { composerHolds } from '../../terminal/windows-submit-verify';

const TEXT = 'Reply with exactly this and nothing else: SESSION1_TYPING_WORKS';

const NOT_SUBMITTED = `
 ▐▛███▜▌   Claude Code v2.1.197
────────────────────────────────────────────────────────────
❯ ${TEXT}
────────────────────────────────────────────────────────────
    C:\\home\\lm-assist feat/wechat-kf
`;

// VERBATIM capture of a SUCCESSFUL submit on DESKTOP-GDKLATG (the model had
// already answered). Note the transcript echo carries the SAME `❯` marker as the
// composer — my first version of this fixture used `>` for the echo, which I made
// up, and it hid a real false-negative: this screen was reported `submitted:false`
// while the round-trip had plainly succeeded. Never invent a fixture you can capture.
const SUBMITTED = `
 ▐▛███▜▌   Claude Code v2.1.197
▝▜█████▛▘  Fable 5 · Claude Max

❯ ${TEXT}

● SESSION1_TYPING_WORKS

✻ Sautéed for 2s

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
    > ${TEXT}
    C:\\home\\lm-assist feat/wechat-kf
`;

test('the exact 107 capture: text still in the composer => NOT submitted', () => {
  assert.equal(composerHolds(NOT_SUBMITTED, TEXT), true);
});

test('after a real submit the composer is empty => submitted', () => {
  assert.equal(composerHolds(SUBMITTED, TEXT), false);
});

test('🔴 the transcript echo uses the SAME ❯ marker and must not read as unsubmitted', () => {
  // The trap that actually bit: after submitting, the prompt appears AGAIN
  // higher up, prefixed with ❯. Only the LAST ❯ line is the live composer.
  assert.ok(SUBMITTED.includes(`❯ ${TEXT}`), 'fixture must keep the ❯-prefixed transcript echo');
  assert.equal(composerHolds(SUBMITTED, TEXT), false);
});

test('a pending prompt BELOW an earlier transcript echo is still detected', () => {
  // Guards the inverse: last-❯-wins must not blind us to a genuine non-submit
  // in a session that already has history.
  const pending = `
❯ an earlier prompt that was submitted

● some earlier answer
────────────────────────────────────────────
❯ ${TEXT}
────────────────────────────────────────────
`;
  assert.equal(composerHolds(pending, TEXT), true);
});

test('wrapped/padded composer text still matches (whitespace-normalized)', () => {
  const wrapped = `❯   Reply with exactly   this and nothing else:  SESSION1_TYPING_WORKS  `;
  assert.equal(composerHolds(wrapped, TEXT), true);
});

test('a DIFFERENT prompt in the composer does not count as ours', () => {
  assert.equal(composerHolds('❯ some other prompt entirely', TEXT), false);
});

test('empty screen / empty text are safe', () => {
  assert.equal(composerHolds('', TEXT), false);
  assert.equal(composerHolds(NOT_SUBMITTED, ''), false);
  assert.equal(composerHolds(NOT_SUBMITTED, '   '), false);
});

test('only the composer line is considered, not any line containing the text', () => {
  const transcriptOnly = `
  > ${TEXT}
    done
`;
  assert.equal(composerHolds(transcriptOnly, TEXT), false);
});

test('a long prompt is matched on its head, which survives wrapping', () => {
  const long = 'A'.repeat(200);
  assert.equal(composerHolds(`❯ ${'A'.repeat(60)}`, long), true);
});
