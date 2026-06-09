/**
 * Unit tests: the HYBRID transport channel (ICE-style escalation ladder) over an
 * in-process hub (fake WS pair) + real udp4 sockets.
 *
 * The hub forwards the `udp` candidate ADVERT verbatim ({ip, port, cands}). To
 * model NATs a test can rewrite the advert a peer sends (rewriteOutgoingUdp) so
 * the other peer only ever sees a proxy endpoint — closing the real direct path.
 *
 * Covered:
 *   - Both directions direct → channel promotes to mode 'bidi', payload intact
 *     both ways, and the relay carries NO data datagrams after promotion (we
 *     count relay 0x00 frames and assert they stop post-promotion).
 *   - Asymmetric NAT (one direct direction dropped) → mode 'oneway', data still
 *     flows both ways (direct one way, relay the other), payload intact.
 *   - Demotion: start bidi, then make one udp direction start dropping → demotes
 *     to 'oneway'/'relay' and a payload sent during/after the break still arrives
 *     intact (retransmit over the warm relay).
 *
 * Run (compiled): node --test dist-test/transport/__tests__/hybrid.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { openHybridChannel } from '../hybrid';
import type { UdpEndpoint } from '../ws-deps';
import type { UdpAdvert } from '../candidates';

const RELAY_MARKER = 0xfd;
const RELAY_TAG_DATAGRAM = 0x00;
type Advert = UdpAdvert | undefined;

/** In-process hub linking two FakeWs endpoints. `rewriteOutgoingUdp` lets a test
 *  rewrite the candidate advert a peer advertises (models a NAT mapping the peer
 *  to an unreachable/proxy external endpoint). */
function makeHubPair(idA: string, idB: string) {
  const a = new FakeWs(idA);
  const b = new FakeWs(idB);
  a.peer = b; b.peer = a;
  return { a, b };
}

class FakeWs extends EventEmitter {
  peer: FakeWs | null = null;
  connected = true;
  rewriteOutgoingUdp: ((u: Advert) => Advert) | null = null;
  /** Count of relay reliable-datagram frames (0xFD payload tag 0x00) sent. */
  dataFrames = 0;
  constructor(public gatewayId: string) { super(); this.setMaxListeners(0); }

  isConnected(): boolean { return this.connected; }
  bufferedAmount(): number { return 0; }

  send(obj: unknown): void {
    const msg = obj as Record<string, unknown>;
    const peer = this.peer;
    if (!peer) return;
    const type = msg.type as string;
    const rw = (u: Advert): Advert => (this.rewriteOutgoingUdp ? this.rewriteOutgoingUdp(u) : u);
    setImmediate(() => {
      if (!peer.connected) return;
      switch (type) {
        case 'transport_open':
          peer.emit('transport_offer', { channelId: msg.channelId, fromGatewayId: this.gatewayId, udp: rw(msg.udp as Advert) });
          break;
        case 'transport_answer':
          peer.emit('transport_answer', { channelId: msg.channelId, udp: rw(msg.udp as Advert) });
          break;
        case 'transport_relay_open':
          peer.emit('transport_relay_open', { channelId: msg.channelId, fromGatewayId: this.gatewayId });
          break;
        case 'transport_relay_ready':
          peer.emit('transport_relay_ready', { channelId: msg.channelId });
          break;
        case 'transport_close':
          peer.emit('transport_close', { channelId: msg.channelId, reason: msg.reason });
          break;
        default: break;
      }
    });
  }

  sendBinary(idHash: Buffer, payload: Buffer, marker = 0xff): void {
    if (marker !== RELAY_MARKER) return;
    if (payload.length >= 1 && payload.readUInt8(0) === RELAY_TAG_DATAGRAM) this.dataFrames += 1;
    const peer = this.peer;
    if (!peer) return;
    const hashCopy = Buffer.from(idHash);
    const payCopy = Buffer.from(payload);
    setImmediate(() => { if (peer.connected) peer.emit('transport_relay_data', { channelHash: hashCopy, payload: payCopy }); });
  }
}

/** Honest STUN responder: replies {type:'stun',ip,port} with the sender's src. */
async function startStun(): Promise<{ port: number; close(): void }> {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf-8') === 'LMSTUN') {
      const reply = Buffer.from(JSON.stringify({ type: 'stun', ip: rinfo.address, port: rinfo.port }));
      try { sock.send(reply, rinfo.port, rinfo.address); } catch { /* ignore */ }
    }
  });
  sock.bind(0, '127.0.0.1');
  await new Promise<void>((r) => sock.once('listening', () => r()));
  return { port: sock.address().port, close: () => { try { sock.close(); } catch { /* ignore */ } } };
}

/**
 * Asymmetric NAT proxy (sits on BOTH of B's paths):
 *   - B sends its OUTBOUND direct to the proxy; the proxy forwards to A FROM the
 *     proxy address, so A only ever sees the proxy as B's source.
 *   - A sends its direct to the proxy (advertised as B's only endpoint); the
 *     proxy DROPS it (asymmetric inbound closed).
 * Net: B→A direct works (via the proxy), A→B direct is black-holed.
 */
async function startNat() {
  const sock = dgram.createSocket('udp4');
  let bReal: { port: number; host: string } | null = null;
  let aReal: { port: number; host: string } | null = null;
  sock.on('message', (msg, rinfo) => {
    if (bReal && rinfo.address === bReal.host && rinfo.port === bReal.port) {
      if (aReal) { try { sock.send(msg, aReal.port, aReal.host); } catch { /* ignore */ } }
      return;
    }
    // A→B: DROPPED.
  });
  sock.bind(0, '127.0.0.1');
  await new Promise<void>((r) => sock.once('listening', () => r()));
  return {
    port: sock.address().port,
    setBReal: (port: number, host = '127.0.0.1') => { bReal = { port, host }; },
    setAReal: (port: number, host = '127.0.0.1') => { aReal = { port, host }; },
    close: () => { try { sock.close(); } catch { /* ignore */ } },
  };
}

/**
 * Bidirectional udp proxy with a runtime "break" toggle for the demotion test.
 * Both peers send their direct traffic to the proxy; the proxy relays each side
 * to the other FROM the proxy address (so both peers roam to the proxy and the
 * only reachable peer endpoint is the proxy). Flipping `dropAtoB` makes the
 * proxy silently drop A→B packets, breaking exactly one direct direction while
 * leaving B→A direct alive.
 */
async function startTogglableProxy() {
  const sock = dgram.createSocket('udp4');
  let aReal: { port: number; host: string } | null = null;
  let bReal: { port: number; host: string } | null = null;
  const state = { dropAtoB: false, dropBtoA: false };
  sock.on('message', (msg, rinfo) => {
    const fromA = aReal && rinfo.address === aReal.host && rinfo.port === aReal.port;
    const fromB = bReal && rinfo.address === bReal.host && rinfo.port === bReal.port;
    if (fromA) {
      if (state.dropAtoB) return;
      if (bReal) { try { sock.send(msg, bReal.port, bReal.host); } catch { /* ignore */ } }
    } else if (fromB) {
      if (state.dropBtoA) return;
      if (aReal) { try { sock.send(msg, aReal.port, aReal.host); } catch { /* ignore */ } }
    }
  });
  sock.bind(0, '127.0.0.1');
  await new Promise<void>((r) => sock.once('listening', () => r()));
  return {
    port: sock.address().port,
    state,
    setAReal: (port: number, host = '127.0.0.1') => { aReal = { port, host }; },
    setBReal: (port: number, host = '127.0.0.1') => { bReal = { port, host }; },
    close: () => { try { sock.close(); } catch { /* ignore */ } },
  };
}

/** The loopback source a peer presents when it sends to a 127.0.0.1 proxy: its
 *  bound local port = the srflx candidate's port (STUN over loopback reflects
 *  127.0.0.1:<localPort>). Falls back to the advert's primary port. */
function loopbackSource(u: UdpAdvert): UdpEndpoint {
  const srflx = (u.cands ?? []).find((c) => c.kind === 'srflx');
  const port = srflx ? srflx.port : u.port;
  return { ip: '127.0.0.1', port };
}

/** Replace an advert's whole candidate list with a single proxy srflx candidate
 *  (the ONLY way the other peer can reach this one). Captures the advertiser's
 *  REAL loopback socket source via `onReal` so the proxy can forward back to it. */
function proxyAdvert(proxyPort: number, onReal?: (ep: UdpEndpoint) => void) {
  return (u: Advert): Advert => {
    if (!u) return u;
    if (onReal) onReal(loopbackSource(u));
    return { ip: '127.0.0.1', port: proxyPort, cands: [{ ip: '127.0.0.1', port: proxyPort, kind: 'srflx' }] };
  };
}

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

test('hybrid: both directions direct — promotes to bidi, payloads intact, relay goes quiet', async () => {
  const stun = await startStun();
  const { a: wsA, b: wsB } = makeHubPair('gw-A', 'gw-B');
  const recvA: Buffer[] = [];
  const recvB: Buffer[] = [];
  const channelId = crypto.randomUUID();

  // Mirror real ordering: A (initiator) opens first; B is constructed in
  // response to the inbound open (so B's relay_ready / answer land after A is
  // listening) — exactly what index.ts answerHybrid does.
  let bGotOpen = false;
  let aOffer: Advert;
  wsB.on('transport_relay_open', (() => { bGotOpen = true; }) as (...a: unknown[]) => void);
  wsB.on('transport_offer', ((m: { channelId: string; udp?: Advert }) => {
    if (m.channelId === channelId && m.udp) aOffer = m.udp;
  }) as (...a: unknown[]) => void);

  const chAP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-B', initiator: true, ws: wsA, stunHost: '127.0.0.1', stunPort: stun.port },
    (d) => recvA.push(Buffer.from(d)), () => {},
  );
  await waitFor(() => bGotOpen && aOffer !== undefined, 4000);
  const chBP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-A', initiator: false, ws: wsB, stunHost: '127.0.0.1', stunPort: stun.port, knownPeer: aOffer },
    (d) => recvB.push(Buffer.from(d)), () => {},
  );
  const chA = await chAP;
  const chB = await chBP;

  // Conservative promotion needs a sustained window across >=2 sweep cycles.
  const bidi = await waitFor(() => chA.mode() === 'bidi' && chB.mode() === 'bidi', 12000);
  assert.ok(bidi, `expected both ends mode 'bidi', got A=${chA.mode()} B=${chB.mode()}`);
  // via() must be non-null in bidi (a confirmed outbound candidate kind).
  assert.ok(chA.via() !== null && chB.via() !== null, `via must be set in bidi, A=${chA.via()} B=${chB.via()}`);

  // Snapshot relay data-frame counts AFTER promotion; the bulk payload that
  // follows must ride direct only (these counters must not climb).
  const aFramesAtPromote = wsA.dataFrames;
  const bFramesAtPromote = wsB.dataFrames;

  const payAtoB = crypto.randomBytes(40 * 1024);
  const payBtoA = crypto.randomBytes(40 * 1024);
  chA.reliable.send(payAtoB);
  chB.reliable.send(payBtoA);

  const okB = await waitFor(() => Buffer.concat(recvB).length >= payAtoB.length, 15000);
  const okA = await waitFor(() => Buffer.concat(recvA).length >= payBtoA.length, 15000);
  assert.ok(okB && okA, 'both multi-KB payloads must arrive');
  assert.ok(Buffer.concat(recvB).equals(payAtoB), 'A→B payload byte-identical');
  assert.ok(Buffer.concat(recvA).equals(payBtoA), 'B→A payload byte-identical');

  // Still bidi, and the relay carried (essentially) no data datagrams during the
  // bulk transfer — allow a tiny slack for any control already in flight at the
  // exact moment of the snapshot. The 40KB payload alone would be ~34 relay data
  // frames per direction if it had gone over relay; assert it did NOT.
  assert.equal(chA.mode(), 'bidi', 'A stays bidi through the bulk transfer');
  assert.equal(chB.mode(), 'bidi', 'B stays bidi through the bulk transfer');
  assert.ok(wsA.dataFrames - aFramesAtPromote <= 2, `A relay data frames must stay ~0 post-promotion (got ${wsA.dataFrames - aFramesAtPromote})`);
  assert.ok(wsB.dataFrames - bFramesAtPromote <= 2, `B relay data frames must stay ~0 post-promotion (got ${wsB.dataFrames - bFramesAtPromote})`);

  chA.close(); chB.close(); stun.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('hybrid: asymmetric NAT (one direct direction dropped) — mode oneway, data still flows both ways', async () => {
  const stun = await startStun();
  const { a: wsA, b: wsB } = makeHubPair('gw-A', 'gw-B');
  const recvA: Buffer[] = [];
  const recvB: Buffer[] = [];
  const channelId = crypto.randomUUID();
  const nat = await startNat();

  // A advertises B's endpoint as the proxy (A → proxy, dropped inbound). We
  // replace B's WHOLE candidate list with the proxy srflx so A cannot reach B's
  // real host candidate and bypass the NAT.
  let aRealUdp: UdpEndpoint | undefined;
  wsB.on('transport_offer', ((m: { channelId: string; udp?: Advert }) => {
    if (m.channelId === channelId && m.udp) { aRealUdp = loopbackSource(m.udp); nat.setAReal(aRealUdp.port, aRealUdp.ip); }
  }) as (...a: unknown[]) => void);
  wsB.rewriteOutgoingUdp = proxyAdvert(nat.port, (ep) => nat.setBReal(ep.port, ep.ip));

  const chAP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-B', initiator: true, ws: wsA, stunHost: '127.0.0.1', stunPort: stun.port },
    (d) => recvA.push(Buffer.from(d)), () => {},
  );
  await waitFor(() => aRealUdp !== undefined, 4000);
  // B's knownPeer = the proxy, so B's outbound direct traverses the NAT and
  // appears to come from the proxy (exactly what a real NAT does to B's egress).
  const chBP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-A', initiator: false, ws: wsB, stunHost: '127.0.0.1', stunPort: stun.port, knownPeer: { ip: '127.0.0.1', port: nat.port, cands: [{ ip: '127.0.0.1', port: nat.port, kind: 'srflx' }] } },
    (d) => recvB.push(Buffer.from(d)), () => {},
  );
  const chA = await chAP;
  const chB = await chBP;

  const oneway = await waitFor(
    () => chA.mode() === 'oneway' && chB.mode() === 'oneway', 14000,
  );
  assert.ok(oneway, `expected both ends mode 'oneway', got A=${chA.mode()} B=${chB.mode()}`);

  const payAtoB = crypto.randomBytes(32 * 1024);
  const payBtoA = crypto.randomBytes(32 * 1024);
  chA.reliable.send(payAtoB);
  chB.reliable.send(payBtoA);

  const okB = await waitFor(() => Buffer.concat(recvB).length >= payAtoB.length, 20000);
  const okA = await waitFor(() => Buffer.concat(recvA).length >= payBtoA.length, 20000);
  assert.ok(okB, `A→B payload must arrive (over relay); got ${Buffer.concat(recvB).length}/${payAtoB.length}`);
  assert.ok(okA, `B→A payload must arrive (over direct); got ${Buffer.concat(recvA).length}/${payBtoA.length}`);
  assert.ok(Buffer.concat(recvB).equals(payAtoB), 'A→B payload byte-identical');
  assert.ok(Buffer.concat(recvA).equals(payBtoA), 'B→A payload byte-identical');

  chA.close(); chB.close(); nat.close(); stun.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('hybrid: demotion — bidi then one direction breaks → demotes, in-flight payload still arrives via relay', async () => {
  const stun = await startStun();
  const { a: wsA, b: wsB } = makeHubPair('gw-A', 'gw-B');
  const recvA: Buffer[] = [];
  const recvB: Buffer[] = [];
  const channelId = crypto.randomUUID();
  const proxy = await startTogglableProxy();

  // Route BOTH peers' direct traffic through the togglable proxy: each side's
  // advertised candidates are replaced with the proxy, and each side's knownPeer
  // is the proxy. Both directions work initially → bidi. We capture each peer's
  // real socket source the first time it reaches the proxy so the proxy can
  // forward back to it.
  let aRegistered = false;
  wsB.on('transport_offer', ((m: { channelId: string; udp?: Advert }) => {
    if (m.channelId === channelId && m.udp) { const a = loopbackSource(m.udp); proxy.setAReal(a.port, a.ip); aRegistered = true; }
  }) as (...a: unknown[]) => void);
  wsB.rewriteOutgoingUdp = proxyAdvert(proxy.port, (ep) => proxy.setBReal(ep.port, ep.ip));
  // A's view of B is the proxy (it learns B's candidates as the proxy via the
  // rewrite above). B's knownPeer is the proxy too.
  // Additionally rewrite A's outgoing advert so its primary endpoint that the
  // proxy learns matches the socket the proxy must reply to (setAReal above is
  // from the OFFER, i.e. A's real udp — correct).

  const chAP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-B', initiator: true, ws: wsA, stunHost: '127.0.0.1', stunPort: stun.port },
    (d) => recvA.push(Buffer.from(d)), () => {},
  );
  // Wait until A's real endpoint is registered with the proxy.
  await waitFor(() => aRegistered, 4000);
  const chBP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-A', initiator: false, ws: wsB, stunHost: '127.0.0.1', stunPort: stun.port, knownPeer: { ip: '127.0.0.1', port: proxy.port, cands: [{ ip: '127.0.0.1', port: proxy.port, kind: 'srflx' }] } },
    (d) => recvB.push(Buffer.from(d)), () => {},
  );
  const chA = await chAP;
  const chB = await chBP;

  const bidi = await waitFor(() => chA.mode() === 'bidi' && chB.mode() === 'bidi', 14000);
  assert.ok(bidi, `expected bidi before break, got A=${chA.mode()} B=${chB.mode()}`);

  // BREAK the A→B direct direction. B stops receiving A's direct probes/data →
  // B.weReceiveDirect goes stale; A's outbound is no longer confirmed (no fresh
  // DPROBE_ACK from B) → A.myDirectOut goes stale. Both ends must demote.
  proxy.state.dropAtoB = true;

  // Send a payload DURING/AFTER the break. reliable.ts must retransmit the lost
  // direct datagrams over the warm relay — payload must arrive intact.
  const payAtoB = crypto.randomBytes(24 * 1024);
  chA.reliable.send(payAtoB);

  const demoted = await waitFor(
    () => chA.mode() !== 'bidi' && chB.mode() !== 'bidi', 12000,
  );
  assert.ok(demoted, `expected demotion out of bidi, got A=${chA.mode()} B=${chB.mode()}`);

  const okB = await waitFor(() => Buffer.concat(recvB).length >= payAtoB.length, 20000);
  assert.ok(okB, `A→B payload sent during the break must still arrive (via relay); got ${Buffer.concat(recvB).length}/${payAtoB.length}`);
  assert.ok(Buffer.concat(recvB).equals(payAtoB), 'A→B payload byte-identical after demotion');

  chA.close(); chB.close(); proxy.close(); stun.close();
  await new Promise((r) => setTimeout(r, 50));
});
