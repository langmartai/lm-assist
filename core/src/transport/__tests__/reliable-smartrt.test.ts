/**
 * Unit tests for Task A2 (adaptive RTT-based RTO + Karn's algorithm) and
 * Task A3 (fast-retransmit on 3 duplicate ACKs) in ReliableConnection.
 *
 * Uses a small in-process *controlled-timing* pair (fixed per-direction
 * delay, deterministic one-shot drops) rather than the randomized
 * makeLossyPair in reliable.test.ts, because these tests need precise,
 * repeatable timing to assert *when* a retransmit fires (fast-retransmit vs
 * RTO) and *whether* a given ACK was sampled into the RTT estimator.
 *
 * Run (compiled): node --test dist-test/transport/__tests__/reliable-smartrt.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { ReliableConnection, DATAGRAM_TYPE } from '../reliable';

/**
 * A bidirectional link with a FIXED per-direction delay and support for:
 *  - deterministic one-shot drops of a given DATA seq (A -> B direction),
 *  - an inflated delay applied to whatever A -> B delivery immediately
 *    follows a dropped seq (i.e. the retransmission) — used to make a Karn
 *    violation observable: if the retransmitted segment's ACK is (wrongly)
 *    sampled, the resulting "RTT" is huge and unmistakable.
 */
function makeControlledPair(opts: { delayMs: number; retransmitDelayMs?: number }) {
  let a: ReliableConnection | null = null;
  let b: ReliableConnection | null = null;

  const dropOnceSeqs = new Set<number>();
  const inflateNextSeqs = new Set<number>();

  const aToB = (buf: Buffer) => {
    const type = buf.readUInt8(0);
    const seq = buf.readUInt32BE(1);
    if (type === DATAGRAM_TYPE.DATA && dropOnceSeqs.has(seq)) {
      dropOnceSeqs.delete(seq);
      if (opts.retransmitDelayMs != null) inflateNextSeqs.add(seq);
      return; // dropped once
    }
    let delay = opts.delayMs;
    if (type === DATAGRAM_TYPE.DATA && inflateNextSeqs.has(seq)) {
      inflateNextSeqs.delete(seq);
      delay = opts.retransmitDelayMs!;
    }
    const copy = Buffer.from(buf);
    setTimeout(() => { b?.onDatagram(copy); }, delay);
  };

  const bToA = (buf: Buffer) => {
    const copy = Buffer.from(buf);
    setTimeout(() => { a?.onDatagram(copy); }, opts.delayMs);
  };

  return {
    setA: (conn: ReliableConnection) => { a = conn; },
    setB: (conn: ReliableConnection) => { b = conn; },
    aToB,
    bToA,
    dropOnceSeqs,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  /* eslint-enable no-await-in-loop */
  if (!predicate()) throw new Error('waitFor: condition not met before timeout');
}

// ---------------------------------------------------------------------------
// A2: adaptive RTT-based RTO + Karn's algorithm
// ---------------------------------------------------------------------------

test('A2: converges to a low adaptive RTO under a steady ~5ms simulated RTT', async () => {
  const link = makeControlledPair({ delayMs: 5 });
  const received: Buffer[] = [];

  const aConn = new ReliableConnection({
    sendDatagram: (buf) => link.aToB(buf),
    onDeliver: () => {},
    rtoMs: 300,
    rtoMaxMs: 2000,
    windowSize: 64,
    keepaliveMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  const bConn = new ReliableConnection({
    sendDatagram: (buf) => link.bToA(buf),
    onDeliver: (data) => { received.push(Buffer.from(data)); },
    rtoMs: 300,
    rtoMaxMs: 2000,
    windowSize: 64,
    keepaliveMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  link.setA(aConn);
  link.setB(bConn);

  const messages: Buffer[] = [];
  for (let i = 0; i < 20; i++) {
    const m = Buffer.from(`seg-${i}`);
    messages.push(m);
    aConn.send(m);
  }
  const expectedLen = Buffer.concat(messages).length;

  await waitFor(() => Buffer.concat(received).length >= expectedLen && aConn.inFlightCount() === 0);

  const rto = aConn.currentRto();
  assert.ok(rto <= 80, `expected adaptive rto <=80ms after warmup over a ~10ms RTT link, got ${rto}`);
  assert.ok(rto < 300, `adaptive rto (${rto}) should have moved off the old fixed 300ms base`);

  aConn.close();
  bConn.close();
});

test("A2: Karn's algorithm — a retransmitted segment's ACK must not be sampled into the RTT estimate", async () => {
  // retransmitDelayMs is deliberately huge relative to the steady 5ms delay:
  // if the retransmitted segment's ACK were (incorrectly) sampled, the
  // resulting RTT sample (~150ms+) would visibly blow up currentRto(); if
  // Karn's algorithm correctly skips it, the estimator is untouched and
  // currentRto() is unchanged, bit for bit.
  //
  // rtoMs is set high (poll cadence = max(50, floor(rtoMs/2)) = 500ms) purely
  // so the RTO-timer's poll tick doesn't fire a *second* time (it would use
  // the normal, non-inflated delay, since the one-shot inflate is consumed by
  // the first retransmit) before the first, deliberately-slow retransmit's
  // ACK has a chance to land — a second, faster retransmit would refresh
  // sentAt and mask the very inflation this test depends on to be observable.
  const link = makeControlledPair({ delayMs: 5, retransmitDelayMs: 150 });
  const received: Buffer[] = [];

  const aConn = new ReliableConnection({
    sendDatagram: (buf) => link.aToB(buf),
    onDeliver: () => {},
    rtoMs: 1000,
    rtoMaxMs: 4000,
    windowSize: 64,
    keepaliveMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  const bConn = new ReliableConnection({
    sendDatagram: (buf) => link.bToA(buf),
    onDeliver: (data) => { received.push(Buffer.from(data)); },
    rtoMs: 1000,
    rtoMaxMs: 4000,
    windowSize: 64,
    keepaliveMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  link.setA(aConn);
  link.setB(bConn);

  // Warm up 20 clean segments (seq 0..19) so the estimate has converged.
  const warmup: Buffer[] = [];
  for (let i = 0; i < 20; i++) {
    const m = Buffer.from(`w${i}`);
    warmup.push(m);
    aConn.send(m);
  }
  const warmupLen = Buffer.concat(warmup).length;
  await waitFor(() => Buffer.concat(received).length >= warmupLen && aConn.inFlightCount() === 0);

  const rtoBaseline = aConn.currentRto();
  assert.ok(rtoBaseline <= 80, `sanity: expected converged rto <=80, got ${rtoBaseline}`);

  // The 21st send is assigned seq=20 (each prior send() produced exactly one
  // datagram). Drop it once; the retransmit that follows gets the inflated
  // 150ms delay.
  link.dropOnceSeqs.add(20);
  const probe = Buffer.from('karn-probe');
  aConn.send(probe);

  await waitFor(
    () => Buffer.concat(received).length >= warmupLen + probe.length && aConn.inFlightCount() === 0,
    5000,
  );

  const rtoAfter = aConn.currentRto();
  assert.strictEqual(
    rtoAfter,
    rtoBaseline,
    `Karn violation: a retransmitted segment's inflated round-trip was sampled (rto ${rtoBaseline} -> ${rtoAfter})`,
  );

  aConn.close();
  bConn.close();
});

// ---------------------------------------------------------------------------
// A3: fast-retransmit on 3 duplicate ACKs
// ---------------------------------------------------------------------------

test('A3: seq at the gap is fast-retransmitted on the 3rd duplicate ACK, well before RTO, and all data delivers in order', async () => {
  const link = makeControlledPair({ delayMs: 5 });
  const received: Buffer[] = [];
  const aSent: { buf: Buffer; at: number }[] = [];

  const aConn = new ReliableConnection({
    sendDatagram: (buf) => {
      aSent.push({ buf: Buffer.from(buf), at: Date.now() });
      link.aToB(buf);
    },
    onDeliver: () => {},
    // Poll cadence = max(50, floor(rtoMs/2)) = 150ms. Fast-retransmit must
    // clearly beat that (it's event-driven, not timer-driven).
    rtoMs: 300,
    rtoMaxMs: 2000,
    windowSize: 64,
    keepaliveMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  const bConn = new ReliableConnection({
    sendDatagram: (buf) => link.bToA(buf),
    onDeliver: (data) => { received.push(Buffer.from(data)); },
    rtoMs: 300,
    rtoMaxMs: 2000,
    windowSize: 64,
    keepaliveMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  link.setA(aConn);
  link.setB(bConn);

  link.dropOnceSeqs.add(3);

  const messages: Buffer[] = [];
  for (let i = 0; i < 10; i++) {
    const m = Buffer.from(`m${i}`);
    messages.push(m);
    aConn.send(m);
  }
  const expected = Buffer.concat(messages);

  await waitFor(() => Buffer.concat(received).length >= expected.length, 5000);

  const assembled = Buffer.concat(received);
  assert.strictEqual(assembled.length, expected.length, 'all 10 segments delivered');
  assert.ok(assembled.equals(expected), 'segments delivered in order, byte-identical (seq=3 gap healed)');

  const seq3Sends = aSent.filter((r) => r.buf.readUInt8(0) === DATAGRAM_TYPE.DATA && r.buf.readUInt32BE(1) === 3);
  assert.ok(
    seq3Sends.length >= 2,
    `expected seq=3 to be sent at least twice (original + fast-retransmit), got ${seq3Sends.length}`,
  );
  assert.ok(
    seq3Sends.length <= 4,
    `expected a bounded number of fast-retransmits (no storm), got ${seq3Sends.length} sends of seq=3`,
  );

  const firstSend = seq3Sends[0];
  const firstRetransmit = seq3Sends[1];
  const elapsed = firstRetransmit.at - firstSend.at;
  assert.ok(
    elapsed < 100,
    `fast-retransmit of seq=3 should fire within ms of the 3rd dup-ACK (got ${elapsed}ms) — ` +
      'must beat the 150ms RTO poll tick and the 300ms base RTO',
  );

  aConn.close();
  bConn.close();
});
