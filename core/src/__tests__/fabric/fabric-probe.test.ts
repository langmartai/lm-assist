// core/src/__tests__/fabric/fabric-probe.test.ts
//
// Task 13 fix (flagged by the Task 12 review as Task 13's territory):
// fabricProbe()'s `path` field was derived from
// `LinkMetrics.snapshot().perClass.control.outBps >= 0 ? (rtt >= 0 ? 'direct' : 'relay') : 'none'`
// — outBps and rtt are never negative, so the ternaries were always true and
// `path` always reported 'direct' for any connected link, relay included.
// This proves `path` now reflects the SAME live `mode` that /fabric/status
// already exposes per peer (PeerLinkSnapshot.mode, sourced from the
// transport Channel's live mode getter via PeerManager.snapshot()), not that
// bogus always-true heuristic.
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';
import {
  fabricProbe, stopFabric, __initFabricForTest, __setFabricLinkForTest, fabricAcceptInbound,
} from '../../fabric';

before(async () => { await initEnvelopeCodec(); });

/** A ping-capable FabricLink paired with an in-process peer that auto-replies
 *  pong (FabricLink.dispatch() handles 'ping'->'pong' itself — no onServer
 *  needed). Mirrors fabric-request.test.ts's echoLink()/pairedLink() pattern. */
function pingPair(peer: string): FabricLink {
  let aCb: ((d: Buffer) => void) | null = null;
  let bCb: ((d: Buffer) => void) | null = null;
  const clientCh: FabricChannel = {
    peer, policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => bCb && bCb(b)),
    sendControl: (b) => queueMicrotask(() => bCb && bCb(b)),
    onData: (cb) => { aCb = cb; },
  };
  const serverCh: FabricChannel = {
    peer: 'self', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => aCb && aCb(b)),
    sendControl: (b) => queueMicrotask(() => aCb && aCb(b)),
    onData: (cb) => { bCb = cb; },
  };
  const server = new FabricLink(serverCh, {});
  const client = new FabricLink(clientCh, {});
  (client as unknown as { _peerServer: FabricLink })._peerServer = server; // pin the server
  return client;
}

/** Wires a fake PeerLink (via __initFabricForTest + fabricAcceptInbound — no
 *  reconcile timer needed) reporting a fixed live `mode`, plus a ping-capable
 *  FabricLink for the same peer — the same two-map shape production reaches
 *  once a link connects (mgr's PeerLink + fabricLinks' FabricLink). */
function wirePeer(peer: string, mode: 'bidi' | 'oneway' | 'relay'): void {
  __initFabricForTest({
    selfNode: 'self',
    cluster: 'default',
    listPeers: async () => [],
    makeLink: (p) => ({
      peer: p,
      core: { state: 'discovered', since: 0, attempts: 0, lastError: null },
      open: async () => {},
      adopt: () => {},
      close: () => {},
      markPeerOffline: () => {},
      snapshot: () => ({
        peer: p, state: 'connected', mode, via: mode === 'relay' ? null : 'host', rttMs: 2,
        pathInUse: mode === 'relay' ? 'relay-floor' : 'direct', since: 0, lastError: null,
        attempts: 0, counters: { helloOk: 1, helloTimeouts: 0, inboundAdopted: 0 },
      }),
    }),
  });
  fabricAcceptInbound({ peerGatewayId: peer, onClose: () => {} });
  __setFabricLinkForTest(peer, pingPair(peer));
}

test('fabricProbe reports path=relay for a live relay-mode link (was hardcoded direct pre-fix)', async () => {
  stopFabric();
  wirePeer('peer-relay', 'relay');
  const res = await fabricProbe('peer-relay');
  assert.equal(res.path, 'relay');
  assert.equal(typeof res.rttMs, 'number');
  stopFabric();
});

test('fabricProbe reports path=direct for a live bidi-mode link', async () => {
  stopFabric();
  wirePeer('peer-bidi', 'bidi');
  const res = await fabricProbe('peer-bidi');
  assert.equal(res.path, 'direct');
  stopFabric();
});

test('fabricProbe reports path=direct for a live oneway-mode link', async () => {
  stopFabric();
  wirePeer('peer-oneway', 'oneway');
  const res = await fabricProbe('peer-oneway');
  assert.equal(res.path, 'direct');
  stopFabric();
});

test('fabricProbe reports path=none and null rtt/mbps for a node with no fabric link', async () => {
  stopFabric();
  const res = await fabricProbe('ghost-node');
  assert.deepEqual(res, { node: 'ghost-node', rttMs: null, mbps: null, path: 'none' });
});
