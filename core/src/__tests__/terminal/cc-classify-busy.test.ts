/**
 * `busy` must mean a turn is IN FLIGHT.
 *
 * The rule used to accept any of `✻`, `✶` or `⏵⏵`. All three survive on a
 * finished screen:
 *   - `✻ Sautéed for 2s`        — the COMPLETED timing summary
 *   - `⏵⏵ bypass permissions on` — a permission MODE indicator
 * so every session that had ever completed a turn classified as permanently
 * busy. Measured on DESKTOP-GDKLATG: a session sat `busy` for 60s+ after its
 * reply had rendered, which made a restart guard refuse forever.
 *
 * Both fixtures below are verbatim captures from that host.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyScreen } from '../../terminal/cc-classify';

/** Verbatim: reply rendered, turn finished, composer empty. */
const DONE_WITH_SUMMARY = `
❯ Remember this codeword for later: PURPLE_OTTER_42. Just reply OK.

● OK. I've noted the codeword.

✻ Sautéed for 2s

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
    C:\\home\\lm-assist feat/wechat-kf
    no worktrees ctx:7% $1.22 ram:382M pid:122948
`;

/** Verbatim: long finished session, permission-mode indicator present. */
const DONE_WITH_BYPASS = `
✔ Goal achieved (10m · 2 turns · 32.2k tokens)

✻ Cooked for 3m 57s

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
    C:\\home\\lm-unified-trade main
    no worktrees ctx:45% $132.79 ram:518M pid:41492
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

/** A genuinely in-flight turn. */
const REALLY_BUSY = `
❯ do the thing

● Working on it…

  ✻ Thinking… (esc to interrupt)
`;

test('🔴 a COMPLETED turn is idle, not busy (✻ heads the summary line)', () => {
  assert.notEqual(classifyScreen(DONE_WITH_SUMMARY).state, 'busy');
});

test('🔴 "⏵⏵ bypass permissions on" is a MODE, not activity', () => {
  assert.notEqual(classifyScreen(DONE_WITH_BYPASS).state, 'busy');
});

test('a turn in flight IS busy — the interrupt affordance is the signal', () => {
  assert.equal(classifyScreen(REALLY_BUSY).state, 'busy');
});

test('"esc to interrupt" alone is sufficient', () => {
  assert.equal(classifyScreen('some output\n  esc to interrupt\n').state, 'busy');
});

test('a finished screen classifies as idle so callers can act on it', () => {
  assert.equal(classifyScreen(DONE_WITH_SUMMARY).state, 'idle');
  assert.equal(classifyScreen(DONE_WITH_BYPASS).state, 'idle');
});
