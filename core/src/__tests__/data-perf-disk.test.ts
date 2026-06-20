import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CacheBackend } from '../data/backends/cache-backend';
import { KeyStore } from '../data/key-store';
import { recordTooLarge, MAX_RECORD_BYTES } from '../data/data-service';
import { detectType } from '../mcp-server/tools/data-tools-format';
import type { DataRecord } from '../data/types';

/**
 * Performance + disk-consumption hardening (2026-06-20) — the data service runs
 * inside the single-threaded :3100 server, so unbounded sync work or unbounded
 * disk growth from one caller degrades every tenant. Fixes from the perf/disk review.
 */

let counter = 0;
function tmp(name: string): string {
  const d = path.join(os.tmpdir(), `lmtest-${name}-${process.pid}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const rec = (id: string, n: number): DataRecord =>
  ({ id, version: 1, fields: { n, name: 'r' + id }, createdAt: '2026-01-01', updatedAt: `2026-01-${String((n % 28) + 1).padStart(2, '0')}` });

// ---- C1-A: bounded cache query ----

test('cache query streams a page with an exact total (no full materialization)', async () => {
  const b = new CacheBackend(tmp('cacheq'));
  await b.createDataset({ id: 'd', backend: 'cache' } as any);
  for (let i = 0; i < 10; i++) await b.put('d', rec(String(i), i));
  const r = await b.query('d', { limit: 3, offset: 2 });
  assert.equal(r.records.length, 3);
  assert.equal(r.total, 10);
  await b.dropDataset('d');
});

test('cache query bounds the scan at maxScan and flags scanTruncated', async () => {
  const b = new CacheBackend(tmp('cachecap'));
  b.maxScan = 4;
  await b.createDataset({ id: 'd', backend: 'cache' } as any);
  for (let i = 0; i < 12; i++) await b.put('d', rec(String(i), i));
  const r: any = await b.query('d', {});
  assert.equal(r.scanTruncated, true);
  assert.ok(r.records.length <= 4, `scan should be capped, got ${r.records.length}`);
  await b.dropDataset('d');
});

test('cache query filter still works under streaming', async () => {
  const b = new CacheBackend(tmp('cachefilter'));
  await b.createDataset({ id: 'd', backend: 'cache' } as any);
  for (let i = 0; i < 6; i++) await b.put('d', rec(String(i), i));
  const r = await b.query('d', { filter: [{ field: 'n', op: 'gte', value: 4 }] });
  assert.deepEqual(r.records.map((x) => x.fields.n).sort(), [4, 5]);
  assert.equal(r.total, 2);
  await b.dropDataset('d');
});

// ---- C2-C: cache dropDataset removes the orphaned -lock file ----

test('cache dropDataset removes the orphaned <id>.lmdb-lock sibling', async () => {
  const dir = tmp('cachelock');
  const b = new CacheBackend(dir);
  await b.createDataset({ id: 'd', backend: 'cache' } as any);
  await b.put('d', rec('1', 1));
  await b.dropDataset('d');
  assert.equal(fs.existsSync(path.join(dir, 'd.lmdb')), false, '.lmdb dir should be gone');
  assert.equal(fs.existsSync(path.join(dir, 'd.lmdb-lock')), false, '.lmdb-lock should be gone');
});

// ---- C2-A: audit log ring-buffer ----

test('KeyStore audit log is ring-buffer trimmed (bounded growth, no 256MB cliff)', async () => {
  const ks = new KeyStore(tmp('keys'), { maxAudit: 10, auditTrimEvery: 5 });
  for (let i = 0; i < 80; i++) {
    await ks.appendAudit({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(), event: 'use', principalType: 'cloud' });
  }
  const n = ks.listAudit().length;
  assert.ok(n <= 15, `audit must stay near maxAudit=10, got ${n}`);
  ks.close();
});

// ---- C2-D: per-record size cap ----

test('recordTooLarge rejects an oversized record, accepts a normal one', () => {
  assert.equal(recordTooLarge(rec('1', 1)), undefined);
  const big: DataRecord = { id: 'big', version: 1, fields: { blob: 'x'.repeat(MAX_RECORD_BYTES + 10) }, createdAt: '', updatedAt: '' };
  assert.ok(typeof recordTooLarge(big) === 'string');
});

// ---- C1-D: bounded content scan ----

test('detectType stays fast on a multi-MB value (scan is capped, not O(content))', () => {
  const huge = 'lorem ipsum '.repeat(500000); // ~6MB of text
  const t0 = Date.now();
  const d = detectType(huge);
  assert.ok(Date.now() - t0 < 100, 'detectType must not scan the whole multi-MB value');
  assert.equal(d.type, 'text');
});
