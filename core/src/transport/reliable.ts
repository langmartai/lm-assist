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
 *   - retransmit on RTO (Jacobson/Karn-estimated, exponential backoff, capped).
 *   - in-order delivery to the consumer (a reorder buffer holds out-of-order
 *     DATA until the gap fills).
 *   - TCP/QUIC-style congestion control + send pacing so the sender adapts the
 *     send rate to the path instead of blasting a fixed window.
 *   - keepalive PING so the NAT mapping (and the peer's liveness) stays fresh.
 *
 * Congestion control (sender-internal only — wire format unchanged):
 *   - RTT estimated per RFC 6298 (srtt/rttvar) using Karn's algorithm: a sample
 *     is taken only from datagrams that were never retransmitted.
 *   - cwnd (float, in datagrams): IW=10, slow-start until ssthresh, then
 *     congestion avoidance. RTO loss → ssthresh=cwnd/2, cwnd=1. 3 dup-acks →
 *     fast retransmit + fast recovery (ssthresh=cwnd=cwnd/2).
 *   - send pacing: DATA datagrams are released spaced by ~srtt/cwnd, with a
 *     small per-tick burst, so in-flight grows smoothly toward cwnd rather than
 *     bursting. ACK / PING / FIN bypass cwnd + pacing (sent immediately).
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
  sendDatagram: (datagram: Buffer) => void;
  /** Delivered an in-order, reassembled chunk to the consumer. */
  onDeliver: (data: Buffer) => void;
  /** Peer sent FIN, or the link is being torn down. */
  onClose?: (reason?: string) => void;
  /**
   * Base retransmit timeout in ms (default 300). Used only as the initial RTO
   * before the first RTT sample arrives; thereafter RTO is computed from the
   * Jacobson/Karn estimator and clamped to [rtoMinMs, rtoMaxMs].
   */
  rtoMs?: number;
  /** Floor on the estimated RTO in ms (default 200). */
  rtoMinMs?: number;
  /** Cap on the backed-off RTO in ms (default 4000). */
  rtoMaxMs?: number;
  /**
   * Flow-control ceiling: hard cap on unacked datagrams in flight regardless of
   * cwnd (default 1024). cwnd is the real governor; this is a safety ceiling so
   * a huge cwnd can never exhaust memory. Kept generous on purpose.
   */
  windowSize?: number;
  /** Initial congestion window in datagrams (default 10, per RFC 6928 IW=10). */
  initialCwnd?: number;
  /** Minimum spacing between paced DATA sends in ms (default 0.2). */
  minPaceMs?: number;
  /** Max DATA datagrams released per pacing tick (default 4). */
  paceBurst?: number;
  /** Conservative srtt (ms) used for pacing before the first RTT sample (default 50). */
  initialSrttMs?: number;
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
  retransmitted: boolean; // Karn: once true, never sample RTT from this datagram
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

/** Sender-internal congestion-control snapshot (test-only diagnostics). */
export interface CongestionStats {
  cwnd: number;
  ssthresh: number;
  srtt: number;
  rttvar: number;
  rto: number;
  inFlight: number;
  waitQueue: number;
  dupAcks: number;
  sendCount: number;     // total datagrams handed to sendDatagram
  dataSendCount: number; // DATA datagrams handed to sendDatagram (incl. retransmits)
  retransmitCount: number;
}

export class ReliableConnection {
  private readonly opts: Required<Omit<ReliableOptions, 'onClose'>> & Pick<ReliableOptions, 'onClose'>;

  // --- send side ---
  private nextSeq = 0;                              // next seq to assign to a DATA datagram
  private sendBase = 0;                             // oldest unacked seq
  private readonly inFlight = new Map<number, PendingDatagram>();
  private readonly waitQueue: Buffer[] = [];        // payloads waiting for cwnd/pacing

  // --- receive side ---
  private rcvNext = 0;                              // next in-order seq we expect to deliver
  private readonly reorderBuf = new Map<number, Buffer>(); // seq -> payload held out-of-order

  // --- congestion control ---
  private cwnd: number;                             // float, in datagrams
  private ssthresh = Number.MAX_SAFE_INTEGER;       // slow-start threshold
  private srtt = 0;                                 // smoothed RTT (ms), 0 = no sample yet
  private rttvar = 0;                               // RTT variance (ms)
  private rto: number;                              // current computed RTO (ms)
  private lastAckValue = 0;                         // last cumulative ack observed
  private dupAckCount = 0;                          // consecutive dup acks at lastAckValue

  // --- pacing ---
  private paceTimer: NodeJS.Timeout | null = null;
  private lastPaceAt = 0;

  // --- diagnostics ---
  private sendCount = 0;
  private dataSendCount = 0;
  private retransmitCount = 0;

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
      rtoMinMs: options.rtoMinMs ?? 200,
      rtoMaxMs: options.rtoMaxMs ?? 4000,
      windowSize: options.windowSize ?? 1024,
      initialCwnd: options.initialCwnd ?? 10,
      minPaceMs: options.minPaceMs ?? 0.2,
      paceBurst: options.paceBurst ?? 4,
      initialSrttMs: options.initialSrttMs ?? 50,
      keepaliveMs: options.keepaliveMs ?? 5000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30000,
    };
    this.cwnd = this.opts.initialCwnd;
    this.rto = this.opts.rtoMs;
    this.startKeepalive();
  }

  /** Reliable, ordered application send. Fragments across datagrams. */
  send(data: Buffer): void {
    if (this.closed) return;
    for (let off = 0; off < data.length; off += MAX_PAYLOAD) {
      const chunk = data.subarray(off, Math.min(off + MAX_PAYLOAD, data.length));
      // Copy: the caller's buffer may be reused after send() returns, and the
      // chunk can sit in waitQueue across ticks before it is encoded.
      this.waitQueue.push(Buffer.from(chunk));
    }
    // Zero-length send is a no-op (no empty DATA datagrams).
    this.schedulePump();
  }

  // ---- congestion-controlled send pacing ----

  /**
   * The effective in-flight cap is the min of cwnd (floored) and the flow window.
   * cwnd is the real governor; windowSize is a generous safety ceiling.
   */
  private effectiveWindow(): number {
    return Math.min(Math.max(1, Math.floor(this.cwnd)), this.opts.windowSize);
  }

  /** Current pacing srtt: real estimate if we have one, else the conservative default. */
  private paceSrtt(): number {
    return this.srtt > 0 ? this.srtt : this.opts.initialSrttMs;
  }

  /** ms between paced DATA releases ≈ srtt / cwnd, floored at minPaceMs. */
  private pacingInterval(): number {
    const interval = this.paceSrtt() / Math.max(1, this.cwnd);
    return Math.max(this.opts.minPaceMs, interval);
  }

  /**
   * Is there anything the pump could send right now (fresh data) given the
   * current congestion window? (Retransmits are handled by the RTO timer, but
   * the pump also drives them paced via maybeSendNewData.)
   */
  private hasSendableData(): boolean {
    return this.waitQueue.length > 0 && this.inFlight.size < this.effectiveWindow();
  }

  /** Schedule the pacing pump if there is sendable data and no pump pending. */
  private schedulePump(): void {
    if (this.closed) return;
    if (this.paceTimer) return;
    if (!this.hasSendableData()) return;

    const now = Date.now();
    const sinceLast = now - this.lastPaceAt;
    const interval = this.pacingInterval();
    const delay = Math.max(0, interval - sinceLast);
    // Round up sub-ms intervals to the timer floor (Node clamps to >=1ms anyway);
    // the per-tick burst amortizes the timer overhead for high-rate paths.
    const ms = delay <= 0 ? 0 : Math.ceil(delay);
    this.paceTimer = setTimeout(() => {
      this.paceTimer = null;
      this.pumpPaced();
    }, ms);
    if (this.paceTimer.unref) this.paceTimer.unref();
  }

  /** One pacing tick: release up to paceBurst fresh DATA datagrams, then reschedule. */
  private pumpPaced(): void {
    if (this.closed) return;
    this.lastPaceAt = Date.now();
    let burst = this.opts.paceBurst;
    while (burst > 0 && this.hasSendableData()) {
      this.emitNewData();
      burst -= 1;
    }
    this.ensureRtoTimer();
    // If more remains (window/data permitting), schedule the next paced tick.
    this.schedulePump();
  }

  /** Encode + send exactly one fresh DATA datagram from the wait queue. */
  private emitNewData(): void {
    const payload = this.waitQueue.shift()!;
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) >>> 0;
    const datagram = encodeDatagram(DATAGRAM_TYPE.DATA, seq, this.rcvNext, payload);
    const pending: PendingDatagram = {
      seq,
      datagram,
      sentAt: Date.now(),
      rto: this.rto,
      retries: 0,
      retransmitted: false,
    };
    this.inFlight.set(seq, pending);
    this.dataSendCount += 1;
    this.safeSend(datagram);
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

  // ---- ack / congestion-control accounting ----

  /**
   * Apply a cumulative ack: drop every in-flight datagram with seq < ack,
   * update RTT (Karn), grow/shrink cwnd, and handle dup-ack fast retransmit.
   */
  private processAck(ack: number): void {
    // How far does this ack advance the send base? (in datagrams)
    const advanced = this.inFlight.size > 0
      ? this.countNewlyAcked(ack)
      : 0;

    if (advanced > 0) {
      // RTT sample (Karn): use the OLDEST newly-acked datagram, but only if it
      // was never retransmitted. The oldest newly-acked seq is the current base.
      const sampleBase = this.inFlight.get(this.sendBase);
      const now = Date.now();
      if (sampleBase && !sampleBase.retransmitted) {
        this.updateRtt(now - sampleBase.sentAt);
      }

      // Drop all acked datagrams from the in-flight set.
      for (const seq of Array.from(this.inFlight.keys())) {
        if (seqLt(seq, ack)) this.inFlight.delete(seq);
      }
      this.sendBase = ack;

      // cwnd growth on a new (non-dup) cumulative ack.
      this.growCwnd(advanced);

      // Base advanced → reset the dup-ack tracker.
      this.lastAckValue = ack;
      this.dupAckCount = 0;
    } else {
      // No advance. Could be a duplicate cumulative ack (fast-retransmit signal)
      // or a stale/old ack. Only count it as a dup if it equals our last ack and
      // we still have unacked data outstanding.
      if (this.inFlight.size > 0 && ack === this.lastAckValue) {
        this.dupAckCount += 1;
        if (this.dupAckCount === 3) {
          this.onTripleDupAck();
        }
      } else if (this.inFlight.size > 0 && seqLt(this.lastAckValue, ack)) {
        // Newer ack value but it didn't clear anything we track (already gone) —
        // adopt it as the new baseline without treating it as a dup.
        this.lastAckValue = ack;
        this.dupAckCount = 0;
        this.sendBase = ack;
      }
    }

    if (this.inFlight.size === 0) this.clearRtoTimer();
    // Window may have freed up — let the pump release more (paced).
    this.schedulePump();
  }

  /** Count how many currently-in-flight datagrams this ack would clear. */
  private countNewlyAcked(ack: number): number {
    let n = 0;
    for (const seq of this.inFlight.keys()) {
      if (seqLt(seq, ack)) n += 1;
    }
    return n;
  }

  /** RFC 6298 RTT smoothing + RTO recompute. */
  private updateRtt(sampleMs: number): void {
    const r = Math.max(0, sampleMs);
    if (this.srtt === 0) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = (3 / 4) * this.rttvar + (1 / 4) * Math.abs(this.srtt - r);
      this.srtt = (7 / 8) * this.srtt + (1 / 8) * r;
    }
    const computed = this.srtt + 4 * this.rttvar;
    this.rto = Math.min(this.opts.rtoMaxMs, Math.max(this.opts.rtoMinMs, computed));
  }

  /** Increase cwnd for an ack that advanced the base by `acked` datagrams. */
  private growCwnd(acked: number): void {
    if (this.cwnd < this.ssthresh) {
      // Slow start: exponential growth (one per acked datagram).
      this.cwnd += acked;
    } else {
      // Congestion avoidance: ~+1 MSS per RTT.
      this.cwnd += acked / this.cwnd;
    }
  }

  /** 3 duplicate cumulative acks → fast retransmit + (simplified) fast recovery. */
  private onTripleDupAck(): void {
    // Retransmit the segment at the base immediately (bypasses pacing — this is
    // a loss-recovery signal, not bulk data).
    const seg = this.inFlight.get(this.sendBase);
    if (seg) {
      seg.retransmitted = true; // Karn: no RTT sample from a retransmit
      seg.sentAt = Date.now();
      seg.datagram.writeUInt32BE(this.rcvNext >>> 0, 5);
      this.dataSendCount += 1;
      this.retransmitCount += 1;
      this.safeSend(seg.datagram);
    }
    // Fast recovery (simplified): halve, stay in congestion avoidance.
    this.ssthresh = Math.max(this.cwnd / 2, 2);
    this.cwnd = this.ssthresh;
    if (this.cwnd < 1) this.cwnd = 1;
  }

  // ---- retransmission (RTO) ----

  private ensureRtoTimer(): void {
    if (this.rtoTimer || this.inFlight.size === 0 || this.closed) return;
    // Poll frequently enough to honor short RTOs; each datagram tracks its own
    // deadline so the poll granularity only bounds detection latency.
    const tick = Math.max(20, Math.floor(this.opts.rtoMinMs / 2));
    this.rtoTimer = setInterval(() => this.checkRetransmits(), tick);
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
    let timedOut = false;
    for (const pending of this.inFlight.values()) {
      if (now - pending.sentAt >= pending.rto) {
        pending.retries += 1;
        pending.retransmitted = true; // Karn: never sample RTT from this datagram
        // Exponential backoff, capped.
        pending.rto = Math.min(pending.rto * 2, this.opts.rtoMaxMs);
        pending.sentAt = now;
        // Refresh the piggybacked ack to our latest rcvNext before resending.
        pending.datagram.writeUInt32BE(this.rcvNext >>> 0, 5);
        this.dataSendCount += 1;
        this.retransmitCount += 1;
        this.safeSend(pending.datagram);
        timedOut = true;
      }
    }
    if (timedOut) {
      // RTO loss: collapse the window and re-enter slow start.
      this.ssthresh = Math.max(this.cwnd / 2, 2);
      this.cwnd = 1;
      // Reset the dup-ack tracker; the next genuine ack restarts growth.
      this.dupAckCount = 0;
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
    // Control datagrams (ACK/PING/FIN) carry no payload and are NOT subject to
    // cwnd or pacing — they are tiny and must not be delayed. seq is the current
    // nextSeq (ignored by the receiver for control ordering), ack is rcvNext.
    const dg = encodeDatagram(type, this.nextSeq, this.rcvNext, Buffer.alloc(0));
    this.safeSend(dg);
  }

  private safeSend(datagram: Buffer): void {
    this.sendCount += 1;
    try {
      this.opts.sendDatagram(datagram);
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
    if (this.paceTimer) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
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

  /** Test-only: current congestion window (datagrams, float). */
  __cwnd(): number {
    return this.cwnd;
  }

  /** Test-only: full congestion-control snapshot. */
  __stats(): CongestionStats {
    return {
      cwnd: this.cwnd,
      ssthresh: this.ssthresh,
      srtt: this.srtt,
      rttvar: this.rttvar,
      rto: this.rto,
      inFlight: this.inFlight.size,
      waitQueue: this.waitQueue.length,
      dupAcks: this.dupAckCount,
      sendCount: this.sendCount,
      dataSendCount: this.dataSendCount,
      retransmitCount: this.retransmitCount,
    };
  }
}
