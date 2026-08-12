/**
 * Scheduler safety — the executor-reaper incident's operational lessons (bl_94b6c158).
 *
 * Four defects, each pinned by a test below:
 *  1. Hand-editing scheduled-jobs.json while Core runs was SILENTLY clobbered by the next
 *     in-process persist() → persist now stats the file first and merges hand-edits.
 *  2. deleteJob refused built-ins without naming HOW to disable → the error names the exact
 *     REST call and the scheduler_jobs MCP equivalent.
 *  3. makeBuiltinJobs claimed "All ship inert (disabled)" but seeded destructive jobs armed →
 *     destructive built-ins seed disarmed; observational monitors stay enabled.
 *  4. No kill switch that survives a dist-sync → LM_DISABLE_JOBS env override, checked at
 *     RUN TIME, never executes the job and surfaces disabledByEnv in the listing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Point every store this file touches at scratch space (jobsFilePath() reads env at call time).
const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-safety-'));
process.env.LM_ASSIST_DATA_DIR = ROOT_TMP;

import {
  makeBuiltinJobs,
  envDisabledJobIds,
  jobsFilePath,
  ScheduledJobs,
  type ScheduledJob,
} from '../scheduler/scheduled-jobs';
import { createSchedulerRoutes } from '../routes/core/scheduler.routes';

const NOW = Date.parse('2026-08-12T12:00:00Z');

/** A fresh store dir + instance per test so instances never share a file. */
function freshScheduler(): ScheduledJobs {
  process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(ROOT_TMP, 'case-'));
  return new ScheduledJobs();
}

function readStore(): ScheduledJob[] {
  return JSON.parse(fs.readFileSync(jobsFilePath(), 'utf8')) as ScheduledJob[];
}

/** Rewrite the store file as an operator's editor would, guaranteeing a NEWER mtime. */
function handEdit(mutate: (arr: ScheduledJob[]) => void): void {
  const f = jobsFilePath();
  const arr = readStore();
  mutate(arr);
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(f, future, future); // editors land on a later mtime; make that deterministic
}

// ── Defect 3: seed values ──────────────────────────────────────────────

test('seeds: destructive built-ins ship disarmed (executor-reaper disabled, worktree-gc dry-run)', () => {
  const jobs = makeBuiltinJobs(NOW);

  const reaper = jobs.find((j) => j.id === 'executor-reaper');
  assert.ok(reaper, 'executor-reaper builtin present');
  assert.equal(reaper!.enabled, false, 'executor-reaper KILLS panes — must seed disabled (the executor-reaper incident)');
  assert.equal(reaper!.config.dryRun, true, 'defense in depth: even once enabled it reports until armed');

  const gc = jobs.find((j) => j.id === 'worktree-gc');
  assert.ok(gc, 'worktree-gc builtin present');
  assert.equal(gc!.config.dryRun, true, 'worktree-gc DELETES worktrees/caches — the destructive action seeds dry-run');
  assert.equal(gc!.enabled, true, 'the sweep itself stays on so a fresh node still reports reclaimable disk');

  const cleanup = jobs.find((j) => j.id === 'cleanup-test-conversations');
  assert.equal(cleanup!.enabled, false, 'cleanup ships disabled (unchanged)');
});

test('seeds: observational monitors stay enabled (current prod reality)', () => {
  const jobs = makeBuiltinJobs(NOW);
  for (const id of ['stall-monitor', 'auth-monitor', 'mission-controller']) {
    const j = jobs.find((x) => x.id === id);
    assert.ok(j, `${id} builtin present`);
    assert.equal(j!.enabled, true, `${id} is observational/recovery — seeds enabled`);
  }
});

// ── Defect 2: the built-in delete refusal names the exact levers ───────

test('deleting a built-in names the REST call AND the scheduler_jobs MCP equivalent', async () => {
  freshScheduler(); // isolate the route singleton's store dir from other cases
  const routes = createSchedulerRoutes({} as any);
  const del = routes.find((r) => r.method === 'DELETE');
  assert.ok(del, 'DELETE /scheduler/jobs/:id route exists');
  const res: any = await del!.handler({ params: { id: 'executor-reaper' }, body: {} } as any, {} as any);
  assert.equal(res.success, false);
  assert.equal(res.error.code, 'BUILTIN');
  const msg = String(res.error.message);
  assert.ok(
    msg.includes('PUT /scheduler/jobs/executor-reaper {"enabled":false}'),
    `error must name the exact REST lever, got: ${msg}`,
  );
  assert.ok(
    msg.includes('scheduler_jobs(action="update", id="executor-reaper", auto_run=false)'),
    `error must name the scheduler_jobs MCP equivalent, got: ${msg}`,
  );
});

// ── Defect 4: LM_DISABLE_JOBS env kill switch ──────────────────────────

test('envDisabledJobIds parses a comma-separated list (trims, drops empties)', () => {
  assert.deepEqual([...envDisabledJobIds(undefined)], []);
  assert.deepEqual([...envDisabledJobIds('')], []);
  assert.deepEqual([...envDisabledJobIds('executor-reaper')], ['executor-reaper']);
  assert.deepEqual([...envDisabledJobIds(' a , b ,,c ')], ['a', 'b', 'c']);
});

test('an env-disabled job NEVER executes (even forced) and surfaces disabledByEnv in the listing', async () => {
  const s = freshScheduler();
  let runs = 0;
  s.registerHandler('probe', async () => {
    runs++;
    return { result: 'ran' };
  });
  s.upsertJob({ id: 'k1', type: 'probe', enabled: true, intervalMinutes: 1 });

  process.env.LM_DISABLE_JOBS = ' other , k1 ';
  try {
    const v = await s.runJob('k1', { force: true });
    assert.equal(runs, 0, 'env kill switch overrides store state — the handler must not run');
    assert.equal(v!.disabledByEnv, true, 'the returned view carries the marker');
    assert.equal(v!.lastRunAt, null, 'no run was recorded');
    const listed = s.listJobs().find((j) => j.id === 'k1');
    assert.equal(listed!.disabledByEnv, true, 'GET /scheduler/jobs surfaces disabledByEnv');
    assert.equal(listed!.nextRunAt, null, 'an env-disabled job forecasts no next run');
    const other = s.listJobs().find((j) => j.id === 'stall-monitor');
    assert.equal(other!.disabledByEnv, false, 'jobs not named by the env var are unaffected');
  } finally {
    delete process.env.LM_DISABLE_JOBS;
  }

  // Checked at RUN TIME: lifting the env var re-enables execution with no restart.
  const v2 = await s.runJob('k1', { force: true });
  assert.equal(runs, 1, 'after the override is lifted the job executes again');
  assert.equal(v2!.disabledByEnv, false);
});

// ── Defect 1: hand-edits merge instead of being clobbered ──────────────

test('a hand-edit while Core runs survives the next persist (merged, logged loudly)', () => {
  const s = freshScheduler();
  s.upsertJob({ id: 'c1', type: 'noop', enabled: false }); // creates the store file
  assert.equal(s.getJob('stall-monitor')!.enabled, true, 'precondition: seeded enabled');

  // Operator disarms stall-monitor + retunes its schedule directly in the file.
  handEdit((arr) => {
    const sm = arr.find((j) => j.id === 'stall-monitor')!;
    sm.enabled = false;
    sm.intervalMinutes = 45;
  });

  // An unrelated in-process mutation triggers persist() — the old code clobbered the file here.
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
  try {
    s.upsertJob({ id: 'c2', type: 'noop', enabled: false });
  } finally {
    console.error = origErr;
  }

  assert.equal(s.getJob('stall-monitor')!.enabled, false, 'hand-edited enabled survives in memory');
  assert.equal(s.getJob('stall-monitor')!.intervalMinutes, 45, 'hand-edited schedule survives in memory');
  const onDisk = readStore();
  assert.equal(onDisk.find((j) => j.id === 'stall-monitor')!.enabled, false, 'and on disk after the rewrite');
  assert.ok(onDisk.find((j) => j.id === 'c2'), 'the in-process mutation landed too');
  assert.ok(
    errors.some((l) => /hand-edit/i.test(l)),
    `a hand-edit must be logged loudly, got: ${JSON.stringify(errors)}`,
  );
});

test('a job THIS process mutated after the hand-edit keeps the in-process value (newer intent wins)', () => {
  const s = freshScheduler();
  s.upsertJob({ id: 'c1', type: 'noop', enabled: false }); // creates the store file

  handEdit((arr) => {
    const gc = arr.find((j) => j.id === 'worktree-gc')!;
    gc.enabled = false;
  });

  // The process changes the SAME job after the hand-edit — the PUT is newer intent.
  const origErr = console.error;
  console.error = () => {};
  try {
    s.upsertJob({ id: 'worktree-gc', enabled: true });
  } finally {
    console.error = origErr;
  }

  assert.equal(s.getJob('worktree-gc')!.enabled, true, 'the in-process PUT wins over the older hand-edit');
  assert.equal(readStore().find((j) => j.id === 'worktree-gc')!.enabled, true);
});

// ── Review finding 1: finishRun must not write back a stale pre-run snapshot ──

test('a hand-edit merged MID-RUN survives finishRun (no stale pre-run snapshot write-back)', async () => {
  const s = freshScheduler();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  s.registerHandler('slow', async () => { await gate; return { result: 'done' }; });
  s.upsertJob({ id: 'j1', type: 'slow', enabled: true, intervalMinutes: 60 });

  const origLog = console.log; const origErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const p = s.runJob('j1', { force: true }); // the handler is now pending on the gate
    // Incident response lands MID-RUN: the operator disarms j1 directly in the file…
    handEdit((arr) => { arr.find((j) => j.id === 'j1')!.enabled = false; });
    // …and an unrelated persist merges that edit into memory (defect-1 behavior, already shipped).
    s.upsertJob({ id: 'unrelated', type: 'noop', enabled: false });
    assert.equal(s.getJob('j1')!.enabled, false, 'precondition: the merge landed while j1 was running');
    release();
    const v = await p;
    assert.equal(v!.lastRun!.result, 'done', 'the run outcome is recorded');
    assert.equal(v!.enabled, false, 'the returned view reflects the CURRENT job, not the pre-run snapshot');
    assert.equal(s.getJob('j1')!.enabled, false, 'finishRun must not write back the stale pre-run snapshot');
    assert.equal(s.getJob('j1')!.lastRun!.result, 'done', 'run state landed on the current job');
    assert.equal(readStore().find((j) => j.id === 'j1')!.enabled, false, 'the disarm survives on disk');
  } finally {
    console.log = origLog; console.error = origErr;
  }
});

test('a job deleted MID-RUN stays deleted (finishRun must not resurrect it)', async () => {
  const s = freshScheduler();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  s.registerHandler('slow', async () => { await gate; return { result: 'done' }; });
  s.upsertJob({ id: 'doomed', type: 'slow', enabled: true, intervalMinutes: 60 });

  const origLog = console.log; console.log = () => {};
  try {
    const p = s.runJob('doomed', { force: true });
    assert.equal(s.deleteJob('doomed'), true, 'precondition: deleted while running');
    release();
    const v = await p;
    assert.equal(v!.lastRun!.result, 'done', 'the caller still sees the finished run');
    assert.equal(s.getJob('doomed'), null, 'a job deleted mid-run stays deleted');
    assert.ok(!readStore().some((j) => j.id === 'doomed'), 'and stays deleted on disk');
  } finally {
    console.log = origLog;
  }
});

// ── Review finding 2: the tick adopts hand-edits BEFORE selecting due jobs ──

test('a hand-edit disarming a DUE job stops the next tick (merge at tick time, not only at persist)', async () => {
  const s = freshScheduler();
  let runs = 0;
  s.registerHandler('probe2', async () => { runs++; return { result: 'ran' }; });
  // Disable every seeded built-in in-process so NOTHING else is due: otherwise a due built-in runs
  // first and its finishRun→persist merges the hand-edit as a side effect, masking the defect.
  for (const j of s.listJobs()) if (j.enabled) s.upsertJob({ id: j.id, enabled: false });
  s.upsertJob({ id: 'd1', type: 'probe2', enabled: true, intervalMinutes: 1 }); // never run → due NOW
  // Incident response: the operator disarms the due job directly in the file. No API call follows —
  // the only thing between the edit and a destructive run is the next tick.
  handEdit((arr) => { arr.find((j) => j.id === 'd1')!.enabled = false; });

  (s as any)._started = true; // arm tick() without start()'s real timer/handler registration
  const origErr = console.error; const origLog = console.log;
  const errs1: string[] = [];
  console.error = (...a: unknown[]) => errs1.push(a.map(String).join(' '));
  console.log = () => {};
  try { await (s as any).tick(); } finally { console.error = origErr; console.log = origLog; }

  assert.equal(runs, 0, 'the tick must adopt the on-disk disarm BEFORE selecting due jobs');
  assert.equal(s.getJob('d1')!.enabled, false, 'the hand-edit is in memory now');
  assert.ok(errs1.some((l) => /hand-edit/i.test(l)), `adoption is logged loudly, got: ${JSON.stringify(errs1)}`);

  // mtime unchanged → the next tick is one cheap fs.stat: no re-read, no re-log.
  const errs2: string[] = [];
  console.error = (...a: unknown[]) => errs2.push(a.map(String).join(' '));
  console.log = () => {};
  try { await (s as any).tick(); } finally { console.error = origErr; console.log = origLog; }
  assert.equal(errs2.filter((l) => /hand-edit/i.test(l)).length, 0, 'no re-log when the mtime is unchanged');
});

// ── Review finding 3: a manual run of an env-disabled job is refused, not silently ignored ──

test('POST /scheduler/jobs/:id/run on an LM_DISABLE_JOBS job returns a structured ENV_DISABLED refusal', async () => {
  freshScheduler(); // fresh store dir for the route singleton's persist path
  const routes = createSchedulerRoutes({} as any);
  const run = routes.find((r) => r.method === 'POST' && String(r.pattern).includes('run'));
  assert.ok(run, 'POST /scheduler/jobs/:id/run route exists');

  process.env.LM_DISABLE_JOBS = 'stall-monitor';
  const origLog = console.log; console.log = () => {};
  try {
    const res: any = await run!.handler({ params: { id: 'stall-monitor' }, body: {} } as any, {} as any);
    assert.equal(res.success, false, 'the caller must learn the run did NOT happen');
    assert.equal(res.error.code, 'ENV_DISABLED');
    const msg = String(res.error.message);
    assert.ok(msg.includes('LM_DISABLE_JOBS'), `the refusal must name the env var, got: ${msg}`);
    assert.ok(msg.includes('stall-monitor'), `the refusal must name the job id, got: ${msg}`);
  } finally {
    delete process.env.LM_DISABLE_JOBS;
    console.log = origLog;
  }
});

test('config hand-edits (e.g. flipping dryRun back on) survive too', () => {
  const s = freshScheduler();
  s.upsertJob({ id: 'worktree-gc', config: { dryRun: false } }); // operator armed it earlier
  assert.equal(s.getJob('worktree-gc')!.config.dryRun, false);

  handEdit((arr) => {
    const gc = arr.find((j) => j.id === 'worktree-gc')!;
    gc.config.dryRun = true; // incident response: disarm by hand
  });

  const origErr = console.error;
  console.error = () => {};
  try {
    s.upsertJob({ id: 'c2', type: 'noop', enabled: false });
  } finally {
    console.error = origErr;
  }
  assert.equal(s.getJob('worktree-gc')!.config.dryRun, true, 'the hand-disarm survives the rewrite');
});
