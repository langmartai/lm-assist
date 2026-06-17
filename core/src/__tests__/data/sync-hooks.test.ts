import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CacheBackend } from '../../data/backends/cache-backend';
import type { DataRecord, DatasetDescriptor, NodeOrigin } from '../../data/types';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sh-')); }
function d(id: string): DatasetDescriptor {
  return { id, backend: 'cache', ownerNode: 'n', visibility: 'local-only', config: { kind: 'cache' }, acl: [], createdAt: 't', updatedAt: 't' };
}
function rec(id: string, v: number, u: string): DataRecord {
  return { id, version: v, fields: {}, createdAt: 't', updatedAt: u };
}
const ORIGIN: NodeOrigin = { machineId: 'peerA', hostname: 'h', os: 'linux' };

test('exportSince returns records with updatedAt >= since, ascending', async () => {
  const be = new CacheBackend(tmp()); await be.createDataset(d('x'));
  await be.put('x', rec('a', 1, '2026-01-01')); await be.put('x', rec('b', 1, '2026-02-01')); await be.put('x', rec('c', 1, '2026-03-01'));
  const all = await be.exportSince('x'); assert.equal(all.length, 3);
  const since = await be.exportSince('x', '2026-02-01'); assert.deepEqual(since.map(r => r.id), ['b', 'c']);
});

test('importBatch applies only strictly-newer (LWW), stamps origin', async () => {
  const be = new CacheBackend(tmp()); await be.createDataset(d('y'));
  const r1 = await be.importBatch('y', [rec('a', 1, '2026-01-01')], ORIGIN);
  assert.deepEqual(r1, { applied: 1, skipped: 0 });
  const got = await be.get('y', 'a'); assert.equal(got?.origin?.machineId, 'peerA'); // stamped
  const r2 = await be.importBatch('y', [rec('a', 1, '2026-01-01')], ORIGIN); // same version -> skip
  assert.deepEqual(r2, { applied: 0, skipped: 1 });
  const r3 = await be.importBatch('y', [rec('a', 2, '2026-01-01')], ORIGIN); // newer version -> apply
  assert.deepEqual(r3, { applied: 1, skipped: 0 });
  assert.equal((await be.get('y', 'a'))?.version, 2);
});
