/**
 * Direct port-forward streams over the Core API port via an HTTP `Upgrade`
 * handshake (`lm-portfwd/1`) — the port-forward sibling of tcp-upgrade.ts.
 *
 * Today a port-forward tunnels every byte listener→hub→target over the gateway
 * WebSocket (see hub-client/port-forward-handler.ts). For two same-LAN nodes
 * that hair-pins through the hub for no reason. This module lets the LISTENER
 * open a direct kernel-TCP connection to the TARGET's Core port (already bound
 * 0.0.0.0, LAN-reachable) and, per forwarded stream, hand it straight to the
 * target's local service:
 *
 *   listener → (Upgrade: lm-portfwd/1, x-lm-target-port: N) → target Core
 *   target Core dials 127.0.0.1:N, replies 101, raw-pipes the socket ↔ service
 *
 * The result is one direct TCP socket per forwarded stream at native speed, with
 * the hub out of the data path. When no direct endpoint is known (non-fabric /
 * cross-subnet peer) or the connect fails, the caller falls straight back to the
 * hub-WS relay, so nothing regresses.
 *
 * TRUST: the target accepts the upgrade iff BOTH (a) `x-lm-node` is a currently-
 * online node in this owner's fleet (isKnownPeer — the same roster the lm-tcp/1
 * transfer receiver and the hub-relayed forward use; the hub only ever bridges
 * same-owner nodes), AND (b) the connection's source IP matches the address that
 * `node` advertised over the fabric HELLO (peerHost). (b) binds the self-claimed
 * gatewayId to its fabric-known network location: a LAN attacker who merely knows
 * a valid gatewayId can't impersonate a peer without also originating from that
 * peer's exact address (spoofing an established-TCP source is impractical), and an
 * unknown/mismatched endpoint is rejected (→ the listener falls back to relay).
 * This is strictly stronger than the roster-only lm-tcp/1 receiver, which should
 * get the same source-address binding as a follow-up.
 *
 * The arbitrary `x-lm-target-port` (any localhost port) is intentional — that IS
 * port-forwarding (parity with the hub-relayed path and SSH -L). It is safe
 * because the caller is authenticated to be a same-owner fabric peer, who can
 * already reach their own fleet's services; the port is not an SSRF vector once
 * the caller identity above is enforced.
 */
import type { IncomingMessage } from 'http';
import * as net from 'net';
import type { Socket } from 'net';
import type { Duplex } from 'stream';

export const PORTFWD_UPGRADE_PROTOCOL = 'lm-portfwd/1';
/** Path the listener requests (informational — routing is by the Upgrade header). */
export const PORTFWD_UPGRADE_PATH = '/transport/portfwd';

/** Listener-side: give up the direct attempt after this and fall back to relay. */
const CONNECT_TIMEOUT_MS = 1500;
/** Target-side: fail the upgrade if the local service doesn't answer in time. */
const TARGET_DIAL_TIMEOUT_MS = 10_000;
/** A 101 response is tiny; more than this before the header terminator is bogus. */
const UPGRADE_HEAD_MAX = 4096;

export interface PortfwdUpgradeDeps {
  /** True if `node` is a currently-online peer we accept a forward from. */
  isKnownPeer: (node: string) => Promise<boolean> | boolean;
  /** The host `node` advertised over the fabric HELLO (getPeerTcpEndpoint().host),
   *  or null if unknown. The upgrade's source IP must match this — see TRUST. */
  peerHost: (node: string) => string | null;
}

let deps: PortfwdUpgradeDeps | null = null;

/** Normalize an IP for comparison: strip an IPv4-mapped-IPv6 prefix, lowercase. */
function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let s = String(ip).trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s || null;
}

/** Register the receiver wiring. HubClient calls this once fabric is up; null ⇒
 *  we reject lm-portfwd upgrades (and the peer falls back to hub relay). */
export function setPortfwdUpgradeDeps(d: PortfwdUpgradeDeps | null): void {
  deps = d;
}

/** True if this HTTP upgrade is ours, so rest-server routes it here. */
export function isPortfwdUpgrade(req: IncomingMessage): boolean {
  return String(req.headers['upgrade'] || '').toLowerCase() === PORTFWD_UPGRADE_PROTOCOL;
}

/**
 * TARGET side: validate the peer, dial 127.0.0.1:<x-lm-target-port>, and on
 * connect send 101 and raw-pipe the upgraded socket ↔ the local service. Any
 * failure closes the socket (listener then falls back to relay). Best-effort.
 */
export function handlePortfwdUpgrade(req: IncomingMessage, rawSocket: Duplex, head: Buffer): void {
  const socket = rawSocket as Socket; // an upgraded HTTP connection is a net.Socket at runtime
  const node = String(req.headers['x-lm-node'] || '');
  const targetPort = parseInt(String(req.headers['x-lm-target-port'] || ''), 10);
  if (!deps || !node || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    try { socket.destroy(); } catch { /* ignore */ }
    return;
  }
  const d = deps;
  socket.setNoDelay(true);

  Promise.resolve(d.isKnownPeer(node)).then((ok) => {
    if (!ok) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // Bind the self-claimed gatewayId to its fabric-published address: the source
    // IP must match the host `node` advertised over the HELLO. Unknown or
    // mismatched ⇒ reject (the listener falls back to relay). See TRUST above.
    const expectedIp = normalizeIp(d.peerHost(node));
    const sourceIp = normalizeIp(socket.remoteAddress);
    if (!expectedIp || !sourceIp || expectedIp !== sourceIp) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // allowHalfOpen: keep reading the service's response after the peer FINs.
    const local = net.connect({ port: targetPort, host: '127.0.0.1', allowHalfOpen: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      try { local.destroy(); } catch { /* ignore */ }
    }, TARGET_DIAL_TIMEOUT_MS);

    local.once('connect', () => {
      if (settled) { try { local.destroy(); } catch { /* ignore */ } return; }
      settled = true;
      clearTimeout(timer);
      local.setNoDelay(true);
      try {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: lm-portfwd/1\r\nConnection: Upgrade\r\n\r\n');
      } catch {
        try { socket.destroy(); } catch { /* ignore */ }
        try { local.destroy(); } catch { /* ignore */ }
        return;
      }
      // A well-behaved listener sends nothing before 101, so head is normally
      // empty; forward it anyway so a pipelining peer isn't truncated.
      if (head && head.length) { try { local.write(head); } catch { /* ignore */ } }
      pipePair(socket, local);
    });

    local.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    });
  }).catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
}

/** Symmetric raw byte-pipe with half-close propagation + backpressure. */
function pipePair(a: Socket, b: Socket): void {
  a.on('data', (c: Buffer) => { if (!b.write(c)) a.pause(); });
  b.on('drain', () => a.resume());
  b.on('data', (c: Buffer) => { if (!a.write(c)) b.pause(); });
  a.on('drain', () => b.resume());
  a.on('end', () => { try { b.end(); } catch { /* ignore */ } });
  b.on('end', () => { try { a.end(); } catch { /* ignore */ } });
  const shut = () => { try { a.destroy(); } catch { /* ignore */ } try { b.destroy(); } catch { /* ignore */ } };
  a.on('error', shut); b.on('error', shut);
  a.on('close', shut); b.on('close', shut);
}

/**
 * LISTENER side: open a direct lm-portfwd channel to `ep` for a forwarded stream
 * to `targetPort`. Resolves the ready raw socket (plus any bytes the target
 * service sent before we wired piping — e.g. an SSH/SMTP greeting) once the
 * target answers 101, or null on any failure/timeout/rejection (→ relay fallback).
 */
export function openPortfwdChannel(
  ep: { host: string; port: number },
  selfNode: string,
  targetPort: number,
): Promise<{ socket: Socket; leftover: Buffer } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host: ep.host, port: ep.port });
    const timer = setTimeout(() => { fail(); }, CONNECT_TIMEOUT_MS);
    let buf: Buffer = Buffer.alloc(0);

    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onErr); };
    const done = (v: { socket: Socket; leftover: Buffer } | null) => {
      if (!settled) { settled = true; cleanup(); resolve(v); }
    };
    const fail = () => { try { socket.destroy(); } catch { /* ignore */ } done(null); };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > UPGRADE_HEAD_MAX) fail(); return; } // headers incomplete
      const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      if (!/\s101\s/.test(statusLine)) { fail(); return; } // not "HTTP/1.1 101 ..."
      const leftover = buf.subarray(end + 4); // target-service bytes that arrived with the 101
      done({ socket, leftover: Buffer.from(leftover) });
    };
    const onErr = () => { fail(); };

    socket.once('connect', () => {
      try {
        socket.setNoDelay(true);
        socket.write(
          `GET ${PORTFWD_UPGRADE_PATH} HTTP/1.1\r\nHost: ${ep.host}\r\n` +
          `Upgrade: ${PORTFWD_UPGRADE_PROTOCOL}\r\nConnection: Upgrade\r\n` +
          `x-lm-node: ${selfNode}\r\nx-lm-target-port: ${targetPort}\r\n\r\n`,
        );
      } catch { fail(); }
    });
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}
