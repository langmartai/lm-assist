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
  assert.strictEqual(s.autoResumeMaxIntervalMin, 30); // cap the widening backoff
  assert.strictEqual(s.autoResumeNeverGiveUp, true); // keep retrying through long outages
  const saved = ps.saveProjectSettings({ autoResumeStalledEnabled: false, autoResumeMaxAttempts: 3 });
  assert.strictEqual(saved.autoResumeStalledEnabled, false);
  assert.strictEqual(saved.autoResumeMaxAttempts, 3);
  assert.strictEqual(saved.autoResumeIntervalMin, 5); // untouched
  assert.strictEqual(saved.autoResumeMaxIntervalMin, 30); // untouched
  assert.strictEqual(saved.autoResumeNeverGiveUp, true); // untouched
});
