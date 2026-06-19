/**
 * Memory Cache Store — LMDB-backed storage adapter
 *
 * Mirrors SessionCacheStore for memory directories. Keys are absolute
 * paths to memory directories (either `~/.claude/projects/<slug>/memory/`
 * for live auto-memory, or `<cwd>/memory/<host-id>/` for repo mirrors).
 * Values are MemoryDirData with the parsed file list and the MEMORY.md
 * index.
 *
 * Storage layout:
 *   ~/.lm-assist/memory-cache/
 *     memory-cache.lmdb
 *       ├── dirs (sub-db)   # key: dirPath → value: MemoryDirData
 *       └── meta (sub-db)   # key: "version" → metadata
 */

import { open, RootDatabase, Database } from 'lmdb';
import * as path from 'path';
import * as fs from 'fs';
import type { MemoryDirData } from './memory-cache';
import { getDataDir, getCacheDir } from './utils/path-utils';

const DEFAULT_CACHE_DIR = getCacheDir('memory-cache');

export class MemoryCacheStore {
  private env: RootDatabase;
  private dirsDb: Database<MemoryDirData, string>;
  private metaDb: Database<any, string>;
  private _closed = false;
  private _path: string;

  constructor(cacheDir?: string) {
    const dir = cacheDir || DEFAULT_CACHE_DIR;
    this._path = dir;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.env = open({
      path: dir,
      compression: true,
      maxDbs: 2,
      // 512 MB is plenty — memory files are small markdown
      mapSize: 512 * 1024 * 1024,
    });

    this.dirsDb = this.env.openDB('dirs', { encoding: 'msgpack' });
    this.metaDb = this.env.openDB('meta', { encoding: 'msgpack' });
  }

  // ─── Dir data ──────────────────────────────────────────────

  getDirData(dirPath: string): MemoryDirData | undefined {
    return this.dirsDb.get(dirPath);
  }

  async putDirData(dirPath: string, data: MemoryDirData): Promise<void> {
    await this.dirsDb.put(dirPath, data);
  }

  async removeDirData(dirPath: string): Promise<boolean> {
    return await this.dirsDb.remove(dirPath);
  }

  /**
   * List all cached dir paths.
   */
  listDirPaths(): string[] {
    const paths: string[] = [];
    for (const key of this.dirsDb.getKeys()) {
      paths.push(key);
    }
    return paths;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.env.close();
  }

  getPath(): string {
    return this._path;
  }
}
