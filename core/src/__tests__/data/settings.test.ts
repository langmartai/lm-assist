import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS, getProjectSettings, saveProjectSettings } from '../../project-settings';

test('dataSyncViaFabric defaults OFF (opt-in — replaces a working sync transport)', () => {
  assert.equal((DEFAULTS as unknown as Record<string, unknown>).dataSyncViaFabric, false);
});

test('load coerces a persisted dataSyncViaFabric=true', () => {
  const prev = getProjectSettings().dataSyncViaFabric;
  const updated = saveProjectSettings({ dataSyncViaFabric: true });
  assert.equal(updated.dataSyncViaFabric, true);
  saveProjectSettings({ dataSyncViaFabric: prev }); // restore
});
