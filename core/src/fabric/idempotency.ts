/**
 * Receiver-side dedup cache (spec T7): a retried `req` (same reqId) returns the
 * cached `res` instead of re-executing — the fabric's effectively-exactly-once
 * guarantee for the rpc class. ~2 min TTL, LRU-bounded. Map insertion order is
 * the LRU order (touch on get).
 */
import type { Envelope } from './envelope';

interface Entry { res: Envelope; at: number; }

export class IdempotencyCache {
  private map = new Map<string, Entry>();
  private ttlMs: number;
  private cap: number;
  private now: () => number;
  private hitCount = 0;
  constructor(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.cap = opts.cap ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }
  get(reqId: string): Envelope | undefined {
    const e = this.map.get(reqId);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) { this.map.delete(reqId); return undefined; }
    this.map.delete(reqId); this.map.set(reqId, e); // LRU touch
    this.hitCount++;
    return e.res;
  }
  put(reqId: string, res: Envelope): void {
    this.map.delete(reqId);
    this.map.set(reqId, { res, at: this.now() });
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
  }
  size(): number { return this.map.size; }
  hits(): number { return this.hitCount; }
}
