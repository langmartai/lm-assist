/**
 * TcpChannel — the Channel interface (see ./index.ts) over a real, already
 * connected net.Socket. This is the direct-TCP-for-LAN path (transport-perf
 * plan, PHASE D): a same-LAN peer gets a real kernel TCP connection instead of
 * the UDP-based hybrid channel.
 *
 * CRUCIALLY this does NOT wrap ReliableConnection (../reliable.ts). The kernel's
 * TCP stack already does reliability/ordering/retransmit/congestion-windowing at
 * line rate; layering the userspace ARQ on top of it would just re-impose the
 * same ~9 MB/s ceiling that caps the direct-UDP path today. TcpChannel.send() is
 * just "frame + socket.write()" — the kernel does the rest.
 *
 * Message boundaries: a raw TCP connection is a byte stream, not
 * message-preserving (a single socket.write() may arrive split across several
 * 'data' events, or coalesced with an adjacent write). TcpChannel imposes its
 * own boundaries with a `[4B big-endian length][payload]` frame per send() call
 * — the same idea as file-transfer/frame.ts's FrameReader, but reimplemented
 * locally here rather than imported:
 *   - file-transfer/frame.ts's FrameReader decodes payloads into FT-specific
 *     KIND_CONTROL/KIND_DATA shapes; a generic transport-layer Channel has no
 *     business knowing about file-transfer's wire format.
 *   - file-transfer already depends on transport/ (sender.ts/receiver.ts import
 *     Channel from here); importing file-transfer/frame.ts from transport/ would
 *     point a dependency backwards.
 * The upshot is TcpChannel's send()/onData() are message-preserving — a
 * strictly STRONGER contract than the existing hybrid Channel (whose own docs
 * note it is NOT message-preserving, which is why file-transfer's sender.ts and
 * receiver.ts already carry their own defensive FrameReader re-framing on top of
 * onData()). That existing FT-layer framing keeps working unmodified over a
 * TcpChannel once wired in (D3/D4) — it will just see whole FT frames arrive as
 * its "transport chunks", which its FrameReader already handles fine; the only
 * cost is a second, redundant 4-byte length prefix per message, which is a
 * trivial overhead next to the kernel-speed bulk-throughput win this phase is
 * chasing.
 *
 * NOT wired into openChannel/file-transfer yet — that is D2 (TCP listener +
 * auth) / D3 (openBestChannel) / D4 (file-transfer rides it). This file is just
 * the Channel implementation + its own tests.
 */

import * as net from 'net';
import { randomUUID } from 'crypto';
import type { Channel } from './index';

const LEN_PREFIX = 4;

/** Hard cap (bytes) on data queued internally while the socket is
 *  backpressured. Mirrors reliable.ts's A5 hard-cap-then-teardown policy for
 *  its send queue — same rationale: protect memory from a producer that never
 *  checks send()'s return value (see maxQueueBytes doc on TcpChannelOptions). */
const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024;

/** Grace period between socket.end() (FIN) and a forced socket.destroy() in
 *  close(), so a peer that promptly FINs back gets a clean shutdown instead of
 *  an abrupt reset. */
const DEFAULT_LINGER_MS = 2000;

export interface TcpChannelOptions {
  /** Channel id. Defaults to a fresh UUID (matches openChannel's convention in
   *  ./index.ts). */
  id?: string;
  /**
   * Hard cap on bytes queued internally while send() keeps getting called
   * after the underlying socket.write() already returned false (i.e. the
   * caller is not honoring backpressure). This exists because the CURRENT
   * file-transfer sender (../file-transfer/sender.ts's streamFile) calls
   * channel.send() in a tight loop and never checks the return value — so
   * without a cap, a fast local producer against a slow peer (e.g. slow disk
   * on the receiving end) would let this queue grow unbounded. Once exceeded,
   * the channel tears itself down (onClose fires with an "overflow" reason)
   * rather than risk unbounded memory growth. Default 16 MiB.
   */
  maxQueueBytes?: number;
  /** See DEFAULT_LINGER_MS. */
  lingerMs?: number;
  /** Bytes already read off the socket before it was wrapped (e.g. a handshake
   *  reader on the listener consumed the hello and left trailing bytes). Fed
   *  through the frame reader on construction; frames that complete before a
   *  consumer registers onData() are buffered and flushed on registration. */
  initialData?: Buffer;
}

/**
 * Minimal length-prefixed frame reader: accumulates bytes from socket 'data'
 * events and yields whole `[4B BE len][payload]` payloads as they complete.
 * Deliberately raw-Buffer-only (no kind tag) — see the file header for why
 * this isn't file-transfer/frame.ts's FrameReader.
 */
class LengthPrefixedReader {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns any payloads that completed. */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.buf.length < LEN_PREFIX) break;
      const len = this.buf.readUInt32BE(0);
      const total = LEN_PREFIX + len;
      if (this.buf.length < total) break;
      out.push(this.buf.subarray(LEN_PREFIX, total));
      this.buf = this.buf.subarray(total);
    }
    return out;
  }

  /** Bytes still buffered awaiting more input (diagnostics/tests). */
  pending(): number {
    return this.buf.length;
  }
}

function frameOne(data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(LEN_PREFIX + data.length);
  out.writeUInt32BE(data.length >>> 0, 0);
  data.copy(out, LEN_PREFIX);
  return out;
}

/**
 * Channel implementation over a real, connected net.Socket. See the file
 * header for the full design rationale (no ReliableConnection, own framing).
 */
export class TcpChannel implements Channel {
  readonly id: string;
  readonly peerGatewayId: string;

  private socket: net.Socket;
  private reader = new LengthPrefixedReader();
  private dataCb: ((data: Buffer) => void) | null = null;
  private unreliableCb: ((data: Buffer) => void) | null = null;
  private pendingFrames: Buffer[] = []; // frames that arrived before onData() was registered
  private closeCbs: Array<(reason?: string) => void> = [];
  private drainCbs: Array<() => void> = [];
  private closed = false; // close() was called (graceful shutdown initiated)
  private torndown = false; // finishClose has already run (guards double-fire)
  private socketWritable = true;
  private readonly sendQueue: Buffer[] = [];
  private queuedBytes = 0;
  private readonly maxQueueBytes: number;
  private readonly lingerMs: number;
  private rttMs: number | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;

  constructor(socket: net.Socket, peerGatewayId: string, opts: TcpChannelOptions = {}) {
    this.socket = socket;
    this.peerGatewayId = peerGatewayId;
    this.id = opts.id ?? randomUUID();
    this.maxQueueBytes = opts.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.lingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS;

    // Disable Nagle's algorithm: this phase exists to hit LAN native speed, and
    // batching small writes to wait for an ACK is exactly the wrong default
    // for a channel that will carry both latency-sensitive control frames and
    // bulk data.
    try {
      socket.setNoDelay(true);
    } catch {
      /* not fatal if unsupported on this socket */
    }

    socket.on('data', (chunk: Buffer) => this.onSocketData(chunk));
    socket.on('close', () => this.finishClose('closed'));
    socket.on('end', () => this.finishClose('ended'));
    socket.on('error', (err: Error) => this.finishClose('error: ' + err.message));

    // Bytes consumed off the socket before wrapping (e.g. the listener's hello
    // reader left trailing bytes): feed them through the reader now; completed
    // frames buffer in pendingFrames until onData() registers.
    if (opts.initialData && opts.initialData.length > 0) this.onSocketData(opts.initialData);
  }

  get mode(): 'bidi' {
    return 'bidi';
  }

  get via(): 'host' {
    return 'host';
  }

  /** Unmeasured for now — D1 ships no peer-side hello/ping protocol to measure
   *  against (that lands in D2's TCP listener + auth handshake). Kept as a live
   *  getter so a later caller can wire a real measurement in without changing
   *  this shape. */
  get rtt(): number | null {
    return this.rttMs;
  }

  send(data: Buffer): boolean {
    return this.writeFramed(frameOne(data));
  }

  /**
   * TCP is a single ordered stream — there is no separate priority lane the
   * way the relay/hybrid channel has (control datagrams jumping the relay's
   * backpressure queue). Control and data share the same connection, so this
   * is a plain alias.
   */
  sendControl(data: Buffer): boolean {
    return this.send(data);
  }

  /** TCP has no unreliable delivery mode; map onto the (already reliable)
   *  send path. Returns false only once the channel is no longer usable,
   *  mirroring the hybrid Channel's "false if there is no confirmed direct
   *  peer" contract. */
  sendUnreliable(buf: Buffer): boolean {
    if (this.torndown || this.closed) return false;
    this.send(buf);
    return true;
  }

  onData(cb: (data: Buffer) => void): void {
    this.dataCb = cb;
    if (this.pendingFrames.length > 0) {
      const flush = this.pendingFrames;
      this.pendingFrames = [];
      for (const f of flush) {
        cb(f);
        if (this.unreliableCb) this.unreliableCb(f);
      }
    }
  }

  /**
   * No separate unreliable plane exists on a TCP byte stream, so this is kept
   * as its OWN callback slot (not an alias that overwrites onData's slot) and
   * every delivered frame is handed to both callbacks when both are
   * registered. A naive alias (onUnreliable just calling this.onData) would
   * silently clobber whatever onData() had already registered — a real
   * footgun for a caller like file-transfer/receiver.ts, which registers
   * onData first (for control/meta frames) and onUnreliable later (for the
   * firehose data plane).
   */
  onUnreliable(cb: (data: Buffer) => void): void {
    this.unreliableCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  /** Not part of the frozen Channel interface — an extra signal for a
   *  conscientious caller (matches the "cleaner" option in the D1 spec: send()
   *  already returns the write-accepted boolean; this is the complementary
   *  event for "you may resume now"). */
  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }

  /** Point-in-time backpressure query, complementing send()'s per-call return
   *  value and onDrain()'s event. */
  isWritable(): boolean {
    return this.socketWritable && !this.torndown && !this.closed;
  }

  /** TCP has no ICE-style confirmation ladder — the mere existence of a live,
   *  connected socket IS the confirmation. True once constructed, false once
   *  the channel starts or finishes closing. */
  directReady(): boolean {
    return !this.torndown && !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    this.lingerTimer = setTimeout(() => {
      if (!this.torndown) {
        try {
          this.socket.destroy();
        } catch {
          /* ignore */
        }
      }
    }, this.lingerMs);
    if (this.lingerTimer.unref) this.lingerTimer.unref();
  }

  // ---------------------------------------------------------------------

  private onSocketData(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.reader.push(chunk);
    } catch (e) {
      this.finishClose('frame decode error: ' + (e as Error).message);
      return;
    }
    for (const f of frames) {
      if (this.dataCb) {
        this.dataCb(f);
        if (this.unreliableCb) this.unreliableCb(f);
      } else {
        // No consumer yet — buffer until onData() registers (initialData/hello race).
        this.pendingFrames.push(f);
      }
    }
  }

  private writeFramed(framed: Buffer): boolean {
    if (this.torndown || this.closed) return false;
    if (!this.socketWritable) {
      this.enqueue(framed);
      return false;
    }
    let ok: boolean;
    try {
      ok = this.socket.write(framed);
    } catch {
      return false;
    }
    if (!ok) {
      this.socketWritable = false;
      this.armDrain();
    }
    return ok;
  }

  private enqueue(framed: Buffer): void {
    this.sendQueue.push(framed);
    this.queuedBytes += framed.length;
    if (this.queuedBytes > this.maxQueueBytes) {
      this.finishClose(
        `send queue overflow (${this.queuedBytes}B > ${this.maxQueueBytes}B cap) — ` +
          'caller kept sending without honoring backpressure',
      );
    }
  }

  private armDrain(): void {
    this.socket.once('drain', () => {
      this.socketWritable = true;
      this.flushQueue();
      const cbs = this.drainCbs.slice();
      for (const cb of cbs) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    });
  }

  private flushQueue(): void {
    while (this.sendQueue.length > 0 && this.socketWritable) {
      const next = this.sendQueue.shift()!;
      this.queuedBytes -= next.length;
      let ok: boolean;
      try {
        ok = this.socket.write(next);
      } catch {
        continue;
      }
      if (!ok) {
        this.socketWritable = false;
        this.armDrain();
        return;
      }
    }
  }

  private finishClose(reason: string): void {
    if (this.torndown) return;
    this.torndown = true;
    this.closed = true;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    const cbs = this.closeCbs.slice();
    this.closeCbs = [];
    for (const cb of cbs) {
      try {
        cb(reason);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Wrap an already-connected net.Socket as a Channel. */
export function createTcpChannelFromSocket(
  socket: net.Socket,
  peerGatewayId: string,
  opts?: TcpChannelOptions,
): TcpChannel {
  return new TcpChannel(socket, peerGatewayId, opts);
}
