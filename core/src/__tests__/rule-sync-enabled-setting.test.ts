import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function freshSettings(dataDir: string): any {
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  delete require.cache[require.resolve('../project-settings')];
  return require('../project-settings');
}
test('ruleSyncEnabled defaults to true', () => {
  const { getProjectSettings } = freshSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'rse-')));
  assert.equal(getProjectSettings().ruleSyncEnabled, true);
});
test('ruleSyncEnabled reads false from the settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rse2-'));
  fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ ruleSyncEnabled: false }));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().ruleSyncEnabled, false);
});
test('saveProjectSettings round-trips ruleSyncEnabled', () => {
  const { getProjectSettings, saveProjectSettings } = freshSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'rse3-')));
  saveProjectSettings({ ruleSyncEnabled: false });
  assert.equal(getProjectSettings().ruleSyncEnabled, false);
});
