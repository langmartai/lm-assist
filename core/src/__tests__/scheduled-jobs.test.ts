import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isJobDue,
  nextRunAtMs,
  applyJobResult,
  makeBuiltinJobs,
  formatShellResult,
  clampTimeoutMs,
  type ScheduledJob,
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
