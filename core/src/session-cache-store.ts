/**
 * Session Cache Store — LMDB-backed storage adapter
 *
 * Replaces the old Memory Map + .cache.gz disk files with a single
 * memory-mapped LMDB database. Reads are synchronous and instant
 * (served directly from mmap'd pages by the OS), writes are async
 * and auto-batched by lmdb-js.
 *
 * Storage layout:
 *   ~/.session-cache/
 *     session-cache.lmdb          # LMDB environment
 *       ├── sessions (sub-db)     # key: sessionPath → value: SessionCacheData
 *       ├── raw (sub-db)          # key: sessionPath → value: RawMessagesCache
 *       └── meta (sub-db)         # key: "stats"|"version" → value: metadata
 */

import { open, RootDatabase, Database } from 'lmdb';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { SessionCacheData, RawMessagesCache } from './session-cache';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.session-cache');

export class SessionCacheStore {
  private env: RootDatabase;
  private sessionsDb: Database<SessionCacheData, string>;
  private rawDb: Database<RawMessagesCache, string>;
  private metaDb: Database<any, string>;
  private _closed = false;
  private _path: string;

  constructor(cacheDir?: string) {
    const dir = cacheDir || DEFAULT_CACHE_DIR;
    this._path = dir;

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.env = open({
      path: dir,
      compression: true,       // LZ4 — ~5 GB/s decompression
      maxDbs: 3,
      // 2 GB map size — LMDB will grow the file as needed within this limit
      mapSize: 2 * 1024 * 1024 * 1024,
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
    await this.sessionsDb.put(sessionPath, data);
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
    await this.rawDb.put(sessionPath, data);
  }

  /**
   * Remove a raw messages entry.
   */
  async removeRawMessages(sessionPath: string): Promise<void> {
    await this.rawDb.remove(sessionPath);
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
