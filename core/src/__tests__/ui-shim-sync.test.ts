/**
 * The pane shim deploys through a channel the build does not control — these tests hold the
 * mechanism that notices.
 *
 * Placed in `core/src/__tests__/` next to `lmui-shim-identity.test.ts`, its sibling guard: that
 * one keeps the 18 in-repo shim copies identical, this one keeps the DEPLOYED copies honest.
 * `run-tests.js` requires a `__tests__` path segment to treat a compiled `.test.js` as a suite;
 * it walks all of `dist-test`, so a nested `__tests__` dir works too (verified 2026-08-13: all
 * eight `src/ui-pages/local-tier/__tests__/` suites are discovered).
 *
 * Every test drives an isolated fake home via the appsRoot/stateDir/canonical seams — nothing
 * here reads or writes the real ~/.lmui.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  CANONICAL_PANE, canonicalShim, checkShims, syncShims, formatDrift, logShimDrift, listInstalledPanes,
} from '../ui-pages/shim-sync';

const CANON = Buffer.from('// canonical shim v2\nfetch("/viewtoken/remint", {body: JSON.stringify({uiId, token})});\n');
const OLD = Buffer.from('// old shim v1\nfetch("/viewtoken/remint", {body: JSON.stringify({uiId})});\n');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-shim-'));
}

/** Lay down a pane dir; `shim` undefined = no lmui.js at all. */
function pane(root: string, uiId: string, shim?: Buffer, bundle?: string): string {
  const dir = path.join(root, uiId);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lmui.config.json'), JSON.stringify({ uiId }));
  if (shim) fs.writeFileSync(path.join(dir, 'assets', 'lmui.js'), shim);
  if (bundle !== undefined) fs.writeFileSync(path.join(dir, 'assets', 'app.js'), bundle);
  return dir;
}

// ── the repo's own canonical copy ────────────────────────────────────────────────────────

test('the canonical pane named here is the one the build script copies', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../scripts/copy-ui-shim.js'), 'utf8');
  const m = /const CANONICAL_PANE = '([^']+)'/.exec(script);
  assert.ok(m, 'copy-ui-shim.js no longer declares CANONICAL_PANE');
  assert.equal(
    m![1], CANONICAL_PANE,
    'copy-ui-shim.js bakes a different pane than shim-sync.ts compares against — the build would '
    + 'ship one shim and the check would look for another',
  );
});

test('the canonical shim resolves from a real build tree', () => {
  const c = canonicalShim();
  assert.ok(c, 'canonicalShim() returned null — neither <dist>/ui-pages/shim/lmui.js nor '
    + `ui-apps/${CANONICAL_PANE}/assets/lmui.js was readable`);
  assert.ok(c!.bytes.length > 0, 'canonical shim is empty');
  assert.match(c!.bytes.toString('utf8'), /viewtoken\/remint/,
    'the canonical shim no longer calls /viewtoken/remint — is this still the shim?');
});

// ── inventory ────────────────────────────────────────────────────────────────────────────

test('panes are found under the apps root', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'a', CANON);
  pane(apps, 'b', OLD);
  const found = listInstalledPanes({ appsRoot: apps, stateDir: path.join(home, 'nostate') });
  assert.deepEqual(found.map((p) => p.uiId), ['a', 'b']);
});

test('a pane served from OUTSIDE the apps root is still found, via its state file', () => {
  // ~/.lmui/dev-<uiId>.json carries the dir lmui actually serves; it can point anywhere, and a
  // check that only walked the apps root would miss exactly the pane a human placed by hand.
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  fs.mkdirSync(apps, { recursive: true });
  const elsewhere = path.join(home, 'somewhere-else');
  pane(elsewhere, 'stray', OLD);
  const stateDir = path.join(home, '.lmui');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'dev-stray.json'), JSON.stringify({ uiId: 'stray', dir: path.join(elsewhere, 'stray') }));

  const found = listInstalledPanes({ appsRoot: apps, stateDir });
  assert.deepEqual(found.map((p) => p.uiId), ['stray']);
});

test('a HOST-MODE state file (dir = a root of many panes) expands to its panes, not to itself', () => {
  // dev-_host.json points at the apps root and serves every sibling beneath it. Treating that
  // dir as a single pane finds no lmui.js and reports nothing — the real deployed shape here.
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'one', CANON);
  pane(apps, 'two', OLD);
  const stateDir = path.join(home, '.lmui');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'dev-_host.json'), JSON.stringify({ uiId: '_host', dir: apps }));

  const found = listInstalledPanes({ appsRoot: path.join(home, 'unused'), stateDir });
  assert.deepEqual(found.map((p) => p.uiId), ['one', 'two']);
});

test('🔴 an apps root carrying its OWN _host lmui.config.json is not counted as a pane', () => {
  // Regression, found against live data on 117: ~/.lmui/apps/lmui.config.json exists and declares
  // uiId "_host". "has a config ⇒ is a pane" therefore invented a phantom pane named `apps`,
  // inflating the count in every report. The declared uiId is the discriminator.
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'real', OLD);
  fs.writeFileSync(path.join(apps, 'lmui.config.json'), JSON.stringify({ uiId: '_host', name: 'lmui host' }));
  const stateDir = path.join(home, '.lmui');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'dev-_host.json'), JSON.stringify({ uiId: '_host', dir: apps }));

  const found = listInstalledPanes({ appsRoot: apps, stateDir });
  assert.deepEqual(found.map((p) => p.uiId), ['real'],
    'the apps root itself must not appear in the pane inventory');
});

test('a stray directory under the apps root is ignored (no lmui.config.json)', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'real', CANON);
  fs.mkdirSync(path.join(apps, 'notes', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(apps, 'notes', 'assets', 'lmui.js'), OLD);

  const found = listInstalledPanes({ appsRoot: apps, stateDir: path.join(home, 'nostate') });
  assert.deepEqual(found.map((p) => p.uiId), ['real']);
});

test('a pane reachable from BOTH the apps root and a state file is counted once', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  const dir = pane(apps, 'dup', OLD);
  const stateDir = path.join(home, '.lmui');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'dev-dup.json'), JSON.stringify({ uiId: 'dup', dir }));

  const found = listInstalledPanes({ appsRoot: apps, stateDir });
  assert.equal(found.length, 1, `expected one pane, got ${found.map((p) => p.uiId).join(',')}`);
});

// ── the check ────────────────────────────────────────────────────────────────────────────

function report(home: string) {
  return checkShims({ appsRoot: path.join(home, 'apps'), stateDir: path.join(home, 'nostate'), canonical: CANON });
}

test('a stale shim is detected and named', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'fresh', CANON);
  pane(apps, 'stale-one', OLD);

  const r = report(home);
  assert.equal(r.canonicalHash, sha(CANON));
  assert.deepEqual(r.stale.map((p) => p.uiId), ['stale-one']);
  assert.equal(r.panes.find((p) => p.uiId === 'fresh')!.state, 'match');

  const lines = formatDrift(r).join('\n');
  assert.match(lines, /STALE PANE SHIMS/);
  assert.match(lines, /stale-one/, 'the warning must NAME the stale pane');
  assert.doesNotMatch(lines, /\bfresh\b/, 'an up-to-date pane must not be reported as stale');
  assert.match(lines, /sync-ui-shims\.js/, 'the warning must carry the command that fixes it');
  assert.match(lines, /reload/i, 'the warning must say open panes need a reload');
});

test('no drift produces no warning', () => {
  const home = tmpHome();
  pane(path.join(home, 'apps'), 'a', CANON);
  const r = report(home);
  assert.equal(r.stale.length, 0);
  assert.deepEqual(formatDrift(r), []);
});

test('a pane that INLINES the shim into a bundle is reported separately, never as in-sync', () => {
  // assist-home / assist-machine / assist-api-keys / assist-whatsapp are built this way on the
  // live node: no lmui.js, and the remint call minified into app.js. No copy can repair them.
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'bundled-pane', undefined, 'var x=1;fetch("/viewtoken/remint",{body:JSON.stringify({uiId:a})})');
  pane(apps, 'inert-pane', undefined, 'var x=1;// no serving-tier calls at all');

  const r = report(home);
  assert.deepEqual(r.bundled.map((p) => p.uiId), ['bundled-pane']);
  assert.equal(r.panes.find((p) => p.uiId === 'inert-pane')!.state, 'no-shim');
  assert.equal(r.stale.length, 0, 'a bundled pane has no shim FILE and must not be counted stale');
});

test('a bundled pane is named in the warning as NOT fixed by a sync', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'stale-one', OLD);
  pane(apps, 'bundled-pane', undefined, 'fetch("/viewtoken/remint")');
  const lines = formatDrift(report(home)).join('\n');
  assert.match(lines, /NOT FIXED BY A SYNC/);
  assert.match(lines, /bundled-pane/);
});

test('🔴 an unresolvable canonical shim reports "could not check", never "all clear"', () => {
  const home = tmpHome();
  pane(path.join(home, 'apps'), 'a', OLD);
  // canonical: an empty buffer is still a resolvable canonical; force the null path instead by
  // pointing the module at a tree with no baked shim AND no ui-apps — simulated via the report
  // shape the callers actually branch on.
  const r = { ...report(home), canonicalHash: null, canonicalPath: null };
  const lines = formatDrift(r).join('\n');
  assert.match(lines, /SKIPPED/);
  assert.match(lines, /NOT verified/);
  assert.doesNotMatch(lines, /up to date/);
});

test('logShimDrift never throws on a broken apps root', () => {
  const out: string[] = [];
  assert.doesNotThrow(() => logShimDrift((m) => out.push(m), {
    appsRoot: '/nonexistent/apps/root', stateDir: '/nonexistent/state', canonical: CANON,
  }));
  assert.ok(out.length > 0, 'the check must say something even when it finds nothing');
});

// ── the sync ─────────────────────────────────────────────────────────────────────────────

function syncOpts(home: string) {
  return { appsRoot: path.join(home, 'apps'), stateDir: path.join(home, 'nostate'), canonical: CANON };
}

test('sync rewrites every stale shim and leaves fresh ones untouched', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'fresh', CANON);
  pane(apps, 'stale-a', OLD);
  pane(apps, 'stale-b', OLD);
  const freshMtime = fs.statSync(path.join(apps, 'fresh', 'assets', 'lmui.js')).mtimeMs;

  const res = syncShims(syncOpts(home));
  assert.deepEqual(res.synced.sort(), ['stale-a', 'stale-b']);
  assert.deepEqual(res.failed, []);
  for (const id of ['stale-a', 'stale-b']) {
    assert.deepEqual(fs.readFileSync(path.join(apps, id, 'assets', 'lmui.js')), CANON, `${id} not updated`);
  }
  assert.equal(fs.statSync(path.join(apps, 'fresh', 'assets', 'lmui.js')).mtimeMs, freshMtime,
    'an already-current pane must not be rewritten');

  // Idempotent: a second run has nothing left to do.
  assert.deepEqual(syncShims(syncOpts(home)).synced, []);
});

test('🔴 sync NEVER creates a shim where the pane had none', () => {
  // Writing lmui.js into a bundled or shim-less pane would be a guess, and would make the
  // report claim a fix it did not make.
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'bundled-pane', undefined, 'fetch("/viewtoken/remint")');
  pane(apps, 'inert-pane', undefined, '// nothing');

  const res = syncShims(syncOpts(home));
  assert.deepEqual(res.synced, []);
  assert.deepEqual(res.bundled, ['bundled-pane'], 'the bundled pane must be reported, not silently skipped');
  assert.equal(fs.existsSync(path.join(apps, 'bundled-pane', 'assets', 'lmui.js')), false);
  assert.equal(fs.existsSync(path.join(apps, 'inert-pane', 'assets', 'lmui.js')), false);
});

test('dryRun reports what it would do and writes nothing', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'stale-a', OLD);

  const res = syncShims({ ...syncOpts(home), dryRun: true });
  assert.deepEqual(res.synced, ['stale-a']);
  assert.equal(res.dryRun, true);
  assert.deepEqual(fs.readFileSync(path.join(apps, 'stale-a', 'assets', 'lmui.js')), OLD,
    'dryRun must not modify the pane');
});

test('a pane whose shim cannot be written is reported as failed, and the rest still sync', () => {
  const home = tmpHome();
  const apps = path.join(home, 'apps');
  pane(apps, 'stale-ok', OLD);
  const locked = pane(apps, 'stale-locked', OLD);
  const lockedAssets = path.join(locked, 'assets');
  fs.chmodSync(lockedAssets, 0o500); // no write on the directory → rename fails

  try {
    const res = syncShims(syncOpts(home));
    // Running as root defeats the permission bit; only assert the isolation property when the
    // OS actually enforced it, rather than asserting something this environment cannot show.
    if (res.failed.length) {
      assert.deepEqual(res.failed.map((f) => f.uiId), ['stale-locked']);
      assert.deepEqual(res.synced, ['stale-ok'], 'one failure must not skip the remaining panes');
    } else {
      assert.deepEqual(res.synced.sort(), ['stale-locked', 'stale-ok']);
    }
    // Either way: no temp file is left behind.
    assert.deepEqual(fs.readdirSync(lockedAssets).filter((n) => n.includes('.tmp')), []);
  } finally {
    fs.chmodSync(lockedAssets, 0o700);
  }
});

test('sync refuses to guess when the canonical shim is unresolvable', () => {
  const home = tmpHome();
  pane(path.join(home, 'apps'), 'stale-a', OLD);
  // An empty canonical is falsy for the `opts.canonical ||` guard, which is the same branch a
  // missing dist artifact takes — the sync must report, not write an empty shim.
  const res = syncShims({ ...syncOpts(home), canonical: Buffer.alloc(0) });
  assert.deepEqual(res.synced, []);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /canonical/i);
  assert.deepEqual(fs.readFileSync(path.join(home, 'apps', 'stale-a', 'assets', 'lmui.js')), OLD);
});
