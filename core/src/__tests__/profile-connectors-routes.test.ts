/**
 * /mcp/profile-connectors — one claude.ai connector per profile (spec §7.3, amended d7a4d0c: the
 * REST surface lives under /mcp/, not /mcp-tools/, so an older Core answers a clean 404 instead
 * of misrouting the request into its /mcp-tools/:name tool-registry handler).
 *
 * The handlers stay in mcp-tools.routes.ts (their dependencies already live there) — only the
 * route table entries are anchored to /mcp/profile-connectors. Port-injected (fake claude.ai
 * roster), like the other /mcp-tools handler tests. Pins: the list is bounded (never tool names),
 * create is idempotent by URL and serialized, a dev hub's connector is never counted as ours, and
 * the new patterns don't collide with anything under /mcp-tools/ or /mcp/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-profile-connectors-routes-'));

import {
  handleProfileConnectorsList, handleProfileConnectorCreate, handleProfileConnectorDelete,
  createMcpToolsRoutes, type ProfileConnectorDeps,
} from '../routes/core/mcp-tools.routes';
import { PROFILE_DEFINITIONS } from '../mcp-server/registry/profiles';
import type { ConnectorLike } from '../mcp-server/profile-connectors';

const PROD = 'https://mcp.langmart.ai';
const U = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2';
const B = '3b3b3b3b-0000-4000-8000-00000000000b';
const N = '5d5d5d5d-0000-4000-8000-00000000000d';

type Server = ConnectorLike & { tools?: string[] };

const ROSTER: Server[] = [
  { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', connected: true, authStatus: 'authenticated', toolCount: 9, tools: ['drive_search'] },
  { uuid: U, name: 'lm-assist langmart', url: `${PROD}/mcp`, connected: true, authStatus: 'authenticated', toolCount: 2, tools: ['search', 'secret_tool_name_xyz'] },
  { uuid: B, name: 'lm-assist langmart basic', url: `${PROD}/mcp/basic/`, connected: true, authStatus: 'authenticated', toolCount: 1, tools: ['search'] },
  { uuid: '4c4c4c4c-0000-4000-8000-00000000000c', name: 'lm-assist dev', url: 'https://mcp.xeenhub.com/mcp/extended', connected: true, authStatus: 'authenticated', toolCount: 5 },
  { uuid: N, name: 'from a newer build', url: `${PROD}/mcp/nextgen`, connected: true, authStatus: 'authenticated', toolCount: 3 },
];

function fakeDeps(initial: Server[], opts: { base?: string; listThrows?: string } = {}) {
  const servers: Server[] = initial.map((s) => ({ ...s }));
  const created: Array<{ url: string; name: string }> = [];
  const deleted: string[] = [];
  let n = 0;
  const deps: ProfileConnectorDeps = {
    base: () => opts.base ?? PROD,
    listServers: async () => {
      if (opts.listThrows) throw new Error(opts.listThrows);
      await new Promise((r) => setTimeout(r, 5));
      return servers.map((s) => ({ ...s }));
    },
    createServer: async (url, name) => {
      created.push({ url, name });
      const uuid = `9c9c9c9c-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      servers.push({ uuid, name, url, connected: false, authStatus: null, toolCount: 0 });
      return { status: 201, body: { uuid, name, url } };
    },
    deleteServer: async (uuid) => {
      deleted.push(uuid);
      const i = servers.findIndex((s) => s.uuid === uuid);
      if (i >= 0) servers.splice(i, 1);
      return { status: 204, body: null };
    },
  };
  return { deps, servers, created, deleted };
}

test('GET lists every profile with its URL and claude.ai connector (or null)', async () => {
  const { deps } = fakeDeps(ROSTER);
  const r = await handleProfileConnectorsList(deps);
  assert.equal(r.success, true, JSON.stringify(r));
  const d = r.data as any;
  assert.equal(d.base, PROD);
  assert.equal(d.hub, 'langmart');
  assert.equal(d.nodeDefault, 'admin');
  assert.deepEqual(d.claudeai, { ok: true });
  assert.equal(d.unpinned.url, `${PROD}/mcp`);
  assert.equal(d.unpinned.connector.uuid, U);
  assert.deepEqual(d.profiles.map((p: any) => p.profile), Object.keys(PROFILE_DEFINITIONS));
  const basic = d.profiles.find((p: any) => p.profile === 'basic');
  assert.equal(basic.url, `${PROD}/mcp/basic`);
  assert.equal(basic.suggestedName, 'lm-assist langmart basic');
  assert.equal(basic.connector.uuid, B, 'a trailing slash on the claude.ai URL still matches');
  const extended = d.profiles.find((p: any) => p.profile === 'extended');
  assert.equal(extended.connector, null, "the dev hub's /mcp/extended is not this node's");
  assert.deepEqual(d.unknownPins.map((u: any) => u.profile), ['nextgen']);
});

/** The exact GET payload for a small roster. The web page (Task 13) and the pane (Task 14)
 *  normalise THIS shape; their fixture tests copy it verbatim. */
const WIRE_ROSTER: Server[] = [
  { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', connected: true, authStatus: 'authenticated', toolCount: 9 },
  { uuid: U, name: 'lm-assist langmart', url: `${PROD}/mcp`, connected: true, authStatus: 'authenticated', toolCount: 320, tools: ['search'] },
  { uuid: B, name: 'lm-assist langmart basic', url: `${PROD}/mcp/basic`, connected: false, authStatus: 'auth_required', toolCount: 0 },
  { uuid: N, name: 'from a newer build', url: `${PROD}/mcp/nextgen`, connected: true, authStatus: 'authenticated', toolCount: 3 },
];
const WIRE_FIXTURE = {
  base: 'https://mcp.langmart.ai',
  hub: 'langmart',
  nodeDefault: 'admin',
  claudeai: { ok: true },
  unpinned: {
    url: 'https://mcp.langmart.ai/mcp',
    suggestedName: 'lm-assist langmart',
    connector: { uuid: '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2', name: 'lm-assist langmart', connected: true, authStatus: 'authenticated', toolCount: 320 },
    duplicates: 0,
  },
  profiles: [
    {
      profile: 'basic', url: 'https://mcp.langmart.ai/mcp/basic', suggestedName: 'lm-assist langmart basic',
      connector: { uuid: '3b3b3b3b-0000-4000-8000-00000000000b', name: 'lm-assist langmart basic', connected: false, authStatus: 'auth_required', toolCount: 0 },
      duplicates: 0,
    },
    { profile: 'platform', url: 'https://mcp.langmart.ai/mcp/platform', suggestedName: 'lm-assist langmart platform', connector: null, duplicates: 0 },
    { profile: 'extended', url: 'https://mcp.langmart.ai/mcp/extended', suggestedName: 'lm-assist langmart extended', connector: null, duplicates: 0 },
    { profile: 'admin', url: 'https://mcp.langmart.ai/mcp/admin', suggestedName: 'lm-assist langmart admin', connector: null, duplicates: 0 },
  ],
  unknownPins: [
    {
      profile: 'nextgen', url: 'https://mcp.langmart.ai/mcp/nextgen',
      connector: { uuid: '5d5d5d5d-0000-4000-8000-00000000000d', name: 'from a newer build', connected: true, authStatus: 'authenticated', toolCount: 3 },
    },
  ],
};

test('GET wire shape — the exact payload the UI normalises (WIRE_FIXTURE)', async () => {
  const { deps } = fakeDeps(WIRE_ROSTER);
  const r = await handleProfileConnectorsList(deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(r.data, WIRE_FIXTURE);
});

test('GET is bounded — never a tool name, and a fixed five-field connector view', async () => {
  const { deps } = fakeDeps(ROSTER);
  const d = (await handleProfileConnectorsList(deps)).data as any;
  assert.ok(!JSON.stringify(d).includes('secret_tool_name_xyz'), 'no per-tool names');
  const basic = d.profiles.find((p: any) => p.profile === 'basic');
  assert.deepEqual(Object.keys(basic.connector).sort(), ['authStatus', 'connected', 'name', 'toolCount', 'uuid']);
});

test('GET without claude.ai access still returns the URLs', async () => {
  const { deps } = fakeDeps(ROSTER, { listThrows: 'No claude.ai session configured' });
  const d = (await handleProfileConnectorsList(deps)).data as any;
  assert.equal(d.claudeai.ok, false);
  assert.match(d.claudeai.error, /No claude\.ai session/);
  assert.equal(d.profiles.find((p: any) => p.profile === 'basic').url, `${PROD}/mcp/basic`);
  assert.equal(d.unpinned.connector, null);
});

test('GET on a node with no hub configured refuses clearly', async () => {
  const { deps } = fakeDeps(ROSTER, { base: '' });
  const r = await handleProfileConnectorsList(deps);
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'HUB_NOT_CONFIGURED');
});

test('POST creates a missing profile connector with the hub-labelled name, and names the Connect step', async () => {
  const { deps, created } = fakeDeps(ROSTER);
  const r = await handleProfileConnectorCreate({ profile: 'extended' }, deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(created, [{ url: `${PROD}/mcp/extended`, name: 'lm-assist langmart extended' }]);
  const d = r.data as any;
  assert.equal(d.created, true);
  assert.equal(d.url, `${PROD}/mcp/extended`);
  assert.ok(d.connector.uuid);
  assert.match(d.nextStep, /Connect/);
});

test('POST is idempotent by URL — an existing connector is returned, nothing created', async () => {
  const { deps, created } = fakeDeps(ROSTER);
  const r = await handleProfileConnectorCreate({ profile: 'basic' }, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).created, false);
  assert.equal((r.data as any).connector.uuid, B);
  assert.equal((r.data as any).nextStep, null, 'already connected → no remaining step');
  assert.equal(created.length, 0);
});

test('POST canonicalises the langmart alias to platform', async () => {
  const { deps, created } = fakeDeps(ROSTER);
  await handleProfileConnectorCreate({ profile: 'langmart' }, deps);
  assert.deepEqual(created, [{ url: `${PROD}/mcp/platform`, name: 'lm-assist langmart platform' }]);
});

test('POST refuses an unknown or missing profile without creating anything', async () => {
  const { deps, created } = fakeDeps(ROSTER);
  assert.equal((await handleProfileConnectorCreate({ profile: 'nosuch' }, deps)).error?.code, 'UNKNOWN_PROFILE');
  assert.equal((await handleProfileConnectorCreate({}, deps)).error?.code, 'INVALID_PROFILE');
  assert.equal(created.length, 0);
});

test('two concurrent creates of the same profile make ONE connector (serialized)', async () => {
  const { deps, created } = fakeDeps(ROSTER);
  const [a, b] = await Promise.all([
    handleProfileConnectorCreate({ profile: 'extended' }, deps),
    handleProfileConnectorCreate({ profile: 'extended' }, deps),
  ]);
  assert.equal(created.length, 1);
  assert.deepEqual([(a.data as any).created, (b.data as any).created].sort(), [false, true]);
});

test('DELETE removes the connector pinned to that profile — and only a pinned one', async () => {
  const { deps, deleted } = fakeDeps(ROSTER);
  const r = await handleProfileConnectorDelete('basic', deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(deleted, [B]);
  assert.equal((r.data as any).removed.length, 1);
  assert.equal((await handleProfileConnectorDelete('extended', deps)).error?.code, 'NOT_FOUND');
  assert.equal((await handleProfileConnectorDelete('connectors', deps)).error?.code, 'INVALID_PROFILE');
  assert.equal((await handleProfileConnectorDelete('Basic', deps)).error?.code, 'INVALID_PROFILE');
  assert.deepEqual(deleted, [B], 'the unpinned connector is never deleted');
});

test('the OLD /mcp-tools/profile-connectors route is gone — an older Core must 404 on the new path, not silently accept the old one (spec §7.3, amended d7a4d0c)', () => {
  const routes = createMcpToolsRoutes({} as never);
  // No pattern in the table literally names /mcp-tools/profile-connectors any more — a GET/POST
  // there now falls through to the generic /mcp-tools/(?<name>)/ tool-registry routes, same as
  // any other unrelated tool name (no special profile-connectors handling left at that path).
  assert.ok(
    !routes.some((r) => r.pattern.source.includes('mcp-tools\\/profile-connectors')),
    'no /mcp-tools/profile-connectors pattern should remain in the route table',
  );
  const generic = (method: string, p: string) => routes.find((r) => r.method === method && r.pattern.test(p));
  assert.match(String(generic('GET', '/mcp-tools/profile-connectors')?.pattern), /\(\?<name>/, 'GET falls through to handleToolGet');
  assert.match(String(generic('POST', '/mcp-tools/profile-connectors')?.pattern), /\(\?<name>/, 'POST falls through to handleToolSet');
});

test('the NEW /mcp/profile-connectors patterns match', () => {
  const routes = createMcpToolsRoutes({} as never);
  const first = (method: string, p: string) => routes.find((r) => r.method === method && r.pattern.test(p));
  for (const [m, p] of [
    ['GET', '/mcp/profile-connectors'],
    ['POST', '/mcp/profile-connectors'],
    ['DELETE', '/mcp/profile-connectors/basic'],
  ] as const) {
    const hit = first(m, p);
    assert.ok(hit, `${m} ${p} must match a route`);
    assert.match(String(hit!.pattern), /profile-connectors/, `${m} ${p} must hit the profile-connectors route`);
  }
  // Confirms there is no /mcp/<x> catch-all in this table to out-order: an unrelated /mcp/<x>
  // literal (from mcp-api.routes.ts, not this file) wouldn't collide with these patterns either,
  // since every /mcp/* route anywhere in the app is a literal, never a capturing catch-all.
  assert.equal(first('GET', '/mcp/something-else'), undefined);
});
