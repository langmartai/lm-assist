import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// SETTINGS_FILE is computed at module load from getDataDir() (LM_ASSIST_DATA_DIR), so set the env
// then re-require the module fresh for each fixture.
function freshSettings(dataDir: string): any {
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  delete require.cache[require.resolve('../project-settings')];
  return require('../project-settings');
}

test('crossProjectSignpostEnabled defaults to true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-set-'));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().crossProjectSignpostEnabled, true);
});

test('crossProjectSignpostEnabled reads false from the settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-set2-'));
  fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ crossProjectSignpostEnabled: false }));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().crossProjectSignpostEnabled, false);
});

test('saveProjectSettings round-trips the flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-set3-'));
  const { getProjectSettings, saveProjectSettings } = freshSettings(dir);
  saveProjectSettings({ crossProjectSignpostEnabled: false });
  assert.equal(getProjectSettings().crossProjectSignpostEnabled, false);
});
