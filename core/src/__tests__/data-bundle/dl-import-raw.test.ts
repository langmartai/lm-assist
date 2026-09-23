// core/src/__tests__/data-bundle/dl-import-raw.test.ts
// DataService.importRaw — the faithful bundle import primitive. Covers the spec's policy
// matrix (merge / add-missing / replace × absent / local-older / local-newer / identical),
// tombstones, the size cap, dry-run purity, batched change-notify, sample capping and the
// local-only + replica refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-imp-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-imp-data-'));

import { DataService, MAX_RECORD_BYTES, planImportRecord } from '../../data/data-service';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import type { DataRecord, ImportOutcome } from '../../data/types';

const LOCAL = { principal: { type: 'local' as const } };

function svc() {
  const datasets = new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-imp-r-')), 'd.json'));
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-imp-k-')));
  const backend = new CacheBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-imp-c-')));
  const backends = new BackendRegistry();
  backends.register(backend);
  const notes: Array<[string, string, string[]]> = [];
  const s = new DataService({
    datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: 'self' }),
    notify: (d, t, ids) => notes.push([d, t, ids]),
  });
  (s as any).enabledOverride = true;
  datasets.create({ id: 'ds', backend: 'cache', visibility: 'cross-node-readable', syncMode: 'full', config: { kind: 'cache' } });
  return { s, datasets, backend, notes };
}

function rec(id: string, version: number, fields: Record<string, unknown>, extra: Partial<DataRecord> = {}): DataRecord {
  return { id, version, fields, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-01-0${Math.min(9, version)}T00:00:00.000Z`, ...extra };
}

async function seed(backend: CacheBackend, records: DataRecord[]): Promise<void> {
  for (const r of records) await backend.put('ds', r);
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

// Local fixture: a=v3 (will be "local older" vs bundle v5), b=v7 (local newer than bundle v2),
// c=v4 identical content+version to bundle, d absent locally.
const LOCAL_STATE = () => [
  rec('a', 3, { t: 'local-a' }),
  rec('b', 7, { t: 'local-b' }),
  rec('c', 4, { t: 'same' }),
];
const BUNDLE = () => [
  rec('a', 5, { t: 'bundle-a' }, { origin: { machineId: 'gw-src', hostname: 'src', os: 'linux' } }),
  rec('b', 2, { t: 'bundle-b' }),
  rec('c', 4, { t: 'same' }),
  rec('d', 1, { t: 'bundle-d' }),
];

test('merge: absent → add verbatim, local older → update verbatim, newer/identical → skip', async () => {
  const { s, backend, notes } = svc();
  await seed(backend, LOCAL_STATE());
  const before = Date.now();
  const out = ok(await s.importRaw(LOCAL, 'ds', BUNDLE(), { policy: 'merge', dryRun: false }));
  assert.equal(out.counts.add, 1);
  assert.equal(out.counts.update, 1);
  assert.equal(out.counts.skipOlder, 1);
  assert.equal(out.counts.skipIdentical, 1);
  assert.deepEqual(out.samples.add, ['d']);
  assert.deepEqual(out.samples.update, ['a']);
  assert.deepEqual(out.samples.skipOlder, ['b']);
  assert.deepEqual(out.samples.skipIdentical, ['c']);
  const a = (await backend.get('ds', 'a'))!;
  assert.equal(a.version, 5, 'verbatim keeps the bundle version');
  // ds is SYNCED: updatedAt is re-stamped to now so the write sorts above every replica's
  // pull watermark (version/createdAt stay verbatim). An unsynced dataset keeps it — below.
  assert.ok(Date.parse(a.updatedAt) >= before - 1000, 'a synced write is stamped updatedAt=now');
  assert.equal(a.origin, undefined, 'the imported record becomes locally owned');
  assert.equal((await backend.get('ds', 'b'))!.fields.t, 'local-b', 'a newer local record is never rolled back');
  const d = (await backend.get('ds', 'd'))!;
  assert.equal(d.version, 1);
  assert.equal(d.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(notes, [['ds', 'changed', ['a', 'd']]], 'ONE batched notify per dataset, written ids only');
});

test('add-missing: only absent records are written; everything present is skipped', async () => {
  const { s, backend } = svc();
  await seed(backend, LOCAL_STATE());
  const out = ok(await s.importRaw(LOCAL, 'ds', BUNDLE(), { policy: 'add-missing', dryRun: false }));
  assert.equal(out.counts.add, 1);
  assert.equal(out.counts.update, 0);
  assert.equal(out.counts.skipExists, 2, 'a (local older) and b (local newer) exist');
  assert.equal(out.counts.skipIdentical, 1);
  assert.equal((await backend.get('ds', 'a'))!.fields.t, 'local-a');
});

test('replace: present-and-different is written AS A NEW VERSION that out-LWWs every replica', async () => {
  const { s, backend } = svc();
  await seed(backend, LOCAL_STATE());
  const before = Date.now();
  const out = ok(await s.importRaw(LOCAL, 'ds', BUNDLE(), { policy: 'replace', dryRun: false }));
  assert.equal(out.counts.add, 1);
  assert.equal(out.counts.update, 2, 'a and b');
  assert.equal(out.counts.skipIdentical, 1, 'identical content is not re-versioned');
  const a = (await backend.get('ds', 'a'))!;
  assert.equal(a.version, 6, 'max(local 3, bundle 5) + 1');
  assert.equal(a.fields.t, 'bundle-a');
  assert.ok(Date.parse(a.updatedAt) >= before - 1000, 'updatedAt = now');
  assert.equal(a.origin, undefined);
  const b = (await backend.get('ds', 'b'))!;
  assert.equal(b.version, 8, 'max(local 7, bundle 2) + 1 — the rollback wins LWW');
  assert.equal(b.fields.t, 'bundle-b');
  assert.equal((await backend.get('ds', 'c'))!.version, 4);
  assert.equal((await backend.get('ds', 'd'))!.version, 1, 'absent ⇒ verbatim, even in replace');
});

test('import NEVER deletes: local records absent from the bundle are untouched', async () => {
  const { s, backend } = svc();
  await seed(backend, [rec('only-local', 1, { x: 1 })]);
  for (const policy of ['merge', 'add-missing', 'replace'] as const) {
    ok(await s.importRaw(LOCAL, 'ds', [rec('z', 1, {})], { policy, dryRun: false }));
    assert.ok(await backend.get('ds', 'only-local'), `${policy} must not remove it`);
  }
});

test('tombstones follow the same rules as live records', async () => {
  const { s, backend } = svc();
  await seed(backend, [rec('live', 2, { v: 1 }), rec('gone', 5, {}, { deleted: true })]);
  const bundle = [
    rec('live', 3, {}, { deleted: true }),   // newer tombstone → merge applies the deletion
    rec('gone', 4, { v: 'old' }),              // older live copy → must NOT resurrect
    rec('fresh-tomb', 1, {}, { deleted: true }),
  ];
  const out = ok(await s.importRaw(LOCAL, 'ds', bundle, { policy: 'merge', dryRun: false }));
  assert.equal(out.counts.update, 1);
  assert.equal(out.counts.skipOlder, 1);
  assert.equal(out.counts.add, 1);
  assert.equal((await backend.get('ds', 'live'))!.deleted, true);
  assert.equal((await backend.get('ds', 'gone'))!.deleted, true, 'the local deletion stands');
  assert.equal((await backend.get('ds', 'fresh-tomb'))!.deleted, true);
  // add-missing: a local tombstone counts as PRESENT — never resurrect a deletion by accident
  const out2 = ok(await s.importRaw(LOCAL, 'ds', [rec('gone', 9, { v: 'x' })], { policy: 'add-missing', dryRun: false }));
  assert.equal(out2.counts.skipExists, 1);
  assert.equal((await backend.get('ds', 'gone'))!.deleted, true);
});

test('identical content = fields/text/metadata/deleted under a canonical compare (key order ignored)', () => {
  const local = rec('x', 3, { a: 1, b: { c: 2, d: [1, 2] } }, { text: 't', metadata: { m: 1 } });
  const incoming = rec('x', 9, { b: { d: [1, 2], c: 2 }, a: 1 }, { text: 't', metadata: { m: 1 } });
  assert.equal(planImportRecord(incoming, local, 'replace', 'now').bucket, 'skipIdentical');
  const differs = { ...incoming, text: 'u' };
  assert.equal(planImportRecord(differs, local, 'replace', 'now').bucket, 'update');
  const tomb = { ...incoming, deleted: true };
  assert.equal(planImportRecord(tomb, local, 'replace', 'now').bucket, 'update', 'deleted participates');
});

test('records over MAX_RECORD_BYTES are skipped as tooLarge (and never written)', async () => {
  const { s, backend } = svc();
  const huge = rec('huge', 1, { blob: 'x'.repeat(MAX_RECORD_BYTES + 10) });
  const out = ok(await s.importRaw(LOCAL, 'ds', [huge, rec('small', 1, {})], { policy: 'merge', dryRun: false }));
  assert.equal(out.counts.tooLarge, 1);
  assert.deepEqual(out.samples.tooLarge, ['huge']);
  assert.equal(await backend.get('ds', 'huge'), null);
  assert.ok(await backend.get('ds', 'small'));
});

test('dry run computes the same outcome and writes NOTHING, notifies nothing', async () => {
  const { s, backend, notes } = svc();
  await seed(backend, LOCAL_STATE());
  const dry = ok(await s.importRaw(LOCAL, 'ds', BUNDLE(), { policy: 'replace', dryRun: true }));
  assert.equal(dry.dryRun, true);
  assert.equal(await backend.get('ds', 'd'), null);
  assert.equal((await backend.get('ds', 'a'))!.version, 3);
  assert.deepEqual(notes, []);
  const real = ok(await s.importRaw(LOCAL, 'ds', BUNDLE(), { policy: 'replace', dryRun: false }));
  assert.deepEqual(dry.counts, real.counts, 'the plan predicts the apply');
});

test('samples are capped at 10 ids per bucket; counts are exact', async () => {
  const { s } = svc();
  const many = Array.from({ length: 25 }, (_, i) => rec(`r${String(i).padStart(2, '0')}`, 1, {}));
  const out: ImportOutcome = ok(await s.importRaw(LOCAL, 'ds', many, { policy: 'merge', dryRun: true }));
  assert.equal(out.counts.add, 25);
  assert.equal(out.samples.add.length, 10);
  assert.equal(out.total, 25);
});

test('malformed records land in the invalid bucket instead of being written', async () => {
  const { s, backend } = svc();
  const bad = [{ id: '', version: 1, fields: {}, createdAt: '', updatedAt: '' }, { id: 'nov', fields: {} }, null] as unknown as DataRecord[];
  const out = ok(await s.importRaw(LOCAL, 'ds', bad, { policy: 'merge', dryRun: false }));
  assert.equal(out.counts.invalid, 3);
  assert.equal(await backend.get('ds', 'nov'), null);
});

test('importRaw is local-principal only, refuses replicas, unknown datasets and bad policies', async () => {
  const { s, datasets } = svc();
  const cloud = await s.importRaw({ principal: { type: 'cloud' } }, 'ds', [], { policy: 'merge', dryRun: true });
  assert.equal(cloud.ok, false); assert.equal((cloud as any).code, 'FORBIDDEN');
  const owner = await s.importRaw({ principal: { type: 'owner' } }, 'ds', [], { policy: 'merge', dryRun: true });
  assert.equal((owner as any).code, 'FORBIDDEN', 'the ROUTE is the owner boundary; the primitive is local-only');
  datasets.upsertReplica({ id: 'rep', backend: 'cache', ownerNode: 'gw-o', syncMode: 'full', config: { kind: 'cache' }, origin: { machineId: 'gw-o', hostname: 'o', os: 'linux' } });
  const rep = await s.importRaw(LOCAL, 'rep', [rec('x', 1, {})], { policy: 'merge', dryRun: true });
  assert.equal((rep as any).code, 'READ_ONLY_REPLICA');
  const missing = await s.importRaw(LOCAL, 'nope', [], { policy: 'merge', dryRun: true });
  assert.equal((missing as any).code, 'NOT_FOUND');
  const badPolicy = await s.importRaw(LOCAL, 'ds', [], { policy: 'yolo' as any, dryRun: true });
  assert.equal((badPolicy as any).code, 'BAD_REQUEST');
});

test('importRaw writes under the SAME per-key lock as put(): a concurrent put is serialized, not lost', async () => {
  const { s, backend } = svc();
  // Fire a put and an import of the same key together; whichever order the lock picks,
  // the final record must be one coherent write (never a torn interleave) and versions
  // must be monotonic: the put reads the import's result or the import sees the put's.
  const bundle = [rec('k', 50, { from: 'bundle' })];
  const [p, i] = await Promise.all([
    s.put(LOCAL, 'ds', { id: 'k', version: 0, fields: { from: 'put' }, createdAt: '', updatedAt: '' }),
    s.importRaw(LOCAL, 'ds', bundle, { policy: 'merge', dryRun: false }),
  ]);
  assert.equal(p.ok, true); assert.equal(i.ok, true);
  const final = (await backend.get('ds', 'k'))!;
  assert.ok(final.version === 50 || final.version === 51, `version ${final.version}`);
  if (final.version === 51) assert.equal(final.fields.from, 'put', 'put ran after the import and bumped it');
  else assert.equal(final.fields.from, 'bundle', 'import ran after the put and won LWW');
});

test('synced vs local-only: updatedAt is stamped now only where replicas pull by watermark', async () => {
  const { s, datasets, backend } = svc();
  datasets.create({ id: 'lo', backend: 'cache', visibility: 'local-only', syncMode: 'none', config: { kind: 'cache' } });
  ok(await s.importRaw(LOCAL, 'lo', [rec('x', 4, { v: 1 })], { policy: 'merge', dryRun: false }));
  const lo = (await backend.get('lo', 'x'))!;
  assert.equal(lo.updatedAt, '2026-01-04T00:00:00.000Z', 'a local-only dataset keeps updatedAt verbatim');
  assert.equal(lo.version, 4);
  const before = Date.now();
  ok(await s.importRaw(LOCAL, 'ds', [rec('x', 4, { v: 1 })], { policy: 'merge', dryRun: false }));
  const ds = (await backend.get('ds', 'x'))!;
  assert.equal(ds.version, 4, 'version stays verbatim');
  assert.equal(ds.createdAt, '2026-01-01T00:00:00.000Z', 'createdAt stays verbatim');
  assert.ok(Date.parse(ds.updatedAt) >= before - 1000);
});

test('an import into a synced dataset reaches a replica that already pulled (watermark pull)', async () => {
  const { s, backend } = svc();
  // The replica already holds r1 @01-10 → its watermark is 01-10.
  await seed(backend, [rec('r1', 1, { v: 1 }, { updatedAt: '2026-01-10T00:00:00.000Z' })]);
  const watermark = '2026-01-10T00:00:00.000Z';
  // Import an OLDER record (01-05) the owner did not have.
  ok(await s.importRaw(LOCAL, 'ds', [rec('r0', 1, { v: 0 }, { updatedAt: '2026-01-05T00:00:00.000Z' })], { policy: 'merge', dryRun: false }));
  const pulled = await backend.exportSince('ds', watermark);
  assert.ok(pulled.some((r) => r.id === 'r0'), 'the replica\'s next watermark pull sees the imported record');
  // Re-applying the same bundle is still a no-op (idempotent).
  const again = ok(await s.importRaw(LOCAL, 'ds', [rec('r0', 1, { v: 0 }, { updatedAt: '2026-01-05T00:00:00.000Z' })], { policy: 'merge', dryRun: false }));
  assert.equal(again.counts.skipIdentical, 1);
});

test('a big import still notifies: the id list is bounded so the bus payload cap never drops it', async () => {
  const { s, notes } = svc();
  const many = Array.from({ length: 600 }, (_, i) => rec(`n${i}`, 1, {}));
  ok(await s.importRaw(LOCAL, 'ds', many, { policy: 'merge', dryRun: false }));
  assert.equal(notes.length, 1, 'one notify');
  assert.deepEqual(notes[0][2], [], 'past MAX_NOTIFY_IDS the notify carries no ids (the listener pulls the whole dataset)');
});

test('a backend write error mid-import stops with partial counts + a notify for what was written', async () => {
  const { s, backend, notes } = svc();
  const realPut = backend.put.bind(backend);
  let n = 0;
  (backend as any).put = async (ds: string, r: DataRecord) => { if (++n === 2) throw new Error('MDB_MAP_FULL'); return realPut(ds, r); };
  const out = ok(await s.importRaw(LOCAL, 'ds', [rec('a', 1, {}), rec('b', 1, {}), rec('c', 1, {})], { policy: 'merge', dryRun: false }));
  assert.equal(out.failed?.code, 'IMPORT_FAILED');
  assert.match(out.failed!.reason, /"b".*MDB_MAP_FULL/);
  assert.equal(out.counts.add, 1, 'only a was written');
  assert.deepEqual(notes, [['ds', 'changed', ['a']]], 'what was written is still change-notified');
});

test('a dataset demoted to a replica mid-import stops the import (owner re-checked under the lock)', async () => {
  const { s, datasets, backend } = svc();
  const realGet = backend.get.bind(backend);
  let demoted = false;
  (backend as any).get = async (ds: string, id: string) => {
    if (id === 'b' && !demoted) { demoted = true; datasets.demoteToReplica('ds', { machineId: 'gw-n', hostname: 'n', os: 'linux' }, 'gw-n'); }
    return realGet(ds, id);
  };
  const out = ok(await s.importRaw(LOCAL, 'ds', [rec('a', 1, {}), rec('b', 1, {}), rec('c', 1, {})], { policy: 'merge', dryRun: false }));
  assert.equal(out.failed?.code, 'READ_ONLY_REPLICA');
  assert.equal(await realGet('ds', 'c'), null, 'nothing is written onto the replica');
  const put = await s.put(LOCAL, 'ds', { id: 'z', version: 0, fields: {}, createdAt: '', updatedAt: '' });
  assert.equal(put.ok, false);
});
