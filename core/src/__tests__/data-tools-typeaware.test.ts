import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectType, summarizeValue, resolvePath, windowValue } from '../mcp-server/tools/data-tools-format';
import type { DataRecord } from '../data/types';

/**
 * Type-aware return for the data_* tools (requested 2026-06-20): auto-detect
 * bin/text/json/code (+ code language + size), and let the caller fetch a part
 * in the unit natural to that type — chars for text, lines for code, JSON-path
 * for json, byte-range for binary.
 */

const NUL = (n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => i % 4)); // control bytes 0..3

// ---- detectType ----

test('detectType: object/array -> json with shape', () => {
  assert.equal(detectType({ a: 1, b: 2 }).type, 'json');
  assert.deepEqual(detectType({ a: 1, b: 2 }).keys, ['a', 'b']);
  const arr = detectType([1, 2, 3]);
  assert.equal(arr.type, 'json');
  assert.equal(arr.length, 3);
});

test('detectType: a JSON-parseable string -> json', () => {
  assert.equal(detectType('{"x":1,"y":2}').type, 'json');
  assert.equal(detectType('[1,2,3]').type, 'json');
});

test('detectType: prose -> text with char size', () => {
  const d = detectType('The quick brown fox jumps over the lazy dog. It was a fine day.');
  assert.equal(d.type, 'text');
  assert.ok((d.chars ?? 0) > 0);
});

test('detectType: source code -> code with a language guess', () => {
  assert.equal(detectType('export function f(x: number): number { return x + 1; }').type, 'code');
  assert.equal(detectType('export function f(x: number) { return x; }').lang, 'ts');
  assert.equal(detectType('def add(a, b):\n    return a + b\n').lang, 'py');
  assert.equal(detectType('SELECT id, name FROM users WHERE active = 1;').lang, 'sql');
  assert.equal(detectType('#!/bin/bash\nset -euo pipefail\necho hi\n').lang, 'sh');
});

test('detectType: NUL/control bytes -> binary, never carries the raw content', () => {
  const d = detectType('PK' + NUL(4) + 'binary stuff');
  assert.equal(d.type, 'binary');
  assert.ok((d.bytes ?? 0) > 0);
});

test('detectType: a long base64 blob -> binary', () => {
  const b64 = Buffer.from('x'.repeat(400)).toString('base64');
  assert.equal(detectType(b64).type, 'binary');
});

// ---- summarizeValue (type-aware summary used by the default view) ----

test('summarizeValue: small text passes through inline (no wrapper)', () => {
  assert.equal(summarizeValue('alpha'), 'alpha');
  assert.equal(summarizeValue(42), 42);
  assert.equal(summarizeValue(true), true);
});

test('summarizeValue: large code -> typed descriptor with lang, lines, snippet (no full body)', () => {
  const code = Array.from({ length: 200 }, (_, i) => `const x${i}: number = ${i};`).join('\n');
  const s: any = summarizeValue(code);
  assert.equal(s.type, 'code');
  assert.equal(s.lang, 'ts');
  assert.ok(s.lines >= 200);
  assert.ok(JSON.stringify(s).length < code.length); // strictly smaller than the full body
});

test('summarizeValue: binary -> descriptor with bytes, never the content', () => {
  const blob = NUL(3) + 'Z'.repeat(5000);
  const s: any = summarizeValue(blob);
  assert.equal(s.type, 'binary');
  assert.ok(s.bytes > 0);
  assert.ok(!JSON.stringify(s).includes('ZZZZZ')); // raw bytes not inlined
});

// ---- resolvePath (field / JSON path / part-id) ----

const rec: DataRecord = {
  id: 'K057', version: 1,
  fields: {
    title: 'Explore',
    parts: [
      { partId: 'K057.1', title: 'Overview', summary: 'first summary' },
      { partId: 'K057.2', title: 'Details', summary: 'second summary' },
    ],
  },
  text: 'line1\nline2\nline3\nline4\nline5',
  createdAt: '', updatedAt: '',
};

test('resolvePath: "text" resolves the record text', () => {
  const r = resolvePath(rec, 'text');
  assert.equal(r.ok, true);
  assert.equal((r as any).value, rec.text);
});

test('resolvePath: bare field name resolves under fields', () => {
  assert.equal((resolvePath(rec, 'title') as any).value, 'Explore');
});

test('resolvePath: JSON path with index + key', () => {
  assert.equal((resolvePath(rec, 'parts[1].summary') as any).value, 'second summary');
});

test('resolvePath: part:<id> resolves a parts[] element by partId', () => {
  assert.equal((resolvePath(rec, 'part:K057.2') as any).value.title, 'Details');
});

test('resolvePath: unknown path -> error, not a throw', () => {
  assert.equal(resolvePath(rec, 'nope.nope').ok, false);
});

// ---- windowValue (type-aware slicing, self-describing) ----

test('windowValue: text windows by chars and reports total + hasMore', () => {
  const w: any = windowValue('abcdefghij', { offset: 2, limit: 4 });
  assert.equal(w.unit, 'chars');
  assert.equal(w.content, 'cdef');
  assert.equal(w.total, 10);
  assert.equal(w.hasMore, true);
});

test('windowValue: code windows by lines and reports totalLines + lang', () => {
  const code = ['const a=1;', 'const b=2;', 'const c=3;', 'const d=4;'].join('\n');
  const w: any = windowValue(code, { offset: 2, limit: 2 });
  assert.equal(w.unit, 'lines');
  assert.equal(w.totalLines, 4);
  assert.equal(w.content, 'const b=2;\nconst c=3;'); // 1-based line 2..3
});

test('windowValue: json array pages by element', () => {
  const w: any = windowValue([10, 20, 30, 40, 50], { offset: 1, limit: 2 });
  assert.equal(w.unit, 'elements');
  assert.equal(w.total, 5);
  assert.deepEqual(w.content, [20, 30]);
});

test('windowValue: binary requires an explicit range, returns capped base64', () => {
  const blob = NUL(2) + 'Z'.repeat(200);
  const noRange: any = windowValue(blob, {});
  assert.equal(noRange.unit, 'bytes');
  assert.ok(noRange.note && !noRange.content); // refuses to inline without a range
  const ranged: any = windowValue(blob, { offset: 0, limit: 8 });
  assert.equal(ranged.unit, 'bytes');
  assert.ok(typeof ranged.content === 'string'); // base64 slice
  assert.equal(ranged.encoding, 'base64');
});
