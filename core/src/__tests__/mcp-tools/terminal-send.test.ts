import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EXPANDED_HANDLERS, EXPANDED_TOOL_DEFS } from '../../mcp-server/tools/expanded';
import { TOOL_SCOPES, assertScopesCoverTools } from '../../mcp-server/configure';

/**
 * terminal_send — the Linux/tmux counterpart of windows_terminal_send.
 *
 * Before this tool, no MCP surface could press Escape / arrows / Tab in a
 * tmux session (terminal_prompt only types text + Enter), so CC dialogs and
 * menus on Linux were undriveable from the connector. Handler is a thin
 * pass-through to POST /terminal/tmux/:name/send-keys ({text, keys[], enter}).
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
    return { ok: true, status: 200, async text() { return text; }, async json() { return payload; } };
  };
}

afterEach(() => {
  global.fetch = realFetch;
  lastUrl = '';
  lastBody = null;
});

test('terminal_send is registered: def, handler, write scope, scope cover holds', () => {
  const def = EXPANDED_TOOL_DEFS.find((d) => d.name === 'terminal_send');
  assert.ok(def, 'terminal_send def is in EXPANDED_TOOL_DEFS');
  assert.equal(typeof EXPANDED_HANDLERS.terminal_send, 'function');
  assert.equal(TOOL_SCOPES['terminal_send'], 'write');
  assertScopesCoverTools();
});

test('terminal_send posts text + keys + enter to the tmux send-keys route', async () => {
  stubFetch({ success: true, data: { sent: true } });
  const res = await EXPANDED_HANDLERS.terminal_send({ name: 'my sess', text: 'pick', keys: ['Down', 'Enter'], enter: false });
  assert.ok(!res.isError, JSON.stringify(res.content));
  assert.match(lastUrl, /\/terminal\/tmux\/my%20sess\/send-keys$/);
  assert.deepEqual(lastBody, { text: 'pick', keys: ['Down', 'Enter'] });
});

test('terminal_send: keys alone works (the Escape case)', async () => {
  stubFetch({ success: true, data: { sent: true } });
  await EXPANDED_HANDLERS.terminal_send({ name: 's', keys: ['Escape'] });
  assert.deepEqual(lastBody, { keys: ['Escape'] });
});

test('terminal_send: enter alone presses Enter', async () => {
  stubFetch({ success: true, data: { sent: true } });
  await EXPANDED_HANDLERS.terminal_send({ name: 's', enter: true });
  assert.deepEqual(lastBody, { enter: true });
});

test('terminal_send refuses an empty send without making a request', async () => {
  stubFetch({ success: true, data: {} });
  const res = await EXPANDED_HANDLERS.terminal_send({ name: 's' });
  assert.ok(res.isError, 'empty send must be an error');
  assert.equal(lastUrl, '', 'no request was made');
});

test('terminal_send requires name', async () => {
  stubFetch({ success: true, data: {} });
  const res = await EXPANDED_HANDLERS.terminal_send({ keys: ['Escape'] });
  assert.ok(res.isError);
  assert.equal(lastUrl, '');
});
