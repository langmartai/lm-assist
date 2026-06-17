import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { VectorBackend } from '../../data/backends/vector-backend';
import { fakeEmbed } from './_fake-embed';
import type { DatasetDescriptor, DataRecord } from '../../data/types';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-vec-')); }
function be(dir = tmp()): VectorBackend { return new VectorBackend({ storeDir: dir, embed: fakeEmbed }); }
function descriptor(id: string): DatasetDescriptor {
  return { id, backend: 'vector', ownerNode: 'n', visibility: 'local-only',
    config: { kind: 'vector' }, acl: [], createdAt: 't', updatedAt: 't' };
}

test('vector backend: createDataset then dropDataset', async () => {
  const dir = tmp();
  const b = be(dir);
  await b.createDataset(descriptor('d1'));
  // get on an empty (but existing) table returns null, not a throw
  assert.equal(await b.get('d1', 'missing'), null);
  await b.dropDataset('d1');
  // after drop, get returns null (table gone)
  assert.equal(await b.get('d1', 'missing'), null);
});

test('vector backend: two datasets coexist independently', async () => {
  const b = be();
  await b.createDataset(descriptor('alpha'));
  await b.createDataset(descriptor('beta'));
  assert.equal(await b.get('alpha', 'x'), null);
  assert.equal(await b.get('beta', 'x'), null);
});

test('vector backend: put/get round-trip preserves the full record', async () => {
  const b = be();
  await b.createDataset(descriptor('rt'));
  const rec: DataRecord = {
    id: 'r1', version: 3, fields: { title: 'Hello', n: 42 }, text: 'hello world',
    metadata: { src: 'unit' }, createdAt: 'c', updatedAt: 'u',
  };
  await b.put('rt', rec);
  const got = await b.get('rt', 'r1');
  assert.deepEqual(got, rec); // doc column is the faithful source of truth
});

test('vector backend: re-put same id upserts (no duplicate rows)', async () => {
  const b = be();
  await b.createDataset(descriptor('up'));
  await b.put('up', { id: 'r1', version: 1, fields: { v: 'first' }, text: 'first', createdAt: 'c', updatedAt: 'u1' });
  await b.put('up', { id: 'r1', version: 2, fields: { v: 'second' }, text: 'second', createdAt: 'c', updatedAt: 'u2' });
  const got = await b.get('up', 'r1');
  assert.equal(got?.fields.v, 'second');
  assert.equal(got?.version, 2);
});

test('vector backend: delete removes the record', async () => {
  const b = be();
  await b.createDataset(descriptor('del'));
  await b.put('del', { id: 'r1', version: 1, fields: {}, text: 't', createdAt: 'c', updatedAt: 'u' });
  assert.equal(await b.delete('del', 'r1'), true);
  assert.equal(await b.get('del', 'r1'), null);
  assert.equal(await b.delete('del', 'r1'), false); // already gone
});

test('vector backend: concurrent first writes to a new dataset both land (no create race)', async () => {
  const b = be();
  await Promise.all([
    b.put('race', { id: 'a', version: 1, fields: {}, text: 'a', createdAt: 'c', updatedAt: 'u' }),
    b.put('race', { id: 'b', version: 1, fields: {}, text: 'b', createdAt: 'c', updatedAt: 'u' }),
  ]);
  assert.equal((await b.get('race', 'a'))?.id, 'a');
  assert.equal((await b.get('race', 'b'))?.id, 'b');
});

test('vector backend: query filter + sort + limit', async () => {
  const b = be();
  await b.createDataset(descriptor('q'));
  await b.put('q', { id: 'a', version: 1, fields: { tag: 'x', n: 1 }, text: 'a', createdAt: 'c', updatedAt: 'u' });
  await b.put('q', { id: 'b', version: 1, fields: { tag: 'y', n: 2 }, text: 'b', createdAt: 'c', updatedAt: 'u' });
  await b.put('q', { id: 'c', version: 1, fields: { tag: 'x', n: 3 }, text: 'c', createdAt: 'c', updatedAt: 'u' });
  const filtered = await b.query('q', { filter: [{ field: 'tag', op: 'eq', value: 'x' }] });
  assert.deepEqual(filtered.records.map((r) => r.id).sort(), ['a', 'c']);
  assert.equal(filtered.total, 2);
  const limited = await b.query('q', { sort: [{ field: 'n', dir: 'desc' }], limit: 1 });
  assert.deepEqual(limited.records.map((r) => r.id), ['c']);
  assert.equal(limited.total, 3);
});

test('vector backend: query on a never-created dataset returns empty', async () => {
  const b = be();
  const r = await b.query('nope', {});
  assert.deepEqual(r.records, []);
  assert.equal(r.total, 0);
});

test('vector backend: hybrid search ranks token-overlapping records above unrelated ones', async () => {
  const b = be();
  await b.createDataset(descriptor('s'));
  // SHORT texts (<=3 distinct tokens) on purpose: the token-bag fakeEmbed L2-normalizes,
  // so a single-token query ("fruit") vs a k-token doc has cosine ~= 1/sqrt(k). With k<=3
  // that is >= 0.577 > MIN_SIMILARITY (0.57), so the relevant docs survive the VECTOR path
  // (and FTS also matches them) — the test exercises BOTH RRF inputs, not FTS alone. Longer
  // texts would dilute the cosine below the cutoff and make the test FTS-only and fragile.
  await b.put('s', { id: 'fruit1', version: 1, fields: {}, text: 'fresh fruit', createdAt: 'c', updatedAt: 'u' });
  await b.put('s', { id: 'fruit2', version: 1, fields: {}, text: 'fruit salad', createdAt: 'c', updatedAt: 'u' });
  await b.put('s', { id: 'cat', version: 1, fields: {}, text: 'sleepy cat', createdAt: 'c', updatedAt: 'u' });

  const results = await b.search('s', { query: 'fruit', limit: 3 });
  const ids = results.map((r) => r.id);
  assert.ok(ids[0] === 'fruit1' || ids[0] === 'fruit2', `expected a fruit record first, got ${ids[0]}`);
  // the unrelated 'cat' record must not outrank the fruit records
  assert.ok(ids.indexOf('cat') === -1 || ids.indexOf('cat') > 1, `cat ranked too high: ${ids}`);
  // scores are attached and descending
  assert.equal(typeof results[0].score, 'number');
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score >= results[i].score);
});

test('vector backend: search honors filter and limit', async () => {
  const b = be();
  await b.createDataset(descriptor('sf'));
  await b.put('sf', { id: 'a', version: 1, fields: { kind: 'doc' }, text: 'shared topic alpha', createdAt: 'c', updatedAt: 'u' });
  await b.put('sf', { id: 'b', version: 1, fields: { kind: 'note' }, text: 'shared topic beta', createdAt: 'c', updatedAt: 'u' });
  const filtered = await b.search('sf', { query: 'shared topic', filter: [{ field: 'kind', op: 'eq', value: 'doc' }], limit: 10 });
  assert.deepEqual(filtered.map((r) => r.id), ['a']); // only kind=doc survives the post-filter
  const capped = await b.search('sf', { query: 'shared topic', limit: 1 });
  assert.equal(capped.length, 1);
});

test('vector backend: search on empty/missing dataset returns []', async () => {
  const b = be();
  assert.deepEqual(await b.search('ghost', { query: 'anything' }), []);
});
