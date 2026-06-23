import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('round-trips records; keys are namespaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arstore-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../monitor/stall-store')];
  const s = require('../monitor/stall-store');
  assert.strictEqual(s.localKey('abc'), 'local:abc');
  assert.strictEqual(s.remoteKey('xyz'), 'ccr:xyz');
  assert.deepStrictEqual(s.loadStallStore(), {});
  s.saveStallStore({ 'local:abc': { attempts: 2, lastNudgeAt: 5, category: 'overloaded', backoffStep: 1, gaveUp: false } });
  const back = s.loadStallStore();
  assert.strictEqual(back['local:abc'].attempts, 2);
  // file is 0600
  const mode = fs.statSync(path.join(dir, 'stall-monitor.json')).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});
