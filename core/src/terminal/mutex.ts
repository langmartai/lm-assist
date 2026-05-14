/**
 * Per-session async mutex.
 *
 * Why: previously two parallel send-keys calls to the same tmux session could
 * interleave their text/Enter sub-commands. Each call now grabs the per-name
 * mutex; serialization is single-process only, but that's where the race
 * lived (one lm-assist instance fielding many concurrent HTTP requests).
 *
 * Implementation: one promise chain per session. acquire() returns a release
 * function that resolves the next waiter. Idle entries are GC'd.
 */

type Release = () => void;

const chains = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve();
  let release!: Release;
  const ticket = new Promise<void>((resolve) => { release = resolve; });
  chains.set(name, prev.then(() => ticket));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // GC: if no one is waiting (chain head equals our ticket and we just
    // released), remove the entry to keep the map bounded.
    queueMicrotask(() => {
      if (chains.get(name) === prev.then(() => ticket)) chains.delete(name);
    });
  }
}

/** Test helper. */
export function _activeLockCount(): number {
  return chains.size;
}
