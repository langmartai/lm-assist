/**
 * mcp_profile + GET/POST /mcp-tools/profile under per-connector pins
 * (docs/superpowers/specs/2026-09-23-mcp-profile-connectors-design.md §6, §7.2).
 *
 * The rule under test: a PIN belongs to the connector, the FILE belongs to the node. `set`
 * only ever writes the node default; on a pinned connector the reply must say, loudly, that
 * THIS connector did not change and where the requested profile lives. `get` never touches
 * the network — it is a protected, always-listed tool. A node-default change fires the
 * unpinned-connector refresh exactly once, fire-and-forget; a read or a refused set never does.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate the node-default file and pin the public MCP base. Both are read PER CALL
// (getDataDir() and mcpPublicBase() consult the env each time), so setting them here is
// enough — and this test never touches ~/.lm-assist or the real hub config. The plugin
// subsystem is switched off so GET /mcp-tools/profile counts built-ins only.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profile-tool-'));
process.env.MCP_PUBLIC_BASE = 'https://mcp.example.test';
process.env.LM_MCP_PLUGINS = '0';
const BASE = 'https://mcp.example.test';

import { EXPANDED_HANDLERS, mcpProfileToolDef } from '../mcp-server/tools/expanded';
import { runWithMcpContext } from '../mcp-server/principal-context';
import {
  _resetProfileCacheForTests, activeProfileName, readProfileState, setActiveProfile,
  type EffectiveProfile,
} from '../mcp-server/registry/profiles';
import { CONNECTORS_HINT, connectorsHintFor } from '../mcp-server/registry/profile-report';
import { LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
import { applyProfileToToolDefs, PROFILE_DEFINITIONS } from '../mcp-server/registry/profiles';
import { _setUnpinnedRefresherForTests } from '../mcp-server/profile-connectors';
import { currentToolsRev } from '../mcp-server/registry/tools-rev';
import { createMcpToolsRoutes, handleProfileGet, handleProfileSet } from '../routes/core/mcp-tools.routes';
import { MEASURED_BUDGETS } from '../mcp-server/tool-output-budget';

const PIN_BASIC: EffectiveProfile = { name: 'basic', source: 'pin', pin: 'basic' };
const UNKNOWN_PIN: EffectiveProfile = { name: 'admin', source: 'node-default', pin: 'basci', unknownPin: true };

// A unit test must never reach the operator's real claude.ai account. The refresh hook's own
// NODE_TEST_CONTEXT guard already keeps the REAL refresh from running under node --test; this
// counting stand-in is what lets the tests below SEE the hook fire.
let hookCalls = 0;
const counting = async (): Promise<void> => { hookCalls++; };
_setUnpinnedRefresherForTests(counting);
after(() => _setUnpinnedRefresherForTests(null));

/** The refresh runs in a `.then` (fire-and-forget) — let it land before counting. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  _resetProfileCacheForTests();
  setActiveProfile('admin', 'test'); // the shipped default; a direct write, so no hook fires
  hookCalls = 0;
});

async function callTool(args: Record<string, unknown>, profile?: EffectiveProfile) {
  const run = () => EXPANDED_HANDLERS.mcp_profile(args);
  return profile ? runWithMcpContext({ principal: { type: 'cloud' }, profile }, run) : run();
}

async function readJson(args: Record<string, unknown>, profile?: EffectiveProfile): Promise<any> {
  const r = await callTool(args, profile);
  assert.notEqual(r.isError, true, String(r.content[0].text));
  return JSON.parse(String(r.content[0].text));
}

/** POST /mcp-tools/profile through the real route table (literal routes before /:name). */
function postProfileRoute(profile: string): Promise<{ success: boolean }> {
  const route = createMcpToolsRoutes({} as never).find((r) => r.method === 'POST' && r.pattern.test('/mcp-tools/profile'))!;
  return route.handler(
    { method: 'POST', path: '/mcp-tools/profile', params: {}, query: {}, body: { profile } } as never,
    {} as never,
  ) as Promise<{ success: boolean }>;
}

// ── read ───────────────────────────────────────────────────────────────────

test('read, unpinned: effective = node default, plus every profile\'s connector URL', async () => {
  const d = await readJson({});
  assert.equal(d.effective, 'admin');
  assert.equal(d.source, 'node-default');
  assert.equal(d.pin, null);
  assert.equal(d.unknownPin, undefined);
  assert.equal(d.nodeDefault, 'admin');
  assert.equal(d.unpinnedConnector, `${BASE}/mcp`);
  assert.equal(d.profiles.basic.connector, `${BASE}/mcp/basic`);
  assert.equal(d.profiles.platform.connector, `${BASE}/mcp/platform`);
  assert.equal(d.profiles.admin.connector, `${BASE}/mcp/admin`);
  assert.equal(typeof d.profiles.extended.description, 'string');
  assert.equal(d.connectorsHint, CONNECTORS_HINT);
  assert.equal(d.note, undefined, 'a read carries no note');
});

test('read, pinned: reports the PIN as effective and the file as nodeDefault', async () => {
  const d = await readJson({}, PIN_BASIC);
  assert.equal(d.effective, 'basic');
  assert.equal(d.source, 'pin');
  assert.equal(d.pin, 'basic');
  assert.equal(d.nodeDefault, 'admin');
});

test('read, unknown pin: fails open to the node default, visibly', async () => {
  const d = await readJson({}, UNKNOWN_PIN);
  assert.equal(d.effective, 'admin');
  assert.equal(d.source, 'node-default');
  assert.equal(d.pin, 'basci');
  assert.equal(d.unknownPin, true);
  const evil = await readJson({}, { name: 'admin', source: 'node-default', pin: 'x"\n; drop', unknownPin: true });
  assert.equal(evil.pin, '(not a legal profile name)', 'request text is never echoed raw');
});

test('get makes NO network call and fires no refresh — it is a protected, always-listed tool', async () => {
  assert.equal(CONNECTORS_HINT, 'For claude.ai connector status per profile, call mcp_connectors {action:"list"}.');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error('no network in this test'); }) as typeof fetch;
  try {
    const pinned = await readJson({}, PIN_BASIC);
    const unpinned = await readJson({});
    await settle();
    assert.equal(fetched, 0, 'get must never read claude.ai — its connector list is a ~30 s stream');
    assert.equal(hookCalls, 0);
    assert.equal(unpinned.connectorsHint, CONNECTORS_HINT, 'admin lists mcp_connectors: the hint is unchanged');
    // basic does not list mcp_connectors, and claude.ai / Claude Code only offer listed tools.
    assert.notEqual(pinned.connectorsHint, CONNECTORS_HINT);
    assert.match(pinned.connectorsHint, /profile "basic" does not list it/);
    assert.match(pinned.connectorsHint, /the unpinned or `admin` lm-assist connector/);
    assert.match(pinned.connectorsHint, /GET \/mcp\/profile-connectors/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── set ────────────────────────────────────────────────────────────────────

test('set from a PINNED connector changes the node default only — and says THIS connector did not change', async () => {
  const revBefore = currentToolsRev();
  const d = await readJson({ set: 'extended' }, PIN_BASIC);
  assert.equal(d.nodeDefault, 'extended');
  assert.equal(d.effective, 'basic', 'the pinned caller still gets its pin');
  assert.equal(d.source, 'pin');
  assert.match(d.note, /THIS CONNECTOR DID NOT CHANGE/);
  assert.match(d.note, /only UNPINNED clients/);
  assert.ok(d.note.includes(`${BASE}/mcp/extended`), `names the connector that has the requested profile: ${d.note}`);
  assert.equal(activeProfileName(), 'extended');
  assert.notEqual(currentToolsRev(), revBefore, 'stdio clients are told their list changed');
  await settle();
  assert.equal(hookCalls, 1, 'unpinned connectors are refreshed');
});

test('set from an UNPINNED caller: its own effective profile moves with the node default', async () => {
  const d = await readJson({ set: 'basic' });
  assert.equal(d.effective, 'basic');
  assert.equal(d.nodeDefault, 'basic');
  assert.equal(d.source, 'node-default');
  assert.doesNotMatch(d.note, /DID NOT CHANGE/);
  assert.match(d.note, /unpinned clients only/);
  await settle();
  assert.equal(hookCalls, 1);
});

test('set from an UNKNOWN pin: that connector follows the default, and is told so', async () => {
  const d = await readJson({ set: 'basic' }, UNKNOWN_PIN);
  assert.equal(d.effective, 'basic');
  assert.equal(d.unknownPin, true);
  assert.match(d.note, /"basci" is not a profile on this node/);
  assert.match(d.note, /DOES change/);
});

test('set accepts the langmart alias and writes the canonical name', async () => {
  const d = await readJson({ set: 'langmart' });
  assert.equal(d.nodeDefault, 'platform');
  assert.equal(readProfileState().profile, 'platform');
});

test('set of an unknown name is refused loudly, writes nothing, refreshes nothing', async () => {
  const r = await callTool({ set: 'nope' });
  assert.equal(r.isError, true);
  assert.match(String(r.content[0].text), /unknown profile/i);
  assert.match(String(r.content[0].text), /nope/);
  assert.equal(activeProfileName(), 'admin');
  await settle();
  assert.equal(hookCalls, 0);
});

test('a failing refresh never undoes or blocks a successful set', async () => {
  try {
    _setUnpinnedRefresherForTests(() => { throw new Error('claude.ai unreachable'); });
    assert.equal((await readJson({ set: 'basic' })).nodeDefault, 'basic');
    _setUnpinnedRefresherForTests(() => Promise.reject(new Error('claude.ai 500')));
    assert.equal((await readJson({ set: 'extended' })).nodeDefault, 'extended');
    await settle();
    assert.equal(activeProfileName(), 'extended');
  } finally {
    _setUnpinnedRefresherForTests(counting);
  }
});

// ── the advertised definition + size ───────────────────────────────────────

test('description no longer claims node-global; set lists the renamed profile', () => {
  assert.doesNotMatch(mcpProfileToolDef.description, /node-global/i);
  assert.match(mcpProfileToolDef.description, /node default/);
  assert.match(mcpProfileToolDef.description, /THIS connector/);
  assert.match(mcpProfileToolDef.inputSchema.properties.set.description, /platform/);
  assert.doesNotMatch(mcpProfileToolDef.inputSchema.properties.set.description, /\| langmart \|/);
});

test('output stays inside the recorded mcp_profile budget — read and the longest set reply', async () => {
  for (const [args, profile] of [[{}, PIN_BASIC], [{ set: 'extended' }, PIN_BASIC], [{ set: 'basic' }, UNKNOWN_PIN]] as const) {
    const r = await callTool(args, profile);
    const bytes = Buffer.byteLength(String(r.content[0].text), 'utf8');
    assert.ok(bytes <= MEASURED_BUDGETS.mcp_profile.budgetBytes, `${JSON.stringify(args)}: ${bytes}B > ${MEASURED_BUDGETS.mcp_profile.budgetBytes}B`);
  }
});

// ── REST ───────────────────────────────────────────────────────────────────

test('GET /mcp-tools/profile keeps `active` and adds the shared vocabulary', async () => {
  const r = await handleProfileGet();
  assert.equal(r.success, true, JSON.stringify(r));
  const d = r.data as any;
  assert.equal(d.active, 'admin', 'deployed panes read `active`');
  assert.equal(d.effective, 'admin');
  assert.equal(d.source, 'node-default');
  assert.equal(d.pin, null, 'REST carries no pin');
  assert.equal(d.nodeDefault, 'admin');
  assert.equal(d.connectors.unpinned, `${BASE}/mcp`);
  assert.equal(d.connectors.byProfile.extended, `${BASE}/mcp/extended`);
  assert.ok(d.profiles.some((p: any) => p.name === 'admin' && p.active === true));
});

test('POST /mcp-tools/profile sets the node default through the shared path', async () => {
  const r = await handleProfileSet({ profile: 'basic' });
  assert.equal(r.success, true, JSON.stringify(r));
  const d = r.data as any;
  assert.equal(d.active, 'basic');
  assert.equal(d.nodeDefault, 'basic');
  assert.match(d.note, /unpinned clients only/);
  await settle();
  assert.equal(hookCalls, 1);

  const bad = await handleProfileSet({ profile: 'nope' });
  assert.equal(bad.success, false);
  assert.equal(bad.error?.code, 'UNKNOWN_PROFILE');
  await settle();
  assert.equal(hookCalls, 1, 'a refused set refreshes nothing');
  assert.equal(activeProfileName(), 'basic');
});

// ── the unpinned-connector refresh, at the handler and route level ─────────
// Handed over by the refresh-hook task (Task 9): these exercise the wiring THIS task adds —
// both set paths reach onNodeDefaultProfileChanged through setNodeDefaultProfile.

test('mcp_profile set refreshes the unpinned connectors — once, fire-and-forget', async () => {
  const res = await EXPANDED_HANDLERS.mcp_profile({ set: 'basic' });
  assert.notEqual(res.isError, true, String(res.content[0].text));
  await settle();
  assert.equal(hookCalls, 1);
});

test('mcp_profile read does not refresh', async () => {
  await EXPANDED_HANDLERS.mcp_profile({});
  await settle();
  assert.equal(hookCalls, 0);
});

test('mcp_profile set to an unknown profile does not refresh', async () => {
  const res = await EXPANDED_HANDLERS.mcp_profile({ set: 'no-such-profile' });
  assert.equal(res.isError, true);
  await settle();
  assert.equal(hookCalls, 0);
});

test('POST /mcp-tools/profile (the route) refreshes the unpinned connectors', async () => {
  const res = await postProfileRoute('extended');
  assert.equal(res.success, true);
  await settle();
  assert.equal(hookCalls, 1);
});

test('POST /mcp-tools/profile (the route) with an unknown profile does not refresh', async () => {
  const res = await postProfileRoute('no-such-profile');
  assert.equal(res.success, false);
  await settle();
  assert.equal(hookCalls, 0);
});

// ── the hint never names a tool the caller cannot call without saying where it is listed ──

/** Is `tool` in this profile's advertised tools/list? (The real filter, over the real defs.) */
const lists = (profile: string, tool: string): boolean =>
  applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], profile).some((d: any) => d.name === tool);

test('connectorsHint: unchanged only where the profile lists mcp_connectors; elsewhere it says where it is listed', () => {
  assert.ok(lists('admin', 'mcp_connectors'));
  for (const name of Object.keys(PROFILE_DEFINITIONS)) {
    for (const source of ['pin', 'node-default'] as const) {
      const hint = connectorsHintFor({ name, source });
      if (lists(name, 'mcp_connectors')) {
        assert.equal(hint, CONNECTORS_HINT, `${name} (${source}) lists it`);
      } else {
        assert.match(hint, new RegExp(`profile "${name}" does not list it`), `${name} (${source})`);
        assert.match(hint, /GET \/mcp\/profile-connectors/, `${name} (${source}) names the REST route`);
        assert.ok(Buffer.byteLength(hint) < 400, `${name} (${source}) stays one bounded line`);
      }
    }
  }
});

test('connectorsHint under a narrowed NODE DEFAULT never points at the unpinned connector (it is narrowed too)', async () => {
  setActiveProfile('basic', 'test');
  try {
    const d = await readJson({});
    assert.equal(d.effective, 'basic');
    assert.doesNotMatch(d.connectorsHint, /unpinned or/);
    assert.match(d.connectorsHint, /an `admin`-pinned lm-assist connector on this hub \(URL …\/mcp\/admin\)/);
    // A basic PIN on this node: the unpinned connector is narrowed too, so the same pointer.
    const p = await readJson({}, PIN_BASIC);
    assert.doesNotMatch(p.connectorsHint, /unpinned or/);
    assert.match(p.connectorsHint, /`admin`-pinned/);
  } finally {
    setActiveProfile('admin', 'test');
  }
});

test('set from a basic PIN: the note names mcp_connectors only together with where it is listed', async () => {
  const d = await readJson({ set: 'extended' }, PIN_BASIC);
  assert.match(d.note, /mcp_connectors \{action:"create", profile:"extended"\} on /);
  // The node default is now extended, which does not list mcp_connectors either.
  assert.match(d.note, /`admin`-pinned lm-assist connector/);
  const a = await readJson({ set: 'basic' }, { name: 'admin', source: 'pin', pin: 'admin' });
  assert.match(a.note, /mcp_connectors \{action:"create", profile:"basic"\}\)/, 'an admin pin lists it: no pointer needed');
});
