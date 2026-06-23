'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');
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

// ── #1 workspace WARN check ─────────────────────────────────────────────────

test('evaluate: post-clone workspace ok=true is a soft WARN pass', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '3.6.0' }, workspace: { rootWorkspaces: true, strayChokidar: false } });
  const wc = r.checks.find((c) => c.name === 'workspace');
  assert.ok(wc, 'workspace check present');
  assert.strictEqual(wc.ok, true);
  assert.strictEqual(wc.hard, false);
  assert.match(wc.detail, /workspaces root OK/);
  assert.strictEqual(r.ok, true);
});

test('evaluate: post-clone workspace strayChokidar=true → ok:false but r.ok stays true (soft)', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '3.6.0' }, workspace: { rootWorkspaces: true, strayChokidar: true } });
  const wc = r.checks.find((c) => c.name === 'workspace');
  assert.ok(wc, 'workspace check present');
  assert.strictEqual(wc.ok, false);
  assert.strictEqual(wc.hard, false);
  assert.match(wc.detail, /stray core\/node_modules\/chokidar/);
  assert.strictEqual(r.ok, true, 'soft check must not flip r.ok');
  assert.strictEqual(r.guidance, null, 'guidance unchanged when only soft check fails');
});

test('evaluate: post-clone workspace rootWorkspaces=false → detail names the problem', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '3.6.0' }, workspace: { rootWorkspaces: false, strayChokidar: false } });
  const wc = r.checks.find((c) => c.name === 'workspace');
  assert.strictEqual(wc.ok, false);
  assert.match(wc.detail, /no "workspaces" in root package\.json/);
  assert.strictEqual(r.ok, true, 'soft check must not flip r.ok');
});

test('evaluate: post-clone with NO workspace key → NO workspace check pushed', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone', chokidar: { resolved: true, version: '3.6.0' } });
  const wc = r.checks.find((c) => c.name === 'workspace');
  assert.strictEqual(wc, undefined, 'workspace check must not be present when workspace not supplied');
});

// ── #2 cheap coverage Minors ────────────────────────────────────────────────

test('nodeUpgradeGuidance: linux nvm+fnm → nvm wins', () => {
  assert.match(pf.nodeUpgradeGuidance('linux', { nvm: true, fnm: true }), /nvm install 20 && nvm use 20/);
});

test('nodeUpgradeGuidance: win32 nvmWindows+fnm → nvm-windows wins', () => {
  assert.match(pf.nodeUpgradeGuidance('win32', { nvmWindows: true, fnm: true }), /nvm install 20\.19\.6/);
});

test('evaluate: post-clone with chokidar omitted → chokidar check absent → r.ok true', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'post-clone' });
  const ck = r.checks.find((c) => c.name === 'chokidar');
  assert.strictEqual(ck, undefined, 'chokidar check must not be pushed when input.chokidar is omitted');
  assert.strictEqual(r.ok, true);
});

test('evaluate: pre-clone with chokidar key supplied → NO chokidar check pushed', () => {
  const r = pf.evaluate({ nodeVersion: 'v22.0.0', platform: 'linux', hasGit: true, hasNpm: true, managers: {}, phase: 'pre-clone', chokidar: { resolved: true, version: '3.6.0' } });
  const ck = r.checks.find((c) => c.name === 'chokidar');
  assert.strictEqual(ck, undefined, 'chokidar check must be ignored pre-clone');
});
