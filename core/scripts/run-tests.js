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
 * Usage: node scripts/run-tests.js [fileOrDirGlobSubstr ...]
 * Env:  TEST_BATCH (files/batch, default 25), TEST_BATCH_TIMEOUT_S (default 240),
 *       TEST_FILE_TIMEOUT_S (per-file bisect bound, default 60).
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'dist-test', '__tests__');
const BATCH = Math.max(1, parseInt(process.env.TEST_BATCH || '25', 10));
const BATCH_TIMEOUT_MS = Math.max(10, parseInt(process.env.TEST_BATCH_TIMEOUT_S || '240', 10)) * 1000;
const FILE_TIMEOUT_MS = Math.max(5, parseInt(process.env.TEST_FILE_TIMEOUT_S || '60', 10)) * 1000;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
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
      const notOk = (out.match(/^not ok /gm) || []).length;
      resolve({ timedOut, code, pass: pass ? +pass : 0, fail: fail ? +fail : notOk, out });
    });
  });
}

function sweepOrphans() {
  // Kill any lingering node procs still running our dist-test files (defense in depth).
  try {
    const mine = process.pid;
    const ps = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf-8' }); // fixed args, no shell
    let killed = 0;
    for (const line of ps.split('\n')) {
      if (!line.includes('dist-test/__tests__') || !/\bnode\b/.test(line)) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (!pid || pid === mine) continue;
      try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* gone */ }
    }
    if (killed) console.log(`\n[run-tests] swept ${killed} orphaned dist-test proc(s)`);
  } catch { /* ps unavailable (non-Linux) — skip */ }
}

(async () => {
  if (!fs.existsSync(TEST_DIR)) { console.error(`[run-tests] no ${TEST_DIR} — run \`npm run build:test\` first`); process.exit(2); }
  const filter = process.argv.slice(2);
  let files = walk(TEST_DIR).sort();
  if (filter.length) files = files.filter((f) => filter.some((s) => f.includes(s)));
  if (!files.length) { console.error('[run-tests] no matching test files'); process.exit(2); }

  console.log(`[run-tests] ${files.length} suites, batch=${BATCH}, batch-timeout=${BATCH_TIMEOUT_MS / 1000}s`);
  let totalPass = 0, totalFail = 0;
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
        totalPass += fr.pass; totalFail += fr.fail;
        if (fr.timedOut) { hungFiles.push(f); console.log(`  ⏱ HUNG: ${path.relative(ROOT, f)}`); }
        else if (fr.fail) console.log(`  ✗ ${fr.fail} fail: ${path.relative(ROOT, f)}`);
      }
    } else {
      totalPass += r.pass; totalFail += r.fail;
      if (r.fail || r.code !== 0) { failedBatches.push(n); console.log(`[run-tests] batch ${n}: ${r.pass} pass, ${r.fail} fail (exit ${r.code})`); }
      else console.log(`[run-tests] batch ${n}: ${r.pass} pass`);
    }
  }

  sweepOrphans();
  console.log(`\n[run-tests] TOTAL: ${totalPass} pass, ${totalFail} fail, ${hungFiles.length} hung`);
  if (hungFiles.length) console.log(`[run-tests] HUNG suites (leaked an open handle — add an after() teardown):\n  ${hungFiles.map((f) => path.relative(ROOT, f)).join('\n  ')}`);
  process.exit(totalFail > 0 || hungFiles.length > 0 ? 1 : 0);
})();
