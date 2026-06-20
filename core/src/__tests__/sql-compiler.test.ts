import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery } from '../data/backends/sql-compiler';

/**
 * SQL backend parity for the new query operators (2026-06-20): wildcard→GLOB,
 * regex→REGEXP (a function registered on the connection), nin→NOT IN,
 * exists→IS [NOT] NULL. Every caller value stays BOUND (never inlined).
 */

test('wildcard compiles to GLOB with the value bound', () => {
  const { where, whereParams } = compileQuery({ filter: [{ field: 'name', op: 'wildcard', value: 'K05*' }] }, new Set());
  assert.match(where, /GLOB \?/);
  assert.deepEqual(whereParams, ['$.name', 'K05*']);
});

test('regex compiles to REGEXP with the pattern bound', () => {
  const { where, whereParams } = compileQuery({ filter: [{ field: 'name', op: 'regex', value: '^K0' }] }, new Set());
  assert.match(where, /REGEXP \?/);
  assert.deepEqual(whereParams, ['$.name', '^K0']);
});

test('nin compiles to NOT IN with each element bound', () => {
  const { where, whereParams } = compileQuery({ filter: [{ field: 'tag', op: 'nin', value: ['a', 'b'] }] }, new Set());
  assert.match(where, /NOT IN \(\?, \?\)/);
  assert.deepEqual(whereParams, ['$.tag', 'a', 'b']);
});

test('exists compiles to IS NOT NULL / IS NULL (no extra value bound)', () => {
  const yes = compileQuery({ filter: [{ field: 'tag', op: 'exists', value: true }] }, new Set());
  assert.match(yes.where, /IS NOT NULL/);
  assert.deepEqual(yes.whereParams, ['$.tag']);
  const no = compileQuery({ filter: [{ field: 'tag', op: 'exists', value: false }] }, new Set());
  assert.match(no.where, /IS NULL/);
});

test('boolean filter value binds as 0/1 (better-sqlite3 cannot bind a JS boolean)', () => {
  const t = compileQuery({ filter: [{ field: 'active', op: 'eq', value: true }] }, new Set());
  assert.deepEqual(t.whereParams, ['$.active', 1]);
  const f = compileQuery({ filter: [{ field: 'active', op: 'eq', value: false }] }, new Set());
  assert.deepEqual(f.whereParams, ['$.active', 0]);
  const arr = compileQuery({ filter: [{ field: 'active', op: 'in', value: [true, false] }] }, new Set());
  assert.deepEqual(arr.whereParams, ['$.active', 1, 0]);
});
