import { test } from 'node:test';
import assert from 'node:assert';
import { parseAdjustResult } from '../mission/mission-model';

test('parses a valid verdict', () => {
  const r = parseAdjustResult('{"verdict":"done","nextDirective":"wrap up","isMaterialPivot":false,"reason":"objective met"}');
  assert.strictEqual(r.verdict, 'done');
  assert.strictEqual(r.nextDirective, 'wrap up');
  assert.strictEqual(r.isMaterialPivot, false);
});
test('extracts JSON embedded in prose', () => {
  const r = parseAdjustResult('Here is my decision:\n{"verdict":"revise","nextDirective":"try Y","isMaterialPivot":true,"revisedObjective":"Y"}\nThanks');
  assert.strictEqual(r.verdict, 'revise');
  assert.strictEqual(r.revisedObjective, 'Y');
  assert.strictEqual(r.isMaterialPivot, true);
});
test('garbage defaults to continue', () => {
  const r = parseAdjustResult('not json at all');
  assert.strictEqual(r.verdict, 'continue');
  assert.strictEqual(r.nextDirective, 'continue');
});
test('unknown verdict falls back to continue; missing directive defaults', () => {
  const r = parseAdjustResult('{"verdict":"explode"}');
  assert.strictEqual(r.verdict, 'continue');
  assert.strictEqual(r.nextDirective, 'continue');
});
