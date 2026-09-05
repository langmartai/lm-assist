/**
 * Session Cache Store — LMDB-backed storage adapter
 *
 * Replaces the old Memory Map + .cache.gz disk files with a single
 * memory-mapped LMDB database. Reads are synchronous and instant
 * (served directly from mmap'd pages by the OS), writes are async
 * and auto-batched by lmdb-js.
 *
 * Storage layout:
 *   ~/.lm-assist/session-cache/
 *     session-cache.lmdb          # LMDB environment
 *       ├── sessions (sub-db)     # key: sessionPath → value: SessionCacheData
 *       ├── raw (sub-db)          # key: sessionPath → value: RawMessagesCache
 *       └── meta (sub-db)         # key: "stats"|"version" → value: metadata
 */

import { open, RootDatabase, Database } from 'lmdb';
import * as path from 'path';
import * as fs from 'fs';
import type { SessionCacheData, RawMessagesCache } from './session-cache';
import { getDataDir, getCacheDir } from './utils/path-utils';

const DEFAULT_CACHE_DIR = getCacheDir('session-cache');

/**
 * Hard ceiling on the LMDB map. LMDB grows the file as needed up to this and then
 * rejects writes with MDB_MAP_FULL — there is no eviction and no automatic reclamation
 * (`compact()` is a destructive manual wipe), so this is a real cliff, not a soft limit.
 */
export const LMDB_MAP_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Retention for cached session entries, in days. Matches `claudeai-cache.ts`, which uses
 * the same default for the same reason. A session whose transcript has not been touched
 * in this long is cold; its cache entry is re-derivable from the JSONL on demand.
 */
export const DEFAULT_EVICT_AFTER_DAYS = 30;

/**
 * True only for the LMDB "map is exhausted" failure.
 *
 * Deliberately narrow: every write on the hot path is a background put nobody awaits, so
 * a broad match here would raise a capacity alarm for ordinary, unrelated write failures
 * (ENOSPC, a bad transaction) and make the signal worthless.
 */
export function isMapFullError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.includes('MDB_MAP_FULL')) return true;
  return err.message.includes('MDB_MAP_FULL');
}

/** Capacity snapshot for /health and diagnostics. */
export interface SessionCacheCapacity {
  /** Current on-disk size of data.mdb. */
  dataSizeBytes: number;
  /** The configured hard ceiling. */
  mapSizeBytes: number;
  /** dataSizeBytes / mapSizeBytes, clamped to 0..1. */
  utilisation: number;
  /**
   * Live session entries. Reported alongside dataSizeBytes because LMDB reuses freed
   * pages instead of shrinking the file — after an eviction the size is unchanged, so
   * size alone makes a working sweep look like a no-op.
   */
  entryCount: number;
  /** Sticky: a write has failed with MDB_MAP_FULL since this store was opened. */
  mapFull: boolean;
  /** When the first such failure was seen. */
  mapFullSince?: string;
}

export class SessionCacheStore {
  private env: RootDatabase;
  private sessionsDb: Database<SessionCacheData, string>;
  private rawDb: Database<RawMessagesCache, string>;
  private metaDb: Database<any, string>;
  private _closed = false;
  private _path: string;
  private _mapFullSince: string | null = null;
  private _cachedSizeBytes = 0;
  private _sizeCheckedAt = 0;

  constructor(cacheDir?: string) {
    const dir = cacheDir || DEFAULT_CACHE_DIR;
    this._path = dir;

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Startup cleanup: if a previous compact flagged for file deletion,
    // delete the old data.mdb before opening LMDB so it creates a fresh file.
    const compactFlag = path.join(dir, '.compact-pending');
    if (fs.existsSync(compactFlag)) {
      const dataFile = path.join(dir, 'data.mdb');
      const lockFile = path.join(dir, 'lock.mdb');
      for (const f of [dataFile, lockFile]) {
        try { fs.unlinkSync(f); } catch { /* ok — may not exist */ }
      }
      // Clean up .old files from previous compactions
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.old')) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ }
          }
        }
      } catch { /* ok */ }
      try { fs.unlinkSync(compactFlag); } catch { /* ok */ }
      console.log('[SessionCacheStore] Startup compact: deleted old LMDB data files');
    }

    this.env = open({
      path: dir,
      compression: true,       // LZ4 — ~5 GB/s decompression
      maxDbs: 3,
      mapSize: LMDB_MAP_SIZE_BYTES,
    });

    this.sessionsDb = this.env.openDB('sessions', {
      encoding: 'msgpack',
    });
    this.rawDb = this.env.openDB('raw', {
      encoding: 'msgpack',
    });
    this.metaDb = this.env.openDB('meta', {
      encoding: 'msgpack',
    });
  }

  // ─── Session Data ────────────────────────────────────────

  /**
   * Sync read — instant, served from mmap'd pages (~0ms).
   */
  getSessionData(sessionPath: string): SessionCacheData | undefined {
    return this.sessionsDb.get(sessionPath);
  }

  /**
   * Async write — batched automatically by lmdb-js.
   */
  async putSessionData(sessionPath: string, data: SessionCacheData): Promise<void> {
    await this.guardCapacity(() => this.sessionsDb.put(sessionPath, data));
  }

  /**
   * Record an exhausted LMDB map instead of letting it vanish into an unawaited promise.
   *
   * The rejection is re-thrown unchanged — callers that already handle write failures keep
   * seeing them. What this adds is a sticky, reportable condition plus ONE loud log line,
   * because the writes that hit this are background watcher updates at a rate of thousands
   * per day: logging per failure would bury the signal it is trying to raise.
   */
  private async guardCapacity<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isMapFullError(err) && !this._mapFullSince) {
        this._mapFullSince = new Date().toISOString();
        console.error(
          `[SessionCacheStore] MDB_MAP_FULL — the session cache has reached its ${
            Math.round(LMDB_MAP_SIZE_BYTES / (1024 * 1024))
          } MB map limit at ${this._path}. Cache writes are now FAILING: session summaries ` +
          `and cache updates will stop while reads keep serving stale data. There is no ` +
          `eviction; reclaim with POST /sessions/compact-cache (destructive — clears the cache).`
        );
      }
      throw err;
    }
  }

  /**
   * Capacity snapshot — utilisation before the cliff, plus whether it has already been hit.
   */
  getCapacityStatus(): SessionCacheCapacity {
    // /health polls this and Core is single-threaded, so the stat is cached briefly.
    // One statSync is microseconds, but sync I/O on a frequently-polled endpoint is
    // exactly the shape that has produced multi-second p99s here before.
    const now = Date.now();
    if (now - this._sizeCheckedAt > 5000) {
      try {
        this._cachedSizeBytes = fs.statSync(path.join(this._path, 'data.mdb')).size;
      } catch { this._cachedSizeBytes = 0; /* not created yet — 0 is correct */ }
      this._sizeCheckedAt = now;
    }
    const dataSizeBytes = this._cachedSizeBytes;

    return {
      dataSizeBytes,
      mapSizeBytes: LMDB_MAP_SIZE_BYTES,
      utilisation: Math.min(1, dataSizeBytes / LMDB_MAP_SIZE_BYTES),
      entryCount: this.sessionsDb.getCount(),
      mapFull: this._mapFullSince !== null,
      ...(this._mapFullSince ? { mapFullSince: this._mapFullSince } : {}),
    };
  }

  /**
   * Remove a session data entry.
   */
  async removeSessionData(sessionPath: string): Promise<void> {
    await this.sessionsDb.remove(sessionPath);
  }

  // ─── Raw Messages ────────────────────────────────────────

  /**
   * Sync read for raw messages cache.
   */
  getRawMessages(sessionPath: string): RawMessagesCache | undefined {
    return this.rawDb.get(sessionPath);
  }

  /**
   * Async write for raw messages cache.
   */
  async putRawMessages(sessionPath: string, data: RawMessagesCache): Promise<void> {
    await this.guardCapacity(() => this.rawDb.put(sessionPath, data));
  }

  /**
   * Remove a raw messages entry.
   */
  async removeRawMessages(sessionPath: string): Promise<void> {
    await this.rawDb.remove(sessionPath);
  }

  /**
   * Evict cache entries whose transcript has not been touched within the retention
   * window. Returns the number of sessions removed.
   *
   * Keyed on `fileMtime` (the transcript's own mtime), not on when we last wrote the
   * entry — "cold" must mean the SESSION is cold. Removes the raw-messages entry with it,
   * since that sub-db holds the bulk of the bytes and evicting only `sessions` would
   * defeat the point.
   *
   * An entry with no usable mtime is KEPT. Losing a cache entry is cheap, but treating
   * "unknown age" as "infinitely old" would wipe the whole store the first time that
   * field is renamed — a far worse failure than carrying a few stale rows.
   *
   * Safe by construction: this is a cache, not a system of record. Anything evicted
   * re-parses from its JSONL on next access.
   */
  async sweepStale(evictAfterDays: number = DEFAULT_EVICT_AFTER_DAYS): Promise<number> {
    const cutoffMs = Date.now() - evictAfterDays * 86_400_000;

    // Collect first, then delete: mutating the range while iterating it is asking for
    // undefined cursor behaviour.
    const stale: string[] = [];
    for (const { key, value } of this.allSessions()) {
      const mtime = value?.fileMtime;
      if (typeof mtime !== 'number' || !Number.isFinite(mtime)) continue;
      if (mtime < cutoffMs) stale.push(key);
    }

    for (const key of stale) {
      try {
        await this.removeSessionData(key);
        await this.removeRawMessages(key);
      } catch { /* best-effort, same as the claudeai-cache sweep */ }
    }

    if (stale.length > 0) {
      console.log(
        `[SessionCacheStore] Evicted ${stale.length} session(s) not touched in ${evictAfterDays} days`
      );
    }
    return stale.length;
  }

  // ─── Iteration ───────────────────────────────────────────

  /**
   * Iterate all session entries. Used by getAllSessionsFromCache().
   */
  *allSessions(): IterableIterator<{ key: string; value: SessionCacheData }> {
    for (const { key, value } of this.sessionsDb.getRange()) {
      yield { key: key as string, value };
    }
  }

  /**
   * Count of session entries in the store.
   */
  get sessionCount(): number {
    return this.sessionsDb.getCount();
  }

  /**
   * Count of raw message entries in the store.
   */
  get rawCount(): number {
    return this.rawDb.getCount();
  }

  // ─── Meta ────────────────────────────────────────────────

  getMeta(key: string): any {
    return this.metaDb.get(key);
  }

  async putMeta(key: string, value: any): Promise<void> {
    await this.metaDb.put(key, value);
  }

  // ─── Housekeeping ────────────────────────────────────────

  /**
   * Clear a specific session's cache, or all caches if no path given.
   */
  async clear(sessionPath?: string): Promise<void> {
    if (sessionPath) {
      await this.sessionsDb.remove(sessionPath);
      await this.rawDb.remove(sessionPath);
    } else {
      await this.sessionsDb.clearAsync();
      await this.rawDb.clearAsync();
    }
  }

  /**
   * Compact the LMDB database to reclaim disk space.
   *
   * On Windows, LMDB data files are memory-mapped and cannot be deleted while
   * any process (including MCP servers spawned by Claude Code) has them open.
   *
   * Strategy:
   * 1. Clear all data immediately (pages become free internally)
   * 2. Write a `.compact-pending` flag file
   * 3. On next server restart, the constructor deletes data.mdb before opening
   *
   * All cached data is lost and will be reparsed on demand.
   */
  async compact(): Promise<{ beforeSize: number; afterSize: number }> {
    const dataFile = path.join(this._path, 'data.mdb');

    // Measure before size
    let beforeSize = 0;
    try { beforeSize = fs.statSync(dataFile).size; } catch { /* ok */ }

    // Clear all data (marks pages as free within LMDB — file size unchanged)
    await this.sessionsDb.clearAsync();
    await this.rawDb.clearAsync();
    await this.metaDb.clearAsync();

    // Try to delete the file directly (works on Linux/macOS, rarely on Windows)
    let deleted = false;
    this.close();
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      fs.unlinkSync(dataFile);
      try { fs.unlinkSync(path.join(this._path, 'lock.mdb')); } catch { /* ok */ }
      deleted = true;
    } catch {
      // File is locked (Windows mmap) — flag for cleanup on next startup
      const compactFlag = path.join(this._path, '.compact-pending');
      fs.writeFileSync(compactFlag, new Date().toISOString());
      console.log('[SessionCacheStore] File locked by other processes, flagged for cleanup on next restart');
    }

    // Clean up .old files from previous compactions
    try {
      for (const f of fs.readdirSync(this._path)) {
        if (f.endsWith('.old')) {
          try { fs.unlinkSync(path.join(this._path, f)); } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }

    // Reopen (either fresh file if deleted, or the cleared-but-same-size file)
    this._closed = false;
    this.env = open({
      path: this._path,
      compression: true,
      maxDbs: 3,
      mapSize: LMDB_MAP_SIZE_BYTES,
    });
    this.sessionsDb = this.env.openDB('sessions', { encoding: 'msgpack' });
    this.rawDb = this.env.openDB('raw', { encoding: 'msgpack' });
    this.metaDb = this.env.openDB('meta', { encoding: 'msgpack' });

    // Measure after size
    let afterSize = 0;
    try { afterSize = fs.statSync(dataFile).size; } catch { /* ok */ }

    return { beforeSize, afterSize };
  }

  /**
   * Get the LMDB environment path (for diagnostics).
   */
  getPath(): string {
    return this._path;
  }

  /**
   * Close the LMDB environment. Call on server shutdown.
   */
  close(): void {
    if (!this._closed) {
      this._closed = true;
      this.env.close();
    }
  }

  get closed(): boolean {
    return this._closed;
  }
}
