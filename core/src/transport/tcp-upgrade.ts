/**
 * Direct-TCP-for-LAN over the Core API port via an HTTP `Upgrade` handshake.
 *
 * Rather than binding a dedicated listener port, a same-LAN peer opens a normal
 * TCP connection to this node's Core API port (already bound 0.0.0.0 and
 * LAN-reachable) and sends an `Upgrade: lm-tcp/1` request. The Core HTTP server
 * routes it here from its 'upgrade' event; we validate the peer, reply `101
 * Switching Protocols`, and hijack the raw socket into a TcpChannel — from there
 * the stream is byte-identical to the raw path (kernel TCP, ~100-225 MB/s). One
 * port, nothing extra to open. The 101 costs one LAN round-trip at setup
 * (~0.2 ms); steady-state throughput is unchanged.
 */
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import { TcpChannel } from './tcp-channel';

export const TCP_UPGRADE_PROTOCOL = 'lm-tcp/1';
/** Path the sender requests (informational — routing is by the Upgrade header). */
export const TCP_UPGRADE_PATH = '/transport/tcp';

export interface TcpUpgradeDeps {
  /** True if `node` is a currently-online peer we accept a channel from. */
  isKnownPeer: (node: string) => Promise<boolean> | boolean;
  /** Called with each authenticated inbound channel + the peer's gatewayId. */
  onChannel: (channel: TcpChannel, peerNode: string) => void;
}

let deps: TcpUpgradeDeps | null = null;

/** Register the receiver wiring. The HubClient calls this once fabric is up; it
 *  is what makes the Core port answer lm-tcp upgrades (null ⇒ we reject them). */
export function setTcpUpgradeDeps(d: TcpUpgradeDeps | null): void {
  deps = d;
}

/** True if this HTTP upgrade is ours, so rest-server routes it here. */
export function isTcpUpgrade(req: IncomingMessage): boolean {
  return String(req.headers['upgrade'] || '').toLowerCase() === TCP_UPGRADE_PROTOCOL;
}

/**
 * Service an lm-tcp Upgrade: validate the peer, send 101, hijack the socket.
 * `head` is any bytes the HTTP parser already read past the request (normally
 * empty — the sender waits for 101 before it streams). Best-effort: an unwired
 * or rejected upgrade just closes the socket.
 */
export function handleTcpUpgrade(req: IncomingMessage, rawSocket: Duplex, head: Buffer): void {
  const socket = rawSocket as Socket; // an upgraded HTTP connection is a net.Socket at runtime
  const node = String(req.headers['x-lm-node'] || '');
  if (!deps || !node) { try { socket.destroy(); } catch { /* ignore */ } return; }
  const d = deps;
  socket.setNoDelay(true);

  // Validate first (async), THEN switch protocols. The peer streams only after it
  // sees 101, so no inbound bytes arrive during the check; `head` (and anything a
  // pipelining peer did send) is handed to the channel as initialData, and the
  // channel resumes the socket to drain whatever the OS buffered.
  Promise.resolve(d.isKnownPeer(node)).then((ok) => {
    if (!ok) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    try {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: lm-tcp/1\r\nConnection: Upgrade\r\n\r\n');
    } catch { try { socket.destroy(); } catch { /* ignore */ } return; }
    const channel = new TcpChannel(socket, node, head && head.length ? { initialData: head } : {});
    d.onChannel(channel, node);
  }).catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
}
