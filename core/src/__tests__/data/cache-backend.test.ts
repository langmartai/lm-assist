import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CacheBackend } from '../../data/backends/cache-backend';
import type { DatasetDescriptor, DataRecord } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cache-')); }
function descriptor(id: string): DatasetDescriptor {
  return { id, backend: 'cache', ownerNode: 'n', visibility: 'local-only',
    config: { kind: 'cache' }, acl: [], createdAt: 't', updatedAt: 't' };
}
function rec(id: string, fields: Record<string, unknown>, text?: string): DataRecord {
  return { id, version: 1, fields, text, createdAt: 't', updatedAt: 't' };
}

test('cache backend: put/get round-trip', async () => {
  const be = new CacheBackend(tmp());
  await be.createDataset(descriptor('d1'));
  await be.put('d1', rec('a', { n: 1, name: 'alice' }));
  const got = await be.get('d1', 'a');
  assert.equal(got?.id, 'a');
  assert.equal(got?.fields.name, 'alice');
  assert.equal(await be.get('d1', 'missing'), null);
});

test('cache backend: query filter + limit', async () => {
  const be = new CacheBackend(tmp());
  await be.createDataset(descriptor('d2'));
  await be.put('d2', rec('a', { tag: 'x', n: 1 }));
  await be.put('d2', rec('b', { tag: 'y', n: 2 }));
  await be.put('d2', rec('c', { tag: 'x', n: 3 }));
  const r = await be.query('d2', { filter: [{ field: 'tag', op: 'eq', value: 'x' }] });
  assert.deepEqual(r.records.map((x) => x.id).sort(), ['a', 'c']);
  const lim = await be.query('d2', { limit: 2 });
  assert.equal(lim.records.length, 2);
});

test('cache backend: delete', async () => {
  const be = new CacheBackend(tmp());
  await be.createDataset(descriptor('d3'));
  await be.put('d3', rec('a', {}));
  assert.equal(await be.delete('d3', 'a'), true);
  assert.equal(await be.get('d3', 'a'), null);
  assert.equal(await be.delete('d3', 'a'), false);
});
