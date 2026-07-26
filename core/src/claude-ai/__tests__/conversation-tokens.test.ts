import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateConversationTokens,
  messageChars,
  activeBranch,
  CHARS_PER_TOKEN,
  ROOT_PARENT_UUID,
} from '../conversation-tokens';

const ROOT = ROOT_PARENT_UUID;

/** Build a linear conversation: m0 <- m1 <- m2 ... */
function linear(msgs: Array<Record<string, unknown>>): Record<string, unknown> {
  const out = msgs.map((m, i) => ({
    uuid: `m${i}`,
    parent_message_uuid: i === 0 ? ROOT : `m${i - 1}`,
    index: i,
    sender: i % 2 === 0 ? 'human' : 'assistant',
    ...m,
  }));
  return {
    uuid: 'conv-1',
    chat_messages: out,
    current_leaf_message_uuid: `m${out.length - 1}`,
  };
}

// ── block extraction ────────────────────────────────────────────────────────

test('counts text, thinking, tool_use.input and tool_result.content', () => {
  const c = messageChars({
    content: [
      { type: 'text', text: 'abcde' },                       // 5
      { type: 'thinking', thinking: '1234' },                // 4
      { type: 'tool_use', input: { a: 1 } },                 // {"a":1} = 7
      { type: 'tool_result', content: [{ type: 'text', text: 'xyz' }] }, // 3
    ],
  });
  assert.equal(c.text, 5);
  assert.equal(c.thinking, 4);
  assert.equal(c.tool_use, 7);
  assert.equal(c.tool_result, 3);
});

test('IGNORES display_content — it is UI render data, not model input', () => {
  // Measured: display_content was 669 KB of a 1.81 MB record and never identical
  // to content. Counting it roughly doubles the estimate.
  const withDisplay = messageChars({
    content: [{
      type: 'tool_result',
      content: [{ type: 'text', text: 'abc' }],
      display_content: { some: 'x'.repeat(5000) },
    }],
  });
  assert.equal(withDisplay.tool_result, 3, 'display_content must not be counted');
});

test('does NOT read the flat msg.text mirror field', () => {
  // Measured: msg.text was EMPTY on all 62 messages of a real conversation while
  // content[] held 1.8 MB. Trusting msg.text reports ~0 for a full conversation;
  // double-counting it would inflate every message.
  const c = messageChars({ text: 'ZZZZZZZZZZ', content: [{ type: 'text', text: 'abc' }] });
  assert.equal(c.text, 3);
});

test('handles tool_result content as a bare string and as image blocks', () => {
  assert.equal(messageChars({ content: [{ type: 'tool_result', content: 'hello' }] }).tool_result, 5);
  const img = messageChars({
    content: [{ type: 'tool_result', content: [{ type: 'image', file_uuid: 'abc' }] }],
  });
  // an opaque file reference costs its own JSON, not image bytes
  assert.ok(img.tool_result > 0 && img.tool_result < 200);
});

test('counts an inline tool result on a tool_use block (render_all_tools=true)', () => {
  const c = messageChars({ content: [{ type: 'tool_use', input: {}, result: 'abcdefgh' }] });
  assert.equal(c.tool_result, 8);
});

test('tolerates content as a bare string and unknown block types', () => {
  assert.equal(messageChars({ content: 'hello' }).text, 5);
  assert.equal(messageChars({ content: [{ type: 'future_block', x: 1 }] }).text, 0);
  assert.deepEqual(messageChars(null), { text: 0, thinking: 0, tool_use: 0, tool_result: 0 });
});

// ── tree walking ────────────────────────────────────────────────────────────

test('walks only the ACTIVE branch — dead branches are not in context', () => {
  // Measured: 10 of 62 messages sat on dead (edited/retried) branches.
  const body = {
    uuid: 'c',
    current_leaf_message_uuid: 'b2',
    chat_messages: [
      { uuid: 'a', parent_message_uuid: ROOT, content: [{ type: 'text', text: 'aa' }] },
      { uuid: 'b1', parent_message_uuid: 'a', content: [{ type: 'text', text: 'DEADBRANCH' }] },
      { uuid: 'b2', parent_message_uuid: 'a', content: [{ type: 'text', text: 'bb' }] },
    ],
  };
  const chain = activeBranch(body);
  assert.deepEqual(chain.map((m) => m.uuid), ['a', 'b2'], 'root-first, dead branch excluded');

  const est = estimateConversationTokens(body);
  assert.equal(est.messages.total, 3);
  assert.equal(est.messages.onActiveBranch, 2);
  assert.equal(est.messages.offBranch, 1);
  assert.equal(est.chars.total, 4, 'DEADBRANCH must not be counted');
});

test('falls back to all messages when the leaf pointer is missing', () => {
  // A partial walk must never silently report a fraction of the conversation.
  const body = {
    uuid: 'c',
    chat_messages: [
      { uuid: 'a', parent_message_uuid: ROOT, index: 0, content: [{ type: 'text', text: 'aa' }] },
      { uuid: 'b', parent_message_uuid: 'a', index: 1, content: [{ type: 'text', text: 'bb' }] },
    ],
  };
  assert.equal(activeBranch(body).length, 2);
  assert.equal(estimateConversationTokens(body).chars.total, 4);
});

test('a parent cycle terminates instead of hanging', () => {
  const body = {
    uuid: 'c',
    current_leaf_message_uuid: 'x',
    chat_messages: [
      { uuid: 'x', parent_message_uuid: 'y', content: [{ type: 'text', text: 'aa' }] },
      { uuid: 'y', parent_message_uuid: 'x', content: [{ type: 'text', text: 'bb' }] },
    ],
  };
  const chain = activeBranch(body);
  assert.ok(chain.length <= 2);
});

test('empty / malformed bodies do not throw', () => {
  for (const b of [null, undefined, {}, { chat_messages: 'nope' }]) {
    const e = estimateConversationTokens(b as unknown);
    assert.equal(e.liveTokens, 0);
    assert.equal(e.confidence, 'low');
  }
});

// ── compaction: the load-bearing behaviour ──────────────────────────────────

test('COMPACTION: live window = surviving summary + messages after it', () => {
  // claude.ai's own note: "This conversation was successfully compacted to free
  // up space in the context window. This is a summary of the content that was
  // discussed prior to compaction." So earlier turns leave the context.
  const body = linear([
    { content: [{ type: 'text', text: 'A'.repeat(1000) }] },
    { content: [{ type: 'text', text: 'B'.repeat(1000) }] },
    {
      content: [{ type: 'text', text: 'C'.repeat(1000) }],
      compaction_summary: [{ type: 'text', text: 'S'.repeat(100) }],
    },
    { content: [{ type: 'text', text: 'D'.repeat(500) }] },
  ]);
  const est = estimateConversationTokens(body);

  assert.equal(est.compaction.compacted, true);
  assert.equal(est.compaction.events, 1);
  // live = summary(100) + only what came AFTER the compacted message (500)
  assert.equal(est.chars.live, 600);
  assert.equal(est.chars.total, 3500);
  assert.ok(est.liveTokens < est.totalTokens, 'live must be below total after compaction');
  assert.equal(est.messages.compactedAway, 3);
  assert.equal(est.messages.live, 1);
});

test('COMPACTION: the LAST summary wins when several exist', () => {
  // Measured: 5 compaction events on one conversation, each summarising
  // everything before it. Only the most recent survives in context.
  const body = linear([
    { content: [{ type: 'text', text: 'A'.repeat(900) }], compaction_summary: [{ type: 'text', text: 'S1'.repeat(10) }] },
    { content: [{ type: 'text', text: 'B'.repeat(900) }] },
    { content: [{ type: 'text', text: 'C'.repeat(900) }], compaction_summary: [{ type: 'text', text: 'X'.repeat(50) }] },
    { content: [{ type: 'text', text: 'D'.repeat(200) }] },
  ]);
  const est = estimateConversationTokens(body);
  assert.equal(est.compaction.events, 2);
  assert.equal(est.chars.live, 250, 'second summary (50) + trailing message (200)');
  assert.equal(est.messages.compactedAway, 3);
});

test('an UNCOMPACTED conversation reports live == total and high confidence', () => {
  const body = linear([
    { content: [{ type: 'text', text: 'A'.repeat(400) }] },
    { content: [{ type: 'text', text: 'B'.repeat(400) }] },
  ]);
  const est = estimateConversationTokens(body);
  assert.equal(est.chars.live, est.chars.total);
  assert.equal(est.liveTokens, est.totalTokens);
  assert.equal(est.compaction.compacted, false);
  assert.equal(est.confidence, 'high');
});

test('a compacted conversation can never claim HIGH confidence', () => {
  const body = linear([
    { content: [{ type: 'text', text: 'A'.repeat(400) }], compaction_summary: [{ type: 'text', text: 'S' }] },
    { content: [{ type: 'text', text: 'B'.repeat(400) }] },
  ]);
  const est = estimateConversationTokens(body);
  assert.equal(est.confidence, 'medium');
  assert.ok(
    est.unmeasured.some((u) => /compaction/i.test(u)),
    'the compaction assumption must be declared in unmeasured[]',
  );
});

// ── token conversion ────────────────────────────────────────────────────────

test('uses per-class chars/token ratios, not one flat ratio', () => {
  // Calibrated against /v1/messages/count_tokens on real blocks: tool_result is
  // the densest class (2.834) and dominates operational chats; a flat 4.0 would
  // under-count it by ~30%.
  const n = 10000;
  const asText = estimateConversationTokens(linear([{ content: [{ type: 'text', text: 'x'.repeat(n) }] }]));
  const asResult = estimateConversationTokens(
    linear([{ content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x'.repeat(n) }] }] }]),
  );
  assert.equal(asText.liveTokens, Math.round(n / CHARS_PER_TOKEN.text));
  assert.equal(asResult.liveTokens, Math.round(n / CHARS_PER_TOKEN.tool_result));
  assert.ok(asResult.liveTokens > asText.liveTokens, 'tool_result packs more tokens per char');
});

test('breakdown sums to liveTokens and reflects the live window only', () => {
  const body = linear([
    { content: [{ type: 'text', text: 'A'.repeat(1000) }] },
    {
      content: [{ type: 'tool_use', input: { q: 'z'.repeat(100) } }],
      compaction_summary: [{ type: 'text', text: 'S'.repeat(80) }],
    },
    { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'R'.repeat(600) }] }] },
  ]);
  const est = estimateConversationTokens(body);
  const sum = est.breakdown.text + est.breakdown.thinking + est.breakdown.tool_use + est.breakdown.tool_result;
  assert.equal(sum, est.liveTokens);
  assert.equal(est.breakdown.tool_use, 0, 'pre-compaction tool_use is out of the live window');
  assert.ok(est.breakdown.tool_result > 0);
});

test('pctOfCeiling tracks the LIVE window, and the ceiling is declared as assumed', () => {
  const body = linear([{ content: [{ type: 'text', text: 'x'.repeat(40740) }] }]);
  const est = estimateConversationTokens(body, { ceilingTokens: 100000 });
  assert.equal(est.ceilingTokens, 100000);
  assert.equal(est.ceilingSource, 'reported');
  assert.equal(est.pctOfCeiling, 10);

  const dflt = estimateConversationTokens(body);
  assert.equal(dflt.ceilingSource, 'assumed', 'an assumed ceiling must never be presented as fact');
  assert.equal(dflt.ceilingTokens, 1_000_000);
});

test('unmeasured[] names the costs this estimate cannot see', () => {
  const est = estimateConversationTokens(linear([{ content: [{ type: 'text', text: 'hi' }] }]));
  const joined = est.unmeasured.join(' | ').toLowerCase();
  for (const expected of ['system prompt', 'tool schema']) {
    assert.ok(joined.includes(expected), `unmeasured must name: ${expected}`);
  }
});

test('returns NO message content anywhere in the result', () => {
  // The critical design rule: measuring the budget must not consume the budget.
  const secret = 'SUPERSECRETCONTENT';
  const body = linear([
    { content: [{ type: 'text', text: secret }] },
    { content: [{ type: 'tool_result', content: [{ type: 'text', text: secret }] }] },
  ]);
  const est = estimateConversationTokens(body);
  assert.ok(!JSON.stringify(est).includes(secret), 'estimate must never echo conversation content');
});

test('counts stored thinking summaries and declares the hidden remainder', () => {
  // Measured: all 116 thinking blocks on a real conversation had
  // thinking_hidden=true and an EMPTY .thinking body — only summaries survive.
  const c = messageChars({
    content: [{
      type: 'thinking',
      thinking: '',
      thinking_hidden: true,
      summaries: [{ summary: 'abcde' }, { summary: 'fg' }],
    }],
  });
  assert.equal(c.thinking, 7, 'summaries are stored content and must be counted');

  const est = estimateConversationTokens(
    linear([{ content: [{ type: 'thinking', thinking: '', summaries: [{ summary: 'x' }] }] }]),
  );
  assert.ok(
    est.unmeasured.some((u) => /hidden thinking/i.test(u)),
    'the unstored thinking text must be declared, not silently reported as zero',
  );
});
