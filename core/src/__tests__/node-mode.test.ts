import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMemorySyncConfig, writeMemorySyncConfig } from '../memory/node-mode';

// Hermetic: this var would otherwise redirect the config path away from the tmp home.
delete process.env.LM_ASSIST_DATA_DIR;

function withTmpHome(cfg: object | null, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  fs.mkdirSync(path.join(dir, '.lm-assist'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(dir, '.lm-assist', 'memory-sync.json'), JSON.stringify(cfg));
  fn(dir);
}

test('defaults to persistent mode + no home when file missing', () => {
  withTmpHome(null, (dir) => {
    const c = readMemorySyncConfig(dir);
    assert.equal(c.nodeMode, 'persistent');
    assert.equal(c.homeNode, null);
  });
});

test('reads ephemeral mode + homeNode from file', () => {
  withTmpHome({ nodeMode: 'ephemeral', homeNode: 'gw4-abc', project: '-home-x' }, (dir) => {
    const c = readMemorySyncConfig(dir);
    assert.equal(c.nodeMode, 'ephemeral');
    assert.equal(c.homeNode, 'gw4-abc');
    assert.equal(c.project, '-home-x');
  });
});

test('malformed json -> safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  fs.mkdirSync(path.join(dir, '.lm-assist'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.lm-assist', 'memory-sync.json'), '{not json');
  assert.equal(readMemorySyncConfig(dir).nodeMode, 'persistent');
});

test('writeMemorySyncConfig round-trips and merges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  writeMemorySyncConfig({ nodeMode: 'ephemeral', homeNode: 'gw9' }, dir);
  let c = readMemorySyncConfig(dir);
  assert.equal(c.nodeMode, 'ephemeral');
  assert.equal(c.homeNode, 'gw9');
  // a partial write keeps prior fields
  writeMemorySyncConfig({ project: '-proj' }, dir);
  c = readMemorySyncConfig(dir);
  assert.equal(c.homeNode, 'gw9');
  assert.equal(c.project, '-proj');
});
