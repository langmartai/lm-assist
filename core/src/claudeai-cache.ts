/**
 * On-disk cache for claude.ai conversations.
 *
 * One JSON file per conversation + a lightweight _index.json for fast list
 * operations. All writes use an atomic tmp-then-rename pattern to avoid
 * partial reads. Backed by plain fs — no extra dependencies required.
 *
 * Env overrides (all optional):
 *   LM_ASSIST_CLAUDEAI_CACHE_DIR      Directory to store files (default ~/.lm-assist/claudeai-cache)
 *   LM_ASSIST_CLAUDEAI_CACHE_TTL_SEC  TTL in seconds before a cache entry is considered stale (default 60)
 *   LM_ASSIST_CLAUDEAI_CACHE_EVICT_DAYS  Days before an entry is permanently evicted (default 30)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CachedConversation {
  uuid: string;
  name?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface IndexEntry {
  uuid: string;
  name?: string;
  updated_at?: string;
  lastSyncedAt: string;
}

export interface ClaudeAiCacheOptions {
  cacheDir: string;
  ttlSec: number;
  evictAfterDays?: number;
}

export interface ClaudeAiCache {
  /** Return cached conversation or null on miss / stale. */
  get(uuid: string): Promise<CachedConversation | null>;
  /** Persist conversation to disk and update index. */
  set(uuid: string, payload: CachedConversation): Promise<void>;
  /** Return all index entries (does not apply TTL filter). */
  listIndex(): Promise<IndexEntry[]>;
  /** Remove entries older than evictAfterDays. Returns count removed. */
  sweep(): Promise<number>;
}

export function createClaudeAiCache(opts: ClaudeAiCacheOptions): ClaudeAiCache {
  const { cacheDir, ttlSec, evictAfterDays = 30 } = opts;
  fs.mkdirSync(cacheDir, { recursive: true });
  const indexPath = path.join(cacheDir, '_index.json');

  function loadIndex(): Record<string, IndexEntry> {
    if (!fs.existsSync(indexPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, IndexEntry>;
    } catch {
      return {};
    }
  }

  function saveIndex(idx: Record<string, IndexEntry>): void {
    const tmp = indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
    fs.renameSync(tmp, indexPath);
  }

  function entryPath(uuid: string): string {
    return path.join(cacheDir, `${uuid}.json`);
  }

  return {
    async get(uuid) {
      const idx = loadIndex();
      const entry = idx[uuid];
      if (!entry) return null;
      const ageSec = (Date.now() - new Date(entry.lastSyncedAt).getTime()) / 1000;
      if (ageSec > ttlSec) return null;
      const fp = entryPath(uuid);
      if (!fs.existsSync(fp)) return null;
      try {
        return JSON.parse(fs.readFileSync(fp, 'utf8')) as CachedConversation;
      } catch {
        return null;
      }
    },

    async set(uuid, payload) {
      const fp = entryPath(uuid);
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, fp);
      const idx = loadIndex();
      idx[uuid] = {
        uuid,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        updated_at: typeof payload.updated_at === 'string' ? payload.updated_at : undefined,
        lastSyncedAt: new Date().toISOString(),
      };
      saveIndex(idx);
    },

    async listIndex() {
      return Object.values(loadIndex());
    },

    async sweep() {
      const idx = loadIndex();
      const cutoffMs = Date.now() - evictAfterDays * 86_400_000;
      let removed = 0;
      for (const [uuid, entry] of Object.entries(idx)) {
        if (new Date(entry.lastSyncedAt).getTime() < cutoffMs) {
          try { fs.unlinkSync(entryPath(uuid)); } catch (_) { /* best-effort */ }
          delete idx[uuid];
          removed++;
        }
      }
      if (removed > 0) saveIndex(idx);
      return removed;
    },
  };
}
