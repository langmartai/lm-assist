/**
 * First-frame subsystem demux for inbound transport channels (the convention
 * documented in file-transfer/protocol.ts). Buffers raw chunks until the first
 * control frame decodes, picks the subsystem by its `type`, then hands the
 * handler a channel whose onData REPLAYS the buffered bytes before going live
 * (Channel.onData registers a single callback — last wins — so the handler's
 * own FrameReader sees the stream from byte 0).
 */
import { FrameReader } from '../file-transfer/frame';
import { FABRIC_TAG } from './protocol';

export interface RoutableChannel {
  onData(cb: (d: Buffer) => void): void;
  onClose(cb: (r?: string) => void): void;
  [k: string]: unknown;
}

export interface InboundRoutes {
  fabric: (ch: RoutableChannel) => void;
  fileTransfer: (ch: RoutableChannel) => void;
}

/** Shared close state so a close that fires before routing decides — or before the
 *  handler attaches its own onClose — is never dropped. */
interface CloseState {
  fired: boolean;
  reason?: string;
  forward: ((r?: string) => void) | null;
  delivered: boolean;
}

/** Delivers a close to whatever `forward` callback is currently registered, via
 *  queueMicrotask — never synchronously. Delivery is only ever QUEUED once a forward
 *  target exists (see the gated onClose below, and the replay gate in makeReplayed) —
 *  an early close (no forward yet, e.g. mid multi-chunk frame or before routing decides)
 *  just captures `fired`/`reason` and queues nothing. Because of that gating, whenever a
 *  handler attaches onData before onClose (the pattern every routed handler in this file
 *  follows), the drain microtask queued at onData-attach is always FIRST in the FIFO, so
 *  a close queued in the same turn — at that onClose attach, or by a close firing after —
 *  always runs after it: data-before-close ordering holds for that attach order. It is
 *  NOT a universal guarantee: a handler that attaches onClose before onData would instead
 *  get the close microtask queued first. Either way close still delivers exactly once,
 *  after state capture, and any bytes still buffered/in-flight are drained to a handler
 *  that has already observed the close — delivered, never lost. Guarded by `delivered` so
 *  a close is forwarded at most once, however many times this is called (real fire +
 *  replay-on-attach) or however many times onClose is re-registered. */
function deliverClose(closeState: CloseState): void {
  queueMicrotask(() => {
    if (closeState.delivered) return;
    const cb = closeState.forward;
    if (!cb) return;
    closeState.delivered = true;
    cb(closeState.reason);
  });
}

export function routeInboundChannel(ch: RoutableChannel, routes: InboundRoutes, timeoutMs = 3000): void {
  const reader = new FrameReader();
  const buffered: Buffer[] = [];
  let decided = false;

  // Register immediately (not deferred to makeReplayed): a close can fire before
  // routing decides (up to timeoutMs) or before the handler attaches onClose. Capture
  // it into shared state so it can still be delivered once the handler does attach.
  const closeState: CloseState = { fired: false, reason: undefined, forward: null, delivered: false };
  ch.onClose((reason?: string) => {
    closeState.fired = true;
    closeState.reason = reason;
    if (closeState.forward) deliverClose(closeState);
  });

  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => decide('fileTransfer'), timeoutMs);
  timer?.unref?.();

  function decide(which: keyof InboundRoutes): void {
    if (decided) return;
    decided = true;
    if (timer) { clearTimeout(timer); timer = null; }
    routes[which](makeReplayed(ch, buffered, closeState));
  }

  ch.onData((chunk: Buffer) => {
    if (decided) { buffered.push(chunk); return; } // makeReplayed drains these too
    buffered.push(chunk);
    let frames;
    try { frames = reader.push(chunk); } catch { decide('fileTransfer'); return; }
    if (!frames.length) return;
    const first = frames[0];
    const isFabric = first.kind === 'control' && (first.msg as { type?: string } | null)?.type === FABRIC_TAG;
    decide(isFabric ? 'fabric' : 'fileTransfer');
  });
}

/** Wrap `ch` so the handler's onData first receives `buffered` (in order), then live chunks;
 *  and its onClose delivers a close — already-fired or still-pending — to whichever
 *  callback was most recently registered (last wins, matching the underlying channel).
 *  Close delivery always goes through deliverClose() (queueMicrotask, once-only) — never
 *  synchronous — and is only queued once `closeState.forward` is set, which happens right
 *  here. So for a handler that attaches onData before onClose (every routed handler in
 *  this file), the drain microtask queued by wrapped.onData above is already in the FIFO
 *  before this can queue the close microtask, and a close therefore never races ahead of
 *  a data drain queued in the same turn. A close that fired before this attach (`fired`
 *  true, forward still null until now) was captured but never queued — it is queued here,
 *  on attach, and still delivers exactly once. */
function makeReplayed(ch: RoutableChannel, buffered: Buffer[], closeState: CloseState): RoutableChannel {
  const wrapped: RoutableChannel = Object.create(ch);
  wrapped.onData = (cb: (d: Buffer) => void) => {
    // Take over the underlying stream: append post-decision chunks to `buffered`
    // until the microtask replay below drains it, preserving order.
    let draining = true;
    ch.onData((d: Buffer) => { if (draining) buffered.push(d); else cb(d); });
    queueMicrotask(() => {
      // Isolate each replayed chunk: a throw from the handler's own frame parsing
      // (e.g. a malformed frame after a valid one) must not abort the drain — an
      // uncaught throw here would leave `draining` stuck true forever, silently
      // swallowing every live chunk from then on.
      try {
        while (buffered.length) {
          const d = buffered.shift() as Buffer;
          try { cb(d); } catch (e) { console.debug('[fabric] inbound replay handler threw:', String((e as Error)?.message ?? e)); }
        }
      } finally {
        draining = false;
      }
    });
  };
  wrapped.onClose = (cb: (r?: string) => void) => {
    closeState.forward = cb; // last registration wins
    if (closeState.fired) deliverClose(closeState); // replay path — still microtask, still once-only
  };
  return wrapped;
}
