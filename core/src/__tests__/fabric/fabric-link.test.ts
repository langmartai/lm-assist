// core/src/__tests__/fabric/fabric-link.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  initEnvelopeCodec, encodeBody, decodeBody, FabricFrameReader, type Envelope,
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
