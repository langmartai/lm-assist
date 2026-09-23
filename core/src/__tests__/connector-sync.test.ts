/**
 * syncConnectorForPluginTools across SEVERAL connectors of one node.
 *
 * The old sync picked the first `/langmart/i` connector: with per-profile connectors only one got
 * upkeep and the rest kept stale lists silently, and a dev Core acted on the production connector.
 * These pin the replacement: every connector of THIS hub (by URL), each filtered by its own
 * profile, "listed yet" checked per connector, and one batched write.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Node default = admin (an empty data dir) — never the operator's real profile file.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-connector-sync-'));
const PROD = 'https://mcp.langmart.ai';
const DEV = 'https://mcp.xeenhub.com';
process.env.MCP_PUBLIC_BASE = PROD;

import { syncConnectorForPluginTools } from '../mcp-server/plugins/connector-sync';

const U = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2'; // lm-assist langmart          (unpinned)
const P = '2a2a2a2a-0000-4000-8000-00000000000a'; // lm-assist langmart platform (pinned)
const B = '3b3b3b3b-0000-4000-8000-00000000000b'; // lm-assist langmart basic    (pinned)
const D = '4c4c4c4c-0000-4000-8000-00000000000c'; // lm-assist dev               (other hub)
const G = '5d5d5d5d-0000-4000-8000-00000000000d'; // Google Drive
const TOOL = 'ext__langmart__models_list';

function roster(listedOn: string[]) {
  const s = (uuid: string, name: string, url: string) => ({
    uuid, name, url, connected: true, authStatus: 'authenticated',
    tools: listedOn.includes(uuid) ? ['search', TOOL] : ['search'],
  });
  return [
    s(G, 'Google Drive', 'https://drivemcp.googleapis.com/mcp/v1'),
    s(U, 'lm-assist langmart', `${PROD}/mcp`),
    s(P, 'lm-assist langmart platform', `${PROD}/mcp/platform`),
    s(B, 'lm-assist langmart basic', `${PROD}/mcp/basic`),
    s(D, 'lm-assist dev', `${DEV}/mcp`),
  ];
}

const realFetch = global.fetch;
const calls: Array<{ method: string; url: string; body?: any }> = [];

/** Loopback stub. The FIRST server listing is before the refetch; later ones are after it. */
function stub(opts: { before?: unknown; after?: unknown; failList?: boolean } = {}): void {
  let lists = 0;
  // @ts-expect-error test stub
  global.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET';
    const u = String(url);
    calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined });
    let status = 200;
    let env: unknown;
    if (u.endsWith('/claude-ai/mcp/servers') && method === 'GET') {
      lists++;
      if (opts.failList) {
        status = 400;
        env = { success: false, error: { code: 'CLAUDEAI_SESSION_NOT_CONFIGURED', message: 'No claude.ai session configured' } };
      } else {
        env = { success: true, data: { servers: lists === 1 ? (opts.before ?? roster([])) : (opts.after ?? roster([])) } };
      }
    } else if (u.endsWith('/claude-ai/mcp/tool-settings/batch')) {
      const updates = JSON.parse(init!.body!).updates as Array<{ connectorUuid: string; autoApprove?: { tools?: string[] } }>;
      env = {
        success: true,
        data: {
          patched: true, totalKeys: 99,
          results: updates.map((x) => ({ connectorUuid: x.connectorUuid, accessChanged: [TOOL], approved: x.autoApprove?.tools ?? [], skipped: [] })),
        },
      };
    } else {
      env = { success: true, data: {} };
    }
    const text = JSON.stringify(env);
    return { ok: status < 400, status, async text() { return text; }, async json() { return env; } };
  };
}

afterEach(() => { global.fetch = realFetch; calls.length = 0; process.env.MCP_PUBLIC_BASE = PROD; });

const clearedUuids = () => calls.filter((c) => c.url.endsWith('/clear-cache')).map((c) => c.url.split('/').slice(-2)[0]);
const batches = () => calls.filter((c) => c.url.endsWith('/claude-ai/mcp/tool-settings/batch'));

test('enabling a plugin syncs EVERY connector that advertises it — and only those — in ONE batched write', async () => {
  stub({ after: roster([U]) });
  const r = await syncConnectorForPluginTools({ addedTools: [TOOL] });

  assert.deepEqual(clearedUuids().sort(), [P, U].sort(), 'unpinned (admin default) + platform; basic hides ext__, dev/Drive are not ours');
  assert.equal(batches().length, 1, 'tool access + auto-approve for all connectors in one read-modify-write');
  assert.deepEqual(batches()[0].body.updates.map((x: any) => x.connectorUuid).sort(), [P, U].sort());
  for (const x of batches()[0].body.updates) {
    assert.deepEqual(x.access, { [TOOL]: true });
    assert.deepEqual(x.autoApprove, { enable: true, tools: [TOOL] });
  }
  assert.ok(!calls.some((c) => /\/(tool-access|auto-approve)$/.test(c.url)), 'no per-connector writes (they race on the shared map)');

  assert.equal(r.connector?.uuid, U, 'the preferred connector is the unpinned one');
  const byUuid = new Map((r.connectors || []).map((c) => [c.uuid, c]));
  assert.equal(byUuid.get(B)?.touched, false);
  assert.equal(byUuid.get(U)?.toolsListed, true, 'checked against ITS OWN tool list');
  assert.equal(byUuid.get(P)?.toolsListed, false, 'being listed on another connector does not count');
  assert.equal(r.toolsListed, false);
  assert.equal(r.ok, true, 'toolsListed:false is reported, not a failed step');
});

test('autoApprove:false writes tool access only', async () => {
  stub({ after: roster([U, P]) });
  await syncConnectorForPluginTools({ addedTools: [TOOL], autoApprove: false });
  for (const x of batches()[0].body.updates) assert.equal(x.autoApprove, undefined);
});

test('disabling a plugin clears the caches that listed it and writes nothing', async () => {
  stub();
  const r = await syncConnectorForPluginTools({ removedTools: [TOOL] });
  assert.deepEqual(clearedUuids().sort(), [P, U].sort());
  assert.equal(batches().length, 0);
  assert.equal(r.ok, true);
});

test('a manual sync with no tool names refreshes every connector of this node', async () => {
  stub();
  await syncConnectorForPluginTools({});
  assert.deepEqual(clearedUuids().sort(), [B, P, U].sort());
  assert.equal(batches().length, 0);
});

test('a dev Core never touches the production connectors', async () => {
  process.env.MCP_PUBLIC_BASE = DEV;
  stub();
  await syncConnectorForPluginTools({ addedTools: [TOOL] });
  assert.deepEqual(clearedUuids(), [D]);
});

test('no claude.ai cookie on this node → deferred, nothing cleared or written', async () => {
  stub({ failList: true });
  const r = await syncConnectorForPluginTools({ addedTools: [TOOL] });
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].step, 'resolve-connector');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('no connector of this node → a loud failure, never a first-match fallback', async () => {
  stub({ before: roster([]).filter((s) => s.uuid === G || s.uuid === D) });
  const r = await syncConnectorForPluginTools({ addedTools: [TOOL] });
  assert.equal(r.ok, false);
  assert.match(r.steps[0].detail || '', /profile-connectors/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});
