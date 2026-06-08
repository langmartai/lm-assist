/**
 * Hybrid transport path for the transport driver — ICE-style escalation ladder.
 *
 * Keeps BOTH underlying transports live at once and routes per-direction. The
 * relay is ALWAYS the reliable floor + bootstrap control plane; the direct UDP
 * path is layered on top and escalated through a candidate ladder. On a path
 * that fully opens both directions the channel promotes to strict-direct (BIDI)
 * and the relay goes idle (0 bytes) but stays connected as the safety net.
 *
 * Candidate ladder (NEW): each node gathers UDP candidates for its bound socket
 * and advertises them ALL inside the single `udp` field the hub forwards
 * verbatim (see candidates.ts for the wire shape and gathering):
 *   host   (highest) — every non-internal IPv4 at the bound local port. Lets
 *                      same-LAN peers connect directly over the LAN.
 *   static           — configured public endpoint (env).
 *   srflx  (lowest)  — STUN-discovered public mapping (needs hole punch).
 * Probing escalates HOST → PUNCH:
 *   Phase 1 (HOST): probe host + static candidates for ~PHASE1_HOST_MS.
 *   Phase 2 (PUNCH): if no direction confirmed direct by then, ALSO probe the
 *                    srflx candidate (the public-IP hole punch). All candidates
 *                    keep being probed as keepalive.
 *
 * State machine: RELAY → ONEWAY → BIDI (with fast demotion).
 *   RELAY  — relay floor only; all traffic via relay. openChannel resolves here.
 *   ONEWAY — our outbound direct confirmed for >=1 direction but NOT both.
 *            Bulk data (>CONTROL_DATAGRAM_MAX) rides direct when myDirectOut;
 *            control (<=256B) always relay + opportunistic direct.
 *   BIDI   — BOTH directions confirmed AND sustained. EVERYTHING (data, control,
 *            acks) rides direct both ways; the relay WS stays connected but idle.
 *
 * Promotion to BIDI is CONSERVATIVE (avoids reintroducing reverse-control loss):
 *   both directions must be FRESH — myDirectOut confirmed within
 *   DIRECT_OUT_STALE_MS AND weReceiveDirect() within DIRECT_RECV_STALE_MS —
 *   sustained across >=BIDI_SUSTAIN_CYCLES consecutive stale-sweep ticks (the
 *   sweep runs every PROBE_INTERVAL_MS). The counter only increments while BOTH
 *   are fresh and resets to 0 the instant either goes stale.
 *
 * Demotion is FAST (the safety net):
 *   the stale sweep (every PROBE_INTERVAL_MS) drops myDirectOut when no
 *   DPROBE_ACK within DIRECT_OUT_STALE_MS. weReceiveDirect() is freshness-based
 *   already. The live routing reads both every send, so the instant either leg
 *   goes stale the mode falls from BIDI → ONEWAY (control returns to relay) or →
 *   RELAY (neither direct). Because reliable.ts retransmits unacked datagrams and
 *   the relay is warm, any datagram lost on a just-broken direct leg is
 *   retransmitted over the relay — no data loss.
 *
 * Relay 0xFD payload wire format (1-byte tag prefix):
 *   0x00  reliable datagram follows  → onDatagram(payload.subarray(1))
 *   0x01  DPROBE_ACK control         → myDirectOut = true (confirm)
 *
 * Mode reporting:
 *   Channel.mode → 'bidi' | 'oneway' | 'relay'
 *   Channel.via  → kind of the best confirmed OUTBOUND candidate
 *                  ('host'|'static'|'srflx'), or null in relay.
 */

import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { ReliableConnection } from './reliable';
import type { TransportWsSender, UdpEndpoint } from './ws-deps';
import {
  type Candidate,
  type CandidateKind,
  buildCandidateList,
  buildUdpAdvert,
  candidatePriority,
  classifyEndpoint,
  gatherHostCandidates,
  gatherStaticCandidate,
  parseUdpAdvert,
} from './candidates';

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
/** Phase 1 (HOST tier) duration: probe host + static only. After this, if no
 *  direction is confirmed direct, escalate to PUNCH (also probe srflx). */
const PHASE1_HOST_MS = 2000;
/** Number of consecutive stale-sweep cycles BOTH legs must be fresh before we
 *  promote to BIDI. At PROBE_INTERVAL_MS=1000 this is a ~2s sustained window. */
const BIDI_SUSTAIN_CYCLES = 2;

const CONTROL_DATAGRAM_MAX = 256;

function hashChannelId(channelId: string): Buffer {
  return crypto.createHash('md5').update(channelId).digest().subarray(0, 8);
}

export type HybridMode = 'bidi' | 'oneway' | 'relay';
export type ProbeTier = 'host' | 'punch';

export interface HybridOptions {
  channelId: string;
  peerGatewayId: string;
  /** True if THIS node initiates (sent transport_open / transport_relay_open). */
  initiator: boolean;
  ws: TransportWsSender;
  /** Hub host for STUN (the gateway host). */
  stunHost: string;
  stunPort?: number; // default 8087
  /** Peer udp advert already known from transport_offer (answerer side). */
  knownPeer?: unknown;
  /**
   * Mode policy:
   *   'relay'  — relay only, never open the udp socket (forceMode:'relay').
   *   'direct' — best-effort direct, skip the relay floor (forceMode:'direct').
   *   undefined — full hybrid ladder (relay floor + escalating direct). Default.
   */
  force?: 'direct' | 'relay';
  /** Initiator: how long to wait for the relay floor before giving up. */
  relayReadyTimeoutMs?: number;
}

export interface HybridChannel {
  reliable: ReliableConnection;
  /** Current mode based on which legs are confirmed direct + sustained. Live. */
  mode(): HybridMode;
  /** Kind of the best confirmed OUTBOUND candidate, or null in relay. Live. */
  via(): CandidateKind | null;
  close(reason?: string): void;
}

/**
 * Open a hybrid channel and resolve once it is usable.
 *
 * Usability:
 *   - force:'relay'  → resolves when the relay floor is ready.
 *   - force:'direct' → resolves once the udp socket is bound + candidates
 *                      exchanged (best-effort; direct may not be reachable).
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
    const dbg = (...a: unknown[]): void => {
      if (process.env.LM_TDEBUG) console.log('[hybrid]', opts.channelId.slice(0, 8), opts.initiator ? 'I' : 'A', ...a);
    };

    // --- direct (udp) state ---
    let socket: dgram.Socket | null = null;
    /** Peer candidates we probe (priority-ordered). */
    let peerCands: Candidate[] = opts.knownPeer ? parseUdpAdvert(opts.knownPeer) : [];
    /** The peer endpoint our OUTBOUND data is sent to (roamed to last good src). */
    let peerUdp: UdpEndpoint | null = peerCands.length > 0 ? { ip: peerCands[0].ip, port: peerCands[0].port } : null;
    /** Kind of the candidate peerUdp currently corresponds to (for via()). */
    let viaKind: CandidateKind | null = null;
    let myDirectOut = false; // peer confirmed it receives OUR direct packets
    let lastDirectRecvAt = 0; // last time we got ANY direct packet from peer
    let lastDirectOutConfirmAt = 0; // last DPROBE_ACK from peer
    let probeTimer: NodeJS.Timeout | null = null;
    let staleTimer: NodeJS.Timeout | null = null;
    let tier: ProbeTier = 'host'; // ladder tier; escalates to 'punch'
    let probingStartedAt = 0;
    let bidiFreshCycles = 0; // consecutive sweeps with BOTH legs fresh
    let bidiPromoted = false; // sticky promotion flag (cleared on demotion)
    let roamed = false; // we have observed real inbound udp from the peer

    // --- relay state ---
    let relayReady = false;
    let answerListener: ((m: { channelId: string; udp?: unknown }) => void) | null = null;

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

    const sendDprobeAck = (tag: string): void => {
      // Tag 0x01 + echoed target string: tells the peer WHICH of its candidate
      // targets actually reached us, so it can pick the right send endpoint.
      const t = Buffer.from(tag, 'utf-8');
      const buf = Buffer.allocUnsafe(1 + t.length);
      buf.writeUInt8(RELAY_TAG_DPROBE_ACK, 0);
      t.copy(buf, 1);
      sendRelayFrame(buf);
    };

    // --- mode computation (live) ---
    const weReceiveDirect = (): boolean =>
      lastDirectRecvAt > 0 && Date.now() - lastDirectRecvAt < DIRECT_RECV_STALE_MS;

    const myDirectFresh = (): boolean =>
      myDirectOut && Date.now() - lastDirectOutConfirmAt < DIRECT_OUT_STALE_MS;

    const mode = (): HybridMode => {
      const out = myDirectFresh(); // our send leg is direct + fresh
      const inn = weReceiveDirect(); // our recv leg is direct + fresh
      // BIDI only after conservative sustained promotion AND both legs still fresh.
      if (bidiPromoted && out && inn) return 'bidi';
      if (out || inn) return 'oneway';
      return 'relay';
    };

    const via = (): CandidateKind | null => {
      if (!myDirectFresh()) return null;
      return viaKind;
    };

    // --- the single reliable engine, routing per-direction LIVE ---
    const makeReliable = (): ReliableConnection => {
      return new ReliableConnection({
        sendDatagram: (buf: Buffer) => {
          // Read live state at send time (never snapshot).
          const canDirect = myDirectFresh() && !!peerUdp && !!socket;
          const sendDirect = (): boolean => {
            try { socket!.send(buf, peerUdp!.port, peerUdp!.ip); return true; }
            catch { return false; }
          };
          // BIDI: both legs confirmed + sustained → EVERYTHING direct, no relay copy.
          if (mode() === 'bidi') {
            if (sendDirect()) return;
            // Direct send threw despite BIDI — fall back to relay this once;
            // the stale sweep will demote shortly.
            relaySendDatagram(buf);
            return;
          }
          // ONEWAY / RELAY policy: small control always on relay floor (+
          // opportunistic direct); bulk data direct when our outbound is fresh.
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
        via,
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
        // Echoed payload = which of OUR candidate targets reached the peer. Use
        // it as the send endpoint UNLESS we already roamed to an observed inbound
        // source (a proven reverse path = higher confidence). Prefer the
        // highest-priority confirmed candidate.
        const ep = payload.subarray(1).toString('utf-8');
        const mm = /^(.+):(\d+)$/.exec(ep);
        if (mm && !roamed) {
          const cand: UdpEndpoint = { ip: mm[1], port: Number(mm[2]) };
          const kind = classifyEndpoint(cand, peerCands);
          if (!viaKind || candidatePriority(kind) >= candidatePriority(viaKind)) {
            peerUdp = cand;
            viaKind = kind;
            dbg('out-confirmed target', ep, kind);
          }
        }
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
    /** Candidates eligible at the current tier: host+static always; srflx only
     *  once we've escalated to the PUNCH tier. */
    const activePeerCands = (): Candidate[] => {
      if (tier === 'punch') return peerCands;
      return peerCands.filter((c) => c.kind !== 'srflx');
    };

    const startProbing = (): void => {
      if (probeTimer || tornDown) return;
      probingStartedAt = Date.now();
      dbg('startProbing peerCands=', JSON.stringify(peerCands));
      const blast = () => {
        if (tornDown || !socket) return;
        // Escalate HOST → PUNCH if nothing confirmed within the phase-1 budget.
        if (tier === 'host' && !myDirectFresh() && !weReceiveDirect()
            && Date.now() - probingStartedAt >= PHASE1_HOST_MS) {
          tier = 'punch';
        }
        const cands = activePeerCands();
        for (const c of cands) {
          const probe = Buffer.concat([PUNCH_PROBE, Buffer.from(`${c.ip}:${c.port}`)]);
          try { socket.send(probe, c.port, c.ip); } catch { /* ignore */ }
        }
      };
      blast();
      probeTimer = setInterval(blast, PROBE_INTERVAL_MS);
      probeTimer.unref?.();
    };

    const startStaleSweep = (): void => {
      if (staleTimer || tornDown) return;
      staleTimer = setInterval(() => {
        if (tornDown) return;
        // FAST DEMOTION: if the peer stopped confirming our direct sends, fall
        // back OUTBOUND to relay so a NAT remap / route change cannot black-hole
        // us. (weReceiveDirect is already freshness-based, no flag to clear.)
        if (myDirectOut && Date.now() - lastDirectOutConfirmAt > DIRECT_OUT_STALE_MS) {
          myDirectOut = false;
        }
        // CONSERVATIVE PROMOTION: count consecutive cycles where BOTH legs are
        // fresh; promote to BIDI only after the sustain window. Reset the moment
        // either leg goes stale (which also demotes a promoted channel).
        const was = bidiPromoted;
        if (myDirectFresh() && weReceiveDirect()) {
          bidiFreshCycles += 1;
          if (bidiFreshCycles >= BIDI_SUSTAIN_CYCLES) bidiPromoted = true;
        } else {
          bidiFreshCycles = 0;
          bidiPromoted = false; // FAST DEMOTION out of BIDI on either leg stale.
        }
        if (process.env.LM_TDEBUG)
          dbg('sweep out=' + myDirectFresh() + ' inn=' + weReceiveDirect() + ' mode=' + mode()
              + (was !== bidiPromoted ? ' BIDI->' + bidiPromoted : ''));
      }, PROBE_INTERVAL_MS);
      staleTimer.unref?.();
    };

    /** Roam peerUdp to a freshly observed source + recompute via kind. */
    const adoptPeerSource = (rinfo: dgram.RemoteInfo): void => {
      const changed = !peerUdp || peerUdp.ip !== rinfo.address || peerUdp.port !== rinfo.port;
      if (changed) peerUdp = { ip: rinfo.address, port: rinfo.port };
      roamed = true; // proven reverse path: the peer's packets reach us
      viaKind = classifyEndpoint(peerUdp!, peerCands);
      if (changed) dbg('roamed to', rinfo.address + ':' + rinfo.port, viaKind);
    };

    const onUdpMessage = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      if (tornDown) return;
      // Direct probe from the peer: their direct path reaches us.
      if (msg.length >= PUNCH_PROBE.length && msg.subarray(0, PUNCH_PROBE.length).equals(PUNCH_PROBE)) {
        lastDirectRecvAt = Date.now();
        adoptPeerSource(rinfo); // roaming: learn the peer's current udp source
        // Echo back the candidate the peer aimed at, so they learn which of
        // THEIR candidates reaches us (per-candidate outbound confirmation).
        const aimed = msg.subarray(PUNCH_PROBE.length).toString('utf-8');
        sendDprobeAck(aimed);
        return;
      }
      // STUN reply is consumed by the stun() listener below; ignore here.
      if (isStunReply(msg)) return;
      // Otherwise: a reliable datagram arriving over the direct path.
      lastDirectRecvAt = Date.now();
      adoptPeerSource(rinfo);
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

      // The actual bound local port (resolves the ephemeral case for host cands).
      const localPort = (() => { try { return s.address().port; } catch { return fixedPort; } })();

      // Gather candidates: host (all LAN IPs at the bound port), static (env),
      // srflx (STUN). When a fixed public endpoint is configured we advertise it
      // as the static candidate and skip STUN (matching the prior single-endpoint
      // behavior); otherwise STUN gives the srflx candidate.
      const hostCands = gatherHostCandidates(localPort);
      const staticCand = gatherStaticCandidate();
      let srflx: UdpEndpoint | null = null;
      if (fixedPort && publicIp) {
        srflx = null; // static candidate already covers the public endpoint
      } else {
        srflx = await stun(s, opts.stunHost, stunPort, 1500);
      }
      if (tornDown) return;

      const myCands = buildCandidateList(hostCands, staticCand, srflx);
      const advert = buildUdpAdvert(myCands);
      dbg('myCands=', JSON.stringify(myCands));

      // Exchange candidate adverts over the existing transport_open/offer/answer.
      if (opts.initiator) {
        opts.ws.send({
          type: 'transport_open',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
          udp: advert,
        });
        answerListener = (m) => {
          if (m.channelId !== opts.channelId) return;
          const cands = parseUdpAdvert(m.udp);
          if (cands.length > 0) {
            peerCands = cands;
            if (!peerUdp) peerUdp = { ip: cands[0].ip, port: cands[0].port };
          }
          startProbing();
        };
        opts.ws.on('transport_answer', answerListener as (...a: unknown[]) => void);
      } else {
        opts.ws.send({
          type: 'transport_answer',
          channelId: opts.channelId,
          peerGatewayId: opts.peerGatewayId,
          udp: advert,
        });
        // Answerer already knows the peer candidates from transport_offer.udp.
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
