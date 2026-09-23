/**
 * tools/list under a profile PIN (spec 2026-09-23-mcp-profile-connectors §3, §5).
 *
 * The effective profile is the pin when present and known, else the node default. The
 * contract no new feature may break: NO pin + the shipped default (`admin`) serves exactly
 * the surface it served before pins existed.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic, BEFORE any lm-assist import: the node-default profile file and the mcp-calls
// log both live under getDataDir(), and mcp-logger fixes its log path at module load.
// (The test below proves tools/list writes NOTHING to that log.)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-list-'));
process.env.LM_ASSIST_DATA_DIR = DATA_DIR;

import {
  configureMcpServer, getLmAssistInstructions, LM_ASSIST_TOOL_DEFS,
  type ExtToolDef, type McpToolDispatcher,
} from '../mcp-server/configure';
import { applyOverlayToToolDefs } from '../mcp-server/registry/overlay';
import {
  applyProfileToToolDefs, resolveEffectiveProfile, setActiveProfile, _resetProfileCacheForTests,
} from '../mcp-server/registry/profiles';
import { runWithMcpContext, currentEffectiveProfile } from '../mcp-server/principal-context';
import { isDevRepo } from '../utils/path-utils';

const EXT: ExtToolDef[] = [
  { name: 'ext__langmart__models_list', description: 'models', inputSchema: { type: 'object' } },
  { name: 'ext__other__thing', description: 'thing', inputSchema: { type: 'object' } },
];

/** An ext provider that counts how often tools/list asked it — the fleet fan-out cost. */
function extProvider(): { calls: number; list: () => Promise<ExtToolDef[]> } {
  const p = { calls: 0, list: async () => { p.calls++; return EXT; } };
  return p;
}

type Handler = (req?: unknown) => Promise<any>;
function fakeServer(): { server: any; list: () => Promise<any> } {
  const handlers = new Map<string, Handler>();
  const server = {
    setRequestHandler(schema: any, fn: Handler) {
      // The SDK schema objects carry the method literal at shape.method.value
      handlers.set(schema?.shape?.method?.value ?? String(handlers.size), fn);
    },
  };
  return { server, list: () => handlers.get('tools/list')!() };
}

const noop: McpToolDispatcher = async () => ({ content: [{ type: 'text', text: 'ok' }] });
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);
const subset = (profile: string, extra: Array<{ name: string }> = []) =>
  names(applyProfileToToolDefs([...LM_ASSIST_TOOL_DEFS, ...extra] as Array<{ name: string }>, profile));

function stateFile(): string {
  return path.join(DATA_DIR, `mcp-profile${isDevRepo() ? '-dev' : ''}.json`);
}

/**
 * Runs `fn` with console.log captured and returns the `[mcp] tools/list` lines it wrote
 * (the Core log is Core's console). logToolsList writes synchronously inside the handler,
 * so no settling is needed. Any other console output passes through untouched.
 */
async function toolsListLines<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => {
    const s = a.map((x) => String(x)).join(' ');
    if (s.startsWith('[mcp] tools/list')) lines.push(s);
    else original(...a);
  };
  try {
    return { out: await fn(), lines };
  } finally {
    console.log = original;
  }
}

beforeEach(() => {
  fs.rmSync(stateFile(), { force: true });
  _resetProfileCacheForTests();
});

test('currentEffectiveProfile reads the request context, and is undefined outside one', () => {
  assert.equal(currentEffectiveProfile(), undefined);
  const basic = resolveEffectiveProfile('basic');
  assert.equal(runWithMcpContext({ principal: { type: 'local' }, profile: basic }, () => currentEffectiveProfile()), basic);
  assert.equal(runWithMcpContext({ principal: { type: 'local' } }, () => currentEffectiveProfile()), undefined,
    'an entry point that predates pins sets no profile');
});

test('NO pin + node default admin → byte-identical to the pre-pin surface', async () => {
  const before = JSON.stringify(applyOverlayToToolDefs([...LM_ASSIST_TOOL_DEFS, ...EXT], null));
  for (const opts of [undefined, { profile: resolveEffectiveProfile(undefined) }]) {
    const ext = extProvider();
    const { server, list } = fakeServer();
    configureMcpServer(server, noop, undefined, ext, opts);
    const out = await list();
    assert.equal(JSON.stringify(out.tools), before, `opts=${JSON.stringify(opts)}`);
    assert.equal(ext.calls, 1, 'admin can carry plugin tools, so the plugin list is still fetched');
  }
});

test('a basic pin advertises exactly the basic subset and skips the plugin fan-out', async () => {
  const ext = extProvider();
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, ext, { profile: resolveEffectiveProfile('basic') });
  const got = names((await list()).tools);
  assert.deepEqual(got, subset('basic'));
  for (const n of ['bootstrap', 'guide', 'mcp_profile', 'session_status', 'list_nodes']) assert.ok(got.includes(n), n);
  assert.ok(!got.includes('gmail_send'));
  assert.equal(ext.calls, 0, 'basic has no ext__ selector — fetching plugin defs would be pure waste');
});

test('a platform pin (and its old name) keeps its plugin and only that one', async () => {
  for (const pin of ['platform', 'langmart']) {
    const ext = extProvider();
    const { server, list } = fakeServer();
    configureMcpServer(server, noop, undefined, ext, { profile: resolveEffectiveProfile(pin) });
    const got = names((await list()).tools);
    assert.deepEqual(got, subset('platform', EXT), pin);
    assert.ok(got.includes('ext__langmart__models_list'), pin);
    assert.ok(!got.includes('ext__other__thing'), pin);
    assert.equal(ext.calls, 1, pin);
  }
});

test('with no server option, the pin comes from the request context', async () => {
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, extProvider());
  const out = await runWithMcpContext(
    { principal: { type: 'local' }, profile: resolveEffectiveProfile('basic') },
    () => list(),
  );
  assert.deepEqual(names(out.tools), subset('basic'));
});

test('the server option outranks the request context', async () => {
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, extProvider(), { profile: resolveEffectiveProfile('basic') });
  const out = await runWithMcpContext(
    { principal: { type: 'local' }, profile: resolveEffectiveProfile('extended') },
    () => list(),
  );
  assert.deepEqual(names(out.tools), subset('basic'));
});

test('an unknown pin fails OPEN to the node default — never a blank surface', async () => {
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, extProvider(), { profile: resolveEffectiveProfile('basci') });
  assert.deepEqual(names((await list()).tools), subset('admin', EXT));
});

test('a pin ignores the node default; a node-default resolution follows it live', async () => {
  const pinned = fakeServer();
  configureMcpServer(pinned.server, noop, undefined, extProvider(), { profile: resolveEffectiveProfile('extended') });
  // Resolved while the node default was admin — the shape a stdio server holds for hours.
  const unpinned = fakeServer();
  const ext = extProvider();
  configureMcpServer(unpinned.server, noop, undefined, ext, { profile: resolveEffectiveProfile(undefined) });

  setActiveProfile('basic', 'test');

  assert.deepEqual(names((await unpinned.list()).tools), subset('basic'),
    'a node-default resolution is re-read per tools/list, or `mcp_profile set` never reaches a running stdio client');
  assert.equal(ext.calls, 0, 'and the node default in force decides the plugin fan-out');
  assert.deepEqual(names((await pinned.list()).tools), subset('extended'), 'a pin is fixed');
});

test('each tools/list writes exactly one Core-log line: profile, source, pin, count', async () => {
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, extProvider(), { profile: resolveEffectiveProfile('extended') });
  const { out, lines } = await toolsListLines(async () => {
    const first = await list();
    await list();
    return first;
  });
  assert.equal(lines.length, 2, 'one line per tools/list');
  const m = lines[0].match(/^\[mcp\] tools\/list profile=extended source=pin pin="extended" advertised=(\d+) \d+ms$/);
  assert.ok(m, lines[0]);
  assert.equal(Number(m![1]), out.tools.length, 'the count is what actually went out');
});

test('an unpinned tools/list says node default and names no pin', async () => {
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, extProvider());
  const { out, lines } = await toolsListLines(() => list());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[mcp\] tools\/list profile=admin source=node-default advertised=\d+ \d+ms$/);
  assert.ok(lines[0].includes(` advertised=${out.tools.length} `), lines[0]);
});

test('an unknown pin is visible in the log line — on ONE line, whatever was sent', async () => {
  for (const [sent, echoed] of [['nope-typo', 'nope-typo'], ['evil\nline', 'evil?line']]) {
    const { server, list } = fakeServer();
    configureMcpServer(server, noop, undefined, extProvider(), { profile: resolveEffectiveProfile(sent) });
    const { lines } = await toolsListLines(() => list());
    assert.equal(lines.length, 1, JSON.stringify(sent));
    assert.ok(!lines[0].includes('\n'), 'a pin must never split the log line');
    assert.equal(
      lines[0].split(' advertised=')[0],
      `[mcp] tools/list profile=admin source=node-default pin=${JSON.stringify(echoed)} unknown-pin (served the node default)`,
    );
  }
});

test('the tools/list line goes to the Core log, never to mcp-calls.jsonl', async () => {
  const { server, list } = fakeServer();
  configureMcpServer(server, noop, undefined, extProvider(), { profile: resolveEffectiveProfile('basic') });
  await toolsListLines(() => list());
  // Long enough for a stray fire-and-forget append to land, if one were ever re-added.
  await new Promise((r) => setTimeout(r, 50));
  const file = path.join(DATA_DIR, 'logs', 'mcp-calls.jsonl');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.ok(!text.includes('tools/list'),
    'mcp-calls.jsonl is a 1,000-line capped fleet dataset — a line per tools/list would push the tool-call history out');
});

test('instructions: a node-default resolution is the unpinned text, byte for byte', () => {
  assert.equal(getLmAssistInstructions(resolveEffectiveProfile(undefined)), getLmAssistInstructions());
});
