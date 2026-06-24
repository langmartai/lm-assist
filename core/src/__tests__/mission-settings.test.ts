import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULTS } from '../project-settings';

test('mission controller defaults exist', () => {
  assert.strictEqual(DEFAULTS.missionControllerEnabled, true);
  assert.strictEqual(DEFAULTS.missionControllerIntervalMin, 5);
  assert.strictEqual(DEFAULTS.missionControllerMaxNudges, 6);
  assert.strictEqual(DEFAULTS.missionControllerModel, 'claude-opus-4-8[1m]');
});
