/**
 * /mcp-tools route handlers (spec §4.5) — port-injected, mission.routes idioms:
 * bare {success,data}/{success,error} envelopes; reads local; catalog join with
 * override/disabled/orphan visibility; store-level guards surfaced as envelopes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleToolList, handleToolOverlay, handleToolGet, handleToolSet, handleToolHistory, handleToolRollback,
} from '../routes/core/mcp-tools.routes';
import type { ToolRegistryPort } from '../mcp-server/registry/store';
import type { ToolRegistryDoc } from '../mcp-server/registry/model';
import { LM_ASSIST_TOOL_NAMES } from '../mcp-server/configure';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ToolRegistryPort & { docs: Map<string, ToolRegistryDoc> } {
  const docs = new Map<string, ToolRegistryDoc>();
  return {
    docs,
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { docs.set(d.name, d); },
  };
}

async function seed(port: ToolRegistryPort, name: string, over: string | null, enabled: boolean) {
  const r = await handleToolSet(name, { descriptionOverride: over, enabled }, port, actor);
  assert.equal(r.success, true, JSON.stringify(r));
  return r;
}

test('list joins the code catalog with registry docs: overrides, disabled, orphans, counts', async () => {
  const port = memPort();
  await seed(port, 'detail', 'OVERRIDDEN detail description', true);
  await seed(port, 'search', null, false);
  await seed(port, 'zz-e2e-probe', 'scratch', true);

  const r = await handleToolList(port);
  assert.equal(r.success, true);
  const data = r.data as any;
  assert.equal(data.tools.length, LM_ASSIST_TOOL_NAMES.length, 'every advertised tool listed');

  const detail = data.tools.find((t: any) => t.name === 'detail');
  assert.equal(detail.effectiveDescription, 'OVERRIDDEN detail description');
  assert.equal(detail.hasOverride, true);
  assert.equal(detail.enabled, true);
  assert.equal(detail.rev, 1);
  assert.ok(detail.defaultDescription.length > 0);
  assert.notEqual(detail.defaultDescription, detail.effectiveDescription);
  assert.equal(detail.category, 'core');
  assert.equal(detail.scope, 'read');

  const search = data.tools.find((t: any) => t.name === 'search');
  assert.equal(search.enabled, false);
  assert.equal(search.hasOverride, false);
  assert.equal(search.effectiveDescription, search.defaultDescription);

  const boot = data.tools.find((t: any) => t.name === 'bootstrap');
  assert.equal(boot.protected, true);
  assert.equal(boot.enabled, true);
  assert.equal(boot.rev, undefined, 'no doc → pure default');

  assert.deepEqual(data.orphanDocs.map((d: any) => d.name), ['zz-e2e-probe']);
  assert.equal(data.counts.tools, LM_ASSIST_TOOL_NAMES.length);
  assert.equal(data.counts.overridden, 1);
  assert.equal(data.counts.disabled, 1);
  assert.equal(data.counts.orphans, 1);
  assert.ok(Array.isArray(data.categories) && data.categories.includes('core'));
});

test('overlay returns the minimal byName map (stdio provider payload)', async () => {
  const port = memPort();
  await seed(port, 'detail', 'o', true);
  await seed(port, 'search', null, false);
  const r = await handleToolOverlay(port);
  assert.equal(r.success, true);
  const byName = (r.data as any).byName;
  assert.deepEqual(byName.detail, { enabled: true, descriptionOverride: 'o' });
  assert.deepEqual(byName.search, { enabled: false, descriptionOverride: null });
  assert.equal(Object.keys(byName).length, 2, 'only stored docs — absence means default');
});

test('get for a known tool: def + implementation + default/effective descriptions', async () => {
  const port = memPort();
  await seed(port, 'detail', 'OVERRIDDEN', true);
  const r = await handleToolGet('detail', port);
  assert.equal(r.success, true);
  const d = r.data as any;
  assert.equal(d.knownTool, true);
  assert.equal(d.def.name, 'detail');
  assert.ok(d.def.inputSchema, 'schema shown');
  assert.equal(d.scope, 'read');
  assert.equal(d.category, 'core');
  assert.equal(d.protected, false);
  assert.ok(d.module.includes('mcp-server'));
  assert.ok(d.defaultDescription.length > 0);
  assert.equal(d.effectiveDescription, 'OVERRIDDEN');
  assert.equal(d.doc.rev, 1);
  assert.ok(d.implementation.handlerSource.length > 20, 'String(handler) present');
  assert.ok(d.implementation.module.includes('detail.ts'));
});

test('get for a known tool without a doc: pure default, doc null', async () => {
  const r = await handleToolGet('guide', memPort());
  assert.equal(r.success, true);
  const d = r.data as any;
  assert.equal(d.doc, null);
  assert.equal(d.protected, true);
  assert.equal(d.effectiveDescription, d.defaultDescription);
});

test('get for an orphan doc: knownTool:false with the doc, no def/implementation', async () => {
  const port = memPort();
  await seed(port, 'zz-e2e-probe', 'scratch', true);
  const r = await handleToolGet('zz-e2e-probe', port);
  assert.equal(r.success, true);
  const d = r.data as any;
  assert.equal(d.knownTool, false);
  assert.equal(d.doc.descriptionOverride, 'scratch');
  assert.equal(d.def, null);
  assert.equal(d.implementation, null);
});

test('get for an unknown name with no doc → NOT_FOUND', async () => {
  const r = await handleToolGet('zz-never-was', memPort());
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'NOT_FOUND');
});

test('set: creates/updates docs, flags knownTool, enforces validation + protection', async () => {
  const port = memPort();
  const r1 = await handleToolSet('detail', { descriptionOverride: 'x' }, port, actor);
  assert.equal((r1.data as any).doc.rev, 1);
  assert.equal((r1.data as any).changed, true);
  assert.equal((r1.data as any).knownTool, true);

  const probe = await handleToolSet('zz-e2e-probe', { descriptionOverride: 'scratch' }, port, actor);
  assert.equal(probe.success, true);
  assert.equal((probe.data as any).knownTool, false);

  const prot = await handleToolSet('bootstrap', { enabled: false }, port, actor);
  assert.equal(prot.success, false);
  assert.equal((prot as any).error.code, 'PROTECTED_TOOL');

  const bad = await handleToolSet('Bad.Name', { enabled: false }, port, actor);
  assert.equal(bad.success, false);
  assert.equal((bad as any).error.code, 'INVALID_INPUT');

  const big = await handleToolSet('detail', { descriptionOverride: 'x'.repeat(3000) }, port, actor);
  assert.equal(big.success, false);
  assert.equal((big as any).error.code, 'OVERRIDE_TOO_LARGE');
});

test('set with no effective change reports changed:false', async () => {
  const port = memPort();
  await seed(port, 'detail', 'same', true);
  const r = await handleToolSet('detail', { descriptionOverride: 'same' }, port, actor);
  assert.equal(r.success, true);
  assert.equal((r.data as any).changed, false);
});

test('history: newest first', async () => {
  const port = memPort();
  await seed(port, 'detail', 'v1', true);
  await seed(port, 'detail', 'v2', true);
  await seed(port, 'detail', 'v3', true);
  const r = await handleToolHistory('detail', {}, port);
  assert.equal(r.success, true);
  const revs = (r.data as any).history.map((h: any) => h.rev);
  assert.deepEqual(revs, [3, 2, 1]);
});

test('history for a doc-less tool is empty; unknown name is empty too (no throw)', async () => {
  const r = await handleToolHistory('guide', {}, memPort());
  assert.equal(r.success, true);
  assert.deepEqual((r.data as any).history, []);
});

test('rollback: restores an earlier rev; NOT_FOUND for a missing rev; protected guard surfaces', async () => {
  const port = memPort();
  await seed(port, 'detail', 'v1', true);
  await seed(port, 'detail', 'v2', true);
  const r = await handleToolRollback('detail', { toRev: 1 }, port, actor);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.descriptionOverride, 'v1');
  assert.equal((r.data as any).doc.rev, 3);

  const missing = await handleToolRollback('detail', { toRev: 99 }, port, actor);
  assert.equal(missing.success, false);
  assert.equal((missing as any).error.code, 'NOT_FOUND');

  const badRev = await handleToolRollback('detail', { toRev: 'nope' }, port, actor);
  assert.equal(badRev.success, false);
  assert.equal((badRev as any).error.code, 'INVALID_INPUT');
});
