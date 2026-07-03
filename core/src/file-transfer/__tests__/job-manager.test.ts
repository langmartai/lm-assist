/**
 * Job manager tests (Task 6 of the bulk-transfer-job-manager plan).
 *
 * job-manager.ts is a durable, singleton scheduler (module-scoped maps, same
 * shape as the send-queue.ts it replaces) — so within this one file all tests
 * share the same in-memory jobs/pendingByPeer/activeByPeer/globalActive state.
 * Node's test runner executes top-level tests in a file sequentially (the
 * existing sender-abort-resume.test.ts / firehose.test.ts already rely on
 * this for their own module-level test seams), so we lean on the same
 * assumption here and keep tests independent by:
 *   - giving every test its own peer name(s), so per-peer bookkeeping never
 *     crosses test boundaries;
 *   - fully draining every job it starts (awaiting terminal state) before
 *     returning, so `globalActive` is back to its 0 baseline for the next
 *     test;
 *   - pointing the store at a fresh temp-file JobStore (`freshStore()`) at
 *     the start of every test via the `_setStoreForTest` seam, so nothing
 *     ever touches the real `~/.cache/lm-assist/` log.
 *
 * Covers:
 *   (a) per-peer(2) + global(8) concurrency caps, with fairness across peers;
 *   (b) cancelling a still-queued job -> 'cancelled', executor never runs;
 *   (c) cancelling an active job -> executor observes signal.aborted -> 'cancelled';
 *   (d) a retriable failure twice, then success -> attempts increments, ends 'done';
 *   (f) recover() replays a persisted non-terminal record as 'queued';
 *   (g) recover() also drops a terminal record past the retention window
 *       while still re-queueing a non-terminal record seeded in that same
 *       call (the drop and the re-queue are proven together, not in isolation);
 *   (h) the TTL sweep against a *cooperative* (abort-responsive) executor
 *       still disambiguates to 'expired' via cancelReason, not 'cancelled'
 *       — the counterpart of (e) below, which covers the non-cooperative
 *       (stuck, ignores abort) executor instead;
 *   (e) the TTL sweep marks an expired job 'expired' even if its executor is
 *       stuck and never responds to abort;
 *   (i) enqueueJob threads an optional forceMode onto the JobRecord the
 *       executor receives, and leaves it undefined when omitted (review-fix:
 *       forceMode restoration, task-7-report.md).
 *
 * (f)/(g)/(h) all run before (e) deliberately: (e)'s stuck-forever executor
 * permanently leaks one global concurrency slot (nothing ever decrements it,
 * since runJob's finally only runs once the executor promise settles) —
 * ordering it last keeps that leak from affecting any other test's cap
 * accounting. (f)/(g)/(h) never hit that problem themselves: (f)/(g)'s
 * recovered jobs are driven to completion (or never dispatched at all, for
 * the dropped record) and (h)'s executor is cooperative, so its promise
 * settles and runJob's finally always runs.
 *
 * `_setStoreForTest` and `_sweepNowForTest` are test-only seams added beyond
 * the brief's transcribed code — see task-6-report.md for why.
 *
 * Run (compiled): node --test dist-test/file-transfer/__tests__/job-manager.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { JobStore, type JobRecord, type SourceRef, type SinkRef } from '../job-store';
import {
  enqueueJob,
  cancelJob,
  getJob,
  snapshot,
  waitForJob,
  recover,
  _setExecutorForTest,
  _setStoreForTest,
  _sweepNowForTest,
} from '../job-manager';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * job-manager's own timers (retry backoff, waitForJob's poll, the TTL
 * sweeper) are all .unref()'d — correct in production, where the HTTP
 * server / hub WebSocket keeps the process alive regardless. This test file
 * has no such handle, so without a ref'd timer standing in, Node's event
 * loop can drain and abort a test mid-flight ("Promise resolution is still
 * pending but the event loop has already resolved"). Mirrors the identical
 * helper in sender-abort-resume.test.ts / firehose.test.ts.
 */
function keepAlive(): { stop: () => void } {
  const t = setInterval(() => {}, 25);
  return { stop: () => clearInterval(t) };
}

/** Point the manager's durable store at a fresh temp file; returns it for direct seeding. */
function freshStore(): JobStore {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jm-')), 'jobs.jsonl');
  const store = new JobStore(f);
  _setStoreForTest(store);
  return store;
}

async function drain(jobIds: string[], timeoutMs = 10_000): Promise<void> {
  await Promise.all(jobIds.map((id) => waitForJob(id, timeoutMs)));
}

function src(p: string): SourceRef {
  return { kind: 'file', path: p };
}
function snk(p: string): SinkRef {
  return { kind: 'file', path: p };
}

test('enforces per-peer(2) and global(8) concurrency caps while making fair progress across peers', { timeout: 15_000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peers = ['a-p1', 'a-p2', 'a-p3', 'a-p4', 'a-p5'];
    const JOBS_PER_PEER = 3;
    let maxGlobal = 0;
    const maxPerPeer = new Map<string, number>();
    const startedByPeer = new Map<string, number>();

    // Sample the manager's own live counters at the exact instant each job
    // starts (pump() has already incremented globalActive/activeByPeer for
    // this job by the time its executor is invoked), so the peak is exact
    // rather than a polling approximation that could miss a spike.
    _setExecutorForTest(async (job) => {
      const snap = snapshot();
      maxGlobal = Math.max(maxGlobal, snap.globalActive);
      const activeForPeer = snap.jobs.filter((j) => j.peer === job.peer && j.state === 'active').length;
      maxPerPeer.set(job.peer, Math.max(maxPerPeer.get(job.peer) ?? 0, activeForPeer));
      startedByPeer.set(job.peer, (startedByPeer.get(job.peer) ?? 0) + 1);
      await sleep(150);
      return { bytes: job.size, mode: 'relay', via: null };
    });

    const jobIds: string[] = [];
    for (const peer of peers) {
      for (let i = 0; i < JOBS_PER_PEER; i++) {
        jobIds.push(enqueueJob({ peer, source: src(`/local/${peer}/${i}`), sink: snk(`/remote/${peer}/${i}`), size: 1024 }));
      }
    }

    await drain(jobIds);

    assert.ok(maxGlobal <= 8, `global active never exceeded 8 (saw ${maxGlobal})`);
    assert.ok(maxGlobal >= 7, `global cap was actually exercised near its limit (saw peak ${maxGlobal})`);
    for (const peer of peers) {
      assert.ok((maxPerPeer.get(peer) ?? 0) <= 2, `peer ${peer} active never exceeded 2 (saw ${maxPerPeer.get(peer)})`);
    }
    for (const peer of peers) {
      assert.equal(startedByPeer.get(peer), JOBS_PER_PEER, `peer ${peer} ran all ${JOBS_PER_PEER} of its jobs (no starvation)`);
    }
    for (const id of jobIds) {
      assert.equal(getJob(id)!.state, 'done');
    }
  } finally {
    ka.stop();
  }
});

test('cancelling a still-queued job marks it cancelled and it never runs', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peer = 'b-peer';
    const started: string[] = [];
    _setExecutorForTest(async (job) => {
      started.push(job.jobId);
      await sleep(80);
      return { bytes: job.size, mode: 'relay', via: null };
    });

    const j0 = enqueueJob({ peer, source: src('/l/0'), sink: snk('/r/0'), size: 1 });
    const j1 = enqueueJob({ peer, source: src('/l/1'), sink: snk('/r/1'), size: 1 });
    const j2 = enqueueJob({ peer, source: src('/l/2'), sink: snk('/r/2'), size: 1 }); // queued: per-peer cap is 2
    const j3 = enqueueJob({ peer, source: src('/l/3'), sink: snk('/r/3'), size: 1 }); // queued

    assert.equal(getJob(j0)!.state, 'active', 'j0 dispatched immediately (slot 1/2)');
    assert.equal(getJob(j1)!.state, 'active', 'j1 dispatched immediately (slot 2/2)');
    assert.equal(getJob(j2)!.state, 'queued', 'j2 waits — per-peer cap reached');

    const ok = cancelJob(j2, 'test-cancel');
    assert.equal(ok, true, 'cancelJob reports success for a queued job');
    assert.equal(getJob(j2)!.state, 'cancelled');
    assert.equal(getJob(j2)!.cancelReason, 'test-cancel');

    await drain([j0, j1, j3]);

    assert.ok(!started.includes(j2), 'cancelled-while-queued job never invoked the executor');
    assert.equal(getJob(j0)!.state, 'done');
    assert.equal(getJob(j1)!.state, 'done');
    assert.equal(getJob(j3)!.state, 'done', 'j3 took the slot freed by j2 being cancelled out of the queue');
  } finally {
    ka.stop();
  }
});

test('cancelling an active job aborts its signal and ends cancelled', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peer = 'c-peer';
    let sawAbort = false;
    _setExecutorForTest(
      (_job, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new Error('aborted by peer'));
            },
            { once: true },
          );
        }),
    );

    const j0 = enqueueJob({ peer, source: src('/l/0'), sink: snk('/r/0'), size: 1 });
    assert.equal(getJob(j0)!.state, 'active');

    const ok = cancelJob(j0, 'user-cancel');
    assert.equal(ok, true);

    const view = await waitForJob(j0, 5000);
    assert.equal(view.state, 'cancelled');
    assert.ok(sawAbort, 'executor observed signal.aborted');
  } finally {
    ka.stop();
  }
});

test('retries a retriable failure and succeeds on the third attempt', { timeout: 10_000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peer = 'd-peer';
    let calls = 0;
    _setExecutorForTest(async (job) => {
      calls++;
      if (calls < 3) throw new Error('transient failure');
      return { bytes: job.size, mode: 'relay', via: null };
    });

    const j0 = enqueueJob({ peer, source: src('/l/0'), sink: snk('/r/0'), size: 42 });
    const view = await waitForJob(j0, 8000);

    assert.equal(view.state, 'done');
    assert.equal(calls, 3, 'executor was invoked 3 times (2 failures + 1 success)');
    assert.equal(getJob(j0)!.attempts, 3);
  } finally {
    ka.stop();
  }
});

test('enqueueJob threads an optional forceMode onto the JobRecord the executor receives; omitted stays undefined', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peer = 'i-peer';
    const seen = new Map<string, 'direct' | 'relay' | undefined>();
    _setExecutorForTest(async (job) => {
      seen.set(job.jobId, job.forceMode);
      return { bytes: job.size, mode: 'relay', via: null };
    });

    const withForce = enqueueJob({ peer, source: src('/l/force'), sink: snk('/r/force'), size: 1, forceMode: 'relay' });
    const withoutForce = enqueueJob({ peer, source: src('/l/noforce'), sink: snk('/r/noforce'), size: 1 });

    await drain([withForce, withoutForce]);

    assert.equal(seen.get(withForce), 'relay', 'executor receives job.forceMode === \'relay\' when the caller requested it');
    assert.equal(seen.get(withoutForce), undefined, 'executor receives job.forceMode === undefined when the caller omitted it (today\'s auto-negotiation)');
    // Round-trips through the persisted/queryable JobRecord too, not just the live executor call.
    assert.equal(getJob(withForce)!.forceMode, 'relay');
    assert.equal(getJob(withoutForce)!.forceMode, undefined);
  } finally {
    ka.stop();
  }
});

test('recover() replays a persisted active job as queued', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  const peer = 'f-peer';
  const releases: Array<() => void> = [];
  _setExecutorForTest(
    (job, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        releases.push(() => resolve({ bytes: job.size, mode: 'relay', via: null }));
      }),
  );

  // Occupy both of this peer's slots with live, cooperative jobs so the
  // recovered job below cannot be immediately re-dispatched by recover()'s
  // trailing pump() — this lets us observe it settle into 'queued' rather
  // than race straight through to 'active'.
  freshStore(); // store A — the occupiers persist here
  const occ0 = enqueueJob({ peer, source: src('/l/occ0'), sink: snk('/r/occ0'), size: 1 });
  const occ1 = enqueueJob({ peer, source: src('/l/occ1'), sink: snk('/r/occ1'), size: 1 });
  assert.equal(getJob(occ0)!.state, 'active');
  assert.equal(getJob(occ1)!.state, 'active');

  // Switch to a second, isolated store *before* seeding the stale record, so
  // recover()'s store.loadAll() only ever sees the one record we seed here —
  // not occ0/occ1's own persisted state (which would otherwise get reloaded
  // and incorrectly re-queued out from under the live jobs still running).
  const storeB = freshStore();
  const recoveredId = randomUUID();
  const staleRecord: JobRecord = {
    jobId: recoveredId,
    peer,
    source: src('/l/crashed'),
    sink: snk('/r/crashed'),
    size: 999,
    state: 'active', // simulates a job that was mid-flight when the process died
    attempts: 1,
    maxAttempts: 5,
    bytesDone: 100,
    resumeCount: 0,
    enqueuedAt: Date.now() - 5000,
    startedAt: Date.now() - 4000,
    deadlineAt: Date.now() + 3600_000,
  };
  storeB.append(staleRecord);

  try {
    recover();

    const view = getJob(recoveredId);
    assert.ok(view, 'recovered job is present after recover()');
    assert.equal(view!.state, 'queued', 'a non-terminal persisted record is re-queued by recover(), not left active');
  } finally {
    cancelJob(recoveredId); // still queued -> removed cleanly, no executor invocation
    for (const release of releases) release();
    await drain([occ0, occ1]);
    ka.stop();
  }
});

test('recover() drops a terminal record past retention while re-queueing a non-terminal one seeded alongside it', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    const peer = 'g-peer';
    let dispatched = false;
    const releases: Array<() => void> = [];
    _setExecutorForTest(
      (job, signal) =>
        new Promise((resolve, reject) => {
          dispatched = true;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          releases.push(() => resolve({ bytes: job.size, mode: 'relay', via: null }));
        }),
    );

    const store = freshStore();
    const staleTerminalId = randomUUID();
    const activeId = randomUUID();
    const staleTerminal: JobRecord = {
      jobId: staleTerminalId,
      peer,
      source: src('/l/stale'),
      sink: snk('/r/stale'),
      size: 10,
      state: 'done', // terminal
      attempts: 1,
      maxAttempts: 5,
      bytesDone: 10,
      resumeCount: 0,
      enqueuedAt: Date.now() - 3 * 3600_000,
      startedAt: Date.now() - 3 * 3600_000,
      endedAt: Date.now() - 2 * 3600_000, // 2h old — past the 1h default retention window
      deadlineAt: Date.now() + 3600_000,
    };
    const activeRecord: JobRecord = {
      jobId: activeId,
      peer,
      source: src('/l/active'),
      sink: snk('/r/active'),
      size: 10,
      state: 'active', // non-terminal — simulates a job mid-flight when the process died
      attempts: 1,
      maxAttempts: 5,
      bytesDone: 0,
      resumeCount: 0,
      enqueuedAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
      deadlineAt: Date.now() + 3600_000,
    };
    store.append(staleTerminal);
    store.append(activeRecord);

    try {
      recover();

      assert.ok(
        !snapshot().jobs.some((j) => j.jobId === staleTerminalId),
        'terminal record past the retention window is dropped by recover(), absent from snapshot()',
      );
      assert.ok(
        dispatched,
        'the non-terminal record was re-queued and actually picked up by pump() (executor invoked), not just left inert',
      );
      assert.equal(getJob(activeId)!.state, 'active', 'recovered non-terminal job is running again, not dropped');
    } finally {
      for (const release of releases) release();
      await drain([activeId]);
    }
  } finally {
    ka.stop();
  }
});

test('TTL sweep against a cooperative (abort-responsive) executor still lands expired, not cancelled', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peer = 'h-peer';
    // Cooperative: unlike (e) below, this executor *does* respond to the
    // abort signal by rejecting — so this exercises runJob's own catch
    // (the ac.signal.aborted / cancelReason==='expired' disambiguation),
    // not sweepOnce()'s force-expire fallback for a stuck executor.
    _setExecutorForTest(
      (_job, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by peer')), { once: true });
        }),
    );

    const j0 = enqueueJob({ peer, source: src('/l/0'), sink: snk('/r/0'), size: 1, ttlMs: 0 });
    assert.equal(getJob(j0)!.state, 'active', 'dispatched immediately — single job, well under caps');

    _sweepNowForTest();

    // The cooperative executor's rejection settles runJob's catch
    // asynchronously (a microtask), unlike (e)'s stuck executor where
    // sweepOnce() forces the state synchronously — so this must be awaited
    // rather than asserted immediately after the sweep call.
    const view = await waitForJob(j0, 5000);
    assert.equal(
      view.state,
      'expired',
      'TTL-triggered abort disambiguates via cancelReason to expired even when the executor cooperates, not cancelled',
    );
  } finally {
    ka.stop();
  }
});

test('TTL sweep marks an expired job as expired even while its executor is stuck', { timeout: 8000 }, async () => {
  freshStore();
  const peer = 'e-peer';
  // Deliberately never settles, and ignores the abort signal entirely — this
  // isolates the sweeper's own bookkeeping from whether the underlying
  // executor cooperates with cancellation (that's covered by test (c)).
  _setExecutorForTest(() => new Promise(() => {}));

  const j0 = enqueueJob({ peer, source: src('/l/0'), sink: snk('/r/0'), size: 1, ttlMs: 0 });
  assert.equal(getJob(j0)!.state, 'active', 'dispatched immediately — single job, well under caps');

  _sweepNowForTest();

  assert.equal(getJob(j0)!.state, 'expired');
});
