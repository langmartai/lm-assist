/**
 * Reliable-ordered layer over unreliable datagrams.
 *
 * Transport-agnostic: it never touches a socket. The caller injects
 * `sendDatagram(buf)` (how a datagram leaves) and feeds inbound datagrams via
 * `onDatagram(buf)`. This lets the exact same code run over a real dgram udp4
 * socket (holepunch.ts) AND an in-process pair (the unit test).
 *
 * Guarantees over a lossy/reordering datagram channel:
 *   - 32-bit sequence numbers, cumulative ACK (ack = next-expected seq).
 *   - retransmit on RTO (~300ms base, exponential backoff, capped).
 *   - in-order delivery to the consumer (a reorder buffer holds out-of-order
 *     DATA until the gap fills).
 *   - a send window (default 64 unacked datagrams) for flow control.
 *   - keepalive PING so the NAT mapping (and the peer's liveness) stays fresh.
 *
 * Datagram header (11 bytes, big-endian):
 *   [1B type][4B seq][4B ack][2B len][payload...]
 * Types: DATA / ACK / PING / FIN.
 *
 * `send(buf)` fragments an arbitrary-length payload across <=1200B datagrams.
 */

export const DATAGRAM_TYPE = {
  DATA: 0,
  ACK: 1,
  PING: 2,
  FIN: 3,
} as const;

export type DatagramType = (typeof DATAGRAM_TYPE)[keyof typeof DATAGRAM_TYPE];

/** Fixed header length: 1 (type) + 4 (seq) + 4 (ack) + 2 (len). */
const HEADER_LEN = 11;
/** Max payload bytes per datagram (keep total MTU-safe, <=1200 payload). */
export const MAX_PAYLOAD = 1200;

export interface ReliableOptions {
  /** Send a single datagram. Must not throw for transient errors. */
  sendDatagram: (datagram: Buffer, isControl: boolean) => void;
  /** Delivered an in-order, reassembled chunk to the consumer. */
  onDeliver: (data: Buffer) => void;
  /** Peer sent FIN, or the link is being torn down. */
  onClose?: (reason?: string) => void;
  /** Base retransmit timeout in ms (default 300). */
  rtoMs?: number;
  /** Cap on the backed-off RTO in ms (default 4000). */
  rtoMaxMs?: number;
  /** Max unacked datagrams in flight (default 64). */
  windowSize?: number;
  /** Keepalive ping interval in ms (default 5000). */
  keepaliveMs?: number;
  /** Drop the link if nothing is heard from the peer for this long (default 30000). */
  idleTimeoutMs?: number;
}

interface PendingDatagram {
  seq: number;
  datagram: Buffer;   // full encoded datagram (header + payload), ready to resend
  sentAt: number;     // last (re)send time
  rto: number;        // current per-datagram backed-off RTO
  retries: number;
  control: boolean;   // routing class: control/metadata (relay) vs bulk (direct)
}

function encodeDatagram(type: DatagramType, seq: number, ack: number, payload: Buffer): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(seq >>> 0, 1);
  buf.writeUInt32BE(ack >>> 0, 5);
  buf.writeUInt16BE(payload.length, 9);
  if (payload.length > 0) payload.copy(buf, HEADER_LEN);
  return buf;
}

interface DecodedDatagram {
  type: DatagramType;
  seq: number;
  ack: number;
  payload: Buffer;
}

function decodeDatagram(buf: Buffer): DecodedDatagram | null {
  if (buf.length < HEADER_LEN) return null;
  const type = buf.readUInt8(0) as DatagramType;
  const seq = buf.readUInt32BE(1);
  const ack = buf.readUInt32BE(5);
  const len = buf.readUInt16BE(9);
  if (buf.length < HEADER_LEN + len) return null;
  const payload = buf.subarray(HEADER_LEN, HEADER_LEN + len);
  return { type, seq, ack, payload };
}

/** 32-bit wrap-safe "is a strictly before b" comparison. */
function seqLt(a: number, b: number): boolean {
  return ((a - b) >>> 0) > 0x80000000;
}

export class ReliableConnection {
  private readonly opts: Required<Omit<ReliableOptions, 'onClose'>> & Pick<ReliableOptions, 'onClose'>;

  // --- send side ---
  private nextSeq = 0;                              // next seq to assign to a DATA datagram
  private sendBase = 0;                             // oldest unacked seq
  private readonly inFlight = new Map<number, PendingDatagram>();
  private readonly waitQueue: Array<{ payload: Buffer; control: boolean }> = []; // payloads waiting for window space

  // --- receive side ---
  private rcvNext = 0;                              // next in-order seq we expect to deliver
  private readonly reorderBuf = new Map<number, Buffer>(); // seq -> payload held out-of-order

  // --- timers / liveness ---
  private rtoTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastRecvAt = Date.now();
  private closed = false;
  private finSent = false;

  constructor(options: ReliableOptions) {
    this.opts = {
      sendDatagram: options.sendDatagram,
      onDeliver: options.onDeliver,
      onClose: options.onClose,
      rtoMs: options.rtoMs ?? 300,
      rtoMaxMs: options.rtoMaxMs ?? 4000,
      windowSize: options.windowSize ?? 64,
      keepaliveMs: options.keepaliveMs ?? 5000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30000,
    };
    this.startKeepalive();
  }

  /** Reliable, ordered application send. Fragments across datagrams. */
  send(data: Buffer, control = false): void {
    if (this.closed) return;
    for (let off = 0; off < data.length; off += MAX_PAYLOAD) {
      const chunk = data.subarray(off, Math.min(off + MAX_PAYLOAD, data.length));
      this.waitQueue.push({ payload: chunk, control });
    }
    // Zero-length send is a no-op (no empty DATA datagrams).
    this.pumpWindow();
  }

  /** Move payloads from the wait queue into the send window while there's room. */
  private pumpWindow(): void {
    while (this.waitQueue.length > 0 && this.inFlight.size < this.opts.windowSize) {
      const { payload, control } = this.waitQueue.shift()!;
      const seq = this.nextSeq;
      this.nextSeq = (this.nextSeq + 1) >>> 0;
      const datagram = encodeDatagram(DATAGRAM_TYPE.DATA, seq, this.rcvNext, payload);
      const pending: PendingDatagram = {
        seq,
        datagram,
        sentAt: Date.now(),
        rto: this.opts.rtoMs,
        retries: 0,
        control,
      };
      this.inFlight.set(seq, pending);
      this.safeSend(datagram, control);
    }
    this.ensureRtoTimer();
  }

  /** Feed an inbound datagram (from the socket or the in-process pair). */
  onDatagram(buf: Buffer): void {
    if (this.closed) return;
    const dg = decodeDatagram(buf);
    if (!dg) return;
    this.lastRecvAt = Date.now();

    // Every datagram carries a cumulative ack — process it first.
    this.processAck(dg.ack);

    switch (dg.type) {
      case DATAGRAM_TYPE.DATA:
        this.handleData(dg);
        break;
      case DATAGRAM_TYPE.PING:
        // Liveness probe: reply with a bare ACK reflecting our rcvNext.
        this.sendControl(DATAGRAM_TYPE.ACK);
        break;
      case DATAGRAM_TYPE.ACK:
        // Pure ack already applied above.
        break;
      case DATAGRAM_TYPE.FIN:
        this.handleFin();
        break;
    }
  }

  private handleData(dg: DecodedDatagram): void {
    const seq = dg.seq;
    if (seqLt(seq, this.rcvNext) || seq === this.rcvNext - 1) {
      // Already delivered (duplicate retransmit) — re-ack so the sender advances.
      this.sendControl(DATAGRAM_TYPE.ACK);
      return;
    }
    if (seq === this.rcvNext) {
      // In order: deliver this one and drain any buffered contiguous successors.
      this.deliver(dg.payload);
      this.rcvNext = (this.rcvNext + 1) >>> 0;
      while (this.reorderBuf.has(this.rcvNext)) {
        const p = this.reorderBuf.get(this.rcvNext)!;
        this.reorderBuf.delete(this.rcvNext);
        this.deliver(p);
        this.rcvNext = (this.rcvNext + 1) >>> 0;
      }
    } else {
      // Out of order, ahead of rcvNext: buffer it until the gap fills.
      if (!this.reorderBuf.has(seq)) {
        // Copy: the payload is a view into the inbound buffer, which may be reused.
        this.reorderBuf.set(seq, Buffer.from(dg.payload));
      }
    }
    // Cumulative ack of everything delivered so far.
    this.sendControl(DATAGRAM_TYPE.ACK);
  }

  private deliver(payload: Buffer): void {
    try {
      this.opts.onDeliver(payload);
    } catch {
      /* consumer errors must not break the protocol loop */
    }
  }

  /** Apply a cumulative ack: drop every in-flight datagram with seq < ack. */
  private processAck(ack: number): void {
    if (this.inFlight.size === 0) {
      this.sendBase = ack;
      return;
    }
    for (const seq of Array.from(this.inFlight.keys())) {
      if (seqLt(seq, ack)) {
        this.inFlight.delete(seq);
      }
    }
    this.sendBase = ack;
    // Window freed up — push more queued payloads.
    this.pumpWindow();
    if (this.inFlight.size === 0) this.clearRtoTimer();
  }

  // ---- retransmission ----

  private ensureRtoTimer(): void {
    if (this.rtoTimer || this.inFlight.size === 0 || this.closed) return;
    // Poll at the base RTO granularity; each datagram tracks its own deadline.
    this.rtoTimer = setInterval(() => this.checkRetransmits(), Math.max(50, Math.floor(this.opts.rtoMs / 2)));
    if (this.rtoTimer.unref) this.rtoTimer.unref();
  }

  private clearRtoTimer(): void {
    if (this.rtoTimer) {
      clearInterval(this.rtoTimer);
      this.rtoTimer = null;
    }
  }

  private checkRetransmits(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const pending of this.inFlight.values()) {
      if (now - pending.sentAt >= pending.rto) {
        pending.retries += 1;
        // Exponential backoff, capped.
        pending.rto = Math.min(pending.rto * 2, this.opts.rtoMaxMs);
        pending.sentAt = now;
        // Refresh the piggybacked ack to our latest rcvNext before resending.
        pending.datagram.writeUInt32BE(this.rcvNext >>> 0, 5);
        this.safeSend(pending.datagram, pending.control);
      }
    }
    if (this.inFlight.size === 0) this.clearRtoTimer();
  }

  // ---- keepalive / liveness ----

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.closed) return;
      const idle = Date.now() - this.lastRecvAt;
      if (idle >= this.opts.idleTimeoutMs) {
        this.teardown('idle timeout');
        return;
      }
      // Probe the peer to keep the NAT hole open and detect death.
      this.sendControl(DATAGRAM_TYPE.PING);
    }, this.opts.keepaliveMs);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  private sendControl(type: DatagramType): void {
    // Control datagrams carry no payload; seq is the current nextSeq (ignored by
    // the receiver for ACK/PING/FIN ordering), ack is our cumulative rcvNext.
    const dg = encodeDatagram(type, this.nextSeq, this.rcvNext, Buffer.alloc(0));
    this.safeSend(dg, true); // reliable ACK/PING/FIN are control → relay
  }

  private safeSend(datagram: Buffer, isControl: boolean): void {
    try {
      this.opts.sendDatagram(datagram, isControl);
    } catch {
      /* transient send errors are tolerated; retransmit/keepalive will recover */
    }
  }

  // ---- close ----

  private handleFin(): void {
    // Ack the FIN's piggybacked state, then close.
    this.sendControl(DATAGRAM_TYPE.ACK);
    this.teardown('peer closed');
  }

  /** Graceful close: flush a FIN to the peer, then tear down. */
  close(reason?: string): void {
    if (this.closed) return;
    if (!this.finSent) {
      this.finSent = true;
      this.sendControl(DATAGRAM_TYPE.FIN);
    }
    this.teardown(reason);
  }

  private teardown(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearRtoTimer();
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.inFlight.clear();
    this.reorderBuf.clear();
    this.waitQueue.length = 0;
    if (this.opts.onClose) {
      try { this.opts.onClose(reason); } catch { /* ignore */ }
    }
  }

  /** True once the connection is torn down. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Diagnostics: count of unacked datagrams currently in flight. */
  inFlightCount(): number {
    return this.inFlight.size;
  }
}
