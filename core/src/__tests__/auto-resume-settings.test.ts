import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('auto-resume settings default on with sane numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arset-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../project-settings')];
  const ps = require('../project-settings');
  const s = ps.getProjectSettings();
  assert.strictEqual(s.autoResumeStalledEnabled, true);
  assert.strictEqual(s.autoResumeIntervalMin, 5);
  assert.strictEqual(s.autoResumeMaxAttempts, 6);
  assert.strictEqual(s.autoResumeRemoteScan, true);
  const saved = ps.saveProjectSettings({ autoResumeStalledEnabled: false, autoResumeMaxAttempts: 3 });
  assert.strictEqual(saved.autoResumeStalledEnabled, false);
  assert.strictEqual(saved.autoResumeMaxAttempts, 3);
  assert.strictEqual(saved.autoResumeIntervalMin, 5); // untouched
});
