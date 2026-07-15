/**
 * /assist-content route handlers (design §5) — catalog-joined list, unit detail with
 * effective body, strict write validation, history, rollback; all port-injected.
 * Mirrors mcp-tools-routes.test.ts (the first consumer of the shared machinery).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleContentList, handleContentOverlay, handleContentGet,
  handleContentSet, handleContentHistory, handleContentRollback,
} from '../routes/core/assist-content.routes';
import type { ContentPort } from '../mcp-server/registry/content-store';
import type { ContentDoc } from '../mcp-server/registry/content-model';
import { getContentCatalog } from '../mcp-server/registry/content-catalog';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ContentPort & { docs: Map<string, ContentDoc> } {
  const docs = new Map<string, ContentDoc>();
  return {
    docs,
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { docs.set(d.name, d); },
  };
}

test('list joins the code catalog with registry deltas + counts + orphans', async () => {
  const port = memPort();
  await handleContentSet('guide.data', { contentOverride: '# custom data' }, port, actor);
  await handleContentSet('guide.zz-e2e-probe', { contentOverride: 'scratch' }, port, actor);
  const r = await handleContentList(port);
  assert.equal(r.success, true);
  const d = r.data as any;
  assert.equal(d.units.length, getContentCatalog().size, 'every code unit listed');
  const dataRow = d.units.find((u: any) => u.id === 'guide.data');
  assert.equal(dataRow.hasOverride, true);
  assert.equal(dataRow.rev, 1);
  assert.ok(dataRow.overrideBytes > 0);
  const headerRow = d.units.find((u: any) => u.id === 'bootstrap.header');
  assert.equal(headerRow.group, 'bootstrap');
  assert.equal(headerRow.hasOverride, false);
  assert.equal(headerRow.rev, undefined, 'un-stored unit has no rev');
  assert.equal(d.orphanDocs.length, 1, 'scratch doc listed as orphan');
  assert.equal(d.orphanDocs[0].name, 'guide.zz-e2e-probe');
  assert.deepEqual(d.counts, { units: getContentCatalog().size, overridden: 1, orphans: 1 });
  assert.deepEqual([...d.groups], ['overview', 'bootstrap', 'guide']);
});

test('overlay returns the {byId} delta map', async () => {
  const port = memPort();
  await handleContentSet('guide.ccr', { contentOverride: 'c', blurbOverride: null }, port, actor);
  const r = await handleContentOverlay(port);
  assert.equal(r.success, true);
  assert.deepEqual((r.data as any).byId['guide.ccr'], { contentOverride: 'c', blurbOverride: null });
});

test('get returns default + effective body for a known unit (no doc)', async () => {
  const r = await handleContentGet('guide.sessions', memPort());
  assert.equal(r.success, true);
  const d = r.data as any;
  assert.equal(d.knownUnit, true);
  assert.match(d.defaultBody, /investigate a Claude Code session/i);
  assert.equal(d.effectiveBody, d.defaultBody, 'no override ⇒ effective == default');
  assert.equal(d.doc, null);
});

test('get returns override as effective when stored; unknown id without doc is NOT_FOUND', async () => {
  const port = memPort();
  await handleContentSet('guide.sessions', { contentOverride: '# replaced' }, port, actor);
  const d = (await handleContentGet('guide.sessions', port)).data as any;
  assert.equal(d.effectiveBody, '# replaced');
  assert.match(d.defaultBody, /investigate/i, 'default still shown alongside');
  const missing = await handleContentGet('guide.zz-not-there', port);
  assert.equal(missing.success, false);
  assert.equal((missing as any).error.code, 'NOT_FOUND');
});

test('get surfaces an orphan doc as knownUnit:false (never rendered, still manageable)', async () => {
  const port = memPort();
  await handleContentSet('guide.zz-e2e-probe', { contentOverride: 'scratch body' }, port, actor);
  const d = (await handleContentGet('guide.zz-e2e-probe', port)).data as any;
  assert.equal(d.knownUnit, false);
  assert.equal(d.defaultBody, null);
  assert.equal(d.effectiveBody, 'scratch body');
  assert.equal(d.doc.rev, 1);
});

test('set validates types strictly and surfaces store refusals as coded envelopes', async () => {
  const port = memPort();
  const badType = await handleContentSet('guide.data', { contentOverride: 42 }, port, actor);
  assert.equal(badType.success, false);
  assert.equal((badType as any).error.code, 'INVALID_INPUT');
  const tooBig = await handleContentSet('guide.data', { contentOverride: 'x'.repeat(20000) }, port, actor);
  assert.equal((tooBig as any).error.code, 'OVERRIDE_TOO_LARGE');
  const badId = await handleContentSet('not-prefixed', { contentOverride: 'x' }, port, actor);
  assert.equal((badId as any).error.code, 'INVALID_INPUT');
});

test('blurbOverride is refused on known units without a blurb, allowed on topics', async () => {
  const port = memPort();
  const onHeader = await handleContentSet('bootstrap.header', { blurbOverride: 'nope' }, port, actor);
  assert.equal(onHeader.success, false);
  assert.equal((onHeader as any).error.code, 'NO_BLURB');
  const onIndex = await handleContentSet('guide.index', { blurbOverride: 'nope' }, port, actor);
  assert.equal((onIndex as any).error.code, 'NO_BLURB');
  const onTopic = await handleContentSet('guide.data', { blurbOverride: 'better one-liner' }, port, actor);
  assert.equal(onTopic.success, true);
  assert.equal((onTopic.data as any).doc.blurbOverride, 'better one-liner');
  // clearing with null is always allowed (no dead-state risk)
  const clearOnHeader = await handleContentSet('bootstrap.header', { blurbOverride: null, contentOverride: 'x' }, port, actor);
  assert.equal(clearOnHeader.success, true);
});

test('set/rollback honor the _originHop guard (never re-proxied) and strip the flag', async () => {
  const port = memPort();
  let proxied = 0;
  const origin = {
    getOrigin: async () => 'gw-123', // says "elsewhere", but the hop flag must win
    thisNode: () => 'gw-117',
    proxyPost: async () => { proxied++; return { success: true }; },
  };
  const r = await handleContentSet('guide.data', { contentOverride: 'x', _originHop: true }, port, actor, origin);
  assert.equal(proxied, 0, 'hopped request handled locally');
  assert.equal(r.success, true);
  assert.equal('_originHop' in (r.data as any).doc, false);
  const rb = await handleContentRollback('guide.data', { toRev: 1, _originHop: true }, port, actor, origin);
  assert.equal(proxied, 0);
  assert.equal(rb.success, true);
});

test('history lists newest-first; rollback restores as a new rev through the route', async () => {
  const port = memPort();
  await handleContentSet('guide.files', { contentOverride: 'v1' }, port, actor);
  await handleContentSet('guide.files', { contentOverride: 'v2' }, port, actor);
  const h = (await handleContentHistory('guide.files', {}, port)).data as any;
  assert.deepEqual(h.history.map((x: any) => x.rev), [2, 1], 'newest first');
  const rb = await handleContentRollback('guide.files', { toRev: 1 }, port, actor);
  assert.equal(rb.success, true);
  assert.equal((rb.data as any).doc.rev, 3);
  assert.equal((rb.data as any).doc.contentOverride, 'v1');
  const badRev = await handleContentRollback('guide.files', { toRev: 99 }, port, actor);
  assert.equal((badRev as any).error.code, 'NOT_FOUND');
  const noRev = await handleContentRollback('guide.files', {}, port, actor);
  assert.equal((noRev as any).error.code, 'INVALID_INPUT');
});
