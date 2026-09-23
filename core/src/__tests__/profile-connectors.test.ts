/**
 * profile-connectors: which claude.ai connectors are THIS node's, and which profile each pins.
 *
 * Identification is by URL against this node's public MCP base. The cases pinned here are the ones
 * the old `/langmart/i` name pick got wrong: several per-profile connectors on one hub, and a dev
 * Core (xeenhub) looking at an account that also holds the production connector.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mcpBase, connectorUrlFor, classifyConnectorUrl, ourConnectors, hubLabelFor,
  connectorNameFor, preferredConnector, refreshUnpinnedConnectors, type OurConnector,
} from '../mcp-server/profile-connectors';

const PROD = 'https://mcp.langmart.ai';
const DEV = 'https://mcp.xeenhub.com';
process.env.MCP_PUBLIC_BASE = PROD;

const NOT_OURS = { ours: false, profile: null };

test('connectorUrlFor builds the unpinned and the pinned URL', () => {
  assert.equal(connectorUrlFor(null, PROD), 'https://mcp.langmart.ai/mcp');
  assert.equal(connectorUrlFor('basic', PROD), 'https://mcp.langmart.ai/mcp/basic');
  assert.equal(connectorUrlFor('basic', `${PROD}/`), 'https://mcp.langmart.ai/mcp/basic', 'no doubled slash');
});

test('classifyConnectorUrl: unpinned, pinned, trailing slash, host case, default port', () => {
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp', PROD), { ours: true, profile: null });
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/', PROD), { ours: true, profile: null });
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/basic', PROD), { ours: true, profile: 'basic' });
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/basic/', PROD), { ours: true, profile: 'basic' });
  assert.deepEqual(classifyConnectorUrl('https://MCP.LangMart.AI/mcp/admin', PROD), { ours: true, profile: 'admin' });
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai:443/mcp', PROD), { ours: true, profile: null });
});

test('classifyConnectorUrl: a well-formed but unknown pin is still ours (the node serves it its default)', () => {
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/nosuch-profile', PROD), { ours: true, profile: 'nosuch-profile' });
});

test('classifyConnectorUrl: not ours', () => {
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp', DEV), NOT_OURS, 'a dev base never claims the prod connector');
  assert.deepEqual(classifyConnectorUrl('https://mcp.xeenhub.com/mcp', PROD), NOT_OURS);
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/connectors', PROD), NOT_OURS, '/mcp/connectors is the hub control plane');
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/Basic', PROD), NOT_OURS, 'the pin grammar is lowercase');
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp/basic/extra', PROD), NOT_OURS);
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcpx', PROD), NOT_OURS);
  assert.deepEqual(classifyConnectorUrl('http://mcp.langmart.ai/mcp', PROD), NOT_OURS, 'scheme must match');
  assert.deepEqual(classifyConnectorUrl('https://drivemcp.googleapis.com/mcp/v1', PROD), NOT_OURS);
  assert.deepEqual(classifyConnectorUrl('not a url', PROD), NOT_OURS);
  assert.deepEqual(classifyConnectorUrl('https://mcp.langmart.ai/mcp', ''), NOT_OURS, 'no hub configured → nothing is ours');
});

test('classifyConnectorUrl honours a base with a path prefix', () => {
  assert.deepEqual(classifyConnectorUrl('https://gw.example.com/lm/mcp/basic', 'https://gw.example.com/lm'), { ours: true, profile: 'basic' });
  assert.deepEqual(classifyConnectorUrl('https://gw.example.com/mcp/basic', 'https://gw.example.com/lm'), NOT_OURS);
});

const SERVERS = [
  { uuid: 'g', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', toolCount: 9 },
  { uuid: 'b', name: 'lm-assist langmart basic', url: 'https://mcp.langmart.ai/mcp/basic', toolCount: 42 },
  { uuid: 'd', name: 'lm-assist dev', url: 'https://mcp.xeenhub.com/mcp', toolCount: 320 },
  { uuid: 'u', name: 'lm-assist langmart', url: 'https://mcp.langmart.ai/mcp', toolCount: 320 },
];

test('ourConnectors returns EVERY connector on this hub, tagged with its profile', () => {
  const mine = ourConnectors(SERVERS, PROD);
  assert.deepEqual(mine.map((c) => [c.uuid, c.profile]), [['b', 'basic'], ['u', null]]);
  assert.equal(mine[0].name, 'lm-assist langmart basic', 'server fields are carried through');
  assert.deepEqual(ourConnectors(SERVERS, DEV).map((c) => c.uuid), ['d']);
});

test('hubLabelFor / connectorNameFor', () => {
  assert.equal(hubLabelFor(PROD), 'langmart');
  assert.equal(hubLabelFor(DEV), 'xeenhub');
  assert.equal(hubLabelFor('http://127.0.0.1:3200'), 'local');
  assert.equal(hubLabelFor('http://localhost:3200'), 'local');
  assert.equal(hubLabelFor(''), 'local');
  assert.equal(connectorNameFor('basic', PROD), 'lm-assist langmart basic');
  assert.equal(connectorNameFor(null, PROD), 'lm-assist langmart');
  assert.equal(connectorNameFor('admin', DEV), 'lm-assist xeenhub admin');
});

test('preferredConnector: unpinned, else admin, else the widest, else the first', () => {
  assert.equal(preferredConnector(ourConnectors(SERVERS, PROD))?.uuid, 'u');
  const pinned: OurConnector[] = [
    { uuid: 'x', profile: 'basic', toolCount: 42 },
    { uuid: 'y', profile: 'extended', toolCount: 168 },
    { uuid: 'z', profile: 'admin', toolCount: 320 },
  ];
  assert.equal(preferredConnector(pinned)?.uuid, 'z');
  assert.equal(preferredConnector(pinned.slice(0, 2))?.uuid, 'y', 'no admin → the widest');
  assert.equal(preferredConnector([{ uuid: 'p', profile: 'basic' }, { uuid: 'q', profile: 'extended' }])?.uuid, 'p', 'no counts → the first');
  assert.equal(preferredConnector([]), undefined);
});

test('mcpBase follows MCP_PUBLIC_BASE and strips a trailing slash', () => {
  try {
    process.env.MCP_PUBLIC_BASE = 'https://mcp.langmart.ai/';
    assert.equal(mcpBase(), PROD);
  } finally {
    process.env.MCP_PUBLIC_BASE = PROD;
  }
});

// ── refreshUnpinnedConnectors ────────────────────────────────────────────────

const U = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2';
const B = '3b3b3b3b-0000-4000-8000-00000000000b';
const D = '4c4c4c4c-0000-4000-8000-00000000000c';
const ROSTER = [
  { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', connected: true },
  { uuid: B, name: 'lm-assist langmart basic', url: `${PROD}/mcp/basic`, connected: true },
  { uuid: D, name: 'lm-assist dev', url: `${DEV}/mcp`, connected: true },
  { uuid: U, name: 'lm-assist langmart', url: `${PROD}/mcp`, connected: true },
];

const realFetch = global.fetch;
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

/** Loopback stub answering in the {success,data|error} envelope Core routes return. */
function stub(route: (url: string, method: string) => { status?: number; data?: unknown; error?: { code: string; message: string } }): void {
  // @ts-expect-error test stub
  global.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
    const method = opts?.method || 'GET';
    calls.push({ method, url: String(url), body: opts?.body ? JSON.parse(opts.body) : undefined });
    const r = route(String(url), method);
    const status = r.status ?? 200;
    const env = r.error ? { success: false, error: r.error } : { success: true, data: r.data ?? {} };
    const text = JSON.stringify(env);
    return { ok: status < 400, status, async text() { return text; }, async json() { return env; } };
  };
}

afterEach(() => { global.fetch = realFetch; calls.length = 0; process.env.MCP_PUBLIC_BASE = PROD; });

test('refreshUnpinnedConnectors clears ONLY the unpinned connector of THIS hub, then re-keys its approvals in one batch', async () => {
  stub((url) => (url.endsWith('/claude-ai/mcp/servers') ? { data: { servers: ROSTER } } : { data: {} }));
  await refreshUnpinnedConnectors();
  const cleared = calls.filter((c) => c.url.endsWith('/clear-cache')).map((c) => c.url);
  assert.equal(cleared.length, 1, 'the pinned basic connector and the dev-hub connector are left alone');
  assert.match(cleared[0], new RegExp(`/claude-ai/mcp/servers/${U}/clear-cache$`));
  const batch = calls.filter((c) => c.url.endsWith('/claude-ai/mcp/tool-settings/batch'));
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0].body, { updates: [{ connectorUuid: U, autoApprove: { enable: true, carryForward: true } }] });
});

test('refreshUnpinnedConnectors defers quietly when this node holds no claude.ai cookie', async () => {
  stub(() => ({ status: 400, error: { code: 'CLAUDEAI_SESSION_NOT_CONFIGURED', message: 'No claude.ai session configured' } }));
  await refreshUnpinnedConnectors();
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing cleared, nothing written');
});

test('refreshUnpinnedConnectors does nothing when only pinned connectors exist', async () => {
  stub((url) => (url.endsWith('/claude-ai/mcp/servers') ? { data: { servers: ROSTER.filter((s) => s.uuid !== U) } } : { data: {} }));
  await refreshUnpinnedConnectors();
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('refreshUnpinnedConnectors never throws — not even when the loopback fetch itself does', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.doesNotReject(refreshUnpinnedConnectors());
});
