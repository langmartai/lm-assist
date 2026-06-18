import { test } from 'node:test'; import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
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

test('getDataService().put enqueues into getSyncQueue()', async () => {
  // Point the data service at a temp dir so it creates a fresh registry
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sq-svc-'));
  process.env.LM_ASSIST_DATA_DIR = tmpDir;

  // Reset singletons so they pick up the new data dir
  const dsModule = await import('../../data/data-service');
  (dsModule as any).instance = null;
  const sqModule = await import('../../data/sync-queue');
  (sqModule as any)._instance = null;

  const { getDataService } = dsModule;
  const { getSyncQueue } = sqModule;

  // Flush any leftover state
  getSyncQueue().flush();

  const svc = getDataService();
  (svc as any).enabledOverride = true;

  // Create a local dataset
  const { getDatasetRegistry } = await import('../../data/dataset-registry');
  (getDatasetRegistry() as any).instance = null;

  // Access internal registry directly to register a dataset
  const reg = (svc as any).deps.datasets;
  reg.create({ id: 'sq-test', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });

  const local = { principal: { type: 'local' as const } };
  const r = await svc.put(local, 'sq-test', { id: 'rec1', version: 0, fields: { x: 1 }, createdAt: '', updatedAt: '' });
  assert.equal(r.ok, true);
  assert.ok(getSyncQueue().size() >= 1, `expected queue size >= 1, got ${getSyncQueue().size()}`);

  // Cleanup
  delete process.env.LM_ASSIST_DATA_DIR;
});
