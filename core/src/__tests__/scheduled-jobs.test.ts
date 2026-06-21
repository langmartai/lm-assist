import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isJobDue,
  nextRunAtMs,
  applyJobResult,
  makeBuiltinJobs,
  formatShellResult,
  clampTimeoutMs,
  applyShellTemplate,
  truncate,
  pushRunLog,
  reachedMaxRuns,
  applyRun,
  parseRunAt,
  isOneTime,
  type ScheduledJob,
  type JobRunRecord,
} from '../scheduler/scheduled-jobs';

const NOW = Date.parse('2026-06-21T12:00:00Z');

function job(partial: Partial<ScheduledJob>): ScheduledJob {
  return {
    id: 't',
    type: 'noop',
    enabled: true,
    intervalMinutes: 60,
    config: {},
    lastRunAt: null,
    lastResult: null,
    lastStatus: null,
    builtin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

// ── isJobDue: the scheduling gate ──────────────────────────────
test('isJobDue: a never-run enabled job is due immediately', () => {
  assert.equal(isJobDue(job({ lastRunAt: null }), NOW), true);
});

test('isJobDue: a disabled job is NEVER due (master off-switch)', () => {
  assert.equal(isJobDue(job({ enabled: false, lastRunAt: null }), NOW), false);
});

test('isJobDue: intervalMinutes<=0 is never due (a paused job)', () => {
  assert.equal(isJobDue(job({ intervalMinutes: 0 }), NOW), false);
  assert.equal(isJobDue(job({ intervalMinutes: -5 }), NOW), false);
});

test('isJobDue: respects the elapsed interval since lastRunAt', () => {
  const recent = job({ intervalMinutes: 60, lastRunAt: new Date(NOW - 30 * 60_000).toISOString() });
  assert.equal(isJobDue(recent, NOW), false); // 30 min < 60 min → not yet
  const stale = job({ intervalMinutes: 60, lastRunAt: new Date(NOW - 90 * 60_000).toISOString() });
  assert.equal(isJobDue(stale, NOW), true); // 90 min >= 60 min → due
  const exact = job({ intervalMinutes: 60, lastRunAt: new Date(NOW - 60 * 60_000).toISOString() });
  assert.equal(isJobDue(exact, NOW), true); // exactly the interval → due
});

// ── nextRunAtMs: display/forecast ──────────────────────────────
test('nextRunAtMs: null when disabled or paused', () => {
  assert.equal(nextRunAtMs(job({ enabled: false }), NOW), null);
  assert.equal(nextRunAtMs(job({ intervalMinutes: 0 }), NOW), null);
});

test('nextRunAtMs: a never-run enabled job fires on the next tick (now)', () => {
  assert.equal(nextRunAtMs(job({ lastRunAt: null }), NOW), NOW);
});

test('nextRunAtMs: lastRunAt + interval otherwise', () => {
  const last = new Date(NOW - 10 * 60_000).toISOString();
  assert.equal(nextRunAtMs(job({ intervalMinutes: 60, lastRunAt: last }), NOW), Date.parse(last) + 60 * 60_000);
});

// ── applyJobResult: records the outcome of a run ───────────────
test('applyJobResult advances lastRunAt and records the outcome', () => {
  const j = job({ lastRunAt: null });
  const updated = applyJobResult(j, { result: '3 swept', status: 'ok' }, NOW);
  assert.equal(updated.lastResult, '3 swept');
  assert.equal(updated.lastStatus, 'ok');
  assert.equal(Date.parse(updated.lastRunAt!), NOW);
  assert.equal(updated.updatedAt, new Date(NOW).toISOString());
  // does not mutate the input
  assert.equal(j.lastRunAt, null);
});

test('applyJobResult defaults a missing status to ok', () => {
  const updated = applyJobResult(job({}), { result: 'done' }, NOW);
  assert.equal(updated.lastStatus, 'ok');
});

// ── one-time (runAt) jobs ──────────────────────────────────────
test('parseRunAt: parses an ISO time, rejects junk/empty', () => {
  assert.equal(parseRunAt('2026-06-22T03:00:00Z'), Date.parse('2026-06-22T03:00:00Z'));
  assert.equal(parseRunAt(''), null);
  assert.equal(parseRunAt('not a date'), null);
  assert.equal(parseRunAt(undefined), null);
});

test('isOneTime: runAt set OR maxRuns===1', () => {
  assert.equal(isOneTime(job({ config: { runAt: '2026-06-22T03:00:00Z' } })), true);
  assert.equal(isOneTime(job({ config: { maxRuns: 1 } })), true);
  assert.equal(isOneTime(job({ config: { maxRuns: 5 } })), false);
  assert.equal(isOneTime(job({ config: {} })), false);
});

test('isJobDue: a one-time runAt job fires only at/after runAt, and only once', () => {
  const future = new Date(NOW + 3600_000).toISOString();
  const past = new Date(NOW - 3600_000).toISOString();
  assert.equal(isJobDue(job({ enabled: true, intervalMinutes: 0, lastRunAt: null, config: { runAt: future } }), NOW), false); // before time
  assert.equal(isJobDue(job({ enabled: true, intervalMinutes: 0, lastRunAt: null, config: { runAt: past } }), NOW), true);   // at/after, unrun
  assert.equal(isJobDue(job({ enabled: true, intervalMinutes: 0, lastRunAt: past, config: { runAt: past } }), NOW), false);  // already ran → done
});

test('nextRunAtMs: a one-time job points at runAt until it runs, then null', () => {
  const at = new Date(NOW + 1800_000).toISOString();
  assert.equal(nextRunAtMs(job({ enabled: true, intervalMinutes: 0, lastRunAt: null, config: { runAt: at } }), NOW), Date.parse(at));
  assert.equal(nextRunAtMs(job({ enabled: true, intervalMinutes: 0, lastRunAt: at, config: { runAt: at } }), NOW), null);
});

// ── run capture: truncate / runLog / conditions / applyRun ─────
test('truncate caps a string and notes how much was dropped', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 5), 'hello… (+6 more)');
  assert.equal(truncate('', 5), '');
  assert.equal(truncate(undefined as any, 5), '');
});

test('pushRunLog prepends newest and bounds the ring', () => {
  const rec = (i: number): JobRunRecord => ({ at: `t${i}`, status: 'ok', result: `r${i}`, trigger: 'schedule' });
  let log = pushRunLog(undefined, rec(1), 3);
  log = pushRunLog(log, rec(2), 3);
  log = pushRunLog(log, rec(3), 3);
  log = pushRunLog(log, rec(4), 3); // overflow drops the oldest
  assert.deepEqual(log.map((r) => r.result), ['r4', 'r3', 'r2']); // newest first, max 3
});

test('reachedMaxRuns: only caps when config.maxRuns is a positive number', () => {
  assert.equal(reachedMaxRuns(job({ config: {}, runCount: 99 })), false); // no cap
  assert.equal(reachedMaxRuns(job({ config: { maxRuns: 3 }, runCount: 2 })), false);
  assert.equal(reachedMaxRuns(job({ config: { maxRuns: 3 }, runCount: 3 })), true);
  assert.equal(reachedMaxRuns(job({ config: { maxRuns: 0 }, runCount: 5 })), false); // 0 = no cap
});

test('isJobDue: a job that hit maxRuns is no longer due', () => {
  const j = job({ enabled: true, intervalMinutes: 60, lastRunAt: null, config: { maxRuns: 2 }, runCount: 2 });
  assert.equal(isJobDue(j, NOW), false);
  assert.equal(isJobDue(job({ enabled: true, intervalMinutes: 60, lastRunAt: null, config: { maxRuns: 2 }, runCount: 1 }), NOW), true);
});

test('applyRun records the full record, rings the log, and counts real runs', () => {
  const j = job({ lastRunAt: null, runCount: 0 });
  const rec: JobRunRecord = { at: 'x', status: 'ok', result: 'done', trigger: 'manual', exitCode: 0, durationMs: 12, stdout: 'out' };
  const u = applyRun(j, rec, NOW);
  assert.equal(u.lastRun!.result, 'done');
  assert.equal(u.lastResult, 'done');
  assert.equal(u.lastStatus, 'ok');
  assert.equal(Date.parse(u.lastRunAt!), NOW);   // manual advances the schedule clock
  assert.equal(u.runCount, 1);                    // real run counts
  assert.equal(u.runLog!.length, 1);
});

test('applyRun: a TEST run does not disturb the schedule clock or runCount', () => {
  const j = job({ lastRunAt: '2026-06-20T00:00:00.000Z', runCount: 4 });
  const rec: JobRunRecord = { at: 'x', status: 'ok', result: 'verified', trigger: 'test' };
  const u = applyRun(j, rec, NOW);
  assert.equal(u.lastRunAt, '2026-06-20T00:00:00.000Z'); // unchanged — test doesn't advance schedule
  assert.equal(u.runCount, 4);                            // test doesn't count toward maxRuns
  assert.equal(u.lastRun!.result, 'verified');            // but it IS captured + logged
  assert.equal(u.runLog!.length, 1);
});

test('applyRun: a SKIPPED run does not count toward maxRuns', () => {
  const u = applyRun(job({ runCount: 1 }), { at: 'x', status: 'skipped', result: 'condition not met', trigger: 'schedule' }, NOW);
  assert.equal(u.runCount, 1);
});

test('formatShellResult also returns exitCode + truncated stdout/stderr', () => {
  const r = formatShellResult({ code: 0, stdout: 'the output', stderr: '', timedOut: false });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'the output');
  const big = formatShellResult({ code: 1, stdout: 'x'.repeat(20000), stderr: 'err', timedOut: false });
  assert.ok((big.stdout || '').length < 9000, 'stdout is bounded for storage');
  assert.equal(big.exitCode, 1);
  assert.equal(big.stderr, 'err');
});

// ── SAFETY: the built-in cleanup job ships inert ───────────────
// ── scripted ("shell") jobs ────────────────────────────────────
test('clampTimeoutMs: clamps to [1000, 600000], default 60000, accepts numeric string', () => {
  assert.equal(clampTimeoutMs(undefined), 60000);
  assert.equal(clampTimeoutMs(500), 1000); // floor
  assert.equal(clampTimeoutMs(99_999_999), 600_000); // ceil
  assert.equal(clampTimeoutMs(30_000), 30_000);
  assert.equal(clampTimeoutMs('45000'), 45_000); // connector delivers numbers as strings
  assert.equal(clampTimeoutMs('garbage'), 60_000); // fallback to default
});

test('formatShellResult: exit 0 → ok, keeps the output tail', () => {
  const r = formatShellResult({ code: 0, stdout: 'l1\nl2\nl3\nl4', stderr: '', timedOut: false });
  assert.equal(r.status, 'ok');
  assert.match(r.result, /exit 0/);
  assert.match(r.result, /l4/); // last line kept
});

test('formatShellResult: nonzero exit → error, includes stderr', () => {
  const r = formatShellResult({ code: 2, stdout: '', stderr: 'boom', timedOut: false });
  assert.equal(r.status, 'error');
  assert.match(r.result, /exit 2/);
  assert.match(r.result, /boom/);
});

test('applyShellTemplate substitutes {{dryRun}} with the boolean (so a toggle can flip it, no hand-editing)', () => {
  assert.equal(applyShellTemplate('curl -d {"dryRun":{{dryRun}}}', true), 'curl -d {"dryRun":true}');
  assert.equal(applyShellTemplate('curl -d {"dryRun":{{dryRun}}}', false), 'curl -d {"dryRun":false}');
  assert.equal(applyShellTemplate('a {{ dryRun }} b {{dryRun}}', false), 'a false b false'); // inner spaces + multiple
  assert.equal(applyShellTemplate('no template here', true), 'no template here');
});

test('formatShellResult: timeout → error and says so', () => {
  const r = formatShellResult({ code: null, stdout: '', stderr: '', timedOut: true });
  assert.equal(r.status, 'error');
  assert.match(r.result, /timed out/i);
});

test('formatShellResult: truncates very long output', () => {
  const r = formatShellResult({ code: 0, stdout: 'x'.repeat(5000), stderr: '', timedOut: false });
  assert.ok(r.result.length < 600, `result should be truncated, got ${r.result.length}`);
});

test('SAFETY: the cleanup-test-conversations built-in ships DISABLED + dryRun', () => {
  const builtins = makeBuiltinJobs(NOW);
  const cleanup = builtins.find((j) => j.id === 'cleanup-test-conversations');
  assert.ok(cleanup, 'a cleanup-test-conversations built-in is seeded');
  assert.equal(cleanup!.enabled, false, 'ships DISABLED — the user must arm it');
  assert.equal(cleanup!.config.dryRun, true, 'ships dryRun=true — never deletes until armed');
  assert.equal(cleanup!.builtin, true, 'flagged builtin so it cannot be deleted, only disabled');
  assert.equal(cleanup!.type, 'cleanup-test-conversations');
});
