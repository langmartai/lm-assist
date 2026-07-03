import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IdempotencyCache } from '../../fabric/idempotency';
import type { Envelope } from '../../fabric/envelope';

const res = (id: string): Envelope => ({ kind: 'res', id, headers: { status: 200 }, payload: new Uint8Array() });

test('a fresh reqId begins as new; after settle, begin replays it as cached and counts a hit', () => {
  let t = 0;
  const c = new IdempotencyCache({ ttlMs: 1000, now: () => t });
  const b0 = c.begin('r1');
  assert.equal(b0.kind, 'new');
  c.settle('r1', res('r1'));
  const b1 = c.begin('r1');
  assert.equal(b1.kind, 'cached');
  assert.ok(b1.kind === 'cached' && b1.res);
  assert.equal(c.hits(), 1);
});

test('completed entries expire after ttl (begin returns new again, not cached)', () => {
  let t = 0;
  const c = new IdempotencyCache({ ttlMs: 1000, now: () => t });
  c.begin('r1');
  c.settle('r1', res('r1'));
  t = 1500;
  const b = c.begin('r1');
  assert.equal(b.kind, 'new');
  assert.equal(c.size(), 0);
});

test('LRU evicts the oldest completed entry past the cap', () => {
  const c = new IdempotencyCache({ cap: 2 });
  c.begin('a'); c.settle('a', res('a'));
  c.begin('b'); c.settle('b', res('b'));
  c.begin('c'); c.settle('c', res('c'));
  assert.equal(c.begin('a').kind, 'new');    // evicted -> treated as fresh
  assert.equal(c.begin('b').kind, 'cached');
  assert.equal(c.begin('c').kind, 'cached');
});

test('a second begin before settle returns inflight; settle resolves the waiter with the settled res; a later begin then replays it as cached', async () => {
  const c = new IdempotencyCache();

  const first = c.begin('x');
  assert.equal(first.kind, 'new');

  const second = c.begin('x');
  assert.equal(second.kind, 'inflight');
  if (second.kind !== 'inflight') throw new Error('unreachable');

  // A third concurrent duplicate must join the SAME wait, not re-claim as new.
  const third = c.begin('x');
  assert.equal(third.kind, 'inflight');

  const settled = res('x');
  c.settle('x', settled);

  assert.deepEqual(await second.wait, settled);
  if (third.kind === 'inflight') assert.deepEqual(await third.wait, settled);

  const after = c.begin('x');
  assert.equal(after.kind, 'cached');
  assert.ok(after.kind === 'cached' && after.res === settled);
});

test('settle is idempotent — calling it twice does not throw and leaves a cached entry', () => {
  const c = new IdempotencyCache();
  c.begin('y');
  const r = res('y');
  c.settle('y', r);
  assert.doesNotThrow(() => c.settle('y', r));
  const b = c.begin('y');
  assert.equal(b.kind, 'cached');
});
