import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery } from '../../data/backends/sql-compiler';

test('compiler: filter ops produce bound placeholders, never inlined values', () => {
  const c = compileQuery({ filter: [{ field: 'topic', op: 'eq', value: 'astro' }, { field: 'n', op: 'gt', value: 5 }] }, new Set(['topic']));
  assert.match(c.where, /WHERE/);
  assert.ok(!c.where.includes('astro'));          // value is bound, not inlined
  // indexed field uses the generated column (no param); non-indexed pushes a bound json path then the value
  assert.match(c.where, /"f_topic"/);
  assert.match(c.where, /json_extract\(fields, \?\)/);
  assert.deepEqual(c.whereParams, ['astro', '$.n', 5]); // topic indexed → just its value; n non-indexed → path + value
  assert.deepEqual(c.orderParams, []);
});

test('compiler: in / contains / fts', () => {
  const c = compileQuery({ filter: [{ field: 'tag', op: 'in', value: ['a', 'b'] }, { field: 'body', op: 'contains', value: 'x_y' }], fts: 'hello' }, new Set());
  assert.match(c.where, /IN \(\?, \?\)/);
  assert.match(c.where, /LIKE \? ESCAPE/);
  assert.match(c.where, /records_fts MATCH \?/);
  assert.ok(c.whereParams.includes('hello'));       // fts query bound
  assert.ok(c.whereParams.includes('%x\\_y%'));     // contains value, LIKE-escaped + bound
});

test('compiler: rejects unsafe field names; a "version" field hits JSON, not the physical column', () => {
  assert.throws(() => compileQuery({ filter: [{ field: 'fields); DROP TABLE records;--', op: 'eq', value: 1 }] }, new Set()), /invalid field/i);
  // a filter field named "version" resolves to fields.version (user JSON), NOT the physical version column
  const c = compileQuery({ filter: [{ field: 'version', op: 'eq', value: 1 }] }, new Set());
  assert.match(c.where, /json_extract\(fields, \?\)/);
  assert.ok(!c.where.includes('records.version'));
  assert.deepEqual(c.whereParams, ['$.version', 1]);
});

test('compiler: sort + empty query', () => {
  const c = compileQuery({ sort: [{ field: 'topic', dir: 'desc' }] }, new Set(['topic']));
  assert.match(c.order, /ORDER BY "f_topic" DESC/);
  assert.deepEqual(c.orderParams, []);              // indexed sort field → generated column, no param
  const c2 = compileQuery({ sort: [{ field: 'n', dir: 'asc' }] }, new Set());
  assert.match(c2.order, /json_extract\(fields, \?\) ASC/);
  assert.deepEqual(c2.orderParams, ['$.n']);        // non-indexed sort field → bound json path in orderParams
  const empty = compileQuery({}, new Set());
  assert.equal(empty.where, '');
  assert.equal(empty.order, '');
});
