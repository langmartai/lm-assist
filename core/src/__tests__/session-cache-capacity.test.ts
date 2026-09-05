/**
 * The session cache must not fill its LMDB map silently.
 *
 * `SessionCacheStore` opens LMDB with a hard `mapSize` of 2 GB and has no eviction, no
 * TTL and no scheduled reclamation — `compactCache()` is a destructive manual wipe, not a
 * background compaction. On 2026-08-19 the prod store measured 608,362,496 bytes growing
 * ~9.5 MB/day, i.e. roughly 160 days of headroom.
 *
 * When LMDB exhausts the map it rejects writes with MDB_MAP_FULL. Every write on the hot
 * path is a background `putSessionData()` from the chokidar-driven update — nobody is
 * watching that promise. So the failure mode was: session summaries and cache updates
 * silently stop while the UI keeps serving stale rows from what is already stored.
 *
 * These tests pin the two things that turn that into a visible condition: the map-full
 * error is RECOGNISED (not confused with an ordinary write failure), and utilisation is
 * REPORTABLE before the cliff rather than only at it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionCacheStore,
  isMapFullError,
  LMDB_MAP_SIZE_BYTES,
} from '../session-cache-store';

/**
 * The sub-db surface `getCapacityStatus()` and the write path actually touch. Kept
 * explicit so that adding a store method which reads the db fails HERE, loudly, instead
 * of silently changing what these tests believe they are exercising.
 */
type StubDb = { put: () => Promise<void>; getCount: () => number };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-session-cache-cap-'));
}

test('isMapFullError recognises the LMDB map-full failure by message', () => {
  assert.strictEqual(isMapFullError(new Error('MDB_MAP_FULL: Environment mapsize limit reached')), true);
  assert.strictEqual(isMapFullError(new Error('mdb_put: MDB_MAP_FULL')), true);
});

test('isMapFullError recognises it by error code', () => {
  const err = Object.assign(new Error('write failed'), { code: 'MDB_MAP_FULL' });
  assert.strictEqual(isMapFullError(err), true);
});

test('isMapFullError does not misclassify ordinary write failures', () => {
  assert.strictEqual(isMapFullError(new Error('ENOSPC: no space left on device')), false);
  assert.strictEqual(isMapFullError(new Error('MDB_BAD_TXN')), false);
  assert.strictEqual(isMapFullError(undefined), false);
  assert.strictEqual(isMapFullError(null), false);
  assert.strictEqual(isMapFullError('MDB_MAP_FULL'), false, 'a bare string is not an Error');
});

test('capacity status reports utilisation against the configured map size', () => {
  const dir = tmpDir();
  const store = new SessionCacheStore(dir);
  try {
    const status = store.getCapacityStatus();

    assert.strictEqual(status.mapSizeBytes, LMDB_MAP_SIZE_BYTES);
    assert.ok(status.dataSizeBytes >= 0, 'data size must be readable');
    assert.ok(
      status.utilisation >= 0 && status.utilisation <= 1,
      `utilisation must be a 0..1 fraction, got ${status.utilisation}`
    );
    assert.strictEqual(status.mapFull, false, 'a fresh store has not hit the map limit');
    // Live data must be reported alongside file size: LMDB reuses freed pages rather
    // than shrinking, so dataSizeBytes stays at the high-water mark after an eviction.
    // Without a count, a flat utilisation reads as "the sweep did nothing" — measured
    // exactly that way on dev, where evicting 7,025 of 8,005 entries left 298 MB.
    assert.strictEqual(status.entryCount, 0, 'a fresh store holds no entries');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a map-full write is recorded as a sticky, reportable condition and still rejects', async () => {
  const dir = tmpDir();
  const store = new SessionCacheStore(dir);
  try {
    // White-box: replace the sub-DB with one that fails the way a full map does. There is
    // no way to exhaust a 2 GB map in a unit test, and the behaviour under test is the
    // store's REACTION to that rejection, not LMDB's own accounting.
    (store as unknown as { sessionsDb: StubDb }).sessionsDb = {
      put: () => Promise.reject(new Error('MDB_MAP_FULL: Environment mapsize limit reached')),
      getCount: () => 0,
    };

    assert.strictEqual(store.getCapacityStatus().mapFull, false, 'precondition: not yet full');

    await assert.rejects(
      () => store.putSessionData('/tmp/whatever.jsonl', {} as never),
      /MDB_MAP_FULL/,
      'the rejection must still propagate — callers that do handle it must keep seeing it'
    );

    const status = store.getCapacityStatus();
    assert.strictEqual(status.mapFull, true, 'the condition must be recorded, not swallowed');
    assert.ok(status.mapFullSince, 'the condition must carry a timestamp for /health');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary write failure does not raise the map-full flag', async () => {
  const dir = tmpDir();
  const store = new SessionCacheStore(dir);
  try {
    (store as unknown as { sessionsDb: StubDb }).sessionsDb = {
      put: () => Promise.reject(new Error('MDB_BAD_TXN: transaction cannot be used')),
      getCount: () => 0,
    };

    await assert.rejects(() => store.putSessionData('/tmp/whatever.jsonl', {} as never), /MDB_BAD_TXN/);

    assert.strictEqual(
      store.getCapacityStatus().mapFull,
      false,
      'only a genuine map-full may raise the capacity alarm'
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
