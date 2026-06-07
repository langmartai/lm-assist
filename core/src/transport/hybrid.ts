/**
 * Hybrid transport path for the transport driver.
 *
 * Replaces the old binary "direct OR relay" choice with a channel that keeps
 * BOTH underlying transports live at once and picks, per direction, whichever
 * one is confirmed reachable. The relay is ALWAYS present as the reliable floor
 * and the control plane; the direct UDP path is layered on top opportunistically
 * and only used for OUTBOUND once the peer has confirmed it receives our direct
 * packets. On an asymmetric NAT (one direction punchable) this yields
 * one-way-direct for the heavy data plus relay for the reverse, automatically.
 *
 * Architecture:
 *   - ONE ReliableConnection per channel (reliable.ts). The single sequencing/
 *     ack/retransmit engine. Its sendDatagram routes LIVE:
 *         myDirectOut && peerUdp ? udp.send(peerUdp) : relaySend()
 *     and its onDatagram is fed from BOTH inbound sources (udp socket + relay).
 *   - TWO transports:
 *       DIRECT: a dgram udp4 socket (fixed port via LM_ASSIST_TRANSPORT_PORT, or
 *               ephemeral; advertise LM_ASSIST_PUBLIC_IP:port or STUN result —
 *               identical endpoint discovery to holepunch.ts).
 *       RELAY:  a 0xFD stream over the hub WS (transport_relay_open / _ready,
 *               same handshake as relay.ts).
 *
 * Per-direction confirmation (the crux):
 *   - We periodically blast LMPUNCH probes at the peer's advertised/last-seen
 *     udp endpoint (keepalive so the NAT mapping + confirmation stay fresh).
 *   - On receiving a direct LMPUNCH from the peer: record the peer's udp source
 *     (rinfo) for our own sends (roaming) AND send a relay control DPROBE_ACK
 *     ("your direct reaches me").
 *   - On receiving DPROBE_ACK over the relay: set myDirectOut = true — our
 *     direct packets are confirmed to reach the peer, so route OUTBOUND direct.
 *   - If no fresh direct traffic/confirm arrives for a while, fall back
 *     myDirectOut = false (robust against NAT remap / route change).
 *
 * Relay 0xFD payload wire format (1-byte tag prefix):
 *   0x00  reliable datagram follows  → onDatagram(payload.subarray(1))
 *   0x01  DPROBE_ACK control         → myDirectOut = true
 *
 * Mode reporting (Channel.mode):
 *   'direct' if BOTH legs are direct (we send direct AND the peer sends us
 *            direct, i.e. myDirectOut && weReceiveDirect),
 *   'relay'  if neither leg is direct,
 *   'hybrid' otherwise (exactly one leg direct).
 */

import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { ReliableConnection } from './reliable';
import type { TransportWsSender, UdpEndpoint } from './ws-deps';

/** Binary frame marker for transport relay data (same as relay.ts). */
export const TRANSPORT_RELAY_MARKER = 0xfd;

/** Relay 0xFD payload tags. */
const RELAY_TAG_DATAGRAM = 0x00; // [0x00][reliable datagram]
const RELAY_TAG_DPROBE_ACK = 0x01; // [0x01] — "your direct reaches me"

/** Raw byte tags used on the direct UDP socket (before/around reliable). */
const STUN_REQUEST = Buffer.from('LMSTUN'); // tiny probe to the hub STUN responder
const PUNCH_PROBE = Buffer.from('LMPUNCH'); // direct probe blasted at the peer

/** WS relay backpressure (mirrors relay.ts). */
const WS_BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024; // 8 MB
const WS_BACKPRESSURE_POLL_MS = 50;

/** Initiator: fail if the hub never replies transport_relay_ready. */
const RELAY_READY_TIMEOUT_MS = 15_000;

/** Direct probe cadence + confirmation freshness window. */
const PROBE_INTERVAL_MS = 1000;
/** If we hear no direct packet from the peer within this window, our inbound
 *  leg is considered NOT direct (mode falls back toward relay). */
const DIRECT_RECV_STALE_MS = 4000;
/** If the peer hasn't reconfirmed (DPROBE_ACK) within this window, stop routing
 *  our OUTBOUND over direct (fall back to relay for sends). */
const DIRECT_OUT_STALE_MS = 4000;
/** Datagrams at or below this size are control/handshake (reliable ACK/PING/FIN
 *  are 11B; small app-level control like the file-transfer FT_OK is tiny). They
 *  ride the relay floor UNCONDITIONALLY (plus opportunistic direct) so control
 *  delivery never depends on a flickery / one-way-only direct leg. Bulk data
 *  above this size rides direct when our outbound leg is confirmed, else relay. */
const CONTROL_DATAGRAM_MAX = 256;

function hashChannelId(channelId: string): Buffer {
  return crypto.createHash('md5').update(channelId).digest().subarray(0, 8);
}

export type HybridMode = 'direct' | 'relay' | 'hybrid';

export interface HybridOptions {
  channelId: string;
  peerGatewayId: string;
  /** True if THIS node initiates (sent transport_open / transport_relay_open). */
  initiator: boolean;
  ws: TransportWsSender;
  /** Hub host for STUN (the gateway host). */
  stunHost: string;
  stunPort?: number; // default 8087
  /** Peer udp endpoint already known from transport_offer (answerer side). */
  knownPeer?: UdpEndpoint;
  /**
   * Mode policy:
   *   'relay'  — relay only, never open the udp socket (forceMode:'relay').
   *   'direct' — best-effort direct, skip the relay floor (forceMode:'direct').
   *   undefined — full hybrid (relay floor + opportunistic direct). Default.
   */
  force?: 'direct' | 'relay';
  /** Initiator: how long to wait for the relay floor before giving up. */
  relayReadyTimeoutMs?: number;
}

export interface HybridChannel {
  reliable: ReliableConnection;
  /** Current mode based on which legs are confirmed direct. Read live. */
  mode(): HybridMode;
  close(reason?: string): void;
}

/**
 * Open a hybrid channel and resolve once it is usable.
 *
 * Usability:
 *   - force:'relay'  → resolves when the relay floor is ready.
 *   - force:'direct' → resolves once the udp socket is bound + endpoints
 *                      exchanged (best-effort; direct may not actually be
 *                      reachable — for testing).
 *   - default hybrid → resolves when the relay floor is ready (the guaranteed
 *                      bidirectional path); direct upgrades asynchronously.
 *
 * onDeliver / onClose are wired into the returned reliable layer.
 */
export function openHybridChannel(
  opts: HybridOptions,
  onDeliver: (data: Buffer) => void,
  onClose: (reason?: string) => void,
): Promise<HybridChannel> {
  const stunPort = opts.stunPort ?? 8087;
  const wantRelay = opts.force !== 'direct';
  const wantDirect = opts.force !== 'relay';
  const hash = hashChannelId(opts.channelId);
  const hashHex = hash.toString('hex');

  return new Promise<HybridChannel>((resolve, reject) => {
    let settled = false;
    let tornDown = false;

    // --- direct (udp) state ---
    let socket: dgram.Socket | null = null;
    let peerUdp: UdpEndpoint | null = opts.knownPeer ?? null;
    let myDirectOut = false; // peer confirmed it receives OUR direct packets
    let lastDirectRecvAt = 0; // last time we got ANY direct packet from peer
    let lastDirectOutConfirmAt = 0; // last DPROBE_ACK from peer
    let probeTimer: NodeJS.Timeout | null = null;
    let staleTimer: NodeJS.Timeout | null = null;

    // --- relay state ---
    let relayReady = false;
    let answerListener: ((m: { channelId: string; udp?: UdpEndpoint }) => void) | null = null;

    // --- reliable ---
    let reliable: ReliableConnection | null = null;

    // --- relay send (0xFD with 1-byte tag) ---
    const sendRelayFrame = (payload: Buffer): void => {
      if (tornDown || !opts.ws.isConnected()) return;
      if (opts.ws.bufferedAmount() > WS_BACKPRESSURE_HIGH_WATER) {
        const retry = () => {
          if (tornDown) return;
          if (opts.ws.bufferedAmount() <= WS_BACKPRESSURE_HIGH_WATER) {
            opts.ws.sendBinary(hash, payload, TRANSPORT_RELAY_MARKER);
          } else {
            setTimeout(retry, WS_BACKPRESSURE_POLL_MS);
          }
        };
        setTimeout(retry, WS_BACKPRESSURE_POLL_MS);
        return;
      }
      opts.ws.sendBinary(hash, payload, TRANSPORT_RELAY_MARKER);
    };

    const relaySendDatagram = (datagram: Buffer): void => {
      // Tag 0x00: reliable datagram follows.
      const framed = Buffer.allocUnsafe(1 + datagram.length);
      framed.writeUInt8(RELAY_TAG_DATAGRAM, 0);
      datagram.copy(framed, 1);
      sendRelayFrame(framed);
    };

    const sendDprobeAck = (): void => {
      // Tag 0x01: "your direct reaches me" — single-byte control over relay.
      sendRelayFrame(Buffer.from([RELAY_TAG_DPROBE_ACK]));
    };

    // --- the single reliable engine, routing per-direction LIVE ---
    const makeReliable = (): ReliableConnection => {
      return new ReliableConnection({
        sendDatagram: (buf: Buffer) => {
          // Policy: data on the available direct direction, control on relay.
          // Small datagrams (acks/ping/fin + tiny app control like FT_OK) ALWAYS
          // ride the relay floor (+ opportunistic direct) so a flickery or
          // one-way-only direct leg can never black-hole control. Bulk data rides
          // direct when our outbound leg is confirmed, otherwise the relay floor.
          const canDirect = myDirectOut && !!peerUdp && !!socket;
          const sendDirect = (): boolean => {
            try { socket!.send(buf, peerUdp!.port, peerUdp!.ip); return true; }
            catch { return false; }
          };
          if (buf.length <= CONTROL_DATAGRAM_MAX) {
            relaySendDatagram(buf);
            if (canDirect) sendDirect();
            return;
          }
          if (canDirect && sendDirect()) return;
          relaySendDatagram(buf);
        },
        onDeliver,
        onClose: (r) => {
          onClose(r);
          teardown(r);
        },
      });
    };

    // --- mode computation (live) ---
    const weReceiveDirect = (): boolean =>
      lastDirectRecvAt > 0 && Date.now() - lastDirectRecvAt < DIRECT_RECV_STALE_MS;

    const mode = (): HybridMode => {
      const out = myDirectOut; // our send leg is direct
      const inn = weReceiveDirect(); // our recv leg is direct
      if (out && inn) return 'direct';
      if (!out && !inn) return 'relay';
      return 'hybrid';
    };

    // --- teardown ---
    const teardown = (reason?: string): void => {
      if (tornDown) return;
      tornDown = true;
      if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
      if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
      detachRelayListeners();
      if (answerListener) {
        opts.ws.off('transport_answer', answerListener as (...a: unknown[]) => void);
        answerListener = null;
      }
      if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
      if (reliable && !reliable.isClosed()) reliable.close(reason);
    };

    const fail = (err: Error): void => {
      if (settled) { teardown(err.message); return; }
      settled = true;
      teardown(err.message);
      reject(err);
    };

    // Resolve the channel once usable. Idempotent.
    const finish = (): void => {
      if (settled || tornDown) return;
      settled = true;
      if (!reliable) reliable = makeReliable();
      resolve({
        reliable,
        mode,
        close: (r?: string) => teardown(r),
      });
    };

    // ========================= RELAY =========================
    const onRelayData = (msg: { channelHash: Buffer; payload: Buffer }): void => {
      if (tornDown || !msg || !msg.channelHash) return;
      if (msg.channelHash.toString('hex') !== hashHex) return;
      const payload = msg.payload;
      if (!payload || payload.length < 1) return;
      const tag = payload.readUInt8(0);
      if (tag === RELAY_TAG_DPROBE_ACK) {
        // Peer confirms our direct packets reach it → route OUTBOUND direct.
        myDirectOut = true;
        lastDirectOutConfirmAt = Date.now();
        return;
      }
      if (tag === RELAY_TAG_DATAGRAM) {
        if (reliable) reliable.onDatagram(payload.subarray(1));
      }
    };

    const onRelayReady = (msg: { channelId: string }): void => {
      if (msg.channelId !== opts.channelId) return;
      if (relayReady) return;
      relayReady = true;
      if (relayReadyTimer) { clearTimeout(relayReadyTimer); relayReadyTimer = null; }
      // The relay floor is up — the channel is usable in hybrid/relay policy.
      if (wantRelay) finish();
    };

    const onRelayClose = (msg: { channelId: string; reason?: string }): void => {
      if (msg.channelId !== opts.channelId) return;
      teardown(msg.reason || 'peer closed');
    };

    const attachRelayListeners = (): void => {
      opts.ws.on('transport_relay_data', onRelayData as (...a: unknown[]) => void);
      opts.ws.on('transport_relay_ready', onRelayReady as (...a: unknown[]) => void);
      opts.ws.on('transport_close', onRelayClose as (...a: unknown[]) => void);
    };
    const detachRelayListeners = (): void => {
      opts.ws.off('transport_relay_data', onRelayData as (...a: unknown[]) => void);
      opts.ws.off('transport_relay_ready', onRelayReady as (...a: unknown[]) => void);
      opts.ws.off('transport_close', onRelayClose as (...a: unknown[]) => void);
    };

    let relayReadyTimer: NodeJS.Timeout | null = null;

    const setupRelay = (): void => {
      attachRelayListeners();
      if (opts.initiator) {
        opts.ws.send({
          type: 'transport_relay_open',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
        });
        relayReadyTimer = setTimeout(() => {
          if (!relayReady && !settled) {
            // Relay floor failed to come up.
            if (wantRelay) {
              fail(new Error('relay ready timeout'));
            }
          }
        }, opts.relayReadyTimeoutMs ?? RELAY_READY_TIMEOUT_MS);
        relayReadyTimer.unref?.();
      } else {
        // Answerer: the stream is symmetric — confirm ready immediately.
        opts.ws.send({ type: 'transport_relay_ready', channelId: opts.channelId });
        relayReady = true;
        if (wantRelay) finish();
      }
    };

    // ========================= DIRECT =========================
    const startProbing = (): void => {
      if (probeTimer || tornDown) return;
      const blast = () => {
        if (tornDown || !socket || !peerUdp) return;
        try { socket.send(PUNCH_PROBE, peerUdp.port, peerUdp.ip); } catch { /* ignore */ }
      };
      blast();
      probeTimer = setInterval(blast, PROBE_INTERVAL_MS);
      probeTimer.unref?.();
    };

    const startStaleSweep = (): void => {
      if (staleTimer || tornDown) return;
      staleTimer = setInterval(() => {
        if (tornDown) return;
        // Robustness: if the peer stopped confirming our direct sends, fall back
        // OUTBOUND to relay so a NAT remap / route change cannot black-hole us.
        if (myDirectOut && Date.now() - lastDirectOutConfirmAt > DIRECT_OUT_STALE_MS) {
          myDirectOut = false;
        }
      }, PROBE_INTERVAL_MS);
      staleTimer.unref?.();
    };

    const onUdpMessage = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      if (tornDown) return;
      // Direct probe from the peer: their direct path reaches us.
      if (msg.length === PUNCH_PROBE.length && msg.equals(PUNCH_PROBE)) {
        lastDirectRecvAt = Date.now();
        // Roaming: learn/track the peer's current udp source for our own sends.
        if (!peerUdp || peerUdp.ip !== rinfo.address || peerUdp.port !== rinfo.port) {
          peerUdp = { ip: rinfo.address, port: rinfo.port };
        }
        // Tell the peer over the relay control plane: "your direct reaches me."
        sendDprobeAck();
        return;
      }
      // STUN reply is consumed by the stun() listener below; ignore here.
      if (isStunReply(msg)) return;
      // Otherwise: a reliable datagram arriving over the direct path.
      lastDirectRecvAt = Date.now();
      if (peerUdp && (peerUdp.ip !== rinfo.address || peerUdp.port !== rinfo.port)) {
        peerUdp = { ip: rinfo.address, port: rinfo.port };
      }
      if (reliable) reliable.onDatagram(msg);
    };

    const setupDirect = async (): Promise<void> => {
      const fixedPort = Number(process.env.LM_ASSIST_TRANSPORT_PORT) || 0;
      const publicIp = process.env.LM_ASSIST_PUBLIC_IP;
      const s = dgram.createSocket('udp4');
      socket = s;
      s.on('error', () => { /* direct errors are non-fatal; relay floor stands */ });
      s.on('message', onUdpMessage);
      s.bind(fixedPort);
      await new Promise<void>((r) => s.once('listening', () => r()));
      if (tornDown) return;

      const mine = fixedPort && publicIp
        ? { ip: publicIp, port: fixedPort }
        : await stun(s, opts.stunHost, stunPort, 1500);
      if (tornDown) return;

      // Exchange udp endpoints over the existing transport_open/offer/answer.
      if (opts.initiator) {
        opts.ws.send({
          type: 'transport_open',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
          udp: mine || undefined,
        });
        answerListener = (m) => {
          if (m.channelId !== opts.channelId) return;
          if (m.udp) peerUdp = m.udp;
          startProbing();
        };
        opts.ws.on('transport_answer', answerListener as (...a: unknown[]) => void);
      } else {
        opts.ws.send({
          type: 'transport_answer',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
          udp: mine || undefined,
        });
        // Answerer already knows the peer endpoint from transport_offer.udp.
        startProbing();
      }
      startStaleSweep();
    };

    // ========================= bring-up =========================
    if (wantRelay) setupRelay();
    if (wantRelay && !wantDirect && opts.initiator) {
      // Relay-only (force:'relay'): the hub forwards transport_open -> the peer
      // as transport_offer (the answerer's set-up trigger) but does NOT forward
      // transport_relay_open. Send a bare transport_open (no udp) purely to
      // notify the answerer so it brings up its relay floor and replies
      // transport_relay_ready; we never open a udp socket or probe.
      opts.ws.send({
        type: 'transport_open',
        channelId: opts.channelId,
        peerGatewayId: opts.peerGatewayId,
        udp: undefined,
      });
    }
    if (wantDirect) {
      setupDirect().catch(() => { /* direct setup failure leaves relay floor */ });
    }

    // force:'direct' has no relay floor to gate on — resolve once the socket is
    // up (best-effort). Poll briefly for the socket to bind.
    if (opts.force === 'direct') {
      const t0 = Date.now();
      const waitSocket = setInterval(() => {
        if (settled || tornDown) { clearInterval(waitSocket); return; }
        if (socket) { clearInterval(waitSocket); finish(); return; }
        if (Date.now() - t0 > 5000) {
          clearInterval(waitSocket);
          fail(new Error('direct setup timeout'));
        }
      }, 20);
      waitSocket.unref?.();
    }
  });

  // -------------------------------------------------------------------------
  // STUN helper (same protocol as holepunch.ts): learn our public udp endpoint.
  // -------------------------------------------------------------------------
  function isStunReply(msg: Buffer): boolean {
    try {
      const obj = JSON.parse(msg.toString('utf-8')) as { type?: string };
      return obj.type === 'stun';
    } catch {
      return false;
    }
  }

  function stun(
    sock: dgram.Socket,
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<UdpEndpoint | null> {
    return new Promise((resolveStun) => {
      let done = false;
      const onMsg = (msg: Buffer) => {
        try {
          const obj = JSON.parse(msg.toString('utf-8')) as { type?: string; ip?: string; port?: number };
          if (obj.type === 'stun' && obj.ip && typeof obj.port === 'number') {
            if (done) return;
            done = true;
            clearInterval(retry);
            clearTimeout(timer);
            sock.removeListener('message', onMsg);
            resolveStun({ ip: obj.ip, port: obj.port });
          }
        } catch {
          /* not a STUN reply; ignore */
        }
      };
      sock.on('message', onMsg);
      const sendProbe = () => { try { sock.send(STUN_REQUEST, port, host); } catch { /* ignore */ } };
      sendProbe();
      const retry = setInterval(sendProbe, 200);
      retry.unref?.();
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        clearInterval(retry);
        sock.removeListener('message', onMsg);
        resolveStun(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }
}
