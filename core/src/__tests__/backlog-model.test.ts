/** Backlog model — id grammar/generation, field validators, normalization, graph
 *  building, serialization aliases (id=name, version=rev). Pure functions only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCapped, buildBacklogGraph, genBacklogId, jsonEq, normalizeTags, refuseSelfEdges,
  toApiItem, toListRow,
  validateBacklogId, validateDiscussion, validateEdges, validateReviews, validateTags, validateTitle,
  MAX_TAGS,
  type BacklogDoc, type BacklogState,
} from '../mcp-server/registry/backlog-model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function doc(name: string, over: Partial<BacklogState> = {}, rev = 1): BacklogDoc {
  return {
    name, rev, history: [], createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 2,
    title: `t-${name}`, description: '', type: 'idea', status: 'open', priority: 'med',
    tags: [], edges: [], discussion: [], reviews: [], removed: false,
    ...over,
  };
}

test('id grammar: generated ids pass, junk fails', () => {
  const id = genBacklogId();
  assert.match(id, /^bl_[a-z0-9]{8}$/);
  assert.equal(validateBacklogId(id).ok, true);
  for (const bad of ['', 'bl_', 'bl_UPPER', 'x_12345678', 'bl_1234567890abcdef0', 'bl_ab.cd']) {
    assert.equal(validateBacklogId(bad as string).ok, false, bad);
  }
  assert.equal(genBacklogId(() => 'abcd1234'), 'bl_abcd1234', 'injectable rng');
});

test('validators: title/tags/edges/discussion/reviews enforce shape + caps', () => {
  assert.equal(validateTitle('A fine idea').ok, true);
  assert.equal(validateTitle('').ok, false);
  assert.equal(validateTitle('x'.repeat(301)).ok, false);

  assert.equal(validateTags(['a', 'b']).ok, true);
  assert.equal(validateTags(['a', 'a']).ok, false, 'dupes rejected');
  assert.equal(validateTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)).ok, false);

  assert.equal(validateEdges([{ to: 'bl_aaaa1111', kind: 'depends-on' }]).ok, true);
  assert.equal(validateEdges([{ to: 'nope', kind: 'depends-on' }]).ok, false);
  assert.equal(validateEdges([{ to: 'bl_aaaa1111', kind: 'sorta' }]).ok, false);
  assert.equal(validateEdges([
    { to: 'bl_aaaa1111', kind: 'blocks' }, { to: 'bl_aaaa1111', kind: 'blocks' },
  ]).ok, false, 'duplicate edges rejected');

  assert.equal(validateDiscussion([{ sessionId: 's1', sessionKind: 'conversation', note: 'hi', at: 5 }]).ok, true);
  assert.equal(validateDiscussion([{ sessionId: '', sessionKind: 'conversation', note: 'hi', at: 5 }]).ok, false);
  assert.equal(validateDiscussion([{ sessionId: 's1', sessionKind: 'zoom', note: 'hi', at: 5 }]).ok, false);
  assert.equal(validateDiscussion([{ sessionId: 's1', sessionKind: 'code', note: '', at: 5 }]).ok, false);

  assert.equal(validateReviews([{ by: 'me', verdict: 'approve', at: 5 }]).ok, true);
  assert.equal(validateReviews([{ by: 'me', verdict: 'meh', at: 5 }]).ok, false);
});

test('normalizeTags trims, dedupes, drops empties, caps', () => {
  assert.deepEqual(normalizeTags([' a ', 'a', '', 'b', 42 as unknown as string]), ['a', 'b']);
  assert.equal(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, MAX_TAGS);
  assert.deepEqual(normalizeTags('not-an-array'), []);
});

test('refuseSelfEdges refuses only edges pointing at the doc itself', () => {
  const state = doc('bl_aaaa1111', { edges: [{ to: 'bl_bbbb2222', kind: 'blocks' }] });
  assert.equal(refuseSelfEdges('bl_aaaa1111', state).ok, true);
  const selfy = doc('bl_aaaa1111', { edges: [{ to: 'bl_aaaa1111', kind: 'relates-to' }] });
  assert.equal(refuseSelfEdges('bl_aaaa1111', selfy).ok, false);
});

test('jsonEq: deep equality for JSON-shaped values', () => {
  assert.equal(jsonEq([{ a: 1 }], [{ a: 1 }]), true);
  assert.equal(jsonEq([{ a: 1 }], [{ a: 2 }]), false);
  assert.equal(jsonEq('x', 'x'), true);
});

test('toApiItem aliases id=name and version=rev; history only when asked', () => {
  const d = doc('bl_aaaa1111', {}, 7);
  const api = toApiItem(d);
  assert.equal(api.id, 'bl_aaaa1111');
  assert.equal(api.version, 7);
  assert.equal(api.rev, 7);
  assert.equal(api.history, undefined);
  assert.equal((api as unknown as Record<string, unknown>).name, undefined, 'internal key not leaked');
  const withH = toApiItem(d, { includeHistory: true });
  assert.deepEqual(withH.history, []);
  const row = toListRow(doc('bl_cccc3333', { discussion: [{ sessionId: 's', sessionKind: 'api', note: 'n', at: 1 }] }));
  assert.equal(row.counts.discussion, 1);
  assert.equal((row as Record<string, unknown>).description, undefined, 'list rows omit bodies');
});

test('buildBacklogGraph: removed items excluded (with their edges), dangling targets dropped', () => {
  const docs = [
    doc('bl_aaaa1111', { edges: [{ to: 'bl_bbbb2222', kind: 'depends-on' }, { to: 'bl_gone0000', kind: 'relates-to' }] }),
    doc('bl_bbbb2222', { edges: [{ to: 'bl_cccc3333', kind: 'blocks' }] }),
    doc('bl_cccc3333', { removed: true }),
  ];
  const g = buildBacklogGraph(docs);
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['bl_aaaa1111', 'bl_bbbb2222']);
  assert.deepEqual(g.edges, [{ from: 'bl_aaaa1111', to: 'bl_bbbb2222', kind: 'depends-on' }]);
  const all = buildBacklogGraph(docs, { includeRemoved: true });
  assert.equal(all.nodes.length, 3);
  assert.equal(all.edges.length, 2, 'removed target visible ⇒ its inbound edge returns');
});

test('appendCapped drops the oldest past the cap', () => {
  assert.deepEqual(appendCapped([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.deepEqual(appendCapped([], 1, 3), [1]);
});
