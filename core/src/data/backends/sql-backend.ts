// core/src/data/backends/sql-backend.ts
// Structured `sql` backend: one SQLite file per dataset (better-sqlite3, synchronous, CJS).
// Schema faithfully round-trips DataRecord; declared indexedFields become indexed generated
// columns; full-text via an external-content FTS5 table kept in sync by triggers. The engine
// owns version/timestamps/origin (DataService.put) — this backend persists records as handed.
import * as fs from 'fs';
import * as path from 'path';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin, SqlConfig,
} from '../types';
import { isNewer } from '../types';
import { sqlDirFor } from '../paths';
import { compileQuery } from './sql-compiler';
import { getDatasetRegistry } from '../dataset-registry';

const Database = require('better-sqlite3');

/** Sanitize an indexedField path into a safe generated-column name. */
function colName(p: string): string { return 'f_' + p.replace(/[^a-z0-9_]/gi, '_'); }
function isSafeFieldPath(p: string): boolean { return /^[A-Za-z0-9_.]+$/.test(p); }

const SELECT_COLS = 'id, fields, text, metadata, origin, version, created_at, updated_at';

export function rowToRecord(row: any): DataRecord {
  return {
    id: row.id,
    version: row.version,
    fields: JSON.parse(row.fields),
    text: row.text == null ? undefined : row.text,
    metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
    origin: row.origin == null ? undefined : JSON.parse(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function recordParams(rec: DataRecord): Record<string, unknown> {
  return {
    id: rec.id,
    fields: JSON.stringify(rec.fields ?? {}),
    text: rec.text ?? null,
    metadata: rec.metadata == null ? null : JSON.stringify(rec.metadata),
    origin: rec.origin == null ? null : JSON.stringify(rec.origin),
    version: rec.version ?? 0,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

export class SqlBackend implements StorageBackend {
  readonly kind: BackendKind = 'sql';
  private storeDirOverride?: string;
  private dbs = new Map<string, any>();

  constructor(storeDirOverride?: string) { this.storeDirOverride = storeDirOverride; }

  private fileFor(id: string): string {
    return this.storeDirOverride ? path.join(this.storeDirOverride, `${id}.sqlite`) : sqlDirFor(id);
  }

  /** Open (creating + migrating schema if needed) the dataset's db handle. */
  private db(id: string, indexedFields?: Array<{ path: string; type: 'text' | 'number' }>): any {
    let h = this.dbs.get(id);
    if (h) return h;
    const file = this.fileFor(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    h = new Database(file);
    h.pragma('journal_mode = WAL');
    h.exec(`
      CREATE TABLE IF NOT EXISTS records(
        rowid INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        fields TEXT NOT NULL,
        text TEXT,
        metadata TEXT,
        origin TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(text, content='records', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
        INSERT INTO records_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO records_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    // Declared indexed fields → generated columns + indexes (best-effort; skip if already present).
    const existing = new Set((h.prepare(`PRAGMA table_info(records)`).all() as any[]).map((c: any) => c.name));
    for (const f of indexedFields || []) {
      if (!isSafeFieldPath(f.path)) continue;
      const col = colName(f.path);
      if (existing.has(col)) continue;
      const type = f.type === 'number' ? 'REAL' : 'TEXT';
      // json_extract path is a literal built from a VALIDATED path (isSafeFieldPath) — no caller input here.
      h.exec(`ALTER TABLE records ADD COLUMN "${col}" ${type} GENERATED ALWAYS AS (json_extract(fields, '$.${f.path}')) VIRTUAL;`);
      h.exec(`CREATE INDEX IF NOT EXISTS "idx_${col}" ON records("${col}");`);
    }
    this.dbs.set(id, h);
    return h;
  }

  /** The indexedFields a dataset declared (for the query compiler to prefer generated columns). */
  indexedPaths(d: DatasetDescriptor): string[] {
    const c = d.config as SqlConfig;
    return (c.indexedFields || []).filter((f) => isSafeFieldPath(f.path)).map((f) => f.path);
  }

  async createDataset(d: DatasetDescriptor): Promise<void> {
    const c = d.config as SqlConfig;
    this.db(d.id, c.indexedFields);
  }

  async dropDataset(id: string): Promise<void> {
    const h = this.dbs.get(id);
    if (h) { try { h.close(); } catch { /* */ } this.dbs.delete(id); }
    const file = this.fileFor(id);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { if (fs.existsSync(f)) fs.rmSync(f); } catch { /* */ } }
  }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    const row = this.db(dataset).prepare(`SELECT ${SELECT_COLS} FROM records WHERE id = ?`).get(id);
    return row ? rowToRecord(row) : null;
  }

  async put(dataset: string, record: DataRecord): Promise<{ id: string }> {
    const h = this.db(dataset);
    h.prepare(`
      INSERT INTO records(id, fields, text, metadata, origin, version, created_at, updated_at)
      VALUES(@id, @fields, @text, @metadata, @origin, @version, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        fields=excluded.fields, text=excluded.text, metadata=excluded.metadata,
        origin=excluded.origin, version=excluded.version,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `).run(recordParams(record));
    return { id: record.id };
  }

  private indexedFor(dataset: string): Set<string> {
    const d = getDatasetRegistry().get(dataset);
    const c = d?.config as SqlConfig | undefined;
    return new Set((c?.indexedFields || []).filter((f) => isSafeFieldPath(f.path)).map((f) => f.path));
  }

  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const h = this.db(dataset);
    const { where, whereParams, order, orderParams } = compileQuery(q, this.indexedFor(dataset));
    const total = (h.prepare(`SELECT COUNT(*) AS n FROM records ${where}`).get(...whereParams) as any).n as number;
    const limit = q.limit ?? -1;            // sqlite: LIMIT -1 = no limit
    const offset = q.offset ?? 0;
    const rows = h.prepare(`SELECT ${SELECT_COLS} FROM records ${where} ${order} LIMIT ? OFFSET ?`).all(...whereParams, ...orderParams, limit, offset);
    return { records: rows.map(rowToRecord), total };
  }

  async delete(dataset: string, id: string): Promise<boolean> {
    const info = this.db(dataset).prepare(`DELETE FROM records WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  async exportSince(dataset: string, since?: string): Promise<DataRecord[]> {
    const h = this.db(dataset);
    const rows = since
      ? h.prepare(`SELECT ${SELECT_COLS} FROM records WHERE updated_at >= ? ORDER BY updated_at ASC`).all(since)
      : h.prepare(`SELECT ${SELECT_COLS} FROM records ORDER BY updated_at ASC`).all();
    return rows.map(rowToRecord);
  }

  async importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    let applied = 0, skipped = 0;
    for (const incoming of records) {
      const local = await this.get(dataset, incoming.id);
      const stamped: DataRecord = { ...incoming, origin };
      if (isNewer(stamped, local)) { await this.put(dataset, stamped); applied++; } else skipped++;
    }
    return { applied, skipped };
  }

  async admin(dataset: string, op: string, _args?: Record<string, unknown>): Promise<unknown> {
    const h = this.db(dataset);
    switch (op) {
      case 'stats': {
        const n = (h.prepare(`SELECT COUNT(*) AS n FROM records`).get() as any).n;
        return { count: n };
      }
      case 'integrity-check': {
        const r = h.prepare(`PRAGMA integrity_check`).get() as any;
        return { ok: r.integrity_check === 'ok', detail: r.integrity_check };
      }
      case 'vacuum':
        h.exec('VACUUM');
        return { ok: true };
      default:
        throw new Error(`unknown admin op: ${op}`);
    }
  }
}
