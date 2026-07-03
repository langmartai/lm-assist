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

// ---------------------------------------------------------------------------
// Cross-node transmission bug fix: FabricLink must follow the PeerLink's
// CURRENT channel across a relay→direct upgrade (or any other reconnect that
// hands PeerLink a new channel while the same PeerLink instance stays alive).
// onConnected() only ever reports the FIRST channel (connectedFired gate) —
// onChannel()/currentChannel() are the new, swap-aware surface attachFabricLink
// (fabric/index.ts) subscribes to instead. See fabric-attach.test.ts for the
// end-to-end proof through the real attachFabricLink wiring; this is the
// narrow unit test on PeerLink alone.
// ---------------------------------------------------------------------------
test('onChannel fires on the first live channel and again on a swap; currentChannel() reflects the latest', async () => {
  const f1 = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('unused — answerer path'); }, selfNode: 'gw4-self', now: () => 1 });
  const seen: LinkChannel[] = [];
  link.onChannel((ch) => { seen.push(ch); });
  assert.equal(link.currentChannel(), null, 'no channel before connect');

  link.adopt(f1.ch);
  f1.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1, 'onChannel fired once on the first connect');
  assert.equal(seen[0], f1.ch);
  assert.equal(link.currentChannel(), f1.ch);

  // Simulate a relay->direct upgrade: a second adopt() on the SAME PeerLink
  // instance (production: PeerManager.acceptInbound() calling adopt() again
  // on an already-connected link when a fresh inbound channel for the same
  // peer is routed — e.g. a direct connection arriving after the relay one).
  const f2 = fakeCh();
  link.adopt(f2.ch);
  f2.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 2, 'onChannel fired again on the swap');
  assert.equal(seen[1], f2.ch);
  assert.notEqual(seen[1], seen[0], 'the swap channel is a different object from the first');
  assert.equal(link.currentChannel(), f2.ch, 'currentChannel() reflects the latest channel, not the first');
});

test('onConnected still fires exactly once across a swap (no regression) while onChannel fires for both', async () => {
  const f1 = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('unused — answerer path'); }, selfNode: 'gw4-self', now: () => 1 });
  let connectedFires = 0;
  let channelFires = 0;
  link.onConnected(() => { connectedFires++; });
  link.onChannel(() => { channelFires++; });

  link.adopt(f1.ch);
  f1.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));

  const f2 = fakeCh();
  link.adopt(f2.ch);
  f2.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));

  assert.equal(connectedFires, 1, 'onConnected must still fire exactly once (unchanged W1/W2 semantics)');
  assert.equal(channelFires, 2, 'onChannel fires on every (re)connect, including the swap');
});
