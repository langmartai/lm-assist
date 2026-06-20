import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SqlBackend } from '../../data/backends/sql-backend';
import type { DatasetDescriptor, DataRecord } from '../../data/types';

/**
 * The sql backend is now a worker-thread proxy (sql-backend.ts → sql-worker.ts →
 * sql-engine.ts) so better-sqlite3's synchronous native calls never block the shared
 * :3100 event loop. These guard the proxy's RPC: reply correlation under concurrency,
 * and that the main thread keeps running while calls are in flight.
 */

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sqlw-')); }
const descriptor = (id: string): DatasetDescriptor =>
  ({ id, backend: 'sql', ownerNode: 'n', visibility: 'local-only', config: { kind: 'sql' }, acl: [], createdAt: 't', updatedAt: 't' });
const rec = (id: string, n: number): DataRecord => ({ id, version: 1, fields: { n }, createdAt: 'c', updatedAt: 'u' });

test('proxy correlates concurrent replies to the right caller (id map)', async () => {
  const b = new SqlBackend(tmp());
  await b.createDataset(descriptor('cc'));
  for (let i = 0; i < 20; i++) await b.put('cc', rec('r' + i, i));
  // 20 different gets in flight at once — each must resolve to ITS OWN record, never a crossed wire.
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => b.get('cc', 'r' + i)));
  for (let i = 0; i < 20; i++) assert.equal(results[i]?.fields.n, i, `reply ${i} mismatched`);
});

test('main thread keeps running while sql calls are in flight (off-thread)', async () => {
  const b = new SqlBackend(tmp());
  await b.createDataset(descriptor('nb'));
  for (let i = 0; i < 50; i++) await b.put('nb', rec('r' + i, i));
  let mainTicks = 0;
  const timer = setInterval(() => { mainTicks++; }, 1);
  await Promise.all(Array.from({ length: 10 }, () => b.query('nb', { filter: [{ field: 'n', op: 'gte', value: 0 }] })));
  clearInterval(timer);
  assert.ok(mainTicks > 0, 'main-thread timer advanced during SQL work — the loop was not frozen');
});

test('a worker error rejects the specific call, not the process', async () => {
  const b = new SqlBackend(tmp());
  await b.createDataset(descriptor('err'));
  await assert.rejects(() => (b as any).admin('err', 'bogus-op'), /unknown admin op/i);
  // proxy still usable after a rejected call
  assert.equal(await b.get('err', 'nope'), null);
});
