/**
 * Resource → node resolution (spec N3). A session/mission/dataset is a
 * RESOURCE; resolvers map ids to locations; callers address resources and the
 * fabric routes. Shared semantics live HERE (cache, negative cache,
 * invalidate-on-failure, counters) — resolvers stay trivial.
 */
export type Location = { node: string } | { cloud: true };

export interface Resolver {
  kind: string;
  resolve(id: string): Promise<Location | null>;
}

interface CacheEntry { loc: Location | null; at: number }

export class ResolutionService {
  private resolvers = new Map<string, Resolver>();
  private cache = new Map<string, CacheEntry>();     // key `${kind}:${id}`, Map order = LRU
  private stats = { hits: 0, misses: 0, negatives: 0, invalidations: 0 };

  constructor(private opts: { ttlMs?: number; negTtlMs?: number; cap?: number } = {}) {}

  register(r: Resolver): void { this.resolvers.set(r.kind, r); }

  async resolve(kind: string, id: string): Promise<Location | null> {
    const key = `${kind}:${id}`;
    const now = Date.now();
    const ttl = this.opts.ttlMs ?? 60_000;
    const negTtl = this.opts.negTtlMs ?? 10_000;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (hit.loc ? ttl : negTtl)) {
      this.cache.delete(key); this.cache.set(key, hit);  // LRU touch
      this.stats.hits++;
      return hit.loc;
    }
    this.stats.misses++;
    const r = this.resolvers.get(kind);
    if (!r) return null;
    let loc: Location | null = null;
    try { loc = await r.resolve(id); } catch { loc = null; }
    if (!loc) this.stats.negatives++;
    this.cache.set(key, { loc, at: now });
    const cap = this.opts.cap ?? 500;
    while (this.cache.size > cap) this.cache.delete(this.cache.keys().next().value as string);
    return loc;
  }

  /** Delivery failed at the cached location → forget it so the next resolve re-runs. */
  invalidate(kind: string, id: string): void {
    if (this.cache.delete(`${kind}:${id}`)) this.stats.invalidations++;
  }

  counters(): { hits: number; misses: number; negatives: number; invalidations: number } {
    return { ...this.stats };
  }
}
