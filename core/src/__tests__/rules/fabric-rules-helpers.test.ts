// core/src/__tests__/rules/fabric-rules-helpers.test.ts
//
// feat/rules-fabric: mirrors data/fabric-data-helpers.test.ts's fabricDataPeer
// coverage, and fabric-attach.test.ts's real PeerLink+HELLO idiom, for the new
// fabricRulesPeer() receiving-side gate (Task: "a peer advertises 'rules' only
// when its ruleSyncEnabled").
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fabric from '../../fabric';
import { initEnvelopeCodec } from '../../fabric/envelope';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';
import { PeerLink, type LinkChannel } from '../../fabric/peer-link';

before(async () => { await initEnvelopeCodec(); });

test('fabricRulesPeer is false when no fabric link exists', () => {
  assert.equal(fabric.fabricRulesPeer('nobody'), false);
});

/** Mirrors fabric-attach.test.ts's fanoutCloseForTest (production's fanoutClose
 *  isn't exported) — an onClose that supports multiple subscribers, the shape
 *  attachFabricLink() requires from every channel it wires. */
function fanoutCloseForTest(ch: LinkChannel): LinkChannel {
  const subs: Array<(r?: string) => void> = [];
  let closed = false;
  let closeReason: string | undefined;
  ch.onClose((r) => { closed = true; closeReason = r; for (const cb of subs.splice(0)) cb(r); });
  const wrapped = Object.create(ch) as LinkChannel;
  wrapped.onClose = (cb: (r?: string) => void) => { if (closed) { cb(closeReason); return; } subs.push(cb); };
  return wrapped;
}

function fakeCh(): { ch: LinkChannel & { send(b: Buffer): void }; reply: (b: Buffer) => void } {
  let dataCb: ((d: Buffer) => void) | null = null;
  const raw = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    send: (_b: Buffer) => {}, sendControl: (_b: Buffer) => {},
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (_cb: (r?: string) => void) => {},
    close: () => {},
  };
  const ch = fanoutCloseForTest(raw as unknown as LinkChannel) as LinkChannel & { send(b: Buffer): void };
  return { ch, reply: (b) => { if (dataCb) dataCb(b); } };
}

test('fabricRulesPeer is true once a peer connects and its HELLO advertises "rules"', async () => {
  fabric.stopFabric();
  const f = fakeCh();
  const link = new PeerLink('gw-rules-1', { openChannel: async () => { throw new Error('unused — answerer path'); }, selfNode: 'gw-self', now: () => 1 });
  let connectedCh: LinkChannel | null = null;
  link.onConnected((ch) => { connectedCh = ch; });

  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['status', 'rpc', 'comp-gzip', 'rules'], node: 'gw-rules-1' }));
  await new Promise((r) => setImmediate(r));
  assert.ok(connectedCh, 'PeerLink connected');

  assert.equal(fabric.fabricRulesPeer('gw-rules-1'), false, 'not yet attached — no FabricLink registered');
  await fabric.__attachFabricLinkForTest('gw-rules-1', link, connectedCh as unknown as LinkChannel & { send(b: Buffer): void });
  assert.equal(fabric.fabricRulesPeer('gw-rules-1'), true, 'attached AND peer advertised rules');

  fabric.stopFabric();
});

test('fabricRulesPeer is false when the peer is attached but its HELLO did NOT advertise "rules" (mixed-version / ruleSyncEnabled off on its side)', async () => {
  fabric.stopFabric();
  const f = fakeCh();
  const link = new PeerLink('gw-rules-2', { openChannel: async () => { throw new Error('unused — answerer path'); }, selfNode: 'gw-self', now: () => 1 });
  let connectedCh: LinkChannel | null = null;
  link.onConnected((ch) => { connectedCh = ch; });

  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['status', 'rpc', 'comp-gzip'], node: 'gw-rules-2' }));
  await new Promise((r) => setImmediate(r));
  assert.ok(connectedCh, 'PeerLink connected');

  await fabric.__attachFabricLinkForTest('gw-rules-2', link, connectedCh as unknown as LinkChannel & { send(b: Buffer): void });
  assert.equal(fabric.fabricRulesPeer('gw-rules-2'), false, 'attached but peer never advertised rules');

  fabric.stopFabric();
});
