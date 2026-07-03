/**
 * Bus storage (spec §5 S1) — LMDB, mirroring memory-cache-store.ts's open/keying
 * idiom. Three sub-dbs under a dev/prod-separated `bus.lmdb`:
 *   events  key [topic, origin, seq]        → BusEvent      (the append-only log)
 *   heads   key [topic, origin]             → seq (number)  (per-origin high-water)
 *   cursors key [subscriberId, topic]       → BusCursor     (durable subscriber pos)
 * Array keys use LMDB's default ordered-binary key encoding (element-wise sort),
 * so a `[topic]`-prefixed getRange walks a topic in (origin, seq) order. Ingest
 * is idempotent: a key that already exists is a no-op (no LWW, no conflicts).
 */
import { open, RootDatabase, Database } from 'lmdb';
import * as fs from 'fs';
import { getCacheDir } from '../utils/path-utils';
import type { BusEvent, BusCursor } from './types';
import { mergeCursor } from './types';

export interface TopicSummary {
  topic: string;
  events: number;
  origins: number;
  oldestAt: number | null;
  newestAt: number | null;
  head: BusCursor;
}

type EventKey = [string, string, number];
type HeadKey = [string, string];
type CursorKey = [string, string];

export class BusStore {
  private env: RootDatabase;
  private events: Database<BusEvent, EventKey>;
  private heads: Database<number, HeadKey>;
  private cursors: Database<BusCursor, CursorKey>;
  private seqCache = new Map<string, number>(); // `${topic} ${origin}` → last seq
  private _closed = false;

  constructor(dir?: string) {
    const d = dir || getCacheDir('bus');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    this.env = open({ path: d, compression: true, maxDbs: 4, mapSize: 2 * 1024 * 1024 * 1024 });
    this.events = this.env.openDB('events', { encoding: 'msgpack' });
    this.heads = this.env.openDB('heads', { encoding: 'msgpack' });
    this.cursors = this.env.openDB('cursors', { encoding: 'msgpack' });
  }

  private hk(topic: string, origin: string): string { return `${topic} ${origin}`; }

  private storedHead(topic: string, origin: string): number {
    const k = this.hk(topic, origin);
    const cached = this.seqCache.get(k);
    if (cached !== undefined) return cached;
    const h = this.heads.get([topic, origin]) ?? 0;
    this.seqCache.set(k, h);
    return h;
  }

  /** Reserve the next per-origin seq (monotonic, cached so rapid publishes don't collide). */
  nextSeq(topic: string, origin: string): number {
    const next = this.storedHead(topic, origin) + 1;
    this.seqCache.set(this.hk(topic, origin), next);
    return next;
  }

  private bumpHead(topic: string, origin: string, seq: number): void {
    const k = this.hk(topic, origin);
    const cur = this.seqCache.get(k) ?? this.heads.get([topic, origin]) ?? 0;
    if (seq > cur) this.seqCache.set(k, seq);
    // putSync (not put): this class's whole API is synchronous — nextSeq/storedHead
    // and ingest's idempotency check read back in the same tick, and lmdb-js's async
    // put() batches writes so a same-process get() right after does NOT see them yet
    // (verified: only putSync gives same-tick read-your-writes here). putSync also
    // persists durably, so reopen after close() still resumes from the true head.
    this.heads.putSync([topic, origin], Math.max(cur, seq));
  }

  append(e: BusEvent): void {
    this.events.putSync([e.topic, e.origin, e.seq], e);
    this.bumpHead(e.topic, e.origin, e.seq);
  }

  /** Idempotent merge: returns false if (topic,origin,seq) already exists. */
  ingest(e: BusEvent): boolean {
    if (this.events.get([e.topic, e.origin, e.seq]) !== undefined) return false;
    this.events.putSync([e.topic, e.origin, e.seq], e);
    this.bumpHead(e.topic, e.origin, e.seq);
    return true;
  }

  get(topic: string, origin: string, seq: number): BusEvent | undefined {
    return this.events.get([topic, origin, seq]);
  }

  readSince(topic: string, cursor: BusCursor, limit = 10_000): BusEvent[] {
    const out: BusEvent[] = [];
    for (const { key, value } of this.events.getRange({ start: [topic] })) {
      const k = key as EventKey;
      if (!Array.isArray(k) || k[0] !== topic) break; // left the topic prefix
      if (k[2] > (cursor[k[1]] ?? 0)) out.push(value);
      if (out.length >= limit) break;
    }
    return out;
  }

  maxCursor(topic: string): BusCursor {
    const out: BusCursor = {};
    for (const { key, value } of this.heads.getRange({ start: [topic] })) {
      const k = key as HeadKey;
      if (!Array.isArray(k) || k[0] !== topic) break;
      out[k[1]] = value;
    }
    return out;
  }

  allTopicNames(): string[] {
    const seen = new Set<string>();
    for (const { key } of this.heads.getRange({})) {
      const k = key as HeadKey;
      if (Array.isArray(k) && typeof k[0] === 'string') seen.add(k[0]);
    }
    return [...seen];
  }

  listTopics(): TopicSummary[] {
    return this.allTopicNames().map((topic) => {
      let events = 0;
      let oldestAt: number | null = null;
      let newestAt: number | null = null;
      const origins = new Set<string>();
      for (const { key, value } of this.events.getRange({ start: [topic] })) {
        const k = key as EventKey;
        if (!Array.isArray(k) || k[0] !== topic) break;
        events++;
        origins.add(k[1]);
        oldestAt = oldestAt === null ? value.at : Math.min(oldestAt, value.at);
        newestAt = newestAt === null ? value.at : Math.max(newestAt, value.at);
      }
      return { topic, events, origins: origins.size, oldestAt, newestAt, head: this.maxCursor(topic) };
    });
  }

  getCursor(subscriberId: string, topic: string): BusCursor {
    return this.cursors.get([subscriberId, topic]) ?? {};
  }

  setCursor(subscriberId: string, topic: string, c: BusCursor): void {
    this.cursors.putSync([subscriberId, topic], mergeCursor(this.getCursor(subscriberId, topic), c));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.env.close();
  }
}
