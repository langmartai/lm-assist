// Reactive cross-node convergence (spec §5 S2.1): observe the bus for data:<dataset> change-notify
// events and drive a debounced SyncEngine.pullDataset — the bounded replacement for the retired,
// unbounded SyncQueue + dead dataset_updated push. Uses getBus().onLocalEvent (fires for local
// publishes AND cross-node ingests, including catch-up first-sight), so a peer's change converges
// in ~1-2s; the 300s reconcile stays as the safety net. Own-origin events are skipped (a local write
// is already local). onLocalEvent teardown is a clean EventEmitter off() — chosen over Bus.subscribe()
// precisely to avoid W3's subscribe() trailing-delivery + failure-latch caveat (W4 is not a subscribe
// caller); at-least-once pull is instead provided by onLocalEvent re-firing on catch-up + the reconcile.
import type { BusEvent } from '../bus/types';

const DATA_PREFIX = 'data:';

export interface SyncListenerDeps {
  selfNode: () => string;
  pull: (dataset: string, fromNode: string) => Promise<unknown>;
  onLocalEvent: (cb: (e: BusEvent) => void) => (() => void);
  debounceMs?: number;
  maxPending?: number;
}

export class SyncListener {
  private timers = new Map<string, ReturnType<typeof setTimeout>>(); // `${origin}|${dataset}` → debounce timer
  private off: (() => void) | null = null;
  private readonly debounceMs: number;
  private readonly maxPending: number;

  constructor(private deps: SyncListenerDeps) {
    this.debounceMs = deps.debounceMs ?? 300;
    this.maxPending = deps.maxPending ?? 500;
  }

  start(): void {
    if (this.off) return;
    this.off = this.deps.onLocalEvent((e) => this.onEvent(e));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private onEvent(e: BusEvent): void {
    if (!e || typeof e.topic !== 'string' || !e.topic.startsWith(DATA_PREFIX)) return;
    if (e.origin === this.deps.selfNode()) return; // our own write — nothing to pull
    const dataset = e.topic.slice(DATA_PREFIX.length);
    if (!dataset) return;
    this.schedule(dataset, e.origin);
  }

  private schedule(dataset: string, origin: string): void {
    const key = `${origin}|${dataset}`;
    const existing = this.timers.get(key);
    if (existing) { clearTimeout(existing); }
    else if (this.timers.size >= this.maxPending) {
      // Bound the buffer: rather than grow unboundedly under a flood of distinct (origin,dataset)
      // pairs, fire this one immediately (no debounce) — still idempotent, just less coalesced.
      void this.deps.pull(dataset, origin).catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(key);
      void this.deps.pull(dataset, origin).catch(() => {});
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(key, t);
  }
}
