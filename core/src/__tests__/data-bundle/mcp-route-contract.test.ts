// core/src/__tests__/data-bundle/mcp-route-contract.test.ts
// CONTRACT: data_export / data_import against the REAL /data/bundles route handlers.
//
// mcp-tools.test.ts pins the paths and bodies the tools send; this proves the routes accept
// them. Each call goes through what the loopback hop does to it — a URL (percent-encoding
// kept, dot segments resolved), a JSON round trip of the body, the route's own body guard
// (unknown fields are refused LOUDLY there, so one stray key would fail a whole action), and
// a JSON round trip of the envelope — and lands on an injected service that records the
// arguments it was called with. A drift on either side (a renamed field, a wrapped list, a
// stricter id check) fails here instead of on a live node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-contract-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcp-contract-data-'));

import type * as ToolsModule from '../../mcp-server/tools/data-bundle';
import type { ParsedRequest, RouteHandler } from '../../routes/index';
import type { BundleRoutesService } from '../../routes/core/data-bundle.routes';
const T = require('../../mcp-server/tools/data-bundle') as typeof ToolsModule;
const { createDataBundleRoutes } = require('../../routes/core/data-bundle.routes') as typeof import('../../routes/core/data-bundle.routes');
const { BundleServiceError } = require('../../data/bundle') as typeof import('../../data/bundle');

const ID = 'lmb-20260923-180000-abcdef';
const NEW = 'lmb-20260923-181500-123456';
const SOURCE = { nodeId: 'gw-src', hostname: 'src-host', platform: 'linux', lmAssistVersion: '0.2.6', mode: 'prod' as const };
const ZERO = { add: 0, update: 0, skipOlder: 0, skipIdentical: 0, skipExists: 0, tooLarge: 0, neutralized: 0, skipDiffers: 0, skipped: 0, importedDisabled: 0 };
const MANIFEST = {
  t: 'manifest' as const, format: 'lm-assist-bundle' as const, formatVersion: 1, bundleId: ID, createdAt: '2026-09-23T18:00:00.000Z',
  source: SOURCE, options: {}, sections: [], totals: { entries: 0, uncompressedBytes: 0 },
};
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');

/** A service that records every call and answers with the service's own result shapes. */
function recordingService(overrides: Partial<BundleRoutesService> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const importResult = (id: string, dryRun: boolean) => ({
    bundleId: id, policy: 'merge' as const, dryRun, source: SOURCE, createdAt: MANIFEST.createdAt,
    sections: [{ kind: 'dataset' as const, id: 'backlog', counts: { ...ZERO, add: 1 }, samples: { add: ['bl_1'] }, warnings: [] }],
    totals: { ...ZERO, add: 1 }, refused: 0, warnings: [], ...(dryRun ? {} : { applied: { ...ZERO, add: 1 } }),
  });
  const svc: BundleRoutesService = {
    inventory: async () => {
      calls.push(['inventory']);
      return {
        node: { nodeId: 'gw-self', hostname: 'self-host', cluster: null, mode: 'dev' }, roster: { queried: false },
        datasets: [], orphans: [], sections: { config: [], files: [] }, neverExported: [], sync: null, bundles: { count: 0 },
      };
    },
    listBundles: async () => { calls.push(['listBundles']); return [{ bundleId: ID, sizeBytes: 10, mtime: MANIFEST.createdAt, source: SOURCE }]; },
    createExport: async (o) => {
      calls.push(['createExport', o]);
      return { bundleId: ID, path: `/x/${ID}.lmbundle.gz`, sizeBytes: 10, sha256: 'a'.repeat(64), createdAt: MANIFEST.createdAt,
        sections: [], totals: MANIFEST.totals, excluded: [], warnings: [], pruned: [], next: 'fetch it' };
    },
    inspect: async (id) => { calls.push(['inspect', id]); return { bundleId: id, sizeBytes: 10, manifest: MANIFEST }; },
    readChunk: () => { throw new Error('unused'); },
    deleteBundle: (id) => { calls.push(['deleteBundle', id]); return { bundleId: id, deleted: true }; },
    uploadChunk: async () => { throw new Error('unused'); },
    importReceived: async (name) => {
      calls.push(['importReceived', name]);
      return { bundleId: NEW, manifest: MANIFEST, sizeBytes: 10, sha256: 'b'.repeat(64), imported: { importedFrom: ID, via: 'received' as const, at: 'now', name } };
    },
    fetchFromPeer: async (fromNode, bundleId) => {
      calls.push(['fetchFromPeer', fromNode, bundleId]);
      return { bundleId: NEW, manifest: MANIFEST, sizeBytes: 10, sha256: 'c'.repeat(64), imported: { importedFrom: bundleId, via: 'fetch' as const, at: 'now', fromNode },
        fromNode, sourceBundleId: bundleId, chunks: 1 };
    },
    plan: async (id, o) => { calls.push(['plan', id, o]); return importResult(id, true); },
    apply: async (id, o) => { calls.push(['apply', id, o]); return importResult(id, false); },
    takeover: async (id, o) => {
      calls.push(['takeover', id, o]);
      return { dataset: id, records: 3, tombstones: 0, superseded: { machineId: 'gw-old', hostname: 'old-host' }, ownerNode: 'gw-self',
        visibility: 'cross-node-readable', forced: !!o?.force, note: 'owned now' };
    },
    ...overrides,
  };
  return { svc, calls };
}

/** The loopback hop, minus the socket: URL → route match → handler → JSON envelope. */
function viaRoutes(svc: BundleRoutesService): ToolsModule.BundleTransport {
  const routes: RouteHandler[] = createDataBundleRoutes({} as never, { service: () => svc });
  const dispatch = async (method: string, urlPath: string, body?: Record<string, unknown>) => {
    const u = new URL(urlPath, 'http://127.0.0.1');
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = u.pathname.match(r.pattern);
      if (!m) continue;
      const wire = body === undefined ? undefined : JSON.stringify(body);
      const req: ParsedRequest = {
        method, path: u.pathname, params: m.groups ?? {}, query: Object.fromEntries(u.searchParams),
        body: wire === undefined ? {} : JSON.parse(wire), rawBody: wire ?? '', headers: {}, clientIp: '127.0.0.1',
      };
      return JSON.parse(JSON.stringify(await r.handler(req, {} as never)));
    }
    return { success: false, error: { code: 'NOT_FOUND', message: `no route ${method} ${u.pathname}` } };
  };
  return {
    get: (p) => dispatch('GET', p),
    post: (p, b) => dispatch('POST', p, b),
    del: (p) => dispatch('DELETE', p),
  };
}

const run = (tool: string, args: Record<string, unknown>) => T.DATA_BUNDLE_HANDLERS[tool](args);

function use(overrides: Partial<BundleRoutesService> = {}) {
  const r = recordingService(overrides);
  T._setBundleTransportForTests(viaRoutes(r.svc));
  return r.calls;
}

async function expectOk(tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await run(tool, args);
  assert.ok(!r.isError, `${tool} ${JSON.stringify(args)} was refused by the real route: ${text(r)}`);
  return text(r);
}

test('data_export: every action is accepted by the real routes with the options intact', async () => {
  const calls = use();
  await expectOk('data_export', {});
  assert.match(await expectOk('data_export', { action: 'list' }), new RegExp(ID), 'the route wraps the list as {bundles}');
  await expectOk('data_export', {
    action: 'create', sections: 'datasets,config', datasets: ['backlog'], includeReplicas: 'true',
    includeKnowledge: true, includeClaudeMemory: '1', note: 'before the move',
  });
  assert.match(await expectOk('data_export', { action: 'inspect', bundle: ID }), /src-host/);
  assert.match(await expectOk('data_export', { action: 'delete', bundle: ID, confirm: true }), /Deleted/);
  assert.deepEqual(calls, [
    ['inventory'],
    ['listBundles'],
    ['createExport', { sections: ['datasets', 'config'], datasets: ['backlog'], includeReplicas: true, includeKnowledge: true, includeClaudeMemory: true, note: 'before the move' }],
    ['inspect', ID],
    ['deleteBundle', ID],
  ]);
});

test('data_import plan/apply: the selection arrives intact; apply reaches the service ONLY with confirm', async () => {
  const calls = use();
  const sel = { policy: 'add-missing', sections: ['datasets'], datasets: 'backlog,missions', takeOwnership: 'true', force: true };
  await expectOk('data_import', { action: 'plan', bundle: ID, ...sel });
  assert.match(await expectOk('data_import', { action: 'apply', bundle: ID, ...sel }), /NOTHING WAS WRITTEN/);
  assert.match(await expectOk('data_import', { action: 'apply', bundle: ID, confirm: 'true', ...sel }), /APPLIED/);
  const opts = { policy: 'add-missing', sections: ['datasets'], datasets: ['backlog', 'missions'], takeOwnership: true, force: true };
  assert.deepEqual(calls, [
    ['plan', ID, opts],
    ['plan', ID, opts],
    ['apply', ID, { ...opts, confirm: true }],
  ]);
});

test('data_import received:<name> → importReceived once, then plan by the new id', async () => {
  const calls = use();
  const t = await expectOk('data_import', { action: 'plan', bundle: 'received:weekly.lmbundle.gz' });
  assert.match(t, new RegExp(`bundle:"${NEW}"`));
  assert.deepEqual(calls, [['importReceived', 'weekly.lmbundle.gz'], ['plan', NEW, {}]]);
});

test('data_import fetch and takeover reach the service with the right arguments', async () => {
  const calls = use();
  assert.match(await expectOk('data_import', { action: 'fetch', fromNode: 'gw-src', bundleId: ID }), new RegExp(NEW));
  assert.match(await expectOk('data_import', { action: 'takeover', dataset: 'mission-workflows', force: 'true' }), /old-host/);
  await expectOk('data_import', { action: 'takeover', dataset: 'backlog' });
  assert.deepEqual(calls, [
    ['fetchFromPeer', 'gw-src', ID],
    ['takeover', 'mission-workflows', { force: true }],
    ['takeover', 'backlog', { force: false }],
  ]);
});

test('a service refusal crosses the route with its code, and the tool adds the next step', async () => {
  use({
    takeover: async () => { throw new BundleServiceError('ORIGIN_ONLINE', 'the origin of "backlog", old-host (gw-old), is online', { machineId: 'gw-old', hostname: 'old-host' }); },
  });
  const r = await run('data_import', { action: 'takeover', dataset: 'backlog' });
  assert.ok(r.isError);
  const t = text(r);
  assert.match(t, /ORIGIN_ONLINE: the origin of "backlog", old-host \(gw-old\), is online/);
  assert.match(t, /old-host/);
  assert.match(t, /→ the origin is online/);
});

test('a malformed id is refused by the route with a code the tool explains', async () => {
  use();
  const r = await run('data_export', { action: 'inspect', bundle: 'not-a-bundle' });
  assert.ok(r.isError);
  assert.match(text(r), /BUNDLE_ID_INVALID/);
  assert.match(text(r), /→ a bundle id is lmb-/);
});

test('transport restored', () => {
  T._setBundleTransportForTests(null);
});
