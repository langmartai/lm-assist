// core/src/__tests__/fabric/inbound-router.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { routeInboundChannel } from '../../fabric/inbound-router';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';
import { FrameReader } from '../../file-transfer/frame';

function fakeChannel() {
  let dataCb: ((d: Buffer) => void) | null = null;
  let closeCb: ((r?: string) => void) | null = null;
  return {
    peerGatewayId: 'gw4-peer',
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (cb: (r?: string) => void) => { closeCb = cb; },
    feed: (d: Buffer) => dataCb && dataCb(d),
    fireClose: (r?: string) => closeCb && closeCb(r),
  };
}

const helloWire = () => encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' });
const ftTagWire = () => {
  const json = Buffer.from(JSON.stringify({ type: 'lm-file-transfer/1' }), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x00]), json]);
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
};

test('fabric hello routes to fabric and replays the hello to the handler', async () => {
  const ch = fakeChannel();
  const got: string[] = [];
  routeInboundChannel(ch as never, {
    fabric: (routed) => {
      const reader = new FrameReader();
      routed.onData((chunk: Buffer) => {
        for (const f of reader.push(chunk)) if (f.kind === 'control') got.push((f.msg as { kind?: string }).kind ?? '?');
      });
    },
    fileTransfer: () => got.push('WRONG'),
  });
  ch.feed(helloWire());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['hello']);
});

test('file-transfer tag routes to fileTransfer with replay; split frames handled', async () => {
  const ch = fakeChannel();
  let routedTo = '';
  let replayed = 0;
  routeInboundChannel(ch as never, {
    fabric: () => { routedTo = 'fabric'; },
    fileTransfer: (routed) => {
      routedTo = 'ft';
      routed.onData((chunk: Buffer) => { replayed += chunk.length; });
    },
  });
  const wire = ftTagWire();
  ch.feed(wire.subarray(0, 3));      // split mid-prefix — must buffer, not decide
  ch.feed(wire.subarray(3));
  await new Promise((r) => setImmediate(r));
  assert.equal(routedTo, 'ft');
  assert.equal(replayed, wire.length); // every raw byte replayed
});

test('timeout with no decodable frame defaults to fileTransfer', async () => {
  const ch = fakeChannel();
  let routedTo = '';
  routeInboundChannel(ch as never, {
    fabric: () => { routedTo = 'fabric'; },
    fileTransfer: () => { routedTo = 'ft'; },
  }, 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(routedTo, 'ft');
});

test('replay survives a throwing handler callback', async () => {
  const ch = fakeChannel();
  const received: Buffer[] = [];
  let calls = 0;
  let routedTo = '';
  const originalDebug = console.debug;
  let debugCalls = 0;
  console.debug = (..._args: unknown[]) => { debugCalls++; };
  try {
    routeInboundChannel(ch as never, {
      fabric: (routed) => {
        routedTo = 'fabric';
        routed.onData((chunk: Buffer) => {
          calls++;
          if (calls === 1) throw new Error('boom on first replayed chunk');
          received.push(chunk);
        });
      },
      fileTransfer: () => { routedTo = 'WRONG'; },
    });
    const second = Buffer.from('second-chunk');
    ch.feed(helloWire()); // pre-decision: decides fabric, buffers the hello, attaches the wrapped onData
    ch.feed(second);      // still draining (pre-drain) — also buffered, not yet live
    await new Promise((r) => setImmediate(r)); // flush the microtask drain
    assert.equal(routedTo, 'fabric');
    // hello's replay call threw and was isolated (not recorded); second was recorded despite it.
    assert.deepEqual(received, [second]);
    assert.equal(debugCalls, 1); // the throw was logged exactly once, not left to crash the drain

    const third = Buffer.from('third-chunk');
    ch.feed(third); // now live (post-drain) — must still be delivered, not swallowed
    assert.deepEqual(received, [second, third]);
  } finally {
    console.debug = originalDebug;
  }
});

test('close before handler attach is replayed', async () => {
  const ch = fakeChannel();
  let routedTo = '';
  let closedCalled = false;
  let closedReason: string | undefined;
  routeInboundChannel(ch as never, {
    fabric: () => { routedTo = 'WRONG'; },
    fileTransfer: (routed) => {
      routedTo = 'ft';
      routed.onClose((reason?: string) => { closedCalled = true; closedReason = reason; });
    },
  }, 20);
  ch.fireClose('gone'); // fires before routing decides and long before the handler attaches onClose
  await new Promise((r) => setTimeout(r, 40)); // let the 20ms routing timeout fire -> routes to fileTransfer
  assert.equal(routedTo, 'ft');
  assert.equal(closedCalled, true);
  assert.equal(closedReason, 'gone');
});

test('data then close in the same turn delivers data before close', async () => {
  const ch = fakeChannel();
  const log: string[] = [];
  routeInboundChannel(ch as never, {
    fabric: (routed) => {
      const reader = new FrameReader();
      routed.onData((chunk: Buffer) => {
        for (const f of reader.push(chunk)) {
          if (f.kind === 'control') log.push(`data:${(f.msg as { kind?: string }).kind ?? '?'}`);
        }
      });
      routed.onClose(() => { log.push('close'); });
    },
    fileTransfer: () => { log.push('WRONG'); },
  });
  ch.feed(helloWire()); // decides fabric synchronously; attaches wrapped onData (queues drain microtask) + onClose
  ch.fireClose('bye');  // same synchronous turn: underlying close fires right after data, matching real EOF-after-chunk
  await new Promise((r) => setImmediate(r));
  assert.ok(log.indexOf('data:hello') < log.indexOf('close'), `expected data before close, got: ${JSON.stringify(log)}`);
  assert.equal(log.filter((e) => e === 'close').length, 1);
});

test('close racing a still-buffering frame still delivers data before close', async () => {
  const ch = fakeChannel();
  const log: string[] = [];
  let routedTo = '';
  routeInboundChannel(ch as never, {
    fabric: (routed) => {
      routedTo = 'fabric';
      routed.onData(() => { log.push('data'); });
      routed.onClose(() => { log.push('close'); });
    },
    fileTransfer: () => { routedTo = 'WRONG'; },
  });
  const wire = helloWire();
  ch.feed(wire.subarray(0, 5)); // partial — not enough for FrameReader to decode; routing not yet decided
  ch.fireClose('mid');          // fires before any forward exists (mid multi-chunk frame) — must not jump the queue
  ch.feed(wire.subarray(5));    // completes the frame -> decides fabric synchronously, attaches onData then onClose
  await new Promise((r) => setImmediate(r));
  assert.equal(routedTo, 'fabric');
  assert.ok(log.includes('data'), `expected at least one data entry, got: ${JSON.stringify(log)}`);
  assert.equal(log.filter((e) => e === 'close').length, 1, `expected exactly one close, got: ${JSON.stringify(log)}`);
  assert.ok(log.lastIndexOf('data') < log.indexOf('close'), `expected every data entry before close, got: ${JSON.stringify(log)}`);
});

test('onClose last registration wins', async () => {
  const ch = fakeChannel();
  const fired: string[] = [];
  routeInboundChannel(ch as never, {
    fabric: (routed) => {
      routed.onClose(() => { fired.push('A'); });
      routed.onClose(() => { fired.push('B'); });
    },
    fileTransfer: () => { fired.push('WRONG'); },
  });
  ch.feed(helloWire()); // decides fabric synchronously; both onClose registrations happen before any close fires
  ch.fireClose('x');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fired, ['B']);
});
