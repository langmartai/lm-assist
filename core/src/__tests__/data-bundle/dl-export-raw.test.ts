// core/src/__tests__/data-bundle/dl-export-raw.test.ts
// DataService.exportRaw (unredacted, tombstone-inclusive, pages past the backend cap and
// never truncates silently) and createDatasetFromBundle (the rebuilt-origin / new-fleet
// path of the spec's ownership table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-exp-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-exp-data-'));

import { DataService } from '../../data/data-service';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { exportAllRecords } from '../../data/sync-engine';
import { thisNodeId } from '../../data/paths';
import type { DataRecord, DatasetDescriptor, StorageBackend } from '../../data/types';

const LOCAL = { principal: { type: 'local' as const } };

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-exp-r-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-exp-k-')));
  const backend = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-exp-c-')));
  const backends = new BackendRegistry();
  backends.register(backend);
  const s = new DataService({ datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: 'self' }) });
  (s as any).enabledOverride = true;
  return { s, datasets, backend };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

test('exportRaw is UNREDACTED and includes tombstones (unlike exportDataset)', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'ds', backend: 'cache', syncMode: 'full', config: { kind: 'cache' } });
  await s.put(LOCAL, 'ds', { id: 'a', version: 0, fields: { title: 't', apiKey: 'sk-live' }, text: 'sha 0123456789abcdef0123456789abcdef01234567', createdAt: '', updatedAt: '' });
  await s.put(LOCAL, 'ds', { id: 'b', version: 0, fields: {}, createdAt: '', updatedAt: '' });
  await s.del(LOCAL, 'ds', 'b');
  const recs = ok(await s.exportRaw(LOCAL, 'ds'));
  const a = recs.find((r) => r.id === 'a')!;
  assert.equal(a.fields.apiKey, 'sk-live', 'a bundle must round-trip bytes faithfully');
  assert.match(a.text!, /0123456789abcdef0123456789abcdef01234567/);
  assert.equal(recs.find((r) => r.id === 'b')?.deleted, true, 'tombstones travel');
});

test('exportRaw pages past the cache backend scan cap (no silent truncation)', async () => {
  const { s, datasets, backend } = svc();
  datasets.create({ id: 'big', backend: 'cache', config: { kind: 'cache' } });
  for (let i = 0; i < 23; i++) {
    await backend.put('big', { id: `k${String(i).padStart(3, '0')}`, version: 1, fields: { i }, createdAt: 'x', updatedAt: `2026-02-${String((i % 9) + 1).padStart(2, '0')}T00:00:00.000Z` });
  }
  backend.maxScan = 5; // stand-in for the 50k CACHE_MAX_SCAN
  const recs = ok(await s.exportRaw(LOCAL, 'big'));
  assert.equal(recs.length, 23);
  assert.equal(new Set(recs.map((r) => r.id)).size, 23);
  assert.equal(backend.maxScan, 5, 'the cap is restored for every other caller');
});

/** A backend shaped like the sql engine: `ORDER BY updated_at ASC LIMIT cap`, inclusive since. */
function sortedLimitBackend(rows: DataRecord[], cap: number): StorageBackend {
  return {
    kind: 'sql',
    createDataset: async () => {}, dropDataset: async () => {},
    put: async (_d, r) => ({ id: r.id }), get: async () => null,
    query: async () => ({ records: [] }), delete: async () => false,
    importBatch: async () => ({ applied: 0, skipped: 0 }),
    exportSince: async (_d, since) => rows
      .filter((r) => !since || r.updatedAt >= since)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
      .slice(0, cap),
  } as StorageBackend;
}

test('exportAllRecords loops on the updatedAt watermark and de-dupes boundary ties', async () => {
  const rows: DataRecord[] = [];
  for (let i = 0; i < 17; i++) {
    // pairs of equal timestamps so page boundaries land on ties
    rows.push({ id: `r${i}`, version: 1, fields: {}, createdAt: 'x', updatedAt: `2026-03-01T00:00:${String(Math.floor(i / 2)).padStart(2, '0')}.000Z` });
  }
  const r = await exportAllRecords(sortedLimitBackend(rows, 4), 'ds', { pageCap: 4 });
  assert.equal(r.complete, true);
  assert.equal(r.records.length, 17);
  assert.equal(new Set(r.records.map((x) => x.id)).size, 17);
});

test('exportAllRecords reports INCOMPLETE instead of truncating when a page cannot advance', async () => {
  const rows: DataRecord[] = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, version: 1, fields: {}, createdAt: 'x', updatedAt: '2026-03-01T00:00:00.000Z' }));
  const r = await exportAllRecords(sortedLimitBackend(rows, 4), 'ds', { pageCap: 4 });
  assert.equal(r.complete, false);
  assert.match((r as { reason: string }).reason, /share updatedAt|cannot advance/i);
});

test('exportRaw is local-only and refuses unsupported backends', async () => {
  const { s, datasets } = svc();
  datasets.create({ id: 'ds', backend: 'cache', config: { kind: 'cache' } });
  const cloud = await s.exportRaw({ principal: { type: 'cloud' } }, 'ds');
  assert.equal((cloud as any).code, 'FORBIDDEN');
  const peer = await s.exportRaw({ principal: { type: 'peer', node: 'x' } }, 'ds');
  assert.equal((peer as any).code, 'FORBIDDEN');
  assert.equal(((await s.exportRaw(LOCAL, 'nope')) as any).code, 'NOT_FOUND');
  datasets.create({ id: 'logs', backend: 'file', config: { kind: 'file', path: '/tmp/x.log', format: 'log' } });
  assert.equal(((await s.exportRaw(LOCAL, 'logs')) as any).code, 'NOT_SUPPORTED');
});

test('exportRaw serves a replica too (includeReplicas), records verbatim', async () => {
  const { s, datasets, backend } = svc();
  datasets.upsertReplica({ id: 'rep', backend: 'cache', ownerNode: 'gw-o', syncMode: 'full', config: { kind: 'cache' }, origin: { machineId: 'gw-o', hostname: 'o', os: 'linux' } });
  await backend.importBatch('rep', [{ id: 'x', version: 4, fields: { v: 1 }, createdAt: 'c', updatedAt: 'u' }], { machineId: 'gw-o', hostname: 'o', os: 'linux' });
  const recs = ok(await s.exportRaw(LOCAL, 'rep'));
  assert.equal(recs[0].version, 4);
  assert.equal(recs[0].origin?.machineId, 'gw-o');
});

// ── createDatasetFromBundle ─────────────────────────────────────────────────

function bundleDescriptor(over: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    id: 'backlog', backend: 'cache', title: 'Backlog', ownerNode: 'gw-src', visibility: 'synced',
    syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, sensitive: false, readOnly: true,
    acl: [{ principal: 'peer', actions: ['read'] }], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
    ...over,
  };
}

test('createDatasetFromBundle: an OWNED bundle side keeps its visibility/acl; the result is owned here', async () => {
  const { s, datasets } = svc();
  const d = ok(await s.createDatasetFromBundle(LOCAL, bundleDescriptor()));
  assert.equal(d.id, 'backlog');
  assert.equal(d.origin, undefined);
  assert.equal(d.ownerNode, thisNodeId());
  assert.equal(d.visibility, 'synced');
  assert.deepEqual(d.acl, [{ principal: 'peer', actions: ['read'] }]);
  assert.equal(d.scope, 'fleet');
  assert.equal(d.syncMode, 'full');
  assert.equal(d.title, 'Backlog');
  assert.equal(d.readOnly, undefined, 'only the spec\'s allow-listed fields are carried');
  assert.ok(datasets.get('backlog'));
  // storage is allocated: a put works straight away
  assert.equal((await s.put(LOCAL, 'backlog', { id: 'x', version: 0, fields: {}, createdAt: '', updatedAt: '' })).ok, true);
});

test('createDatasetFromBundle: a REPLICA bundle side gets cross-node-readable + empty acl', async () => {
  const { s } = svc();
  const d = ok(await s.createDatasetFromBundle(LOCAL, bundleDescriptor({
    visibility: 'local-only', acl: [], origin: { machineId: 'gw-o', hostname: 'o', os: 'linux' },
  })));
  assert.equal(d.visibility, 'cross-node-readable');
  assert.deepEqual(d.acl, []);
  assert.equal(d.origin, undefined, 'never re-created as a replica');
  const { s: s2 } = svc();
  const d2 = ok(await s2.createDatasetFromBundle(LOCAL, bundleDescriptor({ visibility: 'local-only' }), { replicaOf: { machineId: 'gw-o', hostname: 'o', os: 'linux' } }));
  assert.equal(d2.visibility, 'cross-node-readable', 'the bundle line\'s replicaOf marks it a replica too');
});

test('createDatasetFromBundle refuses non-local callers, system descriptors, derived backends, existing ids', async () => {
  const { s } = svc();
  assert.equal(((await s.createDatasetFromBundle({ principal: { type: 'owner' } }, bundleDescriptor())) as any).code, 'FORBIDDEN');
  assert.equal(((await s.createDatasetFromBundle(LOCAL, bundleDescriptor({ system: true }))) as any).code, 'FORBIDDEN');
  assert.equal(((await s.createDatasetFromBundle(LOCAL, bundleDescriptor({ id: 'kb', backend: 'knowledge', config: { kind: 'knowledge' } }))) as any).code, 'NOT_SUPPORTED');
  ok(await s.createDatasetFromBundle(LOCAL, bundleDescriptor()));
  assert.equal(((await s.createDatasetFromBundle(LOCAL, bundleDescriptor())) as any).code, 'BAD_REQUEST');
});
