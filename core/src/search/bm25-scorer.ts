/**
 * BM25 Scorer — LMDB-backed
 *
 * Okapi BM25 lexical search with LMDB persistence.
 * Zero startup cost (mmap'd reads, no JSON parse), crash-safe writes.
 *
 * LMDB layout (~/.lm-assist/bm25-lmdb/):
 *   terms sub-db:  term   → { [docId]: termFreq }
 *   docs sub-db:   docId  → BM25DocEntry (metadata + terms list)
 *   meta sub-db:   "stats" → { totalDl, docCount }
 */

import { open, type RootDatabase, type Database } from 'lmdb';
import * as path from 'path';
import * as fs from 'fs';
import { tokenize } from './text-scorer';
import { getDataDir } from '../utils/path-utils';

// ─── Types ──────────────────────────────────────────────────

export interface BM25DocMeta {
  type: 'session' | 'milestone' | 'knowledge';
  timestamp: string;
  sessionId: string;
  knowledgeId?: string;
  partId?: string;
  projectPath?: string;
  phase?: number;
}

export interface BM25SearchResult extends BM25DocMeta {
  id: string;
  score: number;
}

interface BM25DocEntry extends BM25DocMeta {
  length: number;    // token count
  terms: string[];   // terms in this doc (for efficient removal)
}

type PostingList = Record<string, number>;  // { docId: termFreq }

// ─── Constants ──────────────────────────────────────────────────

const LMDB_DIR = path.join(getDataDir(), 'bm25-lmdb');
const OLD_JSON_PATH = path.join(getDataDir(), 'bm25-index.json');

// ─── BM25 Scorer ──────────────────────────────────────────────────

export class BM25Scorer {
  private env: RootDatabase;
  private termsDb: Database<PostingList, string>;
  private docsDb: Database<BM25DocEntry, string>;
  private metaDb: Database<any, string>;

  // Cached corpus stats — updated on writes, loaded once from meta
  private totalDl = 0;
  private docCount = 0;

  // BM25 parameters
  private k1 = 1.5;
  private b = 0.5;

  constructor(lmdbDir?: string) {
    const dir = lmdbDir || LMDB_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.env = open({
      path: dir,
      compression: true,        // LZ4 (~5 GB/s decompression)
      maxDbs: 3,
      mapSize: 512 * 1024 * 1024,  // 512 MB
    });

    this.termsDb = this.env.openDB('terms', { encoding: 'msgpack' });
    this.docsDb = this.env.openDB('docs', { encoding: 'msgpack' });
    this.metaDb = this.env.openDB('meta', { encoding: 'msgpack' });

    // Load cached corpus stats
    const stats = this.metaDb.get('stats');
    if (stats) {
      this.totalDl = stats.totalDl || 0;
      this.docCount = stats.docCount || 0;
    }

    // One-time migration from old JSON format
    if (this.docCount === 0) {
      this.migrateFromJson();
    }

    if (this.docCount > 0) {
      console.log(`[BM25Scorer] LMDB ready: ${this.docCount} docs, ${this.termsDb.getCount()} terms`);
    }
  }

  get avgdl(): number {
    return this.docCount === 0 ? 0 : this.totalDl / this.docCount;
  }

  // ─── Write API ──────────────────────────────────────────────────

  addDocument(id: string, text: string, meta: BM25DocMeta): void {
    this.addDocInternal(id, text, meta);
    void this.metaDb.put('stats', { totalDl: this.totalDl, docCount: this.docCount });
  }

  addDocuments(items: Array<{ id: string; text: string } & BM25DocMeta>): void {
    for (const item of items) {
      this.addDocInternal(item.id, item.text, {
        type: item.type,
        timestamp: item.timestamp,
        sessionId: item.sessionId,
        knowledgeId: item.knowledgeId,
        partId: item.partId,
        projectPath: item.projectPath,
        phase: item.phase,
      });
    }
    void this.metaDb.put('stats', { totalDl: this.totalDl, docCount: this.docCount });
  }

  removeDocument(id: string): boolean {
    if (!this.docsDb.get(id)) return false;
    this.removeDocInternal(id);
    void this.metaDb.put('stats', { totalDl: this.totalDl, docCount: this.docCount });
    return true;
  }

  removeDocumentsByPrefix(prefix: string): number {
    const toRemove: string[] = [];
    for (const { key } of this.docsDb.getRange({ start: prefix, end: prefix + '\uffff' })) {
      toRemove.push(key as string);
    }
    for (const id of toRemove) this.removeDocInternal(id);
    if (toRemove.length > 0) {
      void this.metaDb.put('stats', { totalDl: this.totalDl, docCount: this.docCount });
    }
    return toRemove.length;
  }

  // ─── Search API ──────────────────────────────────────────────────

  search(query: string, limit = 10, typeFilter?: string): BM25SearchResult[] {
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0 || this.docCount === 0) return [];

    const N = this.docCount;
    const avgdl = this.totalDl / N;
    const scores = new Map<string, number>();
    const docCache = new Map<string, BM25DocEntry | null>();
    const docTermHits = new Map<string, number>();  // track query-token coverage per doc

    // Path-like queries (contain /): use boolean mode (cap TF at 1).
    // Presence matters more than frequency for specific paths — a focused
    // 40-token doc mentioning the path once should beat a 65-token doc
    // mentioning it 3 times. Length normalization then favors shorter, focused docs.
    const tfCap = query.includes('/') ? 1 : Infinity;

    for (const term of queryTokens) {
      const postings = this.termsDb.get(term);
      if (!postings) continue;

      const df = Object.keys(postings).length;
      const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1));

      for (const [docId, tf] of Object.entries(postings)) {
        // Lazy-load and cache doc metadata
        if (!docCache.has(docId)) {
          const doc = this.docsDb.get(docId) || null;
          if (doc && typeFilter && doc.type !== typeFilter) {
            docCache.set(docId, null);  // filtered out
            continue;
          }
          docCache.set(docId, doc);
        }

        const doc = docCache.get(docId);
        if (!doc) continue;

        const dl = doc.length;
        const effectiveTf = Math.min(tf, tfCap);
        const tfNorm = (effectiveTf * (this.k1 + 1)) / (effectiveTf + this.k1 * (1 - this.b + this.b * dl / avgdl));
        scores.set(docId, (scores.get(docId) || 0) + idf * tfNorm);
        docTermHits.set(docId, (docTermHits.get(docId) || 0) + 1);
      }
    }

    // Token-coverage boost: reward docs matching many unique query tokens.
    // Helps specific multi-token queries (file paths, code identifiers) where
    // individual tokens have low IDF but the full combination is highly specific.
    if (queryTokens.length >= 3) {
      for (const [docId, score] of scores) {
        const hits = docTermHits.get(docId) || 0;
        const coverage = hits / queryTokens.length;
        if (coverage > 0.5) {
          scores.set(docId, score * (1 + coverage));  // 1.5x at 50%, 2.0x at 100%
        }
      }
    }

    // Build results sorted by score
    const results: BM25SearchResult[] = [];
    for (const [id, score] of scores) {
      const doc = docCache.get(id);
      if (!doc) continue;
      results.push({
        id,
        score,
        type: doc.type,
        timestamp: doc.timestamp,
        sessionId: doc.sessionId,
        knowledgeId: doc.knowledgeId,
        partId: doc.partId,
        projectPath: doc.projectPath,
        phase: doc.phase,
      });
    }
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  // ─── Stats ──────────────────────────────────────────────────

  getStats(): { documentCount: number; termCount: number; avgdl: number } {
    return {
      documentCount: this.docCount,
      termCount: this.termsDb.getCount(),
      avgdl: this.avgdl,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private addDocInternal(id: string, text: string, meta: BM25DocMeta): void {
    // Remove existing doc if present (update case)
    if (this.docsDb.get(id)) {
      this.removeDocInternal(id);
    }

    const tokens = tokenize(text);
    if (tokens.length === 0) return;

    // Compute term frequencies
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Update posting lists
    for (const [term, freq] of tf) {
      const postings = this.termsDb.get(term) || {};
      postings[id] = freq;
      void this.termsDb.put(term, postings);
    }

    // Store doc entry with terms list for efficient removal
    void this.docsDb.put(id, {
      length: tokens.length,
      terms: Array.from(tf.keys()),
      ...meta,
    });

    this.totalDl += tokens.length;
    this.docCount++;
  }

  private removeDocInternal(id: string): void {
    const doc = this.docsDb.get(id);
    if (!doc) return;

    // Remove from posting lists using stored terms list
    for (const term of doc.terms) {
      const postings = this.termsDb.get(term);
      if (postings) {
        delete postings[id];
        if (Object.keys(postings).length === 0) {
          void this.termsDb.remove(term);
        } else {
          void this.termsDb.put(term, postings);
        }
      }
    }

    void this.docsDb.remove(id);
    this.totalDl -= doc.length;
    this.docCount--;
  }

  // ─── Migration from old JSON format ──────────────────────────────

  private migrateFromJson(): void {
    if (!fs.existsSync(OLD_JSON_PATH)) return;

    try {
      console.log('[BM25Scorer] Migrating from JSON to LMDB...');
      const raw = fs.readFileSync(OLD_JSON_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (data.version !== 1) return;

      const docs = data.docs as Record<string, any>;
      const invertedIndex = data.invertedIndex as Record<string, Record<string, number>>;

      // Rebuild docTerms from inverted index
      const docTermsMap = new Map<string, string[]>();
      for (const [term, docMap] of Object.entries(invertedIndex)) {
        for (const docId of Object.keys(docMap)) {
          let terms = docTermsMap.get(docId);
          if (!terms) { terms = []; docTermsMap.set(docId, terms); }
          terms.push(term);
        }
        // Write posting list to LMDB
        void this.termsDb.put(term, docMap);
      }

      // Write doc entries to LMDB
      for (const [id, doc] of Object.entries(docs)) {
        const terms = docTermsMap.get(id) || [];
        void this.docsDb.put(id, { ...(doc as object), terms } as BM25DocEntry);
      }

      // Update stats
      this.totalDl = data.totalDl || 0;
      this.docCount = Object.keys(docs).length;
      void this.metaDb.put('stats', { totalDl: this.totalDl, docCount: this.docCount });

      console.log(`[BM25Scorer] Migrated ${this.docCount} docs from JSON to LMDB`);
    } catch (err) {
      console.error('[BM25Scorer] JSON migration failed:', err);
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: BM25Scorer | null = null;

export function getBM25Scorer(): BM25Scorer {
  if (!instance) {
    instance = new BM25Scorer();
  }
  return instance;
}
