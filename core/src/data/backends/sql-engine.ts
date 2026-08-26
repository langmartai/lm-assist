// core/src/data/backends/sql-engine.ts
// The SYNCHRONOUS SQLite engine (better-sqlite3, CJS). Runs INSIDE the sql worker
// thread (see sql-worker.ts) so its blocking native calls never stall the main :3100
// event loop. The main-thread proxy is sql-backend.ts. Registry/business logic stays
// on the main thread — query() receives the resolved indexed-field set as a param.
// Schema faithfully round-trips DataRecord; declared indexedFields become indexed generated
// columns; full-text via an external-content FTS5 table kept in sync by triggers. The engine
// owns version/timestamps/origin (DataService.put) — this backend persists records as handed.
import * as fs from 'fs';
import { isDangerousPattern, safeTest } from './query-filter';
import * as path from 'path';
import type {
  BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin, SqlConfig,
} from '../types';
import { isNewer } from '../types';
import { sqlDirFor } from '../paths';
import { compileQuery } from './sql-compiler';
import { buildFtsMatch } from './fts-query';

// better-sqlite3 is a NATIVE module loaded LAZILY: importing/constructing SqlBackend must NOT
// require it, so Core boots on a node where the binary is absent/ABI-mismatched (sql is simply
// unavailable there — the rest of the data service works). Only actual sql operations load it.
let _Database: any = null;
function sqlite(): any {
  if (_Database) return _Database;
  try {
    _Database = require('better-sqlite3');
  } catch (e) {
    throw new Error(`sql backend unavailable: better-sqlite3 could not be loaded — install it on this node (${e instanceof Error ? e.message : String(e)})`);
  }
  return _Database;
}

/** Sanitize an indexedField path into a safe generated-column name. */
function colName(p: string): string { return 'f_' + p.replace(/[^a-z0-9_]/gi, '_'); }
function isSafeFieldPath(p: string): boolean { return /^[A-Za-z0-9_.]+$/.test(p); }

// Table-qualified because the fts path JOINs records_fts, which also has a `text`
// column — an unqualified list is an "ambiguous column name" error the moment ranking
// is switched on. Qualification is harmless for the non-join queries (same table name)
// and the returned column names are unchanged, so rowToRecord is unaffected.
const SELECT_COLS = 'records.id, records.fields, records.text, records.metadata, records.origin, records.version, records.deleted, records.created_at, records.updated_at';
/** Same shape, but `text` is not read off disk (NULL keeps rowToRecord's contract). */
const SELECT_COLS_NO_TEXT = SELECT_COLS.replace('records.text', 'NULL AS text');

export function rowToRecord(row: any): DataRecord {
  return {
    id: row.id,
    version: row.version,
    fields: JSON.parse(row.fields),
    text: row.text == null ? undefined : row.text,
    metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
    origin: row.origin == null ? undefined : JSON.parse(row.origin),
    // Top-level tombstone flag (deletion reconciliation): 0 → undefined so a live
    // record's shape matches the other backends (`deleted` only present when true).
    deleted: row.deleted ? true : undefined,
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
    // Losing this flag here turns DataService.del's tombstone into a LIVE record with
    // blanked fields on read-back — the delete "succeeds", deletes nothing, and the
    // blanking replicates fleet-wide. It must round-trip losslessly.
    deleted: rec.deleted === true ? 1 : 0,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

export class SqlEngine {
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
    h = new (sqlite())(file);
    h.pragma('journal_mode = WAL');
    h.pragma('busy_timeout = 5000');           // don't block the loop indefinitely on lock contention
    h.pragma('wal_autocheckpoint = 1000');
    h.pragma('journal_size_limit = 67108864'); // truncate the -wal back to <=64MB at checkpoint
    // `col REGEXP ?` support for the regex query op (SQLite has GLOB native but not REGEXP).
    // Compiled patterns are bounded-cached; an invalid pattern matches nothing (never throws into SQLite).
    const reCache = new Map<string, RegExp | null>();
    h.function('regexp', { deterministic: true }, (pattern: string, val: unknown) => {
      if (val === null || val === undefined) return 0;
      let re = reCache.get(pattern);
      if (re === undefined) {
        try { re = isDangerousPattern(pattern) ? null : new RegExp(pattern); } catch { re = null; } // ReDoS guard
        if (reCache.size > 500) reCache.clear();
        reCache.set(pattern, re);
      }
      return re && safeTest(re, String(val)) ? 1 : 0;
    });
    h.exec(`
      CREATE TABLE IF NOT EXISTS records(
        rowid INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        fields TEXT NOT NULL,
        text TEXT,
        metadata TEXT,
        origin TEXT,
        version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
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
    //
    // table_xinfo, NOT table_info: `PRAGMA table_info` OMITS generated columns entirely
    // (both VIRTUAL and STORED), so it reports a dataset that already HAS its indexed
    // columns as having none. The ALTERs below are then re-issued on every fresh open and
    // throw "duplicate column name" — meaning any sql dataset declaring indexedFields
    // opened fine when created and failed for good on the next process to touch it, i.e.
    // after the first Core restart. table_xinfo lists them (hidden=2 virtual, 3 stored).
    const existing = new Set((h.prepare(`PRAGMA table_xinfo(records)`).all() as any[]).map((c: any) => c.name));
    // Idempotent migration for DBs created before the tombstone column existed —
    // same PRAGMA-guarded ALTER pattern as the indexed-field columns below.
    if (!existing.has('deleted')) {
      h.exec(`ALTER TABLE records ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;`);
    }
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
      INSERT INTO records(id, fields, text, metadata, origin, version, deleted, created_at, updated_at)
      VALUES(@id, @fields, @text, @metadata, @origin, @version, @deleted, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        fields=excluded.fields, text=excluded.text, metadata=excluded.metadata,
        origin=excluded.origin, version=excluded.version, deleted=excluded.deleted,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `).run(recordParams(record));
    return { id: record.id };
  }

  async query(dataset: string, q: QuerySpec, indexed: string[] = []): Promise<{ records: DataRecord[]; total?: number }> {
    const h = this.db(dataset);
    // `q.fts` is RAW HUMAN TEXT, never FTS5 syntax. It is compiled to a quoted-literal
    // MATCH expression here so no caller can hand FTS5 a grammar it will either misread
    // (a leading `-` silently becoming NOT) or throw a syntax error on. A query whose
    // terms are all stopwords/punctuation yields no expression: that is an empty result,
    // not an unfiltered one — falling through to a bare scan would return the whole table
    // for a query that matched nothing.
    let spec = q;
    if (q.fts) {
      const match = buildFtsMatch(q.fts, q.ftsMode === 'or' ? 'or' : 'and');
      if (!match) return { records: [], total: 0 };
      spec = { ...q, fts: match };
    }
    const { join, where, whereParams, order, orderParams } = compileQuery(spec, new Set(indexed));
    const limit = q.limit ?? 1000;          // finite default — never an unbounded full-table materialization
    const offset = q.offset ?? 0;
    const cols = q.omitText ? SELECT_COLS_NO_TEXT : SELECT_COLS;
    const rows = h.prepare(`SELECT ${cols} FROM records ${join} ${where} ${order} LIMIT ? OFFSET ?`).all(...whereParams, ...orderParams, limit, offset);
    // Exact total for free when the page isn't full; only pay the COUNT scan when results are truncated.
    // The COUNT must carry the same JOIN as the page query — dropping it would count the
    // whole table and report a match-everything total next to a correctly filtered page.
    const total = rows.length < limit
      ? offset + rows.length
      : q.countTotal === false
        ? undefined
        : (h.prepare(`SELECT COUNT(*) AS n FROM records ${join} ${where}`).get(...whereParams) as any).n as number;
    return { records: rows.map(rowToRecord), total };
  }

  async delete(dataset: string, id: string): Promise<boolean> {
    const info = this.db(dataset).prepare(`DELETE FROM records WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  async exportSince(dataset: string, since?: string): Promise<DataRecord[]> {
    const h = this.db(dataset);
    const rows = since
      ? h.prepare(`SELECT ${SELECT_COLS} FROM records WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 50000`).all(since)
      : h.prepare(`SELECT ${SELECT_COLS} FROM records ORDER BY updated_at ASC LIMIT 50000`).all();
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

  /** Run a single READ-ONLY SELECT on a fresh readonly connection. Throws on writes/multi-statement. */
  rawSelect(dataset: string, sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const file = this.fileFor(dataset);
    if (!fs.existsSync(file)) return [];
    const ro = new (sqlite())(file, { readonly: true, fileMustExist: true });
    ro.pragma('busy_timeout = 5000');
    try {
      const stmt = ro.prepare(sql);          // throws "source contained more than one statement" on multi
      if (!stmt.reader) throw new Error('only read-only SELECT statements are allowed');
      return stmt.all(...(params || [])) as Array<Record<string, unknown>>;
    } finally {
      try { ro.close(); } catch { /* */ }
    }
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
