/**
 * enabled_mcp_tools writers: serialized, and batchable into ONE read-modify-write.
 *
 * claude.ai's PATCH /api/account/settings REPLACES the whole enabled_mcp_tools map (verified
 * 2026-06-20: a partial map collapsed 228 keys to 1), so every writer reads the whole map and
 * writes it all back — two writers in flight lose one write. One connector per profile makes
 * upkeep write several connectors at once, which is exactly that race.
 */
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs = require('fs');
import {
  setMcpToolsAccess, applyConnectorToolUpdates, applyConnectorToolUpdatesToMap,
  validateConnectorToolUpdates, withEnabledMcpToolsLock,
} from '../utils/claudeai-session';

const ORG = '7cad1e03-e98e-42ca-8571-311a4ce74b8b';
const A = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2';
const B = '3b3b3b3b-0000-4000-8000-00000000000b';
const H1 = 'a'.repeat(32);
const H2 = 'b'.repeat(32);
const OLD = 'c'.repeat(32);

const realReadFileSync = fs.readFileSync;
function stubSession(): void {
  mock.method(fs, 'readFileSync', (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.endsWith('claudeai-session.json')) {
      return JSON.stringify({ cookie: `lastActiveOrg=${ORG}; sessionKey=REDACTED` });
    }
    return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  });
}

type ToolObj = { name: string; enabled_key?: string; always_approved_key?: string };

/** A fake account: GET /api/account returns the map; PATCH REPLACES it (as claude.ai does).
 *  Both answer after a short delay so unserialized writers really interleave. */
function fakeAccount(initial: Record<string, boolean>, tools: Record<string, ToolObj[]> = {}) {
  const state = { map: { ...initial } as Record<string, boolean>, gets: 0, patches: 0, boots: 0 };
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = String(init?.method || 'GET');
    if (method === 'GET' && u === 'https://claude.ai/api/account') {
      state.gets++;
      const snapshot = { ...state.map };
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ settings: { enabled_mcp_tools: snapshot } }), { status: 200 });
    }
    if (method === 'PATCH' && u === 'https://claude.ai/api/account/settings') {
      state.patches++;
      const next = JSON.parse(String(init!.body)).enabled_mcp_tools as Record<string, boolean>;
      await new Promise((r) => setTimeout(r, 5));
      state.map = { ...next };
      return new Response('{}', { status: 202 });
    }
    if (method === 'GET' && u.endsWith('/mcp/v2/bootstrap')) {
      state.boots++;
      const sse = Object.entries(tools)
        .map(([server_uuid, t]) => `event: tools\ndata: ${JSON.stringify({ server_uuid, tools: t })}\n\n`)
        .join('');
      return new Response(sse, { status: 200 });
    }
    return new Response('unexpected', { status: 599 });
  });
  return state;
}

afterEach(() => { mock.restoreAll(); });

test('two concurrent tool-access writes on different connectors BOTH survive', async () => {
  stubSession();
  const acct = fakeAccount({ 'OTHER:keep': true });
  await Promise.all([setMcpToolsAccess(A, { search: true }), setMcpToolsAccess(B, { detail: false })]);
  assert.equal(acct.map[`${A}:search`], true, 'the first write was not dropped by the second');
  assert.equal(acct.map[`${B}:detail`], false);
  assert.equal(acct.map['OTHER:keep'], true);
});

test('a batch folds several connectors into ONE bootstrap read, ONE account read and ONE write', async () => {
  stubSession();
  const acct = fakeAccount({ 'OTHER:keep': true }, {
    [A]: [{ name: 'search', enabled_key: `${A}:search`, always_approved_key: `${A}:search-${H1}` }],
    [B]: [{ name: 'search', enabled_key: `${B}:search`, always_approved_key: `${B}:search-${H2}` }],
  });
  const r = await applyConnectorToolUpdates([
    { connectorUuid: A, access: { search: true }, autoApprove: { enable: true, tools: ['search'] } },
    { connectorUuid: B, access: { search: true }, autoApprove: { enable: true, tools: ['search'] } },
  ]);
  assert.deepEqual([acct.boots, acct.gets, acct.patches], [1, 1, 1]);
  assert.equal(acct.map[`${A}:search-${H1}`], true);
  assert.equal(acct.map[`${B}:search-${H2}`], true);
  assert.equal(acct.map['OTHER:keep'], true);
  assert.equal(r.body.patched, true);
  assert.deepEqual(r.body.results.map((x) => x.approved), [['search'], ['search']]);
});

test('an access-only batch never reads the bootstrap', async () => {
  stubSession();
  const acct = fakeAccount({ 'OTHER:keep': true });
  await applyConnectorToolUpdates([{ connectorUuid: A, access: { search: false } }]);
  assert.equal(acct.boots, 0);
  assert.equal(acct.map[`${A}:search`], false);
});

test('a batch that changes nothing does not PATCH', async () => {
  stubSession();
  const acct = fakeAccount({ [`${A}:search`]: true });
  const r = await applyConnectorToolUpdates([{ connectorUuid: A, access: { search: true } }]);
  assert.equal(acct.patches, 0);
  assert.equal(r.body.patched, false);
});

test('a batch refuses to write when the account read comes back empty', async () => {
  stubSession();
  const acct = fakeAccount({});
  await assert.rejects(applyConnectorToolUpdates([{ connectorUuid: A, access: { search: true } }]), /refusing to write an empty/);
  assert.equal(acct.patches, 0);
});

test('a failed writer does not wedge the queue', async () => {
  await assert.rejects(withEnabledMcpToolsLock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withEnabledMcpToolsLock(async () => 7), 7);
});

test('carryForward re-keys ONLY tools already approved under an older hash — it never widens', () => {
  const current = { [`${A}:search-${OLD}`]: true, [`${A}:detail-${OLD}`]: false, 'OTHER:keep': true };
  const objs = {
    [A]: [
      { name: 'search', enabled_key: `${A}:search`, always_approved_key: `${A}:search-${H1}` },
      { name: 'detail', enabled_key: `${A}:detail`, always_approved_key: `${A}:detail-${H2}` },
      { name: 'list_nodes', enabled_key: `${A}:list_nodes`, always_approved_key: `${A}:list_nodes-${H1}` },
    ],
  };
  const { map, results } = applyConnectorToolUpdatesToMap(
    [{ connectorUuid: A, autoApprove: { enable: true, carryForward: true } }], objs, current);
  assert.deepEqual(results[0].approved, ['search']);
  assert.equal(map[`${A}:search-${H1}`], true);
  assert.equal(map[`${A}:detail-${H2}`], undefined, 'was not approved before → not approved now');
  assert.equal(map[`${A}:list_nodes-${H1}`], undefined, 'a new tool is not approved');
  assert.equal(map['OTHER:keep'], true);
});

test('carryForward with nothing previously approved writes nothing (never "all tools")', () => {
  const objs = { [A]: [{ name: 'search', enabled_key: `${A}:search`, always_approved_key: `${A}:search-${H1}` }] };
  const { map, results } = applyConnectorToolUpdatesToMap(
    [{ connectorUuid: A, autoApprove: { enable: true, carryForward: true } }], objs, { 'X:y': true });
  assert.deepEqual(results[0].approved, []);
  assert.deepEqual(map, { 'X:y': true });
});

test('autoApprove on a connector the bootstrap lists no tools for → per-connector error; access still applied', () => {
  const { map, results } = applyConnectorToolUpdatesToMap(
    [{ connectorUuid: A, access: { search: true }, autoApprove: { enable: true } }], {}, { 'X:y': true });
  assert.match(results[0].error || '', /lists no tools/);
  assert.equal(map[`${A}:search`], true);
});

test('the pure apply never mutates its input map', () => {
  const current = { 'X:y': true };
  applyConnectorToolUpdatesToMap([{ connectorUuid: A, access: { search: true } }], {}, current);
  assert.deepEqual(current, { 'X:y': true });
});

test('validateConnectorToolUpdates refuses loudly and keeps only known fields', () => {
  assert.ok('error' in validateConnectorToolUpdates({}));
  assert.ok('error' in validateConnectorToolUpdates({ updates: [] }));
  const bad = validateConnectorToolUpdates({ updates: [{ connectorUuid: 'nope', access: { a: true } }] });
  assert.ok('error' in bad && bad.error.code === 'INVALID_UUID');
  const notBool = validateConnectorToolUpdates({ updates: [{ connectorUuid: A, access: { a: 'yes' } }] });
  assert.ok('error' in notBool && notBool.error.code === 'INVALID_INPUT');
  const empty = validateConnectorToolUpdates({ updates: [{ connectorUuid: A }] });
  assert.ok('error' in empty && empty.error.code === 'NO_CHANGES');
  const good = validateConnectorToolUpdates({
    updates: [{ connectorUuid: A, access: { a: true }, autoApprove: { enable: true, tools: ['a', 7], carryForward: 'yes' }, junk: 1 }],
  });
  assert.ok('updates' in good);
  assert.deepEqual(good.updates, [{ connectorUuid: A, access: { a: true }, autoApprove: { enable: true, tools: ['a'] } }]);
});

// ── an empty auto-approve scope must never widen to "every tool" ─────────────
// Always-approve removes the human approval gate: `tools: []` (or a list whose entries were all
// dropped as non-strings) reads as "none" or is refused — never as the omitted-list "all".

test('validateConnectorToolUpdates refuses an autoApprove.tools list that names no tool', () => {
  for (const tools of [[], [7], [null, {}]]) {
    const v = validateConnectorToolUpdates({ updates: [{ connectorUuid: A, autoApprove: { enable: true, tools } }] });
    assert.ok('error' in v, `tools=${JSON.stringify(tools)} was accepted`);
    assert.equal(v.error.code, 'INVALID_INPUT');
    assert.match(v.error.message, /updates\[0\]\.autoApprove\.tools/);
    assert.ok(v.error.message.includes(JSON.stringify(tools)), 'the refusal echoes what was sent');
  }
});

test('{enable:true, tools:[]} approves NOTHING in the pure apply — plain and carryForward alike', () => {
  const objs = {
    [A]: [
      { name: 'search', enabled_key: `${A}:search`, always_approved_key: `${A}:search-${H1}` },
      { name: 'elevated_exec', enabled_key: `${A}:elevated_exec`, always_approved_key: `${A}:elevated_exec-${H2}` },
    ],
  };
  for (const carryForward of [false, true]) {
    const current = { [`${A}:search-${OLD}`]: true, 'X:y': true };
    const { map, results } = applyConnectorToolUpdatesToMap(
      [{ connectorUuid: A, autoApprove: { enable: true, tools: [], ...(carryForward ? { carryForward: true } : {}) } }],
      objs, current);
    assert.deepEqual(results[0].approved, [], `carryForward=${carryForward}`);
    assert.deepEqual(map, current, `carryForward=${carryForward}: the map is unchanged`);
  }
});

test('applyConnectorToolUpdates with {enable:true, tools:[]} writes nothing', async () => {
  stubSession();
  const acct = fakeAccount({ 'OTHER:keep': true }, {
    [A]: [{ name: 'elevated_exec', enabled_key: `${A}:elevated_exec`, always_approved_key: `${A}:elevated_exec-${H1}` }],
  });
  const r = await applyConnectorToolUpdates([{ connectorUuid: A, autoApprove: { enable: true, tools: [] } }]);
  assert.equal(acct.patches, 0);
  assert.equal(r.body.patched, false);
  assert.equal(acct.map[`${A}:elevated_exec-${H1}`], undefined);
});
