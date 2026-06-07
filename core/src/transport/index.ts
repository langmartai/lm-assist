/**
 * Node-to-node transport driver — UDP hole-punch (direct) with hub-relay
 * fallback. The exported Channel interface + openChannel signature are the
 * FROZEN contract the file-transfer layer builds on (unchanged below).
 *
 * Implementation per docs/plans/2026-06-08-nat-transport-design.md:
 *   - openChannel(peer): try direct (holepunch.ts) within directTimeoutMs, else
 *     fall back to relay (relay.ts). Resolves only when usable; sets `mode`.
 *   - initTransport(deps): wires the hub WS sender + selfGatewayId + STUN host,
 *     and registers the inbound-offer handler so this node can ANSWER channels a
 *     peer opens to it.
 *
 * Decoupling: the driver talks to the hub only through TransportWsSender
 * (ws-deps.ts). The integrator adapts the real WebSocketClient/HubClient and
 * forwards the transport_* events + the 0xFD binary demux. See the
 * "INTEGRATOR WIRING" note at the bottom of this file.
 */

import { randomUUID } from 'crypto';
import { holePunch } from './holepunch';
import { openRelayChannel } from './relay';
import type { TransportDeps, TransportWsSender, UdpEndpoint } from './ws-deps';

export interface Channel {
  id: string;
  peerGatewayId: string;
  mode: "direct" | "relay";
  /** Reliable, ordered in both modes. */
  send(data: Buffer): void;
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

function registerInboundHandlers(ws: TransportWsSender): void {
  if (wiredWsSet.has(ws as object)) return;
  wiredWsSet.add(ws as object);

  // A peer opened a DIRECT channel to us: it sent transport_open, the hub
  // relayed it as transport_offer carrying the initiator's gatewayId + udp.
  ws.on('transport_offer', ((msg: { channelId: string; fromGatewayId: string; udp?: UdpEndpoint }) => {
    if (!deps) return;
    void answerDirect(msg);
  }) as (...a: unknown[]) => void);

  // A peer opened a RELAY channel to us: it sent transport_relay_open, the hub
  // relayed it. We answer by establishing our side and emitting relay_ready.
  ws.on('transport_relay_open', ((msg: { channelId: string; peerGatewayId?: string; fromGatewayId?: string }) => {
    if (!deps) return;
    void answerRelay(msg);
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
// Channel construction helpers (direct + relay → the frozen Channel shape).
// ---------------------------------------------------------------------------

function makeDirectChannel(
  id: string,
  peerGatewayId: string,
  punched: { reliable: import('./reliable').ReliableConnection; close(reason?: string): void },
  dataCbRef: { cb: ((d: Buffer) => void) | null },
  closeCbRef: { cb: ((r?: string) => void) | null },
): Channel {
  return {
    id,
    peerGatewayId,
    mode: 'direct',
    send: (data: Buffer) => punched.reliable.send(data),
    onData: (cb) => { dataCbRef.cb = cb; },
    onClose: (cb) => { closeCbRef.cb = cb; },
    close: () => punched.close('closed by caller'),
  };
}

function makeRelayChannel(
  id: string,
  peerGatewayId: string,
  relay: import('./relay').RelayChannel,
): Channel {
  return {
    id,
    peerGatewayId,
    mode: 'relay',
    send: (data: Buffer) => relay.send(data),
    onData: (cb) => relay.onData(cb),
    onClose: (cb) => relay.onClose(cb),
    close: () => relay.close('closed by caller'),
  };
}

// ---------------------------------------------------------------------------
// Initiator side: openChannel (FROZEN signature).
// ---------------------------------------------------------------------------

/**
 * Open a reliable, ordered channel to peerGatewayId.
 * Tries direct (UDP hole punch) within directTimeoutMs; on failure (or when
 * forceMode:'relay') falls back to the hub relay. Resolves only once usable.
 */
export async function openChannel(peerGatewayId: string, opts?: OpenChannelOpts): Promise<Channel> {
  if (!deps) throw new Error('transport not initialized — call initTransport(deps) first');
  if (!deps.ws.isConnected()) throw new Error('hub not connected — cannot open transport channel');
  if (peerGatewayId === deps.selfGatewayId) throw new Error('cannot open a transport channel to self');

  const directTimeoutMs = opts?.directTimeoutMs ?? 4000;
  const channelId = randomUUID();
  const forceMode = opts?.forceMode;

  if (forceMode !== 'relay') {
    try {
      const ch = await tryDirect(channelId, peerGatewayId, directTimeoutMs);
      return ch;
    } catch (err) {
      if (forceMode === 'direct') {
        throw err instanceof Error ? err : new Error(String(err));
      }
      // else fall through to relay
    }
  }

  return tryRelay(channelId, peerGatewayId, /*initiator*/ true);
}

async function tryDirect(channelId: string, peerGatewayId: string, directTimeoutMs: number): Promise<Channel> {
  const d = deps!;
  const dataCbRef: { cb: ((d: Buffer) => void) | null } = { cb: null };
  const closeCbRef: { cb: ((r?: string) => void) | null } = { cb: null };

  const punched = await holePunch(
    {
      channelId,
      peerGatewayId,
      initiator: true,
      ws: d.ws,
      stunHost: d.stunHost,
      stunPort: d.stunPort,
      punchTimeoutMs: Math.max(500, directTimeoutMs - 500),
    },
    (data) => { if (dataCbRef.cb) dataCbRef.cb(data); },
    (reason) => { if (closeCbRef.cb) closeCbRef.cb(reason); },
  );
  return makeDirectChannel(channelId, peerGatewayId, punched, dataCbRef, closeCbRef);
}

async function tryRelay(channelId: string, peerGatewayId: string, initiator: boolean): Promise<Channel> {
  const d = deps!;
  const relay = await openRelayChannel({ channelId, peerGatewayId, initiator, ws: d.ws });
  return makeRelayChannel(channelId, peerGatewayId, relay);
}

// ---------------------------------------------------------------------------
// Answerer side: respond to a peer's offer (direct) / relay_open (relay).
// ---------------------------------------------------------------------------

async function answerDirect(msg: { channelId: string; fromGatewayId: string; udp?: UdpEndpoint }): Promise<void> {
  const d = deps!;
  if (!msg.udp) {
    // No usable peer endpoint — cannot punch; ignore (initiator will time out
    // and fall back to relay, which we answer via transport_relay_open).
    return;
  }
  const dataCbRef: { cb: ((d: Buffer) => void) | null } = { cb: null };
  const closeCbRef: { cb: ((r?: string) => void) | null } = { cb: null };
  try {
    const punched = await holePunch(
      {
        channelId: msg.channelId,
        peerGatewayId: msg.fromGatewayId,
        initiator: false,
        ws: d.ws,
        stunHost: d.stunHost,
        stunPort: d.stunPort,
        knownPeer: msg.udp,
      },
      (data) => { if (dataCbRef.cb) dataCbRef.cb(data); },
      (reason) => { if (closeCbRef.cb) closeCbRef.cb(reason); },
    );
    emitInbound(makeDirectChannel(msg.channelId, msg.fromGatewayId, punched, dataCbRef, closeCbRef));
  } catch {
    // Punch failed on our side; the initiator times out and retries via relay.
  }
}

async function answerRelay(msg: { channelId: string; peerGatewayId?: string; fromGatewayId?: string }): Promise<void> {
  const d = deps!;
  const peer = msg.fromGatewayId || msg.peerGatewayId || 'unknown';
  try {
    const relay = await openRelayChannel({
      channelId: msg.channelId,
      peerGatewayId: peer,
      initiator: false,
      ws: d.ws,
    });
    emitInbound(makeRelayChannel(msg.channelId, peer, relay));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Re-exports for the file-transfer layer + integrator.
// ---------------------------------------------------------------------------

export { ReliableConnection } from './reliable';
export { TRANSPORT_RELAY_MARKER } from './relay';
export type { TransportDeps, TransportWsSender, UdpEndpoint } from './ws-deps';

/*
 * ============================================================================
 * INTEGRATOR WIRING — what to add to core/src/hub-client (do NOT done here).
 * ============================================================================
 *
 * 1. websocket-client.ts handleMessage(): forward the new transport_* JSON
 *    control messages as typed events (mirror the forward_* cases):
 *
 *      case 'transport_open':         this.emit('transport_open', message); break;
 *      case 'transport_offer':        this.emit('transport_offer', message); break;
 *      case 'transport_answer':       this.emit('transport_answer', message); break;
 *      case 'transport_relay_open':   this.emit('transport_relay_open', message); break;
 *      case 'transport_relay_ready':  this.emit('transport_relay_ready', message); break;
 *      case 'transport_close':        this.emit('transport_close', message); break;
 *
 * 2. websocket-client.ts handleMessage(): add the 0xFD binary demux right after
 *    the 0xFE port-forward block (same [marker][8-byte hash][payload] shape):
 *
 *      if (buffer.length >= 9 && buffer[0] === 0xfd) {
 *        const channelHash = buffer.subarray(1, 9);
 *        const payload = buffer.subarray(9);
 *        this.emit('transport_relay_data', { channelHash, payload });
 *        return;
 *      }
 *
 * 3. hub-client/index.ts, after authentication (where portForwardHandler is
 *    wired), call initTransport with an adapter over wsClient:
 *
 *      import { initTransport } from '../transport';
 *      ...
 *      initTransport({
 *        ws: this.wsClient,            // WebSocketClient already has send/
 *                                      // sendBinary/isConnected/bufferedAmount/
 *                                      // on/off (EventEmitter)
 *        selfGatewayId: data.gatewayId,
 *        stunHost: <hub host from this.options.hubUrl>,  // e.g. new URL(hubUrl).hostname
 *        stunPort: 8087,
 *      });
 *
 *    WebSocketClient already satisfies TransportWsSender: it extends
 *    EventEmitter (on/off) and exposes send(), sendBinary(hash,payload,marker),
 *    isConnected(), bufferedAmount(). The ONLY new code is the six event
 *    forwards + the 0xFD demux in step 1-2, plus this one initTransport call.
 *
 * 4. On disconnect, transport channels relying on the relay die with the WS
 *    (relay.ts tears down on transport_close / send failure). Direct channels
 *    keep their own udp socket but lose coordination; they self-heal via
 *    keepalive/idle-timeout. No extra teardown wiring is strictly required, but
 *    you MAY call a transport cleanup if you add channel tracking later.
 * ============================================================================
 */
