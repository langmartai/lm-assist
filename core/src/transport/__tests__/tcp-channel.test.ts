/**
 * TcpChannel — Channel interface over a real net.Socket pair on 127.0.0.1.
 *
 * These are REAL loopback TCP sockets (not an in-process fake pair like the
 * UDP/ReliableConnection tests) — that is deliberate: the whole point of D1 is
 * that the kernel does reliability/ordering/backpressure for us, so the test
 * has to exercise the actual kernel socket to mean anything.
 *
 * Run (compiled): node --test dist-test/transport/__tests__/tcp-channel.test.js
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as net from 'net';
import * as crypto from 'crypto';
import { TcpChannel, createTcpChannelFromSocket } from '../tcp-channel';

/** Bring up a real TCP server+client pair on 127.0.0.1 and hand back BOTH raw
 *  sockets once fully connected. Callers decide when (if ever) to wrap each end
 *  in a TcpChannel — this matters for the backpressure test, which needs one
 *  end to stay a raw, un-drained socket for a while. */
function makeSocketPair(): Promise<{ server: net.Server; a: net.Socket; b: net.Socket }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server address unavailable'));
        return;
      }
      let a: net.Socket | undefined;
      let bConnected = false;
      const tryResolve = () => {
        if (a && bConnected) resolve({ server, a, b });
      };
      const b = net.connect({ host: '127.0.0.1', port: addr.port });
      b.on('connect', () => {
        bConnected = true;
        tryResolve();
      });
      b.on('error', reject);
      server.once('connection', (sock) => {
        a = sock;
        tryResolve();
      });
    });
  });
}

function closePair(server: net.Server, ...sockets: net.Socket[]): Promise<void> {
  return new Promise((resolve) => {
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    server.close(() => resolve());
  });
}

test('integrity: varying-size messages (incl. >64KB) arrive intact, in order, boundaries preserved (A->B)', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chA = createTcpChannelFromSocket(a, 'peerB');
  const chB = createTcpChannelFromSocket(b, 'peerA');
  t.after(() => closePair(server, a, b));

  const sizes = [0, 1, 13, 4096, 70 * 1024, 300 * 1024]; // includes >64KB for multi-chunk reassembly
  const messages = sizes.map((n) => crypto.randomBytes(n));

  const received: Buffer[] = [];
  const gotAll = new Promise<void>((resolve) => {
    chB.onData((data) => {
      received.push(Buffer.from(data));
      if (received.length === messages.length) resolve();
    });
  });

  for (const m of messages) chA.send(m);

  await gotAll;

  assert.equal(received.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    assert.ok(received[i].equals(messages[i]), `message ${i} (size ${sizes[i]}) mismatch`);
  }
});

test('integrity: varying-size messages also preserve boundaries in the reverse direction (B->A)', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chA = createTcpChannelFromSocket(a, 'peerB');
  const chB = createTcpChannelFromSocket(b, 'peerA');
  t.after(() => closePair(server, a, b));

  const sizes = [5, 2000, 80 * 1024];
  const messages = sizes.map((n) => crypto.randomBytes(n));

  const received: Buffer[] = [];
  const gotAll = new Promise<void>((resolve) => {
    chA.onData((data) => {
      received.push(Buffer.from(data));
      if (received.length === messages.length) resolve();
    });
  });

  for (const m of messages) chB.send(m);

  await gotAll;

  assert.equal(received.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    assert.ok(received[i].equals(messages[i]), `message ${i} (size ${sizes[i]}) mismatch`);
  }
});

test('integrity: a message deliberately split across TCP segments (incl. mid-length-prefix) reassembles correctly', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chB = createTcpChannelFromSocket(b, 'peerA');
  t.after(() => closePair(server, a, b));

  const payload = crypto.randomBytes(50000);
  // Hand-build exactly the frame TcpChannel.send() would produce ([4B BE
  // len][payload]), then feed it to the RAW socket in pieces at arbitrary byte
  // offsets — including a split INSIDE the 4-byte length prefix itself — so
  // reassembly is proven deterministically, independent of whatever chunking
  // the OS/loopback happens to choose on its own.
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const framed = Buffer.concat([lenBuf, payload]);
  const splitPoints = [2, 4, 5, 30000, framed.length];

  const received: Buffer[] = [];
  const got = new Promise<void>((resolve) => {
    chB.onData((data) => {
      received.push(Buffer.from(data));
      resolve();
    });
  });

  let prev = 0;
  for (const p of splitPoints) {
    if (p === prev) continue;
    a.write(framed.subarray(prev, p));
    await new Promise((r) => setImmediate(r)); // force separate 'data' events on b
    prev = p;
  }

  await got;
  assert.equal(received.length, 1);
  assert.ok(received[0].equals(payload));
});

test('backpressure: send() signals not-writable under load and resumes cleanly on drain, no data lost', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chA = createTcpChannelFromSocket(a, 'peerB', { maxQueueBytes: 64 * 1024 * 1024 });
  t.after(() => closePair(server, a, b));
  // Deliberately do NOT wrap `b` yet: TcpChannel's constructor attaches a
  // 'data' listener immediately, which would put the socket in flowing mode
  // and start draining `a`'s writes right away. Leaving `b` a raw, listener-less
  // socket keeps it paused (Node default) so nothing drains `a` — that's what
  // actually forces socket.write() to return false.

  const chunk = crypto.randomBytes(200 * 1024);
  const N = 50; // 10MB total, comfortably over default socket buffers
  let sawNotWritable = false;
  let drained = false;
  chA.onDrain(() => {
    drained = true;
  });

  for (let i = 0; i < N; i++) {
    const ok = chA.send(chunk);
    if (!ok) sawNotWritable = true;
  }
  assert.ok(sawNotWritable, 'expected socket.write to signal backpressure under this load');
  assert.equal(chA.isWritable(), false);

  // Now wrap + drain the receiver and verify every byte still arrives.
  const chB = createTcpChannelFromSocket(b, 'peerA');
  let receivedBytes = 0;
  let receivedCount = 0;
  const allIn = new Promise<void>((resolve) => {
    chB.onData((data) => {
      receivedBytes += data.length;
      receivedCount += 1;
      if (receivedCount === N) resolve();
    });
  });

  await allIn;
  assert.equal(receivedCount, N);
  assert.equal(receivedBytes, N * chunk.length);
  assert.ok(drained, 'expected onDrain to fire once the socket caught up');
  assert.equal(chA.isWritable(), true);
});

test('hard cap: send() far past maxQueueBytes while never draining tears the channel down', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chA = createTcpChannelFromSocket(a, 'peerB', { maxQueueBytes: 64 * 1024 });
  t.after(() => closePair(server, a, b));
  // `b` is intentionally left raw/un-drained so nothing ever relieves backpressure.

  let closeReason: string | undefined;
  let closeCount = 0;
  const closed = new Promise<void>((resolve) => {
    chA.onClose((r) => {
      closeCount += 1;
      closeReason = r;
      resolve();
    });
  });

  const chunk = crypto.randomBytes(64 * 1024);
  // Keep sending well past the 64KB cap; the channel should tear itself down
  // rather than let the internal queue grow without bound.
  for (let i = 0; i < 50 && closeCount === 0; i++) {
    chA.send(chunk);
  }

  await closed;
  assert.equal(closeCount, 1);
  assert.ok(closeReason && /overflow/i.test(closeReason), `expected an overflow reason, got: ${closeReason}`);
});

test('close: closing one end fires the other end onClose exactly once', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chA = createTcpChannelFromSocket(a, 'peerB');
  const chB = createTcpChannelFromSocket(b, 'peerA');
  t.after(() => closePair(server, a, b));

  let closeCount = 0;
  let reason: string | undefined;
  const closed = new Promise<void>((resolve) => {
    chB.onClose((r) => {
      closeCount += 1;
      reason = r;
      resolve();
    });
  });

  chA.close();
  await closed;

  // Give any duplicate close-ish events (both 'end' and 'close' firing) a
  // chance to manifest before asserting exactly-once.
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(closeCount, 1, `onClose should fire exactly once, fired ${closeCount} times`);
  assert.ok(reason, 'expected a reason string');
});

test('basic shape: mode/via/rtt/directReady/id match the Channel contract for a fresh TCP channel', async (t) => {
  const { server, a, b } = await makeSocketPair();
  const chA: TcpChannel = createTcpChannelFromSocket(a, 'peerB', { id: 'fixed-id-1' });
  t.after(() => closePair(server, a, b));

  assert.equal(chA.id, 'fixed-id-1');
  assert.equal(chA.peerGatewayId, 'peerB');
  assert.equal(chA.mode, 'bidi');
  assert.equal(chA.via, 'host');
  assert.equal(chA.rtt, null);
  assert.equal(chA.directReady(), true);
});
