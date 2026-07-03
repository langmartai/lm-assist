// core/src/__tests__/fabric/fabric-link.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  initEnvelopeCodec, encodeBody, decodeBody, encodeEnvelope, FabricFrameReader,
  type Envelope, type TrafficClass,
} from '../../fabric/envelope';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION, type FabricHello } from '../../fabric/protocol';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';

before(async () => { await initEnvelopeCodec(); });

/** A pair of in-memory channels: A.send → B.onData and vice-versa (microtask hop). */
function pair(policy: 'direct' | 'relay' = 'direct') {
  let aCb: ((d: Buffer) => void) | null = null;
  let bCb: ((d: Buffer) => void) | null = null;
  const deliver = (d: Buffer, sink: (d: Buffer) => void) => queueMicrotask(() => sink(d));
  const a: FabricChannel = {
    peer: 'B', policy: () => policy, peerHasFeature: () => true,
    send: (b) => deliver(b, (d) => bCb && bCb(d)),
    sendControl: (b) => deliver(b, (d) => bCb && bCb(d)),
    onData: (cb) => { aCb = cb; },
  };
  const b: FabricChannel = {
    peer: 'A', policy: () => policy, peerHasFeature: () => true,
    send: (bb) => deliver(bb, (d) => aCb && aCb(d)),
    sendControl: (bb) => deliver(bb, (d) => aCb && aCb(d)),
    onData: (cb) => { bCb = cb; },
  };
  return { a, b };
}

/** Deterministic pseudo-random fill (matches compression.test.ts's convention) —
 *  avoids Math.random() flakiness while still defeating gzip on the entropy-sample path. */
function fillPseudoRandom(buf: Uint8Array): void {
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) & 0xff;
}

test('request → server echo round-trips through compress/split/reassemble', async () => {
  const { a, b } = pair('relay'); // relay path exercises gzip level 6
  // Server B: echo the req body back as res with status 200.
  new FabricLink(b, {
    onServer: (env, reply) => {
      const body = decodeBody(env.payload) as { body?: unknown };
      reply({ kind: 'res', id: env.id, headers: { status: 200, 'content-type': 'application/json' }, payload: encodeBody({ echoed: body.body }) });
    },
  });
  const client = new FabricLink(a, {});
  const bigText = 'x'.repeat(50_000); // >4KB → compressed; <64KB → single frame
  const res = await client.request({ method: 'POST', path: '/echo', body: { text: bigText }, contentType: 'application/json' });
  assert.equal(res.headers.status, 200);
  const data = decodeBody(res.payload) as { echoed: { text: string } };
  assert.equal(data.echoed.text, bigText);
});

test('a >64KB body is split into multiple frames and reassembled intact', async () => {
  const { a, b } = pair('direct');
  new FabricLink(b, {
    onServer: (env, reply) => {
      // request() wraps the caller's body as { body, query } — unwrap it like a real
      // RPC server would (mirrors test 1's onServer), then echo just the body back.
      const parsed = decodeBody(env.payload) as { body?: { blob?: Uint8Array } };
      reply({ kind: 'res', id: env.id, headers: { status: 200 }, payload: encodeBody({ blob: parsed.body?.blob }) });
    },
  });
  const client = new FabricLink(a, {});
  const buf = new Uint8Array(200_000);
  fillPseudoRandom(buf); // high-entropy: won't shrink under 64KB even if compression were attempted
  // application/octet-stream is BINARYLIKE → compression is skipped outright (deterministic split).
  const res = await client.request({ method: 'POST', path: '/blob', body: { blob: buf }, contentType: 'application/octet-stream' });
  assert.equal(res.headers.status, 200);
  const data = decodeBody(res.payload) as { blob: Uint8Array };
  assert.equal(data.blob.length, buf.length);
  assert.deepEqual(Buffer.from(data.blob), Buffer.from(buf));
});

test('request rejects on timeout when no response arrives', async () => {
  const { a } = pair('direct'); // no server on the other end
  const client = new FabricLink(a, {});
  // PendingCalls.register()'s timer is deliberately unref'd (a live link with pending
  // calls must never block process exit) — same as pending-calls.test.ts's own timeout
  // test, hold the loop open with a ref'd interval so the unref'd 30ms timer gets a
  // chance to fire instead of the process considering itself drained first.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(client.request({ method: 'GET', path: '/void', timeoutMs: 30 }), /timeout/);
  } finally {
    clearInterval(keepAlive);
  }
});

test('a compressible body is sent as comp:"gzip" on the wire; receiver decompresses correctly', async () => {
  const { a, b } = pair('relay');
  const frames: Buffer[] = [];
  const origSendControl = a.sendControl.bind(a);
  a.sendControl = (buf: Buffer) => { frames.push(buf); origSendControl(buf); };
  new FabricLink(b, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200 }, payload: env.payload }),
  });
  const client = new FabricLink(a, {});
  const bigText = 'y'.repeat(20_000);
  const res = await client.request({ method: 'POST', path: '/c', body: { text: bigText }, contentType: 'application/json' });
  assert.equal(res.headers.status, 200);
  assert.equal(frames.length, 1, 'single frame — compressed payload stays under the 64KB chunk threshold');
  const [inb] = new FabricFrameReader().push(frames[0]);
  assert.equal(inb.kind, 'envelope');
  const wireEnv = (inb as { kind: 'envelope'; env: Envelope }).env;
  assert.equal(wireEnv.headers.comp, 'gzip');
  assert.ok((wireEnv.headers.rawLen ?? 0) > wireEnv.payload.length, 'gzip actually shrank the wire payload');
});

test('compression is skipped when the peer lacks comp-gzip (mixed-version interop)', async () => {
  const { a, b } = pair('relay');
  a.peerHasFeature = () => false; // simulate a W1-only / older peer with no comp-gzip feature
  const frames: Buffer[] = [];
  const origSendControl = a.sendControl.bind(a);
  a.sendControl = (buf: Buffer) => { frames.push(buf); origSendControl(buf); };
  new FabricLink(b, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200 }, payload: env.payload }),
  });
  const client = new FabricLink(a, {});
  const bigText = 'z'.repeat(20_000);
  const res = await client.request({ method: 'POST', path: '/nc', body: { text: bigText }, contentType: 'application/json' });
  assert.equal(res.headers.status, 200);
  const [inb] = new FabricFrameReader().push(frames[0]);
  const wireEnv = (inb as { kind: 'envelope'; env: Envelope }).env;
  assert.equal(wireEnv.headers.comp, 'none');
});

test('a hello frame arriving on the channel is forwarded via onHello, not swallowed', async () => {
  const { a, b } = pair('direct');
  const received: FabricHello[] = [];
  new FabricLink(a, { onHello: (h) => received.push(h) });
  const helloBuf = encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc'], node: 'gwX' });
  b.sendControl(helloBuf); // W1 re-advertising on the same live channel FabricLink now owns
  await new Promise((r) => setImmediate(r));
  assert.equal(received.length, 1);
  assert.equal(received[0].node, 'gwX');
  assert.deepEqual(received[0].features, ['rpc']);
});

test('ping resolves with an RTT after the peer auto-pongs', async () => {
  const { a, b } = pair('direct');
  new FabricLink(b, {}); // no onServer needed — dispatch() auto-pongs any ping
  const client = new FabricLink(a, {});
  const rtt = await client.ping();
  assert.equal(typeof rtt, 'number');
  assert.ok(rtt >= 0);
  assert.equal(client.metrics.snapshot().rttMs, rtt);
});

test('failInflight rejects all outstanding requests on this link', async () => {
  const { a } = pair('direct'); // no server; request would otherwise hang until its timeout
  const client = new FabricLink(a, {});
  const p = client.request({ method: 'GET', path: '/x', timeoutMs: 5000 });
  client.failInflight(new Error('link closed'));
  await assert.rejects(p, /link closed/);
});

test('a send failure rejects request() without leaking the pending waiter (no unhandled rejection)', async () => {
  // send/sendControl both throw synchronously — e.g. a channel that closed
  // between register() storing the waiter and the write actually happening.
  const ch: FabricChannel = {
    peer: 'B', policy: () => 'direct', peerHasFeature: () => true,
    send: () => { throw new Error('boom: channel send failed'); },
    sendControl: () => { throw new Error('boom: channel send failed'); },
    onData: () => {},
  };
  const client = new FabricLink(ch, { requestTimeoutMs: 20 });
  const pendingSize = () => (client as unknown as { pending: { size: () => number } }).pending.size();

  let unhandled: unknown = null;
  const onUnhandledRejection = (err: unknown) => { unhandled = err; };
  process.once('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(client.request({ method: 'GET', path: '/x' }), /boom: channel send failed/);

    // The orphaned-waiter bug leaves an entry in PendingCalls forever (nothing
    // ever resolves/rejects it) — assert it was cleaned up immediately rather
    // than left to reject later, alone, on its own unref'd timeout.
    assert.equal(pendingSize(), 0, 'the pending waiter must be rejected+removed when the send fails, not orphaned');

    // Belt-and-suspenders: hold the loop open past requestTimeoutMs (the
    // waiter's timer is unref'd — see the timeout test above) so an orphaned
    // waiter would actually get a chance to fire and prove itself unhandled.
    const keepAlive = setInterval(() => {}, 100);
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(keepAlive);
    assert.equal(unhandled, null, 'the registered pending waiter must not reject as an unobserved rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('an envelope with an unrecognized wire cls does not crash onData and is still delivered', () => {
  let deliver: ((d: Buffer) => void) | null = null;
  const ch: FabricChannel = {
    peer: 'B', policy: () => 'direct', peerHasFeature: () => true,
    send: () => {}, sendControl: () => {},
    onData: (cb) => { deliver = cb; },
  };
  const delivered: Envelope[] = [];
  new FabricLink(ch, { onServer: (env) => { delivered.push(env); } });

  // A wire cls outside control|rpc|bus|bulk (e.g. from a newer/differently
  // versioned peer) must not abort classOf()'s caller — LinkMetrics.recordIn
  // indexes a Record<TrafficClass,Ewma> by whatever classOf() returns.
  const foreignEnv: Envelope = {
    kind: 'req', id: 'foreign-1',
    headers: { method: 'GET', path: '/x', reqId: 'foreign-1', cls: 'meta-future' as unknown as TrafficClass },
    payload: encodeBody({ body: null, query: {} }),
  };
  assert.doesNotThrow(() => deliver!(encodeEnvelope(foreignEnv)), 'onData must not throw on an unrecognized wire cls');
  assert.equal(delivered.length, 1, 'the frame must still be delivered to onServer despite the unrecognized cls');
  assert.equal(delivered[0].id, 'foreign-1');
});

test('failInflight resets the chunk assembler so a stale partial reassembly does not survive', async () => {
  const { a, b } = pair('direct');
  const client = new FabricLink(a, {});
  // seq:0, fin:false — leaves the assembler holding an open partial for
  // 'stale-1' until a matching fin frame arrives (never does, in this test).
  const partial: Envelope = {
    kind: 'req', id: 'stale-1',
    headers: { method: 'GET', path: '/x', seq: 0, fin: false },
    payload: encodeBody({ body: null, query: {} }),
  };
  b.sendControl(encodeEnvelope(partial));
  await new Promise((r) => setImmediate(r));
  const assembler = () => (client as unknown as { assembler: { open: Map<string, unknown> } }).assembler;
  assert.equal(assembler().open.size, 1, 'sanity: a partial reassembly is retained before failInflight');

  client.failInflight(new Error('link closed'));

  assert.equal(assembler().open.size, 0, 'failInflight must reset the assembler so no stale partial reassembly survives');
});

// ---------------------------------------------------------------------------
// Cross-node transmission bug fix (fabric/index.ts's attachFabricLink now
// follows the PeerLink's CURRENT channel across a relay→direct upgrade
// instead of closing over the first channel forever). channelSwapped() is
// the FabricLink-side half of that fix: it resets the byte-stream state tied
// to the OLD channel (a FabricFrameReader mid-parse / a ChunkAssembler
// holding a partial reassembly are both meaningless — and corrupting — on a
// fresh stream from a different channel) without tearing down the FabricLink
// object itself (metrics/scheduler/object identity survive; see
// fabric-attach.test.ts for the end-to-end proof through the real
// attachFabricLink wiring using a mock PeerLink-shaped swap).
// ---------------------------------------------------------------------------
test('channelSwapped() resets the reader/assembler so a stale partial from the old channel cannot corrupt a message on the new one, and rejects in-flight calls', async () => {
  const wireOld = pair('relay');
  const wireNew = pair('direct');

  // The facade under test is SWAPPABLE — mirrors attachFabricLink's dynamic
  // facade (fabric/index.ts), which resolves link.currentChannel() live on
  // every send/sendControl call and re-registers onData on every swap,
  // instead of the pre-fix code that closed over one channel's send/
  // sendControl/onData forever.
  let current = wireOld.a;
  let dataCb: ((d: Buffer) => void) | null = null;
  const swappableFacade: FabricChannel = {
    peer: 'B', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => current.send(b),
    sendControl: (b) => current.sendControl(b),
    onData: (cb) => { dataCb = cb; current.onData(cb); },
  };
  const client = new FabricLink(swappableFacade, {});
  new FabricLink(wireNew.b, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200 }, payload: env.payload }),
  });

  // A message starts arriving on the OLD channel but never finishes (seq:0,
  // fin:false) — leaves the client's assembler holding a dangling partial.
  const partial: Envelope = {
    kind: 'req', id: 'stale-from-old-channel',
    headers: { method: 'GET', path: '/x', seq: 0, fin: false },
    payload: encodeBody({ body: null, query: {} }),
  };
  wireOld.b.sendControl(encodeEnvelope(partial));
  await new Promise((r) => setImmediate(r));
  const assemblerOpenSize = () => (client as unknown as { assembler: { open: Map<string, unknown> } }).assembler.open.size;
  assert.equal(assemblerOpenSize(), 1, 'sanity: the partial reassembly is retained before the swap');

  // A request registered on the OLD channel is still in flight at swap time.
  const staleCall = client.request({ method: 'GET', path: '/before-swap', timeoutMs: 5000 });
  const pendingSize = () => (client as unknown as { pending: { size: () => number } }).pending.size();
  assert.equal(pendingSize(), 1, 'sanity: the pre-swap call is pending before the swap');

  // --- the swap: attachFabricLink's onChannel handler does exactly these
  // calls, in this order (fabric/index.ts) ---
  current = wireNew.a;
  client.channelSwapped();
  if (dataCb) current.onData(dataCb);

  await assert.rejects(staleCall, /swapped/, 'a call in flight on the OLD channel is rejected, not left hanging forever');
  assert.equal(pendingSize(), 0, 'channelSwapped() clears pending calls tied to the dead channel');
  assert.equal(assemblerOpenSize(), 0, 'channelSwapped() drops the stale partial from the old channel');

  // A request issued AFTER the swap must go out on the NEW wire (the pre-fix
  // bug pinned sends to the first channel forever, so this would hang) and a
  // response delivered on the NEW wire must resolve it.
  const res = await client.request({ method: 'GET', path: '/after-swap', timeoutMs: 2000 });
  assert.equal(res.headers.status, 200);

  // And the dangling partial from the old channel did not leak forward and
  // corrupt/block the new channel's clean round trip.
  assert.equal(assemblerOpenSize(), 0, 'no leftover partial after a clean round trip on the new channel');
});
