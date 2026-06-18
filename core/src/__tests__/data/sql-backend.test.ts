import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SqlBackend } from '../../data/backends/sql-backend';
import type { DatasetDescriptor } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sql-')); }
function be(dir = tmp()): SqlBackend { return new SqlBackend(dir); }
function descriptor(id: string, indexedFields?: Array<{ path: string; type: 'text' | 'number' }>): DatasetDescriptor {
  return { id, backend: 'sql', ownerNode: 'n', visibility: 'local-only',
    config: { kind: 'sql', ...(indexedFields ? { indexedFields } : {}) }, acl: [], createdAt: 't', updatedAt: 't' };
}

test('sql backend: createDataset builds a usable db (FTS), get on empty → null, dropDataset removes the file', async () => {
  const dir = tmp();
  const b = be(dir);
  await b.createDataset(descriptor('d1', [{ path: 'topic', type: 'text' }]));
  assert.ok(fs.existsSync(path.join(dir, 'd1.sqlite')));
  assert.equal(await b.get('d1', 'missing'), null);
  await b.dropDataset('d1');
  assert.ok(!fs.existsSync(path.join(dir, 'd1.sqlite')));
});

test('sql backend: config-less replica (no indexedFields) still creates a valid table', async () => {
  const b = be();
  await b.createDataset(descriptor('repl')); // no indexedFields
  assert.equal(await b.get('repl', 'x'), null); // table exists, query path works
});

function rec(id: string, fields: Record<string, unknown>, text?: string, version = 1): import('../../data/types').DataRecord {
  return { id, version, fields, text, createdAt: 'c', updatedAt: 'u', metadata: { src: 'unit' } } as import('../../data/types').DataRecord;
}

test('sql backend: put/get round-trip preserves the full record; re-put upserts (one row)', async () => {
  const b = be();
  await b.createDataset(descriptor('rt'));
  await b.put('rt', rec('a', { title: 'Hello', n: 42 }, 'body text', 3));
  const got = await b.get('rt', 'a');
  assert.equal(got?.fields.title, 'Hello');
  assert.equal(got?.fields.n, 42);
  assert.equal(got?.version, 3);
  assert.equal(got?.text, 'body text');
  assert.equal((got?.metadata as any)?.src, 'unit');
  await b.put('rt', rec('a', { title: 'Renamed' }, 'body text', 4));
  const after = await b.get('rt', 'a');
  assert.equal(after?.fields.title, 'Renamed');
  assert.equal(after?.version, 4);
});

test('sql backend: delete removes the record (and its FTS row)', async () => {
  const b = be();
  await b.createDataset(descriptor('del'));
  await b.put('del', rec('a', {}, 'find me unique-token'));
  assert.equal(await b.delete('del', 'a'), true);
  assert.equal(await b.get('del', 'a'), null);
  assert.equal(await b.delete('del', 'a'), false);
});

test('sql backend: query filter + sort + limit + total + fts', async () => {
  const b = be();
  await b.createDataset(descriptor('q', [{ path: 'topic', type: 'text' }]));
  await b.put('q', rec('a', { topic: 'astro', n: 1 }, 'telescope galaxies'));
  await b.put('q', rec('b', { topic: 'cook', n: 2 }, 'tomato sauce'));
  await b.put('q', rec('c', { topic: 'astro', n: 3 }, 'exoplanet orbit'));
  const f = await b.query('q', { filter: [{ field: 'topic', op: 'eq', value: 'astro' }] });
  assert.deepEqual(f.records.map((r) => r.id).sort(), ['a', 'c']);
  assert.equal(f.total, 2);
  const sorted = await b.query('q', { sort: [{ field: 'n', dir: 'desc' }], limit: 1 });
  assert.deepEqual(sorted.records.map((r) => r.id), ['c']);
  assert.equal(sorted.total, 3);
  const fts = await b.query('q', { fts: 'galaxies' });
  assert.deepEqual(fts.records.map((r) => r.id), ['a']);
});

import type { NodeOrigin } from '../../data/types';
const ORIGIN: NodeOrigin = { machineId: 'remote1', hostname: 'r1', os: 'linux' };

test('sql backend: exportSince watermark (ascending) + importBatch LWW + origin stamp', async () => {
  const b = be();
  await b.createDataset(descriptor('s'));
  await b.put('s', { id: 'a', version: 1, fields: {}, text: 'a', createdAt: 'c', updatedAt: '2026-01-01T00:00:00Z' });
  await b.put('s', { id: 'b', version: 1, fields: {}, text: 'b', createdAt: 'c', updatedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual((await b.exportSince('s')).map((r) => r.id), ['a', 'b']);
  assert.deepEqual((await b.exportSince('s', '2026-01-15T00:00:00Z')).map((r) => r.id), ['b']);

  await b.put('s', { id: 'a', version: 2, fields: { v: 'local' }, text: 'a', createdAt: 'c', updatedAt: 'u2' });
  const res = await b.importBatch('s', [
    { id: 'a', version: 1, fields: { v: 'old' }, text: 'a', createdAt: 'c', updatedAt: 'u1' },   // older → skip
    { id: 'z', version: 3, fields: { v: 'new' }, text: 'z', createdAt: 'c', updatedAt: 'u3' },   // new → apply
  ], ORIGIN);
  assert.equal(res.applied, 1);
  assert.equal(res.skipped, 1);
  assert.equal((await b.get('s', 'a'))?.fields.v, 'local'); // local v2 preserved
  const z = await b.get('s', 'z');
  assert.equal(z?.fields.v, 'new');
  assert.deepEqual(z?.origin, ORIGIN);                      // origin stamped on the replica
});

test('sql backend: admin stats + integrity-check', async () => {
  const b = be();
  await b.createDataset(descriptor('adm'));
  await b.put('adm', { id: 'a', version: 1, fields: {}, createdAt: 'c', updatedAt: 'u' });
  const stats = await b.admin!('adm', 'stats') as any;
  assert.equal(stats.count, 1);
  const ic = await b.admin!('adm', 'integrity-check') as any;
  assert.equal(ic.ok, true);
  const v = await b.admin!('adm', 'vacuum') as any;
  assert.equal(v.ok, true);
  await assert.rejects(() => b.admin!('adm', 'nope'), /unknown admin op/i);
});
