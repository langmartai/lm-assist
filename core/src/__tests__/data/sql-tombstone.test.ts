// core/src/__tests__/data/sql-tombstone.test.ts
// Deletion reconciliation on the SQL backend (review fix for 416d00d, finding 1).
//
// The tombstone design stores the delete marker on the record's TOP-LEVEL `deleted`
// flag. The sql backend's schema (recordParams / rowToRecord / SELECT_COLS) must
// round-trip that flag LOSSLESSLY: dropping it turns DataService.del's tombstone
// `{deleted:true, fields:{}}` into a LIVE record with blanked fields — the delete
// reports success, deletes nothing, and the blanking replicates fleet-wide.
//
// Like the other sql suites (sql-backend/sql-worker/sql-route), this file requires
// the better-sqlite3 native bindings; if they are absent the worker rejects every
// op and these tests fail loudly with the "sql backend unavailable" message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Isolated data dir — SqlBackend.indexedFor consults the GLOBAL dataset registry.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sqltomb-'));

import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { SqlBackend } from '../../data/backends/sql-backend';
import { DataService } from '../../data/data-service';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { SyncEngine } from '../../data/sync-engine';
import type { PeerClient, DataRecord } from '../../data/types';

const LOCAL_CTX = { principal: { type: 'local' as const } };

function svcSql(nodeId: string) {
  const datasets = new DatasetRegistry(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sqltomb-r-${nodeId}-`)), 'd.json'),
  );
  const keys = new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), `sqltomb-k-${nodeId}-`)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sqltomb-s-${nodeId}-`));
  const backend = new SqlBackend(dir);
  const backends = new BackendRegistry();
  backends.register(backend);
  const manager = new AccessManager({ datasets, keys, nodeId });
  const service = new DataService({ datasets, backends, manager });
  (service as any).enabledOverride = true;
  return { service, datasets, backends, backend, dir };
}

function mkRecord(id: string, fields: Record<string, unknown> = {}): DataRecord {
  return { id, version: 0, fields, createdAt: '', updatedAt: '' };
}

const NO_PEERS: PeerClient = {
  listPeers: async () => [], manifest: async () => ({ node: '', datasets: [] }),
  exportFrom: async () => [], getFrom: async () => null,
};

// ── 1. The lossless round-trip: DataService.del's exact tombstone shape ────────

test('sql tombstone: the exact del() tombstone shape round-trips with deleted:true', async () => {
  const a = svcSql('SQL1');
  a.datasets.create({ id: 'tickets', backend: 'sql', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'sql' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);

  const now = new Date().toISOString();
  // EXACTLY what DataService.del writes (data-service.ts del()):
  const tombstone: DataRecord = {
    id: 't1', version: 2, fields: {}, deleted: true,
    createdAt: now, updatedAt: now, origin: undefined,
  };
  await a.backend.put('tickets', tombstone);

  const back = await a.backend.get('tickets', 't1');
  assert.ok(back, 'tombstone row exists');
  assert.equal(back!.deleted, true, 'the top-level deleted flag SURVIVES the sql round-trip');
  assert.deepEqual(back!.fields, {}, 'tombstone carries no payload');
  assert.equal(back!.version, 2);

  // A live record must NOT grow a truthy deleted flag from the round-trip.
  await a.backend.put('tickets', { id: 'live1', version: 1, fields: { x: 1 }, createdAt: now, updatedAt: now });
  const live = await a.backend.get('tickets', 'live1');
  assert.ok(live && live.deleted !== true, 'live record round-trips as live');
});

// ── 2. del() on a SYNCED sql dataset actually deletes (and propagates) ─────────

test('sql tombstone: DataService.del hides the record, is idempotent, and exports the tombstone', async () => {
  const a = svcSql('SQL2');
  a.datasets.create({ id: 'tickets', backend: 'sql', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'sql' }, acl: [] });
  await a.backend.createDataset(a.datasets.get('tickets')!);
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r1', { title: 'ghost-to-be' }));
  await a.service.put(LOCAL_CTX, 'tickets', mkRecord('r2', { title: 'keeper' }));

  const del = await a.service.del(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(del.ok && del.value === true, 'delete reports success');

  // Consumer surfaces: gone.
  const got = await a.service.get(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(got.ok && got.value === null, 'get after delete is null');
  const q = await a.service.query(LOCAL_CTX, 'tickets', {});
  assert.ok(q.ok);
  assert.deepEqual(q.value.records.map((r) => r.id), ['r2'], 'query no longer lists r1');

  // Idempotent: a second delete reports false (the tombstone is not a live record).
  const del2 = await a.service.del(LOCAL_CTX, 'tickets', 'r1');
  assert.ok(del2.ok && del2.value === false, 'second delete: false — the record is already gone');

  // Propagation channel: the raw store + exportSince serve the tombstone.
  const raw = await a.backend.get('tickets', 'r1');
  assert.ok(raw && raw.deleted === true, 'raw store holds a real tombstone');
  const exported = await a.backend.exportSince('tickets');
  const exportedT = exported.find((r) => r.id === 'r1');
  assert.ok(exportedT && exportedT.deleted === true, 'exportSince carries deleted:true (the pull channel)');
});

// ── 3. GC purge works on sql ───────────────────────────────────────────────────

test('sql tombstone: age-based GC purges only genuinely old tombstones on a sql dataset', async () => {
  const b = svcSql('SQL3');
  b.datasets.create({ id: 'tickets', backend: 'sql', visibility: 'synced', syncMode: 'full', scope: 'fleet', config: { kind: 'sql' }, acl: [] });
  await b.backend.createDataset(b.datasets.get('tickets')!);

  const now = new Date().toISOString();
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15d > 14d TTL
  await b.backend.put('tickets', { id: 'dead-old', version: 2, fields: {}, deleted: true, createdAt: old, updatedAt: old });
  await b.backend.put('tickets', { id: 'dead-new', version: 2, fields: {}, deleted: true, createdAt: now, updatedAt: now });
  await b.backend.put('tickets', { id: 'alive', version: 1, fields: { title: 'x' }, createdAt: old, updatedAt: old });
  await b.backend.put('tickets', { id: 'shadow', version: 1, fields: { deleted: true }, createdAt: old, updatedAt: old });

  const engine = new SyncEngine({ datasets: b.datasets, backends: b.backends, peers: NO_PEERS, nodeId: 'SQL3' });
  const status = await engine.reconcile();

  assert.equal(status.errors.length, 0, `reconcile clean (got ${JSON.stringify(status.errors)})`);
  assert.equal(status.tombstonesPurged, 1, 'exactly the expired tombstone is purged');
  assert.equal(await b.backend.get('tickets', 'dead-old'), null, 'expired tombstone gone');
  assert.ok(await b.backend.get('tickets', 'dead-new'), 'fresh tombstone retained (still propagating)');
  assert.ok(await b.backend.get('tickets', 'alive'), 'live record untouched');
  assert.ok(await b.backend.get('tickets', 'shadow'), 'live record with fields.deleted=true untouched (shadow hazard)');
});

// ── 4. Existing DBs migrate: pre-tombstone schema gains the column idempotently ─

test('sql tombstone: a DB created by the OLD schema is migrated in place (idempotent ALTER)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltomb-mig-'));
  const file = path.join(dir, 'legacy.sqlite');

  // Build the dataset file EXACTLY as the pre-fix schema did — no `deleted` column.
  // (Direct better-sqlite3 use, main thread: this is fixture setup, not the backend.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE records(
      rowid INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      fields TEXT NOT NULL,
      text TEXT,
      metadata TEXT,
      origin TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(text, content='records', content_rowid='rowid');
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
      INSERT INTO records_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
      INSERT INTO records_fts(records_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
      INSERT INTO records_fts(records_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO records_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  raw.prepare(`INSERT INTO records(id, fields, text, metadata, origin, version, created_at, updated_at)
               VALUES('a', '{"title":"legacy"}', NULL, NULL, NULL, 1, 'c', 'u')`).run();
  raw.close();

  // Open through the backend: the schema migration must add the column without
  // disturbing the existing row, and the tombstone flag must round-trip.
  const b = new SqlBackend(dir);
  const pre = await b.get('legacy', 'a');
  assert.ok(pre, 'legacy row readable after migration');
  assert.equal(pre!.fields.title, 'legacy');
  assert.ok(pre!.deleted !== true, 'legacy row is live');

  const now = new Date().toISOString();
  await b.put('legacy', { id: 'a', version: 2, fields: {}, deleted: true, createdAt: 'c', updatedAt: now });
  const tomb = await b.get('legacy', 'a');
  assert.equal(tomb?.deleted, true, 'tombstone survives on the migrated DB');

  // Re-opening the same file must not re-run (or trip over) the migration.
  const b2 = new SqlBackend(dir);
  const again = await b2.get('legacy', 'a');
  assert.equal(again?.deleted, true, 'second open (migration already applied) still round-trips');
});
