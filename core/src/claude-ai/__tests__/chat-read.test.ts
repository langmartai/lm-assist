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

test('extracts image file refs from a tool_result and keeps result text clean', () => {
  // Real shape from a get_view_image turn (2026-07-21): claude.ai re-hosts the
  // MCP image block as {type:'image', file_uuid} inside tool_result content.
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'tool_use', id: 'img1', name: 'lm-assist langmart:ext__chart-context__get_view_image', input: { client: 'cabc.t1' } },
      { type: 'tool_result', tool_use_id: 'img1', is_error: false, content: [
        { type: 'image', file_uuid: '33201c04-ded9-4ecd-aef0-6ce6e9efd73e' },
        { type: 'text', text: '{"client":{"clientId":"cabc.t1"},"imageAgeSeconds":12}' },
      ] },
      { type: 'text', text: 'looks choppy' },
    ] },
  ] });
  const call = d[0].toolCalls![0];
  assert.deepEqual(call.images, [{ fileUuid: '33201c04-ded9-4ecd-aef0-6ce6e9efd73e' }]);
  assert.match(call.result as string, /imageAgeSeconds/);
  assert.ok(!(call.result as string).includes('file_uuid'), 'image block must not be stringified into result');
});

test('suppresses successful tool_search meta-calls but keeps errored ones', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'tool_use', id: 's1', name: 'tool_search', input: { query: 'chart' }, result: 'Loaded 2 tools', is_error: false },
      { type: 'tool_use', id: 'r1', name: 'lm-assist langmart:ext__chart-context__get_view_summary', input: {}, result: '{"summary":"..."}', is_error: false },
      { type: 'text', text: 'answer' },
    ] },
    { sender: 'assistant', content: [
      { type: 'tool_use', id: 's2', name: 'tool_search', input: { query: 'x' }, result: 'catalog down', is_error: true },
      { type: 'text', text: 'hmm' },
    ] },
  ] });
  assert.equal(d[0].toolCalls?.length, 1);
  assert.match(d[0].toolCalls![0].name, /get_view_summary/);
  // errored tool_search stays visible
  assert.equal(d[1].toolCalls?.length, 1);
  assert.equal(d[1].toolCalls![0].name, 'tool_search');
  assert.equal(d[1].toolCalls![0].isError, true);
});

test('drops a message left empty after tool_search suppression', () => {
  const d = parseChatMessages({ chat_messages: [
    { sender: 'assistant', content: [
      { type: 'tool_use', id: 'only', name: 'tool_search', input: { query: 'q' }, result: 'ok', is_error: false },
    ] },
    { sender: 'assistant', content: [{ type: 'text', text: 'real answer' }] },
  ] });
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'real answer');
});
