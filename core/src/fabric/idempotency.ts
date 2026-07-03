/**
 * Receiver-side dedup cache (spec T7): a retried `req` (same reqId) returns the
 * cached `res` instead of re-executing — the fabric's effectively-exactly-once
 * guarantee for the rpc class. ~2 min TTL, LRU-bounded. Map insertion order is
 * the LRU order (touch on get).
 *
 * In-flight tracking: a duplicate reqId that arrives WHILE the original is
 * still being dispatched (e.g. a sender-side retry firing before a slow route
 * responds — the completed cache is still empty at that point) must NOT
 * re-invoke the route a second time; it must await the SAME in-progress
 * dispatch and replay its eventual result. `begin`/`settle` make the
 * check-then-claim atomic (no `await` between them): `begin` either replays a
 * completed `cached` res, hands back an `inflight` promise to await, or
 * claims the slot as `new` — in which case the caller MUST call `settle` on
 * EVERY terminal path (including error paths), or any concurrent waiter on
 * that reqId hangs forever.
 */
import type { Envelope } from './envelope';

interface Entry { res: Envelope; at: number; }
interface Pending { promise: Promise<Envelope>; resolve: (res: Envelope) => void; }

export type BeginResult =
  | { kind: 'cached'; res: Envelope }
  | { kind: 'inflight'; wait: Promise<Envelope> }
  | { kind: 'new' };

export class IdempotencyCache {
  private map = new Map<string, Entry>();
  private inflight = new Map<string, Pending>();
  private ttlMs: number;
  private cap: number;
  private now: () => number;
  private hitCount = 0;
  constructor(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.cap = opts.cap ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Atomically claim a reqId: replay a completed entry, await an in-flight
   * one, or claim it as new. The caller of a `'new'` result owns the
   * dispatch and MUST call `settle()` exactly once it's done (success or
   * error) to release any concurrent waiters.
   */
  begin(reqId: string): BeginResult {
    const e = this.map.get(reqId);
    if (e) {
      if (this.now() - e.at >= this.ttlMs) {
        this.map.delete(reqId); // expired — fall through to inflight/new
      } else {
        this.map.delete(reqId); this.map.set(reqId, e); // LRU touch
        this.hitCount++;
        return { kind: 'cached', res: e.res };
      }
    }
    const p = this.inflight.get(reqId);
    if (p) return { kind: 'inflight', wait: p.promise };

    let resolve!: (res: Envelope) => void;
    const promise = new Promise<Envelope>((res) => { resolve = res; });
    this.inflight.set(reqId, { promise, resolve });
    return { kind: 'new' };
  }

  /**
   * Resolve any waiters queued behind `begin`'s `'inflight'` result and store
   * the completed response in the LRU/TTL cache. Idempotent — a second call
   * for the same reqId just refreshes the completed entry (no throw, no
   * double-resolve; Promise#resolve is itself a no-op past the first call).
   */
  settle(reqId: string, res: Envelope): void {
    const p = this.inflight.get(reqId);
    if (p) { this.inflight.delete(reqId); p.resolve(res); }
    this.map.delete(reqId);
    this.map.set(reqId, { res, at: this.now() });
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
  }

  size(): number { return this.map.size; }
  hits(): number { return this.hitCount; }
}
