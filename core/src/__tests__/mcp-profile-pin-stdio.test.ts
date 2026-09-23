/**
 * stdio carries its profile PIN as a process env var (LM_MCP_PROFILE, spec 2026-09-23 §5.2):
 * the stdio server hands it to configureMcpServer, forwards it to Core on every /mcp-call
 * as `x-lm-mcp-profile`, and Core lifts that header into the MCP context, so Core-side
 * handlers (bootstrap, session_status, mcp_profile) and the footer see the same profile.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-stdio-'));
process.env.LM_BOOTSTRAP_GATE = 'off';
delete process.env.LM_MCP_PROFILE;

import { createMcpApiRoutes } from '../routes/core/mcp-api.routes';
import { configureMcpServer, type McpToolDispatcher } from '../mcp-server/configure';
// EXPANDED_HANDLERS is typed with _passthrough's McpToolResult (text required), not
// configure's (text optional) — the probe must use that one or build:test fails.
import type { McpToolResult } from '../mcp-server/tools/_passthrough';
import { resolveEffectiveProfile, PROFILE_PIN_HEADER, PROFILE_PIN_ENV } from '../mcp-server/registry/profiles';
import { currentEffectiveProfile, currentMcpContext, runWithMcpContext } from '../mcp-server/principal-context';
import { EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import type { ParsedRequest } from '../routes/index';

// ── Core side: /mcp-call lifts the forwarded header ──────────────────────────────────

const PROBE = '__profile_pin_probe_stdio__';
EXPANDED_HANDLERS[PROBE] = async (): Promise<McpToolResult> => ({
  content: [{ type: 'text', text: JSON.stringify(currentEffectiveProfile() ?? null) }],
});
after(() => { delete EXPANDED_HANDLERS[PROBE]; });

function mcpCall(headers: Record<string, string | string[]>): Promise<any> {
  const route = createMcpApiRoutes({} as any).find((r) => r.method === 'POST' && '/mcp-call'.match(r.pattern));
  if (!route) throw new Error('no /mcp-call route');
  const req: ParsedRequest = {
    method: 'POST', path: '/mcp-call', params: {}, query: {},
    body: { tool: PROBE, args: {} }, headers, clientIp: '127.0.0.1',
  };
  return route.handler(req, {} as any);
}
/** The probe's JSON is the first line; the origin footer follows it. */
const seenBy = (env: any) => JSON.parse(env.data.content[0].text.split('\n')[0]);

test('/mcp-call lifts a known pin into the MCP context', async () => {
  const env = await mcpCall({ [PROFILE_PIN_HEADER]: 'basic' });
  assert.equal(env.success, true);
  assert.deepEqual(seenBy(env), { name: 'basic', source: 'pin', pin: 'basic' });
});

test('/mcp-call resolves an alias against THIS Core\'s definitions', async () => {
  assert.deepEqual(seenBy(await mcpCall({ [PROFILE_PIN_HEADER]: 'langmart' })), { name: 'platform', source: 'pin', pin: 'langmart' });
});

test('/mcp-call without the header runs under the node default, stated as such', async () => {
  assert.deepEqual(seenBy(await mcpCall({})), { name: 'admin', source: 'node-default' });
});

test('/mcp-call with an unknown pin fails open, flagged', async () => {
  assert.deepEqual(
    seenBy(await mcpCall({ [PROFILE_PIN_HEADER]: 'basci' })),
    { name: 'admin', source: 'node-default', pin: 'basci', unknownPin: true },
  );
});

test('/mcp-call takes the first value of a repeated header', async () => {
  assert.deepEqual(seenBy(await mcpCall({ [PROFILE_PIN_HEADER]: ['extended', 'basic'] })), { name: 'extended', source: 'pin', pin: 'extended' });
});

// ── the shared CallTool seam: a pinned stdio process installs its pin ──────────────────

type Handler = (req?: unknown) => Promise<any>;
function fakeServer(): { server: any; call: (name: string) => Promise<any> } {
  const handlers = new Map<string, Handler>();
  const server = {
    setRequestHandler(schema: any, fn: Handler) {
      handlers.set(schema?.shape?.method?.value ?? String(handlers.size), fn);
    },
  };
  return { server, call: (name) => handlers.get('tools/call')!({ params: { name, arguments: {} } }) };
}
function recordingDispatch(): { seen: any; dispatch: McpToolDispatcher } {
  const rec: { seen: any; dispatch: McpToolDispatcher } = {
    seen: 'not called',
    dispatch: async () => {
      rec.seen = { profile: currentEffectiveProfile(), principal: currentMcpContext()?.principal };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  return rec;
}

test('a pinned stdio server installs its pin as the MCP context for every call', async () => {
  const rec = recordingDispatch();
  const { server, call } = fakeServer();
  configureMcpServer(server, rec.dispatch, undefined, undefined, { profile: resolveEffectiveProfile('basic') });
  await call('search');
  assert.deepEqual(rec.seen, { profile: { name: 'basic', source: 'pin', pin: 'basic' }, principal: { type: 'local' } });
});

test('an existing request context (HTTP) is never replaced', async () => {
  const rec = recordingDispatch();
  const { server, call } = fakeServer();
  configureMcpServer(server, rec.dispatch, undefined, undefined, { profile: resolveEffectiveProfile('basic') });
  await runWithMcpContext({ principal: { type: 'cloud' }, profile: resolveEffectiveProfile('extended') }, () => call('search'));
  assert.deepEqual(rec.seen, { profile: { name: 'extended', source: 'pin', pin: 'extended' }, principal: { type: 'cloud' } });
});

test('an unpinned stdio server installs no context — unchanged from before pins', async () => {
  const rec = recordingDispatch();
  const { server, call } = fakeServer();
  configureMcpServer(server, rec.dispatch);
  await call('search');
  assert.deepEqual(rec.seen, { profile: undefined, principal: undefined });
});

// ── stdio client side: the header rides every /mcp-call ────────────────────────────────

test('api-client sends the pin header only when the process is pinned', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  process.env.API_PORT = String((srv.address() as AddressInfo).port);
  // api-client fixes its Core base URL at load, so it is required only now.
  const { mcpGenericCall, profilePinHeaders } =
    require('../mcp-server/api-client') as typeof import('../mcp-server/api-client');
  try {
    delete process.env[PROFILE_PIN_ENV];
    assert.deepEqual(profilePinHeaders(), {});
    await mcpGenericCall('mcp_profile', {});
    assert.equal(seen[0][PROFILE_PIN_HEADER], undefined, 'unpinned: Core sees exactly the request it saw before pins');

    process.env[PROFILE_PIN_ENV] = 'basic';
    assert.deepEqual(profilePinHeaders(), { [PROFILE_PIN_HEADER]: 'basic' });
    await mcpGenericCall('mcp_profile', {});
    assert.equal(seen[1][PROFILE_PIN_HEADER], 'basic');

    process.env[PROFILE_PIN_ENV] = 'bad\u0001pin';
    assert.deepEqual(profilePinHeaders(), { [PROFILE_PIN_HEADER]: 'bad?pin' },
      'a control char would make fetch throw and fail EVERY forwarded call — sent bounded instead');
  } finally {
    delete process.env[PROFILE_PIN_ENV];
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// ── wiring (the stdio entry cannot be spawned in a test: main() auto-starts Core) ──────

test('wiring — the stdio server reads LM_MCP_PROFILE once and hands it to the instructions AND the filter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'mcp-server', 'index.ts'), 'utf8');
  assert.match(src, /process\.env\[PROFILE_PIN_ENV\]/, 'index.ts must read the pin from PROFILE_PIN_ENV');
  assert.match(src, /getLmAssistInstructions\(PINNED/, 'the instructions must be built for the pinned profile');
  assert.match(src, /getLmAssistInstructions\(PINNED \?\? resolveEffectiveProfile\(undefined\)\)/,
    'unpinned, the instructions must be built for the node default in force — so a narrowed node default gets the profile banner, as HTTP does');
  assert.match(src, /configureMcpServer\([^;]*PINNED \? \{ profile: PINNED \} : undefined/,
    'configureMcpServer must receive the pin, and NOTHING when unpinned (so no MCP context is installed)');
});
