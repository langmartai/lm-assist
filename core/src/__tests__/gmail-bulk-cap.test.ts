/**
 * The bulk cap must be REPORTED, never silently applied.
 *
 * 🔴 A capped call that trims its input and returns a short success list is
 * indistinguishable from partial success — the caller sees `done: [...]` and has
 * no way to know ids were dropped. So every id beyond BULK_MAX comes back in
 * `failed` with BULK_CAP_EXCEEDED.
 *
 * Tested against a stub cdp rather than a live mailbox: 30 ids would otherwise mean
 * 25 real browser operations, which is slow, contends for the driver lock, and
 * tells us nothing about the cap itself. (Measured: a live attempt lost the lock
 * seven times and never reached the assertion.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bulkAction, BULK_MAX } from '../gmail/actions';

/** Every page-side call fails, so the loop is fast and deterministic. */
const stubCdp = {
  evaluate: async () => {
    throw new Error('stub: no browser');
  },
  navigate: async () => undefined,
  send: async () => undefined,
  close: () => undefined,
} as unknown as Parameters<typeof bulkAction>[0];

test('ids beyond BULK_MAX are reported, not silently dropped', async () => {
  const over = 5;
  const ids = Array.from({ length: BULK_MAX + over }, (_, i) => `thread${i}`);
  const res = await bulkAction(stubCdp, ids, 'star');

  const capped = res.failed.filter((f) => f.error.includes('BULK_CAP_EXCEEDED'));
  assert.equal(capped.length, over, `the ${over} ids past the cap must each be reported`);

  // Nothing may vanish: every input id appears in exactly one bucket.
  const seen = new Set([...res.done, ...res.failed.map((f) => f.id)]);
  assert.equal(seen.size, ids.length, 'every id must appear in done or failed');
});

test('a duplicate id is not processed twice', async () => {
  const res = await bulkAction(stubCdp, ['a', 'a', 'b'], 'star');
  const ids = [...res.done, ...res.failed.map((f) => f.id)];
  assert.equal(new Set(ids).size, ids.length, 'no id should be reported twice');
});
