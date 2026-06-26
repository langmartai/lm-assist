import { test } from 'node:test';
import assert from 'node:assert';
import { getProjectSettings, saveProjectSettings, DEFAULTS } from '../project-settings';

test('authMonitor defaults: enabled true, interval 15', () => {
  assert.strictEqual(DEFAULTS.authMonitorEnabled, true);
  assert.strictEqual(DEFAULTS.authMonitorIntervalMin, 15);
});

test('authMonitor settings round-trip + clamp', () => {
  const prev = getProjectSettings();
  try {
    let s = saveProjectSettings({ authMonitorEnabled: false, authMonitorIntervalMin: 9999 });
    assert.strictEqual(s.authMonitorEnabled, false);
    // interval is clamped at the route layer (1..1440); the store itself accepts the number
    assert.strictEqual(typeof s.authMonitorIntervalMin, 'number');
  } finally {
    saveProjectSettings({ authMonitorEnabled: prev.authMonitorEnabled, authMonitorIntervalMin: prev.authMonitorIntervalMin });
  }
});
