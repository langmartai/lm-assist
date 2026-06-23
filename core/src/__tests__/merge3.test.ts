import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from '../memory/merge3';

test('identical sides → clean, unchanged', () => {
  const r = merge3('base', 'same', 'same');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'same');
  assert.equal(r.conflicts, 0);
});

test('only theirs changed (ours == base) → fast-forward to theirs', () => {
  const r = merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'a\nB\nc\n');
});

test('only ours changed (theirs == base) → keep ours', () => {
  const r = merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nc\n');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'A\nb\nc\n');
});

test('non-overlapping edits auto-merge cleanly (no LLM needed)', () => {
  const r = merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
  assert.equal(r.clean, true);
  assert.equal(r.conflicts, 0);
  assert.equal(r.merged, 'A\nb\nC\n');
});

test('overlapping edits to the same line → conflict (markers + count)', () => {
  const r = merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n');
  assert.equal(r.clean, false);
  assert.ok(r.conflicts >= 1);
  assert.match(r.merged, /<<<<<<</);
  assert.match(r.merged, />>>>>>>/);
  // both versions preserved in the markers (nothing lost)
  assert.match(r.merged, /X/);
  assert.match(r.merged, /Y/);
});
