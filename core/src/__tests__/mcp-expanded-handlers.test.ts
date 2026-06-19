import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import { SESSION_MESSAGING_HANDLERS } from '../mcp-server/tools/session-messaging';

/**
 * Behavioral fixes for MCP tool handlers:
 *  - agent_resume: documented default prompt="continue" must actually be sent.
 *  - agent_execute: a bad `model` must be rejected early with a clear message.
 *  - ccr_connect / windows_terminal_send: a raw envelope with success:false
 *    (e.g. a CONFLICT refusal, or NOT_SUPPORTED) must surface as an isError
 *    result — not be wrapped as success.
 *
 * Handlers call fetch() via _passthrough; we stub global.fetch to capture the
 * outgoing request and feed canned envelopes.
 */

const realFetch = global.fetch;
let lastUrl = '';
let lastBody: Record<string, unknown> | null = null;

function stubFetch(payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  // @ts-expect-error - test stub
  global.fetch = async (url: string, opts?: { body?: string }) => {
    lastUrl = String(url);
    lastBody = opts?.body ? JSON.parse(opts.body) : null;
    const ok = payload.success !== false;
    return {
      ok,
      status: ok ? 200 : 400,
      async text() { return text; },
      async json() { return payload; },
    };
  };
}

afterEach(() => {
  global.fetch = realFetch;
  lastUrl = '';
  lastBody = null;
});

test('agent_resume: omitting prompt sends the documented default "continue"', async () => {
  stubFetch({ success: true, data: { executionId: 'e1', status: 'started' } });
  await EXPANDED_HANDLERS.agent_resume({ session_id: 'abc' });
  assert.ok(lastBody, 'a request was made');
  assert.equal(lastBody!.prompt, 'continue', 'default prompt must be "continue"');
});

test('agent_resume: an explicit prompt is preserved', async () => {
  stubFetch({ success: true, data: {} });
  await EXPANDED_HANDLERS.agent_resume({ session_id: 'abc', prompt: 'do the thing' });
  assert.equal(lastBody!.prompt, 'do the thing');
});

test('agent_execute: a bad model is rejected before any request', async () => {
  stubFetch({ success: true, data: {} });
  const res = await EXPANDED_HANDLERS.agent_execute({ prompt: 'hi', cwd: os.homedir(), model: 'gpt-4' });
  assert.equal(res.isError, true, 'bad model must be an error');
  assert.match(res.content[0].text, /model/i);
  assert.equal(lastBody, null, 'no request should have been made for a bad model');
});

test('agent_execute: a valid shorthand model is accepted', async () => {
  stubFetch({ success: true, data: { executionId: 'e2', status: 'started' } });
  const res = await EXPANDED_HANDLERS.agent_execute({ prompt: 'hi', cwd: os.homedir(), model: 'opus' });
  assert.notEqual(res.isError, true, 'opus must be accepted');
  assert.ok(lastBody, 'a request was made');
  assert.equal(lastBody!.model, 'opus');
});

test('ccr_connect: a success:false CONFLICT envelope surfaces as an isError result', async () => {
  stubFetch({ success: false, error: { code: 'CONFLICT', message: 'a live process owns the session storage' } });
  const res = await EXPANDED_HANDLERS.ccr_connect({ session_id: 'abc' });
  assert.equal(res.isError, true, 'a refusal must be an error, not a success');
  assert.match(res.content[0].text, /live process owns the session/);
});

test('windows_terminal_send: a success:false envelope surfaces as an isError result', async () => {
  stubFetch({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'no such session' } });
  const res = await EXPANDED_HANDLERS.windows_terminal_send({ sessionId: 'nope', text: 'hi' });
  assert.equal(res.isError, true, 'a failed send must be an error');
  assert.match(res.content[0].text, /no such session/);
});

test('get_execution: merges the agent result so a completed run is readable', async () => {
  // Route by URL: the status route omits the agent output; the /result route has it.
  // @ts-expect-error - test stub
  global.fetch = async (url: string) => {
    const u = String(url);
    const payload = u.includes('/result')
      ? { success: true, data: { executionId: 'e1', completed: true, result: 'THE-AGENT-OUTPUT-XYZ' } }
      : { success: true, data: { executionId: 'e1', status: 'completed', isRunning: false } };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, async text() { return text; }, async json() { return payload; } };
  };
  const res = await EXPANDED_HANDLERS.get_execution({ id: 'e1' });
  assert.notEqual(res.isError, true);
  assert.match(res.content[0].text, /THE-AGENT-OUTPUT-XYZ/, 'completed agent output must be included');
});

test('send_session_message: a "pending" (no driver) result is an isError, not silent success', async () => {
  stubFetch({ success: true, data: { id: 'msg-1', status: 'pending', detail: 'no driver delivered — cc-session:unavailable; tmux-send-keys:unavailable' } });
  const res = await SESSION_MESSAGING_HANDLERS.send_session_message({ toSession: 'ghost', category: 'guided', body: 'do X' });
  assert.equal(res.isError, true, 'queued-but-undelivered must be an error');
  assert.match(res.content[0].text, /NOT delivered/i);
  assert.match(res.content[0].text, /msg-1/, 'includes the messageId for follow-up');
});

test('send_session_message: a delivered (received) result is success', async () => {
  stubFetch({ success: true, data: { id: 'msg-2', status: 'received', driver: 'tmux-send-keys', detail: 'delivered' } });
  const res = await SESSION_MESSAGING_HANDLERS.send_session_message({ toSession: 'real', category: 'reference', body: 'fyi' });
  assert.notEqual(res.isError, true, 'a delivered message is success');
});
