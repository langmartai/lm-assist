/**
 * The sync walk must yield the driver tab between steps.
 *
 * 🔴 The bug this encodes: the Gmail driver browser has ONE tab and more than one
 * writer. A sync held it for the length of a multi-minute job while interactive
 * reads navigated the same tab, so a reader could be handed the sync's page as
 * its own answer — DIRECTLY OBSERVED 2026-08-03, seven navigations by the sync in
 * thirty seconds while a caller was waiting on its own search.
 *
 * Two properties matter, and only the pair is safe:
 *   - each step runs INSIDE the critical section (or the lock is decorative), and
 *   - steps do not overlap each other (or it is not a lock at all),
 * while the job as a whole does NOT stay inside it — a job-length lock would make
 * every concurrent read fail BROWSER_BUSY, which is why the naive fix was rejected.
 *
 * These test the composition, not the browser, so they run without one.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

type Step<T> = (id: number) => Promise<T>;

/** A stand-in for withCdp(): mutual exclusion with an observable occupancy count. */
function makeLock() {
  let chain: Promise<unknown> = Promise.resolve();
  const state = { inside: 0, maxInside: 0, entries: 0 };
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      state.entries++;
      state.inside++;
      state.maxInside = Math.max(state.maxInside, state.inside);
      try {
        return await fn();
      } finally {
        state.inside--;
      }
    });
    chain = run.catch(() => undefined);
    return run as Promise<T>;
  };
  return { exclusive, state };
}

/** The shape paginate/fetchBodies now use: every step goes through `step`. */
async function walk<T>(pages: number, step: Step<T>, exclusive: (fn: () => Promise<T>) => Promise<T>) {
  const out: T[] = [];
  for (let p = 1; p <= pages; p++) out.push(await exclusive(() => step(p)));
  return out;
}

test('every page runs inside the critical section', async () => {
  const { exclusive, state } = makeLock();
  await walk(5, async (p) => p, exclusive);
  assert.equal(state.entries, 5, 'one entry per page, not one per job');
});

test('🔴 steps never overlap — this is the whole point', async () => {
  const { exclusive, state } = makeLock();
  const slow: Step<number> = async (p) => {
    await new Promise((r) => setTimeout(r, 5));
    return p;
  };
  // Two walks racing over the same tab, exactly the arrival-sync vs read case.
  await Promise.all([walk(4, slow, exclusive), walk(4, slow, exclusive)]);
  assert.equal(state.maxInside, 1, 'two writers were inside the tab at once');
  assert.equal(state.entries, 8);
});

test('🔴 a reader waits ONE step, not the whole job', async () => {
  const { exclusive, state } = makeLock();
  const order: string[] = [];
  const syncWalk = walk(3, async (p) => {
    await new Promise((r) => setTimeout(r, 5));
    order.push(`sync:${p}`);
    return p;
  }, exclusive);
  // A read arriving mid-walk must land BETWEEN pages, never after all of them.
  const read = exclusive(async () => {
    order.push('read');
    return 0;
  });
  await Promise.all([syncWalk, read]);
  const idx = order.indexOf('read');
  assert.ok(idx >= 0, 'the read never ran');
  assert.ok(idx < order.length - 1, `the read was starved until the job ended: ${order.join(',')}`);
  assert.equal(state.maxInside, 1);
});

test('no lock supplied = unchanged behaviour, so existing callers are untouched', async () => {
  const passthrough = <T,>(fn: () => Promise<T>) => fn();
  const got = await walk(3, async (p) => p * 2, passthrough);
  assert.deepEqual(got, [2, 4, 6]);
});
