// core/src/__tests__/data/change-notify.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../../data/data-service';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { getKeyStore } from '../../data/key-store';
import type { DataRecord } from '../../data/types';

function svc(notify: (d: string, t: string, ids: string[]) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
  const datasets = new DatasetRegistry(path.join(dir, 'datasets.json'));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend());
  const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: 'self' });
  const s = new DataService({ datasets, backends, manager, notify: notify as any });
  datasets.create({ id: 'synced', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } });
  datasets.create({ id: 'localonly', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' } }); // syncMode defaults 'none'
  return s;
}
const rec = (id: string): DataRecord => ({ id, version: 0, fields: {}, createdAt: '', updatedAt: '' });
const ctx = { principal: { type: 'local' as const } };

test('put on a syncable dataset publishes a changed notify; del publishes deleted', async () => {
  const calls: Array<[string, string, string[]]> = [];
  const s = svc((d, t, ids) => calls.push([d, t, ids]));
  await s.put(ctx, 'synced', rec('x'));
  await s.del(ctx, 'synced', 'x');
  assert.deepEqual(calls, [['synced', 'changed', ['x']], ['synced', 'deleted', ['x']]]);
});

test('put on a syncMode:none dataset does NOT notify (no bus churn)', async () => {
  const calls: unknown[] = [];
  const s = svc((...a) => calls.push(a));
  await s.put(ctx, 'localonly', rec('y'));
  assert.equal(calls.length, 0);
});

test('a throwing notify (bus disabled) never breaks the write', async () => {
  const s = svc(() => { throw new Error('bus disabled'); });
  const r = await s.put(ctx, 'synced', rec('z'));
  assert.equal(r.ok, true); // put still succeeds
});
