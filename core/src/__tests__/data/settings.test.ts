import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic: set the data dir BEFORE project-settings loads (it resolves its file path once, at
// module load) — otherwise this round-trips the real ~/.lm-assist/project-settings.json.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-'));
delete require.cache[require.resolve('../../project-settings')];
const { DEFAULTS, getProjectSettings, saveProjectSettings } = require('../../project-settings') as typeof import('../../project-settings');

test('dataSyncViaFabric defaults OFF (opt-in — replaces a working sync transport)', () => {
  assert.equal((DEFAULTS as unknown as Record<string, unknown>).dataSyncViaFabric, false);
});

test('load coerces a persisted dataSyncViaFabric=true', () => {
  const prev = getProjectSettings().dataSyncViaFabric;
  const updated = saveProjectSettings({ dataSyncViaFabric: true });
  assert.equal(updated.dataSyncViaFabric, true);
  saveProjectSettings({ dataSyncViaFabric: prev }); // restore
});
