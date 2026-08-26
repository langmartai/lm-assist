// core/src/__tests__/search/fts-query.test.ts
// The FTS5 MATCH argument is a GRAMMAR, not a bag of words. These tests pin the two
// properties that keep it from being one: no caller text is ever parsed as syntax,
// and a query made entirely of noise yields no expression rather than a bare scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeFts, buildFtsMatch, expandCjk, hasCjk } from '../../data/backends/fts-query';

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

test('CJK runs expand to overlapping bigrams so sub-word search works', () => {
  // Chinese writes without spaces, so unicode61 treats a whole run as ONE token: a
  // document holding that run could not be found by searching a word inside it. Bigrams —
  // not SQLite's `trigram` tokenizer, which needs 3+ chars while most Chinese words are two.
  assert.equal(expandCjk('搜索'), '搜索');
  assert.equal(expandCjk('文件搜索'), '文件 件搜 搜索');
  assert.deepEqual(tokenizeFts('文件搜索功能实现'), ['文件', '件搜', '搜索', '索功', '功能', '能实', '实现']);
  // The query side produces a term the document side also produced — that is the match.
  assert.ok(tokenizeFts('文件搜索功能实现').includes('搜索'));
});

test('CJK expansion leaves latin text completely alone', () => {
  assert.equal(expandCjk('sqlite fts index'), 'sqlite fts index');
  assert.deepEqual(tokenizeFts('sqlite fts index'), ['sqlite', 'fts', 'index']);
});

test('mixed CJK/latin keeps both halves searchable', () => {
  const t = tokenizeFts('修复 websocket 连接问题');
  assert.ok(t.includes('websocket'), 'latin term survives');
  assert.ok(t.includes('连接'), 'CJK sub-word is reachable');
});

test('hasCjk gates the work', () => {
  assert.equal(hasCjk('plain ascii only'), false);
  assert.equal(hasCjk('has 中文 inside'), true);
});
