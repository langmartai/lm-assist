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
    waitForJob: (async (jobId: string) => { calls.push('wait:' + jobId); return {} as never; }) as never,
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
