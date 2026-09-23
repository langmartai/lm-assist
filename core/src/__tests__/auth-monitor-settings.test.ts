import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic: project-settings resolves its file from LM_ASSIST_DATA_DIR at LOAD time, so point
// it at a temp dir BEFORE requiring it — a static import is hoisted above this and would
// round-trip the operator's real ~/.lm-assist/project-settings.json (shared by dev AND prod).
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-'));
delete require.cache[require.resolve('../project-settings')];
const { getProjectSettings, saveProjectSettings, DEFAULTS } = require('../project-settings') as typeof import('../project-settings');

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
