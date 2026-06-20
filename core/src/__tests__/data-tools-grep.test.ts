import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grepField, selectLines } from '../mcp-server/tools/data-tools-format';

/**
 * Line-oriented content retrieval for data_get (requested 2026-06-20): grep a
 * field for lines matching a pattern (returns 1-based line numbers, like grep -n),
 * and select explicit line ranges. The "line number operator to retrieve."
 */

test('grepField: returns matching lines with 1-based line numbers', () => {
  const text = ['alpha', 'beta', 'gamma beta', 'delta'].join('\n');
  const r: any = grepField(text, 'beta', {});
  assert.equal(r.unit, 'matches');
  assert.equal(r.totalMatches, 2);
  assert.deepEqual(r.matches.map((m: any) => m.line), [2, 3]);
  assert.equal(r.matches[0].text, 'beta');
});

test('grepField: ignoreCase + context lines (before/after)', () => {
  const text = ['a', 'TARGET here', 'b', 'c'].join('\n');
  const r: any = grepField(text, 'target', { ignoreCase: true, context: 1 });
  assert.equal(r.matches[0].line, 2);
  assert.deepEqual(r.matches[0].before, ['a']);
  assert.deepEqual(r.matches[0].after, ['b']);
});

test('grepField: wildcard pattern matches within a line (unanchored)', () => {
  const text = ['export const a = 1', 'const b = 2', 'let c = 3'].join('\n');
  const r: any = grepField(text, 'const*=', { wildcard: true });
  // "const*=" → /const.*=/ unanchored → lines 1 and 2 contain it
  assert.deepEqual(r.matches.map((m: any) => m.line), [1, 2]);
});

test('grepField: maxMatches caps returned matches but reports the true total', () => {
  const text = Array.from({ length: 10 }, () => 'hit').join('\n');
  const r: any = grepField(text, 'hit', { maxMatches: 3 });
  assert.equal(r.totalMatches, 10);
  assert.equal(r.matches.length, 3);
  assert.equal(r.hasMore, true);
});

test('grepField: binary content is refused (use a byte range instead)', () => {
  const bin = String.fromCharCode(0, 1, 2) + 'Z'.repeat(50);
  const r: any = grepField(bin, 'Z', {});
  assert.ok(r.error && /binary/i.test(r.error));
});

test('grepField: a json value is grepped over its pretty-printed form', () => {
  const r: any = grepField({ parts: [{ title: 'Overview' }, { title: 'Details' }] }, 'Details', {});
  assert.equal(r.totalMatches, 1);
  assert.ok(/Details/.test(r.matches[0].text));
});

test('selectLines: multi-range selector returns those lines, numbered, sorted, deduped', () => {
  const text = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
  const r: any = selectLines(text, '2-4, 7, 9-10');
  assert.equal(r.unit, 'lines');
  assert.equal(r.totalLines, 10);
  assert.deepEqual(r.lines.map((l: any) => l.line), [2, 3, 4, 7, 9, 10]);
  assert.equal(r.lines[0].text, 'L2');
});

test('selectLines: out-of-range numbers are dropped', () => {
  const text = ['only', 'two'].join('\n');
  const r: any = selectLines(text, '1,5-9');
  assert.deepEqual(r.lines.map((l: any) => l.line), [1]);
});
