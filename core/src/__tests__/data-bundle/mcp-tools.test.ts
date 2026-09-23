// core/src/__tests__/data-bundle/mcp-tools.test.ts
// The data_export / data_import MCP tools: registration end to end (advertised, handled,
// scoped, categorised, output-size classified, in the right profiles), argument coercion
// (the connector relay stringifies numbers, booleans AND arrays), the exact REST contract
// each action hits over the loopback hop, the confirm gate (apply without confirm:true
// PLANS and writes nothing), and coded errors carrying an actionable next step.
//
// Hermetic: HOME and the data dir point at temp dirs BEFORE any lm-assist module loads
// (configure.ts pulls the whole tool surface, and several modules read os.homedir() at
// load), and every handler test runs against an injected transport — no Core, no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-bundle-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-bundle-data-'));

import type * as ToolsModule from '../../mcp-server/tools/data-bundle';
const T = require('../../mcp-server/tools/data-bundle') as typeof ToolsModule;
const { LM_ASSIST_TOOL_DEFS, TOOL_SCOPES, assertScopesCoverTools } =
  require('../../mcp-server/configure') as typeof import('../../mcp-server/configure');
const { EXPANDED_HANDLERS } = require('../../mcp-server/tools/expanded') as typeof import('../../mcp-server/tools/expanded');
const { categoryOf } = require('../../mcp-server/registry/categories') as typeof import('../../mcp-server/registry/categories');
const { MEASURED_BUDGETS, NOT_MEASURED } = require('../../mcp-server/tool-output-budget') as typeof import('../../mcp-server/tool-output-budget');
const { PROFILE_DEFINITIONS, resolveProfileTools } = require('../../mcp-server/registry/profiles') as typeof import('../../mcp-server/registry/profiles');
const { playbookTopicForTool } = require('../../mcp-server/tool-topics') as typeof import('../../mcp-server/tool-topics');
const { GUIDE_HANDLERS } = require('../../mcp-server/tools/guide') as typeof import('../../mcp-server/tools/guide');

const TOOLS = ['data_export', 'data_import'];
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');

test('hermetic: HOME and the data dir are temp dirs', () => {
  assert.ok(process.env.HOME!.startsWith(os.tmpdir()));
  assert.ok(process.env.LM_ASSIST_DATA_DIR!.startsWith(os.tmpdir()));
});

// ─── registration ────────────────────────────────────────────────────────────

test('both tools are advertised, handled, scoped and categorised', () => {
  const advertised = new Set(LM_ASSIST_TOOL_DEFS.map((d) => d.name));
  for (const n of TOOLS) {
    assert.ok(advertised.has(n), `${n} is not advertised`);
    assert.equal(typeof EXPANDED_HANDLERS[n], 'function', `${n} has no EXPANDED_HANDLERS entry`);
    assert.equal(categoryOf(n), 'data', `${n} must be in the data category`);
    assert.equal(playbookTopicForTool(n), 'data', `${n} must resolve to the data playbook`);
  }
  // Worst action wins: create prunes and delete removes restore points — never an auto-approved read.
  assert.equal(TOOL_SCOPES.data_export, 'write');
  assert.equal(TOOL_SCOPES.data_import, 'admin');
  assert.doesNotThrow(() => assertScopesCoverTools());
});

test('both tools are output-size classified (data_export measured, data_import excused)', () => {
  assert.ok(MEASURED_BUDGETS.data_export, 'data_export (inventory by default) must be budgeted');
  assert.ok(MEASURED_BUDGETS.data_export.budgetBytes >= MEASURED_BUDGETS.data_export.measuredBytes);
  assert.ok(NOT_MEASURED.data_import, 'data_import writes, so it is excused with a reason');
  assert.ok(!(('data_import') in MEASURED_BUDGETS));
});

test('the data category puts them in extended + admin, never basic', () => {
  const names = LM_ASSIST_TOOL_DEFS.map((d) => d.name);
  const basic = resolveProfileTools(PROFILE_DEFINITIONS.basic, names);
  const ext = resolveProfileTools(PROFILE_DEFINITIONS.extended, names);
  const admin = resolveProfileTools(PROFILE_DEFINITIONS.admin, names);
  for (const n of TOOLS) {
    assert.ok(!basic.has(n), `${n} must not be in basic`);
    assert.ok(ext.has(n), `${n} must be in extended`);
    assert.ok(admin.has(n), `${n} must be in admin`);
  }
});

test('schemas: action enums per spec, no own `node` prop, confirm on import, terse defs', () => {
  const exp = T.dataExportToolDef.inputSchema as { properties: Record<string, any> };
  const imp = T.dataImportToolDef.inputSchema as { properties: Record<string, any> };
  assert.deepEqual(exp.properties.action.enum, ['inventory', 'create', 'list', 'inspect', 'delete']);
  assert.deepEqual(imp.properties.action.enum, ['plan', 'apply', 'fetch', 'takeover']);
  assert.deepEqual(imp.properties.policy.enum, ['merge', 'add-missing', 'replace']);
  for (const k of ['bundle', 'policy', 'sections', 'datasets', 'takeOwnership', 'confirm', 'fromNode', 'dataset', 'force']) {
    assert.ok(imp.properties[k], `data_import is missing ${k}`);
  }
  for (const k of ['bundle', 'sections', 'datasets', 'includeReplicas', 'includeKnowledge', 'includeClaudeMemory', 'note']) {
    assert.ok(exp.properties[k], `data_export is missing ${k}`);
  }
  // `node` is injected on every tool to ROUTE the call; a tool-owned `node` would shadow it.
  assert.ok(!exp.properties.node && !imp.properties.node);
  // The catalogue tax: each def is paid by every conversation on an extended/admin profile.
  for (const d of T.DATA_BUNDLE_TOOL_DEFS) {
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
    assert.ok(bytes <= 2200, `${d.name} def is ${bytes}B — keep it terse, prose lives in guide("data")`);
  }
});

test('guide("data") carries the export/import recipe and guide(tool) resolves to it', async () => {
  const g = text(await GUIDE_HANDLERS.guide({ topic: 'data_import' }));
  assert.match(g, /data_export/);
  assert.match(g, /data_import/);
  assert.match(g, /confirm:true/);
  assert.match(g, /takeover/);
});

// ─── argument coercion ───────────────────────────────────────────────────────

test('listArg accepts an array, a JSON array string, or a comma list', () => {
  assert.deepEqual(T.listArg(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(T.listArg('["x","y"]'), ['x', 'y']);
  assert.deepEqual(T.listArg('x, y ,z'), ['x', 'y', 'z']);
  assert.equal(T.listArg(undefined), undefined);
  assert.equal(T.listArg(''), undefined);
});

test('listArg never BROADENS a selection: [] stays [], a wrong type is refused', () => {
  // An import scoped to datasets:[] must not turn into "every dataset" on the way through.
  assert.deepEqual(T.listArg([]), []);
  assert.throws(() => T.listArg({ backlog: true }, 'datasets'), /datasets must be a list/);
});

test('the schema enums match the bundle service (no drift between tool and service)', () => {
  const { SECTION_GROUPS, IMPORT_POLICIES } = require('../../data/bundle') as typeof import('../../data/bundle');
  assert.deepEqual(T.SECTION_GROUP_ENUM, [...SECTION_GROUPS]);
  assert.deepEqual(T.POLICY_ENUM, [...IMPORT_POLICIES]);
});

test('exportBody coerces relay-stringified booleans and drops what was not asked', () => {
  assert.deepEqual(T.exportBody({}), {});
  assert.deepEqual(
    T.exportBody({ includeKnowledge: 'true', includeReplicas: 'false', includeClaudeMemory: 1, sections: 'datasets,config', datasets: '["backlog"]', note: 'pre-move' }),
    { sections: ['datasets', 'config'], datasets: ['backlog'], includeKnowledge: true, includeClaudeMemory: true, note: 'pre-move' },
  );
});

test('importBody passes only the selection args, booleans coerced', () => {
  assert.deepEqual(T.importBody({}), {});
  assert.deepEqual(
    T.importBody({ policy: 'replace', sections: ['datasets'], datasets: 'backlog', takeOwnership: 'true', force: '1', confirm: true, junk: 1 }),
    { policy: 'replace', sections: ['datasets'], datasets: ['backlog'], takeOwnership: true, force: true },
  );
});

// ─── handlers over an injected transport ─────────────────────────────────────

interface Call { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: Record<string, unknown> }

function fake(routes: Record<string, unknown | ((c: Call) => unknown)>) {
  const calls: Call[] = [];
  const answer = (c: Call) => {
    calls.push(c);
    const k = `${c.method} ${c.path}`;
    if (!(k in routes)) return { success: false, error: { code: 'NOT_FOUND', message: `no route ${k}` } };
    const v = routes[k];
    return typeof v === 'function' ? (v as (c: Call) => unknown)(c) : v;
  };
  T._setBundleTransportForTests({
    get: async (p) => answer({ method: 'GET', path: p }),
    post: async (p, body) => answer({ method: 'POST', path: p, body }),
    del: async (p) => answer({ method: 'DELETE', path: p }),
  });
  return calls;
}
const okEnv = (data: unknown) => ({ success: true, data });
const run = (tool: string, args: Record<string, unknown>) => T.DATA_BUNDLE_HANDLERS[tool](args);

const ID = 'lmb-20260923-180000-abcdef';
const SOURCE = { nodeId: 'gw-src', hostname: 'src-host', platform: 'linux', lmAssistVersion: '0.2.6', mode: 'prod' as const, cluster: 'alpha' };

function inventory(): ToolsModule.InventoryView {
  return {
    node: { nodeId: 'gw-self', hostname: 'self-host', cluster: 'alpha', mode: 'prod' },
    roster: { queried: true, available: true, onlinePeers: 2 },
    datasets: [
      { id: 'backlog', backend: 'cache', owned: true, ownerNode: 'gw-self', scope: 'fleet', syncMode: 'full', export: 'default', records: 239, tombstones: 3, approxBytes: 1_400_000 },
      { id: 'mission-workflows', backend: 'cache', owned: false, ownerNode: 'gw-old', origin: { machineId: 'gw-old', hostname: 'old-host' }, originOnline: false, scope: 'fleet', syncMode: 'full', export: 'opt-in', reason: 'replica', records: 12, tombstones: 0, approxBytes: 40_000 },
      { id: 'knowledge', backend: 'knowledge', owned: true, ownerNode: 'gw-self', scope: 'node', syncMode: 'none', export: 'never', reason: 'system dataset', records: null, tombstones: null, approxBytes: null },
    ],
    orphans: [{ id: 'old-thing', backend: 'cache', bytes: 8192 }],
    sections: {
      config: [{ id: 'scheduled-jobs', title: 'Scheduled jobs', default: true }],
      files: [{ id: 'knowledge', title: 'Knowledge base', default: false, option: 'includeKnowledge' }],
    },
    neverExported: ['secrets: api-token*', 'runtime datasets: node-clusters, mcp-bootstrap'],
    sync: { lastRun: '2026-09-23T17:55:00.000Z', peersChecked: 2, datasetsReplicated: 9, errors: ['pull x: timeout'] },
    bundles: { count: 1, newest: ID },
  };
}

test('data_export with no args is the inventory (GET /data/bundles/inventory)', async () => {
  const calls = fake({ 'GET /data/bundles/inventory': okEnv(inventory()) });
  const r = await run('data_export', {});
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /data/bundles/inventory']);
  const t = text(r);
  assert.match(t, /self-host/);
  assert.match(t, /backlog/);
  assert.match(t, /239/);
  // an offline origin's replica gets the actionable takeover call
  // …pinned to the node that answered, so a copied call never runs on the connector's default node
  assert.match(t, /data_import\(\{action:"takeover", dataset:"mission-workflows", node:"gw-self"\}\)/);
  assert.match(t, /old-thing/);
  assert.match(t, /pull x: timeout/);
});

test('create POSTs the export options to /data/bundles and says how to move the bundle', async () => {
  const res: ToolsModule.ExportView = {
    bundleId: ID, path: `/tmp/bundles/${ID}.lmbundle.gz`, sizeBytes: 123_456, sha256: 'f'.repeat(64),
    createdAt: '2026-09-23T18:00:00.000Z', note: 'pre-move',
    sections: [{ kind: 'dataset', id: 'backlog', title: 'backlog', count: 239, bytes: 900_000, tombstones: 3, owned: true, scope: 'fleet', syncMode: 'full', backend: 'cache', warnings: [] }],
    totals: { entries: 241, uncompressedBytes: 900_100 },
    excluded: [{ id: 'knowledge', reason: 'system dataset' }],
    warnings: [], pruned: [],
    next: `on the target node: data_import{action:'fetch', fromNode:'gw-self', bundleId:'${ID}'}, then action:'plan'`,
  };
  const calls = fake({ 'POST /data/bundles': okEnv(res) });
  const r = await run('data_export', { action: 'create', includeKnowledge: 'true', note: 'pre-move' });
  assert.ok(!r.isError, text(r));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'POST', path: '/data/bundles', body: { includeKnowledge: true, note: 'pre-move' } });
  const t = text(r);
  assert.match(t, new RegExp(ID));
  assert.match(t, /lmbundle\.gz/);
  assert.match(t, /action:'fetch'/);
});

test('list / inspect / delete hit the store routes; inspect and delete need a bundle', async () => {
  const listed = [{ bundleId: ID, sizeBytes: 5000, mtime: '2026-09-23T18:00:00.000Z', createdAt: '2026-09-23T18:00:00.000Z', source: SOURCE, sections: [], totals: { entries: 3, uncompressedBytes: 900 } }];
  const calls = fake({
    // the route wraps the list: {bundles:[…]} (a bare array is accepted too)
    'GET /data/bundles': okEnv({ bundles: listed }),
    [`GET /data/bundles/${ID}`]: okEnv({ bundleId: ID, sizeBytes: 5000, manifest: { t: 'manifest', format: 'lm-assist-bundle', formatVersion: 1, bundleId: ID, createdAt: '2026-09-23T18:00:00.000Z', source: SOURCE, options: {}, sections: [], totals: { entries: 3, uncompressedBytes: 900 } } }),
    [`DELETE /data/bundles/${ID}`]: okEnv({ bundleId: ID, deleted: true }),
  });
  assert.match(text(await run('data_export', { action: 'list' })), new RegExp(ID));
  assert.match(text(await run('data_export', { action: 'inspect', bundle: ID })), /src-host/);
  // delete removes a restore point: without confirm:true it never reaches the route.
  const unconfirmed = await run('data_export', { action: 'delete', bundle: ID });
  assert.ok(unconfirmed.isError);
  assert.match(text(unconfirmed), /CONFIRM_REQUIRED: deleting .* removes a restore point/);
  assert.match(text(await run('data_export', { action: 'delete', bundle: ID, confirm: true })), /Deleted/);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /data/bundles', `GET /data/bundles/${ID}`, `DELETE /data/bundles/${ID}`]);

  const before = calls.length;
  for (const action of ['inspect', 'delete']) {
    const r = await run('data_export', { action });
    assert.ok(r.isError, `${action} without bundle must refuse`);
    assert.match(text(r), /bundle is required/);
  }
  assert.equal(calls.length, before, 'a refused call never reaches Core');
});

test('an unknown action is refused with the valid list, and nothing is called', async () => {
  const calls = fake({});
  const r = await run('data_export', { action: 'restore' });
  assert.ok(r.isError);
  assert.match(text(r), /inventory, create, list, inspect, delete/);
  const r2 = await run('data_import', { action: 'merge', bundle: ID });
  assert.ok(r2.isError);
  assert.match(text(r2), /plan, apply, fetch, takeover/);
  assert.equal(calls.length, 0);
});

function planResult(dryRun: boolean): ToolsModule.ImportView {
  const counts = { add: 2, update: 1, skipOlder: 0, skipIdentical: 5, skipExists: 0, tooLarge: 0, neutralized: 0, skipDiffers: 0, skipped: 0, importedDisabled: 0 };
  const zero = { add: 0, update: 0, skipOlder: 0, skipIdentical: 0, skipExists: 0, tooLarge: 0, neutralized: 0, skipDiffers: 0, skipped: 0, importedDisabled: 0 };
  return {
    bundleId: ID, policy: 'merge', dryRun, source: SOURCE, createdAt: '2026-09-23T18:00:00.000Z',
    sections: [
      { kind: 'dataset', id: 'backlog', action: 'import', counts, samples: { add: ['bl_1', 'bl_2'], update: ['bl_3'] }, warnings: [], ...(dryRun ? {} : { applied: { ...zero, add: 2, update: 1 } }) },
      { kind: 'dataset', id: 'mission-workflows', action: 'refuse', counts: zero, samples: {}, warnings: [],
        refused: { code: 'REPLICA_READ_ONLY', reason: '"mission-workflows" is a read-only replica here; its origin is old-host (gw-old).' } },
    ],
    totals: counts, ...(dryRun ? {} : { applied: { ...zero, add: 2, update: 1 } }),
    refused: 1, warnings: ['source: exported on src-host (gw-src), not this node'],
  };
}

test('plan POSTs the selection to /data/bundles/:id/plan and renders counts, samples and refusal fixes', async () => {
  const calls = fake({ [`POST /data/bundles/${ID}/plan`]: okEnv(planResult(true)) });
  const r = await run('data_import', { action: 'plan', bundle: ID, policy: 'merge', datasets: ['backlog', 'mission-workflows'], takeOwnership: 'false' });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls, [{ method: 'POST', path: `/data/bundles/${ID}/plan`, body: { policy: 'merge', datasets: ['backlog', 'mission-workflows'] } }]);
  const t = text(r);
  assert.match(t, /DRY RUN/);
  assert.match(t, /bl_1/);
  assert.match(t, /REPLICA_READ_ONLY/);
  assert.match(t, /takeOwnership:true/, 'a replica refusal names the takeover route');
  assert.match(t, /confirm:true/, 'the plan says how to apply');
});

test('apply WITHOUT confirm:true plans instead, says nothing was written, and never calls /apply', async () => {
  const calls = fake({ [`POST /data/bundles/${ID}/plan`]: okEnv(planResult(true)) });
  for (const confirm of [undefined, false, 'false', 'yes']) {
    const r = await run('data_import', { action: 'apply', bundle: ID, ...(confirm === undefined ? {} : { confirm }) });
    assert.ok(!r.isError, text(r));
    const t = text(r);
    assert.match(t, /NOTHING WAS WRITTEN/);
    assert.match(t, /confirm:true/);
  }
  assert.ok(calls.every((c) => c.path.endsWith('/plan')), `only /plan may be called: ${calls.map((c) => c.path).join(', ')}`);
  assert.ok(calls.every((c) => !('confirm' in (c.body ?? {}))));
});

test('apply with confirm (relay-stringified "true") POSTs /apply with confirm:true', async () => {
  const calls = fake({ [`POST /data/bundles/${ID}/apply`]: okEnv(planResult(false)) });
  const r = await run('data_import', { action: 'apply', bundle: ID, confirm: 'true', policy: 'add-missing' });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls, [{ method: 'POST', path: `/data/bundles/${ID}/apply`, body: { policy: 'add-missing', confirm: true } }]);
  const t = text(r);
  assert.match(t, /APPLIED/);
  assert.doesNotMatch(t, /DRY RUN/);
});

test('bundle "received:<name>" is imported from the inbox ONCE, then planned by its new id', async () => {
  const NEW = 'lmb-20260923-181500-123456';
  const calls = fake({
    'POST /data/bundles/received/backup.lmbundle.gz': okEnv({ bundleId: NEW, sizeBytes: 5000, sha256: 'a'.repeat(64), manifest: { bundleId: ID, source: SOURCE, sections: [] }, imported: { importedFrom: ID, via: 'received', at: 'now', name: 'backup.lmbundle.gz' } }),
    [`POST /data/bundles/${NEW}/plan`]: okEnv({ ...planResult(true), bundleId: NEW }),
  });
  const r = await run('data_import', { action: 'plan', bundle: 'received:backup.lmbundle.gz' });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /data/bundles/received/backup.lmbundle.gz', `POST /data/bundles/${NEW}/plan`]);
  assert.match(text(r), new RegExp(`bundle:"${NEW}"`), 'the caller is told which id to use from now on');
});

test('fetch POSTs {fromNode, bundleId} (bundleId accepted as an alias of bundle)', async () => {
  const NEW = 'lmb-20260923-182000-654321';
  const fetched = { bundleId: NEW, sizeBytes: 5000, sha256: 'b'.repeat(64), fromNode: 'gw-src', sourceBundleId: ID, chunks: 1,
    manifest: { bundleId: ID, createdAt: '2026-09-23T18:00:00.000Z', source: SOURCE, sections: [], totals: { entries: 3, uncompressedBytes: 900 } },
    imported: { importedFrom: ID, via: 'fetch', at: 'now', fromNode: 'gw-src' } };
  const calls = fake({ 'POST /data/bundles/fetch': okEnv(fetched) });
  for (const args of [{ bundle: ID }, { bundleId: ID }]) {
    const r = await run('data_import', { action: 'fetch', fromNode: 'gw-src', ...args });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), new RegExp(`data_import\\(\\{action:"plan", bundle:"${NEW}"\\}\\)`));
  }
  assert.deepEqual(calls.map((c) => c.body), [{ fromNode: 'gw-src', bundleId: ID }, { fromNode: 'gw-src', bundleId: ID }]);
  const r = await run('data_import', { action: 'fetch', bundle: ID });
  assert.ok(r.isError);
  assert.match(text(r), /fromNode is required/);
});

test('takeover POSTs /data/datasets/:id/takeover with force coerced; needs a dataset', async () => {
  const calls = fake({
    'POST /data/datasets/mission-workflows/takeover': okEnv({ dataset: 'mission-workflows', records: 12, tombstones: 0, superseded: { machineId: 'gw-old', hostname: 'old-host' }, ownerNode: 'gw-self', visibility: 'cross-node-readable', forced: true, note: 'this node now owns "mission-workflows".' }),
  });
  const r = await run('data_import', { action: 'takeover', dataset: 'mission-workflows', force: 'true' });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(calls, [{ method: 'POST', path: '/data/datasets/mission-workflows/takeover', body: { force: true } }]);
  assert.match(text(r), /old-host/);
  assert.match(text(r), /FORCED/);
  const r2 = await run('data_import', { action: 'takeover' });
  assert.ok(r2.isError);
  assert.match(text(r2), /dataset is required/);
});

test('ids in a path are URL-encoded — a caller cannot steer the loopback route', async () => {
  const calls = fake({});
  await run('data_import', { action: 'takeover', dataset: '../bundles/x?y' });
  await run('data_export', { action: 'inspect', bundle: '../../health' });
  assert.deepEqual(calls.map((c) => c.path), ['/data/datasets/..%2Fbundles%2Fx%3Fy/takeover', '/data/bundles/..%2F..%2Fhealth']);
  // A bare dot segment survives encodeURIComponent and the URL parser resolves it — refuse it.
  for (const r of [
    await run('data_import', { action: 'takeover', dataset: '..' }),
    await run('data_export', { action: 'delete', bundle: '.' }),
    await run('data_import', { action: 'plan', bundle: 'received:..' }),
  ]) {
    assert.ok(r.isError);
    assert.match(text(r), /BAD_REQUEST: invalid/);
  }
  assert.equal(calls.length, 2, 'a dot segment never reaches Core');
});

test('a malformed selection is refused before anything is called', async () => {
  const calls = fake({});
  const r = await run('data_import', { action: 'apply', bundle: ID, confirm: true, datasets: { backlog: 1 } });
  assert.ok(r.isError);
  assert.match(text(r), /BAD_REQUEST: datasets must be a list/);
  assert.equal(calls.length, 0);
});

test('a coded route error is surfaced with its code and the next step', async () => {
  fake({ 'POST /data/datasets/backlog/takeover': { success: false, error: { code: 'ORIGIN_ONLINE', message: 'the origin of "backlog", h1 (gw1), is online' } } });
  const r = await run('data_import', { action: 'takeover', dataset: 'backlog' });
  assert.ok(r.isError);
  assert.match(text(r), /ORIGIN_ONLINE/);
  assert.match(text(r), /→/);

  fake({ [`POST /data/bundles/${ID}/plan`]: { success: false, error: { code: 'BUNDLE_CORRUPT', message: 'end-hash check failed' } } });
  const r2 = await run('data_import', { action: 'plan', bundle: ID });
  assert.ok(r2.isError);
  assert.match(text(r2), /BUNDLE_CORRUPT: end-hash/);
  assert.match(text(r2), /re-fetch|re-export/);
});

test('a `|` is escaped inside a table cell, and nowhere else', () => {
  const e = T.renderToolError('BAD_REQUEST', 'unknown policy — expected merge | add-missing | replace');
  assert.match(e, /merge \| add-missing \| replace/);
  assert.doesNotMatch(e, /\\\|/);
  const inv = inventory();
  inv.datasets[0].id = 'odd|id';
  assert.match(T.renderInventory(inv), /\| odd\\\|id \|/, 'a pipe in a cell must not split the row');
});

test('a write that times out says it may still land (never "nothing happened")', async () => {
  T._setBundleTransportForTests({
    get: async () => { throw new Error('unused'); },
    post: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; },
    del: async () => { throw new Error('unused'); },
  });
  const r = await run('data_import', { action: 'apply', bundle: ID, confirm: true });
  assert.ok(r.isError);
  assert.match(text(r), /may still/i);
});

test('transport restored', () => {
  T._setBundleTransportForTests(null);
});

test('copy-paste hints carry node (and force) so a follow-up runs where the plan ran', async () => {
  const { renderImport, renderFetch, renderList } = T;
  const plan = { bundleId: ID, policy: 'replace', dryRun: true, sections: [], totals: {}, refused: 0, warnings: [] } as any;
  const t = renderImport(plan, { mode: 'plan', node: 'gw-123', force: true });
  assert.match(t, /data_import\(\{action:"apply", bundle:"[^"]+", node:"gw-123", policy:"replace", force:true, confirm:true\}\)/);
  const f = renderFetch({ bundleId: ID, sourceBundleId: ID, fromNode: 'gw-a', chunks: 1, sizeBytes: 10, sha256: 'a'.repeat(64), manifest: undefined } as any, { node: 'gw-123' });
  assert.match(f, /Next: data_import\(\{action:"plan", bundle:"[^"]+", node:"gw-123"\}\)/);
  assert.match(renderList([], { node: 'gw-123' }), /data_export\(\{action:"create", node:"gw-123"\}\)/);
});
