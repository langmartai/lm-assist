/**
 * Relay fallback path for the transport driver (relay mode).
 *
 * Mirrors hub-client/port-forward-handler.ts but for the transport channel:
 *   - binary marker 0xFD (port-forward uses 0xFE, console 0xFF).
 *   - frame: [0xFD][8-byte md5(channelId)[0:8]][payload] — the hub routes
 *     peer<->peer exactly like the 0xFE port-forward frames.
 *   - control: transport_relay_open {channelId, peerGatewayId} (initiator),
 *     transport_relay_ready {channelId} (both directions establish the stream).
 *
 * The relay path is already reliable (WS over TCP), so the Channel's send() can
 * push raw payloads straight through — no ReliableConnection needed. We still
 * apply WS backpressure (pause sends while the buffer is high) mirroring the
 * port-forward handler.
 */

import * as crypto from 'crypto';
import type { TransportWsSender } from './ws-deps';

/** Binary frame marker for transport relay data. */
export const TRANSPORT_RELAY_MARKER = 0xfd;

/** Pause sends while the WS send buffer exceeds this many bytes. */
const WS_BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024; // 8 MB
const WS_BACKPRESSURE_POLL_MS = 50;
/** Initiator: fail if the hub never replies transport_relay_ready. */
const RELAY_READY_TIMEOUT_MS = 15_000;

function hashChannelId(channelId: string): Buffer {
  return crypto.createHash('md5').update(channelId).digest().subarray(0, 8);
}

export interface RelayChannelOptions {
  channelId: string;
  peerGatewayId: string;
  /** True if THIS node initiates (sends transport_relay_open). */
  initiator: boolean;
  ws: TransportWsSender;
}

export interface RelayChannel {
  /** Send a raw payload to the peer over the relay (already reliable/ordered). */
  send(data: Buffer): void;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(reason?: string): void;
}

/**
 * Open a relay channel and resolve once it's ready:
 *   - initiator: send transport_relay_open, wait for transport_relay_ready.
 *   - answerer:  send transport_relay_ready (the stream is symmetric), resolve.
 *
 * Returns a RelayChannel that frames sends as [0xFD][hash][payload] and demuxes
 * inbound 0xFD frames matching this channel's hash.
 */
export function openRelayChannel(opts: RelayChannelOptions): Promise<RelayChannel> {
  const hash = hashChannelId(opts.channelId);
  const hashHex = hash.toString('hex');

  return new Promise<RelayChannel>((resolve, reject) => {
    let ready = false;
    let closed = false;
    let dataCb: ((data: Buffer) => void) | null = null;
    let closeCb: ((reason?: string) => void) | null = null;
    const pendingBeforeReady: Buffer[] = [];

    let readyTimer: NodeJS.Timeout | null = null;

    // Inbound 0xFD frame demux — the integrator forwards these as a
    // 'transport_relay_data' event carrying {channelHash, payload}.
    const onRelayData = (msg: { channelHash: Buffer; payload: Buffer }) => {
      if (!msg || !msg.channelHash) return;
      if (msg.channelHash.toString('hex') !== hashHex) return;
      if (closed) return;
      if (dataCb) dataCb(msg.payload);
    };

    const onRelayReady = (msg: { channelId: string }) => {
      if (msg.channelId !== opts.channelId) return;
      if (ready) return;
      ready = true;
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      // Flush anything queued before the stream was ready.
      for (const p of pendingBeforeReady) sendFrame(p);
      pendingBeforeReady.length = 0;
      resolve(channel);
    };

    const onRelayClose = (msg: { channelId: string; reason?: string }) => {
      if (msg.channelId !== opts.channelId) return;
      teardown(msg.reason || 'peer closed', false);
    };

    opts.ws.on('transport_relay_data', onRelayData as (...a: unknown[]) => void);
    opts.ws.on('transport_relay_ready', onRelayReady as (...a: unknown[]) => void);
    opts.ws.on('transport_close', onRelayClose as (...a: unknown[]) => void);

    const detach = () => {
      opts.ws.off('transport_relay_data', onRelayData as (...a: unknown[]) => void);
      opts.ws.off('transport_relay_ready', onRelayReady as (...a: unknown[]) => void);
      opts.ws.off('transport_close', onRelayClose as (...a: unknown[]) => void);
    };

    const sendFrame = (payload: Buffer) => {
      if (closed || !opts.ws.isConnected()) return;
      // Backpressure: defer the send while the WS buffer is high.
      if (opts.ws.bufferedAmount() > WS_BACKPRESSURE_HIGH_WATER) {
        const retry = () => {
          if (closed) return;
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

    const teardown = (reason: string | undefined, notifyPeer: boolean) => {
      if (closed) return;
      closed = true;
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      detach();
      if (notifyPeer && opts.ws.isConnected()) {
        opts.ws.send({ type: 'transport_close', channelId: opts.channelId, reason });
      }
      if (closeCb) {
        try { closeCb(reason); } catch { /* ignore */ }
      }
    };

    const channel: RelayChannel = {
      send: (data: Buffer) => {
        if (closed) return;
        // The hub relay caps a single frame; the port-forward path streams
        // arbitrary chunk sizes, so we pass payloads through as-is.
        if (!ready) { pendingBeforeReady.push(data); return; }
        sendFrame(data);
      },
      onData: (cb) => { dataCb = cb; },
      onClose: (cb) => { closeCb = cb; },
      close: (reason?: string) => teardown(reason, true),
    };

    if (opts.initiator) {
      opts.ws.send({
        type: 'transport_relay_open',
        channelId: opts.channelId,
        peerGatewayId: opts.peerGatewayId,
      });
      readyTimer = setTimeout(() => {
        if (!ready) {
          teardown('relay ready timeout', false);
          reject(new Error('relay ready timeout'));
        }
      }, RELAY_READY_TIMEOUT_MS);
      readyTimer.unref?.();
    } else {
      // Answerer: the stream is symmetric — confirm ready immediately.
      opts.ws.send({ type: 'transport_relay_ready', channelId: opts.channelId });
      ready = true;
      resolve(channel);
    }
  });
}
