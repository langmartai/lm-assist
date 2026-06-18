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
