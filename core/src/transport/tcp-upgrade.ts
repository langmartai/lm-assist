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
 *
 * TRUST: the upgrade runs outside the api-token gate, and the channel it opens is
 * a file-transfer receiver (writes to absolute paths, FT_FS reads). So the peer
 * must be BOTH (a) a currently-online node of this owner's fleet (isKnownPeer) AND
 * (b) connecting from the address that node advertised over the fabric HELLO
 * (peerHost) — the same binding lm-portfwd/1 has. A gatewayId is an identifier,
 * not a secret (list_nodes, logs, the UI show it), so (a) alone let any LAN host
 * that knew one online id read and write files as the Core user. Unknown or
 * mismatched source ⇒ 403, and the sender falls back to the hybrid/relay channel
 * (open-best.ts), so a legitimate transfer never fails on it.
 */
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import { TcpChannel } from './tcp-channel';
import { normalizeIp } from './portfwd-upgrade';

export const TCP_UPGRADE_PROTOCOL = 'lm-tcp/1';
/** Path the sender requests (informational — routing is by the Upgrade header). */
export const TCP_UPGRADE_PATH = '/transport/tcp';

export interface TcpUpgradeDeps {
  /** True if `node` is a currently-online peer we accept a channel from. */
  isKnownPeer: (node: string) => Promise<boolean> | boolean;
  /** The host `node` advertised over the fabric HELLO (getPeerTcpEndpoint().host),
   *  or null if unknown. The upgrade's source IP must match it — see TRUST. */
  peerHost: (node: string) => string | null;
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
  const refuse = () => {
    try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
    try { socket.destroy(); } catch { /* ignore */ }
  };
  Promise.resolve(d.isKnownPeer(node)).then((ok) => {
    if (!ok) { refuse(); return; }
    // Bind the self-claimed gatewayId to its fabric-published address (see TRUST).
    let expectedIp: string | null = null;
    try { expectedIp = normalizeIp(d.peerHost(node)); } catch { expectedIp = null; }
    const sourceIp = normalizeIp(socket.remoteAddress);
    if (!expectedIp || !sourceIp || expectedIp !== sourceIp) { refuse(); return; }
    try {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: lm-tcp/1\r\nConnection: Upgrade\r\n\r\n');
    } catch { try { socket.destroy(); } catch { /* ignore */ } return; }
    const channel = new TcpChannel(socket, node, head && head.length ? { initialData: head } : {});
    d.onChannel(channel, node);
  }).catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
}
