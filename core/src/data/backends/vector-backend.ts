// core/src/data/backends/vector-backend.ts
// Generic vector (RAG) backend. One LanceDB table per dataset (`ds_<id>`) in a
// dedicated store dir, isolated from the knowledge `lance-store/vectors` table.
// The full DataRecord is persisted as JSON in a `doc` column (faithful round-trip);
// `vector`/`text` power semantic + full-text search; `version`/`updatedAt` power
// export watermarking and LWW. Embedding is injectable for hermetic tests.
import * as fs from 'fs';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin,
} from '../types';
import { isNewer } from '../types';
import { applyQuery, matches } from './query-filter';
import { getEmbedder, VECTOR_DIM } from '../../vector/embedder';
import { vectorStoreDir } from '../paths';

const lancedb = require('@lancedb/lancedb');

// RRF + similarity constants — kept identical to core/src/vector/vector-store.ts.
const RRF_K = 60;
const VEC_WEIGHT = 1.0;
const FTS_WEIGHT = 0.8;
const MIN_SIMILARITY = 0.57;

interface LanceDoc {
  id: string;
  vector: number[];
  text: string;
  doc: string;       // JSON.stringify(DataRecord) — source of truth
  version: number;
  updatedAt: string;
}

function tableName(datasetId: string): string { return `ds_${datasetId}`; }
function esc(v: string): string { return v.replace(/'/g, "''"); }

/** Text we embed + FTS-index: the record's text, else its string fields, else its id. */
function embedText(rec: DataRecord): string {
  if (rec.text && rec.text.trim()) return rec.text;
  const parts = Object.values(rec.fields || {}).filter((v): v is string => typeof v === 'string');
  const joined = parts.join(' ').trim();
  return joined || rec.id;
}

export class VectorBackend implements StorageBackend {
  readonly kind: BackendKind = 'vector';
  private storeDir: string;
  private embedFn: (text: string) => Promise<number[]>;
  private dbPromise: Promise<any> | null = null;
  private tables = new Map<string, any>();
  private opening = new Map<string, Promise<any>>();
  private ftsDirty = new Set<string>();

  constructor(opts?: { storeDir?: string; embed?: (text: string) => Promise<number[]> }) {
    this.storeDir = opts?.storeDir || vectorStoreDir();
    this.embedFn = opts?.embed || ((t: string) => getEmbedder().embed(t));
    if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
  }

  private db(): Promise<any> {
    if (!this.dbPromise) this.dbPromise = lancedb.connect(this.storeDir);
    return this.dbPromise!;
  }

  /** Open the dataset's table, or null if it doesn't exist yet. */
  private async openOrNull(datasetId: string): Promise<any | null> {
    const cached = this.tables.get(datasetId);
    if (cached) return cached;
    const db = await this.db();
    const names: string[] = await db.tableNames();
    if (!names.includes(tableName(datasetId))) return null;
    const t = await db.openTable(tableName(datasetId));
    this.tables.set(datasetId, t);
    return t;
  }

  /** Open the dataset's table, creating it (seed-then-delete for schema inference) if absent.
   *  Concurrency-safe: serializes concurrent first-opens per dataset and falls back to
   *  openTable if it loses a create race (mirrors VectorStore.init()'s `initializing` guard). */
  private async tableFor(datasetId: string): Promise<any> {
    const cached = this.tables.get(datasetId);
    if (cached) return cached;
    let inflight = this.opening.get(datasetId);
    if (!inflight) {
      inflight = (async () => {
        const existing = await this.openOrNull(datasetId);
        if (existing) return existing;
        const db = await this.db();
        const seed: LanceDoc = {
          id: '__seed__', vector: new Array(VECTOR_DIM).fill(0), text: '', doc: '', version: 0, updatedAt: '',
        };
        let t: any;
        try {
          t = await db.createTable(tableName(datasetId), [seed]);
          try { await t.delete("id = '__seed__'"); } catch { /* best effort */ }
        } catch {
          // Lost a create race (table already exists) — open the existing one.
          t = await db.openTable(tableName(datasetId));
        }
        this.tables.set(datasetId, t);
        return t;
      })();
      this.opening.set(datasetId, inflight);
    }
    try { return await inflight; }
    finally { this.opening.delete(datasetId); }
  }

  async createDataset(d: DatasetDescriptor): Promise<void> { await this.tableFor(d.id); }

  async dropDataset(id: string): Promise<void> {
    const db = await this.db();
    try { await db.dropTable(tableName(id)); } catch { /* best effort */ }
    this.tables.delete(id);
    this.ftsDirty.delete(id);
  }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    const table = await this.openOrNull(dataset);
    if (!table) return null;
    const rows = await table.query().where(`id = '${esc(id)}'`).select(['doc']).toArray();
    if (!rows.length) return null;
    return JSON.parse(rows[0].doc) as DataRecord;
  }

  private async row(rec: DataRecord): Promise<LanceDoc> {
    const text = embedText(rec);
    const vector = await this.embedFn(text);
    return { id: rec.id, vector, text, doc: JSON.stringify(rec), version: rec.version ?? 0, updatedAt: rec.updatedAt };
  }

  private async upsert(table: any, rows: LanceDoc[]): Promise<void> {
    await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }

  async put(dataset: string, record: DataRecord): Promise<{ id: string }> {
    const table = await this.tableFor(dataset);
    await this.upsert(table, [await this.row(record)]);
    this.ftsDirty.add(dataset);
    return { id: record.id };
  }

  // query added in Task 4; search in Task 5; exportSince/importBatch in Task 6.
  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const table = await this.openOrNull(dataset);
    if (!table) return { records: [], total: 0 };
    const rows = await table.query().select(['doc']).toArray();
    const records = rows.map((r: any) => JSON.parse(r.doc) as DataRecord);
    return applyQuery(records, q);
  }

  async delete(dataset: string, id: string): Promise<boolean> {
    const table = await this.openOrNull(dataset);
    if (!table) return false;
    if (!(await this.get(dataset, id))) return false;
    await table.delete(`id = '${esc(id)}'`);
    this.ftsDirty.add(dataset);
    return true;
  }

  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> { throw new Error('not implemented'); }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> { throw new Error('not implemented'); }
}
