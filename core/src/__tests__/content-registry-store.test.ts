/**
 * Content-registry store — the SECOND instantiation of the generic overlay-doc store
 * (the first is the MCP tool registry): rev/history/merge/no-op/rollback semantics over
 * an in-memory port, plus the coded DATA_SERVICE_DISABLED throw. Mirrors
 * mcp-tool-registry-store.test.ts so both consumers pin the shared machinery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getContentDoc,
  listContentDocs,
  putContentDoc,
  rollbackContentDoc,
  type ContentPort,
} from '../mcp-server/registry/content-store';
import { CONTENT_HISTORY_CAP, type ContentDoc } from '../mcp-server/registry/content-model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ContentPort & { docs: Map<string, ContentDoc>; puts: () => number } {
  const docs = new Map<string, ContentDoc>();
  let puts = 0;
  return {
    docs,
    puts: () => puts,
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { puts++; docs.set(d.name, d); },
  };
}

test('putContentDoc creates rev 1 with null defaults for omitted fields', async () => {
  const port = memPort();
  const { doc, changed } = await putContentDoc({ name: 'guide.data', contentOverride: '# better data guide' }, actor, port);
  assert.equal(changed, true);
  assert.equal(doc.rev, 1);
  assert.equal(doc.contentOverride, '# better data guide');
  assert.equal(doc.blurbOverride, null, 'blurb defaults null');
  assert.equal(doc.history.length, 1);
  assert.deepEqual(doc.history[0].state, { contentOverride: '# better data guide', blurbOverride: null });
  assert.equal(doc.createdBy, actor);
});

test('merge semantics: omitted field keeps its value; null explicitly clears', async () => {
  const port = memPort();
  await putContentDoc({ name: 'guide.data', contentOverride: 'body1' }, actor, port);
  const { doc } = await putContentDoc({ name: 'guide.data', blurbOverride: 'blurb1' }, actor, port);
  assert.equal(doc.rev, 2);
  assert.equal(doc.contentOverride, 'body1', 'content kept when omitted');
  assert.equal(doc.blurbOverride, 'blurb1');
  const { doc: d3 } = await putContentDoc({ name: 'guide.data', contentOverride: null }, actor, port);
  assert.equal(d3.rev, 3);
  assert.equal(d3.contentOverride, null, 'null clears');
  assert.equal(d3.blurbOverride, 'blurb1', 'blurb kept when omitted');
});

test('no-op write does not bump rev or hit the port', async () => {
  const port = memPort();
  await putContentDoc({ name: 'guide.ccr', contentOverride: 'o' }, actor, port);
  const before = port.puts();
  const { changed, doc } = await putContentDoc({ name: 'guide.ccr', contentOverride: 'o', blurbOverride: null }, actor, port);
  assert.equal(changed, false);
  assert.equal(doc.rev, 1);
  assert.equal(port.puts(), before);
});

test('history carries full state per entry and is capped', async () => {
  const port = memPort();
  for (let i = 1; i <= CONTENT_HISTORY_CAP + 4; i++) {
    await putContentDoc({ name: 'guide.nodes', contentOverride: `o${i}` }, actor, port);
  }
  const doc = (await getContentDoc('guide.nodes', port))!;
  assert.equal(doc.rev, CONTENT_HISTORY_CAP + 4);
  assert.equal(doc.history.length, CONTENT_HISTORY_CAP, 'capped');
  assert.equal(doc.history[doc.history.length - 1].state.contentOverride, `o${CONTENT_HISTORY_CAP + 4}`);
  assert.equal(doc.history[0].state.contentOverride, 'o5', 'oldest entries dropped');
});

test('rollback restores a listed rev FULL state as a NEW rev', async () => {
  const port = memPort();
  await putContentDoc({ name: 'guide.files', contentOverride: 'v1', blurbOverride: 'b1' }, actor, port);
  await putContentDoc({ name: 'guide.files', contentOverride: 'v2', blurbOverride: null }, actor, port);
  const r = await rollbackContentDoc('guide.files', 1, actor, port);
  assert.ok('doc' in r, 'rollback succeeds');
  if ('doc' in r) {
    assert.equal(r.doc.rev, 3, 'rollback is a new revision');
    assert.equal(r.doc.contentOverride, 'v1');
    assert.equal(r.doc.blurbOverride, 'b1', 'FULL state restored, both fields');
  }
});

test('rollback to a missing rev returns coded NOT_FOUND', async () => {
  const port = memPort();
  await putContentDoc({ name: 'guide.files', contentOverride: 'v1' }, actor, port);
  const r = await rollbackContentDoc('guide.files', 99, actor, port);
  assert.ok('error' in r);
  if ('error' in r) assert.equal(r.error.code, 'NOT_FOUND');
});

test('validation is enforced at the store (every write path covered)', async () => {
  const port = memPort();
  await assert.rejects(() => putContentDoc({ name: 'no-prefix', contentOverride: 'x' }, actor, port), (e: any) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => putContentDoc({ name: 'guide.data', contentOverride: '' }, actor, port), (e: any) => e.code === 'INVALID_INPUT');
  await assert.rejects(
    () => putContentDoc({ name: 'guide.data', contentOverride: 'x'.repeat(20000) }, actor, port),
    (e: any) => e.code === 'OVERRIDE_TOO_LARGE',
  );
  await assert.rejects(
    () => putContentDoc({ name: 'guide.data', blurbOverride: 'a\nb' }, actor, port),
    (e: any) => e.code === 'INVALID_INPUT',
  );
});

test('disabled data service throws coded DATA_SERVICE_DISABLED (never a silent no-op)', async () => {
  const port = memPort();
  port.isEnabled = () => false;
  await assert.rejects(
    () => putContentDoc({ name: 'guide.data', contentOverride: 'x' }, actor, port),
    (e: any) => e.code === 'DATA_SERVICE_DISABLED',
  );
});

test('listContentDocs returns everything the port holds', async () => {
  const port = memPort();
  await putContentDoc({ name: 'guide.data', contentOverride: 'a' }, actor, port);
  await putContentDoc({ name: 'bootstrap.header', contentOverride: 'b' }, actor, port);
  const all = await listContentDocs(port);
  assert.deepEqual(all.map((d) => d.name).sort(), ['bootstrap.header', 'guide.data']);
});
