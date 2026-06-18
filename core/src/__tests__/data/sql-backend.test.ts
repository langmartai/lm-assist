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
