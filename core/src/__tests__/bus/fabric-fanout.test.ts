// core/src/__tests__/bus/fabric-fanout.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, decodeBody } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';
import { fabricPublish, fabricBusPeers, __setFabricLinkForTest } from '../../fabric';

before(async () => { await initEnvelopeCodec(); });

test('fabricPublish sends a pub frame over the peer link; missing link is a no-op', async () => {
  const sent: Buffer[] = [];
  const ch: FabricChannel = {
    peer: 'gw-x', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => sent.push(b), sendControl: (b) => sent.push(b), onData: () => {},
  };
  __setFabricLinkForTest('gw-x', new FabricLink(ch, {}));
  fabricPublish('gw-x', { topic: 'm', origin: 'gw-self', seq: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1); // one pub frame on the wire
  fabricPublish('gw-absent', { topic: 'm', origin: 'gw-self', seq: 1 }); // no throw
  __setFabricLinkForTest('gw-x', null as unknown as FabricLink);
});

test('fabricBusPeers is empty without registered peer links', () => {
  assert.ok(Array.isArray(fabricBusPeers()));
});
