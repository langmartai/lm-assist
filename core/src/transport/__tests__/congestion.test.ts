/**
 * Congestion-control test for ReliableConnection.
 *
 * Models a bottlenecked link with a limited buffer. The A->B direction is a
 * rate-limited drain queue: datagrams enter a FIFO of capacity `bufferLimit`;
 * a service loop releases one every `serviceMs` (the bottleneck bandwidth);
 * each released datagram then takes `hopDelayMs` propagation to reach B. When
 * the queue is full, the arriving datagram is TAIL-DROPPED — modeling a
 * bottleneck link / kernel UDP receive buffer that overflows when the sender
 * outpaces the drain.
 *
 * A sender that blasts a fixed window faster than 1/serviceMs overruns the
 * queue → heavy loss → retransmit storm. A paced congestion-controlled sender
 * grows cwnd until it loses, backs off, and converges so cwnd/srtt ≈ the
 * bottleneck rate, fitting inside the buffer with little loss.
 *
 * Asserts:
 *   (a) a multi-MB transfer arrives byte-intact over the lossy/bottlenecked link.
 *   (b) cwnd grows past IW, then backs off after real loss (a >=25% dip from the
 *       observed peak, AND at least one loss event happened).
 *   (c) no unbounded retransmit storm — total DATA sends stay < 3x the datagram
 *       count.
 *
 * Run (compiled): node --test dist-test/transport/__tests__/congestion.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import { ReliableConnection, MAX_PAYLOAD } from '../reliable';

/**
 * Rate-limited bottleneck relay for the A -> B direction with a bounded buffer.
 * The reverse direction (B -> A acks) is reliable with the same propagation
 * delay so acks are never the thing that's lost.
 */
function makeBottleneck(opts: { hopDelayMs: number; serviceMs: number; bufferLimit: number }) {
  let a: ReliableConnection | null = null;
  let b: ReliableConnection | null = null;
  let dropped = 0;
  let delivered = 0;
  const queue: Buffer[] = [];
  const timers: NodeJS.Timeout[] = [];
  let serviceTimer: NodeJS.Timeout | null = null;

  const startService = () => {
    if (serviceTimer) return;
    serviceTimer = setInterval(() => {
      const buf = queue.shift();
      if (buf) {
        delivered += 1;
        const t = setTimeout(() => { b?.onDatagram(buf); }, opts.hopDelayMs);
        if (t.unref) t.unref();
        timers.push(t);
      }
      if (queue.length === 0 && serviceTimer) {
        clearInterval(serviceTimer);
        serviceTimer = null;
      }
    }, opts.serviceMs);
    if (serviceTimer.unref) serviceTimer.unref();
  };

  const aToB = (buf: Buffer) => {
    if (queue.length >= opts.bufferLimit) {
      dropped += 1; // tail-drop: bottleneck buffer full
      return;
    }
    queue.push(Buffer.from(buf));
    startService();
  };

  const bToA = (buf: Buffer) => {
    const copy = Buffer.from(buf);
    const t = setTimeout(() => { a?.onDatagram(copy); }, opts.hopDelayMs);
    if (t.unref) t.unref();
    timers.push(t);
  };

  return {
    setA: (conn: ReliableConnection) => { a = conn; },
    setB: (conn: ReliableConnection) => { b = conn; },
    aToB,
    bToA,
    stats: () => ({ dropped, delivered, queued: queue.length }),
    clear: () => {
      for (const t of timers) clearTimeout(t);
      if (serviceTimer) clearInterval(serviceTimer);
    },
  };
}

test('congestion control: multi-MB transfer over a bottlenecked link, cwnd backs off, no retransmit storm', async () => {
  // Bottleneck: one datagram drained per 0.5ms (~2000 dgram/s) + 5ms propagation,
  // buffer holds 40 datagrams. A sender that paces faster than 2000/s overflows.
  const link = makeBottleneck({ hopDelayMs: 5, serviceMs: 0.5, bufferLimit: 40 });

  const received: Buffer[] = [];
  let peakCwnd = 0;
  let minCwndAfterPeak = Infinity;

  const aConn = new ReliableConnection({
    sendDatagram: (buf) => link.aToB(buf),
    onDeliver: () => { /* A only receives acks */ },
    rtoMinMs: 50,
    rtoMaxMs: 2000,
    keepaliveMs: 2000,
    idleTimeoutMs: 120_000,
  });
  const bConn = new ReliableConnection({
    sendDatagram: (buf) => link.bToA(buf),
    onDeliver: (data) => { received.push(Buffer.from(data)); },
    rtoMinMs: 50,
    rtoMaxMs: 2000,
    keepaliveMs: 2000,
    idleTimeoutMs: 120_000,
  });
  link.setA(aConn);
  link.setB(bConn);

  // Sample cwnd to observe slow-start growth then a backoff after the buffer
  // overruns and loss is detected.
  const sampler = setInterval(() => {
    const c = aConn.__cwnd();
    if (c > peakCwnd) peakCwnd = c;
    // Track the minimum AFTER cwnd has clearly grown past IW (a real dip, not
    // the initial ramp from 10).
    if (peakCwnd > 20 && c < minCwndAfterPeak) minCwndAfterPeak = c;
  }, 2);
  if (sampler.unref) sampler.unref();

  // 2 MB payload → ~1748 datagrams at MAX_PAYLOAD=1200.
  const total = 2 * 1024 * 1024;
  const payload = crypto.randomBytes(total);
  const datagramCount = Math.ceil(total / MAX_PAYLOAD);

  aConn.send(payload);

  const deadline = Date.now() + 120_000;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (Buffer.concat(received).length >= total) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  /* eslint-enable no-await-in-loop */
  clearInterval(sampler);

  const assembled = Buffer.concat(received);
  const stats = aConn.__stats();
  const linkStats = link.stats();

  // Surface the numbers for the integrating parent (before asserts so they show
  // even on failure).
  // eslint-disable-next-line no-console
  console.log(
    `[CC] datagrams=${datagramCount} dataSends=${stats.dataSendCount} ` +
    `ratio=${(stats.dataSendCount / datagramCount).toFixed(2)}x ` +
    `retransmits=${stats.retransmitCount} linkDropped=${linkStats.dropped} ` +
    `peakCwnd=${peakCwnd.toFixed(1)} ` +
    `minCwndAfterPeak=${minCwndAfterPeak === Infinity ? 'n/a' : minCwndAfterPeak.toFixed(1)} ` +
    `srtt=${stats.srtt.toFixed(2)}ms rto=${stats.rto.toFixed(0)}ms`,
  );

  // (a) byte-intact transfer
  assert.strictEqual(assembled.length, total, `expected ${total} bytes, got ${assembled.length}`);
  assert.ok(assembled.equals(payload), 'reassembled payload must be byte-identical and in order');

  // (b) cwnd grew past IW then backed off after real loss
  assert.ok(peakCwnd > 20, `cwnd should grow well past IW (10); peak was ${peakCwnd.toFixed(1)}`);
  assert.ok(linkStats.dropped > 0, 'the bottleneck must have actually dropped datagrams (forcing loss)');
  assert.ok(stats.retransmitCount > 0, 'sender must have retransmitted after loss');
  assert.ok(
    minCwndAfterPeak < peakCwnd * 0.75,
    `cwnd should back off >=25% from peak after loss; peak=${peakCwnd.toFixed(1)} minAfter=${minCwndAfterPeak.toFixed(1)}`,
  );

  // (c) no unbounded retransmit storm
  const ratio = stats.dataSendCount / datagramCount;
  assert.ok(
    ratio < 3,
    `DATA sends should be < 3x datagram count; got ${stats.dataSendCount} sends / ${datagramCount} datagrams = ${ratio.toFixed(2)}x`,
  );

  aConn.close();
  bConn.close();
  link.clear();
});
