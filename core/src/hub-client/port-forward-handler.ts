/**
 * Port Forward Handler
 *
 * Node-to-node TCP port forwarding multiplexed over the SAME outbound gateway
 * WebSocket that already carries api_relay + console relay. No second socket to
 * the hub is opened — this reuses the existing data plane (see hub-client/index.ts).
 *
 * Two roles, both implemented here (a worker can be either end of a forward):
 *
 *   LISTENER (the node that "creates a local port"):
 *     - opens a local net.Server on 127.0.0.1:localPort
 *     - per accepted TCP connection: allocates a streamId, asks the hub to wire
 *       it to {targetGatewayId, targetPort} via `forward_open`, then pipes the
 *       socket <-> WS once the hub replies `forward_ready`.
 *
 *   TARGET (the node that owns the real service):
 *     - on `forward_open` from the hub, dials 127.0.0.1:targetPort and pipes that
 *       socket <-> WS. Replies `forward_ready` / `forward_error`.
 *
 * Wire protocol (all over the gateway WS):
 *   control (JSON):
 *     listener -> hub : forward_open  { forwardId, streamId, targetGatewayId, targetPort }
 *     hub -> target   : forward_open  { streamId, srcGatewayId, targetPort }
 *     target -> hub   : forward_ready { streamId } | forward_error { streamId, error }
 *     hub -> listener : forward_ready { streamId } | forward_error { streamId, error }
 *     either -> hub   : forward_eof   { streamId }            (TCP half-close / FIN)
 *     either -> hub   : forward_close { streamId, reason? }   (full teardown)
 *   data (binary): [0xFE][8-byte md5(streamId)[0:8]][payload]
 *
 * The 0xFE marker namespaces these frames away from console relay's 0xFF frames
 * so the two byte-pipes never collide on the shared socket.
 */

import * as net from 'net';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** What's holding a local port, if anything (best-effort, Linux `ss`). */
export interface PortHolder {
  pid: number;        // 0 = unknown (e.g. owned by another user, no privilege to see)
  process: string;    // process name, or 'unknown'
  address: string;    // local listen address:port
}
export interface PortStatus {
  available: boolean;
  holder?: PortHolder;
}

/** Human-readable "port in use" message, naming the holding process when known. */
function describePortConflict(port: number, holder?: PortHolder): string {
  if (holder && holder.pid > 0) {
    return `localPort ${port} is already in use by pid ${holder.pid} (${holder.process})` +
      `${holder.address ? ` on ${holder.address}` : ''}`;
  }
  return `localPort ${port} is already in use (holder unknown — likely owned by another user/root)`;
}

/** Binary frame marker for port-forward data (console relay uses 0xFF). */
export const PORT_FORWARD_MARKER = 0xfe;

/** Pause the source socket while the WS send buffer is above this many bytes. */
const WS_BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024; // 8 MB
const WS_BACKPRESSURE_POLL_MS = 50;
/** Target-side: fail the stream if the local dial doesn't connect in time. */
const TARGET_CONNECT_TIMEOUT_MS = 10_000;
/** Listener-side: fail the stream if the hub never replies forward_ready. */
const LISTENER_READY_TIMEOUT_MS = 15_000;
/** Graceful close: force-destroy a socket if it hasn't finished draining by now. */
const CLOSE_LINGER_MS = 10_000;
/** How often an idle forward probes its target's reachability (for status). */
const HEALTH_PROBE_INTERVAL_MS = 30_000;

/** Minimal view of the gateway WebSocket this handler needs. */
export interface PortForwardSender {
  send(data: unknown): void;
  /** Send a binary frame; marker defaults to console (0xFF), we pass 0xFE. */
  sendBinary(idHash: Buffer, payload: Buffer, marker?: number): void;
  isConnected(): boolean;
  /** Bytes still queued in the WS send buffer (for backpressure). */
  bufferedAmount(): number;
}

/** Reachability of the target service a forward points at. */
export interface ForwardHealth {
  status: 'unknown' | 'up' | 'down';
  since: Date;          // when status last changed
  lastError?: string;   // last connect error when down
}

interface ForwardListener {
  forwardId: string;
  localPort: number;
  bindHost: string;
  targetGatewayId: string;
  targetPort: number;
  server: net.Server;
  createdAt: Date;
  /** Target-port reachability. The forward stays valid across target restarts;
   *  this just reflects whether the target service is currently reachable. */
  health: ForwardHealth;
  probeTimer?: NodeJS.Timeout;
  // --- traffic stats (same shape as transfer stats) ---
  bytesUp: number;    // accumulated from CLOSED streams; active streams summed live
  bytesDown: number;
  streamsTotal: number;
  sBytes: number;     // instant-rate sample baseline (total bytes)
  sAt: number;
  instantBps: number;
  rttMinMs: number;   // min forward_open→ready round-trip (ping/pong latency), ms; 0 = unmeasured
}

interface ForwardStream {
  streamId: string;
  streamHash: Buffer;
  role: 'listener' | 'target';
  socket: net.Socket;
  status: 'opening' | 'active' | 'closed';
  forwardId?: string;       // listener side only
  bytesUp: number;
  bytesDown: number;
  /** Pending connect-timeout (target) / ready-timeout (listener); cleared when active. */
  openTimer?: NodeJS.Timeout;
  openSentAt?: number; // listener: when forward_open was sent (for ping/pong RTT)
}

export class PortForwardHandler {
  private ws: PortForwardSender | null = null;
  private listeners: Map<string, ForwardListener> = new Map();
  private streams: Map<string, ForwardStream> = new Map();
  private streamByHash: Map<string, string> = new Map(); // hashHex -> streamId

  /** This node's own gatewayId, set once authenticated (used to reject self-forward). */
  private selfGatewayId: string | null = null;

  /** Cap on concurrently open local listeners on this node. */
  private static readonly MAX_FORWARDS = 64;

  private static hashStreamId(streamId: string): Buffer {
    return crypto.createHash('md5').update(streamId).digest().subarray(0, 8);
  }

  /**
   * Best-effort check of whether a local TCP port is free, and if not, who
   * holds it. Uses Linux `ss`; on other platforms / if `ss` is unavailable it
   * returns available:true and lets the bind attempt be the real arbiter.
   * pid is 0 / process 'unknown' when the holder is owned by another user
   * (no privilege to read it without root).
   */
  public static inspectLocalPort(port: number): Promise<PortStatus> {
    return new Promise((resolve) => {
      execFile('ss', ['-ltnpH', `sport = :${port}`], { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve({ available: true });
          return;
        }
        const line = stdout.trim().split('\n')[0];
        const cols = line.trim().split(/\s+/);
        const address = cols[3] || '';
        const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        resolve({
          available: false,
          holder: m
            ? { process: m[1], pid: parseInt(m[2], 10), address }
            : { process: 'unknown', pid: 0, address },
        });
      });
    });
  }

  public setWebSocket(ws: PortForwardSender): void {
    this.ws = ws;
  }

  public setSelfGatewayId(gatewayId: string | null): void {
    this.selfGatewayId = gatewayId;
  }

  // ==========================================================================
  // LISTENER SIDE — "create a local port that forwards to another node"
  // ==========================================================================

  /**
   * Open a local listening port that forwards every connection to
   * targetGatewayId's targetPort. Resolves once the listener is bound.
   */
  public async openForward(opts: {
    localPort: number;
    targetGatewayId: string;
    targetPort: number;
    bindHost?: string;
  }): Promise<{ forwardId: string; localPort: number; bindHost: string }> {
    const bindHost = opts.bindHost || '127.0.0.1';
    if (opts.targetGatewayId && opts.targetGatewayId === this.selfGatewayId) {
      throw new Error('Cannot forward to the same node (targetGatewayId is self)');
    }
    if (this.listeners.size >= PortForwardHandler.MAX_FORWARDS) {
      throw new Error(`Too many active port forwards on this node (max ${PortForwardHandler.MAX_FORWARDS})`);
    }

    // Source-port preflight: a non-ephemeral local port may already be taken by
    // another process. Surface the holder (pid/name) instead of a bare EADDRINUSE.
    if (opts.localPort > 0) {
      const st = await PortForwardHandler.inspectLocalPort(opts.localPort);
      if (!st.available) {
        throw new Error(describePortConflict(opts.localPort, st.holder));
      }
    }

    return new Promise((resolve, reject) => {
      const forwardId = crypto.randomUUID();
      // allowHalfOpen: keep the write side open after the client sends FIN so a
      // half-close (forward_eof) can propagate without tearing the stream down.
      const server = net.createServer({ allowHalfOpen: true }, (socket) => this.onListenerConnection(forwardId, socket));

      server.on('error', (err: NodeJS.ErrnoException) => {
        // Bind failures surface here before 'listening'
        if (!this.listeners.has(forwardId)) {
          // Lost a race (or privileged port): enrich EADDRINUSE with the holder.
          if (err.code === 'EADDRINUSE' && opts.localPort > 0) {
            PortForwardHandler.inspectLocalPort(opts.localPort)
              .then((st) => reject(new Error(describePortConflict(opts.localPort, st.holder))))
              .catch(() => reject(err));
          } else {
            reject(err);
          }
        } else {
          console.error(`[PortForward] Listener ${forwardId} error:`, err.message);
        }
      });

      server.listen(opts.localPort, bindHost, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : opts.localPort;
        const listener: ForwardListener = {
          forwardId,
          localPort: actualPort,
          bindHost,
          targetGatewayId: opts.targetGatewayId,
          targetPort: opts.targetPort,
          server,
          createdAt: new Date(),
          health: { status: 'unknown', since: new Date() },
          bytesUp: 0,
          bytesDown: 0,
          streamsTotal: 0,
          sBytes: 0,
          sAt: Date.now(),
          instantBps: 0,
          rttMinMs: 0,
        };
        this.listeners.set(forwardId, listener);
        // Periodically probe target reachability so status reflects the target
        // process going down / coming back even with no user traffic.
        listener.probeTimer = setInterval(() => this.probeForward(forwardId), HEALTH_PROBE_INTERVAL_MS);
        if (listener.probeTimer.unref) listener.probeTimer.unref();
        console.log(`[PortForward] Listening on ${bindHost}:${actualPort} -> ${opts.targetGatewayId}:${opts.targetPort} (forward=${forwardId})`);
        resolve({ forwardId, localPort: actualPort, bindHost });
      });
    });
  }

  private onListenerConnection(forwardId: string, socket: net.Socket): void {
    const listener = this.listeners.get(forwardId);
    if (!listener) {
      socket.destroy();
      return;
    }
    if (!this.ws || !this.ws.isConnected()) {
      socket.destroy();
      return;
    }

    const streamId = crypto.randomUUID();
    const streamHash = PortForwardHandler.hashStreamId(streamId);
    const stream: ForwardStream = {
      streamId,
      streamHash,
      role: 'listener',
      socket,
      status: 'opening',
      forwardId,
      bytesUp: 0,
      bytesDown: 0,
    };
    this.streams.set(streamId, stream);
    listener.streamsTotal += 1;
    this.streamByHash.set(streamHash.toString('hex'), streamId);

    // Hold incoming bytes until the target confirms it connected.
    socket.pause();
    this.wireSocket(stream);

    // If the hub/target never replies forward_ready, don't leak a paused socket.
    stream.openTimer = setTimeout(() => {
      if (stream.status === 'opening') {
        this.teardownStream(streamId, 'forward open timeout', { notifyPeer: true, graceful: false });
      }
    }, LISTENER_READY_TIMEOUT_MS);

    stream.openSentAt = Date.now();
    this.ws.send({
      type: 'forward_open',
      forwardId,
      streamId,
      targetGatewayId: listener.targetGatewayId,
      targetPort: listener.targetPort,
    });
  }

  public listForwards(): Array<{
    forwardId: string;
    localPort: number;
    bindHost: string;
    targetGatewayId: string;
    targetPort: number;
    activeStreams: number;
    createdAt: Date;
    health: ForwardHealth;
  }> {
    return Array.from(this.listeners.values()).map((l) => ({
      forwardId: l.forwardId,
      localPort: l.localPort,
      bindHost: l.bindHost,
      targetGatewayId: l.targetGatewayId,
      targetPort: l.targetPort,
      activeStreams: Array.from(this.streams.values()).filter((s) => s.forwardId === l.forwardId).length,
      createdAt: l.createdAt,
      health: l.health,
    }));
  }

  /** Per-forward traffic stats (mirrors the transfer-stats shape). Live. */
  public stats(): Array<{
    forwardId: string; localPort: number; bindHost: string; targetGatewayId: string; targetPort: number;
    activeStreams: number; streamsTotal: number;
    bytesUp: number; bytesDown: number; totalBytes: number;
    elapsedMs: number; avgBps: number; avgMBps: number; instantBps: number; instantMBps: number;
    health: ForwardHealth; createdAt: Date; rttMs: number | null;
  }> {
    const now = Date.now();
    return Array.from(this.listeners.values()).map((l) => {
      const act = Array.from(this.streams.values()).filter((s) => s.forwardId === l.forwardId);
      const up = l.bytesUp + act.reduce((a, s) => a + s.bytesUp, 0);
      const down = l.bytesDown + act.reduce((a, s) => a + s.bytesDown, 0);
      const total = up + down;
      const elapsedMs = Math.max(0, now - l.createdAt.getTime());
      const avgBps = elapsedMs > 0 ? Math.round((total * 1000) / elapsedMs) : 0;
      const dt = now - l.sAt;
      if (dt >= 500) {
        l.instantBps = Math.max(0, Math.round(((total - l.sBytes) * 1000) / dt));
        l.sBytes = total; l.sAt = now;
      }
      return {
        forwardId: l.forwardId, localPort: l.localPort, bindHost: l.bindHost,
        targetGatewayId: l.targetGatewayId, targetPort: l.targetPort,
        activeStreams: act.length, streamsTotal: l.streamsTotal,
        bytesUp: up, bytesDown: down, totalBytes: total,
        elapsedMs, avgBps, avgMBps: Math.round((avgBps / 1048576) * 100) / 100,
        instantBps: l.instantBps, instantMBps: Math.round((l.instantBps / 1048576) * 100) / 100,
        health: l.health, createdAt: l.createdAt, rttMs: l.rttMinMs || null,
      };
    });
  }

  public closeForward(forwardId: string): boolean {
    const listener = this.listeners.get(forwardId);
    if (!listener) return false;
    if (listener.probeTimer) clearInterval(listener.probeTimer);
    try { listener.server.close(); } catch { /* ignore */ }
    // Tear down any streams belonging to this listener.
    for (const stream of Array.from(this.streams.values())) {
      if (stream.forwardId === forwardId) {
        this.teardownStream(stream.streamId, 'forward closed', { notifyPeer: true, graceful: false });
      }
    }
    try {
      const dir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
      const total = listener.bytesUp + listener.bytesDown;
      const elapsedMs = Date.now() - listener.createdAt.getTime();
      fs.appendFileSync(path.join(dir, 'forward-stats.jsonl'), JSON.stringify({
        forwardId, localPort: listener.localPort, targetGatewayId: listener.targetGatewayId,
        targetPort: listener.targetPort, bytesUp: listener.bytesUp, bytesDown: listener.bytesDown,
        totalBytes: total, streamsTotal: listener.streamsTotal, elapsedMs, rttMs: listener.rttMinMs || null,
        avgMBps: elapsedMs > 0 ? Math.round(((total * 1000) / elapsedMs / 1048576) * 100) / 100 : 0,
        endedAt: Date.now(),
      }) + '\n');
    } catch { /* best-effort */ }
    this.listeners.delete(forwardId);
    console.log(`[PortForward] Closed forward ${forwardId}`);
    return true;
  }

  // ==========================================================================
  // TARGET SIDE — dial the local service the other node asked for
  // ==========================================================================

  public handleForwardOpen(msg: { streamId: string; srcGatewayId?: string; targetPort: number }): void {
    const { streamId, targetPort } = msg;
    if (this.streams.has(streamId)) {
      return; // duplicate
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      this.sendControl({ type: 'forward_error', streamId, error: `invalid targetPort ${targetPort}` });
      return;
    }
    // allowHalfOpen: keep reading the local service's response after we end()
    // our write side in response to a peer forward_eof.
    const socket = net.connect({ port: targetPort, host: '127.0.0.1', allowHalfOpen: true });
    const streamHash = PortForwardHandler.hashStreamId(streamId);
    const stream: ForwardStream = {
      streamId,
      streamHash,
      role: 'target',
      socket,
      status: 'opening',
      bytesUp: 0,
      bytesDown: 0,
    };
    this.streams.set(streamId, stream);
    this.streamByHash.set(streamHash.toString('hex'), streamId);

    // Don't hang forever if the local port is filtered (SYN dropped).
    stream.openTimer = setTimeout(() => {
      if (stream.status === 'opening') {
        this.sendControl({ type: 'forward_error', streamId, error: 'target connect timeout' });
        this.teardownStream(streamId, 'target connect timeout', { notifyPeer: false, graceful: false });
      }
    }, TARGET_CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      if (stream.openTimer) { clearTimeout(stream.openTimer); stream.openTimer = undefined; }
      stream.status = 'active';
      this.wireSocket(stream);
      this.sendControl({ type: 'forward_ready', streamId });
      console.log(`[PortForward] Target connected localhost:${targetPort} (stream=${streamId})`);
    });

    socket.once('error', (err) => {
      if (stream.status === 'opening') {
        this.sendControl({ type: 'forward_error', streamId, error: err.message });
      }
      this.teardownStream(streamId, err.message, { notifyPeer: false, graceful: false });
    });
  }

  // ==========================================================================
  // CONTROL / DATA FROM HUB
  // ==========================================================================

  public handleForwardReady(msg: { streamId: string }): void {
    const stream = this.streams.get(msg.streamId);
    if (!stream || stream.role !== 'listener') return;
    if (stream.openTimer) { clearTimeout(stream.openTimer); stream.openTimer = undefined; }
    stream.status = 'active';
    if (stream.forwardId) {
      this.setForwardHealth(stream.forwardId, 'up'); // target reachable
      // forward_open→forward_ready is a full round-trip over the forward path
      // (listener→hub→target→hub→listener) — the legacy ping/pong. Record the RTT.
      if (stream.openSentAt) {
        const rtt = Date.now() - stream.openSentAt;
        const lst = this.listeners.get(stream.forwardId);
        if (lst && rtt >= 0 && rtt < 60000) lst.rttMinMs = lst.rttMinMs === 0 ? rtt : Math.min(lst.rttMinMs, rtt);
      }
    }
    stream.socket.resume(); // start flowing client bytes now that target is up
  }

  public handleForwardError(msg: { streamId: string; error?: string }): void {
    // A failed open means the target service is currently unreachable — record
    // it on the forward (the forward itself stays valid for future connections).
    const stream = this.streams.get(msg.streamId);
    if (stream?.role === 'listener' && stream.forwardId) {
      this.setForwardHealth(stream.forwardId, 'down', msg.error || 'forward error');
    }
    this.teardownStream(msg.streamId, msg.error || 'forward error', { notifyPeer: false, graceful: false });
  }

  /** Update a forward's target-reachability status, stamping the change time. */
  private setForwardHealth(forwardId: string, status: ForwardHealth['status'], lastError?: string): void {
    const l = this.listeners.get(forwardId);
    if (!l) return;
    if (l.health.status !== status) {
      l.health = { status, since: new Date(), lastError: status === 'down' ? lastError : undefined };
      console.log(`[PortForward] ${forwardId} target ${status}${lastError ? ` (${lastError})` : ''}`);
    } else if (status === 'down' && lastError) {
      l.health.lastError = lastError;
    }
  }

  /**
   * Probe an idle forward's target reachability by opening a throwaway local
   * connection (which drives the normal forward_open -> ready/error round-trip,
   * updating health). Skipped when real streams are active (traffic already
   * reports health). Reuses the tunnel — no extra protocol.
   */
  private probeForward(forwardId: string): void {
    const l = this.listeners.get(forwardId);
    if (!l || !this.ws || !this.ws.isConnected()) return;
    const active = Array.from(this.streams.values()).some((s) => s.forwardId === forwardId);
    if (active) return; // real traffic already reflects health
    const probe = net.connect({ port: l.localPort, host: l.bindHost === '::1' ? '::1' : '127.0.0.1' });
    probe.on('connect', () => setTimeout(() => probe.destroy(), 800));
    probe.on('error', () => { /* listener should be up; ignore */ });
  }

  public handleForwardEof(msg: { streamId: string }): void {
    const stream = this.streams.get(msg.streamId);
    if (!stream || stream.status === 'closed') return;
    // Peer finished writing — flush our pending writes then FIN our write side
    // toward the local socket. allowHalfOpen keeps our read side open for the
    // response, so this is a true half-close, not a teardown.
    try { stream.socket.end(); } catch { /* ignore */ }
  }

  public handleForwardClose(msg: { streamId: string; reason?: string }): void {
    // Peer fully closed — drain our buffered writes to the local socket, then close.
    this.teardownStream(msg.streamId, msg.reason || 'peer closed', { notifyPeer: false, graceful: true });
  }

  /** Binary data frame from hub: write payload to the matching local socket. */
  public handleForwardData(streamHash: Buffer, payload: Buffer): void {
    const streamId = this.streamByHash.get(streamHash.toString('hex'));
    if (!streamId) return;
    const stream = this.streams.get(streamId);
    if (!stream || stream.status === 'closed') return;
    stream.bytesDown += payload.length;
    try {
      stream.socket.write(payload);
    } catch (err) {
      this.teardownStream(streamId, err instanceof Error ? err.message : 'write failed', { notifyPeer: true, graceful: false });
    }
  }

  // ==========================================================================
  // SHARED SOCKET PLUMBING
  // ==========================================================================

  private wireSocket(stream: ForwardStream): void {
    const { socket } = stream;

    socket.on('data', (chunk: Buffer) => {
      if (!this.ws || !this.ws.isConnected() || stream.status === 'closed') return;
      stream.bytesUp += chunk.length;
      this.ws.sendBinary(stream.streamHash, chunk, PORT_FORWARD_MARKER);

      // Backpressure: if the WS send buffer is backing up, pause the socket
      // and resume once it drains.
      if (this.ws.bufferedAmount() > WS_BACKPRESSURE_HIGH_WATER) {
        socket.pause();
        const resume = () => {
          if (stream.status === 'closed') return;
          if (!this.ws || this.ws.bufferedAmount() <= WS_BACKPRESSURE_HIGH_WATER) {
            socket.resume();
          } else {
            setTimeout(resume, WS_BACKPRESSURE_POLL_MS);
          }
        };
        setTimeout(resume, WS_BACKPRESSURE_POLL_MS);
      }
    });

    socket.on('end', () => {
      // Local side sent FIN (done writing) — propagate as a half-close.
      if (stream.status !== 'closed') {
        this.sendControl({ type: 'forward_eof', streamId: stream.streamId });
      }
    });

    socket.on('close', () => {
      // Socket fully closed locally. If we haven't already torn down (e.g. via a
      // peer forward_close), notify the peer now. Already-closed → no-op.
      this.teardownStream(stream.streamId, 'socket closed', { notifyPeer: true, graceful: false });
    });

    socket.on('error', () => {
      // 'close' will follow; teardown there.
    });
  }

  /**
   * Tear a stream down.
   *  - graceful=true: socket.end() so buffered writes flush (no truncation),
   *    with a linger backstop that force-destroys if it doesn't drain.
   *  - graceful=false: socket.destroy() (error/abort paths).
   *  - notifyPeer: send forward_close to the hub (skip when the peer initiated).
   */
  private teardownStream(
    streamId: string,
    reason: string,
    opts: { notifyPeer: boolean; graceful: boolean },
  ): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    if (stream.status === 'closed') return;
    stream.status = 'closed';
    if (stream.forwardId) {
      const lst = this.listeners.get(stream.forwardId);
      if (lst) { lst.bytesUp += stream.bytesUp; lst.bytesDown += stream.bytesDown; }
    }

    if (stream.openTimer) { clearTimeout(stream.openTimer); stream.openTimer = undefined; }
    this.streamByHash.delete(stream.streamHash.toString('hex'));
    this.streams.delete(streamId);

    if (opts.graceful) {
      try { stream.socket.end(); } catch { /* ignore */ }
      const linger = setTimeout(() => { try { stream.socket.destroy(); } catch { /* ignore */ } }, CLOSE_LINGER_MS);
      stream.socket.once('close', () => clearTimeout(linger));
    } else {
      try { stream.socket.destroy(); } catch { /* ignore */ }
    }

    if (opts.notifyPeer) {
      this.sendControl({ type: 'forward_close', streamId, reason });
    }
  }

  /**
   * Drop all in-flight streams (the hub connection went away, so their routing
   * is dead). Listeners are kept bound so new connections work after reconnect.
   */
  public dropStreamsOnDisconnect(): void {
    for (const streamId of Array.from(this.streams.keys())) {
      this.teardownStream(streamId, 'hub disconnected', { notifyPeer: false, graceful: false });
    }
  }

  private sendControl(msg: Record<string, unknown>): void {
    if (!this.ws || !this.ws.isConnected()) return;
    this.ws.send(msg);
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /** Close every listener + stream (called on disconnect/shutdown). */
  public cleanup(): void {
    for (const forwardId of Array.from(this.listeners.keys())) {
      this.closeForward(forwardId);
    }
    for (const streamId of Array.from(this.streams.keys())) {
      this.teardownStream(streamId, 'cleanup', { notifyPeer: false, graceful: false });
    }
    this.listeners.clear();
    this.streams.clear();
    this.streamByHash.clear();
  }
}

// Singleton instance
let handlerInstance: PortForwardHandler | null = null;

export function getPortForwardHandler(): PortForwardHandler {
  if (!handlerInstance) {
    handlerInstance = new PortForwardHandler();
  }
  return handlerInstance;
}
