import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULTS } from '../../project-settings';

function freshSettings(dataDir: string): any {
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  delete require.cache[require.resolve('../../project-settings')];
  return require('../../project-settings');
}

test('fabricEnabled defaults to true', () => {
  assert.equal((DEFAULTS as unknown as Record<string, unknown>).fabricEnabled, true);
});

test('fabricEnabled reads false from the settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-'));
  fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ fabricEnabled: false }));
  const { getProjectSettings } = freshSettings(dir);
  assert.equal(getProjectSettings().fabricEnabled, false);
});

test('saveProjectSettings round-trips fabricEnabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fab2-'));
  const { getProjectSettings, saveProjectSettings } = freshSettings(dir);
  saveProjectSettings({ fabricEnabled: false });
  assert.equal(getProjectSettings().fabricEnabled, false);
});
