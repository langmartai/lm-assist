/**
 * Vector Store (LanceDB)
 *
 * Vector database for semantic search over session and milestone data.
 * Uses LanceDB (embedded Rust engine via NAPI) with local embeddings
 * from transformers.js.
 *
 * All heavy operations (indexing, search, I/O) run in native Rust threads
 * and do NOT block the Node.js event loop.
 *
 * Two vector types stored:
 * - 'session': embeddings from user prompts, results, tasks, file paths
 * - 'milestone': embeddings from milestone titles, facts, user prompts
 *
 * Persists to ~/.lm-assist/lance-store/
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
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

// ─── LanceDB row schema ─────────────────────────────────────
// LanceDB cannot infer types from null, so optional fields use sentinel values:
//   string fields → '' means absent
//   number fields → -1 means absent

interface LanceRow {
  id: string;
  vector: number[];
  type: string;
  sessionId: string;
  milestoneIndex: number;
  knowledgeId: string;
  partId: string;
  contentType: string;
  text: string;
  timestamp: string;
  projectPath: string;
  phase: number;
}

function metadataToRow(vector: number[], meta: VectorMetadata): LanceRow {
  return {
    id: crypto.randomUUID(),
    vector,
    type: meta.type,
    sessionId: meta.sessionId,
    milestoneIndex: meta.milestoneIndex ?? -1,
    knowledgeId: meta.knowledgeId || '',
    partId: meta.partId || '',
    contentType: meta.contentType,
    text: meta.text.length > 500 ? meta.text.slice(0, 500) : meta.text,
    timestamp: meta.timestamp || '',
    projectPath: meta.projectPath || '',
    phase: meta.phase ?? -1,
  };
}

function rowToResult(row: any, score: number): VectorSearchResult {
  return {
    type: row.type,
    sessionId: row.sessionId,
    milestoneIndex: row.milestoneIndex === -1 ? undefined : row.milestoneIndex,
    knowledgeId: row.knowledgeId || undefined,
    partId: row.partId || undefined,
    contentType: row.contentType,
    text: row.text,
    score,
    timestamp: row.timestamp || undefined,
    projectPath: row.projectPath || undefined,
    phase: row.phase === -1 ? undefined : row.phase,
  };
}

function rowToMetadata(row: any): VectorMetadata {
  return {
    type: row.type,
    sessionId: row.sessionId,
    milestoneIndex: row.milestoneIndex === -1 ? undefined : row.milestoneIndex,
    knowledgeId: row.knowledgeId || undefined,
    partId: row.partId || undefined,
    contentType: row.contentType,
    text: row.text,
    timestamp: row.timestamp || undefined,
    projectPath: row.projectPath || undefined,
    phase: row.phase === -1 ? undefined : row.phase,
  };
}

// ─── Where clause builder ───────────────────────────────────

function buildWhere(filter: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      // Escape single quotes in values
      parts.push(`${key} = '${value.replace(/'/g, "''")}'`);
    } else if (typeof value === 'number') {
      parts.push(`${key} = ${value}`);
    }
  }
  return parts.join(' AND ');
}

// ─── Vector Store ──────────────────────────────────────────────────

const STORE_DIR = path.join(getDataDir(), 'lance-store');
const TABLE_NAME = 'vectors';

export class VectraStore {
  private db: any = null;
  private table: any = null;
  private storeDir: string;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(storeDir?: string) {
    this.storeDir = storeDir || STORE_DIR;
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  /**
   * Initialize the LanceDB connection and table.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      const lancedb = require('@lancedb/lancedb');
      this.db = await lancedb.connect(this.storeDir);

      // Open existing table or create with seed row
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(TABLE_NAME)) {
        this.table = await this.db.openTable(TABLE_NAME);
      } else {
        console.log('[VectorStore] Creating new LanceDB table');
        // Seed with a dummy row so LanceDB can infer schema, then delete it
        const seedId = '__seed__';
        this.table = await this.db.createTable(TABLE_NAME, [{
          id: seedId,
          vector: new Array(VECTOR_DIM).fill(0),
          type: '_seed',
          sessionId: '',
          milestoneIndex: -1,
          knowledgeId: '',
          partId: '',
          contentType: '',
          text: '',
          timestamp: '',
          projectPath: '',
          phase: -1,
        }]);
        try { await this.table.delete(`id = '${seedId}'`); } catch { /* best effort */ }
      }

      this.initialized = true;
      console.log('[VectorStore] LanceDB initialized');

      // Bootstrap BM25 from existing data (async, non-blocking)
      this.bootstrapBM25().catch(() => {});
    })();

    await this.initializing;
  }

  /**
   * Add a single vector with metadata
   */
  async addVector(text: string, metadata: VectorMetadata): Promise<void> {
    await this.init();
    const embedder = getEmbedder();
    const vector = await embedder.embed(text);
    await this.table.add([metadataToRow(vector, metadata)]);
  }

  /**
   * Add multiple vectors in batch (more efficient).
   * Also mirrors items to the BM25 index for hybrid search.
   */
  async addVectors(items: Array<{ text: string; metadata: VectorMetadata }>): Promise<number> {
    if (items.length === 0) return 0;
    await this.init();

    const WRITE_CHUNK = 200;
    const embedder = getEmbedder();
    let totalAdded = 0;

    for (let offset = 0; offset < items.length; offset += WRITE_CHUNK) {
      const chunk = items.slice(offset, offset + WRITE_CHUNK);
      const texts = chunk.map(i => i.text);
      const vectors = await embedder.embedBatch(texts);

      const rows = chunk.map((item, i) => metadataToRow(vectors[i], item.metadata));
      await this.table.add(rows);

      totalAdded += chunk.length;
    }

    // Mirror to BM25 index (non-blocking, non-fatal)
    this.mirrorToBM25(items);

    return totalAdded;
  }

  /**
   * Search for similar vectors.
   * @param filter Optional metadata filter (e.g. { type: 'knowledge' })
   */
  async search(query: string, limit: number = 20, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    await this.init();

    const embedder = getEmbedder();
    const queryVector = await embedder.embed(query);

    let q = this.table.search(queryVector).limit(limit);
    if (filter) {
      const where = buildWhere(filter);
      if (where) q = q.where(where);
    }

    const results = await q.toArray();

    // LanceDB returns _distance (L2 or cosine distance). Convert to similarity score.
    // Cosine distance ∈ [0, 2]; similarity = 1 - distance/2 maps to [0, 1].
    return results.map((r: any) => {
      const distance = r._distance ?? 0;
      const score = Math.max(0, 1 - distance / 2);
      return rowToResult(r, score);
    });
  }

  /**
   * Delete all vectors for a session
   */
  async deleteSession(sessionId: string): Promise<number> {
    await this.init();

    const count = await this.countWhere(`sessionId = '${sessionId.replace(/'/g, "''")}'`);
    if (count === 0) return 0;

    await this.table.delete(`sessionId = '${sessionId.replace(/'/g, "''")}'`);

    // Mirror delete to BM25
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      getBM25Scorer().removeDocumentsByPrefix(sessionId);
    } catch { /* non-fatal */ }

    return count;
  }

  /**
   * Delete all vectors for a specific milestone
   */
  async deleteMilestone(sessionId: string, milestoneIndex: number): Promise<number> {
    await this.init();

    const where = `sessionId = '${sessionId.replace(/'/g, "''")}' AND milestoneIndex = ${milestoneIndex} AND type = 'milestone'`;
    const count = await this.countWhere(where);
    if (count === 0) return 0;

    await this.table.delete(where);

    // Mirror delete to BM25
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      getBM25Scorer().removeDocument(`${sessionId}:${milestoneIndex}`);
    } catch { /* non-fatal */ }

    return count;
  }

  /**
   * Delete all vectors for a knowledge document
   */
  async deleteKnowledge(knowledgeId: string): Promise<number> {
    await this.init();

    const where = `knowledgeId = '${knowledgeId.replace(/'/g, "''")}' AND type = 'knowledge'`;
    const count = await this.countWhere(where);
    if (count === 0) return 0;

    await this.table.delete(where);

    // Mirror delete to BM25
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      getBM25Scorer().removeDocumentsByPrefix(knowledgeId);
    } catch { /* non-fatal */ }

    return count;
  }

  /**
   * Delete all vectors of a given type.
   */
  async deleteAllByType(type: 'session' | 'milestone' | 'knowledge'): Promise<number> {
    await this.init();

    // For BM25 mirror, we need the knowledge IDs before deleting
    let knowledgeIds: string[] = [];
    if (type === 'knowledge') {
      try {
        const rows = await this.table.query()
          .where(`type = 'knowledge'`)
          .select(['knowledgeId'])
          .toArray();
        const ids = new Set<string>();
        for (const r of rows) {
          if (r.knowledgeId) ids.add(r.knowledgeId);
        }
        knowledgeIds = Array.from(ids);
      } catch { /* non-fatal */ }
    }

    const count = await this.countWhere(`type = '${type}'`);
    if (count === 0) return 0;

    await this.table.delete(`type = '${type}'`);

    // Mirror delete to BM25
    try {
      const { getBM25Scorer } = await import('../search/bm25-scorer');
      const bm25 = getBM25Scorer();
      for (const kid of knowledgeIds) {
        bm25.removeDocumentsByPrefix(kid);
      }
    } catch { /* non-fatal */ }

    return count;
  }

  // ─── BM25 Mirroring ─────────────────────────────────────────────

  /**
   * Mirror a batch of items to the BM25 index.
   * Groups items by logical doc ID and concatenates texts before adding,
   * so a milestone with title + facts vectors becomes a single BM25 doc.
   */
  private async mirrorToBM25(items: Array<{ text: string; metadata: VectorMetadata }>): Promise<void> {
    try {
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
      }
    } catch (err) {
      console.error('[VectorStore] BM25 mirror failed:', err);
    }
  }

  /**
   * Bootstrap BM25 index from existing LanceDB vectors.
   * Called during init() when the BM25 index is empty but LanceDB has data.
   * All LanceDB reads run in native Rust threads — no event loop blocking.
   */
  async bootstrapBM25(): Promise<number> {
    try {
      const { getBM25Scorer } = require('../search/bm25-scorer');
      const bm25 = getBM25Scorer();
      const stats = bm25.getStats();

      if (stats.documentCount > 0) return 0; // Already populated

      const totalRows = await this.table.countRows();
      if (totalRows === 0) return 0;

      console.log(`[VectorStore] Bootstrapping BM25 from ${totalRows} LanceDB vectors...`);

      // Fetch all rows (native Rust I/O, does not block event loop)
      const allRows = await this.table.query()
        .where("type IN ('session', 'milestone', 'knowledge')")
        .select(['type', 'sessionId', 'milestoneIndex', 'knowledgeId', 'partId', 'text', 'timestamp', 'projectPath', 'phase'])
        .toArray();

      // Group by logical doc ID
      const grouped = new Map<string, { texts: string[]; meta: VectorMetadata }>();

      for (const row of allRows) {
        const meta = rowToMetadata(row);
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
      }

      // Add docs to BM25 (LMDB writes are fast sync ops)
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
      }

      console.log(`[VectorStore] BM25 bootstrap complete: ${grouped.size} docs from ${allRows.length} vectors`);
      return grouped.size;
    } catch (err) {
      console.error('[VectorStore] BM25 bootstrap failed:', err);
      return 0;
    }
  }

  /**
   * Check if a knowledge document has been indexed
   */
  async hasKnowledge(knowledgeId: string): Promise<boolean> {
    await this.init();
    const count = await this.countWhere(
      `knowledgeId = '${knowledgeId.replace(/'/g, "''")}' AND type = 'knowledge'`
    );
    return count > 0;
  }

  /**
   * Get all unique knowledge IDs in the vector index
   */
  async getIndexedKnowledgeIds(): Promise<string[]> {
    await this.init();
    const rows = await this.table.query()
      .where("type = 'knowledge'")
      .select(['knowledgeId'])
      .toArray();
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.knowledgeId) ids.add(row.knowledgeId);
    }
    return Array.from(ids);
  }

  /**
   * Check if a session has been indexed
   */
  async hasSession(sessionId: string): Promise<boolean> {
    await this.init();
    const count = await this.countWhere(
      `sessionId = '${sessionId.replace(/'/g, "''")}' AND type = 'session'`
    );
    return count > 0;
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

    const total = await this.table.countRows();
    return {
      totalVectors: total,
      isInitialized: true,
    };
  }

  /**
   * Get vector counts broken down by type
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

    const [sessions, milestones, knowledge] = await Promise.all([
      this.countWhere("type = 'session'"),
      this.countWhere("type = 'milestone'"),
      this.countWhere("type = 'knowledge'"),
    ]);

    return {
      totalVectors: sessions + milestones + knowledge,
      sessionVectors: sessions,
      milestoneVectors: milestones,
      knowledgeVectors: knowledge,
      isInitialized: true,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async countWhere(where: string): Promise<number> {
    const rows = await this.table.query().where(where).select(['id']).toArray();
    return rows.length;
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
