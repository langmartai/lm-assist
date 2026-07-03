import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  globalId, payloadSize, encodeCursor, decodeCursor, mergeCursor, BUS_PAYLOAD_CAP, type BusCursor,
} from '../../bus/types';

test('globalId is origin:seq', () => {
  assert.equal(globalId({ origin: 'gw-a', seq: 7 }), 'gw-a:7');
});

test('payloadSize measures JSON bytes; cap is 64KB', () => {
  assert.equal(BUS_PAYLOAD_CAP, 64 * 1024);
  assert.ok(payloadSize({ a: 'x'.repeat(100) }) > 100);
  assert.ok(payloadSize(null) < 8);
});

test('cursor encode/decode round-trips and is opaque-string safe', () => {
  const c: BusCursor = { 'gw-a': 3, 'gw-b': 10 };
  const s = encodeCursor(c);
  assert.equal(typeof s, 'string');
  assert.deepEqual(decodeCursor(s), c);
  assert.deepEqual(decodeCursor(undefined), {});
  assert.deepEqual(decodeCursor('not-base64!!'), {});
});

test('mergeCursor takes the per-origin max', () => {
  assert.deepEqual(mergeCursor({ a: 1, b: 5 }, { a: 4, c: 2 }), { a: 4, b: 5, c: 2 });
});
