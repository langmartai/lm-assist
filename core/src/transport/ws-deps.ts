/**
 * Minimal view of the hub WebSocket + node identity that the transport driver
 * needs. Defined here (not imported from hub-client) so the driver is decoupled
 * and unit-testable: a test can supply a fake TransportWsSender.
 *
 * The real wiring (see initTransport in index.ts) adapts the hub-client's
 * WebSocketClient / HubClient to this interface and forwards the relevant
 * events. The integrator note in index.ts spells out exactly what to add to
 * hub-client/index.ts.
 */

import type { EventEmitter } from 'events';

export interface UdpEndpoint {
  ip: string;
  port: number;
}

/**
 * What the transport driver consumes from the hub connection.
 * - send(json): JSON control message to the hub (relayed to the peer).
 * - sendBinary(hash8, payload, 0xFD): relay-data frame to the peer.
 * - on/off(event, cb): subscribe to relayed control messages + 0xFD demux.
 * - isConnected(): hub link live.
 * - bufferedAmount(): WS send-buffer depth (for relay backpressure).
 */
export interface TransportWsSender {
  send(obj: unknown): void;
  sendBinary(idHash: Buffer, payload: Buffer, marker?: number): void;
  isConnected(): boolean;
  bufferedAmount(): number;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
}

/**
 * An EventEmitter-backed adapter satisfies TransportWsSender for `on`/`off`.
 * This is the shape WebSocketClient already has (it extends EventEmitter), so
 * the integrator only needs to add `send`/`sendBinary`/`isConnected`/
 * `bufferedAmount` passthroughs (which WebSocketClient also already has) plus
 * forward the new transport_* events.
 */
export type TransportWsLike = TransportWsSender & Pick<EventEmitter, 'on' | 'off'>;

/** Dependencies injected into the transport driver at init time. */
export interface TransportDeps {
  /** The hub WS sender (adapted WebSocketClient/HubClient). */
  ws: TransportWsSender;
  /** This node's gatewayId (from HubClient.getGatewayId()). */
  selfGatewayId: string;
  /** Hub host used for the UDP STUN responder (gateway host). */
  stunHost: string;
  /** STUN responder UDP port (default 8087). */
  stunPort?: number;
}
