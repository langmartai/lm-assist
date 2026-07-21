/** Backlog route handlers over an in-memory port: CRUD + graph + the dedicated ops
 *  (link/unlink/discuss/review/remove/rollback), the UNSUPPORTED_FIELD refusal (the
 *  assist-content 200-noop lesson), session attach derivation, and the read-paths-
 *  never-write guarantee. Origin anchoring has its own mirror suite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleBacklogCreate, handleBacklogDiscuss, handleBacklogGet, handleBacklogGraph,
  handleBacklogHistory, handleBacklogLink, handleBacklogList, handleBacklogRemove,
  handleBacklogReview, handleBacklogRollback, handleBacklogUnlink, handleBacklogUpdate,
} from '../routes/core/backlog.routes';
import type { BacklogPort } from '../mcp-server/registry/backlog-store';
import type { BacklogDoc } from '../mcp-server/registry/backlog-model';
import type { MissionActor } from '../mission/mission-model';

const apiActor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };
const sessionActor: MissionActor = { kind: 'local-session', id: 'sess-42', node: 'gw-117', channel: 'mcp', label: '/repo', at: 1 };
const convoActor: MissionActor = { kind: 'claudeai-conversation', id: 'conv-77', channel: 'mcp', label: 'Backlog chat', at: 1 };

function memPort(): BacklogPort & { docs: Map<string, BacklogDoc>; puts: () => number } {
  const docs = new Map<string, BacklogDoc>();
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

async function seed(port: BacklogPort, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await handleBacklogCreate({ title, ...extra }, port, apiActor);
  assert.equal(r.success, true, JSON.stringify(r));
  return (r.data as { item: { id: string } }).item.id;
}

test('create → get roundtrip: id generated, aliases present, defaults filled', async () => {
  const port = memPort();
  const r = await handleBacklogCreate({ title: '  Graph exports  ', type: 'feature', tags: ['ui', 'ui', ' export '] }, port, apiActor);
  assert.equal(r.success, true);
  const item = (r.data as { item: Record<string, unknown> }).item;
  assert.match(String(item.id), /^bl_[a-z0-9]{8}$/);
  assert.equal(item.title, 'Graph exports', 'trimmed');
  assert.deepEqual(item.tags, ['ui', 'export'], 'normalized + deduped');
  assert.equal(item.version, 1);
  const g = await handleBacklogGet(String(item.id), port);
  assert.equal(g.success, true);
  const got = (g.data as { item: Record<string, unknown> }).item;
  assert.equal(got.status, 'open');
  assert.ok(Array.isArray(got.history), 'get includes history');
  assert.equal((await handleBacklogGet('bl_nope9999', port)).success, false);
});

test('create without a title refuses', async () => {
  const port = memPort();
  const r = await handleBacklogCreate({ description: 'no title' }, port, apiActor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'INVALID_INPUT');
});

test('update: whitelist enforced — a misspelled field is a coded refusal, not a 200-noop', async () => {
  const port = memPort();
  const id = await seed(port, 'Item');
  const bad = await handleBacklogUpdate(id, { titel: 'oops' }, port, apiActor);
  assert.equal(bad.success, false);
  assert.equal(bad.error!.code, 'UNSUPPORTED_FIELD');
  assert.match(bad.error!.message, /titel/);
  const good = await handleBacklogUpdate(id, { status: 'planned', priority: 'high' }, port, apiActor);
  assert.equal(good.success, true);
  const item = (good.data as { item: Record<string, unknown> }).item;
  assert.equal(item.status, 'planned');
  assert.equal(item.priority, 'high');
  assert.equal(item.version, 2);
  const enumBad = await handleBacklogUpdate(id, { status: 'someday' }, port, apiActor);
  assert.equal(enumBad.success, false, 'bad enum refused by store validation');
});

test('link: validates target existence, self-link, kind; duplicates no-op', async () => {
  const port = memPort();
  const a = await seed(port, 'A');
  const b = await seed(port, 'B');
  const r1 = await handleBacklogLink(a, { to: b, kind: 'depends-on' }, port, apiActor);
  assert.equal(r1.success, true);
  assert.equal((r1.data as { changed: boolean }).changed, true);
  const dup = await handleBacklogLink(a, { to: b, kind: 'depends-on' }, port, apiActor);
  assert.equal(dup.success, true);
  assert.equal((dup.data as { changed: boolean }).changed, false, 'duplicate edge no-ops');
  const missing = await handleBacklogLink(a, { to: 'bl_gone0000', kind: 'blocks' }, port, apiActor);
  assert.equal(missing.success, false);
  assert.equal(missing.error!.code, 'NOT_FOUND');
  const selfy = await handleBacklogLink(a, { to: a, kind: 'relates-to' }, port, apiActor);
  assert.equal(selfy.success, false);
  const badKind = await handleBacklogLink(a, { to: b, kind: 'friends-with' }, port, apiActor);
  assert.equal(badKind.success, false);
});

test('unlink: removes matching edge(s); nothing matched ⇒ changed:false', async () => {
  const port = memPort();
  const a = await seed(port, 'A');
  const b = await seed(port, 'B');
  await handleBacklogLink(a, { to: b, kind: 'depends-on' }, port, apiActor);
  await handleBacklogLink(a, { to: b, kind: 'relates-to' }, port, apiActor);
  const one = await handleBacklogUnlink(a, { to: b, kind: 'depends-on' }, port, apiActor);
  assert.equal((one.data as { item: { edges: unknown[] } }).item.edges.length, 1);
  const none = await handleBacklogUnlink(a, { to: b, kind: 'depends-on' }, port, apiActor);
  assert.equal((none.data as { changed: boolean }).changed, false);
  const all = await handleBacklogUnlink(a, { to: b }, port, apiActor);
  assert.equal((all.data as { item: { edges: unknown[] } }).item.edges.length, 0, 'kind omitted removes every edge to target');
});

test('discuss: caller session derived from the resolved actor (code + conversation)', async () => {
  const port = memPort();
  const id = await seed(port, 'Talk');
  const r1 = await handleBacklogDiscuss(id, { note: 'from a code session' }, port, sessionActor);
  assert.equal(r1.success, true);
  assert.deepEqual((r1.data as { attached: unknown }).attached, { sessionId: 'sess-42', sessionKind: 'code' });
  const r2 = await handleBacklogDiscuss(id, { note: 'from a conversation' }, port, convoActor);
  assert.deepEqual((r2.data as { attached: unknown }).attached, { sessionId: 'conv-77', sessionKind: 'conversation' });
  const doc = (await handleBacklogGet(id, port)).data as { item: { discussion: Array<Record<string, unknown>> } };
  assert.equal(doc.item.discussion.length, 2);
  assert.equal(doc.item.discussion[0].label, '/repo', 'actor label rides along');
});

test('discuss: explicit session (remote/CCR self-declaration) wins; api fallback attributes', async () => {
  const port = memPort();
  const id = await seed(port, 'Talk');
  const r = await handleBacklogDiscuss(id, { note: 'from a CCR', session: { id: 'ccr-1', kind: 'remote' } }, port, sessionActor);
  assert.deepEqual((r.data as { attached: unknown }).attached, { sessionId: 'ccr-1', sessionKind: 'remote' });
  const api = await handleBacklogDiscuss(id, { note: 'plain api' }, port, apiActor);
  assert.deepEqual((api.data as { attached: unknown }).attached, { sessionId: 'api', sessionKind: 'api' });
  const bad = await handleBacklogDiscuss(id, { note: 'x', session: { id: 'y', kind: 'zoom' } }, port, apiActor);
  assert.equal(bad.success, false);
  const empty = await handleBacklogDiscuss(id, { note: '   ' }, port, apiActor);
  assert.equal(empty.success, false);
});

test('review: verdict enum enforced; `by` defaults from the actor', async () => {
  const port = memPort();
  const id = await seed(port, 'Reviewed');
  const r = await handleBacklogReview(id, { verdict: 'approve', note: 'ship it' }, port, sessionActor);
  assert.equal(r.success, true);
  const doc = (r.data as { item: { reviews: Array<Record<string, unknown>> } }).item;
  assert.equal(doc.reviews[0].by, 'sess-42');
  assert.equal(doc.reviews[0].verdict, 'approve');
  const bad = await handleBacklogReview(id, { verdict: 'meh' }, port, apiActor);
  assert.equal(bad.success, false);
});

test('remove is a soft delete: rev-tracked, restorable, excluded from list/graph', async () => {
  const port = memPort();
  const a = await seed(port, 'Keep');
  const b = await seed(port, 'Drop');
  await handleBacklogLink(a, { to: b, kind: 'relates-to' }, port, apiActor);
  const rm = await handleBacklogRemove(b, {}, port, apiActor);
  assert.equal(rm.success, true);
  assert.equal((rm.data as { removed: boolean }).removed, true);
  const again = await handleBacklogRemove(b, {}, port, apiActor);
  assert.equal((again.data as { changed: boolean }).changed, false, 'idempotent');

  const list = (await handleBacklogList({}, port)).data as { items: unknown[]; counts: { removed: number } };
  assert.equal(list.items.length, 1);
  assert.equal(list.counts.removed, 1);
  const listAll = (await handleBacklogList({ includeRemoved: 'true' }, port)).data as { items: unknown[] };
  assert.equal(listAll.items.length, 2);

  const graph = (await handleBacklogGraph({}, port)).data as { nodes: unknown[]; edges: unknown[] };
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0, 'edge to removed target excluded');

  const restore = await handleBacklogRemove(b, { restore: true }, port, apiActor);
  assert.equal((restore.data as { removed: boolean }).removed, false);
  assert.equal(((await handleBacklogGraph({}, port)).data as { edges: unknown[] }).edges.length, 1, 'edge returns after restore');
});

test('list filters: status/type/tag', async () => {
  const port = memPort();
  await seed(port, 'A', { type: 'bug', tags: ['ui'] });
  const b = await seed(port, 'B', { type: 'feature', tags: ['api'] });
  await handleBacklogUpdate(b, { status: 'accepted' }, port, apiActor);
  const byType = (await handleBacklogList({ type: 'bug' }, port)).data as { items: Array<{ title: string }> };
  assert.deepEqual(byType.items.map((i) => i.title), ['A']);
  const byStatus = (await handleBacklogList({ status: 'accepted' }, port)).data as { items: Array<{ title: string }> };
  assert.deepEqual(byStatus.items.map((i) => i.title), ['B']);
  const byTag = (await handleBacklogList({ tag: 'ui' }, port)).data as { items: Array<{ title: string }> };
  assert.deepEqual(byTag.items.map((i) => i.title), ['A']);
});

test('graph shape: nodes carry render fields; edges typed', async () => {
  const port = memPort();
  const a = await seed(port, 'A', { type: 'idea', priority: 'high' });
  const b = await seed(port, 'B');
  await handleBacklogLink(a, { to: b, kind: 'depends-on' }, port, apiActor);
  const g = (await handleBacklogGraph({}, port)).data as {
    nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>;
  };
  const na = g.nodes.find((n) => n.id === a)!;
  assert.equal(na.title, 'A');
  assert.equal(na.priority, 'high');
  assert.deepEqual(g.edges, [{ from: a, to: b, kind: 'depends-on' }]);
});

test('history + rollback: revert restores the full earlier state as a new rev', async () => {
  const port = memPort();
  const id = await seed(port, 'v1', { description: 'd1' });
  await handleBacklogUpdate(id, { title: 'v2', status: 'discussing' }, port, apiActor);
  const h = (await handleBacklogHistory(id, port)).data as { history: Array<{ rev: number }> };
  assert.deepEqual(h.history.map((x) => x.rev), [2, 1], 'newest first');
  const rb = await handleBacklogRollback(id, { toRev: 1 }, port, apiActor);
  assert.equal(rb.success, true);
  const item = (rb.data as { item: Record<string, unknown> }).item;
  assert.equal(item.title, 'v1');
  assert.equal(item.status, 'open');
  assert.equal(item.version, 3);
  const badRev = await handleBacklogRollback(id, { toRev: 99 }, port, apiActor);
  assert.equal(badRev.success, false);
  const noRev = await handleBacklogRollback(id, {}, port, apiActor);
  assert.equal(noRev.success, false);
});

test('reads NEVER write: list/get/graph/history leave the port untouched', async () => {
  const port = memPort();
  const id = await seed(port, 'Read-only probe');
  const before = port.puts();
  await handleBacklogList({}, port);
  await handleBacklogGraph({}, port);
  await handleBacklogGet(id, port);
  await handleBacklogHistory(id, port);
  await handleBacklogGet('bl_nope9999', port);
  assert.equal(port.puts(), before, 'no read path performed a write');
});
