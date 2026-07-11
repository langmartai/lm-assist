import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoworkEvents } from '../cowork-read';

const EVENTS = {
  data: [
    { event_type: 'user', sequence_num: '1', source: 'client',
      payload: { type: 'user', message: { role: 'user', content: 'write a file then reply DONE' } } },
    { event_type: 'assistant', sequence_num: '2', source: 'worker',
      payload: { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi > /mnt/user-data/outputs/capture.md' } },
      ] } } },
    { event_type: 'system', sequence_num: '3', source: 'worker',
      payload: { type: 'system', subtype: 'task_notification', status: 'completed', output_file: 'capture.md' } },
    { event_type: 'assistant', sequence_num: '4', source: 'worker',
      payload: { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'SendUserMessage', input: { message: 'DONE' } },
      ] } } },
    { event_type: 'active_goal', sequence_num: '5', source: 'worker',
      payload: { type: 'active_goal', steps: [
        { title: 'write file', state: 'completed' }, { title: 'reply', state: 'in_progress' },
      ] } },
  ],
  resume_cursor: 'c5',
};
const SESSION = { post_turn_summary: { status_category: 'review_ready' } };

test('extracts user + assistant(SendUserMessage) messages', () => {
  const d = parseCoworkEvents(EVENTS, SESSION);
  assert.equal(d.messages[0].role, 'user');
  assert.match(d.messages[0].text, /write a file/);
  const reply = d.messages.find((m) => m.role === 'assistant' && m.text === 'DONE');
  assert.ok(reply, 'SendUserMessage reply becomes an assistant text message');
});

test('collects outputs, context, activeGoal, statusCategory', () => {
  const d = parseCoworkEvents(EVENTS, SESSION);
  assert.deepEqual(d.outputs, ['capture.md']);
  assert.ok(d.context.tools.includes('Bash'));
  assert.equal(d.activeGoal.length, 2);
  assert.equal(d.activeGoal[0].status, 'done');
  assert.equal(d.activeGoal[1].status, 'active');
  assert.equal(d.statusCategory, 'review_ready');
});

test('tolerates empty / malformed input', () => {
  assert.deepEqual(parseCoworkEvents(null).messages, []);
  assert.deepEqual(parseCoworkEvents({ data: 'nope' }).outputs, []);
});
