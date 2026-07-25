/**
 * Request de-duplication for idempotent GETs.
 *
 * The browser gets ~6 concurrent connections per origin over HTTP/1.1, so a page
 * that fetches the same URL N times doesn't just waste N-1 responses — it starves
 * every *other* request of a connection slot. On /sessions that showed up as
 * head-of-line queueing: /health (a ~0ms endpoint) took 3-4s because it sat
 * behind six copies of /projects.
 *
 * Two separate guarantees, deliberately:
 *
 *   1. IN-FLIGHT sharing is unconditional. Two callers asking for the same URL
 *      while a request is open always share that one request, whatever the TTL
 *      is. This is what collapses the mount-burst (a hook fires, then fires
 *      again when a context upgrades the api client under it).
 *   2. SETTLED values are reused only for `ttlMs` after they resolved. This is
 *      what keeps polling honest: pick a TTL below the poll interval and the
 *      poll still sees fresh data.
 *
 * A rejection is never cached — the entry is dropped so the next caller retries.
 */

interface DedupeEntry {
  /** Start time while in flight; settle time once resolved. */
  at: number;
  promise: Promise<unknown>;
  settled: boolean;
}

const entries = new Map<string, DedupeEntry>();

/**
 * Share one request for `key` across callers.
 *
 * @param key    Cache key — use the fully-resolved URL so proxy/direct and
 *               per-machine variants never collide.
 * @param ttlMs  How long a *settled* value stays reusable. Keep it below the
 *               caller's poll interval. 0 disables value reuse (in-flight
 *               sharing still applies).
 * @param fn     Performs the actual request. Called at most once per shared entry.
 * @param opts   `force: true` bypasses any existing entry and replaces it —
 *               use it for explicit user refreshes and post-write reloads.
 */
export function dedupedRequest<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts?: { force?: boolean },
): Promise<T> {
  if (!opts?.force) {
    const existing = entries.get(key);
    if (existing) {
      // (1) in-flight work is always shared
      if (!existing.settled) return existing.promise as Promise<T>;
      // (2) a settled value is reusable only inside the TTL
      if (Date.now() - existing.at < ttlMs) return existing.promise as Promise<T>;
    }
  }

  const entry: DedupeEntry = { at: Date.now(), promise: null as never, settled: false };
  const promise = fn().then(
    value => {
      entry.settled = true;
      entry.at = Date.now();
      return value;
    },
    err => {
      // Never let a later caller inherit a failure.
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    },
  );
  entry.promise = promise;
  entries.set(key, entry);
  return promise;
}

/** Drop one key, or the whole table when called with no argument. */
export function clearRequestDedupe(key?: string): void {
  if (key === undefined) entries.clear();
  else entries.delete(key);
}

/** Number of live entries. Exposed for tests. */
export function requestDedupeSize(): number {
  return entries.size;
}
