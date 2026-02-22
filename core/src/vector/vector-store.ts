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
 * Search modes:
 *   search()       — Pure vector (cosine) similarity search
 *   hybridSearch() — Vector + FTS (full-text) with RRF merge
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
  /** Origin: 'local' (default) or 'remote' (synced from another machine) */
  origin?: 'local' | 'remote';
  /** Machine ID of the source (for remote knowledge) */
  machineId?: string;
  /** Hostname of the source machine */
  machineHostname?: string;
  /** OS platform of the source machine */
  machineOS?: string;
  /** True if remote source no longer has this entry */
  stale?: boolean;
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
  origin?: 'local' | 'remote';
  machineId?: string;
  machineHostname?: string;
  machineOS?: string;
  stale?: boolean;
}

// ─── Reindex Status Tracker ─────────────────────────────────

export interface ReindexStatus {
  type: string | null;
  status: 'idle' | 'running' | 'done' | 'error';
  vectorsIndexed: number;
  startedAt: string | null;
  completedAt: string | null;
}

let _reindexStatus: ReindexStatus = {
  type: null,
  status: 'idle',
  vectorsIndexed: 0,
  startedAt: null,
  completedAt: null,
};

export function getReindexStatus(): ReindexStatus {
  return { ..._reindexStatus };
}

export function setReindexStatus(s: Partial<ReindexStatus>): void {
  Object.assign(_reindexStatus, s);
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
  origin: string;          // 'local' | 'remote' | ''
  machineId: string;       // '' = local
  machineHostname: string; // '' = local
  machineOS: string;       // '' = local
  stale: number;           // 0 = fresh, 1 = stale
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
    origin: meta.origin || '',
    machineId: meta.machineId || '',
    machineHostname: meta.machineHostname || '',
    machineOS: meta.machineOS || '',
    stale: meta.stale ? 1 : 0,
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
    origin: row.origin === 'remote' ? 'remote' : (row.origin === 'local' ? 'local' : undefined),
    machineId: row.machineId || undefined,
    machineHostname: row.machineHostname || undefined,
    machineOS: row.machineOS || undefined,
    stale: row.stale === 1 ? true : undefined,
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

// ─── Entity ID helper ───────────────────────────────────────
// Multiple vector rows map to one logical entity. This derives the entity ID.

function entityId(row: any): string {
  if (row.type === 'knowledge') {
    return row.partId || row.knowledgeId || '';
  } else if (row.type === 'milestone') {
    return `${row.sessionId}:${row.milestoneIndex}`;
  }
  return row.sessionId;
}

// ─── Vector Store ──────────────────────────────────────────────────

const STORE_DIR = path.join(getDataDir(), 'lance-store');
const TABLE_NAME = 'vectors';

/** Minimum cosine similarity to consider a vector result relevant.
 *  Cosine distance ∈ [0, 2]; similarity = 1 - distance/2.
 *  0.57 ≈ weak but non-random relationship. */
const MIN_SIMILARITY = 0.57;

export class VectorStore {
  private db: any = null;
  private table: any = null;
  private storeDir: string;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private ftsReady = false;
  private _reinitAttempted = false;

  constructor(storeDir?: string) {
    this.storeDir = storeDir || STORE_DIR;
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  /**
   * Initialize the LanceDB connection, table, and FTS index.
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
        try {
          this.table = await this.db.openTable(TABLE_NAME);
          // Validate table is readable (detects stale/corrupt data files)
          await this.table.countRows();
          // Schema migration: check if table has required columns (added for remote sync)
          try {
            const schema = await this.table.schema();
            const fieldNames = schema.fields.map((f: any) => f.name);
            if (!fieldNames.includes('origin')) {
              console.warn('[VectorStore] Table missing new columns (origin, machineId, etc.), recreating for schema migration');
              try { await this.db.dropTable(TABLE_NAME); } catch { /* best effort */ }
              this.table = null;
            }
          } catch {
            // If schema check fails, continue with existing table
          }
        } catch (openErr: any) {
          console.warn(`[VectorStore] Existing table corrupt, recreating: ${openErr.message}`);
          try { await this.db.dropTable(TABLE_NAME); } catch { /* best effort */ }
          this.table = null;
        }
      }

      if (!this.table) {
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
          origin: '',
          machineId: '',
          machineHostname: '',
          machineOS: '',
          stale: 0,
        }]);
        try { await this.table.delete(`id = '${seedId}'`); } catch { /* best effort */ }
      }

      this.initialized = true;
      this._reinitAttempted = false;
      console.log('[VectorStore] LanceDB initialized');

      // Create FTS index on text column (async, non-blocking)
      this.ensureFtsIndex().catch(() => {});
    })();

    await this.initializing;
  }

  /**
   * Force re-initialization by resetting state and re-running init().
   * Called when a stale data file reference is detected (e.g. after schema migration
   * in a long-running MCP server process).
   */
  private async reinit(): Promise<void> {
    console.warn('[VectorStore] Reinitializing due to stale data reference');
    this.initialized = false;
    this.initializing = null;
    this.table = null as any;
    this.db = null as any;
    this.ftsReady = false;
    this._reinitAttempted = true;
    await this.init();
  }

  /**
   * Check if an error is a stale LanceDB data file reference and attempt recovery.
   * Returns true if reinit was performed and the caller should retry.
   */
  private async handleLanceError(err: any): Promise<boolean> {
    if (this._reinitAttempted) return false;
    const msg = String(err?.message || err || '');
    // Stale data file reference (e.g. after external schema migration)
    if (msg.includes('Not found') && msg.includes('.lance')) {
      await this.reinit();
      return true;
    }
    // Schema mismatch: table missing columns added in later versions
    if (msg.includes('not in schema') || msg.includes('Found field not in schema')) {
      console.warn(`[VectorStore] Schema mismatch detected, recreating table: ${msg}`);
      await this.reinit();
      return true;
    }
    return false;
  }

  /**
   * Create or recreate the FTS index on the `text` column.
   * Called during init() and after bulk writes that add new data.
   */
  private async ensureFtsIndex(): Promise<void> {
    try {
      const lancedb = require('@lancedb/lancedb');
      await this.table.createIndex('text', {
        config: lancedb.Index.fts({ withPosition: true }),
        replace: true,
      });
      this.ftsReady = true;
    } catch (err: any) {
      console.warn('[VectorStore] FTS index creation failed:', err.message);
      this.ftsReady = false;
    }
  }

  /**
   * Add a single vector with metadata
   */
  async addVector(text: string, metadata: VectorMetadata): Promise<void> {
    await this.init();
    const embedder = getEmbedder();
    const vector = await embedder.embed(text);

    try {
      await this.table.add([metadataToRow(vector, metadata)]);
    } catch (err: any) {
      if (await this.handleLanceError(err)) {
        await this.table.add([metadataToRow(vector, metadata)]);
      } else {
        throw err;
      }
    }
  }

  /**
   * Add multiple vectors in batch (more efficient).
   * Note: FTS index is NOT rebuilt here — call rebuildFtsIndex() explicitly
   * after a full indexing pass to avoid creating orphaned index snapshots.
   */
  async addVectors(items: Array<{ text: string; metadata: VectorMetadata }>): Promise<number> {
    if (items.length === 0) return 0;
    await this.init();

    const WRITE_CHUNK = 50;
    const embedder = getEmbedder();
    let totalAdded = 0;

    const doAdd = async () => {
      for (let offset = totalAdded; offset < items.length; offset += WRITE_CHUNK) {
        const chunk = items.slice(offset, offset + WRITE_CHUNK);
        const texts = chunk.map(i => i.text);
        const vectors = await embedder.embedBatch(texts);

        const rows = chunk.map((item, i) => metadataToRow(vectors[i], item.metadata));
        await this.table.add(rows);

        totalAdded += chunk.length;
      }
    };

    try {
      await doAdd();
    } catch (err: any) {
      if (await this.handleLanceError(err)) {
        await doAdd();
      } else {
        throw err;
      }
    }

    return totalAdded;
  }

  /**
   * Rebuild the FTS index. Call this once after a full indexing pass,
   * not after every addVectors() batch, to prevent orphaned index snapshots.
   */
  async rebuildFtsIndex(): Promise<void> {
    this.ensureFtsIndex().catch(() => {});
  }

  /**
   * Search for similar vectors (pure vector/cosine similarity).
   * @param filter Optional metadata filter (e.g. { type: 'knowledge' })
   */
  async search(query: string, limit: number = 20, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    await this.init();

    const embedder = getEmbedder();
    const queryVector = await embedder.embed(query);

    const doSearch = async () => {
      let q = this.table.search(queryVector).limit(limit);
      if (filter) {
        const where = buildWhere(filter);
        if (where) q = q.where(where);
      }
      return q.toArray();
    };

    let results: any[];
    try {
      results = await doSearch();
    } catch (err: any) {
      if (await this.handleLanceError(err)) {
        results = await doSearch();
      } else {
        throw err;
      }
    }

    // LanceDB returns _distance (L2 or cosine distance). Convert to similarity score.
    // Cosine distance ∈ [0, 2]; similarity = 1 - distance/2 maps to [0, 1].
    return results.map((r: any) => {
      const distance = r._distance ?? 0;
      const score = Math.max(0, 1 - distance / 2);
      return rowToResult(r, score);
    });
  }

  /**
   * Hybrid search: vector similarity + full-text search, merged via RRF.
   *
   * Runs both searches in parallel against the same LanceDB table, deduplicates
   * by entity ID, and combines rankings with Reciprocal Rank Fusion.
   *
   * @param query  Natural language query
   * @param limit  Max results to return
   * @param filter Optional metadata filter (e.g. { type: 'knowledge' })
   */
  async hybridSearch(query: string, limit: number = 20, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    await this.init();

    const embedder = getEmbedder();
    const queryVector = await embedder.embed(query);

    const runSearches = async (): Promise<[any[], any[]]> => {
      const fetchCount = limit * 3; // Over-fetch for dedup + filtering
      const whereClause = filter ? buildWhere(filter) : '';

      // Build vector search query
      let vecQ = this.table.search(queryVector).limit(fetchCount);
      if (whereClause) vecQ = vecQ.where(whereClause);

      // Build FTS query (only if index is ready)
      let ftsPromise: Promise<any[]>;
      if (this.ftsReady) {
        let ftsQ = this.table.query()
          .fullTextSearch(query, { columns: ['text'] })
          .limit(fetchCount);
        if (whereClause) ftsQ = ftsQ.where(whereClause);
        ftsPromise = ftsQ.toArray().catch(() => []);
      } else {
        ftsPromise = Promise.resolve([]);
      }

      return Promise.all([vecQ.toArray(), ftsPromise]);
    };

    let vecResults: any[];
    let ftsResults: any[];
    try {
      [vecResults, ftsResults] = await runSearches();
    } catch (err: any) {
      if (await this.handleLanceError(err)) {
        [vecResults, ftsResults] = await runSearches();
      } else {
        throw err;
      }
    }

    // ─── Deduplicate vector results by entity ID (keep highest similarity) ───
    const vecByEntity = new Map<string, { row: any; sim: number }>();
    for (const r of vecResults) {
      const dist = r._distance ?? 0;
      const sim = Math.max(0, 1 - dist / 2);
      if (sim < MIN_SIMILARITY) continue; // Filter low-similarity noise

      const eid = entityId(r);
      const existing = vecByEntity.get(eid);
      if (!existing || sim > existing.sim) {
        vecByEntity.set(eid, { row: r, sim });
      }
    }

    // ─── Deduplicate FTS results by entity ID (keep highest score) ───
    const ftsByEntity = new Map<string, { row: any; score: number }>();
    for (const r of ftsResults) {
      const eid = entityId(r);
      const score = r._score ?? 0;
      const existing = ftsByEntity.get(eid);
      if (!existing || score > existing.score) {
        ftsByEntity.set(eid, { row: r, score });
      }
    }

    // ─── RRF merge ───────────────────────────────────────────────
    const K = 60;
    const VEC_WEIGHT = 1.0;
    const FTS_WEIGHT = 0.8;

    // Sort by score to establish ranks
    const vecRanked = Array.from(vecByEntity.entries())
      .sort((a, b) => b[1].sim - a[1].sim);
    const ftsRanked = Array.from(ftsByEntity.entries())
      .sort((a, b) => b[1].score - a[1].score);

    // Build 1-indexed rank maps
    const vecRankMap = new Map<string, number>();
    for (let i = 0; i < vecRanked.length; i++) {
      vecRankMap.set(vecRanked[i][0], i + 1);
    }
    const ftsRankMap = new Map<string, number>();
    for (let i = 0; i < ftsRanked.length; i++) {
      ftsRankMap.set(ftsRanked[i][0], i + 1);
    }

    // Collect all entity IDs
    const allEntityIds = new Set([...vecRankMap.keys(), ...ftsRankMap.keys()]);

    // Merge with RRF
    const merged: VectorSearchResult[] = [];
    for (const eid of allEntityIds) {
      const vRank = vecRankMap.get(eid);
      const fRank = ftsRankMap.get(eid);

      let rrfScore = 0;
      if (vRank !== undefined) rrfScore += VEC_WEIGHT / (K + vRank);
      if (fRank !== undefined) rrfScore += FTS_WEIGHT / (K + fRank);

      // Prefer vec row (has all metadata), fall back to FTS row
      const row = vecByEntity.get(eid)?.row ?? ftsByEntity.get(eid)?.row;
      merged.push(rowToResult(row, rrfScore));
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  /**
   * Delete all vectors for a session
   */
  async deleteSession(sessionId: string): Promise<number> {
    await this.init();

    const count = await this.countWhere(`sessionId = '${sessionId.replace(/'/g, "''")}'`);
    if (count === 0) return 0;

    await this.table.delete(`sessionId = '${sessionId.replace(/'/g, "''")}'`);

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

    return count;
  }

  /**
   * Delete vectors for multiple milestones in a single query (batch delete).
   * Much faster than calling deleteMilestone() per milestone.
   */
  async deleteMilestoneBatch(sessionId: string, milestoneIndices: number[]): Promise<void> {
    if (milestoneIndices.length === 0) return;
    await this.init();

    const escapedId = sessionId.replace(/'/g, "''");
    const indexList = milestoneIndices.join(',');
    const where = `sessionId = '${escapedId}' AND type = 'milestone' AND milestoneIndex IN (${indexList})`;
    await this.table.delete(where);
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

    return count;
  }

  /**
   * Delete all vectors of a given type.
   */
  async deleteAllByType(type: 'session' | 'milestone' | 'knowledge'): Promise<number> {
    await this.init();

    const count = await this.countWhere(`type = '${type}'`);
    if (count === 0) return 0;

    await this.table.delete(`type = '${type}'`);

    return count;
  }

  /**
   * Delete all LOCAL vectors of a given type (preserves remote vectors).
   * Used during knowledge reindex to avoid wiping remote synced vectors.
   */
  async deleteLocalByType(type: 'session' | 'milestone' | 'knowledge'): Promise<number> {
    await this.init();

    const where = `type = '${type}' AND (origin = '' OR origin = 'local')`;
    const count = await this.countWhere(where);
    if (count === 0) return 0;

    await this.table.delete(where);

    return count;
  }

  /**
   * Delete remote knowledge vectors for a specific machine + knowledge ID.
   */
  async deleteRemoteKnowledgeVectors(machineId: string, knowledgeId: string): Promise<number> {
    await this.init();

    const escapedMachine = machineId.replace(/'/g, "''");
    const escapedKnowledge = knowledgeId.replace(/'/g, "''");
    const where = `machineId = '${escapedMachine}' AND knowledgeId = '${escapedKnowledge}' AND type = 'knowledge'`;
    const count = await this.countWhere(where);
    if (count === 0) return 0;

    await this.table.delete(where);
    return count;
  }

  /**
   * Delete all remote knowledge vectors for a specific machine.
   */
  async deleteAllRemoteKnowledge(machineId?: string): Promise<number> {
    await this.init();

    let where: string;
    if (machineId) {
      const escaped = machineId.replace(/'/g, "''");
      where = `origin = 'remote' AND machineId = '${escaped}' AND type = 'knowledge'`;
    } else {
      where = `origin = 'remote' AND type = 'knowledge'`;
    }

    const count = await this.countWhere(where);
    if (count === 0) return 0;

    await this.table.delete(where);
    return count;
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
    // Trigger lazy init so status polls auto-connect on server startup
    await this.init();

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
let vectorStore: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!vectorStore) {
    vectorStore = new VectorStore();
  }
  return vectorStore;
}

// Backward compatibility alias
export { VectorStore as VectraStore };
export const getVectraStore = getVectorStore;
