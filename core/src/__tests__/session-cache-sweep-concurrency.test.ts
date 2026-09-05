/**
 * `sweepStale()` running against a store that the watcher is CONCURRENTLY writing.
 *
 * This is the one thing the capacity/eviction work never exercised. The claim being
 * tested is an assumption, not a result: "deletes and puts are separate LMDB
 * transactions, so it should be safe." In production the sweep does not run against a
 * quiet store — it fires 60s after boot and every 24h thereafter, while the chokidar
 * watcher is issuing background `putSessionData`/`putRawMessages` calls that nobody
 * awaits, at thousands per day.
 *
 * Two distinct questions, deliberately separated:
 *
 *  1. INTEGRITY — can concurrent puts and sweep deletes corrupt the store, reject, or
 *     leave it unreadable? (Answer below: no.)
 *
 *  2. SELECTION — `sweepStale` collects the stale key set synchronously, then awaits one
 *     delete per key. The collect phase is a single tick and cannot interleave; the
 *     DELETE phase yields between every key. So a session that was cold when collected
 *     can be resumed and re-cached by the watcher before its delete lands, and the sweep
 *     will then delete an entry that is no longer stale. That is a real window, and it is
 *     measured here rather than assumed away.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionCacheStore } from '../session-cache-store';
import type { SessionCacheData, RawMessagesCache } from '../session-cache';

const DAY_MS = 86_400_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-session-cache-conc-'));
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

function rawEntry(sessionId: string, messages = 1): RawMessagesCache {
  return {
    version: 1,
    sessionId,
    fileSize: 1,
    fileMtime: 1,
    lastLineIndex: 0,
    // Give the raw sub-db some real bytes — this is the db that actually grows.
    messages: Array.from({ length: messages }, (_, i) => ({ i, text: 'x'.repeat(256) })),
  } as unknown as RawMessagesCache;
}

async function withStore(fn: (s: SessionCacheStore, dir: string) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const store = new SessionCacheStore(dir);
  try {
    await fn(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Key ordering is lexicographic in LMDB, so this pads to keep seed order predictable. */
const coldKey = (i: number) => `/tmp/s${String(i).padStart(4, '0')}.jsonl`;

test('sweepStale survives the watcher writing at volume underneath it', async () => {
  await withStore(async (store) => {
    const COLD = 300;
    const FRESH = 100;
    const CONCURRENT_WRITES = 400;

    // Seed: cold entries that must go, fresh entries that must stay.
    for (let i = 0; i < COLD; i++) {
      await store.putSessionData(coldKey(i), entry(`cold${i}`, 45));
      await store.putRawMessages(coldKey(i), rawEntry(`cold${i}`, 4));
    }
    for (let i = 0; i < FRESH; i++) {
      await store.putSessionData(`/tmp/warm${String(i).padStart(4, '0')}.jsonl`, entry(`warm${i}`, 1));
    }
    assert.strictEqual(store.sessionCount, COLD + FRESH, 'precondition: everything seeded');

    // Start the sweep, then hammer the store the way the watcher does: fire-and-forget
    // writes to NEW keys, interleaved with the sweep's delete loop.
    const sweep = store.sweepStale(30);

    const writeErrors: unknown[] = [];
    const writes: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENT_WRITES; i++) {
      const key = `/tmp/live${String(i).padStart(4, '0')}.jsonl`;
      writes.push(store.putSessionData(key, entry(`live${i}`, 0)).catch((e) => { writeErrors.push(e); }));
      writes.push(store.putRawMessages(key, rawEntry(`live${i}`, 2)).catch((e) => { writeErrors.push(e); }));
      // Yield periodically so the writes genuinely interleave with the delete loop
      // instead of all queueing behind it in one tick.
      if (i % 25 === 0) await new Promise((r) => setImmediate(r));
    }

    const removed = await sweep;
    await Promise.all(writes);

    assert.deepStrictEqual(writeErrors, [], 'no concurrent write may reject while a sweep runs');
    assert.strictEqual(removed, COLD, 'every seeded cold entry is evicted despite the write load');

    // Nothing the watcher wrote during the sweep may be lost.
    for (let i = 0; i < CONCURRENT_WRITES; i++) {
      const key = `/tmp/live${String(i).padStart(4, '0')}.jsonl`;
      assert.ok(store.getSessionData(key), `concurrent write ${key} must survive the sweep`);
      assert.ok(store.getRawMessages(key), `concurrent raw write ${key} must survive the sweep`);
    }
    // Nor may any pre-existing fresh entry be collateral damage.
    for (let i = 0; i < FRESH; i++) {
      assert.ok(
        store.getSessionData(`/tmp/warm${String(i).padStart(4, '0')}.jsonl`),
        `fresh entry warm${i} must survive`
      );
    }
    assert.strictEqual(
      store.sessionCount,
      FRESH + CONCURRENT_WRITES,
      'final count is exactly fresh + concurrently-written'
    );
    assert.strictEqual(store.getCapacityStatus().mapFull, false, 'no capacity alarm from the load');
  });
});

test('a store swept under concurrent write load is intact when reopened from disk', async () => {
  // getRange reads through the same process-local env, so an in-process assertion could
  // pass on state that never durably committed. Reopen and re-read to prove otherwise.
  const dir = tmpDir();
  try {
    const store = new SessionCacheStore(dir);
    for (let i = 0; i < 120; i++) {
      await store.putSessionData(coldKey(i), entry(`cold${i}`, 60));
      await store.putRawMessages(coldKey(i), rawEntry(`cold${i}`, 3));
    }

    const sweep = store.sweepStale(30);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 120; i++) {
      writes.push(store.putSessionData(`/tmp/new${String(i).padStart(4, '0')}.jsonl`, entry(`new${i}`, 0)));
      if (i % 20 === 0) await new Promise((r) => setImmediate(r));
    }
    const removed = await sweep;
    await Promise.all(writes);
    assert.strictEqual(removed, 120);
    store.close();

    const reopened = new SessionCacheStore(dir);
    try {
      assert.strictEqual(reopened.sessionCount, 120, 'exactly the 120 concurrent writes persisted');
      assert.strictEqual(reopened.rawCount, 0, 'the raw entries of evicted sessions are gone from disk');
      for (let i = 0; i < 120; i++) {
        assert.strictEqual(reopened.getSessionData(coldKey(i)), undefined, 'evicted stays evicted');
        const kept = reopened.getSessionData(`/tmp/new${String(i).padStart(4, '0')}.jsonl`);
        assert.ok(kept, `new${i} must be readable after reopen`);
        assert.strictEqual(kept!.sessionId, `new${i}`, 'value must be intact, not torn');
      }
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reads stay serviceable and correct throughout a sweep', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 200; i++) {
      await store.putSessionData(coldKey(i), entry(`cold${i}`, 45));
    }
    await store.putSessionData('/tmp/warm.jsonl', entry('warm', 1));

    const sweep = store.sweepStale(30);

    // A reader (an API request) hitting the store mid-sweep must never throw and must
    // never see a torn value for an entry that is not being evicted.
    let reads = 0;
    const readErrors: unknown[] = [];
    const reader = setInterval(() => {
      try {
        const v = store.getSessionData('/tmp/warm.jsonl');
        assert.strictEqual(v?.sessionId, 'warm');
        reads++;
      } catch (e) { readErrors.push(e); }
    }, 1);

    await sweep;
    clearInterval(reader);

    assert.deepStrictEqual(readErrors, [], 'no read may fail during a sweep');
    assert.ok(reads > 0, 'precondition: the reader actually ran during the sweep');
    assert.ok(store.getSessionData('/tmp/warm.jsonl'), 'the read-hot entry survives');
  });
});

test('an entry resumed mid-sweep is still evicted — the collect/delete window is real', async () => {
  // MEASURED, not assumed. `sweepStale` decides the whole stale set in one synchronous
  // pass, then yields between each delete. A session that goes from cold to warm inside
  // that window is deleted on a decision that is already out of date.
  //
  // The target key sorts LAST, so its delete is the last one in the loop — which makes
  // the window deterministic here rather than a flake. In production the window is real
  // but narrow, and the consequence is bounded: the entry re-parses from its JSONL on
  // next access. This test pins the CURRENT behaviour so a future change to it is a
  // deliberate decision and not a silent one.
  await withStore(async (store) => {
    for (let i = 0; i < 200; i++) {
      await store.putSessionData(coldKey(i), entry(`cold${i}`, 45));
    }
    const TARGET = '/tmp/zzz-resumed.jsonl';
    await store.putSessionData(TARGET, entry('resumed', 45)); // cold at collect time

    const sweep = store.sweepStale(30);

    // The watcher observes the session being resumed and re-caches it as fresh, after
    // the sweep has already made its decision.
    await new Promise((r) => setImmediate(r));
    await store.putSessionData(TARGET, entry('resumed', 0)); // now fresh

    const removed = await sweep;

    // Measured, 10/10 runs: the re-cache loses. The sweep deletes the entry it decided
    // about, not the entry that is now there. The loss is bounded — a cache miss and a
    // re-parse from the transcript on next access, which is exactly what eviction costs
    // anyway — so this is pinned as CURRENT behaviour, not asserted as desirable. If a
    // later change makes the delete re-check freshness, this expectation should flip
    // deliberately.
    assert.strictEqual(
      store.getSessionData(TARGET),
      undefined,
      'a session re-cached after the collect phase is still evicted by the pending delete'
    );
    assert.strictEqual(removed, 201, 'the sweep reports the set it decided on, including the target');

    // The invariant that actually matters: the store stays consistent and the cold set
    // is gone. No corruption, no survivor from the genuinely cold range.
    assert.strictEqual(store.getSessionData(coldKey(0)), undefined);
    assert.strictEqual(store.getSessionData(coldKey(199)), undefined);
    assert.strictEqual(store.sessionCount, 0, 'no entry other than the contested one existed');
  });
});

test('two sweeps overlapping do not double-count or corrupt', async () => {
  // The 24h interval and the 60s initial sweep are independent timers; a slow sweep can
  // in principle still be running when another fires. Neither may throw.
  await withStore(async (store) => {
    for (let i = 0; i < 150; i++) {
      await store.putSessionData(coldKey(i), entry(`cold${i}`, 45));
      await store.putRawMessages(coldKey(i), rawEntry(`cold${i}`, 2));
    }
    await store.putSessionData('/tmp/warm.jsonl', entry('warm', 1));

    const [a, b] = await Promise.all([store.sweepStale(30), store.sweepStale(30)]);

    // Both passes see the same stale set (the collect phase of the second runs before the
    // first has deleted anything it awaits), so the counts are reports of intent, not of
    // unique deletions. What must hold is the end state.
    assert.ok(a >= 0 && b >= 0);
    assert.strictEqual(store.sessionCount, 1, 'only the fresh entry remains');
    assert.ok(store.getSessionData('/tmp/warm.jsonl'), 'the fresh entry survives both sweeps');
    assert.strictEqual(store.rawCount, 0, 'raw entries all evicted, no leftovers');
    assert.strictEqual(store.getCapacityStatus().mapFull, false);
  });
});
