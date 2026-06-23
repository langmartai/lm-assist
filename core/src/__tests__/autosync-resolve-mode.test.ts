import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveMode } from '../memory/autosync';

// resolveMode lazy-requires project-settings; control it via a fresh LM_ASSIST_DATA_DIR + cache reset.
function setSetting(enabled: boolean | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  if (enabled !== null) {
    fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ memorySyncEnabled: enabled }));
  }
  delete require.cache[require.resolve('../project-settings')];
}

test('no env + default setting (true) → on', () => {
  delete process.env.MEMORY_AUTOSYNC;
  setSetting(null); // no file → default memorySyncEnabled true
  assert.equal(resolveMode(), 'on');
});

test('no env + memorySyncEnabled false → off', () => {
  delete process.env.MEMORY_AUTOSYNC;
  setSetting(false);
  assert.equal(resolveMode(), 'off');
});

test('env MEMORY_AUTOSYNC=observe wins over the setting', () => {
  process.env.MEMORY_AUTOSYNC = 'observe';
  setSetting(true);
  assert.equal(resolveMode(), 'observe');
  delete process.env.MEMORY_AUTOSYNC;
});

test('env off wins over the setting', () => {
  process.env.MEMORY_AUTOSYNC = 'off';
  setSetting(true);
  assert.equal(resolveMode(), 'off');
  delete process.env.MEMORY_AUTOSYNC;
});

test('env on wins over a false setting', () => {
  process.env.MEMORY_AUTOSYNC = 'on';
  setSetting(false);
  assert.equal(resolveMode(), 'on');
  delete process.env.MEMORY_AUTOSYNC;
});
