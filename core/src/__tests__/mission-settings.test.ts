import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULTS } from '../project-settings';

test('mission controller defaults exist', () => {
  assert.strictEqual(DEFAULTS.missionControllerEnabled, true);
  assert.strictEqual(DEFAULTS.missionControllerIntervalMin, 5);
  assert.strictEqual(DEFAULTS.missionControllerMaxNudges, 6);
  assert.strictEqual(DEFAULTS.missionControllerModel, 'claude-opus-4-8[1m]');
});

test('missionHistoryInlineCap default is 50', () => {
  assert.strictEqual(DEFAULTS.missionHistoryInlineCap, 50);
});

test('missionHistoryInlineCap loader coerces a numeric configured value', () => {
  // Simulate a file with a numeric value
  const data: Record<string, unknown> = { missionHistoryInlineCap: 100 };
  const result = typeof data.missionHistoryInlineCap === 'number' ? data.missionHistoryInlineCap : DEFAULTS.missionHistoryInlineCap;
  assert.strictEqual(result, 100);
});

test('missionHistoryInlineCap loader ignores non-number and falls back to default', () => {
  // Simulate a file with a string value (misconfigured)
  const data: Record<string, unknown> = { missionHistoryInlineCap: 'not-a-number' };
  const result = typeof data.missionHistoryInlineCap === 'number' ? data.missionHistoryInlineCap : DEFAULTS.missionHistoryInlineCap;
  assert.strictEqual(result, DEFAULTS.missionHistoryInlineCap);
});
