import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_CONNECTOR_HANDLERS } from '../mcp-server/tools/refresh-connector';

const realFetch = global.fetch;
const calls: Array<{ method: string; url: string }> = [];

function stub(routes: (url: string, method: string) => unknown): void {
  // @ts-expect-error test stub
  global.fetch = async (url: string, opts?: { method?: string }) => {
    const method = opts?.method || 'GET';
    calls.push({ method, url: String(url) });
    const data = routes(String(url), method);
    const env = { success: true, data };
    const text = JSON.stringify(env);
    return { ok: true, status: 200, async text() { return text; }, async json() { return env; } };
  };
}

afterEach(() => { global.fetch = realFetch; calls.length = 0; });

const SERVERS = [
  { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Google Drive', url: 'https://mcp.google.com', connected: true },
  { uuid: '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2', name: 'lm-assist langmart', url: 'https://mcp.langmart.ai/mcp', connected: true },
];

test('refresh_connector_tools: auto-finds the langmart connector and clears its cache', async () => {
  stub((url) => (url.includes('/mcp/servers') && !url.includes('clear-cache') ? { servers: SERVERS } : { cleared: true }));
  const res = await REFRESH_CONNECTOR_HANDLERS.refresh_connector_tools({});
  assert.notEqual(res.isError, true);
  const cc = calls.find((c) => c.url.includes('clear-cache'));
  assert.ok(cc, 'clear-cache was called');
  assert.match(cc!.url, /8f61a74e-9d48-44b6-9ba0-a8d4873a86c2\/clear-cache/);
  assert.equal(cc!.method, 'POST');
  assert.match(res.content[0].text, /langmart/i);
});

test('refresh_connector_tools: an explicit server_uuid skips discovery', async () => {
  stub(() => ({ cleared: true }));
  const res = await REFRESH_CONNECTOR_HANDLERS.refresh_connector_tools({ server_uuid: '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2' });
  assert.notEqual(res.isError, true);
  assert.ok(!calls.some((c) => c.url.includes('/mcp/servers') && !c.url.includes('clear-cache')), 'no list call when uuid given');
  assert.ok(calls.some((c) => c.url.includes('clear-cache') && c.method === 'POST'));
});

test('refresh_connector_tools: clear error when no connectors exist', async () => {
  stub(() => ({ servers: [] }));
  const res = await REFRESH_CONNECTOR_HANDLERS.refresh_connector_tools({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no .*connector/i);
});

test('set_connector_tool_access: blocks tools via the tool-access route', async () => {
  const bodies: Record<string, unknown>[] = [];
  // @ts-expect-error stub
  global.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
    calls.push({ method: opts?.method || 'GET', url: String(url) });
    if (opts?.body) bodies.push(JSON.parse(opts.body));
    const data = String(url).includes('/tool-access') ? { changed: { 'x:agent_execute': false }, totalTools: 5 } : { servers: SERVERS };
    const env = { success: true, data };
    const text = JSON.stringify(env);
    return { ok: true, status: 200, async text() { return text; }, async json() { return env; } };
  };
  const res = await REFRESH_CONNECTOR_HANDLERS.set_connector_tool_access({ block: ['agent_execute', 'browser_task'] });
  assert.notEqual(res.isError, true);
  const ta = calls.find((c) => c.url.includes('/tool-access'));
  assert.ok(ta && ta.method === 'POST', 'tool-access POSTed');
  assert.match(ta!.url, /8f61a74e-9d48-44b6-9ba0-a8d4873a86c2\/tool-access/, 'auto-targeted langmart');
  const body = bodies.find((b) => Array.isArray((b as any).block));
  assert.deepEqual((body as any).block, ['agent_execute', 'browser_task']);
});

test('set_connector_tool_access: requires at least one tool', async () => {
  stub(() => ({ servers: SERVERS }));
  const res = await REFRESH_CONNECTOR_HANDLERS.set_connector_tool_access({});
  assert.equal(res.isError, true);
});

test('list_claudeai_connectors: lists each connector with uuid + tool count', async () => {
  stub(() => ({ servers: SERVERS.map((s) => ({ ...s, authStatus: 'authenticated', toolCount: 5 })) }));
  const res = await REFRESH_CONNECTOR_HANDLERS.list_claudeai_connectors({});
  const t = res.content[0].text;
  assert.notEqual(res.isError, true);
  assert.match(t, /Google Drive/);
  assert.match(t, /lm-assist langmart/);
  assert.match(t, /8f61a74e-9d48-44b6-9ba0-a8d4873a86c2/);
  assert.match(t, /5 tools/);
});

test('refresh_connector_tools: connector="drive" targets the Google Drive connector', async () => {
  stub((url) => (url.includes('/mcp/servers') && !url.includes('clear-cache') ? { servers: SERVERS } : { cleared: true }));
  const res = await REFRESH_CONNECTOR_HANDLERS.refresh_connector_tools({ connector: 'drive' });
  assert.notEqual(res.isError, true);
  const cc = calls.find((c) => c.url.includes('clear-cache'));
  assert.match(cc!.url, /aaaaaaaa-0000-4000-8000-000000000001\/clear-cache/, 'targeted Google Drive by name');
});

test('set_connector_tool_access: ambiguous connector match errors with options', async () => {
  stub(() => ({ servers: SERVERS }));
  // "a" matches both "Google Drive"(url mcp.google) ? no — match name/url substring "lm" matches langmart only.
  const res = await REFRESH_CONNECTOR_HANDLERS.set_connector_tool_access({ connector: 'mcp', block: ['detail'] });
  assert.equal(res.isError, true, '"mcp" appears in both urls -> ambiguous');
  assert.match(res.content[0].text, /matches 2|more specific/i);
});
