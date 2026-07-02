/**
 * Fabric wire protocol — W1 carries only link-setup control frames.
 *
 * Wire format is IDENTICAL to file-transfer's (frame.ts): [4B len][0x00][json],
 * so one FrameReader parses any subsystem and the first-frame demux convention
 * from file-transfer/protocol.ts applies: the first control frame's `type`
 * names the subsystem ('lm-file-transfer/1' vs 'lm-fabric/1').
 */
import { KIND_CONTROL } from '../file-transfer/frame';

export const FABRIC_TAG = 'lm-fabric/1' as const;
export const FABRIC_VERSION = 1 as const;

export interface FabricTcpEndpoint {
  host: string;
  port: number;
}

export interface FabricHello {
  type: typeof FABRIC_TAG;
  kind: 'hello' | 'hello-ack';
  version: number;
  features: string[];
  node: string; // sender's gatewayId
  /** The sender's direct-TCP endpoint (LAN host IP + port), if it runs a TCP
   *  listener. Lets a same-LAN peer open a kernel-TCP channel for bulk instead
   *  of the UDP path. Optional + additive — a W1 peer omits it. */
  tcp?: FabricTcpEndpoint;
}

export type FabricControl = FabricHello;

/** Encode a fabric control message as a length-prefixed control frame. */
export function encodeFabricControl(msg: FabricControl): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const payload = Buffer.allocUnsafe(1 + json.length);
  payload[0] = KIND_CONTROL;
  json.copy(payload, 1);
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length >>> 0, 0);
  payload.copy(out, 4);
  return out;
}

/** Parse an already-decoded control-frame body into a FabricHello, or null. */
export function parseFabricControl(msg: unknown): FabricHello | null {
  const m = msg as Record<string, unknown> | null;
  if (!m || m.type !== FABRIC_TAG) return null;
  if (m.kind !== 'hello' && m.kind !== 'hello-ack') return null;
  const out: FabricHello = {
    type: FABRIC_TAG,
    kind: m.kind,
    version: typeof m.version === 'number' ? m.version : 0,
    features: Array.isArray(m.features) ? (m.features as string[]) : [],
    node: typeof m.node === 'string' ? m.node : '',
  };
  const tcp = m.tcp as Record<string, unknown> | undefined;
  if (tcp && typeof tcp.host === 'string' && typeof tcp.port === 'number') {
    out.tcp = { host: tcp.host, port: tcp.port };
  }
  return out;
}
