import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudSessionWebUrl,
  isCloudSid,
  buildCreateBody,
  buildDriveEvent,
  parseTeleportTranscript,
} from '../terminal/ccr-cloud';

test('cloudSessionWebUrl: maps sid to the claude.ai/code URL', () => {
  assert.equal(cloudSessionWebUrl('session_01Epb79wZY8Xg7AMpKoxrZdo'), 'https://claude.ai/code/session_01Epb79wZY8Xg7AMpKoxrZdo');
});

test('isCloudSid: only session_… ids', () => {
  assert.equal(isCloudSid('session_01Epb79wZY8Xg7AMpKoxrZdo'), true);
  assert.equal(isCloudSid('cse_01abc'), false);
  assert.equal(isCloudSid('session_'), false);
  assert.equal(isCloudSid(''), false);
  assert.equal(isCloudSid(undefined), false);
});

test('buildCreateBody: initial user turn is a wrapped event with seed + env + model', () => {
  const b = buildCreateBody({ prompt: 'hello', model: 'claude-opus-4-8[1m]', seedFileId: 'file_x', environmentId: 'env_y', title: 'T' });
  assert.equal(b.title, 'T');
  assert.equal(b.environment_id, 'env_y');
  assert.equal(b.session_context.seed_bundle_file_id, 'file_x');
  assert.equal(b.session_context.model, 'claude-opus-4-8[1m]');
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].type, 'event');
  assert.equal(b.events[0].data.type, 'user');
  assert.equal(b.events[0].data.message.content, 'hello');
  assert.equal(b.events[0].data.session_id, ''); // empty on create
});

test('buildDriveEvent: follow-up event is unwrapped and carries the sid', () => {
  const e = buildDriveEvent('session_x', 'next', 'fixed');
  assert.deepEqual(e, {
    uuid: 'fixed',
    session_id: 'session_x',
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'next' },
  });
});

test('parseTeleportTranscript: extracts role + text + tool names, skips non-message events', () => {
  const body = {
    data: [
      { event_type: 'user', payload: { message: { role: 'user', content: 'hi' } } },
      { event_type: 'assistant', payload: { message: { role: 'assistant', content: [
        { type: 'text', text: 'hello ' },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'text', text: 'world' },
      ] } } },
      { event_type: 'system', payload: { subtype: 'task_started' } }, // skipped
    ],
  };
  const msgs = parseTeleportTranscript(body);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { role: 'user', type: 'user', text: 'hi' });
  assert.equal(msgs[1].text, 'hello world');
  assert.deepEqual(msgs[1].tools, ['Bash']);
});

test('parseTeleportTranscript: tolerates missing/empty data', () => {
  assert.deepEqual(parseTeleportTranscript(null), []);
  assert.deepEqual(parseTeleportTranscript({}), []);
  assert.deepEqual(parseTeleportTranscript({ data: [] }), []);
});
