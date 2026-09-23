import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * The harness run index: an event-sourced JSONL fold with derived status,
 * compaction and retention.
 *
 * Each test points LM_ASSIST_DATA_DIR at its own fresh dir (the store folds by
 * file path, so a new dir is a new index) — nothing here reads or writes the
 * operator's ~/.lm-assist.
 */

import {
  applyRetention,
  clearInFlight,
  compactIndex,
  deriveStatus,
  getRun,
  indexStats,
  listRuns,
  markInFlight,
  maybeCompact,
  patchRun,
  readStartTicks,
  selfStartTicks,
  startRun,
  summarizeRunner,
  sweepInterrupted,
} from '../harness/run-store';
import { harnessRunsRoot, legacyRunsRoot, runIndexFile } from '../harness/run-paths';
import type { HarnessRunRecord } from '../harness/run-types';

let base: string;
let dataDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['LM_ASSIST_DATA_DIR', 'LM_ASSIST_PROD', 'LM_HARNESS_RUN_RETENTION_DAYS', 'LM_HARNESS_OPENCODE_DB'];

before(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-run-store-'));
  process.env.LM_HARNESS_OPENCODE_DB = path.join(base, 'no-opencode', 'opencode.db');
});

after(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(base, { recursive: true, force: true });
});

function freshDataDir(): string {
  dataDir = fs.mkdtempSync(path.join(base, 'data-'));
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  return dataDir;
}

const DAY = 24 * 3600 * 1000;
/** A pid no Linux system hands out (pid_max tops out at 2^22). */
const DEAD_PID = 99_999_999;

function rec(over: Partial<HarnessRunRecord> = {}): HarnessRunRecord {
  const now = Date.now();
  return {
    v: 1,
    id: 'run-1',
    executionId: over.id ?? 'run-1',
    runner: 'qwen',
    origin: 'recorded',
    inferred: false,
    core: 'dev',
    corePid: DEAD_PID,
    status: 'succeeded',
    background: false,
    promptPreview: 'say hi',
    promptChars: 6,
    cwd: '/work/a',
    cwdDefaulted: false,
    model: 'vendor/model-a:free',
    providerProfile: 'gw',
    baseUrlHost: 'gw.example',
    timeoutMs: 900000,
    maxTurns: null,
    maxTurnsEnforced: true,
    startedAt: now - 1000,
    endedAt: now,
    durationMs: 1000,
    costUsd: null,
    runDir: null,
    updatedAt: now,
    ...over,
  };
}

test('paths are dev-suffixed from a checkout, and unsuffixed under LM_ASSIST_PROD=true', () => {
  freshDataDir();
  assert.equal(runIndexFile(), path.join(dataDir, 'harness-runs-index-dev.jsonl'));
  assert.equal(harnessRunsRoot(), path.join(dataDir, 'harness-runs-dev'));
  assert.equal(legacyRunsRoot(), path.join(dataDir, 'harness-runs'));

  process.env.LM_ASSIST_PROD = 'true';
  try {
    assert.equal(runIndexFile(), path.join(dataDir, 'harness-runs-index.jsonl'));
    assert.equal(harnessRunsRoot(), path.join(dataDir, 'harness-runs'), 'prod runs live in the legacy root');
  } finally {
    delete process.env.LM_ASSIST_PROD;
  }
});

test('start then patches fold in order — the last write wins — and the index is 0600', () => {
  freshDataDir();
  assert.equal(startRun(rec({ id: 'fold-1', status: 'running', endedAt: undefined })), true);
  assert.equal(patchRun('fold-1', { model: 'first', numTurns: 1 }), true);
  assert.equal(patchRun('fold-1', { model: 'second' }), true);

  const r = getRun('fold-1')!;
  assert.equal(r.model, 'second');
  assert.equal(r.numTurns, 1, 'a field not re-patched keeps its earlier value');
  assert.equal(fs.statSync(runIndexFile()).mode & 0o777, 0o600);
});

test('a patch for an id that was never started is dropped, not written', () => {
  freshDataDir();
  startRun(rec({ id: 'known' }));
  const before = fs.statSync(runIndexFile()).size;
  assert.equal(patchRun('never-started', { model: 'x' }), false);
  assert.equal(fs.statSync(runIndexFile()).size, before);
});

test('a torn last line is skipped, then read once it is completed', () => {
  freshDataDir();
  startRun(rec({ id: 'whole' }));
  const line = JSON.stringify({ op: 'start', at: 1, rec: rec({ id: 'torn' }) });
  const cut = Math.floor(line.length / 2);
  fs.appendFileSync(runIndexFile(), line.slice(0, cut));

  assert.equal(getRun('torn'), undefined, 'half a line must not be parsed');
  assert.ok(getRun('whole'), 'the lines before it still fold');

  fs.appendFileSync(runIndexFile(), `${line.slice(cut)}\n`);
  assert.equal(getRun('torn')?.id, 'torn', 'the completed line is picked up on the next read');
});

test('an append after a crash-torn tail starts on a fresh line, so only the torn line is lost', () => {
  freshDataDir();
  startRun(rec({ id: 'a' }));
  fs.appendFileSync(runIndexFile(), '{"op":"start","at":1,"rec":{"id":"garb');
  assert.equal(startRun(rec({ id: 'after-crash' })), true);
  assert.ok(getRun('after-crash'), 'the next record must not be swallowed by the torn one');
  assert.ok(getRun('a'));
});

test('appends made by another writer are folded incrementally', () => {
  freshDataDir();
  startRun(rec({ id: 'inc' }));
  assert.equal(getRun('inc')!.numTurns, undefined);
  fs.appendFileSync(runIndexFile(), `${JSON.stringify({ op: 'patch', at: 2, id: 'inc', patch: { numTurns: 7 } })}\n`);
  assert.equal(getRun('inc')!.numTurns, 7);
});

test('deriveStatus: terminal, own in-flight, own lost, foreign live, foreign dead and pid-reused', () => {
  freshDataDir();
  const unended = (over: Partial<HarnessRunRecord>) => rec({ status: 'running', endedAt: undefined, durationMs: undefined, ...over });

  assert.deepEqual(deriveStatus(rec({ status: 'succeeded' })), { status: 'succeeded', live: false });
  assert.deepEqual(deriveStatus(rec({ origin: 'backfill', status: 'not_started', endedAt: undefined })), { status: 'not_started', live: false });

  const own = unended({ id: 'own', corePid: process.pid, coreStartTicks: selfStartTicks() });
  markInFlight('own');
  assert.deepEqual(deriveStatus(own), { status: 'running', live: true }, 'this process, in flight');
  clearInFlight('own');
  assert.deepEqual(deriveStatus(own), { status: 'interrupted', live: false }, 'this process but not in flight: the end write was lost');

  assert.deepEqual(deriveStatus(unended({ corePid: DEAD_PID })), { status: 'interrupted', live: false }, 'a dead owner');

  if (process.platform === 'linux') {
    const ppid = process.ppid;
    const ticks = readStartTicks(ppid);
    assert.ok(ticks !== undefined, 'the parent process must be readable in /proc');
    assert.deepEqual(deriveStatus(unended({ corePid: ppid, coreStartTicks: ticks })), { status: 'running', live: true }, 'a live foreign owner');
    assert.deepEqual(
      deriveStatus(unended({ corePid: ppid, coreStartTicks: ticks! + 12345 })),
      { status: 'interrupted', live: false },
      'same pid, different start ticks: the pid was reused by another process',
    );
    assert.deepEqual(
      deriveStatus(unended({ id: 'reused-self', corePid: process.pid, coreStartTicks: (selfStartTicks() ?? 0) + 777 })),
      { status: 'interrupted', live: false },
      'our pid with foreign ticks is a previous Core, not us',
    );
  }
});

test('compaction folds the history to one line per record plus the meta line, mode 0600', () => {
  freshDataDir();
  startRun(rec({ id: 'c1', status: 'running', endedAt: undefined }));
  startRun(rec({ id: 'c2' }));
  for (let i = 0; i < 5; i++) patchRun('c1', { numTurns: i });
  fs.appendFileSync(runIndexFile(), `${JSON.stringify({ op: 'meta', at: 1, backfill: { qwen: 0, opencode: 0, warnings: [] } })}\n`);
  assert.equal(indexStats().lines, 8);

  assert.equal(compactIndex(), true);
  assert.deepEqual(indexStats().lines, 3);
  assert.equal(getRun('c1')!.numTurns, 4, 'the folded value survives compaction');
  assert.equal(fs.readFileSync(runIndexFile(), 'utf8').trim().split('\n').length, 3);
  assert.equal(fs.statSync(runIndexFile()).mode & 0o777, 0o600);
});

test('maybeCompact fires past the line threshold, and not on an already-folded file', () => {
  freshDataDir();
  startRun(rec({ id: 'hot' }));
  assert.equal(maybeCompact(), false, 'one line per record: nothing to fold');
  const lines: string[] = [];
  for (let i = 0; i < 5001; i++) lines.push(JSON.stringify({ op: 'patch', at: i, id: 'hot', patch: { numTurns: i } }));
  fs.appendFileSync(runIndexFile(), `${lines.join('\n')}\n`);

  assert.equal(maybeCompact(), true);
  assert.equal(indexStats().lines, 1);
  assert.equal(getRun('hot')!.numTurns, 5000);
});

test('past 2 MB, one more run does NOT rewrite the folded index; the size rule waits for it to double', () => {
  freshDataDir();
  // 560 folded records of ~3.9 KB (full previews): legitimately over 2 MB.
  const N = 560;
  const lines: string[] = [];
  for (let i = 0; i < N; i++) {
    lines.push(JSON.stringify({ op: 'start', at: i, rec: rec({ id: `big-${i}`, resultPreview: 'r'.repeat(2000), promptPreview: 'p'.repeat(300), filesTouched: Array.from({ length: 40 }, (_, j) => `/work/a/src/file-${j}.ts`) }) }));
  }
  fs.writeFileSync(runIndexFile(), `${lines.join('\n')}\n`, { mode: 0o600 });
  const size0 = fs.statSync(runIndexFile()).size;
  assert.ok(size0 > 2 * 1024 * 1024, `fixture must exceed the 2 MB threshold (is ${size0})`);
  assert.equal(maybeCompact(), false, 'already folded: nothing to do');
  const ino = fs.statSync(runIndexFile()).ino;

  // One run's worth of history — a start plus its patches — is foldable, but not worth
  // rewriting 2 MB for on the response path.
  startRun(rec({ id: 'one-more', status: 'running', endedAt: undefined }));
  for (const p of [{ pid: 1 }, { firstOutputAt: 2 }, { status: 'succeeded' as const, endedAt: 3 }, { toolCalls: 1 }]) patchRun('one-more', p);
  assert.equal(maybeCompact(), false);
  assert.equal(fs.statSync(runIndexFile()).ino, ino, 'the index was not rewritten');

  // Once the unfolded history has doubled the file, it is folded.
  const more: string[] = [];
  let grown = fs.statSync(runIndexFile()).size;
  for (let i = 0; grown < 2 * size0 + 1024; i++) {
    const line = JSON.stringify({ op: 'patch', at: i, id: `big-${i % N}`, patch: { resultPreview: 'x'.repeat(2000) } });
    more.push(line);
    grown += line.length + 1;
  }
  fs.appendFileSync(runIndexFile(), `${more.join('\n')}\n`);
  assert.equal(maybeCompact(), true);
  assert.equal(indexStats().lines, N + 1);
});

test('retention: drops old and over-cap terminal runs, keeps running ones, deletes only this mode\'s own dirs', () => {
  freshDataDir();
  const now = Date.now();
  const old = now - 40 * DAY;
  const root = harnessRunsRoot();
  const legacy = legacyRunsRoot();
  const mk = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); return dir; };

  const ownDir = mk(path.join(root, 'old-own'));
  const legacyDir = mk(path.join(legacy, 'old-legacy'));
  const otherModeDir = mk(path.join(root, 'old-prod'));
  const outside = mk(path.join(dataDir, 'escape-target'));

  startRun(rec({ id: 'old-own', startedAt: old, endedAt: old, runDir: 'harness-runs-dev/old-own' }));
  startRun(rec({ id: 'old-legacy', origin: 'backfill', inferred: true, core: 'unknown', startedAt: old, endedAt: old, runDir: 'harness-runs/old-legacy' }));
  startRun(rec({ id: 'old-prod', core: 'prod', startedAt: old, endedAt: old, runDir: 'harness-runs-dev/old-prod' }));
  startRun(rec({ id: 'old-escape', startedAt: old, endedAt: old, runDir: 'harness-runs-dev/../escape-target' }));
  startRun(rec({ id: 'old-running', status: 'running', endedAt: undefined, corePid: process.pid, coreStartTicks: selfStartTicks(), startedAt: old }));
  markInFlight('old-running');
  startRun(rec({ id: 'fresh-1', startedAt: now - 3000, endedAt: now - 3000 }));
  startRun(rec({ id: 'fresh-2', startedAt: now - 2000, endedAt: now - 2000 }));
  startRun(rec({ id: 'fresh-3', startedAt: now - 1000, endedAt: now - 1000 }));

  try {
    const out = applyRetention({ now, days: 30, maxRuns: 2 });
    assert.deepEqual(new Set(out.dropped), new Set(['old-own', 'old-legacy', 'old-prod', 'old-escape', 'fresh-1']));
    assert.equal(out.dirsRemoved, 1);

    assert.ok(getRun('old-running'), 'a running record is never dropped, however old');
    assert.ok(getRun('fresh-2') && getRun('fresh-3'), 'the newest N terminal runs are kept');
    assert.equal(getRun('fresh-1'), undefined, 'beyond the cap, the oldest terminal run goes');

    assert.equal(fs.existsSync(ownDir), false, 'this mode\'s own recorded run dir is removed with its record');
    assert.equal(fs.existsSync(legacyDir), true, 'a legacy (backfill) dir is never deleted');
    assert.equal(fs.existsSync(otherModeDir), true, 'a dir recorded by the other mode is not ours to delete');
    assert.equal(fs.existsSync(outside), true, 'a locator pointing outside the root is never followed');
  } finally {
    clearInFlight('old-running');
  }
});

test('retention of 0 days keeps everything', () => {
  freshDataDir();
  startRun(rec({ id: 'ancient', startedAt: 1, endedAt: 1 }));
  process.env.LM_HARNESS_RUN_RETENTION_DAYS = '0';
  try {
    assert.deepEqual(applyRetention({ maxRuns: 0 }).dropped, []);
    assert.ok(getRun('ancient'));
  } finally {
    delete process.env.LM_HARNESS_RUN_RETENTION_DAYS;
  }
});

test('the boot sweep closes out dead-owner runs as interrupted and leaves in-flight ones alone', () => {
  freshDataDir();
  startRun(rec({ id: 'orphan', status: 'running', endedAt: undefined, corePid: DEAD_PID }));
  startRun(rec({ id: 'mine', status: 'running', endedAt: undefined, corePid: process.pid, coreStartTicks: selfStartTicks() }));
  markInFlight('mine');
  try {
    assert.equal(sweepInterrupted(12345), 1);
    const o = getRun('orphan')!;
    assert.equal(o.status, 'interrupted');
    assert.equal(o.termination, 'core_restart');
    assert.equal(o.endedAt, 12345);
    assert.equal(getRun('mine')!.status, 'running');
  } finally {
    clearInFlight('mine');
  }
});

test('listRuns: filters, facet counts, clamping and paging', () => {
  freshDataDir();
  const now = Date.now();
  startRun(rec({ id: 'q1', runner: 'qwen', status: 'succeeded', startedAt: now - 5000, promptPreview: 'Create hello.txt' }));
  startRun(rec({ id: 'q2', runner: 'qwen', status: 'failed', startedAt: now - 4000, error: 'boom '.repeat(100) }));
  startRun(rec({ id: 'o1', runner: 'opencode', status: 'succeeded', startedAt: now - 3000, cwd: '/tmp/special-dir' }));
  startRun(rec({ id: 'oc-ses_legacy0001', runner: 'opencode', origin: 'backfill', inferred: true, executionId: null, status: 'unknown', startedAt: now - 40 * DAY }));
  startRun(rec({ id: 'live', runner: 'qwen', status: 'running', endedAt: undefined, corePid: process.pid, coreStartTicks: selfStartTicks(), startedAt: now - 1000 }));
  markInFlight('live');
  try {
    const all = listRuns();
    assert.deepEqual(all.runs.map((r) => r.id), ['live', 'o1', 'q2', 'q1', 'oc-ses_legacy0001'], 'newest first');
    assert.equal(all.counts.total, 5);
    assert.equal(all.counts.running, 1);
    assert.equal(all.runs[0].live, true);
    assert.equal(all.runs[0].runnerDisplayName, 'Qwen Code');
    assert.equal(all.runs.find((r) => r.id === 'q2')!.errorPreview!.length, 200);

    const qwen = listRuns({ runner: 'qwen' });
    assert.equal(qwen.counts.matched, 3);
    assert.deepEqual(qwen.counts.byRunner, { qwen: 3, opencode: 2 }, 'byRunner ignores the runner filter itself');

    const failed = listRuns({ statuses: ['failed', 'running'] });
    assert.deepEqual(failed.runs.map((r) => r.id).sort(), ['live', 'q2']);
    assert.equal(failed.counts.byStatus.succeeded, 2, 'byStatus ignores the status filter itself');

    assert.deepEqual(listRuns({ q: 'HELLO' }).runs.map((r) => r.id), ['q1'], 'q is case-insensitive over the prompt');
    assert.deepEqual(listRuns({ q: 'special-dir' }).runs.map((r) => r.id), ['o1'], '... and the cwd');
    assert.equal(listRuns({ since: now - DAY }).counts.matched, 4);
    assert.equal(listRuns({ includeBackfill: false }).counts.matched, 4);

    assert.equal(listRuns({ limit: 0 }).runs.length, 1, 'limit is clamped up to 1');
    assert.equal(listRuns({ limit: 10_000 }).runs.length, 5, 'and down to the max');
    const p1 = listRuns({ limit: 2 });
    assert.equal(p1.nextOffset, 2);
    const p3 = listRuns({ limit: 2, offset: 4 });
    assert.deepEqual(p3.runs.map((r) => r.id), ['oc-ses_legacy0001']);
    assert.equal(p3.nextOffset, null);
  } finally {
    clearInFlight('live');
  }
});

test('summarizeRunner: p50/p95, success rate over rated outcomes only, tokens from reported runs only', () => {
  freshDataDir();
  const now = Date.now();
  const usage = (input: number, output: number, reported = true, reasoningTokens: number | null = null) =>
    ({ inputTokens: input, outputTokens: output, reasoningTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: input + output, reported });
  const durations = [100, 200, 300, 400, 1000];
  durations.forEach((d, i) => startRun(rec({
    id: `s${i}`,
    status: i === 3 ? 'failed' : 'succeeded',
    durationMs: d,
    startedAt: now - 10_000 + i,
    usage: usage(10, 5, i !== 4, i === 0 ? 7 : null),
    toolCalls: 2,
    toolErrors: i === 3 ? 1 : 0,
    toolsByName: { write_file: 1, read_file: 1 },
    error: i === 3 ? 'the endpoint said no' : undefined,
  })));
  startRun(rec({ id: 'refused', status: 'refused', durationMs: undefined, startedAt: now - 20_000 }));
  startRun(rec({ id: 'nostart', origin: 'backfill', status: 'not_started', durationMs: undefined, startedAt: now - 30_000 }));
  startRun(rec({ id: 'other-runner', runner: 'opencode' }));
  startRun(rec({ id: 'too-old', startedAt: now - 60 * DAY }));

  const s = summarizeRunner('qwen', 30, now);
  assert.equal(s.total, 7);
  assert.equal(s.p50DurationMs, 300);
  assert.equal(s.p95DurationMs, 1000);
  assert.equal(s.successRate, 4 / 5, 'refused and not_started never ran a model and are not rated');
  assert.deepEqual(s.tokens, { input: 40, output: 20, reasoning: 7, reportedRuns: 4 });
  assert.equal(s.toolCalls, 10);
  assert.equal(s.toolErrors, 1);
  assert.deepEqual(s.topTools, [{ name: 'read_file', count: 5 }, { name: 'write_file', count: 5 }]);
  assert.deepEqual(s.models, [{ model: 'vendor/model-a:free', count: 7 }]);
  assert.deepEqual(s.recentFailures.map((f) => [f.id, f.status]), [['s3', 'failed'], ['refused', 'refused']]);
  assert.equal(s.lastRunAt, now - 10_000 + 4);

  const empty = summarizeRunner('nobody', 30, now);
  assert.equal(empty.successRate, null);
  assert.equal(empty.p50DurationMs, null);
});

test('a read-only data dir costs the record, never throws', { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false }, () => {
  freshDataDir();
  fs.chmodSync(dataDir, 0o500);
  try {
    assert.equal(startRun(rec({ id: 'ro' })), false);
    assert.equal(getRun('ro'), undefined);
    assert.equal(patchRun('ro', { model: 'x' }), false);
  } finally {
    fs.chmodSync(dataDir, 0o700);
  }
});

test('the pid of a process that has exited reads as a dead owner', { skip: process.platform !== 'linux' }, () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(r.stdout);
  assert.ok(deadPid > 0);
  assert.deepEqual(deriveStatus(rec({ status: 'running', endedAt: undefined, corePid: deadPid })).status, 'interrupted');
});
