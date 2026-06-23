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

test('memorySyncEnabled defaults to true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-'));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().memorySyncEnabled, true);
});

test('memorySyncEnabled reads false from the settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mse2-'));
  fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ memorySyncEnabled: false }));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().memorySyncEnabled, false);
});

test('saveProjectSettings round-trips memorySyncEnabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mse3-'));
  const { getProjectSettings, saveProjectSettings } = freshSettings(dir);
  saveProjectSettings({ memorySyncEnabled: false });
  assert.equal(getProjectSettings().memorySyncEnabled, false);
});
