/**
 * Bus storage (spec §5 S1) — LMDB, mirroring memory-cache-store.ts's open/keying
 * idiom. Three sub-dbs under a dev/prod-separated `bus.lmdb`:
 *   events  key [topic, origin, seq]        → BusEvent      (the append-only log)
 *   heads   key [topic, origin]             → seq (number)  (per-origin high-water)
 *   cursors key [subscriberId, topic]       → BusCursor     (durable subscriber pos)
 * Array keys use LMDB's default ordered-binary key encoding (element-wise sort),
 * so a `[topic]`-prefixed getRange walks a topic in (origin, seq) order. Ingest
 * is idempotent: a key that already exists is a no-op (no LWW, no conflicts).
 *
 * Write path is non-blocking (perf fix): append()/ingest()/bumpHead() write through
 * an in-memory overlay (`pendingEvents` + the `seqCache` head map) and commit to LMDB
 * with async put() — never putSync — so a bus publish never blocks the event loop on
 * a synchronous fsync (measured: putSync-per-event capped publish at ~70-86 ops/s and
 * stalled the whole Core API under concurrent publishers; the data-cache backend's
 * async put() stays non-blocking under the same load). Every read method below (get /
 * readSince / maxCursor / allTopicNames / listTopics) merges the overlay in, because a
 * `.getRange()` scan does NOT see an async put() still in flight even with `cache:true`
 * (verified in isolation: point gets get same-tick read-your-writes with `cache:true`,
 * range scans do not) — so `cache:true` (enabled below anyway, belt-and-suspenders) is
 * NOT sufficient on its own and the overlay is load-bearing. close() awaits every
 * in-flight commit before closing the environment — see its comment for the crash-loss
 * tradeoff that accepts. Subscriber cursors are unchanged (still putSync — see
 * setCursor's comment for why that's fine to leave as-is).
 */
import { open, RootDatabase, Database } from 'lmdb';
import * as fs from 'fs';
import { getCacheDir } from '../utils/path-utils';
import type { BusEvent, BusCursor } from './types';
import { mergeCursor } from './types';
import { eventsToEvict, retentionFromEnv, type RetentionPolicy } from './retention';

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
  private seqCache = new Map<string, number>(); // `${topic}\x00${origin}` → last seq (in-memory head overlay)
  // Appended-but-not-yet-durably-committed events, keyed `${topic}\x00${origin}\x00${seq}`.
  // Merged into every read below so an async commit can never break read-your-writes.
  private pendingEvents = new Map<string, BusEvent>();
  // Every in-flight async commit (event bodies AND head bumps), tracked explicitly so close()
  // can deterministically wait for the overlay to fully drain before closing the environment.
  private pendingCommits = new Set<Promise<unknown>>();
  private _closed = false;

  constructor(dir?: string) {
    const d = dir || getCacheDir('bus');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    this.env = open({ path: d, compression: true, maxDbs: 4, mapSize: 2 * 1024 * 1024 * 1024, cache: true });
    this.events = this.env.openDB('events', { encoding: 'msgpack', cache: true });
    this.heads = this.env.openDB('heads', { encoding: 'msgpack', cache: true });
    this.cursors = this.env.openDB('cursors', { encoding: 'msgpack' });
  }

  private hk(topic: string, origin: string): string { return `${topic}\x00${origin}`; }

  /** Inverse of hk() — used only to re-derive (topic, origin) when iterating seqCache. */
  private static splitHk(k: string): [topic: string, origin: string] {
    const i = k.indexOf('\x00');
    return [k.slice(0, i), k.slice(i + 1)];
  }

  private pk(topic: string, origin: string, seq: number): string { return `${topic}\x00${origin}\x00${seq}`; }

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

  /** Track an async commit so close() can await it. The promise passed in must already be
   *  "safe" (never rejects — callers attach their own .catch() first) purely so a single
   *  in-flight window can't produce an unhandled rejection while nothing is awaiting it yet. */
  private trackCommit(p: Promise<unknown>): void {
    this.pendingCommits.add(p);
    void p.finally(() => { this.pendingCommits.delete(p); });
  }

  private bumpHead(topic: string, origin: string, seq: number): void {
    const k = this.hk(topic, origin);
    const cur = this.seqCache.get(k) ?? this.heads.get([topic, origin]) ?? 0;
    if (seq > cur) this.seqCache.set(k, seq);
    // Async durable commit (was putSync): seqCache above is the in-memory head overlay that
    // storedHead()/nextSeq() read directly and that maxCursor()/listTopics() merge in below, so
    // every reader sees the bumped head immediately regardless of whether this write has reached
    // disk yet. See close() for how a clean shutdown still waits for it to land.
    this.trackCommit(
      this.heads.put([topic, origin], Math.max(cur, seq))
        .catch(() => { /* seqCache remains authoritative in-memory; a lost head commit is healed
                           the same way a lost event is — see close()'s durability comment. */ }),
    );
  }

  private commitEvent(e: BusEvent, key: string): void {
    this.trackCommit(
      this.events.put([e.topic, e.origin, e.seq], e)
        .then(() => { this.pendingEvents.delete(key); })
        .catch(() => { /* keep serving this event from the overlay; see close()'s durability
                           comment for the accepted crash-loss window. */ }),
    );
  }

  append(e: BusEvent): void {
    const key = this.pk(e.topic, e.origin, e.seq);
    this.pendingEvents.set(key, e);
    this.bumpHead(e.topic, e.origin, e.seq);
    this.commitEvent(e, key);
  }

  /** Idempotent merge: returns false if (topic,origin,seq) already exists — durably OR still
   *  in-flight in the overlay (a duplicate can arrive before the original even commits). */
  ingest(e: BusEvent): boolean {
    const key = this.pk(e.topic, e.origin, e.seq);
    if (this.pendingEvents.has(key) || this.events.get([e.topic, e.origin, e.seq]) !== undefined) return false;
    this.pendingEvents.set(key, e);
    this.bumpHead(e.topic, e.origin, e.seq);
    this.commitEvent(e, key);
    return true;
  }

  get(topic: string, origin: string, seq: number): BusEvent | undefined {
    return this.pendingEvents.get(this.pk(topic, origin, seq)) ?? this.events.get([topic, origin, seq]);
  }

  readSince(topic: string, cursor: BusCursor, limit = 10_000): BusEvent[] {
    // `${origin}\x00${seq}` → event, de-duping the pending overlay against the committed range
    // (the same key can transiently appear in both between a commit landing and the overlay's
    // own cleanup callback running — either copy is identical content, so either may win).
    const merged = new Map<string, BusEvent>();
    for (const { key, value } of this.events.getRange({ start: [topic] })) {
      const k = key as EventKey;
      if (!Array.isArray(k) || k[0] !== topic) break; // left the topic prefix
      if (k[2] > (cursor[k[1]] ?? 0)) merged.set(`${k[1]}\x00${k[2]}`, value);
    }
    // Merge the not-yet-committed overlay — getRange (above) cannot see an async put() still in
    // flight, so a topic with a pending write would otherwise look stale here.
    for (const e of this.pendingEvents.values()) {
      if (e.topic === topic && e.seq > (cursor[e.origin] ?? 0)) merged.set(`${e.origin}\x00${e.seq}`, e);
    }
    const out = [...merged.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.seq - b.seq);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  maxCursor(topic: string): BusCursor {
    const out: BusCursor = {};
    for (const { key, value } of this.heads.getRange({ start: [topic] })) {
      const k = key as HeadKey;
      if (!Array.isArray(k) || k[0] !== topic) break;
      out[k[1]] = value;
    }
    // Merge the in-memory head overlay (seqCache): a head can be bumped here before its async
    // heads.put(...) commit lands, so getRange alone can under-report during that window.
    for (const [k, v] of this.seqCache) {
      const [t, origin] = BusStore.splitHk(k);
      if (t === topic && v > (out[origin] ?? 0)) out[origin] = v;
    }
    return out;
  }

  allTopicNames(): string[] {
    const seen = new Set<string>();
    for (const { key } of this.heads.getRange({})) {
      const k = key as HeadKey;
      if (Array.isArray(k) && typeof k[0] === 'string') seen.add(k[0]);
    }
    // Every append()/ingest() bumps seqCache (via bumpHead) before its durable heads.put(...)
    // commits, so a brand-new topic's very first event is visible here even before that lands.
    for (const k of this.seqCache.keys()) seen.add(BusStore.splitHk(k)[0]);
    return [...seen];
  }

  listTopics(): TopicSummary[] {
    return this.allTopicNames().map((topic) => {
      let events = 0;
      let oldestAt: number | null = null;
      let newestAt: number | null = null;
      const origins = new Set<string>();
      const seen = new Set<string>(); // `${origin}\x00${seq}` — de-dups committed vs. pending-overlay
      for (const { key, value } of this.events.getRange({ start: [topic] })) {
        const k = key as EventKey;
        if (!Array.isArray(k) || k[0] !== topic) break;
        const dk = `${k[1]}\x00${k[2]}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        events++;
        origins.add(k[1]);
        oldestAt = oldestAt === null ? value.at : Math.min(oldestAt, value.at);
        newestAt = newestAt === null ? value.at : Math.max(newestAt, value.at);
      }
      for (const e of this.pendingEvents.values()) {
        if (e.topic !== topic) continue;
        const dk = `${e.origin}\x00${e.seq}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        events++;
        origins.add(e.origin);
        oldestAt = oldestAt === null ? e.at : Math.min(oldestAt, e.at);
        newestAt = newestAt === null ? e.at : Math.max(newestAt, e.at);
      }
      return { topic, events, origins: origins.size, oldestAt, newestAt, head: this.maxCursor(topic) };
    });
  }

  getCursor(subscriberId: string, topic: string): BusCursor {
    return this.cursors.get([subscriberId, topic]) ?? {};
  }

  /** Subscriber cursor writes intentionally stay putSync (not folded into the overlay): they are
   *  low-frequency (one write per delivered batch per subscriber, not per publish — see Bus.
   *  dispatchTo) and subscriber-local, so they were never implicated in the publish-path stall
   *  this class's async overlay fixes. Keeping them synchronous keeps getCursor/setCursor
   *  trivially read-your-writes-correct with no extra bookkeeping. Revisit only if a subscriber
   *  count ever makes this frequent enough to matter — not needed today. */
  setCursor(subscriberId: string, topic: string, c: BusCursor): void {
    this.cursors.putSync([subscriberId, topic], mergeCursor(this.getCursor(subscriberId, topic), c));
  }

  /** Apply retention to every topic; returns the number of events removed. Reads/removes only
   *  durably committed events (not the pending overlay): sweep runs on its own ~5 min cadence
   *  (spec), long after any recent append's async commit has landed, so a not-yet-committed event
   *  is never a real eviction candidate in practice. Unlike append/ingest, sweep was never
   *  implicated in the measured event-loop stall (it's an infrequent, periodic maintenance pass,
   *  not on the per-publish hot path), so its removeSync is intentionally left as-is.
   */
  sweep(policy: RetentionPolicy = retentionFromEnv()): number {
    const now = Date.now();
    let removed = 0;
    for (const topic of this.allTopicNames()) {
      const evs: Array<{ origin: string; seq: number; at: number }> = [];
      for (const { key, value } of this.events.getRange({ start: [topic] })) {
        const k = key as [string, string, number];
        if (!Array.isArray(k) || k[0] !== topic) break;
        evs.push({ origin: k[1], seq: k[2], at: value.at });
      }
      for (const e of eventsToEvict(evs, policy, now)) {
        // removeSync (not remove): same reason as historically — this method's API is
        // synchronous throughout, and lmdb-js's async remove() would not be reflected in a
        // get() called later in the same tick (e.g. the test that sweeps then immediately
        // asserts the evicted key is gone).
        this.events.removeSync([topic, e.origin, e.seq]);
        removed++;
      }
    }
    return removed;
  }

  /** Wait for every in-flight async commit (event bodies + head bumps) to settle, then for
   *  LMDB's own disk-flush guarantee, before closing. This is what keeps a CLEAN shutdown
   *  lossless even though append()/ingest()/bumpHead() no longer synchronously fsync per call
   *  (see their comments): every write started before close() is awaited here, in two stages —
   *  first the overlay drains (pendingCommits), then events/heads' `flushed` promise (LMDB's
   *  own committed+fsynced guarantee) — before the environment actually closes. A HARD crash
   *  before close() finishes can still lose that in-flight window; that is accepted and no
   *  worse than any other missed bus event — the ~5 min reconcile + bus catch-up re-deliver it
   *  from a peer's copy, the same at-least-once/idempotent-ingest model the bus already relies
   *  on for cross-node delivery. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await Promise.allSettled([...this.pendingCommits]);
    await Promise.all([this.events.flushed, this.heads.flushed]);
    this.env.close();
  }
}
