import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-vb-'));
import { VectorsBackend } from '../../data/backends/vectors-backend';

test('vectors backend: generic record ops are NOT_SUPPORTED (bulk-managed via admin)', async () => {
  const be = new VectorsBackend();
  await assert.rejects(() => be.get('vectors', 'x'), /NOT_SUPPORTED/);
  await assert.rejects(() => be.put('vectors', { id: 'x', version: 0, fields: {}, createdAt: 't', updatedAt: 't' }), /NOT_SUPPORTED/);
  await assert.rejects(() => be.delete('vectors', 'x'), /NOT_SUPPORTED/);
});

test('vectors backend: admin stats returns counts by type', async () => {
  const be = new VectorsBackend();
  const stats = await be.admin('vectors', 'stats') as any;
  assert.equal(typeof stats.totalVectors, 'number');
  assert.equal(typeof stats.sessionVectors, 'number');
  assert.equal(typeof stats.knowledgeVectors, 'number');
});

test('vectors backend: admin delete-all-by-type delegates (0 on an empty store)', async () => {
  const be = new VectorsBackend();
  const r = await be.admin('vectors', 'delete-all-by-type', { type: 'knowledge' }) as any;
  assert.equal(typeof r.deleted, 'number');
});

test('vectors backend: admin rejects unknown op + bad delete type', async () => {
  const be = new VectorsBackend();
  await assert.rejects(() => be.admin('vectors', 'nope'), /unknown admin op/i);
  await assert.rejects(() => be.admin('vectors', 'delete-all-by-type', { type: 'bogus' }), /type must be/i);
});

test('vectors backend: sync hooks throw', async () => {
  const be = new VectorsBackend();
  await assert.rejects(() => be.exportSince('vectors'), /SYNC_NOT_SUPPORTED/);
});
