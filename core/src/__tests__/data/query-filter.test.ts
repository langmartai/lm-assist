import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getField, matches, applyQuery } from '../../data/backends/query-filter';
import type { DataRecord } from '../../data/types';

function rec(id: string, fields: Record<string, unknown>, metadata?: Record<string, unknown>): DataRecord {
  return { id, version: 1, fields, metadata, createdAt: 't', updatedAt: 't' };
}

test('getField: reads fields, then metadata, then top-level', () => {
  const r = rec('a', { x: 1 }, { y: 2 });
  assert.equal(getField(r, 'x'), 1);
  assert.equal(getField(r, 'y'), 2);
  assert.equal(getField(r, 'id'), 'a');
});

test('matches: each operator', () => {
  const r = rec('a', { n: 5, tag: 'hello' });
  assert.equal(matches(r, { field: 'n', op: 'eq', value: 5 }), true);
  assert.equal(matches(r, { field: 'n', op: 'ne', value: 5 }), false);
  assert.equal(matches(r, { field: 'n', op: 'gt', value: 4 }), true);
  assert.equal(matches(r, { field: 'n', op: 'gte', value: 5 }), true);
  assert.equal(matches(r, { field: 'n', op: 'lt', value: 5 }), false);
  assert.equal(matches(r, { field: 'n', op: 'lte', value: 5 }), true);
  assert.equal(matches(r, { field: 'n', op: 'in', value: [4, 5, 6] }), true);
  assert.equal(matches(r, { field: 'tag', op: 'contains', value: 'ell' }), true);
});

test('applyQuery: filter + sort + offset + limit, total is pre-pagination', () => {
  const rows = [rec('a', { n: 3, t: 'x' }), rec('b', { n: 1, t: 'y' }), rec('c', { n: 2, t: 'x' })];
  const r = applyQuery(rows, {
    filter: [{ field: 't', op: 'eq', value: 'x' }],
    sort: [{ field: 'n', dir: 'asc' }],
  });
  assert.deepEqual(r.records.map((x) => x.id), ['c', 'a']); // n=2 before n=3
  assert.equal(r.total, 2);

  const paged = applyQuery(rows, { sort: [{ field: 'n', dir: 'desc' }], offset: 1, limit: 1 });
  assert.deepEqual(paged.records.map((x) => x.id), ['c']); // desc: a(3),c(2),b(1); offset 1 -> c
  assert.equal(paged.total, 3);
});
