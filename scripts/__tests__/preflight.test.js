'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pf = require('../preflight.js');

test('parseNodeVersion parses v?MAJOR.MINOR.PATCH', () => {
  assert.deepStrictEqual(pf.parseNodeVersion('v20.9.0'), { major: 20, minor: 9, patch: 0 });
  assert.deepStrictEqual(pf.parseNodeVersion('18.20.4'), { major: 18, minor: 20, patch: 4 });
  assert.strictEqual(pf.parseNodeVersion('garbage'), null);
  assert.strictEqual(pf.parseNodeVersion(''), null);
});

test('nodeMeetsMinimum gates at 20.9', () => {
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 20, minor: 9, patch: 0 }), true);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 20, minor: 19, patch: 6 }), true);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 22, minor: 0, patch: 0 }), true);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 20, minor: 8, patch: 9 }), false);
  assert.strictEqual(pf.nodeMeetsMinimum({ major: 18, minor: 20, patch: 4 }), false);
  assert.strictEqual(pf.nodeMeetsMinimum(null), false);
});

test('nodeUpgradeGuidance picks the present manager per OS', () => {
  assert.match(pf.nodeUpgradeGuidance('linux', { nvm: true }), /nvm install 20 && nvm use 20/);
  assert.match(pf.nodeUpgradeGuidance('linux', { fnm: true }), /fnm install 20/);
  assert.match(pf.nodeUpgradeGuidance('linux', {}), /nodejs\.org/);
  assert.match(pf.nodeUpgradeGuidance('win32', { nvmWindows: true }), /nvm install 20\.19\.6/);
  assert.match(pf.nodeUpgradeGuidance('win32', { fnm: true }), /fnm install 20/);
  assert.match(pf.nodeUpgradeGuidance('win32', {}), /nodejs\.org/);
});

test('evaluate: too-old node fails hard with manager guidance', () => {
  const r = pf.evaluate({ nodeVersion: 'v18.20.4', platform: 'linux', hasGit: true, hasNpm: true, managers: { nvm: true }, phase: 'pre-clone' });
  assert.strictEqual(r.ok, false);
  assert.match(r.guidance, /nvm install 20/);
  assert.strictEqual(r.checks.find((c) => c.name === 'node').ok, false);
});

test('evaluate: good node + prereqs passes pre-clone with no guidance', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'pre-clone' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.guidance, null);
});

test('evaluate: missing git fails hard', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: false, hasNpm: true, managers: {}, phase: 'pre-clone' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checks.find((c) => c.name === 'git').ok, false);
});

test('evaluate: post-clone chokidar 4/5 fails with pin guidance', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '5.0.0' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.guidance, /chokidar@\^3\.6\.0/);
});

test('evaluate: post-clone chokidar 3.6.0 passes', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '3.6.0' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.guidance, null);
});

test('evaluate: post-clone chokidar unresolved fails', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: false, error: 'not found' } });
  assert.strictEqual(r.ok, false);
});

const cp = require('node:child_process');
const path = require('node:path');

test('CLI --json pre-clone on this host exits 0 with ok:true and a checks array', () => {
  // This host runs Node >= 20.9 (the dev/test node), so pre-clone must pass.
  const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'preflight.js'), '--json', '--phase=pre-clone'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.strictEqual(j.ok, true);
  assert.ok(Array.isArray(j.checks));
  assert.ok(j.checks.find((c) => c.name === 'node').ok);
});

test('CLI human report prints a status line and exits 0 on a healthy host', () => {
  const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'preflight.js'), '--phase=pre-clone'], { encoding: 'utf8' });
  assert.match(out, /lm-assist preflight/);
  assert.match(out, /Preflight OK/);
});
