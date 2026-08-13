#!/usr/bin/env node
/**
 * Bounded test runner — the durable guard against the 2026-07-21 "stuck" class.
 *
 * `node --test <all files>` runs every suite in ONE process. A suite that leaks an
 * open handle (e.g. the SessionCache chokidar watcher) keeps the event loop alive so
 * the process NEVER EXITS — and `--test-timeout` does NOT help: it cancels the
 * hung test but the open handle still blocks exit, so the run hangs forever (observed
 * 1-2.5h, orphaned procs piling up). This runner instead:
 *   - runs suites in BATCHES, each under a hard WALL-CLOCK timeout (SIGKILL the group
 *     on expiry — independent of anything the test leaks),
 *   - on a timed-out batch, BISECTS to per-file runs so the culprit is NAMED,
 *   - SWEEPS orphaned dist-test node procs at the end,
 *   - exits non-zero on any failure OR hang (a hang is a failure, never a silent wait).
 *
 * ── DISCOVERY — read this before narrowing it again ────────────────────────────────────────
 * Suites are found by walking ALL of `dist-test/` for `*.test.js` inside a `__tests__/`
 * directory, NOT just `dist-test/__tests__/`. That distinction was a silent hole: `__tests__`
 * folders that live NEXT TO the code they test (`src/ui-pages/local-tier/__tests__`,
 * `src/transport/__tests__`, `src/file-transfer/__tests__`, `src/voice/__tests__`, …) compile
 * to nested `dist-test/<area>/__tests__/` and were never discovered. Measured 2026-08-13 on the
 * top-level-only rule: 482 suites found, 36 nested ones never even looked at — including EVERY
 * local-serving-tier suite (grants, token, nav, lmui-goto, server, path canonicalization, the
 * browser e2e), plus claude-ai, cowork, file-transfer, fleet, transport and voice. A whole
 * security tier was "covered" by tests that `npm test` never ran.
 *
 * 🔴 STALE ARTEFACTS. `tsc -p tsconfig.test.json` never deletes, so a test whose source MOVED
 * leaves its old `.js` behind and nested discovery would happily run the dead copy (found on the
 * first run: `dist-test/ui-pages/__tests__/lmui-shim-identity.test.js`, whose source now lives at
 * `src/__tests__/`). Every discovered file is therefore matched back to its `.test.ts` under
 * `src/`; one with no source is NOT run and is REPORTED, so it is visible rather than quietly
 * doubling a suite. `npm run clean` clears them.
 *
 * ── SOLO SUITES ────────────────────────────────────────────────────────────────────────────
 * `node --test` runs the files in a batch CONCURRENTLY. A suite that drives a real browser must
 * not compete with 24 others for CPU and ports, and it cannot run at all where there is no
 * Chrome — so such suites are declared in SOLO below: pulled out of the batches, run one at a
 * time, and each one gated. A gate that fails SKIPS the suite LOUDLY (named in the run header
 * AND in the final summary, with the reason). A skipped suite is never silently dropped —
 * silence is exactly how the 36 above went unnoticed.
 *
 * ── ONE RUN AT A TIME ──────────────────────────────────────────────────────────────────────
 * 🔴 Two concurrent runs in one checkout DESTROY EACH OTHER, and they do it quietly. `sweepOrphans`
 * SIGKILLs every node proc whose argv names a compiled suite — it cannot tell the other run's
 * healthy batch children from this run's orphans — so whoever finishes first kills the other's
 * in-flight batch, which is reported as a plain `N fail` against innocent suites. Observed
 * 2026-08-13: a run showed `batch 476-500: 202 pass, 1 fail` while a second run-tests.js was
 * live in the same tree; every file in that batch passed individually afterwards. This runner
 * therefore takes a PID lock and REFUSES to start while another run holds it (override with
 * TEST_ALLOW_CONCURRENT=1, and accept the false failures). Refusing is the point: a run that
 * cannot be trusted is worse than no run.
 *
 * Usage: node scripts/run-tests.js [fileOrDirGlobSubstr ...]
 * Env:  TEST_BATCH (files/batch, default 25), TEST_BATCH_TIMEOUT_S (default 240),
 *       TEST_FILE_TIMEOUT_S (per-file bisect bound, default 60),
 *       LM_TEST_BROWSER (1=force the browser e2e, 0=skip it; default: run iff Chrome resolves),
 *       TEST_ALLOW_CONCURRENT (1=skip the single-run lock; expect cross-killed batches).
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const TEST_DIR = path.join(ROOT, 'dist-test');
const BATCH = Math.max(1, parseInt(process.env.TEST_BATCH || '25', 10));
const BATCH_TIMEOUT_MS = Math.max(10, parseInt(process.env.TEST_BATCH_TIMEOUT_S || '240', 10)) * 1000;
const FILE_TIMEOUT_MS = Math.max(5, parseInt(process.env.TEST_FILE_TIMEOUT_S || '60', 10)) * 1000;

const rel = (f) => path.relative(ROOT, f);

/** Truthiness of an env FLAG, tri-state: true / false / unset (null). */
function envFlag(name) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === '') return null;
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * Suites that must not share a batch, each with the gate that decides whether this machine can
 * run it at all. `gate()` returns { run, reason } — the reason is printed either way, so the
 * run header always says what happened and why.
 */
const SOLO = [
  {
    rel: path.join('ui-pages', 'local-tier', '__tests__', 'browser-cross-pane.test.js'),
    why: 'drives a REAL headless Chrome (puppeteer-core) — the ONLY suite that can observe the '
      + 'browser-enforced half of pane isolation, and the only one that needs a browser to exist',
    gate() {
      const forced = envFlag('LM_TEST_BROWSER');
      if (forced === false) return { run: false, reason: `LM_TEST_BROWSER=${process.env.LM_TEST_BROWSER} — explicitly disabled` };
      // Ask the SAME resolver the suite itself uses, so the runner's gate and the suite's own
      // internal skip can never disagree about whether this box has a browser.
      let chrome = null;
      try { chrome = require(path.join(TEST_DIR, 'voice', 'voice-v2-capability.js')).resolveChromePath(); }
      catch { chrome = null; }
      if (chrome) return { run: true, reason: `system Chrome at ${chrome}` };
      if (forced === true) return { run: true, reason: 'LM_TEST_BROWSER=1 — forced with no Chrome resolved (it will fail loudly, not pass quietly)' };
      return { run: false, reason: 'no system Chrome resolved on this host — set LM_TEST_BROWSER=1 to force it' };
    },
  },
];

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

/** Compiled suites live in a `__tests__` dir — anything else named *.test.js is not a suite. */
function isSuite(file) {
  return path.relative(TEST_DIR, file).split(path.sep).includes('__tests__');
}

/**
 * Does a source still exist for this compiled suite? `false` means the .ts moved or was deleted
 * and tsc left the old .js behind. A hand-written .test.js in src/ is accepted too, so this can
 * only ever flag a genuine orphan — never a suite that is simply not TypeScript.
 */
function hasSource(file) {
  const relPath = path.relative(TEST_DIR, file);
  return ['.test.ts', '.test.js'].some((ext) => fs.existsSync(path.join(SRC_DIR, relPath.replace(/\.test\.js$/, ext))));
}

// Run `node --test <files>` under a hard wall-clock bound. Resolves with
// {timedOut, code, pass, fail}. On timeout the whole process GROUP is SIGKILLed so
// nothing the suite leaked survives.
function runBatch(files, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group may be gone */ }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      const pass = (out.match(/^# pass (\d+)/m) || [])[1];
      const fail = (out.match(/^# fail (\d+)/m) || [])[1];
      // A test the SUITE skipped internally (`{ skip }`) still reports `ok … # SKIP`, so it lands
      // in `# pass`. Surface it separately or a Chrome-less box reads as 12 green browser tests.
      const skipped = (out.match(/^# skipped (\d+)/m) || [])[1];
      // 🔴 Keep the failing TAP lines, not just the count. A batch that reports "1 fail" and names
      // nothing is unactionable — and worse when the failure only appears IN a batch (shared
      // ~/.lm-assist state, a port already bound), because re-running the file alone shows green.
      const notOkLines = out.match(/^not ok .*/gm) || [];
      resolve({
        timedOut, code, pass: pass ? +pass : 0, fail: fail ? +fail : notOkLines.length,
        skipped: skipped ? +skipped : 0, notOkLines, out,
      });
    });
  });
}

const LOCK_FILE = path.join(TEST_DIR, '.run-tests.lock');

/** Is `pid` a LIVE run-tests.js? Checked via argv, so a recycled pid cannot masquerade as one. */
function isLiveRunner(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch { return false; }          // gone, or not ours to signal
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('run-tests.js'); }
  catch { return process.platform === 'linux' ? false : true; }  // no /proc: assume live, fail safe
}

/**
 * Claim the single-run lock, or return the pid already holding it. A stale lock (dead pid, or a
 * pid that is no longer a runner) is taken over silently — a SIGKILLed run must not wedge the next.
 */
function claimRunLock() {
  let holder = 0;
  try { holder = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) || 0; } catch { holder = 0; }
  if (isLiveRunner(holder)) return holder;
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch { /* unwritable — proceed unlocked */ }
  return 0;
}

function releaseRunLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* never let cleanup fail a run */ }
}

/** Name what failed. `not ok` lines carry the test title; the `# Subtest:`/`at …` context has the file. */
function printFailures(r, cap = 20) {
  for (const line of r.notOkLines.slice(0, cap)) console.log(`    ✗ ${line.trim()}`);
  if (r.notOkLines.length > cap) console.log(`    … ${r.notOkLines.length - cap} more`);
  // The file is only in the surrounding TAP context, so point at the one place that still has it.
  const loc = r.out.match(/^\s*at .*dist-test.*$/gm);
  if (loc && loc.length) console.log(`    first failing location: ${loc[0].trim()}`);
}

function sweepOrphans() {
  // Kill any lingering node procs still running our compiled SUITES (defense in depth).
  // Matched on dist-test + __tests__ TOGETHER, not the literal 'dist-test/__tests__' prefix:
  // nested suites live at dist-test/<area>/__tests__/. Deliberately NOT 'dist-test' alone —
  // a hand-started `node dist-test/cli.js serve` is somebody's dev server, not our orphan.
  try {
    const mine = process.pid;
    const ps = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf-8' }); // fixed args, no shell
    let killed = 0;
    for (const line of ps.split('\n')) {
      if (!line.includes('dist-test') || !line.includes('__tests__') || !/\bnode\b/.test(line)) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (!pid || pid === mine) continue;
      try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* gone */ }
    }
    if (killed) console.log(`\n[run-tests] swept ${killed} orphaned dist-test proc(s)`);
  } catch { /* ps unavailable (non-Linux) — skip */ }
}

(async () => {
  if (!fs.existsSync(TEST_DIR)) { console.error(`[run-tests] no ${TEST_DIR} — run \`npm run build:test\` first`); process.exit(2); }

  // Refuse to be the second run in this checkout — see ONE RUN AT A TIME in the header.
  if (envFlag('TEST_ALLOW_CONCURRENT') !== true) {
    const holder = claimRunLock();
    if (holder) {
      console.error(`[run-tests] ✗ REFUSING TO RUN — another run-tests.js (pid ${holder}) is live in this checkout.`);
      console.error('[run-tests]   Concurrent runs SIGKILL each other\'s batches and report the result as test failures.');
      console.error('[run-tests]   Wait for it to finish, or set TEST_ALLOW_CONCURRENT=1 to run anyway (results not trustworthy).');
      process.exit(3);
    }
    process.on('exit', releaseRunLock);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseRunLock(); process.exit(1); });
  }

  const filter = process.argv.slice(2);
  const matches = (f) => !filter.length || filter.some((s) => f.includes(s));

  // 1. discover, 2. drop stale artefacts, 3. split the solo suites out of the batches.
  const discovered = walk(TEST_DIR).filter(isSuite).sort();
  const stale = discovered.filter((f) => !hasSource(f));
  const live = discovered.filter((f) => hasSource(f));

  const soloPlan = [];
  for (const s of SOLO) {
    const file = path.join(TEST_DIR, s.rel);
    if (!live.includes(file)) continue;   // not built (or stale) — the generic paths below report it
    const g = s.gate();
    soloPlan.push({ ...s, file, ...g });
  }
  const soloFiles = new Set(soloPlan.map((s) => s.file));

  let files = live.filter((f) => !soloFiles.has(f) && matches(f));
  const solo = soloPlan.filter((s) => matches(s.file));
  const skippedSuites = solo.filter((s) => !s.run).map((s) => ({ file: s.file, reason: s.reason }));
  const staleShown = stale.filter(matches);

  if (!files.length && !solo.length) { console.error('[run-tests] no matching test files'); process.exit(2); }

  console.log(`[run-tests] ${files.length + solo.length} suites (${files.length} batched, ${solo.length} solo), batch=${BATCH}, batch-timeout=${BATCH_TIMEOUT_MS / 1000}s`);
  // Say what will NOT run, BEFORE running anything — a skip nobody reads is a silent drop.
  for (const s of solo) console.log(`[run-tests] SOLO ${s.run ? 'RUN' : 'SKIP'}: ${rel(s.file)} — ${s.reason}\n            (${s.why})`);
  if (staleShown.length) {
    console.log(`[run-tests] ⚠ ${staleShown.length} STALE compiled suite(s) NOT run — no matching src/**/*.test.ts (moved or deleted). Clear with \`npm run clean\`:`);
    for (const f of staleShown) console.log(`            ${rel(f)}`);
  }

  let totalPass = 0, totalFail = 0, totalSkipped = 0;
  const hungFiles = [];
  const failedBatches = [];

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const n = `${i + 1}-${Math.min(i + BATCH, files.length)}`;
    const r = await runBatch(batch, BATCH_TIMEOUT_MS);
    if (r.timedOut) {
      // Bisect: find which file(s) hang, so the report names the culprit.
      console.log(`[run-tests] batch ${n} TIMED OUT after ${BATCH_TIMEOUT_MS / 1000}s — bisecting ${batch.length} files…`);
      for (const f of batch) {
        const fr = await runBatch([f], FILE_TIMEOUT_MS);
        totalPass += fr.pass; totalFail += fr.fail; totalSkipped += fr.skipped;
        if (fr.timedOut) { hungFiles.push(f); console.log(`  ⏱ HUNG: ${rel(f)}`); }
        else if (fr.fail) { console.log(`  ✗ ${fr.fail} fail: ${rel(f)}`); printFailures(fr); }
      }
    } else {
      totalPass += r.pass; totalFail += r.fail; totalSkipped += r.skipped;
      if (r.fail || r.code !== 0) {
        failedBatches.push(n);
        console.log(`[run-tests] batch ${n}: ${r.pass} pass, ${r.fail} fail (exit ${r.code})`);
        printFailures(r);
      } else console.log(`[run-tests] batch ${n}: ${r.pass} pass`);
    }
  }

  // Solo suites last and one at a time — a browser launch must not race the batches for CPU.
  for (const s of solo) {
    if (!s.run) continue;
    const r = await runBatch([s.file], BATCH_TIMEOUT_MS);
    totalPass += r.pass; totalFail += r.fail; totalSkipped += r.skipped;
    if (r.timedOut) { hungFiles.push(s.file); console.log(`[run-tests] solo ⏱ HUNG: ${rel(s.file)}`); }
    else if (r.fail || r.code !== 0) { console.log(`[run-tests] solo ${rel(s.file)}: ${r.pass} pass, ${r.fail} fail (exit ${r.code})`); printFailures(r); }
    else console.log(`[run-tests] solo ${rel(s.file)}: ${r.pass} pass${r.skipped ? `, ${r.skipped} skipped` : ''}`);
  }

  sweepOrphans();
  console.log(`\n[run-tests] TOTAL: ${totalPass} pass, ${totalFail} fail, ${hungFiles.length} hung`
    + `, ${totalSkipped} test(s) skipped inside suites, ${skippedSuites.length} suite(s) skipped`);
  if (skippedSuites.length) {
    console.log('[run-tests] SKIPPED suites (NOT run — this is not a pass):');
    for (const s of skippedSuites) console.log(`  ⊘ ${rel(s.file)} — ${s.reason}`);
  }
  if (staleShown.length) console.log(`[run-tests] STALE suites (NOT run): ${staleShown.map(rel).join(', ')}`);
  if (hungFiles.length) console.log(`[run-tests] HUNG suites (leaked an open handle — add an after() teardown):\n  ${hungFiles.map(rel).join('\n  ')}`);
  process.exit(totalFail > 0 || hungFiles.length > 0 ? 1 : 0);
})();
