// core/src/__tests__/search/fts-query.test.ts
// The FTS5 MATCH argument is a GRAMMAR, not a bag of words. These tests pin the two
// properties that keep it from being one: no caller text is ever parsed as syntax,
// and a query made entirely of noise yields no expression rather than a bare scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeFts, buildFtsMatch } from '../../data/backends/fts-query';

test('drops the stopword that made every query match every session', () => {
  // `and` was the whole match-all defect: the old scorer substring-tested it, so it hit
  // `command`, `understand`, `expands` — 126 of 126 sessions in the measured project.
  assert.deepEqual(tokenizeFts('auto model discovery and publish'), ['auto', 'model', 'discovery', 'publish']);
  assert.deepEqual(tokenizeFts('the a of to is it'), []);
});

test('de-duplicates and bounds the term list', () => {
  assert.deepEqual(tokenizeFts('model model model'), ['model']);
  const many = tokenizeFts(Array.from({ length: 100 }, (_, i) => `term${i}`).join(' '));
  assert.equal(many.length, 24, 'term count is capped so a pathological query cannot build a huge expression');
});

test('quotes every term so FTS5 operators in user text are searched, not executed', () => {
  // Each of these would otherwise be parsed: `-` as NOT, `*` as prefix, `"` as a phrase
  // delimiter, and a bare AND/OR/NOT as an operator.
  for (const raw of ['auto-model discovery', 'what is the "right" fix?', 'model * discovery', 'foo AND bar', 'alpha NOT beta', '(grouped)', 'col:value']) {
    const m = buildFtsMatch(raw);
    assert.ok(m, `expected an expression for ${JSON.stringify(raw)}`);
    // Only quoted literals and the joining operator may appear.
    assert.match(m!, /^"[^"]+"( (AND|OR) "[^"]+")*$/, `unquoted syntax leaked for ${JSON.stringify(raw)}: ${m}`);
  }
});

test('a query with no usable terms yields null, never an empty filter', () => {
  // Returning '' here would compile to a WHERE with no MATCH clause — i.e. the whole
  // table. "No searchable terms" must be distinguishable from "matched everything".
  assert.equal(buildFtsMatch('the of and to'), null);
  assert.equal(buildFtsMatch('??? !!!'), null);
  assert.equal(buildFtsMatch(''), null);
});

test('and/or modes join with the requested operator', () => {
  assert.equal(buildFtsMatch('model discovery', 'and'), '"model" AND "discovery"');
  assert.equal(buildFtsMatch('model discovery', 'or'), '"model" OR "discovery"');
});
