/**
 * Event Loop Monitor
 *
 * Core is single-threaded: any synchronous work on the main thread delays EVERY
 * pending request, no matter how cheap that request's own handler is. That failure
 * mode is invisible to per-handler timing — a handler can report `durationMs: 0`
 * while the client waited seconds, because the wait happened BEFORE the handler ran.
 *
 * This module makes that wait observable:
 *
 *  1. `monitorEventLoopDelay` (perf_hooks) gives objective lag percentiles — the
 *     libuv timer-phase delay, i.e. exactly how long a ready callback had to wait.
 *  2. A drift detector records individual long blocks (a tick that fired late).
 *  3. Section attribution (`timeSection`) lets suspect code report its own
 *     synchronous cost, so a long block can be blamed on a named culprit rather
 *     than merely observed.
 *
 * Overhead is one interval timer plus a native histogram — negligible, and both
 * timers are `unref()`ed so this never keeps the process alive.
 *
 * @packageDocumentation
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

/** A single detected block of the event loop. */
export interface BlockEvent {
  /** ISO timestamp of when the block was observed to end. */
  at: string;
  /** How long the loop was blocked, in ms. */
  ms: number;
  /** Named culprit if a section reported itself, else 'unattributed'. */
  label: string;
}

/** Aggregated cost of one named section. */
export interface SectionStat {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Blocks from this section that exceeded the long-block threshold. */
  longBlocks: number;
}

export interface EventLoopSnapshot {
  running: boolean;
  /** Wall-clock ms covered by this measurement window. */
  windowMs: number;
  /**
   * Event-loop lag percentiles in ms — how long a ready callback waited before
   * running. This is the number that tracks "client wall-clock minus handler time".
   */
  lagMs: { p50: number; p90: number; p99: number; max: number; mean: number };
  /** Long blocks (> thresholdMs) seen in this window. */
  longBlocks: {
    thresholdMs: number;
    count: number;
    totalMs: number;
    maxMs: number;
    /** Share of the window the loop spent inside long blocks. */
    blockedPct: number;
  };
  /** Which named sections cost the most synchronous time, worst first. */
  topBlockers: SectionStat[];
  /** Most recent individual blocks, newest last. */
  recentBlocks: BlockEvent[];
}

const DEFAULT_TICK_MS = 100;
const DEFAULT_BLOCK_THRESHOLD_MS = 200;
const MAX_RECENT_BLOCKS = 50;

export class EventLoopMonitor {
  private histogram: IntervalHistogram | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private windowStart = 0;
  private expectedTickAt = 0;

  private recentBlocks: BlockEvent[] = [];
  private blockCount = 0;
  private blockTotalMs = 0;
  private blockMaxMs = 0;

  private sections = new Map<string, SectionStat>();
  /** Last section that finished — used to attribute a detected block. */
  private lastSection: { label: string; endedAt: number; ms: number } | null = null;

  constructor(
    private readonly tickMs = DEFAULT_TICK_MS,
    private readonly blockThresholdMs = DEFAULT_BLOCK_THRESHOLD_MS,
  ) {}

  /** Begin measuring. Idempotent. */
  start(): void {
    if (this.tickTimer) return;
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
    this.windowStart = Date.now();
    this.expectedTickAt = Date.now() + this.tickMs;

    this.tickTimer = setInterval(() => this.onTick(), this.tickMs);
    // Never hold the process open just to measure it.
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.histogram?.disable();
    this.histogram = null;
  }

  /**
   * Drift detector: this interval was scheduled to fire at `expectedTickAt`.
   * Anything beyond that is time the loop was unavailable.
   */
  private onTick(): void {
    const now = Date.now();
    const drift = now - this.expectedTickAt;
    this.expectedTickAt = now + this.tickMs;
    if (drift >= this.blockThresholdMs) {
      this.recordBlock(drift, now);
    }
  }

  /**
   * Attribute a block. A section that finished inside this block and accounts for
   * most of it is named as the culprit; otherwise the block is 'unattributed'
   * (which is itself a useful signal — it means an uninstrumented code path).
   */
  private recordBlock(ms: number, now: number): void {
    let label = 'unattributed';
    const last = this.lastSection;
    if (last && now - last.endedAt <= ms + this.tickMs && last.ms >= ms * 0.5) {
      label = last.label;
      const stat = this.sections.get(last.label);
      if (stat) stat.longBlocks++;
    }
    this.blockCount++;
    this.blockTotalMs += ms;
    if (ms > this.blockMaxMs) this.blockMaxMs = ms;
    this.recentBlocks.push({ at: new Date(now).toISOString(), ms: Math.round(ms), label });
    if (this.recentBlocks.length > MAX_RECENT_BLOCKS) this.recentBlocks.shift();
  }

  /** Record that a named synchronous section took `ms`. */
  recordSection(label: string, ms: number): void {
    let stat = this.sections.get(label);
    if (!stat) {
      stat = { label, count: 0, totalMs: 0, maxMs: 0, longBlocks: 0 };
      this.sections.set(label, stat);
    }
    stat.count++;
    stat.totalMs += ms;
    if (ms > stat.maxMs) stat.maxMs = ms;
    this.lastSection = { label, endedAt: Date.now(), ms };
  }

  /** Reset counters so a before/after comparison measures a clean window. */
  reset(): void {
    this.histogram?.reset();
    this.windowStart = Date.now();
    this.recentBlocks = [];
    this.blockCount = 0;
    this.blockTotalMs = 0;
    this.blockMaxMs = 0;
    this.sections.clear();
    this.lastSection = null;
  }

  snapshot(): EventLoopSnapshot {
    const h = this.histogram;
    const windowMs = Math.max(1, Date.now() - this.windowStart);
    const ns2ms = (n: number) => Math.round((n / 1e6) * 100) / 100;
    return {
      running: this.tickTimer !== null,
      windowMs,
      lagMs: h
        ? {
            p50: ns2ms(h.percentile(50)),
            p90: ns2ms(h.percentile(90)),
            p99: ns2ms(h.percentile(99)),
            max: ns2ms(h.max),
            mean: ns2ms(h.mean),
          }
        : { p50: 0, p90: 0, p99: 0, max: 0, mean: 0 },
      longBlocks: {
        thresholdMs: this.blockThresholdMs,
        count: this.blockCount,
        totalMs: Math.round(this.blockTotalMs),
        maxMs: Math.round(this.blockMaxMs),
        blockedPct: Math.round((this.blockTotalMs / windowMs) * 1000) / 10,
      },
      topBlockers: [...this.sections.values()]
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 10)
        .map(s => ({ ...s, totalMs: Math.round(s.totalMs), maxMs: Math.round(s.maxMs) })),
      recentBlocks: this.recentBlocks.slice(-20),
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: EventLoopMonitor | null = null;

export function getEventLoopMonitor(): EventLoopMonitor {
  if (!instance) instance = new EventLoopMonitor();
  return instance;
}

/**
 * Time an async section and attribute its synchronous cost.
 *
 * NOTE: this measures wall-clock across the whole call, so for a genuinely async
 * section it reports elapsed time rather than blocking time. It is meant for the
 * suspects — code that is synchronous or only nominally async — where the two are
 * the same. Attribution only claims a block when the section's own cost accounts
 * for most of the observed drift, so an async section that merely waited will not
 * be blamed for a block it did not cause.
 */
export async function timeSection<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    getEventLoopMonitor().recordSection(label, Date.now() - t0);
  }
}

/** Synchronous variant of {@link timeSection}. */
export function timeSectionSync<T>(label: string, fn: () => T): T {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    getEventLoopMonitor().recordSection(label, Date.now() - t0);
  }
}
