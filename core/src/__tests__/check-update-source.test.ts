import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// We test the small pure shaper the route uses (see Step 3): buildSourceFields(readFn).
test('buildSourceFields surfaces currentSource + isCustomBuild', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cupd-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  ['../utils/install-source', '../routes/core/dev-mode.routes'].forEach((m) => { try { delete require.cache[require.resolve(m)]; } catch {} });
  const isrc = require('../utils/install-source');
  const { buildSourceFields } = require('../routes/core/dev-mode.routes');
  // no marker → null / false
  assert.deepStrictEqual(buildSourceFields(), { currentSource: null, isCustomBuild: false });
  // custom marker → isCustomBuild true
  isrc.recordInstallSource({ kind: 'custom', source: 'github:langmartai/lm-assist#v0.1.76', version: '0.1.76' });
  const r = buildSourceFields();
  assert.strictEqual(r.isCustomBuild, true);
  assert.strictEqual(r.currentSource.source, 'github:langmartai/lm-assist#v0.1.76');
});
