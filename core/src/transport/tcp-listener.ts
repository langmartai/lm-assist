/**
 * Direct-TCP listener (transport-perf plan, PHASE D / D2).
 *
 * Binds a TCP server so a same-LAN peer can open a kernel-TCP `TcpChannel` for
 * bulk transfer instead of the UDP path (which caps at ~9 MB/s in userspace).
 * Each accepted connection begins with ONE length-prefixed hello frame
 * `{ t:'lm-tcp/1', node:<connector gatewayId> }`; the listener validates the
 * node is a currently-online peer, then wraps the socket in a TcpChannel
 * (feeding any bytes that arrived after the hello) and hands it to `onChannel`.
 *
 * Trust: same bar as the existing UDP/host-direct path — the LAN is trusted
 * (see the fabric spec's LAN-direct decision). The hello identifies the peer;
 * we bind on the LAN and only accept a known online gatewayId. A cryptographic
 * token over the relay control plane is a follow-up hardening, tracked with the
 * transport AEAD item.
 */
import * as net from 'net';
import { TcpChannel } from './tcp-channel';

export const TCP_HELLO_TAG = 'lm-tcp/1';
/** Default fabric TCP port. Overridable via LM_FABRIC_TCP_PORT. Chosen away from
 *  the API (3100/3200), web (3848/3948), and elevated worker (3110). */
export const DEFAULT_TCP_PORT = 3130;
const HELLO_TIMEOUT_MS = 5000;
const HELLO_MAX_BYTES = 4096; // a hello is tiny; anything larger is bogus

export interface TcpHello {
  t: typeof TCP_HELLO_TAG;
  node: string;
}

export interface TcpListenerDeps {
  /** True if `node` is a currently-online peer we accept a TCP channel from. */
  isKnownPeer: (node: string) => Promise<boolean> | boolean;
  /** Called with each authenticated inbound channel + the peer's gatewayId. */
  onChannel: (channel: TcpChannel, peerNode: string) => void;
  bindHost?: string; // default 0.0.0.0 (LAN-reachable)
  port?: number; // default DEFAULT_TCP_PORT (0 = ephemeral)
  /** Fired once bound with the actual listening port (address assigned). */
  onListening?: (port: number) => void;
}

export interface TcpListenerHandle {
  endpoint(): { host: string; port: number } | null;
  close(): void;
}

/** Read exactly one length-prefixed hello frame off a raw socket, returning the
 *  parsed hello plus any trailing bytes already read past it. */
function readHello(socket: net.Socket): Promise<{ hello: TcpHello; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('hello timeout')); }, HELLO_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      if (buf.length > HELLO_MAX_BYTES + 4) { cleanup(); reject(new Error('hello too large')); return; }
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > HELLO_MAX_BYTES) { cleanup(); reject(new Error('hello frame too large')); return; }
      if (buf.length < 4 + len) return;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      const leftover = buf.subarray(4 + len);
      cleanup();
      try {
        const hello = JSON.parse(json) as TcpHello;
        if (hello?.t !== TCP_HELLO_TAG || typeof hello.node !== 'string' || !hello.node) {
          reject(new Error('bad hello')); return;
        }
        resolve({ hello, leftover });
      } catch (e) { reject(e as Error); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error('socket ended before hello')); };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onErr); socket.off('end', onEnd);
    }
    socket.on('data', onData); socket.on('error', onErr); socket.on('end', onEnd);
  });
}

/** Encode the hello frame the connector sends first (see open-best.ts). */
export function encodeTcpHello(node: string): Buffer {
  const json = Buffer.from(JSON.stringify({ t: TCP_HELLO_TAG, node } satisfies TcpHello), 'utf8');
  const out = Buffer.allocUnsafe(4 + json.length);
  out.writeUInt32BE(json.length >>> 0, 0);
  json.copy(out, 4);
  return out;
}

export function startTcpListener(deps: TcpListenerDeps): TcpListenerHandle {
  const bindHost = deps.bindHost ?? '0.0.0.0';
  const port = deps.port ?? DEFAULT_TCP_PORT;
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    readHello(socket)
      .then(async ({ hello, leftover }) => {
        const ok = await deps.isKnownPeer(hello.node);
        if (!ok) { try { socket.destroy(); } catch { /* ignore */ } return; }
        const channel = new TcpChannel(socket, hello.node, { initialData: leftover });
        deps.onChannel(channel, hello.node);
      })
      .catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
  });
  server.on('error', (e) => { console.debug('[tcp-listener] server error:', (e as Error).message); });
  server.listen(port, bindHost, () => {
    const a = server.address();
    if (a && typeof a === 'object' && deps.onListening) deps.onListening(a.port);
  });
  return {
    endpoint() {
      const a = server.address();
      if (a && typeof a === 'object') return { host: bindHost, port: a.port };
      return null;
    },
    close() { try { server.close(); } catch { /* ignore */ } },
  };
}
