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

export function routeInboundChannel(ch: RoutableChannel, routes: InboundRoutes, timeoutMs = 3000): void {
  const reader = new FrameReader();
  const buffered: Buffer[] = [];
  let decided = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => decide('fileTransfer'), timeoutMs);

  function decide(which: keyof InboundRoutes): void {
    if (decided) return;
    decided = true;
    if (timer) { clearTimeout(timer); timer = null; }
    routes[which](makeReplayed(ch, buffered));
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

/** Wrap `ch` so the handler's onData first receives `buffered` (in order), then live chunks. */
function makeReplayed(ch: RoutableChannel, buffered: Buffer[]): RoutableChannel {
  const wrapped: RoutableChannel = Object.create(ch);
  wrapped.onData = (cb: (d: Buffer) => void) => {
    // Take over the underlying stream: append post-decision chunks to `buffered`
    // until the microtask replay below drains it, preserving order.
    let draining = true;
    ch.onData((d: Buffer) => { if (draining) buffered.push(d); else cb(d); });
    queueMicrotask(() => {
      while (buffered.length) cb(buffered.shift() as Buffer);
      draining = false;
    });
  };
  return wrapped;
}
