import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { coreKind, coreRuntimeFiles } from '../utils/core-runtime-files';
import { relaunchStdio } from '../relaunch-helper';

test('coreKind — prod when running from an npm install, dev from a checkout', () => {
  assert.equal(coreKind(path.join('C:', 'nvm4w', 'nodejs', 'node_modules', 'lm-assist', 'core', 'dist')), 'prod');
  assert.equal(coreKind('/home/u/.nvm/versions/node/v20/lib/node_modules/lm-assist/core/dist/utils'), 'prod');
  assert.equal(coreKind('/home/u/lm-assist/core/dist'), 'dev');
});

test('coreRuntimeFiles — the service manager names: ~/.cache/lm-assist/core-{prod|dev}.{log|pid}', () => {
  const home = path.join(os.tmpdir(), 'home-x');
  const dir = path.join(home, '.cache', 'lm-assist');
  assert.deepEqual(coreRuntimeFiles('prod', home), { dir, log: path.join(dir, 'core-prod.log'), pid: path.join(dir, 'core-prod.pid') });
  assert.deepEqual(coreRuntimeFiles('dev', home), { dir, log: path.join(dir, 'core-dev.log'), pid: path.join(dir, 'core-dev.pid') });
});

test('relaunchStdio — the relaunched Core APPENDS to the Core log (it used to run with stdio ignore)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  const log = path.join(dir, 'nested', 'core-prod.log');
  const { stdio, fd } = relaunchStdio(log);
  assert.ok(fd !== null && Array.isArray(stdio));
  assert.deepEqual(stdio, ['ignore', fd, fd]);
  fs.writeSync(fd!, 'line from the relaunched core\n');
  fs.closeSync(fd!);
  const again = relaunchStdio(log);
  fs.writeSync(again.fd!, 'second core\n');
  fs.closeSync(again.fd!);
  assert.equal(fs.readFileSync(log, 'utf8'), 'line from the relaunched core\nsecond core\n');
});

test('relaunchStdio — an unusable log path degrades to ignore instead of blocking the relaunch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x'); // a FILE where the log's parent dir should be
  assert.deepEqual(relaunchStdio(path.join(blocker, 'core-prod.log')), { stdio: 'ignore', fd: null });
});
