/**
 * Vectra Store
 *
 * Vector database for semantic search over session and milestone data.
 * Uses Vectra (pure Node.js, JSON file-based persistence) with local
 * embeddings from transformers.js.
 *
 * Two vector types stored:
 * - 'session': embeddings from user prompts, results, tasks, file paths
 * - 'milestone': embeddings from milestone titles, facts, user prompts
 *
 * Persists to ~/.lm-assist/vector-store/
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { LocalIndex } from 'vectra';
import { getEmbedder, VECTOR_DIM } from './embedder';
import { getDataDir } from '../utils/path-utils';

// ─── Types ──────────────────────────────────────────────────

export interface VectorMetadata {
  type: 'session' | 'milestone' | 'knowledge';
  sessionId: string;
  milestoneIndex?: number;
  /** Knowledge document ID (e.g., "K001") — set when type='knowledge' */
  knowledgeId?: string;
  /** Knowledge part ID (e.g., "K001.2") — set when type='knowledge' */
  partId?: string;
  /** What this vector represents: 'prompt', 'result', 'task', 'files', 'title', 'fact', 'knowledge_title', 'knowledge_part' */
  contentType: string;
  /** Original text that was embedded (truncated for storage) */
  text: string;
  /** Timestamp for recency scoring */
  timestamp?: string;
  /** Project path for affinity */
  projectPath?: string;
  /** Phase for milestone quality signal */
  phase?: number;
}

export interface VectorSearchResult {
  type: 'session' | 'milestone' | 'knowledge';
  sessionId: string;
  milestoneIndex?: number;
  knowledgeId?: string;
  partId?: string;
  contentType: string;
  text: string;
  score: number;
  timestamp?: string;
  projectPath?: string;
  phase?: number;
}

// ─── Helpers ──────────────────────────────────────────────────

const yieldToEventLoop = () => new Promise<void>(r => setImmediate(r));

// ─── Vectra Store ──────────────────────────────────────────────────

const STORE_DIR = path.join(getDataDir(), 'vector-store');

export class VectraStore {
  private index: LocalIndex;
  private storeDir: string;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  // Serialize all write operations to prevent concurrent file corruption
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storeDir?: string) {
    this.storeDir = storeDir || STORE_DIR;
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    this.index = new LocalIndex(this.storeDir);
  }

  /**
   * Initialize the index (create if needed).
   * Validates the index file first — if it's corrupt (truncated mid-write),
   * auto-repairs by truncating to the last complete item.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      // Validate and repair corrupt index before Vectra tries to read it
      this.validateAndRepairIndex();

      const exists = await this.index.isIndexCreated();
      if (!exists) {
        console.log('[VectraStore] Creating new vector index');
        await this.index.createIndex();
      }

      // Patch Vectra's endUpdate to use atomic writes (write-to-temp-then-rename)
      // Vectra's default fs.writeFile can leave truncated files if the process crashes mid-write.
      // fs.rename is atomic on Linux (same filesystem), preventing corruption.
      this.patchAtomicWrites();

      this.initialized = true;
      console.log('[VectraStore] Index initialized');

      // Bootstrap BM25 from existing Vectra data (async, non-blocking)
      this.bootstrapBM25().catch(() => {});
    })();

    await this.initializing;
  }

  /**
   * Check if the Vectra index.json is valid JSON. If truncated (e.g. from a
   * process crash mid-write), repair by truncating to the last complete item
   * and re-closing the JSON structure.
   */
  private validateAndRepairIndex(): void {
    const indexFile = path.join(this.storeDir, 'index.json');
    if (!fs.existsSync(indexFile)) return;

    const raw = fs.readFileSync(indexFile, 'utf-8');
    if (raw.length === 0) return;

    try {
      JSON.parse(raw);
      // Valid JSON — no repair needed
      return;
    } catch {
      // Corrupt — attempt repair
    }

    console.error(`[VectraStore] Index file is corrupt (${raw.length} bytes), attempting repair...`);

    // Find the last complete item boundary: },{
    const lastItemSep = raw.lastIndexOf('},{');
    if (lastItemSep < 0) {
      // Can't find any complete items — back up the corrupt file and let Vectra create fresh
      const backupPath = indexFile + '.corrupt';
      try { fs.renameSync(indexFile, backupPath); } catch { /* best effort */ }
      console.error('[VectraStore] Could not repair — backed up corrupt file and will create fresh index');
      return;
    }

    // Keep everything up to and including the "}" at lastItemSep, then close array + object
    const repaired = raw.slice(0, lastItemSep + 1) + ']}';

    // Validate the repair
    try {
      const parsed = JSON.parse(repaired);
      const itemCount = Array.isArray(parsed.items) ? parsed.items.length : 0;

      // Back up corrupt file, write repaired
      const backupPath = indexFile + '.corrupt';
      try { fs.unlinkSync(backupPath); } catch { /* no previous backup */ }
      fs.renameSync(indexFile, backupPath);
      fs.writeFileSync(indexFile, repaired);

      // Re-create the LocalIndex to pick up the repaired file
      this.index = new LocalIndex(this.storeDir);

      console.error(`[VectraStore] Index repaired: ${itemCount} items recovered, ${raw.length - repaired.length} bytes trimmed`);
    } catch {
      // Repair also invalid — back up and start fresh
      const backupPath = indexFile + '.corrupt';
      try { fs.renameSync(indexFile, backupPath); } catch { /* best effort */ }
      console.error('[VectraStore] Repair failed — backed up corrupt file and will create fresh index');
    }
  }

  /**
   * Monkey-patch Vectra's LocalIndex for crash-safe and cross-process-safe writes.
   *
   * Two patches:
   * 1. endUpdate() — atomic write via write-to-temp-then-rename. Prevents
   *    truncated files from process crashes. Uses PID+counter in temp name
   *    to avoid cross-process temp file clobbering.
   *
   * 2. beginUpdate() — forces a re-read from disk before cloning into _update.
   *    Vectra caches _data in memory and never re-reads, so without this a
   *    process would overwrite another process's changes (lost update).
   */
  private patchAtomicWrites(): void {
    const idx = this.index as any;
    const indexPath = path.join(this.storeDir, idx._indexName || 'index.json');
    let writeCounter = 0;

    // Patch beginUpdate: force re-read from disk so we always start from the latest state
    const origBeginUpdate = idx.beginUpdate.bind(idx);
    idx.beginUpdate = async function (this: any): Promise<void> {
      // Clear cached _data to force loadIndexData() to re-read from disk
      this._data = undefined;
      await origBeginUpdate();
    };

    // Patch endUpdate: atomic write via temp-then-rename
    idx.endUpdate = async function (this: any): Promise<void> {
      if (!this._update) {
        throw new Error('No update in progress');
      }
      // Unique temp file per process+write to prevent cross-process clobbering
      const tmpPath = `${indexPath}.tmp.${process.pid}.${writeCounter++}`;
      try {
        const json = JSON.stringify(this._update);
        await fsPromises.writeFile(tmpPath, json);
        await fsPromises.rename(tmpPath, indexPath);
        this._data = this._update;
        this._update = undefined;
      } catch (err: any) {
        try { await fsPromises.unlink(tmpPath); } catch { /* best effort */ }
        throw new Error(`Error saving index: ${err.toString()}`);
      }
    };
  }

  // ─── Cross-process file lock ─────────────────────────────────────
  //
  // Uses O_CREAT|O_EXCL (exclusive create) for a lockfile. This is atomic
  // on all Linux filesystems — only one process can create the file.
  // Stale lock detection: if the lockfile is older than LOCK_STALE_MS,
  // the owning process likely crashed — we steal the lock.

  private lockPath = '';
  private static readonly LOCK_STALE_MS = 30_000; // 30s
  private static readonly LOCK_RETRY_MS = 50;     // poll interval
  private static readonly LOCK_TIMEOUT_MS = 10_000; // 10s max wait

  private async acquireLock(): Promise<void> {
    if (!this.lockPath) {
      this.lockPath = path.join(this.storeDir, 'index.json.lock');
    }
    const deadline = Date.now() + VectraStore.LOCK_TIMEOUT_MS;

    while (true) {
      try {
        // O_CREAT|O_EXCL: fails if file already exists
        const fd = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        // Write our PID for debugging and stale detection
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return; // Lock acquired
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;

        // Lock exists — check if stale
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > VectraStore.LOCK_STALE_MS) {
            // Stale lock from a crashed process — remove and retry
            try { fs.unlinkSync(this.lockPath); } catch { /* another process beat us */ }
            continue;
          }
        } catch {
          // Lock disappeared between EEXIST and stat — retry
          continue;
        }

        // Lock is held by another process — wait
        if (Date.now() >= deadline) {
          throw new Error(`[VectraStore] Lock timeout after ${VectraStore.LOCK_TIMEOUT_MS}ms`);
        }
        await new Promise(r => setTimeout(r, VectraStore.LOCK_RETRY_MS));
      }
    }
  }

  private releaseLock(): void {
    try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
  }

  /**
   * Serialize a write operation through the write queue (intra-process),
   * then wrap with a cross-process file lock. This guarantees:
   * - Within one process: promise-chain serialization (fast, no polling)
   * - Across processes: exclusive lockfile (O_CREAT|O_EXCL)
   *
   * The lock wraps the full read-modify-write cycle (beginUpdate → endUpdate)
   * so no other process can read stale data between our read and write.
   */
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const lockedFn = async (): Promise<T> => {
      await this.acquireLock();
      try {
        return await fn();
      } finally {
        this.releaseLock();
      }
    };
    const result = this.writeQueue.then(lockedFn, lockedFn);
    // Update the queue to wait for this operation (swallow errors to not block future writes)
    this.writeQueue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Add a single vector with metadata
   */
  async addVector(text: string, metadata: VectorMetadata): Promise<void> {
    await this.init();
    const embedder = getEmbedder();
    const vector = await embedder.embed(text);

    await this.serializeWrite(async () => {
      await this.index.insertItem({
        vector,
        metadata: {
          ...metadata,
          text: metadata.text.length > 500 ? metadata.text.slice(0, 500) : metadata.text,
        },
      });
    });
  }

  /**
   * Add multiple vectors in batch (more efficient).
   * Embedding is done outside the write lock for parallelism;
   * only the index mutation is serialized.
   * Also mirrors items to the BM25 index for hybrid search.
   */
  async addVectors(items: Array<{ text: string; metadata: VectorMetadata }>): Promise<number> {
    if (items.length === 0) return 0;
    await this.init();

    // Process in chunks: embed + write per chunk to bound memory usage.
    // Each chunk embeds up to WRITE_CHUNK vectors then flushes to the index.
    const WRITE_CHUNK = 200;
    const embedder = getEmbedder();
    let totalAdded = 0;

    for (let offset = 0; offset < items.length; offset += WRITE_CHUNK) {
      const chunk = items.slice(offset, offset + WRITE_CHUNK);
      const texts = chunk.map(i => i.text);
      const vectors = await embedder.embedBatch(texts);

      await this.serializeWrite(async () => {
        await this.index.beginUpdate();
        try {
          for (let i = 0; i < chunk.length; i++) {
            await this.index.insertItem({
              vector: vectors[i],
              metadata: {
                ...chunk[i].metadata,
                text: chunk[i].metadata.text.length > 500
                  ? chunk[i].metadata.text.slice(0, 500)
                  : chunk[i].metadata.text,
              },
            });
          }
          await this.index.endUpdate();
        } catch (e) {
          await this.index.cancelUpdate();
          throw e;
        }
      });

      totalAdded += chunk.length;
    }

    // Mirror to BM25 index (non-blocking, non-fatal)
    this.mirrorToBM25(items);

    return totalAdded;
  }

  /**
   * Search for similar vectors.
   * @param filter Optional metadata filter passed to Vectra's queryItems (e.g. { type: 'knowledge' })
   */
  async search(query: string, limit: number = 20, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    await this.init();

    const embedder = getEmbedder();
    const queryVector = await embedder.embed(query);

    const results = await this.index.queryItems(queryVector, '', limit, filter);

    return results.map(r => {
      const meta = r.item.metadata as unknown as VectorMetadata;
      return {
        type: meta.type,
        sessionId: meta.sessionId,
        milestoneIndex: meta.milestoneIndex,
        knowledgeId: meta.knowledgeId,
        partId: meta.partId,
        contentType: meta.contentType,
        text: meta.text,
        score: r.score,
        timestamp: meta.timestamp,
        projectPath: meta.projectPath,
        phase: meta.phase,
      };
    });
  }

  /**
   * Delete all vectors for a session
   */
  async deleteSession(sessionId: string): Promise<number> {
    await this.init();

    // Read item IDs outside the lock (stale list is fine — extra deletes are no-ops)
    const items = await this.index.listItemsByMetadata({ sessionId });
    if (items.length === 0) return 0;

    await this.serializeWrite(async () => {
      await this.index.beginUpdate();
      try {
        for (const item of items) {
          // deleteItem with _update active just splices in memory — no disk I/O
          await this.index.deleteItem(item.id);
        }
        await this.index.endUpdate();
      } catch (e) {
        await this.index.cancelUpdate();
        throw e;
      }
    });

    // Mirror delete to BM25 (session ID is prefix for milestones "sessionId:N")
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      getBM25Scorer().removeDocumentsByPrefix(sessionId);
    } catch { /* non-fatal */ }

    return items.length;
  }

  /**
   * Delete all vectors for a specific milestone
   */
  async deleteMilestone(sessionId: string, milestoneIndex: number): Promise<number> {
    await this.init();

    const items = await this.index.listItemsByMetadata({
      sessionId,
      milestoneIndex,
      type: 'milestone',
    });
    if (items.length === 0) return 0;

    await this.serializeWrite(async () => {
      await this.index.beginUpdate();
      try {
        for (const item of items) {
          await this.index.deleteItem(item.id);
        }
        await this.index.endUpdate();
      } catch (e) {
        await this.index.cancelUpdate();
        throw e;
      }
    });

    // Mirror delete to BM25
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      getBM25Scorer().removeDocument(`${sessionId}:${milestoneIndex}`);
    } catch { /* non-fatal */ }

    return items.length;
  }

  /**
   * Delete all vectors for a knowledge document
   */
  async deleteKnowledge(knowledgeId: string): Promise<number> {
    await this.init();

    const items = await this.index.listItemsByMetadata({
      knowledgeId,
      type: 'knowledge',
    });
    if (items.length === 0) return 0;

    await this.serializeWrite(async () => {
      await this.index.beginUpdate();
      try {
        for (const item of items) {
          await this.index.deleteItem(item.id);
        }
        await this.index.endUpdate();
      } catch (e) {
        await this.index.cancelUpdate();
        throw e;
      }
    });

    // Mirror delete to BM25 (prefix matches "K001", "K001.2", etc.)
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      getBM25Scorer().removeDocumentsByPrefix(knowledgeId);
    } catch { /* non-fatal */ }

    return items.length;
  }

  /**
   * Delete all vectors of a given type (e.g., 'knowledge', 'session', 'milestone').
   * Much faster than deleting per-document — single scan, single update.
   */
  async deleteAllByType(type: 'session' | 'milestone' | 'knowledge'): Promise<number> {
    await this.init();

    const items = await this.index.listItemsByMetadata({ type });
    if (items.length === 0) return 0;

    await this.serializeWrite(async () => {
      await this.index.beginUpdate();
      try {
        for (const item of items) {
          await this.index.deleteItem(item.id);
        }
        await this.index.endUpdate();
      } catch (e) {
        await this.index.cancelUpdate();
        throw e;
      }
    });

    // Mirror delete to BM25
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      const bm25 = getBM25Scorer();
      for (const item of items) {
        const meta = item.metadata as unknown as VectorMetadata;
        if (meta.knowledgeId) bm25.removeDocumentsByPrefix(meta.knowledgeId);
      }
    } catch { /* non-fatal */ }

    return items.length;
  }

  // ─── BM25 Mirroring ─────────────────────────────────────────────

  /**
   * Mirror a batch of items to the BM25 index.
   * Groups items by logical doc ID and concatenates texts before adding,
   * so a milestone with title + facts vectors becomes a single BM25 doc.
   * Yields to the event loop every 50 docs to avoid blocking.
   */
  private async mirrorToBM25(items: Array<{ text: string; metadata: VectorMetadata }>): Promise<void> {
    try {
      // Lazy require to avoid circular dependency at module load time
      const { getBM25Scorer } = require('../search/bm25-scorer');
      const bm25 = getBM25Scorer();

      // Group items by logical doc ID, concatenating texts
      const grouped = new Map<string, { texts: string[]; meta: VectorMetadata }>();

      for (const item of items) {
        const meta = item.metadata;
        let id: string;
        if (meta.type === 'knowledge') {
          id = meta.partId || meta.knowledgeId || '';
        } else if (meta.type === 'milestone') {
          id = `${meta.sessionId}:${meta.milestoneIndex}`;
        } else {
          id = meta.sessionId;
        }
        if (!id) continue;

        const existing = grouped.get(id);
        if (existing) {
          existing.texts.push(meta.text);
        } else {
          grouped.set(id, { texts: [meta.text], meta });
        }
      }

      const YIELD_EVERY = 50;
      let count = 0;
      for (const [id, { texts, meta }] of grouped) {
        bm25.addDocument(id, texts.join(' '), {
          type: meta.type,
          timestamp: meta.timestamp || '',
          sessionId: meta.sessionId,
          knowledgeId: meta.knowledgeId,
          partId: meta.partId,
          projectPath: meta.projectPath,
          phase: meta.phase,
        });
        if (++count % YIELD_EVERY === 0) {
          await yieldToEventLoop();
        }
      }
    } catch (err) {
      console.error('[VectraStore] BM25 mirror failed:', err);
    }
  }

  /**
   * Bootstrap BM25 index from existing Vectra vectors.
   * Called during init() when the BM25 index is empty but Vectra has data.
   */
  async bootstrapBM25(): Promise<number> {
    try {
      const { getBM25Scorer } = require('../search/bm25-scorer');
      const bm25 = getBM25Scorer();
      const stats = bm25.getStats();

      if (stats.documentCount > 0) return 0; // Already populated

      const vectraStats = await this.getStats();
      if (vectraStats.totalVectors === 0) return 0;

      console.log('[VectraStore] Bootstrapping BM25 from Vectra vectors...');

      // Single scan of all items (avoids 3× listItemsByMetadata calls,
      // each of which re-filters the full 42MB+ index)
      const allItems = await this.index.listItems();
      await yieldToEventLoop();

      // Group by logical doc ID, yielding periodically for large indices
      const grouped = new Map<string, { texts: string[]; meta: VectorMetadata }>();
      const GROUPING_YIELD = 500;

      for (let i = 0; i < allItems.length; i++) {
        const meta = allItems[i].metadata as unknown as VectorMetadata;
        if (meta.type !== 'session' && meta.type !== 'milestone' && meta.type !== 'knowledge') continue;

        let id: string;
        if (meta.type === 'knowledge') {
          id = meta.partId || meta.knowledgeId || '';
        } else if (meta.type === 'milestone') {
          id = `${meta.sessionId}:${meta.milestoneIndex}`;
        } else {
          id = meta.sessionId;
        }
        if (!id) continue;

        const existing = grouped.get(id);
        if (existing) {
          existing.texts.push(meta.text || '');
        } else {
          grouped.set(id, { texts: [meta.text || ''], meta });
        }

        if ((i + 1) % GROUPING_YIELD === 0) {
          await yieldToEventLoop();
        }
      }

      // Add docs to BM25 in chunks, yielding to the event loop between chunks
      // to avoid blocking the server for seconds on large indices
      const YIELD_EVERY = 50;
      let count = 0;
      for (const [id, { texts, meta }] of grouped) {
        bm25.addDocument(id, texts.join(' '), {
          type: meta.type,
          timestamp: meta.timestamp || '',
          sessionId: meta.sessionId,
          knowledgeId: meta.knowledgeId,
          partId: meta.partId,
          projectPath: meta.projectPath,
          phase: meta.phase,
        });
        if (++count % YIELD_EVERY === 0) {
          await yieldToEventLoop();
        }
      }

      console.log(`[VectraStore] BM25 bootstrap complete: ${grouped.size} docs from ${allItems.length} vectors`);
      return grouped.size;
    } catch (err) {
      console.error('[VectraStore] BM25 bootstrap failed:', err);
      return 0;
    }
  }

  /**
   * Check if a knowledge document has been indexed
   */
  async hasKnowledge(knowledgeId: string): Promise<boolean> {
    await this.init();
    const items = await this.index.listItemsByMetadata({
      knowledgeId,
      type: 'knowledge',
    });
    return items.length > 0;
  }

  /**
   * Get all unique knowledge IDs in the vector index
   */
  async getIndexedKnowledgeIds(): Promise<string[]> {
    await this.init();
    const items = await this.index.listItemsByMetadata({ type: 'knowledge' });
    const ids = new Set<string>();
    for (const item of items) {
      const meta = item.metadata as unknown as VectorMetadata;
      if (meta.knowledgeId) ids.add(meta.knowledgeId);
    }
    return Array.from(ids);
  }

  /**
   * Check if a session has been indexed
   */
  async hasSession(sessionId: string): Promise<boolean> {
    await this.init();
    const items = await this.index.listItemsByMetadata({
      sessionId,
      type: 'session',
    });
    return items.length > 0;
  }

  /**
   * Get index stats
   */
  async getStats(): Promise<{
    totalVectors: number;
    isInitialized: boolean;
  }> {
    if (!this.initialized) {
      return { totalVectors: 0, isInitialized: false };
    }

    const stats = await this.index.getIndexStats();
    return {
      totalVectors: stats.items,
      isInitialized: true,
    };
  }

  /**
   * Get vector counts broken down by type (session vs milestone)
   */
  async getStatsByType(): Promise<{
    totalVectors: number;
    sessionVectors: number;
    milestoneVectors: number;
    knowledgeVectors: number;
    isInitialized: boolean;
  }> {
    if (!this.initialized) {
      return { totalVectors: 0, sessionVectors: 0, milestoneVectors: 0, knowledgeVectors: 0, isInitialized: false };
    }

    const sessionItems = await this.index.listItemsByMetadata({ type: 'session' });
    const milestoneItems = await this.index.listItemsByMetadata({ type: 'milestone' });
    const knowledgeItems = await this.index.listItemsByMetadata({ type: 'knowledge' });

    return {
      totalVectors: sessionItems.length + milestoneItems.length + knowledgeItems.length,
      sessionVectors: sessionItems.length,
      milestoneVectors: milestoneItems.length,
      knowledgeVectors: knowledgeItems.length,
      isInitialized: true,
    };
  }
}

// Singleton
let instance: VectraStore | null = null;

export function getVectraStore(): VectraStore {
  if (!instance) {
    instance = new VectraStore();
  }
  return instance;
}
