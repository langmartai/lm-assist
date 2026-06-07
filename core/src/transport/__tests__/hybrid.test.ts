/**
 * Unit test: the HYBRID transport channel over an in-process hub (fake WS pair)
 * + real udp4 sockets. To simulate an asymmetric NAT we corrupt the udp
 * endpoint ONE peer advertises so the other peer's direct packets land on a
 * black-hole port — closing exactly one direct direction while the reverse
 * direct path stays open.
 *
 * Asserts:
 *   - Both directions direct: data flows reliably both ways, a multi-KB payload
 *     is byte-identical, and Channel.mode reaches 'direct' on both ends.
 *   - Asymmetric NAT (one direct direction dropped): data STILL flows reliably
 *     both ways (direct one way, relay the other), a multi-KB payload arrives
 *     intact, and Channel.mode === 'hybrid' on both ends.
 *
 * Run (compiled): node --test dist-test/transport/__tests__/hybrid.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { openHybridChannel } from '../hybrid';
import type { TransportWsSender, UdpEndpoint } from '../ws-deps';

const RELAY_MARKER = 0xfd;
type Udp = UdpEndpoint | undefined;

/** In-process hub linking two FakeWs endpoints. `rewriteOutgoingUdp` lets a
 *  test corrupt the udp endpoint a peer advertises (models a NAT that maps the
 *  peer to an unreachable external port for one direction). */
function makeHubPair(idA: string, idB: string) {
  const a = new FakeWs(idA);
  const b = new FakeWs(idB);
  a.peer = b; b.peer = a;
  return { a, b };
}

class FakeWs extends EventEmitter implements TransportWsSender {
  peer: FakeWs | null = null;
  connected = true;
  rewriteOutgoingUdp: ((u: Udp) => Udp) | null = null;
  constructor(public gatewayId: string) { super(); this.setMaxListeners(0); }

  isConnected(): boolean { return this.connected; }
  bufferedAmount(): number { return 0; }

  send(obj: unknown): void {
    const msg = obj as Record<string, unknown>;
    const peer = this.peer;
    if (!peer) return;
    const type = msg.type as string;
    const rw = (u: Udp): Udp => (this.rewriteOutgoingUdp ? this.rewriteOutgoingUdp(u) : u);
    setImmediate(() => {
      if (!peer.connected) return;
      switch (type) {
        case 'transport_open':
          peer.emit('transport_offer', { channelId: msg.channelId, fromGatewayId: this.gatewayId, udp: rw(msg.udp as Udp) });
          break;
        case 'transport_answer':
          peer.emit('transport_answer', { channelId: msg.channelId, udp: rw(msg.udp as Udp) });
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
 * Models B's asymmetric NAT as a udp proxy that sits on BOTH of B's paths:
 *   - B sends its OUTBOUND direct to the proxy (B's knownPeer = proxy). The
 *     proxy forwards to A FROM the proxy address, so A only ever sees the proxy
 *     as B's source (roaming can't reveal B's real port → can't bypass the NAT).
 *   - A sends its direct to the proxy (advertised as B's endpoint). The proxy
 *     would forward to B but DROPS it (asymmetric inbound closed).
 * Net: B→A direct works (via the proxy), A→B direct is black-holed.
 * The proxy distinguishes the two flows by source port: packets from B's real
 * socket are B→A; everything else is A→B (dropped).
 */
async function startNat() {
  const sock = dgram.createSocket('udp4');
  let bReal: { port: number; host: string } | null = null; // B's real socket
  let aReal: { port: number; host: string } | null = null; // A's real endpoint
  sock.on('message', (msg, rinfo) => {
    if (bReal && rinfo.address === bReal.host && rinfo.port === bReal.port) {
      // B→A: forward to A from the proxy address.
      if (aReal) { try { sock.send(msg, aReal.port, aReal.host); } catch { /* ignore */ } }
      return;
    }
    // A→B (inbound to B): DROPPED — asymmetric NAT.
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

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

test('hybrid: both directions direct — data flows both ways, mode reaches direct', async () => {
  const stun = await startStun();
  const { a: wsA, b: wsB } = makeHubPair('gw-A', 'gw-B');
  const recvA: Buffer[] = [];
  const recvB: Buffer[] = [];
  const channelId = crypto.randomUUID();

  // Mirror real ordering: the initiator (A) opens first; the answerer (B) is
  // constructed in RESPONSE to the inbound open (so B's relay_ready / answer
  // land after A is already listening). Here we wait for B's ws to receive the
  // initiator's signals, then build B — exactly what index.ts answerHybrid does.
  let bGotOpen = false;
  let aOfferUdp: UdpEndpoint | undefined;
  wsB.on('transport_relay_open', (() => { bGotOpen = true; }) as (...a: unknown[]) => void);
  wsB.on('transport_offer', ((m: { channelId: string; udp?: UdpEndpoint }) => {
    if (m.channelId === channelId && m.udp) aOfferUdp = m.udp;
  }) as (...a: unknown[]) => void);

  const chAP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-B', initiator: true, ws: wsA, stunHost: '127.0.0.1', stunPort: stun.port },
    (d) => recvA.push(Buffer.from(d)), () => {},
  );
  await waitFor(() => bGotOpen && aOfferUdp !== undefined, 4000);
  const chBP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-A', initiator: false, ws: wsB, stunHost: '127.0.0.1', stunPort: stun.port, knownPeer: aOfferUdp },
    (d) => recvB.push(Buffer.from(d)), () => {},
  );
  const chA = await chAP;
  const chB = await chBP;

  const direct = await waitFor(() => chA.mode() === 'direct' && chB.mode() === 'direct', 8000);
  assert.ok(direct, `expected both ends mode 'direct', got A=${chA.mode()} B=${chB.mode()}`);

  const payAtoB = crypto.randomBytes(40 * 1024);
  const payBtoA = crypto.randomBytes(40 * 1024);
  chA.reliable.send(payAtoB);
  chB.reliable.send(payBtoA);

  const okB = await waitFor(() => Buffer.concat(recvB).length >= payAtoB.length, 15000);
  const okA = await waitFor(() => Buffer.concat(recvA).length >= payBtoA.length, 15000);
  assert.ok(okB && okA, 'both multi-KB payloads must arrive');
  assert.ok(Buffer.concat(recvB).equals(payAtoB), 'A→B payload byte-identical');
  assert.ok(Buffer.concat(recvA).equals(payBtoA), 'B→A payload byte-identical');

  chA.close(); chB.close(); stun.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('hybrid: asymmetric NAT (one direct direction dropped) — data still flows both ways, mode is hybrid', async () => {
  const stun = await startStun();
  const { a: wsA, b: wsB } = makeHubPair('gw-A', 'gw-B');
  const recvA: Buffer[] = [];
  const recvB: Buffer[] = [];
  const channelId = crypto.randomUUID();

  // Asymmetric NAT: B's NAT (the proxy) forwards B→A but drops A→B. A's view of
  // B (advertised endpoint) is the proxy; B's view of A (knownPeer) is the proxy
  // too, so B's outbound traverses the proxy and appears to come FROM the proxy
  // (roaming can't reveal B's real port). Expected outcome:
  //   - B→A direct confirms (B→proxy→A; A acks via relay DPROBE_ACK →
  //     B.myDirectOut=true; B sends direct → A receives direct from the proxy).
  //   - A→B direct never confirms (A→proxy dropped; no DPROBE_ACK →
  //     A.myDirectOut stays false → A sends over relay → B receives relay).
  //   - A: recv direct + send relay → 'hybrid'.  B: recv relay + send direct → 'hybrid'.
  const nat = await startNat();

  // Capture A's + B's real udp endpoints at the hub (the un-rewritten values),
  // then configure the NAT and rewrite each side's view of the other → the proxy.
  let aRealUdp: UdpEndpoint | undefined; // A's real (from transport_open)
  let bRealUdp: UdpEndpoint | undefined; // B's real (from transport_answer)
  wsB.on('transport_offer', ((m: { channelId: string; udp?: UdpEndpoint }) => {
    if (m.channelId === channelId && m.udp) { aRealUdp = m.udp; nat.setAReal(m.udp.port, m.udp.ip); }
  }) as (...a: unknown[]) => void);
  // A advertises B's endpoint as the proxy (A → proxy, dropped inbound).
  wsB.rewriteOutgoingUdp = (u: Udp): Udp => {
    if (u) { bRealUdp = u; nat.setBReal(u.port, u.ip); }
    return u ? { ip: '127.0.0.1', port: nat.port } : u;
  };

  // A initiates first so its transport_open (carrying A's real udp) is captured
  // before we build B.
  const chAP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-B', initiator: true, ws: wsA, stunHost: '127.0.0.1', stunPort: stun.port },
    (d) => recvA.push(Buffer.from(d)), () => {},
  );
  await waitFor(() => aRealUdp !== undefined, 4000);
  // B's knownPeer = the proxy, so B's outbound direct traverses the NAT and
  // appears to come from the proxy (exactly what a real NAT does to B's egress).
  const chBP = openHybridChannel(
    { channelId, peerGatewayId: 'gw-A', initiator: false, ws: wsB, stunHost: '127.0.0.1', stunPort: stun.port, knownPeer: { ip: '127.0.0.1', port: nat.port } },
    (d) => recvB.push(Buffer.from(d)), () => {},
  );
  const chA = await chAP;
  const chB = await chBP;
  void bRealUdp;

  const hybridReached = await waitFor(
    () => chA.mode() === 'hybrid' && chB.mode() === 'hybrid', 12000,
  );
  assert.ok(hybridReached, `expected both ends mode 'hybrid', got A=${chA.mode()} B=${chB.mode()}`);

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
