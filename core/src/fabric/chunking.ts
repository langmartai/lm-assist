/**
 * Payload chunking (spec T1): a payload > CHUNK_THRESHOLD is split into frame 0
 * (which keeps the real kind + headers so the receiver knows what it is) plus
 * `chunk` frames, all sharing the envelope `id`. ChunkAssembler keys by id and
 * completes on `fin`. Reassembly is bounded (maxBytes) so a malicious/broken
 * peer cannot exhaust memory.
 */
import type { Envelope, EnvelopeHeaders, FrameKind } from './envelope';

export type Env = Envelope; // re-export alias for terse tests
export const CHUNK_THRESHOLD = 64 * 1024;

export function splitEnvelope(env: Envelope, maxChunk: number = CHUNK_THRESHOLD): Envelope[] {
  if (env.payload.length <= maxChunk) return [env];
  const out: Envelope[] = [];
  let seq = 0;
  for (let off = 0; off < env.payload.length; off += maxChunk) {
    const slice = env.payload.subarray(off, off + maxChunk);
    const fin = off + maxChunk >= env.payload.length;
    if (seq === 0) {
      out.push({ kind: env.kind, id: env.id, headers: { ...env.headers, seq: 0, fin }, payload: slice });
    } else {
      out.push({ kind: 'chunk', id: env.id, headers: { seq, fin }, payload: slice });
    }
    seq++;
  }
  return out;
}

interface Partial {
  kind: FrameKind;
  headers: EnvelopeHeaders;
  parts: Map<number, Uint8Array>;
  total: number;
  finSeq: number | null;
  touchedAt: number;
}

export class ChunkAssembler {
  private open = new Map<string, Partial>();
  constructor(
    readonly maxBytes: number = 32 * 1024 * 1024,
    /** Idle eviction: a partial (frame 0 seen, never `fin`'d — e.g. the peer
     *  died mid-send) is dropped once it has sat untouched this long, so a
     *  stalled reassembly can't leak in `open` forever. */
    private readonly ttlMs: number = 120_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  accept(env: Envelope): Envelope | null {
    this.evictStale();
    if (env.headers.seq === undefined) return env; // whole frame
    const seq = env.headers.seq;
    let p = this.open.get(env.id);
    if (!p) {
      p = { kind: env.kind, headers: {}, parts: new Map(), total: 0, finSeq: null, touchedAt: this.now() };
      this.open.set(env.id, p);
    }
    p.touchedAt = this.now();
    if (seq === 0) {
      p.kind = env.kind;
      p.headers = { ...env.headers };
      delete p.headers.seq;
      delete p.headers.fin;
    }
    if (!p.parts.has(seq)) {
      p.parts.set(seq, env.payload);
      p.total += env.payload.length;
    }
    if (env.headers.fin) p.finSeq = seq;
    if (p.total > this.maxBytes) {
      this.open.delete(env.id);
      return null;
    }
    if (p.finSeq === null || p.parts.size !== p.finSeq + 1) return null;
    const ordered: Uint8Array[] = [];
    for (let i = 0; i <= p.finSeq; i++) {
      const part = p.parts.get(i);
      if (!part) return null;
      ordered.push(part);
    }
    this.open.delete(env.id);
    return { kind: p.kind, id: env.id, headers: p.headers, payload: concat(ordered, p.total) };
  }

  /** Drop any partial untouched for >= ttlMs — called at the top of every
   *  accept() so a peer that sends frame 0 and never fins doesn't hold its
   *  slot in `open` indefinitely. */
  private evictStale(): void {
    const now = this.now();
    for (const [id, p] of this.open) {
      if (now - p.touchedAt >= this.ttlMs) this.open.delete(id);
    }
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
