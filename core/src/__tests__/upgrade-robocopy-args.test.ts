// The Windows EBUSY fallback of the upgrade engine overlays an extracted npm tarball onto
// the installed package with robocopy. Two things about that overlay bit on 2026-09-05/06
// (107, upgrading 0.2.2 → 0.2.3):
//
// 1. npm normalizes EVERY file's mtime inside a tarball to the same 1985 timestamp. Robocopy
//    classifies a file with the same timestamp AND the same size as "Same" and skips it — so a
//    change that keeps the size (package.json "0.2.2" → "0.2.3", the plugin manifests, Next's
//    BUILD_ID and build manifests: 29 files that release) never lands. The node ran 0.2.3 code
//    while reporting 0.2.2, with a web build id that did not match its chunks.
// 2. `/XD node_modules` excludes EVERY directory of that name, including the web standalone's
//    bundled runtime `web/.next/standalone/node_modules` — the only node_modules a tarball
//    ships. The old copy had been pruned by the failed npm attempt, so the web died with
//    "Cannot find module 'next'".
import { test } from 'node:test';
import assert from 'node:assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const upgrade = require('../../scripts/upgrade.js') as { robocopyArgs: (srcDir: string, pkgDir: string) => string[] };

const SRC = 'C:\\Users\\x\\AppData\\Local\\Temp\\lm-upg\\package';
const DST = 'C:\\nvm4w\\nodejs\\node_modules\\lm-assist';

test('requiring the engine starts nothing (main is guarded) and exposes robocopyArgs', () => {
  assert.equal(typeof upgrade.robocopyArgs, 'function');
});

test('robocopyArgs: copies Same and Tweaked files — npm-normalized mtimes make a same-size change look unchanged', () => {
  const args = upgrade.robocopyArgs(SRC, DST);
  assert.deepEqual(args.slice(0, 2), [SRC, DST]);
  assert.ok(args.includes('/E'), 'recurse');
  assert.ok(args.includes('/IS'), '/IS: include Same files (same size + same timestamp)');
  assert.ok(args.includes('/IT'), '/IT: include Tweaked files (same size + same timestamp, different attributes)');
  // Measured on DESKTOP-GDKLATG 2026-09-06 with a list-only run: package.json (same size, same
  // 1985 mtime, rewritten by the failed npm attempt so a different CHANGE time) is classified
  // "Modified", which /IS and /IT do NOT cover — only /IM does.
  assert.ok(args.includes('/IM'), '/IM: include Modified files (same size + same timestamp, different change time)');
});

test('robocopyArgs: never excludes a directory by the bare name node_modules', () => {
  const args = upgrade.robocopyArgs(SRC, DST);
  assert.ok(!args.includes('node_modules'), 'a bare node_modules exclusion also drops web/.next/standalone/node_modules');
  const xd = args.indexOf('/XD');
  if (xd >= 0) assert.ok(args[xd + 1].startsWith(SRC) || args[xd + 1].startsWith(DST), 'an exclusion must be a full path, not a name');
});
