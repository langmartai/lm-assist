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
