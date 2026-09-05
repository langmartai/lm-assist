/**
 * The session cache must evict cold entries, or it grows into its hard 2 GB LMDB map.
 *
 * There is no automatic reclamation today: `compactCache()` is a destructive manual wipe
 * (it clears every sub-DB and deletes data.mdb), so scheduling it would periodically
 * destroy the warm cache and force a lazy re-parse of every session. Per-record eviction
 * is the right tool — LMDB returns freed pages to the map for reuse, so the file need
 * never shrink for the store to stay under its ceiling.
 *
 * Eviction here is unusually safe: this is a cache, not a system of record. The transcript
 * JSONL on disk is the source of truth, and an evicted session re-parses on next access.
 *
 * Keyed on `fileMtime` — the transcript's own mtime — so "cold" means the session itself
 * has not been touched, not merely that we last happened to write the cache entry.
 * Pattern copied from `claudeai-cache.ts` (evictAfterDays + sweep), including its default.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionCacheStore,
  DEFAULT_EVICT_AFTER_DAYS,
} from '../session-cache-store';
import type { SessionCacheData, RawMessagesCache } from '../session-cache';

const DAY_MS = 86_400_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-session-cache-evict-'));
}

/** A cache entry whose transcript was last touched `ageDays` ago. */
function entry(sessionId: string, ageDays: number): SessionCacheData {
  return {
    version: 12,
    sessionId,
    filePath: `/tmp/${sessionId}.jsonl`,
    fileSize: 1024,
    fileMtime: Date.now() - ageDays * DAY_MS,
    lastLineIndex: 0,
    lastTurnIndex: 0,
    createdAt: Date.now() - ageDays * DAY_MS,
    cwd: '/tmp',
    model: 'claude-sonnet-5',
    claudeCodeVersion: '1.0.0',
    permissionMode: 'default',
    tools: [],
    mcpServers: [],
    userPrompts: [],
    toolUses: [],
    responses: [],
  } as unknown as SessionCacheData;
}

function rawEntry(sessionId: string): RawMessagesCache {
  return { version: 1, sessionId, fileSize: 1, fileMtime: 1, lastLineIndex: 0, messages: [] };
}

async function withStore(fn: (s: SessionCacheStore) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const store = new SessionCacheStore(dir);
  try {
    await fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the default retention matches the house pattern (30 days)', () => {
  assert.strictEqual(DEFAULT_EVICT_AFTER_DAYS, 30);
});

test('sweepStale removes entries whose transcript is older than the retention window', async () => {
  await withStore(async (store) => {
    await store.putSessionData('/tmp/cold.jsonl', entry('cold', 45));
    await store.putSessionData('/tmp/older.jsonl', entry('older', 31));

    const removed = await store.sweepStale(30);

    assert.strictEqual(removed, 2, 'both cold entries must be evicted');
    assert.strictEqual(store.getSessionData('/tmp/cold.jsonl'), undefined);
    assert.strictEqual(store.getSessionData('/tmp/older.jsonl'), undefined);
  });
});

test('sweepStale leaves fresh entries untouched', async () => {
  await withStore(async (store) => {
    await store.putSessionData('/tmp/warm.jsonl', entry('warm', 1));
    await store.putSessionData('/tmp/edge.jsonl', entry('edge', 29));

    const removed = await store.sweepStale(30);

    assert.strictEqual(removed, 0, 'nothing inside the window may be evicted');
    assert.ok(store.getSessionData('/tmp/warm.jsonl'), 'a 1-day-old session must survive');
    assert.ok(store.getSessionData('/tmp/edge.jsonl'), 'a 29-day-old session must survive');
  });
});

test('sweepStale evicts the raw-messages entry alongside the session entry', async () => {
  // The raw sub-db is the larger of the two. Evicting only `sessions` would leave the
  // bulk of the bytes behind and quietly defeat the point of the sweep.
  await withStore(async (store) => {
    await store.putSessionData('/tmp/cold.jsonl', entry('cold', 60));
    await store.putRawMessages('/tmp/cold.jsonl', rawEntry('cold'));

    assert.ok(store.getRawMessages('/tmp/cold.jsonl'), 'precondition: raw entry exists');

    await store.sweepStale(30);

    assert.strictEqual(
      store.getRawMessages('/tmp/cold.jsonl'),
      undefined,
      'the raw messages of an evicted session must go with it'
    );
  });
});

test('sweepStale mixes fresh and cold correctly and reports only what it removed', async () => {
  await withStore(async (store) => {
    await store.putSessionData('/tmp/a.jsonl', entry('a', 90));
    await store.putSessionData('/tmp/b.jsonl', entry('b', 2));
    await store.putSessionData('/tmp/c.jsonl', entry('c', 31));
    await store.putSessionData('/tmp/d.jsonl', entry('d', 0));

    const removed = await store.sweepStale(30);

    assert.strictEqual(removed, 2);
    assert.strictEqual(store.sessionCount, 2, 'exactly the two fresh entries remain');
    assert.ok(store.getSessionData('/tmp/b.jsonl'));
    assert.ok(store.getSessionData('/tmp/d.jsonl'));
  });
});

test('sweepStale tolerates an entry with no usable mtime rather than evicting it', async () => {
  // A malformed/legacy entry must not be silently destroyed — losing a cache entry is
  // cheap, but a sweep that treats "unknown age" as "infinitely old" would wipe the store
  // on the first version where the field is renamed.
  await withStore(async (store) => {
    const broken = { ...entry('broken', 1) } as Record<string, unknown>;
    delete broken.fileMtime;
    await store.putSessionData('/tmp/broken.jsonl', broken as unknown as SessionCacheData);

    const removed = await store.sweepStale(30);

    assert.strictEqual(removed, 0);
    assert.ok(store.getSessionData('/tmp/broken.jsonl'), 'unknown age must be kept, not evicted');
  });
});
