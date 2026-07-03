// core/src/__tests__/fabric/fabric-attach.test.ts
//
// Covers the piece the brief's own fabric-request.test.ts deliberately skips
// ("real channels need a hub; the live path is Task 16") at the unit level:
// that connecting a PeerLink actually ATTACHES a FabricLink (fabric/index.ts's
// attachFabricLink, driven in production by PeerLink.onConnected inside
// initFabric's makeLink / fabricAcceptInbound), and that doing so does not
// regress W1's own close-driven link-state tracking.
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec } from '../../fabric/envelope';
import { PeerLink, type LinkChannel } from '../../fabric/peer-link';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';
import { getFabricLink, __attachFabricLinkForTest, stopFabric } from '../../fabric';

before(async () => { await initEnvelopeCodec(); });

/**
 * Mirrors fabric/index.ts's private `fanoutClose` (not exported from
 * production) so this test can drive the SAME shape production hands to
 * PeerLink/attachFabricLink: an onClose that supports multiple subscribers.
 * This is what lets the test prove BOTH PeerLink's own close→state-transition
 * handler AND attachFabricLink's failInflight wiring fire off the same
 * underlying close, instead of the second clobbering the first.
 */
function fanoutCloseForTest(ch: LinkChannel): LinkChannel {
  const subs: Array<(r?: string) => void> = [];
  let closed = false;
  let closeReason: string | undefined;
  ch.onClose((r) => {
    closed = true;
    closeReason = r;
    for (const cb of subs.splice(0)) cb(r);
  });
  const wrapped = Object.create(ch) as LinkChannel;
  wrapped.onClose = (cb: (r?: string) => void) => {
    if (closed) { cb(closeReason); return; }
    subs.push(cb);
  };
  return wrapped;
}

function fakeCh(): { ch: LinkChannel & { send(b: Buffer): void }; reply: (b: Buffer) => void; fireClose: (r?: string) => void } {
  let dataCb: ((d: Buffer) => void) | null = null;
  let closeCb: ((r?: string) => void) | null = null;
  const raw = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    send: (_b: Buffer) => {},
    sendControl: (_b: Buffer) => {},
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (cb: (r?: string) => void) => { closeCb = cb; },
    close: () => {},
  };
  const ch = fanoutCloseForTest(raw as unknown as LinkChannel) as LinkChannel & { send(b: Buffer): void };
  return {
    ch,
    reply: (b) => { if (dataCb) dataCb(b); },
    fireClose: (r) => { if (closeCb) closeCb(r); }, // invokes fanoutCloseForTest's dispatcher, which fans out to every subscriber
  };
}

test('a FabricLink is attached on link connect, and onClose fails in-flight calls WITHOUT clobbering W1 close handling', async () => {
  stopFabric();
  const f = fakeCh();
  const link = new PeerLink('gw-attach-1', {
    openChannel: async () => { throw new Error('unused — this test exercises the answerer (adopt) path'); },
    selfNode: 'gw-self',
    now: () => 1,
  });

  let connectedCh: LinkChannel | null = null;
  link.onConnected((ch) => { connectedCh = ch; });

  // Answerer path: adopt the (fanout-wrapped) inbound channel, then receive
  // the peer's hello — mirrors what fabricAcceptInbound + PeerLink.adopt do
  // in production.
  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc', 'comp-gzip'], node: 'gw-attach-1' }));
  await new Promise((r) => setImmediate(r));
  assert.ok(connectedCh, 'PeerLink.onConnected fired with the channel');
  assert.equal(link.core.state, 'connected', 'W1: PeerLink reached connected state');

  assert.equal(getFabricLink('gw-attach-1'), null, 'nothing attached yet — attachFabricLink has not run');
  await __attachFabricLinkForTest('gw-attach-1', link, connectedCh as unknown as LinkChannel & { send(b: Buffer): void });
  const fl = getFabricLink('gw-attach-1');
  assert.ok(fl, 'a FabricLink is attached once the link connects');

  // An in-flight fabricRequest-shaped call must fail FAST on channel close
  // (this task's failInflight wiring) rather than waiting out its own
  // request timeout.
  let failure: Error | null = null;
  const pending = fl!.request({ method: 'GET', path: '/x', timeoutMs: 5000 }).catch((e: Error) => { failure = e; });

  f.fireClose('peer dropped');
  await pending;
  await new Promise((r) => setImmediate(r));

  assert.ok(failure, 'the in-flight call was rejected, not left to time out');
  assert.match(String(failure && (failure as Error).message), /closed/i);

  // W1 preserved: PeerLink's OWN close handler (registered inside adopt()'s
  // attach(), BEFORE attachFabricLink ever ran) must ALSO have fired — proof
  // that attachFabricLink's later onClose registration did not clobber it.
  assert.notEqual(link.core.state, 'connected', 'W1: PeerLink also observed the close and left connected state');

  stopFabric();
});

test('Task 12 review fix: a post-connect re-advertise hello reaches PeerLink through the REAL onHello wiring, not dropped', async () => {
  // Regresses W1's direct-TCP-for-LAN fast path if onHello is a no-op: once
  // FabricLink attaches it becomes the channel's sole onData reader (single
  // slot — see fakeCh() below), so a hello arriving AFTER attach (e.g. the
  // peer's setFabricSelfTcp 4s boot-race re-advertise, or any readvertiseAll())
  // only ever reaches PeerLink if attachFabricLink's onHello forwards it via
  // PeerLink.ingestPeerHello(). Before the fix this test is RED: peerTcp()
  // stays null because the no-op onHello silently swallows the hello.
  stopFabric();
  const f = fakeCh();
  const link = new PeerLink('gw-hello-1', {
    openChannel: async () => { throw new Error('unused — answerer path'); },
    selfNode: 'gw-self',
    now: () => 1,
  });

  let connectedCh: LinkChannel | null = null;
  link.onConnected((ch) => { connectedCh = ch; });

  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc', 'comp-gzip'], node: 'gw-hello-1' }));
  await new Promise((r) => setImmediate(r));
  assert.ok(connectedCh, 'PeerLink connected');
  assert.equal(link.peerTcp(), null, 'no tcp advertised on the initial hello');

  await __attachFabricLinkForTest('gw-hello-1', link, connectedCh as unknown as LinkChannel & { send(b: Buffer): void });
  assert.ok(getFabricLink('gw-hello-1'), 'FabricLink attached — it now owns onData, not PeerLink');

  // Peer's TCP listener binds late and re-advertises on the ALREADY-connected
  // link. This frame now arrives on FabricLink's onData (single-slot channel
  // — the same fakeCh() used by the test above), never PeerLink's own handler.
  f.reply(encodeFabricControl({
    type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc', 'comp-gzip'], node: 'gw-hello-1',
    tcp: { host: '10.0.1.77', port: 3100 },
  }));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(
    link.peerTcp(),
    { host: '10.0.1.77', port: 3100 },
    'W1: post-connect re-advertise TCP endpoint reached PeerLink via the real onHello wiring',
  );

  stopFabric();
});
