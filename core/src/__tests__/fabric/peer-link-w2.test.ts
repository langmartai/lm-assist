// core/src/__tests__/fabric/peer-link-w2.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerLink, type LinkChannel } from '../../fabric/peer-link';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';

function fakeCh(over: Partial<LinkChannel> = {}) {
  const sent: Buffer[] = [];
  let dataCb: ((d: Buffer) => void) | null = null;
  const ch = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    sendControl: (b: Buffer) => sent.push(b),
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (_cb: (r?: string) => void) => {}, close: () => {},
    ...over,
  };
  return { ch: ch as LinkChannel, sent, reply: (b: Buffer) => dataCb && dataCb(b) };
}
const ack = (features: string[]) => encodeFabricControl({ type: FABRIC_TAG, kind: 'hello-ack', version: FABRIC_VERSION, features, node: 'gw4-peer' });

test('initiator advertises rpc + comp-gzip and captures peer features on connect', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  let connectedCh: LinkChannel | null = null;
  link.onConnected((ch) => { connectedCh = ch; });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  const helloJson = JSON.parse(f.sent[0].subarray(5).toString('utf8'));
  assert.deepEqual(helloJson.features.sort(), ['comp-gzip', 'rpc', 'status']);
  f.reply(ack(['rpc', 'comp-gzip', 'status']));
  await opening;
  assert.ok(connectedCh, 'onConnected fired with the channel');
  assert.equal(link.peerHasFeature('rpc'), true);
  assert.equal(link.peerHasFeature('bus'), false);
  assert.deepEqual(link.peerFeatures().sort(), ['comp-gzip', 'rpc', 'status']);
});

test('answerer fires onConnected once on inbound hello', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('unused'); }, selfNode: 'gw4-self', now: () => 1 });
  let fires = 0;
  link.onConnected(() => { fires++; });
  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc'], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(fires, 1);
  assert.equal(link.peerHasFeature('rpc'), true);
});
