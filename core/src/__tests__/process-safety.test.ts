/**
 * installUnhandledRejectionLogger: Core's last line against a stray rejection. Without it
 * Node (≥ 15) exits on the first unhandled rejection, and nothing restarts Core. Runs in a
 * child process so the test runner's own process-level handlers are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { spawnSync } from 'child_process';

const MOD = path.join(__dirname, '..', 'utils', 'process-safety.js');

function run(install: boolean) {
  const script = `
    ${install ? `require(${JSON.stringify(MOD)}).installUnhandledRejectionLogger();` : ''}
    ${install ? `require(${JSON.stringify(MOD)}).installUnhandledRejectionLogger();` : ''}
    Promise.reject(new Error('stray-rejection-1'));
    Promise.reject(new Error('stray-rejection-2'));
    setTimeout(() => { process.stdout.write('ALIVE'); process.exit(0); }, 200);
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
}

test('without the logger a stray rejection kills the process (the hazard)', () => {
  const r = run(false);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /ALIVE/);
});

test('with the logger the process keeps running and logs once (rate-limited, idempotent)', () => {
  const r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ALIVE/);
  const logged = r.stderr.match(/unhandled promise rejection — kept running/g) || [];
  assert.equal(logged.length, 1, 'installed twice + two rejections within 1 s → one line');
  assert.match(r.stderr, /stray-rejection-1/);
});
