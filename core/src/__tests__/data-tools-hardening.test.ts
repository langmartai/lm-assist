import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, isDangerousPattern } from '../data/backends/query-filter';
import { selectLines, windowValue, resolvePath, summarizeRecord, normalizeFilter, detectType } from '../mcp-server/tools/data-tools-format';
import type { DataRecord } from '../data/types';

const recF = (fields: Record<string, unknown>): DataRecord => ({ id: 'x', version: 1, fields, createdAt: '', updatedAt: '' });

/**
 * Hardening pass (2026-06-20) — fixes for the adversarial-review findings:
 * ReDoS, the `lines` set-bomb, windowValue clamps, summarize budget, prototype
 * access, and cache/SQL null-handling + case alignment.
 */

// ---- ReDoS guard (CRITICAL) ----

test('isDangerousPattern flags nested quantifiers and many-wildcard globs', () => {
  assert.equal(isDangerousPattern('(a+)+$'), true);
  assert.equal(isDangerousPattern('(.*)*'), true);
  assert.equal(isDangerousPattern('.*a.*a.*a.*a.*a.*a.*a.*a.*a.*'), true); // glob *a*a*...
  assert.equal(isDangerousPattern('^deploy'), false);
  assert.equal(isDangerousPattern('K0[0-9]+'), false);
});

test('matches: a catastrophic regex is refused FAST, not run (returns false in ms)', () => {
  const victim = recF({ t: 'a'.repeat(60) + '!' });
  const t0 = Date.now();
  const r = matches(victim, { field: 't', op: 'regex', value: '(a+)+$' });
  const ms = Date.now() - t0;
  assert.equal(r, false);
  assert.ok(ms < 100, `expected fast refusal, took ${ms}ms`);
});

test('matches: a catastrophic wildcard is refused FAST too', () => {
  const victim = recF({ t: 'a'.repeat(60) });
  const t0 = Date.now();
  matches(victim, { field: 't', op: 'wildcard', value: '*a*a*a*a*a*a*a*a*a*a*a*a*b' });
  assert.ok(Date.now() - t0 < 100, 'wildcard ReDoS should be refused fast');
});

test('normalizeFilter rejects a dangerous regex/wildcard with BAD_PATTERN', () => {
  assert.throws(() => normalizeFilter([{ field: 't', op: 'regex', value: '(a+)+$' }]), /BAD_PATTERN|dangerous/i);
  assert.throws(() => normalizeFilter([{ field: 't', op: 'wildcard', value: '*a*a*a*a*a*a*a*a*a*a*b' }]), /BAD_PATTERN|dangerous/i);
});

// ---- flags whitelist (fixes stateful 'g' corruption) ----

test('normalizeFilter rejects unsafe regex flags (g, y) and accepts i/m/s', () => {
  assert.throws(() => normalizeFilter([{ field: 't', op: 'regex', value: 'a', flags: 'g' }]), /flag/i);
  assert.throws(() => normalizeFilter([{ field: 't', op: 'regex', value: 'a', flags: 'y' }]), /flag/i);
  assert.equal(normalizeFilter([{ field: 't', op: 'regex', value: 'a', flags: 'i' }])![0].flags, 'i');
  assert.equal(normalizeFilter([{ field: 't', op: 'regex', value: 'a', flags: 'ims' }])![0].flags, 'ims');
});

// ---- lines set-bomb (CRITICAL) ----

test('selectLines clamps an absurd range instead of building a giant Set', () => {
  const text = ['a', 'b', 'c'].join('\n');
  const t0 = Date.now();
  const r: any = selectLines(text, '1-9999999999');
  assert.ok(Date.now() - t0 < 100, 'must not expand the full range');
  assert.deepEqual(r.lines.map((l: any) => l.line), [1, 2, 3]); // clamped to existing lines
});

// ---- windowValue clamps ----

test('windowValue clamps negative limit and truncates float offset/limit', () => {
  const a: any = windowValue([10, 20, 30, 40], { offset: 0, limit: -3 });
  assert.ok(a.returned >= 0 && Array.isArray(a.content), 'negative array limit must not slice from the end');
  assert.ok(!a.content.includes(40) || a.content[0] === 10, 'must window from the front');
  const t: any = windowValue('abcdefghij', { offset: 2.7, limit: 3.9 });
  assert.equal(Number.isInteger(t.offset), true);
  assert.equal(Number.isInteger(t.returned), true);
});

test('windowValue caps an enormous text limit', () => {
  const big = 'x'.repeat(500000);
  const r: any = windowValue(big, { offset: 0, limit: 1e12 });
  assert.ok(r.content.length <= 200000, `text window must be capped, got ${r.content.length}`);
});

// ---- summarizeRecord overall budget ----

test('summarizeRecord caps total size even with hundreds of small fields', () => {
  const fields: Record<string, unknown> = {};
  for (let i = 0; i < 600; i++) fields['f' + i] = 'value number ' + i;
  const out = summarizeRecord({ id: 'big', version: 1, fields });
  assert.ok(JSON.stringify(out).length < 30000, `summary must stay bounded, got ${JSON.stringify(out).length}`);
});

// ---- resolvePath prototype guard ----

test('resolvePath refuses __proto__/constructor/prototype tokens', () => {
  const rec = recF({ a: 1 });
  assert.equal(resolvePath(rec, '__proto__').ok, false);
  assert.equal(resolvePath(rec, 'constructor.prototype').ok, false);
});

test('resolvePath falls back to fields.<name> for a reserved bare name with no top-level value', () => {
  const rec: DataRecord = { id: 'x', version: 1, fields: { text: 'inner body' }, createdAt: '', updatedAt: '' };
  // record has no top-level `text` distinct from fields.text → bare "text" should still find the field body
  const r = resolvePath(rec, 'text');
  assert.equal(r.ok, true);
});

// ---- cache null / case alignment ----

test('matches: eq/ne null treats absent and explicit-null alike', () => {
  assert.equal(matches(recF({ tag: null }), { field: 'tag', op: 'eq', value: null }), true);
  assert.equal(matches(recF({}), { field: 'tag', op: 'eq', value: null }), true);      // absent
  assert.equal(matches(recF({ tag: 'A' }), { field: 'tag', op: 'eq', value: null }), false);
  assert.equal(matches(recF({ tag: 'A' }), { field: 'tag', op: 'ne', value: null }), true);
});

test('matches: contains is case-insensitive (matches the SQL LIKE behavior)', () => {
  assert.equal(matches(recF({ name: 'Beta' }), { field: 'name', op: 'contains', value: 'BET' }), true);
});

// ---- detectType: hex is not binary ----

test('detectType: a 64-char hex digest is text, not binary', () => {
  assert.equal(detectType('a'.repeat(64)).type, 'text');
  assert.equal(detectType('deadbeef'.repeat(8)).type, 'text');
});
