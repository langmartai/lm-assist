// core/src/__tests__/data-bundle/sch-data-snapshot.test.ts
// The built-in `data-snapshot` scheduled job: seeded DISABLED at 24 h, merged into an existing
// jobs file on upgrade without touching the operator's values, wired into the scheduler's
// defaults, and its runner calls the bundle service's default export (note 'scheduled') and
// reports bundleId / size / section counts — or a failed run carrying the refusal code.
//
// svc-harness MUST be the first import: it points HOME and LM_ASSIST_DATA_DIR at temp dirs
// before any lm-assist module loads, so nothing here can reach the real ~/.lm-assist.
import { tmp, makeNode, ownedDataset, rec } from './svc-harness';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { makeBuiltinJobs, jobsFilePath, ScheduledJobs, type ScheduledJob } from '../../scheduler/scheduled-jobs';
import {
  registerDataSnapshot, runDataSnapshot, snapshotOptions, formatSnapshotResult,
  DATA_SNAPSHOT_JOB_ID, DATA_SNAPSHOT_NOTE,
} from '../../scheduler/data-snapshot';
import { BundleStore } from '../../data/bundle/store';
import { BundleError } from '../../data/bundle/format';
import { _setBundleServiceForTests, BundleServiceError, type ExportOptions, type ExportResult } from '../../data/bundle';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const DATA_ROOT = process.env.LM_ASSIST_DATA_DIR!;

/** A fresh jobs-file dir per case (jobsFilePath() reads the env at call time). */
function freshJobsDir(): void {
  process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(DATA_ROOT, 'jobs-'));
}
const readStore = (): ScheduledJob[] => JSON.parse(fs.readFileSync(jobsFilePath(), 'utf8')) as ScheduledJob[];

function fakeResult(over: Partial<ExportResult> = {}): ExportResult {
  return {
    bundleId: 'lmb-20260923-120000-abc123',
    path: '/x/bundles/lmb-20260923-120000-abc123.lmbundle.gz',
    sizeBytes: 3 * 1024 * 1024,
    sha256: 'f'.repeat(64),
    createdAt: '2026-09-23T12:00:00.000Z',
    note: 'scheduled',
    sections: [
      { kind: 'dataset', id: 'backlog', title: 'backlog', count: 276, bytes: 10, warnings: [], tombstones: 3 },
      { kind: 'dataset', id: 'missions', title: 'missions', count: 65, bytes: 10, warnings: [], tombstones: 0 },
      { kind: 'config', id: 'scheduled-jobs', title: 'Scheduled jobs', count: 1, bytes: 10, warnings: [] },
      { kind: 'config', id: 'project-settings', title: 'Project settings', count: 1, bytes: 10, warnings: ['x'] },
    ],
    totals: { entries: 345, uncompressedBytes: 999 },
    excluded: [{ id: 'node-clusters', reason: 'runtime dataset' }],
    warnings: ['not exported — mcp-profile: boom'],
    pruned: ['lmb-20260101-000000-000001'],
    next: 'on the target node: …',
    ...over,
  };
}

/** A createExport fake that records every call. */
function recorder(impl: (o: ExportOptions) => Promise<ExportResult> = async () => fakeResult()) {
  const calls: ExportOptions[] = [];
  return { calls, createExport: async (o: ExportOptions) => { calls.push(o); return impl(o); } };
}

// ── seed ────────────────────────────────────────────────────────────────

test('seed: data-snapshot is a built-in, DISABLED by default, every 24 h, type data-snapshot', () => {
  const job = makeBuiltinJobs(NOW).find((j) => j.id === DATA_SNAPSHOT_JOB_ID);
  assert.ok(job, 'data-snapshot builtin present');
  assert.equal(job!.type, 'data-snapshot');
  assert.equal(job!.builtin, true, 'cannot be deleted, only disabled');
  assert.equal(job!.enabled, false, 'ships DISABLED — it writes to disk on every node the build reaches');
  assert.equal(job!.intervalMinutes, 1440, 'daily');
  // The opt-ins are visible in the job config but seeded off: a seeded run IS the default export.
  assert.deepEqual(job!.config, { includeReplicas: false, includeKnowledge: false, includeClaudeMemory: false });
  assert.equal(job!.lastRunAt, null);
});

// ── upgrade merge ───────────────────────────────────────────────────────

test('upgrade: an existing jobs file without data-snapshot gains it disabled; the operator’s values survive', () => {
  freshJobsDir();
  // A store written by an older build: no data-snapshot entry, a hand-disabled built-in, a custom job.
  const older = makeBuiltinJobs(NOW).filter((j) => j.id !== DATA_SNAPSHOT_JOB_ID).map((j) =>
    j.id === 'stall-monitor' ? { ...j, enabled: false, intervalMinutes: 17 } : j);
  const custom: ScheduledJob = {
    id: 'my-job', type: 'shell', enabled: true, intervalMinutes: 30, config: { command: 'true' },
    lastRunAt: null, lastResult: null, lastStatus: null, builtin: false,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  };
  fs.mkdirSync(path.dirname(jobsFilePath()), { recursive: true });
  fs.writeFileSync(jobsFilePath(), JSON.stringify([...older, custom], null, 2));

  const s = new ScheduledJobs();
  const snap = s.getJob(DATA_SNAPSHOT_JOB_ID);
  assert.ok(snap, 'the new built-in is seeded into an existing store');
  assert.equal(snap!.enabled, false);
  assert.equal(snap!.intervalMinutes, 1440);
  assert.equal(snap!.nextRunAt, null, 'a disabled job never fires');
  assert.equal(s.getJob('stall-monitor')!.enabled, false, 'the operator’s disable is kept');
  assert.equal(s.getJob('stall-monitor')!.intervalMinutes, 17);
  assert.equal(s.getJob('my-job')!.enabled, true, 'custom jobs are untouched');

  // The next persist writes the new built-in to disk alongside the operator's values.
  s.upsertJob({ id: 'my-job', intervalMinutes: 31 });
  const disk = readStore();
  const onDisk = disk.find((j) => j.id === DATA_SNAPSHOT_JOB_ID);
  assert.ok(onDisk, 'persisted after the first write');
  assert.equal(onDisk!.enabled, false);
  assert.equal(disk.find((j) => j.id === 'stall-monitor')!.enabled, false);
});

test('upgrade: an operator-armed data-snapshot keeps enabled + interval across a reload', () => {
  freshJobsDir();
  const armed = makeBuiltinJobs(NOW).map((j) =>
    j.id === DATA_SNAPSHOT_JOB_ID ? { ...j, enabled: true, intervalMinutes: 720, config: { includeKnowledge: true } } : j);
  fs.mkdirSync(path.dirname(jobsFilePath()), { recursive: true });
  fs.writeFileSync(jobsFilePath(), JSON.stringify(armed, null, 2));
  const job = new ScheduledJobs().getJob(DATA_SNAPSHOT_JOB_ID)!;
  assert.equal(job.enabled, true);
  assert.equal(job.intervalMinutes, 720);
  assert.equal(job.config.includeKnowledge, true, 'saved config wins over the seed');
  assert.equal(job.config.includeReplicas, false, 'seed keys the save lacks are filled in');
});

// ── dispatch wiring ─────────────────────────────────────────────────────

test('dispatch: the scheduler’s default handlers include data-snapshot', () => {
  freshJobsDir();
  const s = new ScheduledJobs();
  (s as unknown as { registerDefaults(): void }).registerDefaults();
  const handlers = (s as unknown as { handlers: Map<string, unknown> }).handlers;
  assert.equal(typeof handlers.get('data-snapshot'), 'function');
});

// ── runner (injected export) ────────────────────────────────────────────

test('runner: calls the bundle service’s default export with note "scheduled" and nothing else', async () => {
  const r = recorder();
  const out = await runDataSnapshot({ includeReplicas: false, includeKnowledge: false, includeClaudeMemory: false }, {}, { createExport: r.createExport });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { note: DATA_SNAPSHOT_NOTE });
  assert.equal(DATA_SNAPSHOT_NOTE, 'scheduled');
  assert.equal(out.status, 'ok');
});

test('runner: lastResult names the bundleId, the size and the section counts', async () => {
  const out = await runDataSnapshot({}, {}, { createExport: recorder().createExport });
  assert.match(out.result, /lmb-20260923-120000-abc123/);
  assert.match(out.result, /3\.0 MB/);
  assert.match(out.result, /4 sections \(2 datasets, 2 config\)/);
  assert.match(out.result, /341 records/, 'dataset record counts are summed');
  assert.match(out.result, /3 tombstones/);
  assert.match(out.result, /pruned 1/);
  assert.match(out.result, /2 warnings/, 'result warnings + section warnings are counted');
  // The per-section detail rides in the run record's output, bounded.
  assert.match(out.stdout ?? '', /dataset backlog: 276 records \(3 tombstones\)/);
  assert.match(out.stdout ?? '', /excluded node-clusters: runtime dataset/);
  assert.match(out.stdout ?? '', /warning: not exported — mcp-profile: boom/);
});

test('runner: config opt-ins pass through only when true (or the connector’s "true")', () => {
  assert.deepEqual(snapshotOptions({}), { note: 'scheduled' });
  assert.deepEqual(snapshotOptions({ includeReplicas: true, includeKnowledge: 'true', includeClaudeMemory: 'yes' }),
    { note: 'scheduled', includeReplicas: true, includeKnowledge: true });
  assert.deepEqual(snapshotOptions({ note: 'mine', sections: ['config'], datasets: ['x'] }), { note: 'scheduled' },
    'note/sections/datasets are not job options — a scheduled snapshot is always the default export');
});

test('runner: DISK_LOW is a FAILED run naming the code and the numbers', async () => {
  const r = recorder(async () => {
    throw new BundleError('DISK_LOW', 'not enough free disk for a bundle', undefined,
      { freeBytes: 100 * 1024 * 1024, requiredBytes: 512 * 1024 * 1024, estimatedBytes: 1024 });
  });
  const out = await runDataSnapshot({}, {}, { createExport: r.createExport });
  assert.equal(out.status, 'error');
  assert.match(out.result, /^DISK_LOW: /);
  assert.match(out.result, /100\.0 MB free, 512\.0 MB required/);
  assert.match(out.result, /no bundle written/);
});

test('runner: any other refusal is a failed run carrying its code', async () => {
  const r = recorder(async () => { throw new BundleServiceError('EXPORT_INCOMPLETE', 'backlog: paging could not prove completeness'); });
  const out = await runDataSnapshot({}, {}, { createExport: r.createExport });
  assert.equal(out.status, 'error');
  assert.match(out.result, /^EXPORT_INCOMPLETE: backlog: paging/);
  const plain = await runDataSnapshot({}, {}, { createExport: async () => { throw new Error('kaboom'); } });
  assert.equal(plain.status, 'error');
  assert.match(plain.result, /^INTERNAL: kaboom/);
});

test('runner: a forced dry-run (preview) writes nothing and prunes nothing', async () => {
  const r = recorder();
  const out = await runDataSnapshot({ includeKnowledge: true }, { dryRunForced: true }, { createExport: r.createExport, retention: () => 7 });
  assert.equal(r.calls.length, 0, 'no export in a preview');
  assert.equal(out.status, 'ok');
  assert.match(out.result, /^dry-run: /);
  assert.match(out.result, /includeKnowledge/);
  assert.match(out.result, /newest 7/);
});

test('formatSnapshotResult: a bundle with no sections still reads cleanly', () => {
  const out = formatSnapshotResult(fakeResult({ sections: [], warnings: [], pruned: [], excluded: [], sizeBytes: 512 }));
  assert.match(out.result, /0 sections/);
  assert.doesNotMatch(out.result, /pruned|warning/);
  assert.match(out.result, /512 B/);
});

// ── end to end: scheduler → real bundle service → store ─────────────────

test('e2e: a manual run writes a "scheduled" bundle, records it in lastResult and persists the run', async () => {
  freshJobsDir();
  // A clock that moves 1 s per read: bundle ids embed their UTC second, and the store orders
  // (and so prunes) by id — same-second ids would fall back to their random suffix.
  let t = NOW;
  const store = new BundleStore({ dir: path.join(tmp('sch-store-'), 'bundles'), receivedDir: tmp('sch-recv-'), retention: 2, freeBytes: () => 1e15, now: () => (t += 1000) });
  const node = makeNode({ store });
  await ownedDataset(node, 'notes', [rec('a', 1, { x: 1 }), rec('b', 2, { x: 2 }), rec('c', 3, { x: 3 }, { deleted: true })]);
  _setBundleServiceForTests(node.svc);
  try {
    const s = new ScheduledJobs();
    registerDataSnapshot(s);
    const v = await s.runJob(DATA_SNAPSHOT_JOB_ID, { force: true });
    assert.equal(v!.lastStatus, 'ok', v!.lastResult ?? '');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].note, 'scheduled');
    assert.match(v!.lastResult!, new RegExp(list[0].bundleId));
    assert.match(v!.lastResult!, /1 section \(1 dataset\), 3 records, 1 tombstone/);
    const onDisk = readStore().find((j) => j.id === DATA_SNAPSHOT_JOB_ID)!;
    assert.equal(onDisk.lastResult, v!.lastResult, 'the summary is persisted');
    assert.equal(onDisk.enabled, false, 'a manual run does not arm the job');

    // Retention (2 here) prunes the oldest; the run that pruned says so.
    await s.runJob(DATA_SNAPSHOT_JOB_ID, { force: true });
    const third = await s.runJob(DATA_SNAPSHOT_JOB_ID, { force: true });
    const kept = (await store.list()).map((b) => b.bundleId);
    assert.equal(kept.length, 2);
    assert.match(third!.lastResult!, /pruned 1/);
    assert.ok(kept.some((id) => third!.lastResult!.includes(id)), 'the bundle the result names is one that was kept');
    assert.ok(!kept.includes(list[0].bundleId), 'the oldest was the one pruned');
  } finally {
    _setBundleServiceForTests(null);
  }
});

test('e2e: DISK_LOW fails the run and writes no bundle', async () => {
  freshJobsDir();
  const store = new BundleStore({ dir: path.join(tmp('sch-store-'), 'bundles'), receivedDir: tmp('sch-recv-'), retention: 5, freeBytes: () => 1024 });
  const node = makeNode({ store });
  await ownedDataset(node, 'notes', [rec('a', 1, { x: 1 })]);
  _setBundleServiceForTests(node.svc);
  try {
    const s = new ScheduledJobs();
    registerDataSnapshot(s);
    const v = await s.runJob(DATA_SNAPSHOT_JOB_ID, { force: true });
    assert.equal(v!.lastStatus, 'error');
    assert.match(v!.lastResult!, /^DISK_LOW: /);
    assert.equal((await store.list()).length, 0);
  } finally {
    _setBundleServiceForTests(null);
  }
});
