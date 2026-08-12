// core/src/__tests__/data/tombstone-refill.test.ts
// Honest pagination under tombstones (review fix for 416d00d, finding 4).
//
// DataService.query()/search() filter tombstones AFTER the backend pages, so a page
// could come back short — or entirely EMPTY — while live records remain beyond it.
// Callers that page until an empty page then silently stop early and miss data.
// The fix: a BOUNDED refill — keep fetching subsequent backend pages until the
// requested limit is filled or the records run out (hard-capped iterations).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-refill-'));

import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { DataService } from '../../data/data-service';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import type { DataRecord, StorageBackend, SearchSpec } from '../../data/types';

const LOCAL_CTX = { principal: { type: 'local' as const } };

function svc(nodeId: string) {
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), `rf-${nodeId}-`)), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), `rfk-${nodeId}-`)));
  const backend = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), `rfc-${nodeId}-`)));
  const backends = new BackendRegistry();
  backends.register(backend);
  const manager = new AccessManager({ datasets, keys, nodeId });
  const service = new DataService({ datasets, backends, manager });
  (service as any).enabledOverride = true;
  return { service, datasets, backends, backend };
}

function mkRecord(id: string, fields: Record<string, unknown> = {}): DataRecord {
  return { id, version: 0, fields, createdAt: '', updatedAt: '' };
}

test('tombstone refill: a page never comes back empty while live records remain beyond it', async () => {
  const a = svc('RF1');
  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);

  // Cache scan order is id-ascending: the first backend page (limit 2) holds ONLY
  // the two tombstones; the live records sit entirely beyond it.
  for (const id of ['a-t1', 'a-t2', 'z1', 'z2']) {
    await a.service.put(LOCAL_CTX, 'tickets', mkRecord(id, { title: id }));
  }
  await a.service.del(LOCAL_CTX, 'tickets', 'a-t1');
  await a.service.del(LOCAL_CTX, 'tickets', 'a-t2');

  const page = await a.service.query(LOCAL_CTX, 'tickets', { limit: 2 });
  assert.ok(page.ok);
  assert.deepEqual(page.value.records.map((r) => r.id), ['z1', 'z2'],
    'the page is refilled with the live records beyond the tombstones');
  assert.equal(page.value.total, 2, 'total stays honest: live records only');
});

test('tombstone refill: a partially-filled page refills up to the requested limit', async () => {
  const a = svc('RF2');
  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);

  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
    await a.service.put(LOCAL_CTX, 'tickets', mkRecord(id, { title: id }));
  }
  await a.service.del(LOCAL_CTX, 'tickets', 'a2');
  await a.service.del(LOCAL_CTX, 'tickets', 'a3');

  // Backend page 1 = [a1, a2] → one live. Refill must reach a4.
  const page = await a.service.query(LOCAL_CTX, 'tickets', { limit: 2 });
  assert.ok(page.ok);
  assert.deepEqual(page.value.records.map((r) => r.id), ['a1', 'a4'], 'refilled to the requested limit');
  assert.equal(page.value.total, 3, 'total counts live records');

  // And when the records genuinely run out, the page returns short with no spin.
  const tail = await a.service.query(LOCAL_CTX, 'tickets', { limit: 10, offset: 4 });
  assert.ok(tail.ok);
  assert.deepEqual(tail.value.records.map((r) => r.id), ['a5'], 'a short page at the true end stays short');
});

test('tombstone refill: the refill loop is HARD-CAPPED — a pathological tombstone run stops, not spins', async () => {
  const a = svc('RF3');
  a.datasets.create({ id: 'tickets', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);

  // 12 tombstones ahead of the single live record; with limit=1 each refill page
  // holds one tombstone, so the 10-iteration cap trips before reaching 'z9'.
  for (let i = 1; i <= 12; i++) {
    const id = `a${String(i).padStart(2, '0')}`;
    await a.service.put(LOCAL_CTX, 'tickets', mkRecord(id));
    await a.service.del(LOCAL_CTX, 'tickets', id);
  }
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('z9', { title: 'alive' }));

  const capped = await a.service.query(LOCAL_CTX, 'tickets', { limit: 1 });
  assert.ok(capped.ok);
  assert.equal(capped.value.records.length, 0, 'the cap bounds the work — a short page is the honest answer here');

  // A window that covers the run finds the live record in one page.
  const wide = await a.service.query(LOCAL_CTX, 'tickets', { limit: 20 });
  assert.ok(wide.ok);
  assert.deepEqual(wide.value.records.map((r) => r.id), ['z9']);
});

test('tombstone refill: search() refills past filtered tombstones up to the requested limit', async () => {
  // A search-capable fake over a fixed scored corpus (cache has no native search):
  // the top-2 contains a tombstone, so a limit-2 search must refill to reach live2.
  const now = new Date().toISOString();
  const corpus: Array<DataRecord & { score: number }> = [
    { id: 't1', version: 2, fields: {}, deleted: true, createdAt: now, updatedAt: now, score: 0.9 },
    { id: 'live1', version: 1, fields: { title: 'one' }, createdAt: now, updatedAt: now, score: 0.8 },
    { id: 't2', version: 2, fields: {}, deleted: true, createdAt: now, updatedAt: now, score: 0.7 },
    { id: 'live2', version: 1, fields: { title: 'two' }, createdAt: now, updatedAt: now, score: 0.6 },
    { id: 'live3', version: 1, fields: { title: 'three' }, createdAt: now, updatedAt: now, score: 0.5 },
  ];
  const asked: number[] = [];
  const raw = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-RF4-')));
  const searchable: StorageBackend = {
    kind: raw.kind,
    createDataset: (d) => raw.createDataset(d),
    dropDataset: (id) => raw.dropDataset(id),
    put: (ds, r) => raw.put(ds, r),
    get: (ds, id) => raw.get(ds, id),
    delete: (ds, id) => raw.delete(ds, id),
    exportSince: (ds, since) => raw.exportSince(ds, since),
    importBatch: (ds, rs, o) => raw.importBatch(ds, rs, o),
    query: (ds, q) => raw.query(ds, q),
    search: async (_ds: string, s: SearchSpec) => {
      const limit = s.limit ?? 20;
      asked.push(limit);
      return corpus.slice(0, limit);
    },
  };
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-RF4-')), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'rfk-RF4-')));
  const backends = new BackendRegistry();
  backends.register(searchable);
  const manager = new AccessManager({ datasets, keys, nodeId: 'RF4' });
  const service = new DataService({ datasets, backends, manager });
  (service as any).enabledOverride = true;
  datasets.create({ id: 'notes', backend: 'cache', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [] });

  const r = await service.search(LOCAL_CTX, 'notes', { query: 'x', limit: 2 });
  assert.ok(r.ok, `search ok (got ${JSON.stringify(r)})`);
  assert.deepEqual(r.value.map((x) => x.id), ['live1', 'live2'],
    'search refills past the filtered tombstones to fill the requested limit');
  assert.ok(asked.length <= 11, `refill attempts are bounded (got ${asked.length})`);
});
