import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClaudeAiCache } from '../claudeai-cache';

function tmpDir(): string {
  const d = path.join(
    os.tmpdir(),
    `claudeai-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('cache miss then hit', async () => {
  const dir = tmpDir();
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 60 });
    assert.equal(await cache.get('uuid-1'), null, 'cold miss');
    const payload = { uuid: 'uuid-1', name: 'Test', chat_messages: [] };
    await cache.set('uuid-1', payload);
    assert.deepEqual(await cache.get('uuid-1'), payload, 'warm hit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cache TTL expiry', async () => {
  const dir = tmpDir();
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 0.01 });
    await cache.set('uuid-2', { uuid: 'uuid-2', name: 'X' });
    await new Promise<void>(r => setTimeout(r, 50));
    assert.equal(await cache.get('uuid-2'), null, 'expired entry returns null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cache index lists ids and metadata', async () => {
  const dir = tmpDir();
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 60 });
    await cache.set('a', { uuid: 'a', name: 'A', updated_at: '2026-05-01T00:00:00Z' });
    await cache.set('b', { uuid: 'b', name: 'B', updated_at: '2026-05-02T00:00:00Z' });
    const idx = await cache.listIndex();
    assert.equal(idx.length, 2, 'two entries in index');
    const a = idx.find(i => i.uuid === 'a');
    assert.equal(a?.name, 'A', 'name preserved');
    assert.equal(a?.updated_at, '2026-05-01T00:00:00Z', 'updated_at preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('eviction sweep removes entries older than evictAfterDays', async () => {
  const dir = tmpDir();
  try {
    // 0.001 days = 86.4 seconds → we fake an old entry by writing the index
    // directly with a past lastSyncedAt, then run sweep with evictAfterDays=0
    // (cutoff = now, so anything set before now is evicted).
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 60, evictAfterDays: 0 });
    await cache.set('old', { uuid: 'old', name: 'O' });
    // evictAfterDays=0 means cutoff = Date.now() − 0ms = now, so any entry
    // whose lastSyncedAt < now qualifies. The set() call above happened in the
    // past (even if just microseconds ago), so it should be swept.
    await new Promise<void>(r => setTimeout(r, 5));
    const removed = await cache.sweep();
    assert.equal(removed, 1, 'one entry removed');
    const idx = await cache.listIndex();
    assert.equal(idx.length, 0, 'index empty after sweep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweep leaves fresh entries untouched', async () => {
  const dir = tmpDir();
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 60, evictAfterDays: 30 });
    await cache.set('fresh', { uuid: 'fresh', name: 'F' });
    const removed = await cache.sweep();
    assert.equal(removed, 0, 'nothing removed');
    const idx = await cache.listIndex();
    assert.equal(idx.length, 1, 'fresh entry remains');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('get returns null when index entry exists but file is missing', async () => {
  const dir = tmpDir();
  try {
    const cache = createClaudeAiCache({ cacheDir: dir, ttlSec: 60 });
    await cache.set('gone', { uuid: 'gone', name: 'G' });
    // Manually delete the data file but leave the index
    fs.unlinkSync(path.join(dir, 'gone.json'));
    assert.equal(await cache.get('gone'), null, 'missing file → null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
