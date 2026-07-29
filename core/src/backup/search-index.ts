/**
 * Search index over the backup — the reason `backup_search` is not a full scan.
 *
 * THE CONSTRAINT. The 117 snapshot is ~2 GB and 90,414 entries inside a single
 * `.tar.gz`. You cannot grep it without decompressing it, and decompressing it
 * per query is not a search feature, it is a restore. So the index is built
 * WHILE the archive is already being streamed, and queries never touch the
 * archive at all — only `backup_read` does, and then only for one member.
 *
 * WHAT CARRIES TEXT. Indexing every byte would make the index as big as the
 * backup and drown real hits in tool-call noise: the overwhelming majority of
 * those 90,414 entries are tool payloads. So sessions contribute user prompts
 * and assistant prose only; memory, rules and conversations are indexed in
 * full; everything else is metadata-only and still findable by path.
 *
 * better-sqlite3 is a NATIVE module and is loaded LAZILY on purpose — a node
 * installed with `--ignore-scripts` has no compiled binding, and the rest of
 * the backup (capture, status, removal) must keep working there. Missing
 * bindings degrade to "index unavailable", never to a broken backup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { BackupConfig } from './config';
import { storePaths } from './config';

export type ItemKind = 'session' | 'memory' | 'rule' | 'conversation' | 'file';

/**
 * WHICH physical subtree of the store holds this item.
 *
 * Not derivable from `source` + `path`: node 107's `rules/CLAUDE.md` is
 * captured twice — once by the whole-`.claude` mirror and once by the
 * memory-rules extract — with the same source and the same logical path.
 * Without this column `backup_remove` could not tell which copy it was asked
 * to delete, and `backup_read` could not find either.
 */
export type StoreArea = 'mirror' | 'snapshot' | 'claudeai' | 'memory-rules';

export interface IndexItem {
  id: string;
  kind: ItemKind;
  source: string;
  store: StoreArea;
  project: string;
  /** Logical path within the captured `.claude` (POSIX separators). */
  path: string;
  /** '' for an extracted tree; else the snapshot filename holding this item. */
  container: string;
  /** Tar member path when `container` is set. */
  member: string;
  title: string;
  mtime: number;
  size: number;
  text: string;
}

export interface SearchHit extends Omit<IndexItem, 'text'> {
  excerpt: string;
}

export interface IndexMeta {
  available: boolean;
  reason?: string;
  indexedAt: number | null;
  rows: number;
  byKind: Record<string, number>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let Database: any = null;
let loadError: string | null = null;

function loadDriver(): any {
  if (Database) return Database;
  if (loadError) throw new Error(loadError);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Database = require('better-sqlite3');
    return Database;
  } catch (e) {
    loadError =
      'search index unavailable: better-sqlite3 has no compiled binding on this node ' +
      `(${e instanceof Error ? e.message : String(e)}). Backup and removal still work; ` +
      'run `npm rebuild better-sqlite3` on the collector to enable search.';
    throw new Error(loadError);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT 'mirror', project TEXT,
  path TEXT NOT NULL, container TEXT NOT NULL DEFAULT '', member TEXT NOT NULL DEFAULT '',
  title TEXT, mtime INTEGER, size INTEGER, capturedAt INTEGER);
CREATE INDEX IF NOT EXISTS items_kind_source ON items(kind, source);
CREATE INDEX IF NOT EXISTS items_container ON items(container);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  id UNINDEXED, title, text, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`;

export function itemId(source: string, container: string, member: string): string {
  return crypto.createHash('sha1').update(`${source}|${container}|${member}`).digest('hex').slice(0, 16);
}

export class BackupIndex {
  private db: any;
  /* Statements are prepared ONCE and reused. Preparing inside the loop instead
   * costs a compile per row, and a snapshot walk is 90,414 rows — the difference
   * between a batched insert and a stall long enough to look like a hang. */
  private stmt!: {
    delFts: any; delItem: any; insItem: any; insFts: any;
    idsInContainer: any; getItem: any;
  };

  constructor(cfg: BackupConfig, readonly = false) {
    const Driver = loadDriver();
    const file = storePaths(cfg).indexDb;
    if (readonly && !fs.existsSync(file)) throw new Error('no index yet — run backup_run to build one');
    // The store root may not exist yet on a first run; sqlite will not create it.
    if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Driver(file, { readonly });
    if (!readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.exec(SCHEMA);
    }
    this.stmt = {
      delFts: this.db.prepare('DELETE FROM items_fts WHERE id = ?'),
      delItem: this.db.prepare('DELETE FROM items WHERE id = ?'),
      insItem: this.db.prepare(
        `INSERT INTO items(id,kind,source,store,project,path,container,member,title,mtime,size,capturedAt)
         VALUES(@id,@kind,@source,@store,@project,@path,@container,@member,@title,@mtime,@size,@capturedAt)
         ON CONFLICT(id) DO UPDATE SET kind=@kind,source=@source,store=@store,project=@project,
           path=@path,container=@container,member=@member,title=@title,mtime=@mtime,size=@size,
           capturedAt=@capturedAt`),
      insFts: this.db.prepare('INSERT INTO items_fts(id,title,text) VALUES(?,?,?)'),
      idsInContainer: this.db.prepare('SELECT id FROM items WHERE container = ?'),
      getItem: this.db.prepare('SELECT * FROM items WHERE id = ?'),
    };
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  /** Replace an item wholesale — capture is idempotent, so upsert not insert. */
  upsert(item: IndexItem, capturedAt = Date.now()): void {
    this.stmt.delFts.run(item.id);
    // Bind an EXPLICIT row: better-sqlite3 rejects an `undefined` value, and
    // `text` belongs to the FTS table, not this one. Spreading the item would
    // smuggle it in and fail on the first insert.
    this.stmt.insItem.run({
      id: item.id, kind: item.kind, source: item.source, store: item.store,
      project: item.project ?? '', path: item.path, container: item.container,
      member: item.member, title: item.title ?? '', mtime: Math.floor(item.mtime) || 0,
      size: item.size ?? 0, capturedAt,
    });
    this.stmt.insFts.run(item.id, item.title ?? '', item.text ?? '');
  }

  /** Batched upsert — one transaction per snapshot keeps a 90K-entry walk fast. */
  upsertMany(items: IndexItem[], capturedAt = Date.now()): number {
    const tx = this.db.transaction((rows: IndexItem[]) => {
      for (const r of rows) this.upsert(r, capturedAt);
    });
    tx(items);
    return items.length;
  }

  /** Drop everything belonging to one container (a snapshot being replaced). */
  dropContainer(container: string): number {
    const ids = this.stmt.idsInContainer.all(container) as { id: string }[];
    const tx = this.db.transaction(() => {
      for (const { id } of ids) { this.stmt.delFts.run(id); this.stmt.delItem.run(id); }
    });
    tx();
    return ids.length;
  }

  deleteItem(id: string): void {
    this.stmt.delFts.run(id);
    this.stmt.delItem.run(id);
  }

  get(id: string): Omit<IndexItem, 'text'> | null {
    return (this.stmt.getItem.get(id) as any) || null;
  }

  setIndexedAt(ts = Date.now()): void {
    this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run('indexedAt', String(ts));
  }

  meta(): IndexMeta {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('indexedAt') as { v: string } | undefined;
    const rows = (this.db.prepare('SELECT COUNT(*) c FROM items').get() as { c: number }).c;
    const byKind: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT kind, COUNT(*) c FROM items GROUP BY kind').all() as
      { kind: string; c: number }[]) byKind[r.kind] = r.c;
    return { available: true, indexedAt: row ? Number(row.v) : null, rows, byKind };
  }

  /**
   * Browse WITHOUT a query — what is actually in the backup.
   *
   * Search cannot answer "what do you have"; it needs a term, and guessing terms
   * to discover content is not discovery. Ordered newest-first and paged like
   * everything else, because the honest answer to "list the backup" is a window
   * onto 90,000+ items, never the items themselves.
   */
  list(opts: {
    source?: string; kind?: string; project?: string; prefix?: string;
    container?: string; limit: number; offset: number;
  }): { rows: Omit<IndexItem, 'text'>[]; total: number } {
    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (opts.source) { where.push('source = ?'); args.push(opts.source); }
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    if (opts.container) { where.push('container = ?'); args.push(opts.container); }
    if (opts.project) { where.push('project LIKE ?'); args.push(`%${opts.project}%`); }
    // LIKE metacharacters in a user prefix would silently widen the match, so
    // they are escaped rather than passed through.
    if (opts.prefix) {
      where.push("path LIKE ? ESCAPE '\\'");
      args.push(`${opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const clause = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM items WHERE ${clause}`)
      .get(...args) as { c: number }).c;
    const rows = this.db.prepare(
      `SELECT id,kind,source,store,project,path,container,member,title,mtime,size
       FROM items WHERE ${clause} ORDER BY mtime DESC, path ASC LIMIT ? OFFSET ?`,
    ).all(...args, opts.limit, opts.offset) as Omit<IndexItem, 'text'>[];
    return { rows, total };
  }

  /**
   * The shape of the whole backup in a fixed number of rows.
   *
   * Deliberately AGGREGATES rather than samples: counts per source and kind, and
   * the snapshots held per source. This is the one call whose size does not grow
   * with the backup — five sources times five kinds, plus the retained snapshots
   * (5 per host by policy) — so it is safe to make the default landing view.
   */
  overview(): {
    bySource: { source: string; kind: string; count: number; bytes: number; newest: number }[];
    snapshots: { source: string; container: string; count: number }[];
    totals: { items: number; bytes: number };
  } {
    const bySource = this.db.prepare(
      `SELECT source, kind, COUNT(*) count, COALESCE(SUM(size),0) bytes, COALESCE(MAX(mtime),0) newest
       FROM items GROUP BY source, kind ORDER BY source, kind`,
    ).all() as { source: string; kind: string; count: number; bytes: number; newest: number }[];
    const snapshots = this.db.prepare(
      `SELECT source, container, COUNT(*) count FROM items WHERE container != ''
       GROUP BY source, container ORDER BY source, container DESC`,
    ).all() as { source: string; container: string; count: number }[];
    const t = this.db.prepare('SELECT COUNT(*) items, COALESCE(SUM(size),0) bytes FROM items')
      .get() as { items: number; bytes: number };
    return { bySource, snapshots, totals: t };
  }

  search(opts: {
    q: string; kind?: string; source?: string; project?: string;
    since?: number; limit: number; offset: number;
  }): { hits: SearchHit[]; total: number } {
    const where: string[] = ['items_fts MATCH ?'];
    const args: unknown[] = [ftsQuery(opts.q)];
    if (opts.kind) { where.push('i.kind = ?'); args.push(opts.kind); }
    if (opts.source) { where.push('i.source = ?'); args.push(opts.source); }
    if (opts.project) { where.push('i.project LIKE ?'); args.push(`%${opts.project}%`); }
    if (opts.since) { where.push('i.mtime >= ?'); args.push(opts.since); }
    const clause = where.join(' AND ');

    const total = (this.db.prepare(
      `SELECT COUNT(*) c FROM items_fts f JOIN items i ON i.id = f.id WHERE ${clause}`,
    ).get(...args) as { c: number }).c;

    const hits = this.db.prepare(
      `SELECT i.id,i.kind,i.source,i.store,i.project,i.path,i.container,i.member,i.title,i.mtime,i.size,
              snippet(items_fts, 2, '«', '»', ' … ', 14) AS excerpt
       FROM items_fts f JOIN items i ON i.id = f.id
       WHERE ${clause} ORDER BY bm25(items_fts) LIMIT ? OFFSET ?`,
    ).all(...args, opts.limit, opts.offset) as SearchHit[];

    return { hits, total };
  }
}

/**
 * Turn user input into a query FTS5 will accept.
 *
 * A bare `q` containing `-`, `:` or an unbalanced quote is a SYNTAX ERROR in
 * FTS5, which would surface as an opaque failure on an ordinary-looking search
 * ("claude-backup", "error:"). Bare words keep their operators; anything else is
 * quoted into a phrase, which is what a user typing punctuation almost always
 * means anyway.
 */
export function ftsQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return '""';
  if (/^[\w\s*]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

/** Open the index for reading, reporting unavailability rather than throwing. */
export function openForRead(cfg: BackupConfig): { index: BackupIndex | null; meta: IndexMeta } {
  try {
    const index = new BackupIndex(cfg, true);
    return { index, meta: index.meta() };
  } catch (e) {
    return {
      index: null,
      meta: {
        available: false,
        reason: e instanceof Error ? e.message : String(e),
        indexedAt: null, rows: 0, byKind: {},
      },
    };
  }
}
