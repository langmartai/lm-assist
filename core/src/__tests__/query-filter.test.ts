import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, applyQuery, globToRegExp } from '../data/backends/query-filter';
import type { DataRecord } from '../data/types';

const recF = (fields: Record<string, unknown>): DataRecord => ({ id: 'x', version: 1, fields, createdAt: '', updatedAt: '' });

const rec = (n: number): DataRecord => ({
  id: `r${n}`, version: 1, fields: { n, name: n === 1 ? 'alpha' : 'beta' },
  createdAt: '', updatedAt: '',
});

/**
 * Engine defense-in-depth for the same footgun the MCP layer normalizes: a
 * symbolic comparison operator must behave like its named equivalent, not
 * fall through to the silent `return false`. (The MCP handler already rejects a
 * truly-unknown op; here we only assert the symbolic aliases resolve.)
 */
test('matches resolves symbolic operators to their named equivalents', () => {
  assert.equal(matches(rec(2), { field: 'n', op: '>=' as any, value: 2 }), true);
  assert.equal(matches(rec(1), { field: 'n', op: '>=' as any, value: 2 }), false);
  assert.equal(matches(rec(2), { field: 'n', op: '=' as any, value: 2 }), true);
  assert.equal(matches(rec(2), { field: 'n', op: '!=' as any, value: 2 }), false);
  assert.equal(matches(rec(2), { field: 'n', op: '>' as any, value: 1 }), true);
});

test('matches still honors the named operators', () => {
  assert.equal(matches(rec(2), { field: 'n', op: 'gte', value: 2 }), true);
  assert.equal(matches(rec(1), { field: 'name', op: 'eq', value: 'alpha' }), true);
});

test('applyQuery filters with a symbolic operator (n >= 2 keeps r2 only)', () => {
  const out = applyQuery([rec(1), rec(2)], { filter: [{ field: 'n', op: '>=' as any, value: 2 }] });
  assert.deepEqual(out.records.map((r) => r.id), ['r2']);
  assert.equal(out.total, 1);
});

// ---- regex / wildcard / nin / exists operators ----

test('matches: regex (substring) + flags', () => {
  assert.equal(matches(recF({ title: 'Deploy guide' }), { field: 'title', op: 'regex', value: '^Dep' }), true);
  assert.equal(matches(recF({ title: 'a guide' }), { field: 'title', op: 'regex', value: '^Dep' }), false);
  assert.equal(matches(recF({ title: 'DEPLOY' }), { field: 'title', op: 'regex', value: 'dep', flags: 'i' }), true);
});

test('matches: regex with an invalid pattern is false (never throws inside a scan)', () => {
  assert.equal(matches(recF({ title: 'x' }), { field: 'title', op: 'regex', value: '(' }), false);
});

test('matches: wildcard is an anchored full-string glob', () => {
  assert.equal(matches(recF({ id2: 'K057' }), { field: 'id2', op: 'wildcard', value: 'K05*' }), true);
  assert.equal(matches(recF({ id2: 'XK057' }), { field: 'id2', op: 'wildcard', value: 'K05*' }), false);
  assert.equal(matches(recF({ id2: 'K057' }), { field: 'id2', op: 'wildcard', value: 'K05?' }), true);
  assert.equal(matches(recF({ id2: 'K05' }), { field: 'id2', op: 'wildcard', value: 'K05?' }), false);
});

test('matches: nin + exists', () => {
  assert.equal(matches(recF({ t: 'a' }), { field: 't', op: 'nin', value: ['b', 'c'] }), true);
  assert.equal(matches(recF({ t: 'a' }), { field: 't', op: 'nin', value: ['a', 'c'] }), false);
  assert.equal(matches(recF({ a: 1 }), { field: 'a', op: 'exists', value: true }), true);
  assert.equal(matches(recF({ a: 1 }), { field: 'b', op: 'exists', value: true }), false);
  assert.equal(matches(recF({ a: 1 }), { field: 'b', op: 'exists', value: false }), true);
});

test('globToRegExp: anchored translation of * and ?, literal dots', () => {
  assert.ok(globToRegExp('K05*').test('K057'));
  assert.ok(!globToRegExp('K05*').test('XK057'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(!globToRegExp('a?c').test('ac'));
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb')); // dot is literal, not regex-any
  assert.ok(globToRegExp('foo', { anchored: false }).test('xxfooxx')); // unanchored for grep
});
