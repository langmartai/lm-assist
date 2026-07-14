import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMessages } from '../chat-read';

test('extracts user + assistant text turns in order', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'user', content: [{ type: 'text', text: 'hello' }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  ] });
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((m) => m.role), ['user', 'assistant']);
  assert.equal(d[0].text, 'hello');
  assert.equal(d[1].text, 'hi there');
});

test('maps claude.ai sender="human" to a user turn (real API shape)', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'human', content: [{ type: 'text', text: 'Read whatsapp msg from 2422' }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'sure' }] },
  ] });
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((m) => m.role), ['user', 'assistant']);
  assert.equal(d[0].text, 'Read whatsapp msg from 2422');
});

test('captures a thinking block into the assistant turn', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'thinking', thinking: 'let me reason' },
      { type: 'text', text: 'the answer is 4' },
    ] },
  ] });
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'the answer is 4');
  assert.match(d[0].thinking as string, /let me reason/);
});

test('pairs an inline tool_use result (render_all_tools) into a toolCall', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, result: 'file1\nfile2', is_error: false },
      { type: 'text', text: 'done' },
    ] },
  ] });
  assert.equal(d[0].toolCalls?.length, 1);
  assert.equal(d[0].toolCalls![0].name, 'Bash');
  assert.deepEqual(d[0].toolCalls![0].input, { command: 'ls' });
  assert.equal(d[0].toolCalls![0].result, 'file1\nfile2');
  assert.equal(d[0].toolCalls![0].isError, false);
  assert.equal(d[0].text, 'done');
});

test('pairs a separate tool_result block (later message) by tool_use_id', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'Search', input: { q: 'x' } }] },
    { sender: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'result text', is_error: false }] },
    { sender: 'assistant', content: [{ type: 'text', text: 'final' }] },
  ] });
  // the tool_result-only message is dropped; its result attaches to the tool_use turn
  const withTool = d.find((m) => m.toolCalls && m.toolCalls.length);
  assert.ok(withTool);
  assert.equal(withTool!.toolCalls![0].result, 'result text');
  assert.ok(!d.some((m) => m.role === 'user' && !m.text.trim() && !m.toolCalls));
  assert.equal(d[d.length - 1].text, 'final');
});

test('tolerates empty / malformed input', () => {
  assert.deepEqual(parseChatMessages(null), []);
  assert.deepEqual(parseChatMessages({}), []);
  assert.deepEqual(parseChatMessages({ chat_messages: 'nope' }), []);
});
