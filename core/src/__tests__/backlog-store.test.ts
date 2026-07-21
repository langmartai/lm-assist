/** Backlog store — the THIRD instantiation of the generic overlay-doc store, plus the
 *  two factory extensions it introduced: per-field `equals` (array fields don't mint
 *  junk revs) and `mutate` (race-free read-modify-write inside the name lock).
 *  Mirrors content-registry-store.test.ts so all consumers pin the shared machinery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBacklogItem, getBacklogDoc, listBacklogDocs, mutateBacklogItem,
  rollbackBacklogItem, updateBacklogItem,
  type BacklogPort,
} from '../mcp-server/registry/backlog-store';
import { BACKLOG_HISTORY_CAP, type BacklogDoc } from '../mcp-server/registry/backlog-model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): BacklogPort & { docs: Map<string, BacklogDoc>; puts: () => number; gate?: () => Promise<void> } {
  const docs = new Map<string, BacklogDoc>();
  let puts = 0;
  const port: BacklogPort & { docs: Map<string, BacklogDoc>; puts: () => number; gate?: () => Promise<void> } = {
    docs,
    puts: () => puts,
    isEnabled: () => true,
    get: async (name) => {
      if (port.gate) await port.gate();
      return docs.get(name) ?? null;
    },
    list: async () => [...docs.values()],
    put: async (d) => { puts++; docs.set(d.name, d); },
  };
  return port;
}

const ids = (() => { let i = 0; return () => `bl_test${String(i++).padStart(3, '0')}`; })();

test('create: rev 1, defaults filled, generated id returned', async () => {
  const port = memPort();
  const { doc, changed } = await createBacklogItem({ title: 'Dark mode', type: 'feature' }, actor, port, () => 'bl_aaaa1111');
  assert.equal(changed, true);
  assert.equal(doc.name, 'bl_aaaa1111');
  assert.equal(doc.rev, 1);
  assert.equal(doc.status, 'open');
  assert.equal(doc.priority, 'med');
  assert.deepEqual(doc.edges, []);
  assert.equal(doc.removed, false);
  assert.equal(doc.createdBy, actor);
});

test('create: id collision throws coded ID_COLLISION instead of silently merging', async () => {
  const port = memPort();
  await createBacklogItem({ title: 'One' }, actor, port, () => 'bl_dupdup11');
  await assert.rejects(
    () => createBacklogItem({ title: 'Two' }, actor, port, () => 'bl_dupdup11'),
    (e: Error & { code?: string }) => e.code === 'ID_COLLISION',
  );
  assert.equal((await getBacklogDoc('bl_dupdup11', port))!.title, 'One');
});

test('create: missing/blank title throws coded INVALID_INPUT', async () => {
  const port = memPort();
  await assert.rejects(
    () => createBacklogItem({ title: '  ' } as { title: string }, actor, port, ids),
    (e: Error & { code?: string }) => e.code === 'INVALID_INPUT',
  );
});

test('update: merge semantics keep omitted fields; missing item throws NOT_FOUND', async () => {
  const port = memPort();
  const { doc } = await createBacklogItem({ title: 'T', description: 'D', tags: ['a'] }, actor, port, () => 'bl_aaaa2222');
  const { doc: d2 } = await updateBacklogItem(doc.name, { status: 'accepted' }, actor, port);
  assert.equal(d2.rev, 2);
  assert.equal(d2.status, 'accepted');
  assert.equal(d2.description, 'D', 'omitted fields kept');
  assert.deepEqual(d2.tags, ['a']);
  await assert.rejects(
    () => updateBacklogItem('bl_nope9999', { status: 'accepted' }, actor, port),
    (e: Error & { code?: string }) => e.code === 'NOT_FOUND',
  );
});

test('equals extension: identical array re-write stays changed:false (no junk rev)', async () => {
  const port = memPort();
  const { doc } = await createBacklogItem({ title: 'T', tags: ['x', 'y'] }, actor, port, () => 'bl_aaaa3333');
  const before = port.puts();
  const { changed, doc: d2 } = await updateBacklogItem(doc.name, { tags: ['x', 'y'] }, actor, port);
  assert.equal(changed, false);
  assert.equal(d2.rev, 1);
  assert.equal(port.puts(), before, 'no write hit the port');
});

test('mutate: transform returning null is an explicit no-op', async () => {
  const port = memPort();
  await createBacklogItem({ title: 'T' }, actor, port, () => 'bl_aaaa4444');
  const { changed } = await mutateBacklogItem('bl_aaaa4444', () => null, actor, port);
  assert.equal(changed, false);
});

test('mutate: CONCURRENT appends both land (the read-then-put race the lock closes)', async () => {
  const port = memPort();
  await createBacklogItem({ title: 'T' }, actor, port, () => 'bl_race0001');
  await createBacklogItem({ title: 'A' }, actor, port, () => 'bl_tgta0001');
  await createBacklogItem({ title: 'B' }, actor, port, () => 'bl_tgtb0001');
  // Slow the in-lock reads so both mutates are in flight together.
  port.gate = () => new Promise((r) => setTimeout(r, 5));
  await Promise.all([
    mutateBacklogItem('bl_race0001', (prev) => ({ edges: [...prev.edges, { to: 'bl_tgta0001', kind: 'blocks' as const }] }), actor, port),
    mutateBacklogItem('bl_race0001', (prev) => ({ edges: [...prev.edges, { to: 'bl_tgtb0001', kind: 'blocks' as const }] }), actor, port),
  ]);
  const doc = (await getBacklogDoc('bl_race0001', port))!;
  assert.equal(doc.edges.length, 2, `both concurrent edges persisted, got ${JSON.stringify(doc.edges)}`);
  assert.equal(doc.rev, 3);
});

test('self-edge is refused on EVERY write path (refuseWrite hook)', async () => {
  const port = memPort();
  await createBacklogItem({ title: 'T' }, actor, port, () => 'bl_self0001');
  await assert.rejects(
    () => mutateBacklogItem('bl_self0001', () => ({ edges: [{ to: 'bl_self0001', kind: 'relates-to' as const }] }), actor, port),
    (e: Error & { code?: string }) => e.code === 'INVALID_INPUT',
  );
});

test('history: full state per entry, capped, rollback restores as a NEW rev', async () => {
  const port = memPort();
  const { doc } = await createBacklogItem({ title: 'v1', description: 'd1' }, actor, port, () => 'bl_hist0001');
  await updateBacklogItem(doc.name, { title: 'v2', status: 'discussing' }, actor, port);
  await updateBacklogItem(doc.name, { title: 'v3' }, actor, port);
  const r = await rollbackBacklogItem(doc.name, 1, actor, port);
  assert.ok('doc' in r);
  if ('doc' in r) {
    assert.equal(r.doc.rev, 4, 'rollback is a new revision');
    assert.equal(r.doc.title, 'v1');
    assert.equal(r.doc.status, 'open', 'FULL state restored');
    assert.equal(r.doc.description, 'd1');
  }
  const missing = await rollbackBacklogItem(doc.name, 99, actor, port);
  assert.ok('error' in missing && missing.error.code === 'NOT_FOUND');
});

test('history cap holds under many writes', async () => {
  const port = memPort();
  await createBacklogItem({ title: 't0' }, actor, port, () => 'bl_capp0001');
  for (let i = 1; i <= BACKLOG_HISTORY_CAP + 3; i++) {
    await updateBacklogItem('bl_capp0001', { title: `t${i}` }, actor, port);
  }
  const doc = (await getBacklogDoc('bl_capp0001', port))!;
  assert.equal(doc.history.length, BACKLOG_HISTORY_CAP);
  assert.equal(doc.history[doc.history.length - 1].state.title, `t${BACKLOG_HISTORY_CAP + 3}`);
});

test('disabled data service throws coded DATA_SERVICE_DISABLED on both write APIs', async () => {
  const port = memPort();
  port.isEnabled = () => false;
  await assert.rejects(
    () => createBacklogItem({ title: 'T' }, actor, port, ids),
    (e: Error & { code?: string }) => e.code === 'DATA_SERVICE_DISABLED',
  );
  await assert.rejects(
    () => mutateBacklogItem('bl_aaaa1111', () => ({}), actor, port),
    (e: Error & { code?: string }) => e.code === 'DATA_SERVICE_DISABLED',
  );
});

test('list returns everything the port holds', async () => {
  const port = memPort();
  await createBacklogItem({ title: 'A' }, actor, port, () => 'bl_lista001');
  await createBacklogItem({ title: 'B' }, actor, port, () => 'bl_listb001');
  const all = await listBacklogDocs(port);
  assert.deepEqual(all.map((d) => d.name).sort(), ['bl_lista001', 'bl_listb001']);
});
