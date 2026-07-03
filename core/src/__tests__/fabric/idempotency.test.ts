import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IdempotencyCache } from '../../fabric/idempotency';
import type { Envelope } from '../../fabric/envelope';

const res = (id: string): Envelope => ({ kind: 'res', id, headers: { status: 200 }, payload: new Uint8Array() });

test('a stored response is returned and counts a hit', () => {
  let t = 0;
  const c = new IdempotencyCache({ ttlMs: 1000, now: () => t });
  assert.equal(c.get('r1'), undefined);
  c.put('r1', res('r1'));
  assert.ok(c.get('r1'));
  assert.equal(c.hits(), 1);
});

test('entries expire after ttl', () => {
  let t = 0;
  const c = new IdempotencyCache({ ttlMs: 1000, now: () => t });
  c.put('r1', res('r1'));
  t = 1500;
  assert.equal(c.get('r1'), undefined);
  assert.equal(c.size(), 0);
});

test('LRU evicts the oldest past the cap', () => {
  const c = new IdempotencyCache({ cap: 2 });
  c.put('a', res('a')); c.put('b', res('b')); c.put('c', res('c'));
  assert.equal(c.get('a'), undefined); // evicted
  assert.ok(c.get('b')); assert.ok(c.get('c'));
});
