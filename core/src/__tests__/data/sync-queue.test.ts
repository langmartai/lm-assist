import { test } from 'node:test'; import assert from 'node:assert/strict';
import { SyncQueue } from '../../data/sync-queue';

test('markDirty batches per dataset, dedups; flush snapshots + clears', () => {
  const q = new SyncQueue();
  q.markDirty('d','a'); q.markDirty('d','b'); q.markDirty('d','a'); q.markDirty('e','c');
  assert.equal(q.size(), 3);
  const batches = q.flush().sort((x,y)=>x.dataset<y.dataset?-1:1);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], { dataset:'d', recordIds:['a','b'] });
  assert.deepEqual(batches[1], { dataset:'e', recordIds:['c'] });
  assert.equal(q.size(), 0);
  assert.deepEqual(q.flush(), []); // cleared
});

// NOTE (Task 5 — change-notify): getDataService().put() no longer feeds SyncQueue. Task 5 replaced
// the onLocalWrite -> SyncQueue.markDirty wiring with a direct bus change-notify (notify dep ->
// getBus().publish('data:<dataset>', ...)); see change-notify.test.ts for the new behavior's
// coverage. SyncQueue itself is retired in a later task (the sync-boot.ts flush timer that
// consumed it is removed alongside the new SyncListener) — this file's remaining test covers the
// still-standalone SyncQueue class in the meantime.
