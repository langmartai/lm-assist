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

// Real-world shape: the /events endpoint returns events NEWEST-first, tool calls arrive as
// separate assistant events, and each tool_use is followed by a `user` tool_result event.
const REVERSED = {
  data: [
    { event_type: 'assistant', sequence_num: '8', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here are your connectors: [table]' }] } } },
    { event_type: 'user', sequence_num: '7', payload: { type: 'tool_result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'connectors...' }] } } },
    { event_type: 'assistant', sequence_num: '6', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ListConnectors', input: {} }] } } },
    { event_type: 'user', sequence_num: '5', payload: { type: 'tool_result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tools...' }] } } },
    { event_type: 'assistant', sequence_num: '4', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ToolSearch', input: {} }] } } },
    { event_type: 'user', sequence_num: '3', payload: { type: 'user', message: { role: 'user', content: 'List connectors' } } },
    { event_type: 'assistant', sequence_num: '2', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I can help you test.' }] } } },
    { event_type: 'user', sequence_num: '1', payload: { type: 'user', message: { role: 'user', content: 'Test a cowork session' } } },
  ],
};

test('renders chronological order, drops tool_result user turns, groups tools into the assistant turn', () => {
  const d = parseCoworkEvents(REVERSED);
  // chronological, exactly 4 turns (2 user + 2 assistant) — no empty user bubbles, no lone-tool messages
  assert.equal(d.messages.length, 4);
  assert.deepEqual(d.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(d.messages[0].text, 'Test a cowork session');
  assert.equal(d.messages[1].text, 'I can help you test.');
  assert.equal(d.messages[2].text, 'List connectors');
  assert.match(d.messages[3].text, /Here are your connectors/);
  // the two tool calls are grouped into the final assistant turn
  assert.deepEqual(d.messages[3].tools, ['ToolSearch', 'ListConnectors']);
  // no user message is empty
  assert.ok(!d.messages.some((m) => m.role === 'user' && !m.text.trim()));
  // context still records the tools
  assert.ok(d.context.tools.includes('ToolSearch') && d.context.tools.includes('ListConnectors'));
});

test('captures thinking blocks into the assistant turn', () => {
  const d = parseCoworkEvents({ data: [
    { event_type: 'user', sequence_num: '1', payload: { type: 'user', message: { role: 'user', content: 'why is the sky blue?' } } },
    { event_type: 'assistant', sequence_num: '2', payload: { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Rayleigh scattering makes shorter wavelengths scatter more.' },
      { type: 'text', text: 'Because of Rayleigh scattering.' },
    ] } } },
  ] });
  assert.equal(d.messages.length, 2);
  assert.equal(d.messages[1].role, 'assistant');
  assert.equal(d.messages[1].text, 'Because of Rayleigh scattering.');
  assert.match(d.messages[1].thinking as string, /Rayleigh scattering/);
});

test('pairs tool_use with its tool_result into an expandable toolCall (name, input, output)', () => {
  const d = parseCoworkEvents({ data: [
    { event_type: 'user', sequence_num: '1', payload: { type: 'user', message: { role: 'user', content: 'list files' } } },
    { event_type: 'assistant', sequence_num: '2', payload: { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
    ] } } },
    { event_type: 'user', sequence_num: '3', payload: { type: 'tool_result', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'file1\nfile2' },
    ] } } },
    { event_type: 'assistant', sequence_num: '4', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  ] });
  const a = d.messages.find((m) => m.role === 'assistant');
  assert.ok(a?.toolCalls && a.toolCalls.length === 1, 'one tool call captured');
  assert.equal(a!.toolCalls![0].name, 'Bash');
  assert.deepEqual(a!.toolCalls![0].input, { command: 'ls' });
  assert.equal(a!.toolCalls![0].result, 'file1\nfile2');
  assert.equal(a!.toolCalls![0].isError, false);
  assert.equal(a!.text, 'done');
});

// AskUserQuestion → pendingQuestion (the interactive "cloud claude is waiting on you" widget).
const askUse = (id: string, header: string) => ({
  event_type: 'assistant', sequence_num: id, payload: { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ header, question: `Q ${header}?`, options: [{ label: 'A' }, { label: 'B' }] }] } },
  ] } },
});
const answerFor = (seq: string, id: string) => ({
  event_type: 'user', sequence_num: seq, payload: { type: 'tool_result', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: id, is_error: false, content: 'A' },
  ] } },
});

test('surfaces an UNANSWERED AskUserQuestion as pendingQuestion', () => {
  const d = parseCoworkEvents({ data: [
    { event_type: 'user', sequence_num: '1', payload: { type: 'user', message: { role: 'user', content: 'do a thing' } } },
    askUse('q1', 'Framework'),
  ] });
  assert.ok(d.pendingQuestion, 'pending question present while unanswered');
  assert.equal(d.pendingQuestion!.toolUseId, 'q1');
  assert.equal(d.pendingQuestion!.questions[0].header, 'Framework');
  assert.equal(d.pendingQuestion!.questions[0].options!.length, 2);
});

test('clears pendingQuestion once the AskUserQuestion is answered (matching tool_result)', () => {
  const d = parseCoworkEvents({ data: [
    { event_type: 'user', sequence_num: '1', payload: { type: 'user', message: { role: 'user', content: 'do a thing' } } },
    askUse('q1', 'Framework'),
    answerFor('3', 'q1'),
    { event_type: 'assistant', sequence_num: '4', payload: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thanks, continuing' }] } } },
  ] });
  assert.equal(d.pendingQuestion, null, 'answered question is no longer pending');
});

test('with multiple questions, surfaces the LATEST unanswered one (not the oldest)', () => {
  const d = parseCoworkEvents({ data: [
    askUse('q1', 'First'),
    answerFor('2', 'q1'),           // q1 answered
    askUse('q2', 'Second'),          // q2 still pending
  ] });
  assert.ok(d.pendingQuestion, 'a pending question remains');
  assert.equal(d.pendingQuestion!.toolUseId, 'q2');
  assert.equal(d.pendingQuestion!.questions[0].header, 'Second');
});
