'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..'); // repo root
const BIN = path.join(REPO, 'bin', 'lm-assist.js');

test('`lm-assist doctor --json` runs the preflight and reports ok on this repo', () => {
  // projectRoot resolves to this repo (not node_modules) when run from source.
  const out = cp.execFileSync(process.execPath, [BIN, 'doctor', '--json'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.strictEqual(j.ok, true);
  assert.ok(j.checks.find((c) => c.name === 'chokidar'), 'post-clone phase includes chokidar');
});

test('`lm-assist doctor` is a recognized command (not "Unknown command")', () => {
  const out = cp.execFileSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8' });
  assert.match(out, /lm-assist preflight/);
});
