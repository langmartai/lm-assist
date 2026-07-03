import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldOffloadToBulk, offloadResponse, fetchBulk, sha256Hex } from '../../fabric/bulk-offload';

test('threshold: only >8MB (default) offloads', () => {
  assert.equal(shouldOffloadToBulk(8 * 1024 * 1024), false);       // == threshold: inline
  assert.equal(shouldOffloadToBulk(8 * 1024 * 1024 + 1), true);
  assert.equal(shouldOffloadToBulk(100, 50), true);
});

test('offloadResponse writes, enqueues a push, waits, and returns a verifiable handle', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const calls: string[] = [];
  const handle = await offloadResponse(bytes, 'gw4-peer', {
    writeOutbox: async (id) => { calls.push('write:' + id); return '/tmp/outbox/' + id + '.bin'; },
    enqueueJob: ((p: { peer: string; sink: { path: string }; size: number }) => { calls.push('enqueue:' + p.peer + ':' + p.sink.path + ':' + p.size); return 'job-1'; }) as never,
    waitForJob: (async (jobId: string) => { calls.push('wait:' + jobId); return { state: 'done' } as never; }) as never,
    genId: () => 'T1',
  });
  assert.equal(handle.transferId, 'T1');
  assert.equal(handle.size, 5);
  assert.equal(handle.sink, 'fabric-bulk/T1.bin');
  assert.equal(handle.sha256, sha256Hex(bytes));
  assert.deepEqual(calls, ['write:T1', 'enqueue:gw4-peer:fabric-bulk/T1.bin:5', 'wait:job-1']);
});

test('fetchBulk verifies size + sha256; a tampered file throws', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const handle = { transferId: 'T2', size: 3, sha256: sha256Hex(bytes), sink: 'fabric-bulk/T2.bin' };
  const got = await fetchBulk(handle, { readSink: async () => bytes });
  assert.deepEqual([...got], [9, 8, 7]);
  await assert.rejects(fetchBulk(handle, { readSink: async () => new Uint8Array([0, 0, 0]) }), /sha256|checksum/i);
  await assert.rejects(fetchBulk(handle, { readSink: async () => new Uint8Array([9, 8]) }), /size/i);
});

// ---------------------------------------------------------------------------
// Task 12 review fix (Important #2): waitForJob (job-manager.ts) NEVER
// rejects — it resolves with a JobView whatever the terminal state, or even
// a non-terminal one if ITS OWN timeout elapses first. offloadResponse used
// to discard that result entirely, so a failed/cancelled/expired/timed-out
// delivery still returned a normal BulkHandle — a false success reported all
// the way up through rpc-server's `{status:200, bulk:true}` reply.
// ---------------------------------------------------------------------------
test('offloadResponse throws (does not report false success) when the job never reaches done', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const terminalFailureStates = ['failed', 'cancelled', 'expired'] as const;
  for (const state of terminalFailureStates) {
    await assert.rejects(
      offloadResponse(bytes, 'gw4-peer', {
        writeOutbox: async (id) => '/tmp/outbox/' + id + '.bin',
        enqueueJob: (() => `job-${state}`) as never,
        waitForJob: (async () => ({ state })) as never,
        genId: () => 'T-' + state,
      }),
      new RegExp(`job-${state}.*state=${state}`, 'i'),
      `state=${state} must throw and name the job + state`,
    );
  }
});

test('offloadResponse throws when waitForJob times out on a still non-terminal job (e.g. active/retry-wait), not just on an explicit failure state', async () => {
  const bytes = new Uint8Array([4, 5]);
  await assert.rejects(
    offloadResponse(bytes, 'gw4-peer', {
      writeOutbox: async (id) => '/tmp/outbox/' + id + '.bin',
      enqueueJob: (() => 'job-stuck') as never,
      // waitForJob's own internal deadline can elapse while the job is still
      // 'active'/'retry-wait' (non-terminal) — it resolves (does not reject)
      // with that in-progress view. offloadResponse must not treat this as success.
      waitForJob: (async () => ({ state: 'active' })) as never,
      genId: () => 'T-stuck',
      timeoutMs: 10,
    }),
    /job-stuck/i,
  );
});
