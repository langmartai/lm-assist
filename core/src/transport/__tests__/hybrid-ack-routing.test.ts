/**
 * Unit test: the pure `chooseDatagramPath` routing predicate used by
 * makeReliable's sendDatagram closure in hybrid.ts.
 *
 * Bug this guards against: sendDatagram used to send EVERY control datagram
 * (ACK/PING/FIN) over the relay unconditionally, even when the direct leg was
 * confirmed fresh (BIDI). Since reliable.ts's send window only advances on
 * cumulative ACK, that capped bulk throughput at ~relay-RTT regardless of the
 * direct data path. The fix: control datagrams take the SAME freshness gate
 * as data — direct when confirmed fresh, relay only as fallback.
 *
 * Run (compiled): node --test dist-test/transport/__tests__/hybrid-ack-routing.test.js
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chooseDatagramPath } from '../hybrid';

test('control datagram + direct fresh → direct', () => {
  assert.equal(
    chooseDatagramPath({ isControl: true, directFresh: true, hasPeer: true, hasSocket: true }),
    'direct',
  );
});

test('control datagram + direct NOT fresh → relay', () => {
  assert.equal(
    chooseDatagramPath({ isControl: true, directFresh: false, hasPeer: true, hasSocket: true }),
    'relay',
  );
});

test('data datagram + direct fresh → direct', () => {
  assert.equal(
    chooseDatagramPath({ isControl: false, directFresh: true, hasPeer: true, hasSocket: true }),
    'direct',
  );
});

test('data datagram + direct NOT fresh → relay', () => {
  assert.equal(
    chooseDatagramPath({ isControl: false, directFresh: false, hasPeer: true, hasSocket: true }),
    'relay',
  );
});

test('direct fresh but no peer endpoint yet → relay', () => {
  assert.equal(
    chooseDatagramPath({ isControl: true, directFresh: true, hasPeer: false, hasSocket: true }),
    'relay',
  );
  assert.equal(
    chooseDatagramPath({ isControl: false, directFresh: true, hasPeer: false, hasSocket: true }),
    'relay',
  );
});

test('direct fresh but no socket bound yet → relay', () => {
  assert.equal(
    chooseDatagramPath({ isControl: true, directFresh: true, hasPeer: true, hasSocket: false }),
    'relay',
  );
  assert.equal(
    chooseDatagramPath({ isControl: false, directFresh: true, hasPeer: true, hasSocket: false }),
    'relay',
  );
});
