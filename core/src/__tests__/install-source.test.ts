import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isrc-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../utils/install-source')];
  return { mod: require('../utils/install-source'), dir };
}

test('classifyInstallSource: registry specs are published', () => {
  const { mod } = fresh();
  assert.deepStrictEqual(mod.classifyInstallSource(''), { kind: 'published', source: 'lm-assist@latest' });
  assert.deepStrictEqual(mod.classifyInstallSource('latest'), { kind: 'published', source: 'lm-assist@latest' });
  assert.deepStrictEqual(mod.classifyInstallSource('lm-assist@0.1.76'), { kind: 'published', source: 'lm-assist@0.1.76' });
  assert.deepStrictEqual(mod.classifyInstallSource('lm-assist@next'), { kind: 'published', source: 'lm-assist@next' });
});

test('classifyInstallSource: tgz / url / github / dir are custom', () => {
  const { mod } = fresh();
  assert.strictEqual(mod.classifyInstallSource('/tmp/lm-assist-0.1.76.tgz').kind, 'custom');
  assert.strictEqual(mod.classifyInstallSource('https://github.com/langmartai/lm-assist/releases/download/v0.1.76/lm-assist-0.1.76.tgz').kind, 'custom');
  assert.strictEqual(mod.classifyInstallSource('github:langmartai/lm-assist#v0.1.76').kind, 'custom');
  assert.strictEqual(mod.classifyInstallSource('/home/me/lm-assist').kind, 'custom');
});

test('record then read round-trips; file is 0600', () => {
  const { mod, dir } = fresh();
  assert.strictEqual(mod.readInstallSource(), null);
  mod.recordInstallSource({ kind: 'custom', source: 'github:langmartai/lm-assist#v0.1.76', version: '0.1.76' });
  const r = mod.readInstallSource();
  assert.strictEqual(r.kind, 'custom');
  assert.strictEqual(r.source, 'github:langmartai/lm-assist#v0.1.76');
  assert.strictEqual(r.version, '0.1.76');
  assert.ok(r.installedAt && r.installedAt.length > 0);
  assert.strictEqual(fs.statSync(path.join(dir, 'install-source.json')).mode & 0o777, 0o600);
});

test('read tolerates a corrupt/missing file → null', () => {
  const { mod, dir } = fresh();
  fs.writeFileSync(path.join(dir, 'install-source.json'), 'not json');
  assert.strictEqual(mod.readInstallSource(), null);
});
