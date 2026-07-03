/**
 * Per-link bandwidth monitoring + sender-side pacing (spec T5). LinkMetrics
 * keeps a 10s-half-life EWMA of in/out byte rate per class plus RTT + gzip
 * savings, feeding StatusRegistry / /fabric/status / fabric_probe.
 * ClassScheduler enforces optional per-class byte/sec caps via token buckets;
 * class PRIORITY (control > rpc > bus > bulk) is expressed by capping only the
 * lower classes, so higher classes are never throttled and bulk consumes what
 * is left. (A fully weighted fair queue is deferred — see plan Deferred.)
 */
import type { TrafficClass } from './envelope';

const HALF_LIFE_MS = 10_000;
const CLASSES: TrafficClass[] = ['control', 'rpc', 'bus', 'bulk'];

export interface ClassRate { inBps: number; outBps: number; }
export interface LinkMetricsSnapshot {
  perClass: Record<TrafficClass, ClassRate>;
  rttMs: number | null;
  compSavedBytes: number;
  queueDepth: number;
}

class Ewma {
  private rate = 0;   // bytes/sec
  private last: number;
  constructor(private now: () => number) { this.last = now(); }
  add(bytes: number): void {
    const t = this.now();
    this.decay(t);
    const dt = Math.max(1, t - this.last);
    this.rate += (bytes * 1000) / dt * (1 - Math.pow(0.5, dt / HALF_LIFE_MS));
    this.last = t;
  }
  value(): number { this.decay(this.now()); return Math.round(this.rate); }
  private decay(t: number): void {
    const dt = t - this.last;
    if (dt <= 0) return;
    this.rate *= Math.pow(0.5, dt / HALF_LIFE_MS);
    this.last = t;
  }
}

export class LinkMetrics {
  private out: Record<TrafficClass, Ewma>;
  private in: Record<TrafficClass, Ewma>;
  private rtt: number | null = null;
  private compSaved = 0;
  private queue = 0;
  constructor(private now: () => number = () => Date.now()) {
    const mk = () => Object.fromEntries(CLASSES.map((c) => [c, new Ewma(now)])) as Record<TrafficClass, Ewma>;
    this.out = mk(); this.in = mk();
  }
  recordOut(cls: TrafficClass, bytes: number): void { this.out[cls].add(bytes); }
  recordIn(cls: TrafficClass, bytes: number): void { this.in[cls].add(bytes); }
  recordRtt(ms: number): void { this.rtt = ms; }
  recordCompSaved(bytes: number): void { this.compSaved += bytes; }
  setQueueDepth(n: number): void { this.queue = n; }
  snapshot(): LinkMetricsSnapshot {
    const perClass = Object.fromEntries(
      CLASSES.map((c) => [c, { inBps: this.in[c].value(), outBps: this.out[c].value() }]),
    ) as Record<TrafficClass, ClassRate>;
    return { perClass, rttMs: this.rtt, compSavedBytes: this.compSaved, queueDepth: this.queue };
  }
}

export interface ClassCaps { control?: number; rpc?: number; bus?: number; bulk?: number; }

export class ClassScheduler {
  private caps: Map<TrafficClass, number> = new Map();
  private tokens: Map<TrafficClass, number> = new Map();
  private last: Map<TrafficClass, number> = new Map();
  constructor(caps: ClassCaps = {}, private now: () => number = () => Date.now()) {
    for (const c of CLASSES) { if (typeof caps[c] === 'number') this.caps.set(c, caps[c] as number); }
  }
  setCap(cls: TrafficClass, bytesPerSec: number | null): void {
    if (bytesPerSec === null) this.caps.delete(cls); else this.caps.set(cls, bytesPerSec);
  }
  /** Pure: consume `bytes` from the class bucket, returning the ms to wait. */
  reserve(cls: TrafficClass, bytes: number): number {
    const cap = this.caps.get(cls);
    if (!cap || cap <= 0) return 0;
    const t = this.now();
    const last = this.last.get(cls) ?? t;
    const refilled = Math.min(cap, (this.tokens.get(cls) ?? cap) + ((t - last) / 1000) * cap);
    this.last.set(cls, t);
    const after = refilled - bytes;
    this.tokens.set(cls, after);
    return after >= 0 ? 0 : Math.ceil((-after / cap) * 1000);
  }
  async schedule(cls: TrafficClass, bytes: number): Promise<void> {
    const delay = this.reserve(cls, bytes);
    if (delay > 0) await new Promise((r) => { const t = setTimeout(r, delay); t.unref?.(); });
  }
}
