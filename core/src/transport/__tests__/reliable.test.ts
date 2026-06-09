/**
 * Unit test: ReliableConnection over a lossy, reordering in-process datagram
 * pair. Injects ~20% drop + reorder in BOTH directions and asserts a multi-KB
 * payload arrives intact and in order at the peer.
 *
 * Run (compiled): node --test dist-test/transport/__tests__/reliable.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import { ReliableConnection } from '../reliable';

/**
 * A bidirectional unreliable link between two ReliableConnections.
 * Each direction: drop ~dropRate of datagrams, and reorder by deferring some
 * deliveries with a small random jitter.
 */
function makeLossyPair(opts: { dropRate: number; reorderRate: number; maxDelayMs: number }) {
  let a: ReliableConnection | null = null;
  let b: ReliableConnection | null = null;

  const deliverTo = (target: () => ReliableConnection | null, buf: Buffer) => {
    if (Math.random() < opts.dropRate) {
      return; // dropped — retransmission must recover it
    }
    // Copy: the sender's buffer may be mutated (ack refresh on retransmit).
    const copy = Buffer.from(buf);
    if (Math.random() < opts.reorderRate) {
      const delay = Math.floor(Math.random() * opts.maxDelayMs);
      setTimeout(() => { target()?.onDatagram(copy); }, delay);
    } else {
      // Even "in order" deliveries get a tiny async hop so timers can fire.
      setImmediate(() => { target()?.onDatagram(copy); });
    }
  };

  const aToB = (buf: Buffer) => deliverTo(() => b, buf);
  const bToA = (buf: Buffer) => deliverTo(() => a, buf);

  return {
    setA: (conn: ReliableConnection) => { a = conn; },
    setB: (conn: ReliableConnection) => { b = conn; },
    aToB,
    bToA,
  };
}

test('reliable layer delivers a multi-KB payload intact and in order over a 20% lossy/reordering link', async () => {
  const link = makeLossyPair({ dropRate: 0.2, reorderRate: 0.3, maxDelayMs: 15 });

  const received: Buffer[] = [];

  // Sender A — delivers nothing inbound (we only send A->B in this test).
  const aConn = new ReliableConnection({
    sendDatagram: (buf) => link.aToB(buf),
    onDeliver: () => { /* A receives only acks/control */ },
    rtoMs: 80,
    rtoMaxMs: 1000,
    windowSize: 64,
    keepaliveMs: 1000,
    idleTimeoutMs: 60_000,
  });

  // Receiver B — collects delivered chunks in order.
  const bConn = new ReliableConnection({
    sendDatagram: (buf) => link.bToA(buf),
    onDeliver: (data) => { received.push(Buffer.from(data)); },
    rtoMs: 80,
    rtoMaxMs: 1000,
    windowSize: 64,
    keepaliveMs: 1000,
    idleTimeoutMs: 60_000,
  });

  link.setA(aConn);
  link.setB(bConn);

  // Multi-KB random payload spanning many datagrams (MAX_PAYLOAD = 1200).
  const total = 64 * 1024; // 64 KB → ~55 datagrams
  const payload = crypto.randomBytes(total);

  aConn.send(payload);

  // Wait until B has reassembled the whole payload (or time out).
  const deadline = Date.now() + 20_000;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    const got = Buffer.concat(received).length;
    if (got >= total) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  /* eslint-enable no-await-in-loop */

  const assembled = Buffer.concat(received);
  assert.strictEqual(assembled.length, total, `expected ${total} bytes, got ${assembled.length}`);
  assert.ok(assembled.equals(payload), 'reassembled payload must be byte-identical and in order');

  aConn.close();
  bConn.close();
});

test('reliable layer handles many small ordered sends under loss', async () => {
  const link = makeLossyPair({ dropRate: 0.15, reorderRate: 0.25, maxDelayMs: 10 });
  const received: Buffer[] = [];

  const aConn = new ReliableConnection({
    sendDatagram: (buf) => link.aToB(buf),
    onDeliver: () => {},
    rtoMs: 60,
    rtoMaxMs: 800,
    keepaliveMs: 1000,
    idleTimeoutMs: 60_000,
  });
  const bConn = new ReliableConnection({
    sendDatagram: (buf) => link.bToA(buf),
    onDeliver: (data) => { received.push(Buffer.from(data)); },
    rtoMs: 60,
    rtoMaxMs: 800,
    keepaliveMs: 1000,
    idleTimeoutMs: 60_000,
  });
  link.setA(aConn);
  link.setB(bConn);

  const messages: Buffer[] = [];
  for (let i = 0; i < 50; i++) {
    const m = Buffer.from(`message-${i}-${'x'.repeat(i % 7)}`);
    messages.push(m);
    aConn.send(m);
  }
  const expected = Buffer.concat(messages);

  const deadline = Date.now() + 15_000;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (Buffer.concat(received).length >= expected.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  /* eslint-enable no-await-in-loop */

  const assembled = Buffer.concat(received);
  assert.strictEqual(assembled.length, expected.length, 'all message bytes delivered');
  assert.ok(assembled.equals(expected), 'messages delivered in order, intact');

  aConn.close();
  bConn.close();
});
