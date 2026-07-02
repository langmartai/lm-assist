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
import { encodeTcpHello } from './tcp-listener';

const TCP_CONNECT_TIMEOUT_MS = 1500;

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

/** Try a direct TCP connection to the peer's advertised endpoint. Resolves a
 *  ready TcpChannel (hello already sent) or null on any failure/timeout. */
function tryTcp(peer: string, ep: { host: string; port: number }): Promise<TcpChannel | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ch: TcpChannel | null) => { if (!settled) { settled = true; resolve(ch); } };
    const socket = net.connect({ host: ep.host, port: ep.port });
    const timer = setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } done(null); }, TCP_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      try {
        socket.setNoDelay(true);
        socket.write(encodeTcpHello(selfNode())); // identify ourselves first
      } catch { try { socket.destroy(); } catch { /* ignore */ } done(null); return; }
      done(new TcpChannel(socket, peer));
    });
    socket.once('error', () => { clearTimeout(timer); done(null); });
  });
}

/**
 * Open the best available channel to `peer` for bulk transfer.
 * `forceMode:'relay'` (or 'direct') skips TCP and goes straight to the hybrid
 * channel, preserving today's behavior for those explicit modes.
 */
export async function openBestChannel(peer: string, opts?: OpenChannelOpts): Promise<Channel> {
  // TCP-for-LAN is gated OFF by default (LM_FABRIC_TCP=1 to enable). The path
  // works end-to-end on loopback (verified to 100MB) but a cross-machine
  // Linux→Windows transfer currently fails the TCP attempt and falls back to
  // relay — until that is root-caused, enabling it by default would only add a
  // failed-connect + attempt latency before the relay fallback. Flip the flag
  // on the nodes under test to debug; the fabric endpoint advertisement +
  // listener stay live so `/fabric/status` shows peerTcp regardless.
  if (process.env.LM_FABRIC_TCP === '1' && !opts?.forceMode) {
    const ep = peerTcpEndpoint(peer);
    if (ep) {
      const tcp = await tryTcp(peer, ep);
      if (tcp) return tcp;
      // else: endpoint stale / listener down / blocked — fall through to hybrid.
    }
  }
  return openChannel(peer, opts);
}
