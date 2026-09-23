/**
 * Driven approvals on the CHROME transport pick the key of the connector a tool_use names.
 *
 * The in-page snippet (claudeai-via-chrome.ts) used one flat tool → key map, so with two lm-assist
 * connectors sharing a tool name (one per profile) the key of whichever connector came last in
 * enabled_mcp_tools answered for both. The snippet now carries APPROVAL_SELECT_JS, a mirror of the
 * cookie transport's indexApprovalKeys + selectApprovalKey, plus a name → uuid map built in Core.
 *
 *  1. parity: the in-page code and selectApprovalKey agree on every input below;
 *  2. approvalConnectorMap merges the roster with the turn's own tools array, skipping junk;
 *  3. the GENERATED snippet, run end to end against a stubbed claude.ai (no network), approves
 *     each tool_use with its own connector's key — and sends nothing for a tool whose named
 *     connector holds no key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { indexApprovalKeys, selectApprovalKey } from '../utils/claudeai-session';
import { APPROVAL_SELECT_JS, approvalConnectorMap, snippetSendMessage } from '../utils/claudeai-via-chrome';

const A = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2'; // "lm-assist langmart"
const B = '3b3b3b3b-0000-4000-8000-00000000000b'; // "lm-assist langmart basic"
const H1 = 'a'.repeat(32);
const H2 = 'b'.repeat(32);
const PLUGIN = 'ext__demo-plugin__alerts_list';
const ORG = '11111111-2222-4333-8444-555555555555';
const CONV = '66666666-7777-4888-9999-aaaaaaaaaaaa';

// B written LAST — the old flat in-page map answered with B for every connector.
const SETTINGS: Record<string, boolean> = {
  search: true, // legacy uuid-less key: ignored
  [`${A}:search`]: true,
  [`${A}:search-${H1}`]: true,
  [`${B}:search`]: true,
  [`${B}:search-${H2}`]: true,
  [`${B}:${PLUGIN}`]: true,
};
const NAMES = { 'lm-assist langmart': A, 'lm-assist langmart basic': B };

type Picked = { key?: string; bare?: string };
const inPage = new Function(`${APPROVAL_SELECT_JS}\nreturn { lmApprovalIndex, lmSelectApprovalKey };`)() as {
  lmApprovalIndex: (emt: Record<string, unknown>) => unknown;
  lmSelectApprovalKey: (idx: unknown, uuidByName: Record<string, string>, toolName: string) => Picked;
};
const norm = (p: Picked): Picked => ({ key: p.key || undefined, bare: p.bare || undefined });

test('the in-page selector agrees with selectApprovalKey on every case', () => {
  const settingsCases: Array<Record<string, boolean>> = [
    SETTINGS,
    { [`${A}:search-${H1}`]: true, [`${B}:search`]: true }, // A has only the hash key
    {}, // nothing indexed
  ];
  const names = [
    'lm-assist langmart:search', 'lm-assist langmart basic:search', 'LM-Assist Langmart:search',
    'search', 'someone else:search', `lm-assist langmart:${PLUGIN}`, `lm-assist langmart basic:${PLUGIN}`,
    'lm-assist langmart:tool_search', 'tool_search', 'constructor:search', `${PLUGIN}`,
  ];
  for (const settings of settingsCases) {
    const entry = { ...indexApprovalKeys(settings), uuidByName: NAMES };
    const idx = inPage.lmApprovalIndex(settings);
    for (const n of names) {
      assert.deepEqual(norm(inPage.lmSelectApprovalKey(idx, NAMES, n)), norm(selectApprovalKey(entry, n)), `${n} over ${Object.keys(settings).length} keys`);
    }
  }
});

test("the in-page selector answers each connector with its OWN key and never borrows one", () => {
  const idx = inPage.lmApprovalIndex(SETTINGS);
  assert.equal(inPage.lmSelectApprovalKey(idx, NAMES, 'lm-assist langmart:search').key, `${A}:search-${H1}`);
  assert.equal(inPage.lmSelectApprovalKey(idx, NAMES, 'lm-assist langmart basic:search').key, `${B}:search-${H2}`);
  assert.equal(inPage.lmSelectApprovalKey(idx, NAMES, `lm-assist langmart basic:${PLUGIN}`).key, `${B}:${PLUGIN}`, 'hyphenated plugin names are indexed');
  assert.equal(inPage.lmSelectApprovalKey(idx, NAMES, `lm-assist langmart:${PLUGIN}`).key, undefined, "A's tool_use never gets B's key");
});

test('approvalConnectorMap merges the roster with the tools array and skips junk', () => {
  const tools = [
    { name: 'search', integration_name: 'LM-Assist Langmart Basic ', mcp_server_uuid: B.toUpperCase() },
    { name: 'x', integration_name: 'evil', mcp_server_uuid: '"; alert(1); "' },
    { name: 'y', integration_name: 42, mcp_server_uuid: A },
    null,
    'nope',
  ];
  assert.deepEqual(approvalConnectorMap(tools, { 'lm-assist langmart': A }), {
    'lm-assist langmart': A,
    'lm-assist langmart basic': B,
  });
  assert.deepEqual(approvalConnectorMap(undefined, undefined), {});
});

/** Run the generated snippet in a fresh context against a stubbed claude.ai. */
async function runSnippet(snippet: string, sse: string): Promise<{ result: any; approvalBodies: any[] }> {
  const approvalBodies: any[] = [];
  const conversation = {
    current_leaf_message_uuid: '00000000-0000-4000-8000-000000000001',
    settings: { enabled_mcp_tools: SETTINGS },
    chat_messages: [{ sender: 'assistant', stop_reason: 'end_turn', content: [{ type: 'tool_result' }, { type: 'text', text: 'done' }] }],
  };
  const bytes = new TextEncoder().encode(sse);
  const fetchStub = async (url: string, init: { method?: string; body?: string } = {}) => {
    if (url.endsWith('/tool_approval')) {
      approvalBodies.push(JSON.parse(String(init.body)));
      return { status: 200 };
    }
    if (url.endsWith('/completion')) {
      let sent = false;
      return {
        ok: true, status: 200, statusText: 'OK',
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })) }) },
      };
    }
    if (url.includes(`/chat_conversations/${CONV}?`)) return { ok: true, status: 200, json: async () => conversation };
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctx = vm.createContext({
    document: { cookie: `lastActiveOrg=${ORG}; anthropic-device-id=dev-1` },
    fetch: fetchStub,
    crypto: { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 0xff; return a; } },
    TextDecoder,
    setTimeout: (fn: () => void) => setImmediate(fn),
  });
  const result = await vm.runInContext(snippet, ctx);
  return { result, approvalBodies };
}

const ev = (type: string, data: unknown): string => `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
function toolUse(index: number, id: string, name: string): string {
  return ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } })
    + ev('content_block_stop', { type: 'content_block_stop', index });
}

test('the GENERATED snippet approves two connectors sharing a tool name, each with its own key', async () => {
  const spaTool = (name: string, integration: string, uuid: string) => ({
    name, description: '', integration_name: integration, mcp_server_uuid: uuid,
    mcp_server_url: 'https://mcp.example.test/mcp', input_schema: { type: 'object' },
  });
  const { snippet } = snippetSendMessage(CONV, 'hi', {
    autoApproveTools: true,
    tools: [
      spaTool('search', 'lm-assist langmart', A),
      spaTool('search', 'lm-assist langmart basic', B),
      spaTool(PLUGIN, 'lm-assist langmart basic', B),
    ],
  });
  assert.ok(snippet.includes(APPROVAL_SELECT_JS), 'the snippet carries the in-page selector verbatim');
  assert.ok(snippet.includes(JSON.stringify({ 'lm-assist langmart': A, 'lm-assist langmart basic': B })), 'and the name → uuid map built in Core');

  const sse = toolUse(0, 'tu_a', 'lm-assist langmart:search')
    + toolUse(1, 'tu_b', 'lm-assist langmart basic:search')
    + toolUse(2, 'tu_p', `lm-assist langmart:${PLUGIN}`); // A named; only B holds the key
  const { result, approvalBodies } = await runSnippet(snippet, sse);

  const byId = Object.fromEntries(approvalBodies.map((b) => [b.tool_use_id, b.approval_key]));
  assert.equal(byId.tu_a, `${A}:search-${H1}`, "A's tool_use goes out with A's key");
  assert.equal(byId.tu_b, `${B}:search-${H2}`, "B's tool_use goes out with B's key");
  assert.equal(byId.tu_p, undefined, "no approval POST with another connector's key");
  assert.equal(approvalBodies.length, 2);
  const synthetic = (result.approvals as any[]).find((a) => a.toolUseId === 'tu_p');
  assert.equal(synthetic?.status, 204, 'reported as not gated, not as a failed approval');
  assert.equal(result.text, 'done', 'the post-approval continuation is merged');
});

test('with a roster from Core and NO tools array, the snippet still selects per connector', async () => {
  const { snippet } = snippetSendMessage(CONV, 'hi', { autoApproveTools: true, approvalConnectors: NAMES });
  const { approvalBodies } = await runSnippet(snippet, toolUse(0, 'tu_a', 'lm-assist langmart:search'));
  assert.deepEqual(approvalBodies.map((b) => b.approval_key), [`${A}:search-${H1}`]);
});
