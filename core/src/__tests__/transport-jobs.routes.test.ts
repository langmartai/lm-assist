/**
 * Transport job routes (Task 7 of the bulk-transfer-job-manager plan).
 *
 * Route-handler level: calls createTransportRoutes()'s handlers directly
 * (same harness convention as worker-role-routes.test.ts — named regex
 * groups -> req.params, plain object literals for req/api). The executor is
 * stubbed via job-manager's own test seam (_setExecutorForTest) so nothing
 * here ever opens a real transport channel, and the durable log is
 * redirected to a fresh temp file per test (_setStoreForTest) so nothing
 * touches the real ~/.cache/lm-assist/transfer-jobs-{dev,prod}.jsonl.
 *
 * job-manager is process-singleton module state shared across every test in
 * this file (same caveat job-manager.test.ts documents) — node:test runs a
 * file's top-level tests sequentially, so isolation is kept by: a distinct
 * peer name per test, and fully draining every job it starts before
 * returning (so globalActive/activeByPeer are back at 0 for the next test's
 * cap accounting).
 *
 * Run (compiled): node --test dist-test/__tests__/transport-jobs.routes.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTransportRoutes } from '../routes/core/transport.routes';
import { JobStore } from '../file-transfer/job-store';
import { _setExecutorForTest, _setStoreForTest, snapshot, waitForJob } from '../file-transfer/job-manager';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** job-manager's own timers (retry backoff, waitForJob's poll, the TTL
 * sweeper) are all .unref()'d — correct in production, where the HTTP
 * server keeps the process alive regardless. This test file has no such
 * handle, so without a ref'd timer standing in, Node's event loop can drain
 * and abort a test mid-flight. Mirrors job-manager.test.ts's identical helper. */
function keepAlive(): { stop: () => void } {
  const t = setInterval(() => {}, 25);
  return { stop: () => clearInterval(t) };
}

/** Point the manager's durable store at a fresh temp file for this test. */
function freshStore(): void {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tjr-')), 'jobs.jsonl');
  _setStoreForTest(new JobStore(f));
}

async function drain(jobIds: string[], timeoutMs = 10_000): Promise<void> {
  await Promise.all(jobIds.map((id) => waitForJob(id, timeoutMs)));
}

const routes = createTransportRoutes({} as any);
const find = (method: string, urlPath: string) => {
  const r = routes.find((x) => x.method === method && x.pattern.test(urlPath));
  if (!r) throw new Error(`no route ${method} ${urlPath}`);
  const params = (r.pattern.exec(urlPath) as any)?.groups ?? {};
  return { r, params };
};
const call = async (method: string, urlPath: string, body?: any, query: Record<string, string> = {}) => {
  const { r, params } = find(method, urlPath);
  return r.handler({ params, query, body } as any, {} as any);
};

// A real file on disk so fs.statSync(localPath) in the send-file handler
// succeeds (the coordination requirement: size comes from stat, not a guess).
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tjr-src-'));
const localFile = path.join(localDir, 'a.bin');
fs.writeFileSync(localFile, Buffer.alloc(1024, 7));

test('the three job routes exist (GET /transport/jobs, GET /transport/jobs/:id, POST /transport/jobs/:id/cancel)', () => {
  assert.doesNotThrow(() => find('GET', '/transport/jobs'));
  assert.doesNotThrow(() => find('GET', '/transport/jobs/abc'));
  assert.doesNotThrow(() => find('POST', '/transport/jobs/abc/cancel'));
});

test('POST /transport/send-file enqueues via the job manager; GET /transport/jobs/:id reports it (size from fs.statSync)', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const releases: Array<() => void> = [];
    _setExecutorForTest(
      (job) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ bytes: job.size, mode: 'relay', via: null }));
        }),
    );

    const sent = await call('POST', '/transport/send-file', {
      peerGatewayId: 'peer-basic',
      localPath: localFile,
      remotePath: 'dest/a.bin',
    });
    assert.equal((sent as any).success, true);
    const jobId = (sent as any).data.jobId;
    assert.ok(jobId, 'jobId returned immediately (non-blocking default)');
    assert.equal((sent as any).data.state, 'queued');

    const status = await call('GET', `/transport/jobs/${jobId}`);
    assert.equal((status as any).success, true);
    assert.equal((status as any).data.jobId, jobId);
    assert.equal((status as any).data.peer, 'peer-basic');
    assert.deepEqual((status as any).data.source, { kind: 'file', path: localFile });
    assert.deepEqual((status as any).data.sink, { kind: 'file', path: 'dest/a.bin' });
    assert.equal((status as any).data.size, 1024, 'size comes from fs.statSync(localPath), not a guess');

    for (const r of releases) r();
    await drain([jobId]);

    const done = await call('GET', `/transport/jobs/${jobId}`);
    assert.equal((done as any).data.state, 'done');
  } finally {
    ka.stop();
  }
});

test('GET /transport/jobs/:id for an unknown id returns a clean error (404-style, not a throw)', async () => {
  const res = await call('GET', '/transport/jobs/does-not-exist-ever');
  assert.equal((res as any).success, false);
  assert.ok((res as any).error);
});

test('POST /transport/send-file with a non-existent localPath fails cleanly (fs.statSync throws, caught not crashed)', async () => {
  const res = await call('POST', '/transport/send-file', {
    peerGatewayId: 'peer-nofile',
    localPath: '/no/such/path/ever/for/this/test',
    remotePath: 'd',
  });
  assert.equal((res as any).success, false);
  assert.ok((res as any).error);
});

test('GET /transport/jobs lists jobs and supports ?peer= and ?state= filters', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const releases: Array<() => void> = [];
    _setExecutorForTest(
      (job) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ bytes: job.size, mode: 'relay', via: null }));
        }),
    );

    const a = await call('POST', '/transport/send-file', { peerGatewayId: 'peer-list-a', localPath: localFile, remotePath: 'x' });
    const b = await call('POST', '/transport/send-file', { peerGatewayId: 'peer-list-b', localPath: localFile, remotePath: 'y' });
    const jobIdA = (a as any).data.jobId;
    const jobIdB = (b as any).data.jobId;

    const all = await call('GET', '/transport/jobs');
    assert.equal((all as any).success, true);
    assert.equal(typeof (all as any).data.maxConcurrent, 'number');
    const ids = (all as any).data.jobs.map((j: any) => j.jobId);
    assert.ok(ids.includes(jobIdA) && ids.includes(jobIdB));

    const byPeer = await call('GET', '/transport/jobs', undefined, { peer: 'peer-list-a' });
    assert.equal((byPeer as any).success, true);
    assert.ok((byPeer as any).data.jobs.length >= 1);
    assert.ok((byPeer as any).data.jobs.every((j: any) => j.peer === 'peer-list-a'));

    const byState = await call('GET', '/transport/jobs', undefined, { state: 'active' });
    assert.ok((byState as any).data.jobs.every((j: any) => j.state === 'active'));

    for (const r of releases) r();
    await drain([jobIdA, jobIdB]);
  } finally {
    ka.stop();
  }
});

test('POST /transport/jobs/:id/cancel cancels a still-queued job (per-peer cap forces it to wait)', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const peer = 'peer-cancel';
    const releases: Array<() => void> = [];
    _setExecutorForTest(
      (job, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          releases.push(() => resolve({ bytes: job.size, mode: 'relay', via: null }));
        }),
    );

    const o0 = await call('POST', '/transport/send-file', { peerGatewayId: peer, localPath: localFile, remotePath: 'o0' });
    const o1 = await call('POST', '/transport/send-file', { peerGatewayId: peer, localPath: localFile, remotePath: 'o1' });
    const o2 = await call('POST', '/transport/send-file', { peerGatewayId: peer, localPath: localFile, remotePath: 'o2' }); // queued: per-peer cap is 2
    const jobId0 = (o0 as any).data.jobId;
    const jobId1 = (o1 as any).data.jobId;
    const jobId2 = (o2 as any).data.jobId;
    assert.equal(snapshot().jobs.find((j) => j.jobId === jobId2)?.state, 'queued');

    const cancelled = await call('POST', `/transport/jobs/${jobId2}/cancel`);
    assert.equal((cancelled as any).success, true);
    assert.equal((cancelled as any).data.cancelled, true);

    const status = await call('GET', `/transport/jobs/${jobId2}`);
    assert.equal((status as any).data.state, 'cancelled');

    // cancelling again -> false (already terminal)
    const again = await call('POST', `/transport/jobs/${jobId2}/cancel`);
    assert.equal((again as any).data.cancelled, false);

    for (const r of releases) r();
    await drain([jobId0, jobId1]);
  } finally {
    ka.stop();
  }
});

test('POST /transport/send-file wait:true blocks until the job is done and returns the full JobView', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    _setExecutorForTest(async (job) => {
      await sleep(10);
      return { bytes: job.size, mode: 'relay', via: null };
    });
    const res = await call('POST', '/transport/send-file', {
      peerGatewayId: 'peer-wait-done',
      localPath: localFile,
      remotePath: 'w',
      wait: true,
    });
    assert.equal((res as any).success, true);
    assert.equal((res as any).data.state, 'done');
    assert.equal((res as any).data.bytesDone, 1024);
  } finally {
    ka.stop();
  }
});

test('POST /transport/send-file wait:true still returns {jobId,state} on timeout while the job is active (no dangling wait)', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    const releases: Array<() => void> = [];
    _setExecutorForTest(
      (job) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ bytes: job.size, mode: 'relay', via: null }));
        }),
    );
    const res = await call('POST', '/transport/send-file', {
      peerGatewayId: 'peer-wait-timeout',
      localPath: localFile,
      remotePath: 'z',
      wait: true,
      timeoutMs: 50,
    });
    assert.equal((res as any).success, true, 'a timeout while queued/active is still a success envelope, not an error');
    assert.ok((res as any).data.jobId, 'jobId is present so the caller can still poll/cancel it later');
    assert.equal((res as any).data.state, 'active');

    for (const r of releases) r();
    await drain([(res as any).data.jobId]);
  } finally {
    ka.stop();
  }
});

test('POST /transport/send-file wait:true returns success:false with the job error when it fails terminally', { timeout: 8000 }, async () => {
  const ka = keepAlive();
  try {
    freshStore();
    _setExecutorForTest(async () => {
      throw new Error('synthetic executor failure');
    });
    // maxRetries:1 -> job-manager's maxAttempts:1 -> fails on the first attempt,
    // no backoff-retry wait. Still resolves via waitForJob's poll loop (its
    // first synchronous check always predates the job's async state
    // transition to 'failed' — the executor's rejection only lands on a
    // later microtask), so this needs keepAlive() same as every other
    // waitForJob-driven test: the poll's setTimeout is .unref()'d, and
    // without a ref'd handle standing in, Node's event loop can drain and
    // cancel this test (and any queued after it) before that tick fires.
    const res = await call('POST', '/transport/send-file', {
      peerGatewayId: 'peer-wait-fail',
      localPath: localFile,
      remotePath: 'f',
      wait: true,
      maxRetries: 1,
    });
    assert.equal((res as any).success, false);
    assert.match((res as any).error, /synthetic executor failure/);
  } finally {
    ka.stop();
  }
});

test('GET /transport/queue still works, now backed by the job manager snapshot()', () => {
  const res = call('GET', '/transport/queue');
  return res.then((r: any) => {
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.data.jobs));
    assert.equal(typeof r.data.globalActive, 'number');
  });
});
