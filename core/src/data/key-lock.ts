// core/src/data/key-lock.ts
// Per-key promise-chain mutex, shared between DataService (put/del CAS critical
// sections) and SyncEngine (tombstone-GC delete). Extracted from DataService so the
// GC's check-then-delete can run under the SAME lock instance as put/del — a GC that
// re-checks under a *different* lock still races a concurrent re-create (TOCTOU).
export class KeyedLocks {
  private locks = new Map<string, Promise<void>>();

  /** Chains `fn` onto the previous critical section for `key` so same-key critical
   *  sections never overlap, no matter how the previous one settled. Cleans up its
   *  own map entry when drained — but only if no newer waiter has already replaced
   *  it — so the map can't grow unbounded. Uncontended keys stay fast: a Map miss +
   *  immediate resolve, no global lock. */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const mine = prev.then(fn);
    // Settles right after `fn`, but never rejects — so a failed critical section
    // doesn't poison the chain for the next waiter on this key.
    const tail = mine.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    try {
      return await mine;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
