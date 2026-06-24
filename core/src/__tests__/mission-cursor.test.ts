import { test } from 'node:test';
import assert from 'node:assert';
import { computeNewOutput } from '../mission/mission-controller';

test('computeNewOutput: fresh messages from cursor 0', () => {
  const r = computeNewOutput([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 0);
  assert.strictEqual(r.cursor, 3);
  assert.deepStrictEqual(r.newOutput?.messages, ['a', 'b', 'c']);
});
test('computeNewOutput: detects new output PAST the old 20 cap (regression)', () => {
  const msgs = Array.from({ length: 25 }, (_, i) => ({ text: 'm' + i }));
  const r = computeNewOutput(msgs, 20);
  assert.strictEqual(r.cursor, 25);
  assert.strictEqual(r.newOutput?.messages.length, 5);
  assert.strictEqual(r.newOutput?.messages[0], 'm20');
});
test('computeNewOutput: no new output when cursor unchanged', () => {
  const msgs = Array.from({ length: 25 }, (_, i) => ({ text: 'm' + i }));
  assert.strictEqual(computeNewOutput(msgs, 25).newOutput, null);
});
