// core/src/__tests__/data/cas-put.test.ts
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

function svc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  const datasets = new DatasetRegistry(path.join(dir, 'datasets.json'));
  const backends = new BackendRegistry();
  backends.register(new CacheBackend(dir));
  const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: 'self' });
  const s = new DataService({ datasets, backends, manager });
  datasets.create({ id: 'cas', backend: 'cache', visibility: 'local-only', config: { kind: 'cache' } });
  return s;
}
const rec = (id: string): DataRecord => ({ id, version: 0, fields: {}, createdAt: '', updatedAt: '' });
const ctx = { principal: { type: 'local' as const } };

test('ifVersion:0 creates when absent; a second ifVersion:0 CONFLICTs', async () => {
  const s = svc();
  const r1 = await s.put(ctx, 'cas', rec('a'), { ifVersion: 0 });
  assert.equal(r1.ok, true);
  const r2 = await s.put(ctx, 'cas', rec('a'), { ifVersion: 0 }); // stored version is now 1
  assert.equal(r2.ok, false);
  assert.equal((r2 as { code: string }).code, 'CONFLICT');
});

test('ifVersion matching the stored version succeeds and bumps the version', async () => {
  const s = svc();
  await s.put(ctx, 'cas', rec('b'));                       // version → 1
  const r = await s.put(ctx, 'cas', rec('b'), { ifVersion: 1 });
  assert.equal(r.ok, true);
});

test('a plain put (no ifVersion) is unaffected by CAS', async () => {
  const s = svc();
  await s.put(ctx, 'cas', rec('c'));
  const r = await s.put(ctx, 'cas', rec('c'));             // no opts → always applies
  assert.equal(r.ok, true);
});

test('N=20 truly concurrent CAS puts to the SAME key: exactly one succeeds, the rest CONFLICT', async () => {
  // Without a per-key lock, put() does read-version -> compare -> write with no serialization:
  // every one of the 20 concurrent calls reads version 0, passes the ifVersion:0 compare, and
  // writes — 20 successes (a silent lost update). The fix must serialize the read-compare-write
  // per key so only the first one through sees version 0; the rest see version 1 and CONFLICT.
  const s = svc();
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, () => s.put(ctx, 'cas', rec('race'), { ifVersion: 0 })),
  );
  const oks = results.filter((r) => r.ok === true);
  const conflicts = results.filter((r) => r.ok === false);
  assert.equal(oks.length, 1, `expected exactly 1 success out of ${N} concurrent CAS puts, got ${oks.length}`);
  assert.equal(conflicts.length, N - 1);
  for (const c of conflicts) assert.equal((c as { code: string }).code, 'CONFLICT');
});

test('concurrent puts to DIFFERENT keys are independent — all succeed (lock is per-key, not global)', async () => {
  const s = svc();
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => s.put(ctx, 'cas', rec(`key-${i}`), { ifVersion: 0 })),
  );
  assert.equal(results.filter((r) => r.ok === true).length, N, 'each key is uncontended, so every put should succeed');
});
