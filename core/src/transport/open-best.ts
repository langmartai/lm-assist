/**
 * openBestChannel (transport-perf plan, PHASE D / D3).
 *
 * Channel selection for bulk: prefer a direct kernel-TCP channel to a same-LAN
 * peer (native speed, ~100 MB/s) over the UDP hybrid channel (~9 MB/s userspace
 * ceiling). Falls back cleanly:
 *   TCP (peer advertises a reachable endpoint) → hybrid UDP/relay (openChannel)
 *
 * The peer's TCP endpoint is learned over the warm fabric link's HELLO
 * (fabric.getPeerTcpEndpoint); a W1 peer / non-fabric peer / relay-forced call
 * simply gets the hybrid channel, so nothing regresses.
 */
import * as net from 'net';
import { openChannel, type Channel, type OpenChannelOpts } from './index';
import { TcpChannel } from './tcp-channel';
import { TCP_UPGRADE_PROTOCOL, TCP_UPGRADE_PATH } from './tcp-upgrade';

const TCP_CONNECT_TIMEOUT_MS = 1500;
const UPGRADE_HEAD_MAX = 4096; // a 101 response is tiny; anything larger is bogus

function selfNode(): string {
  const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
  return getHubConfig().gatewayId ?? 'unknown';
}

function peerTcpEndpoint(peer: string): { host: string; port: number } | null {
  try {
    const { getPeerTcpEndpoint } = require('../fabric') as typeof import('../fabric');
    return getPeerTcpEndpoint(peer);
  } catch {
    return null;
  }
}

/** Open a direct TCP channel to the peer's advertised endpoint (its Core API
 *  port) via an HTTP `Upgrade: lm-tcp/1` handshake. Resolves a ready TcpChannel
 *  once the peer answers `101`, or null on any failure/timeout/rejection. */
function tryTcp(peer: string, ep: { host: string; port: number }): Promise<TcpChannel | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host: ep.host, port: ep.port });
    const timer = setTimeout(() => { fail(); }, TCP_CONNECT_TIMEOUT_MS);
    let buf: Buffer = Buffer.alloc(0);

    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onErr); };
    const done = (ch: TcpChannel | null) => { if (!settled) { settled = true; cleanup(); resolve(ch); } };
    const fail = () => { try { socket.destroy(); } catch { /* ignore */ } done(null); };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > UPGRADE_HEAD_MAX) fail(); return; } // headers not complete yet
      const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      if (!/\s101\s/.test(statusLine)) { fail(); return; } // not "HTTP/1.1 101 ..."
      const leftover = buf.subarray(end + 4); // bytes past the response (normally none)
      done(new TcpChannel(socket, peer, leftover.length ? { initialData: leftover } : {}));
    };
    const onErr = () => { fail(); };

    socket.once('connect', () => {
      try {
        socket.setNoDelay(true);
        socket.write(
          `GET ${TCP_UPGRADE_PATH} HTTP/1.1\r\nHost: ${ep.host}\r\n` +
          `Upgrade: ${TCP_UPGRADE_PROTOCOL}\r\nConnection: Upgrade\r\n` +
          `x-lm-node: ${selfNode()}\r\n\r\n`,
        );
      } catch { fail(); }
    });
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

/**
 * Open the best available channel to `peer` for bulk transfer.
 * `forceMode:'relay'` (or 'direct') skips TCP and goes straight to the hybrid
 * channel, preserving today's behavior for those explicit modes.
 */
export async function openBestChannel(peer: string, opts?: OpenChannelOpts): Promise<Channel> {
  // Direct kernel-TCP for same-LAN peers: validated byte-perfect cross-machine
  // at 225 MB/s (Linux↔Linux) and 93 MB/s (Linux↔Windows), ~40× the relay.
  // On by default; set LM_FABRIC_TCP=0 to force the hybrid/relay path. We only
  // attempt TCP when the peer advertised a reachable endpoint over the fabric
  // HELLO; otherwise (W1/non-fabric peers, forceMode) we fall straight through
  // to openChannel, and a failed/blocked connect times out (1.5s) and falls back
  // too — so nothing regresses when the direct path is unavailable.
  if (process.env.LM_FABRIC_TCP !== '0' && !opts?.forceMode) {
    const ep = peerTcpEndpoint(peer);
    if (ep) {
      const tcp = await tryTcp(peer, ep);
      if (tcp) return tcp;
      // else: endpoint stale / listener down / blocked — fall through to hybrid.
    }
  }
  return openChannel(peer, opts);
}
