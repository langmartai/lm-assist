/**
 * Node-to-node transport driver — HYBRID channel.
 *
 * The exported Channel interface + openChannel signature are the FROZEN contract
 * the file-transfer layer builds on (unchanged below — except Channel.mode now
 * also reports 'hybrid').
 *
 * Hybrid design (per docs/plans/2026-06-08-nat-transport-design.md, revised):
 *   Each channel keeps BOTH transports live at once and routes per-direction:
 *     - RELAY (0xFD over the hub WS) is the ALWAYS-present reliable floor +
 *       control plane.
 *     - DIRECT (udp4 socket + STUN + endpoint exchange) is layered on top and
 *       used for OUTBOUND only once the peer confirms it receives our direct
 *       packets (DPROBE_ACK over the relay control plane).
 *   ONE ReliableConnection per channel does all sequencing/ack/retransmit; its
 *   sendDatagram routes LIVE (direct when confirmed, else relay) and its
 *   onDatagram is fed from BOTH the udp socket and the relay 0xFD stream.
 *   See hybrid.ts for the full mechanism.
 *
 *   forceMode:'relay'  → relay only (skip the udp socket entirely).
 *   forceMode:'direct' → best-effort direct, skip the relay floor (testing).
 *   default            → full hybrid.
 *
 * Decoupling: the driver talks to the hub only through TransportWsSender
 * (ws-deps.ts). The integrator adapts the real WebSocketClient/HubClient and
 * forwards the transport_* events + the 0xFD binary demux. See the
 * "INTEGRATOR WIRING" note at the bottom of this file. (No new hub message
 * types are introduced — DPROBE_ACK rides the existing 0xFD relay-data path.)
 */

import { randomUUID } from 'crypto';
import { openHybridChannel } from './hybrid';
import type { HybridChannel } from './hybrid';
import type { TransportDeps, TransportWsSender } from './ws-deps';

export interface Channel {
  id: string;
  peerGatewayId: string;
  /**
   * Live ICE-ladder state:
   *   'bidi'   — both legs direct + sustained; everything direct, relay idle.
   *   'oneway' — exactly one leg direct; bulk data direct that way, control relay.
   *   'relay'  — neither leg direct; all traffic via the relay floor.
   * Read live (getter) — reflects current per-direction confirmation.
   */
  mode: "bidi" | "oneway" | "relay";
  /**
   * Kind of the best confirmed OUTBOUND direct candidate
   * ('host' | 'static' | 'srflx'), or null when not sending direct (relay).
   * Lets a caller distinguish a same-LAN host-direct path from a hole-punched
   * srflx path. Read live; safe to read at any time.
   */
  via: "host" | "static" | "srflx" | null;
  /** Reliable, ordered bulk data — rides the direct path when confirmed. */
  send(data: Buffer): void;
  /** Reliable, ordered control/metadata — ALWAYS rides the relay (priority). */
  sendControl(data: Buffer): void;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(): void;
}
export interface OpenChannelOpts {
  directTimeoutMs?: number;
  forceMode?: "direct" | "relay";
}

// ---------------------------------------------------------------------------
// Module-level wiring (set by initTransport).
// ---------------------------------------------------------------------------

let deps: TransportDeps | null = null;

/**
 * Wire the transport driver to the hub connection. Call once after the hub
 * client authenticates (so selfGatewayId is known). Re-calling updates deps
 * (e.g. after a reconnect with a new ws sender). Also registers the handler for
 * inbound channel offers so this node can answer peers.
 */
export function initTransport(d: TransportDeps): void {
  deps = d;
  registerInboundHandlers(d.ws);
}

/** True once initTransport has been called with a connected ws. */
export function isTransportReady(): boolean {
  return !!deps && deps.ws.isConnected();
}

// Avoid double-registering listeners across reconnects on the same ws object.
const wiredWsSet = new WeakSet<object>();

// Track channels we've already begun answering, keyed by channelId, so the two
// inbound signals for the SAME hybrid channel (transport_relay_open and
// transport_offer) set up exactly ONE HybridChannel.
const answeredChannels = new Set<string>();

function registerInboundHandlers(ws: TransportWsSender): void {
  if (wiredWsSet.has(ws as object)) return;
  wiredWsSet.add(ws as object);

  // A peer opened a channel to us. For a hybrid channel the initiator sends
  // BOTH transport_relay_open (relay floor) and transport_open→transport_offer
  // (direct leg). We answer once, on whichever arrives first, and pass the
  // known peer udp (if any) through.
  ws.on('transport_relay_open', ((msg: { channelId: string; peerGatewayId?: string; fromGatewayId?: string }) => {
    if (!deps) return;
    const peer = msg.fromGatewayId || msg.peerGatewayId || 'unknown';
    void answerHybrid(msg.channelId, peer, undefined);
  }) as (...a: unknown[]) => void);

  // udp is the candidate ADVERT ({ip, port, cands?}), forwarded verbatim by the
  // hub. Pass it through opaquely (typed unknown) — hybrid.ts parses the ladder.
  ws.on('transport_offer', ((msg: { channelId: string; fromGatewayId: string; udp?: unknown }) => {
    if (!deps) return;
    void answerHybrid(msg.channelId, msg.fromGatewayId, msg.udp);
  }) as (...a: unknown[]) => void);
}

// Callbacks the application registers to receive inbound (answered) channels.
const inboundChannelCbs: Array<(ch: Channel) => void> = [];

/** Register a callback invoked for each channel a peer opens to this node. */
export function onInboundChannel(cb: (ch: Channel) => void): void {
  inboundChannelCbs.push(cb);
}

function emitInbound(ch: Channel): void {
  for (const cb of inboundChannelCbs) {
    try { cb(ch); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// HybridChannel → frozen Channel shape.
// ---------------------------------------------------------------------------

function makeChannel(
  id: string,
  peerGatewayId: string,
  hybrid: HybridChannel,
  dataCbRef: { cb: ((d: Buffer) => void) | null },
  closeCbRef: { cb: ((r?: string) => void) | null },
): Channel {
  return {
    id,
    peerGatewayId,
    // mode + via are dynamic; expose via getters so callers reading ch.mode /
    // ch.via always see the live leg state + winning candidate kind.
    get mode() { return hybrid.mode(); },
    get via() { return hybrid.via(); },
    send: (data: Buffer) => hybrid.reliable.send(data, false),
    sendControl: (data: Buffer) => hybrid.reliable.send(data, true),
    onData: (cb) => { dataCbRef.cb = cb; },
    onClose: (cb) => { closeCbRef.cb = cb; },
    close: () => hybrid.close('closed by caller'),
  } as Channel;
}

// ---------------------------------------------------------------------------
// Initiator side: openChannel (FROZEN signature).
// ---------------------------------------------------------------------------

/**
 * Open a reliable, ordered channel to peerGatewayId.
 *
 * Default = hybrid: brings up the relay floor (resolves once ready) AND opens
 * the direct udp leg in parallel, upgrading OUTBOUND to direct as soon as the
 * peer confirms reachability. forceMode:'relay' = relay only; forceMode:'direct'
 * = best-effort direct with no relay floor. Resolves only once usable.
 */
export async function openChannel(peerGatewayId: string, opts?: OpenChannelOpts): Promise<Channel> {
  if (!deps) throw new Error('transport not initialized — call initTransport(deps) first');
  if (!deps.ws.isConnected()) throw new Error('hub not connected — cannot open transport channel');
  if (peerGatewayId === deps.selfGatewayId) throw new Error('cannot open a transport channel to self');

  const channelId = randomUUID();
  return setupHybrid(channelId, peerGatewayId, /*initiator*/ true, undefined, opts?.forceMode);
}

// ---------------------------------------------------------------------------
// Answerer side: respond to a peer's inbound open.
// ---------------------------------------------------------------------------

async function answerHybrid(channelId: string, peerGatewayId: string, peerUdp?: unknown): Promise<void> {
  if (answeredChannels.has(channelId)) return; // already set up by the other signal
  answeredChannels.add(channelId);
  try {
    const ch = await setupHybrid(channelId, peerGatewayId, /*initiator*/ false, peerUdp, undefined);
    emitInbound(ch);
  } catch {
    answeredChannels.delete(channelId);
  }
}

// ---------------------------------------------------------------------------
// Shared hybrid setup (initiator + answerer).
// ---------------------------------------------------------------------------

async function setupHybrid(
  channelId: string,
  peerGatewayId: string,
  initiator: boolean,
  knownPeer: unknown,
  forceMode: 'direct' | 'relay' | undefined,
): Promise<Channel> {
  const d = deps!;
  const dataCbRef: { cb: ((d: Buffer) => void) | null } = { cb: null };
  const closeCbRef: { cb: ((r?: string) => void) | null } = { cb: null };

  const hybrid = await openHybridChannel(
    {
      channelId,
      peerGatewayId,
      initiator,
      ws: d.ws,
      stunHost: d.stunHost,
      stunPort: d.stunPort,
      knownPeer,
      force: forceMode,
    },
    (data) => { if (dataCbRef.cb) dataCbRef.cb(data); },
    (reason) => {
      answeredChannels.delete(channelId);
      if (closeCbRef.cb) closeCbRef.cb(reason);
    },
  );
  return makeChannel(channelId, peerGatewayId, hybrid, dataCbRef, closeCbRef);
}

// ---------------------------------------------------------------------------
// Re-exports for the file-transfer layer + integrator.
// ---------------------------------------------------------------------------

export { ReliableConnection } from './reliable';
export { TRANSPORT_RELAY_MARKER } from './hybrid';
export type { TransportDeps, TransportWsSender, UdpEndpoint } from './ws-deps';

/*
 * ============================================================================
 * INTEGRATOR WIRING — what to add to core/src/hub-client (already present).
 * ============================================================================
 *
 * The hybrid channel introduces NO new hub message types and NO new binary
 * markers. It reuses exactly the wiring the prior (direct-OR-relay) driver
 * needed, all of which is already in websocket-client.ts:
 *
 * 1. handleMessage(): forward the transport_* JSON control messages as typed
 *    events (already done — verified at websocket-client.ts):
 *      transport_open / transport_offer / transport_answer /
 *      transport_relay_open / transport_relay_ready / transport_close
 *
 * 2. handleMessage(): the 0xFD binary demux (already done):
 *      if (buffer.length >= 9 && buffer[0] === 0xfd) {
 *        const channelHash = buffer.subarray(1, 9);
 *        const payload = buffer.subarray(9);
 *        this.emit('transport_relay_data', { channelHash, payload });
 *        return;
 *      }
 *    The DPROBE_ACK control and the reliable datagrams BOTH ride this single
 *    0xFD path — they are distinguished by a 1-byte tag INSIDE `payload`
 *    (0x00 = datagram, 0x01 = DPROBE_ACK), so the hub-client sees only opaque
 *    relay payloads and needs no change.
 *
 * 3. hub-client/index.ts, after authentication: call initTransport with an
 *    adapter over wsClient (unchanged from before):
 *
 *      import { initTransport } from '../transport';
 *      initTransport({
 *        ws: this.wsClient,
 *        selfGatewayId: data.gatewayId,
 *        stunHost: new URL(hubUrl).hostname,
 *        stunPort: 8087,
 *      });
 *
 * In short: integrator wiring is IDENTICAL to the pre-hybrid driver. Nothing in
 * hub-client needs to change beyond what already exists.
 * ============================================================================
 */
