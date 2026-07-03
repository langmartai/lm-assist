// core/src/__tests__/bus/fabric-link-pub.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, type Envelope } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';

before(async () => { await initEnvelopeCodec(); });

function pair() {
  let onA: ((d: Buffer) => void) | null = null;
  let onB: ((d: Buffer) => void) | null = null;
  const chA: FabricChannel = {
    peer: 'B', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => onB?.(b), sendControl: (b) => onB?.(b), onData: (cb) => { onA = cb; },
  };
  const chB: FabricChannel = {
    peer: 'A', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => onA?.(b), sendControl: (b) => onA?.(b), onData: (cb) => { onB = cb; },
  };
  return { chA, chB };
}

test('an inbound pub frame is dispatched to onBus (not dropped)', async () => {
  const { chA, chB } = pair();
  const got: Envelope[] = [];
  new FabricLink(chB, { onBus: (env) => got.push(env) }); // receiver
  const sender = new FabricLink(chA, {});
  await sender.sendEnvelope({ kind: 'pub', id: 'p1', headers: { cls: 'bus' }, payload: encodeBody({ topic: 'm', origin: 'A', seq: 1 }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'pub');
  assert.deepEqual(encodeBody ? (require('../../fabric/envelope').decodeBody(got[0].payload)) : null, { topic: 'm', origin: 'A', seq: 1 });
});
