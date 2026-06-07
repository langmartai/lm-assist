/**
 * UDP hole-punch path for the transport driver (direct mode).
 *
 * Flow (initiator and peer are symmetric except who sends transport_open):
 *   1. Open ONE dgram udp4 socket. The SAME socket is used for STUN and data so
 *      the NAT mapping the hub observes is the one the peer will hit.
 *   2. STUN: send a small packet to hub:8087, read back {type:'stun',ip,port} —
 *      our public ip:port (NAT mapping).
 *   3. Initiator emits `transport_open {channelId, peerGatewayId}` to the hub;
 *      the hub relays it to the peer as `transport_offer`. The peer STUNs, then
 *      replies `transport_answer {channelId, udp:{ip,port}}` back. The initiator
 *      learns the peer endpoint from transport_answer; the peer learns the
 *      initiator endpoint from transport_offer.udp.
 *   4. Both sides blast small punch packets at the peer's public ip:port every
 *      ~50ms for up to ~2s until a PING round-trips, opening the NAT hole.
 *   5. Hand the socket to ReliableConnection, which then runs DATA/ACK/PING/FIN
 *      over it (reliable, ordered).
 *
 * If no round-trip happens within the budget, the caller (index.ts) tears this
 * down and falls back to relay.
 */

import * as dgram from 'dgram';
import { ReliableConnection } from './reliable';
import type { TransportWsSender, UdpEndpoint } from './ws-deps';

/** A few raw byte tags used ONLY during the punch handshake (before reliable). */
const STUN_REQUEST = Buffer.from('LMSTUN'); // tiny probe to the hub STUN responder
const PUNCH_PROBE = Buffer.from('LMPUNCH'); // hole-punch keepalive blast at the peer
const PUNCH_ACK = Buffer.from('LMPUNCHA'); // reply confirming the hole is open

export interface HolePunchOptions {
  channelId: string;
  peerGatewayId: string;
  /** True if THIS node sent transport_open (initiator); false if it answers. */
  initiator: boolean;
  ws: TransportWsSender;
  /** Hub host for STUN (the gateway's host); port is stunPort. */
  stunHost: string;
  stunPort?: number;       // default 8087
  punchIntervalMs?: number; // default 50
  punchTimeoutMs?: number;  // default 2000
  /** Peer endpoint already known from transport_offer (answerer side). */
  knownPeer?: UdpEndpoint;
}

export interface PunchedSocket {
  /** Reliable layer riding the punched socket; null until punch succeeds. */
  reliable: ReliableConnection;
  /** Tear down the socket + reliable layer. */
  close(reason?: string): void;
}

/**
 * Resolve our own public UDP endpoint via the hub STUN responder, reusing the
 * supplied socket. Resolves null on timeout.
 */
function stun(socket: dgram.Socket, host: string, port: number, timeoutMs: number): Promise<UdpEndpoint | null> {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (msg: Buffer) => {
      try {
        const obj = JSON.parse(msg.toString('utf-8')) as { type?: string; ip?: string; port?: number };
        if (obj.type === 'stun' && obj.ip && typeof obj.port === 'number') {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.removeListener('message', onMsg);
          resolve({ ip: obj.ip, port: obj.port });
        }
      } catch {
        /* not a STUN reply; ignore (could be an early punch packet) */
      }
    };
    socket.on('message', onMsg);
    // Retry the probe a few times in case the first is lost.
    const sendProbe = () => {
      try { socket.send(STUN_REQUEST, port, host); } catch { /* ignore */ }
    };
    sendProbe();
    const retry = setInterval(sendProbe, 200);
    if (retry.unref) retry.unref();
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      clearInterval(retry);
      socket.removeListener('message', onMsg);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    // Stop retrying once resolved.
    const origResolve = resolve;
    resolve = ((v: UdpEndpoint | null) => { clearInterval(retry); origResolve(v); }) as typeof resolve;
  });
}

/**
 * Attempt a direct UDP channel. Resolves with a PunchedSocket whose
 * `reliable` layer is live once a PING has round-tripped, or rejects on timeout.
 *
 * onData / onClose are wired into the returned reliable layer by the caller.
 */
export function holePunch(
  opts: HolePunchOptions,
  onDeliver: (data: Buffer) => void,
  onClose: (reason?: string) => void,
): Promise<PunchedSocket> {
  const stunPort = opts.stunPort ?? 8087;
  const punchIntervalMs = opts.punchIntervalMs ?? 50;
  const punchTimeoutMs = opts.punchTimeoutMs ?? 2000;

  return new Promise<PunchedSocket>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let peer: UdpEndpoint | null = opts.knownPeer ?? null;
    let punchTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let reliable: ReliableConnection | null = null;
    let settled = false;
    let tornDown = false;

    const teardown = (reason?: string) => {
      if (tornDown) return;
      tornDown = true;
      if (punchTimer) clearInterval(punchTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (offerListener) opts.ws.off('transport_answer', offerListener as (...a: unknown[]) => void);
      try { socket.close(); } catch { /* ignore */ }
      if (reliable && !reliable.isClosed()) reliable.close(reason);
    };

    const fail = (err: Error) => {
      if (settled) { teardown(err.message); return; }
      settled = true;
      teardown(err.message);
      reject(err);
    };

    // Bring up the reliable layer over the punched socket and resolve.
    const goReliable = () => {
      if (settled || tornDown || !peer) return;
      settled = true;
      const target = peer;
      reliable = new ReliableConnection({
        sendDatagram: (buf: Buffer) => {
          try { socket.send(buf, target.port, target.ip); } catch { /* tolerated */ }
        },
        onDeliver,
        onClose: (r) => {
          onClose(r);
          teardown(r);
        },
      });
      if (punchTimer) { clearInterval(punchTimer); punchTimer = null; }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      resolve({
        reliable,
        close: (r?: string) => teardown(r),
      });
    };

    socket.on('error', (err) => fail(err));

    socket.on('message', (msg, rinfo) => {
      // During the punch phase, classify raw tag packets. Once reliable is up,
      // every non-tag datagram is fed to it.
      if (!settled) {
        if (msg.length === PUNCH_PROBE.length && msg.equals(PUNCH_PROBE)) {
          // Peer reached us — learn its endpoint, ack, and go reliable.
          peer = { ip: rinfo.address, port: rinfo.port };
          try { socket.send(PUNCH_ACK, rinfo.port, rinfo.address); } catch { /* ignore */ }
          goReliable();
          return;
        }
        if (msg.length === PUNCH_ACK.length && msg.equals(PUNCH_ACK)) {
          // Our probe reached the peer and it acked — hole is open.
          peer = { ip: rinfo.address, port: rinfo.port };
          goReliable();
          return;
        }
        // STUN reply is consumed by the stun() listener; anything else is noise.
        return;
      }
      // Reliable phase: track the peer's CURRENT source endpoint so our acks/
      // data follow it. A NAT can remap the peer's external port mid-session
      // (symmetric NAT / rebinding — observed on a home NAT moving 52061->1359);
      // without this we keep sending to the stale endpoint and the reverse path
      // silently dies (acks/FT_OK never arrive -> idle timeout). Last-received-
      // source roaming, same approach WireGuard uses.
      if (peer && (peer.ip !== rinfo.address || peer.port !== rinfo.port)) {
        peer = { ip: rinfo.address, port: rinfo.port };
      }
      if (reliable) reliable.onDatagram(msg);
    });

    // Begin blasting punch probes at the peer until one round-trips.
    const startPunching = () => {
      if (!peer || tornDown) return;
      const blast = () => {
        if (!peer || tornDown || settled) return;
        try { socket.send(PUNCH_PROBE, peer.port, peer.ip); } catch { /* ignore */ }
      };
      blast();
      punchTimer = setInterval(blast, punchIntervalMs);
      if (punchTimer.unref) punchTimer.unref();
    };

    // If the peer endpoint arrives later (initiator waits for transport_answer).
    let offerListener: ((msg: { channelId: string; udp: UdpEndpoint }) => void) | null = null;

    const begin = async () => {
      // Fixed-port mode: bind a known public UDP port and advertise it directly
      // (no STUN), so a NAT'd peer can reach this side at <publicIp>:<port>.
      // Enables a DIRECT channel when this side has an open, reachable port
      // (e.g. a cloud host with the security-list/firewall opened). 0 = ephemeral.
      const fixedPort = Number(process.env.LM_ASSIST_TRANSPORT_PORT) || 0;
      const publicIp = process.env.LM_ASSIST_PUBLIC_IP;
      socket.bind(fixedPort);
      await new Promise<void>((r) => socket.once('listening', () => r()));

      // STUN to learn our own public endpoint (for the offer/answer we emit),
      // unless a fixed public endpoint is configured (then advertise it directly).
      const mine = fixedPort && publicIp
        ? { ip: publicIp, port: fixedPort }
        : await stun(socket, opts.stunHost, stunPort, 1500);
      if (tornDown) return;
      // STUN failure is non-fatal if we already know the peer (answerer with
      // knownPeer can still try to punch), but the peer won't learn our mapping.
      // Emit our coordination message carrying our mapping (best-effort).
      if (opts.initiator) {
        opts.ws.send({
          type: 'transport_open',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
          udp: mine || undefined,
        });
        // Wait for the peer's transport_answer to learn its endpoint.
        offerListener = (m) => {
          if (m.channelId !== opts.channelId) return;
          peer = m.udp;
          startPunching();
        };
        opts.ws.on('transport_answer', offerListener as (...a: unknown[]) => void);
      } else {
        // Answerer: reply with our mapping so the initiator can punch toward us.
        opts.ws.send({
          type: 'transport_answer',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
          udp: mine || undefined,
        });
        // We already know the peer endpoint from transport_offer.udp.
        startPunching();
      }
    };

    // Overall deadline for the direct attempt.
    deadlineTimer = setTimeout(() => {
      if (!settled) fail(new Error('hole punch timeout'));
    }, punchTimeoutMs + 1500); // STUN budget + punch budget
    deadlineTimer.unref?.();

    begin().catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}
