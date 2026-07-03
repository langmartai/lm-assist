// core/src/__tests__/data/sync-boot-wiring.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

test('SyncQueue file is retired', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../../data/sync-queue.js')), false);
});

test('sync-boot no longer references the dead dataset_updated push or flushNow', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/data/sync-boot.ts'), 'utf8');
  assert.equal(/dataset_updated|flushNow|getSyncQueue|sendDatasetUpdated/.test(src), false);
  assert.equal(/SyncListener/.test(src), true);
});

test('sync-boot exports start/stop and loads without throwing', async () => {
  const mod = await import('../../data/sync-boot');
  assert.equal(typeof mod.startDataSync, 'function');
  assert.equal(typeof mod.stopDataSync, 'function');
});
