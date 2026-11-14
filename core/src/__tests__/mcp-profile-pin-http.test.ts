/**
 * HTTP /mcp carries a profile PIN in its query (`/mcp?profile=basic`, spec 2026-09-23 §5.2).
 * handleMcpRequest resolves it ONCE and threads it to both consumers: the tools/list filter
 * (via buildServer) and the request context (tool handlers, the footer). Driven through a
 * real http.Server around the real handleMcpRequest + SDK StreamableHTTP transport.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';

// Hermetic, BEFORE any lm-assist import: the node-default profile file and the mcp-calls
// log live under getDataDir(); no plugin subsystem; no bootstrap gate on the probe.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-http-'));
process.env.LM_MCP_PLUGINS = '0';
process.env.LM_BOOTSTRAP_GATE = 'off';

import { handleMcpRequest, parseProfilePin } from '../routes/core/mcp.routes';
import { getLmAssistInstructions, LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
// EXPANDED_HANDLERS is typed with _passthrough's McpToolResult (text required), not
// configure's (text optional) — the probe must use that one or build:test fails.
import type { McpToolResult } from '../mcp-server/tools/_passthrough';
import { applyProfileToToolDefs } from '../mcp-server/registry/profiles';
import { currentEffectiveProfile } from '../mcp-server/principal-context';
import { EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import { _configureFleetPlugins } from '../mcp-server/plugins/fleet-plugins';
import {
  createLiveOverlayProvider, sharedLiveOverlay, _replaceSharedLiveOverlayForTests,
} from '../mcp-server/registry/overlay-live';

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);
const subset = (p: string) => names(applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as Array<{ name: string }>, p));
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pin-test', version: '1' } },
};

// Counts the fleet plugin fan-out (fleetExtToolDefs → deps().localDefs) without a network.
let fleetLocalDefsCalls = 0;
_configureFleetPlugins({
  listNodes: async () => [],
  fetchDefs: async () => ({ tools: [] }),
  postCall: async () => ({}),
  selfNode: () => null,
  localDefs: async () => { fleetLocalDefsCalls++; return []; },
  localCall: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: true }),
  now: () => Date.now(),
});

// A tool that reports the profile its handler SEES — crossing an await first, because the
// context must survive one.
const PROBE = '__profile_pin_probe_http__';
EXPANDED_HANDLERS[PROBE] = async (): Promise<McpToolResult> => {
  await new Promise((r) => setTimeout(r, 15));
  return { content: [{ type: 'text', text: JSON.stringify(currentEffectiveProfile() ?? null) }] };
};
const callProbe = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: PROBE, arguments: {} } });
/** The probe's JSON is the first line; the origin footer follows it. */
const probeSeen = (r: any) => JSON.parse(r.result.content[0].text.split('\n')[0]);

const originalOverlay = sharedLiveOverlay();
let srv: http.Server;
let port = 0;

/** POST one JSON-RPC message; returns the parsed message from the SSE `data:` frame. */
function rpc(pathAndQuery: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathAndQuery, method: 'POST', agent: false,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const line = text.split('\n').find((l) => l.startsWith('data: '));
        try { resolve(JSON.parse(line ? line.slice(6) : text)); }
        catch { reject(new Error(`unparseable ${res.statusCode}: ${text.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

before(async () => {
  _replaceSharedLiveOverlayForTests(createLiveOverlayProvider({ ttlMs: 0, list: async () => [] }));
  srv = http.createServer((req, res) => {
    handleMcpRequest(req, res).catch(() => { try { res.end(); } catch { /* closed */ } });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  port = (srv.address() as AddressInfo).port;
});

after(async () => {
  delete EXPANDED_HANDLERS[PROBE];
  _configureFleetPlugins(null);
  _replaceSharedLiveOverlayForTests(originalOverlay);
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
});

test('parseProfilePin reads ?profile= from a raw req.url', () => {
  assert.equal(parseProfilePin('/mcp?profile=basic'), 'basic');
  assert.equal(parseProfilePin('/mcp?x=1&profile=extended&y=2'), 'extended');
  assert.equal(parseProfilePin('/mcp?profile=%20basic%20'), 'basic');
  assert.equal(parseProfilePin('/mcp?profile=a&profile=b'), 'a', 'the first value wins');
  assert.equal(parseProfilePin('/mcp?profile=Nope'), 'Nope', 'returned as sent — resolution decides what is known');
  for (const none of [undefined, '', '/mcp', '/mcp?', '/mcp?profile=', '/mcp?profile=%20', '/mcp?other=basic']) {
    assert.equal(parseProfilePin(none), undefined, String(none));
  }
});

test('POST /mcp?profile=basic → tools/list is the basic subset, and the plugin fan-out never runs', async () => {
  fleetLocalDefsCalls = 0;
  const r = await rpc('/mcp?profile=basic', LIST);
  assert.deepEqual(names(r.result.tools), subset('basic'));
  assert.equal(fleetLocalDefsCalls, 0);
});

test('POST /mcp with no pin → the full surface, as before pins', async () => {
  fleetLocalDefsCalls = 0;
  const r = await rpc('/mcp', LIST);
  assert.deepEqual(names(r.result.tools), names(LM_ASSIST_TOOL_DEFS));
  assert.ok(fleetLocalDefsCalls >= 1, 'admin can carry plugin tools, so the fleet list is consulted');
});

test('an alias pin serves its target; an unknown pin fails OPEN to the full surface', async () => {
  const alias = await rpc('/mcp?profile=langmart', LIST);
  assert.deepEqual(names(alias.result.tools), subset('platform'));
  const typo = await rpc('/mcp?profile=basci', LIST);
  assert.deepEqual(names(typo.result.tools), names(LM_ASSIST_TOOL_DEFS));
});

test('concurrent tools/list with different pins each get their own surface', async () => {
  const pins = ['basic', 'extended', 'admin', 'basic', 'extended', 'admin'];
  const outs = await Promise.all(pins.map((p) => rpc(`/mcp?profile=${p}`, LIST)));
  outs.forEach((o, i) => assert.deepEqual(names(o.result.tools), subset(pins[i]), `request ${i} (${pins[i]})`));
});

test('initialize without a pin returns the unpinned instructions, byte for byte', async () => {
  const r = await rpc('/mcp', INIT);
  assert.equal(r.result.instructions, getLmAssistInstructions());
});

test('initialize with a pin answers normally', async () => {
  const r = await rpc('/mcp?profile=basic', INIT);
  assert.equal(typeof r.result.instructions, 'string');
  assert.match(r.result.serverInfo.name, /^lm-assist/);
});

test('a tool handler sees its OWN request\'s profile — concurrent pins stay isolated', async () => {
  const pins = ['basic', 'extended', 'platform', 'basic', 'extended', 'platform'];
  const outs = await Promise.all(pins.map((p, i) => rpc(`/mcp?profile=${p}`, callProbe(i + 1))));
  outs.forEach((o, i) => {
    assert.deepEqual(probeSeen(o), { name: pins[i], source: 'pin', pin: pins[i] }, `request ${i} (${pins[i]})`);
  });
});

test('an unpinned call runs under the node default, stated as such', async () => {
  assert.deepEqual(probeSeen(await rpc('/mcp', callProbe(1))), { name: 'admin', source: 'node-default' });
  assert.deepEqual(
    probeSeen(await rpc('/mcp?profile=basci', callProbe(2))),
    { name: 'admin', source: 'node-default', pin: 'basci', unknownPin: true },
  );
});
