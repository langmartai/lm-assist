/**
 * Bus service (spec §5 S1). Owns publish (local append → fan-out), idempotent
 * ingest (+ local delivery), in-process subscribe with durable cursor advance,
 * a stateless long-poll read, since (catch-up), and a local EventEmitter that
 * feeds the SSE bridge + long-poll wakeups. Fabric fan-out + catch-up are
 * injected (getBus wires them lazily to `../fabric` — see Tasks 7/9) so this
 * core is unit-testable without a live 2-node fabric.
 */
import { EventEmitter } from 'events';
import { BusStore, type TopicSummary } from './bus-store';
import {
  BUS_PAYLOAD_CAP, payloadSize, encodeCursor, decodeCursor, mergeCursor,
  type BusEvent, type BusRef, type BusCursor,
} from './types';

// decodeBody is the msgpack body codec the fabric already loaded (W2). Lazy to
// avoid pulling the fabric graph into a pure bus unit test.
function decodeWireBody(payload: Uint8Array): unknown {
  const { decodeBody } = require('../fabric/envelope') as typeof import('../fabric/envelope');
  return decodeBody(payload);
}

export interface BusDeps {
  store: BusStore;
  selfNode: string;
  fanout?: (e: BusEvent) => void;
  enabled?: () => boolean;
  now?: () => number;
}

export interface ReadResult { events: BusEvent[]; nextCursor: string; }

interface Sub {
  subscriberId: string;
  topic: string;
  handler: (e: BusEvent) => void | Promise<void>;
  /** Per-subscriber delivery queue: events are dispatched one at a time, in enqueue order
   *  (replay first, then live) — never concurrently. See dispatchTo for why this matters. */
  chain: Promise<void>;
  /** Origins whose delivery has failed at least once on THIS Sub instance. Blocks any further
   *  cursor advance for that origin on this subscriber — a later same-origin success must never
   *  max-merge the durable cursor past an earlier event that was never actually delivered. Only
   *  cleared by a fresh subscribe() (a brand-new Sub with an empty set), whose replay re-attempts
   *  from the un-advanced cursor: i.e. the latch clears when a replay redelivers the failed event. */
  failedOrigins: Set<string>;
}

export class Bus {
  private store: BusStore;
  private selfNode: string;
  private fanout: (e: BusEvent) => void;
  private enabled: () => boolean;
  private now: () => number;
  private subs = new Set<Sub>();
  private emitter = new EventEmitter();

  constructor(deps: BusDeps) {
    this.store = deps.store;
    this.selfNode = deps.selfNode;
    this.fanout = deps.fanout ?? (() => {});
    this.enabled = deps.enabled ?? (() => true);
    this.now = deps.now ?? (() => Date.now());
    this.emitter.setMaxListeners(0);
  }

  publish(topic: string, type: string, payload: unknown, opts?: { scope?: 'cluster' | 'fleet'; ref?: BusRef }): BusEvent {
    if (!this.enabled()) throw new Error('bus: disabled (busEnabled=false)');
    if (opts?.ref === undefined && payloadSize(payload) > BUS_PAYLOAD_CAP) {
      throw new Error(`bus: payload exceeds ${BUS_PAYLOAD_CAP}-byte cap — offload it and publish a ref {kind,id} instead`);
    }
    const seq = this.store.nextSeq(topic, this.selfNode);
    const e: BusEvent = {
      topic, origin: this.selfNode, seq, type, at: this.now(),
      ...(opts?.ref ? { ref: opts.ref } : { payload }),
      scope: opts?.scope ?? 'cluster',
    };
    this.store.append(e);
    this.deliverLocal(e);
    this.emitter.emit('event', e);
    try { this.fanout(e); } catch { /* fan-out is fire-and-forget; catch-up heals */ }
    return e;
  }

  /** Idempotent replica merge. Delivers locally + emits ONLY on first sight. No re-fanout (origin fans out; star topology). */
  ingest(e: BusEvent): boolean {
    if (!this.enabled()) return false;
    const isNew = this.store.ingest(e);
    if (isNew) { this.deliverLocal(e); this.emitter.emit('event', e); }
    return isNew;
  }

  ingestFromWire(payload: Uint8Array): boolean {
    const e = decodeWireBody(payload) as BusEvent;
    if (!e || typeof e.topic !== 'string' || typeof e.origin !== 'string' || typeof e.seq !== 'number') return false;
    return this.ingest(e);
  }

  subscribe(subscriberId: string, topic: string, handler: (e: BusEvent) => void | Promise<void>): () => void {
    if (!this.enabled()) return () => {}; // busEnabled=false: no replay, register nothing, inert unsubscribe
    const sub: Sub = { subscriberId, topic, handler, chain: Promise.resolve(), failedOrigins: new Set() };
    this.subs.add(sub);
    // Replay everything after the durable cursor (restart resumes exactly), serialized ahead of any live events.
    const missed = this.store.readSince(topic, this.store.getCursor(subscriberId, topic));
    for (const e of missed) this.enqueue(sub, e);
    return () => { this.subs.delete(sub); };
  }

  private deliverLocal(e: BusEvent): void {
    if (!this.enabled()) return; // mid-life disable: silence existing subscribers for new events
    for (const sub of this.subs) {
      if (sub.topic !== e.topic) continue;
      if (e.seq <= (this.store.getCursor(sub.subscriberId, e.topic)[e.origin] ?? 0)) continue; // already past
      this.enqueue(sub, e);
    }
  }

  /** Chain `e` onto the subscriber's own delivery queue so one subscriber's events are always
   *  handled one at a time, in order — replay events (enqueued synchronously in subscribe(), before
   *  it returns) run ahead of any live events that arrive afterward and get enqueued behind them. */
  private enqueue(sub: Sub, e: BusEvent): void {
    sub.chain = sub.chain.then(() => this.dispatchTo(sub, e)).catch(() => {});
  }

  private async dispatchTo(sub: Sub, e: BusEvent): Promise<void> {
    if (!this.enabled()) return; // mid-life disable: drop silently — not a failure, no cursor movement
    try {
      await sub.handler(e);
      // Advance only if this origin has no outstanding failure on this Sub: a later success must
      // never max-merge the cursor past an earlier event that was never actually delivered.
      if (!sub.failedOrigins.has(e.origin)) {
        this.store.setCursor(sub.subscriberId, e.topic, { [e.origin]: e.seq }); // advance only after success (at-least-once)
      }
    } catch {
      sub.failedOrigins.add(e.origin); // latch: block further cursor advance for this origin until a fresh subscribe() replay
    }
  }

  since(topic: string, cursor: BusCursor): BusEvent[] {
    return this.store.readSince(topic, cursor);
  }

  async read(topic: string, from?: string, waitMs = 0): Promise<ReadResult> {
    const cursor = decodeCursor(from);
    let events = this.store.readSince(topic, cursor);
    if (events.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const off = this.onLocalEvent((e) => { if (e.topic === topic) { cleanup(); resolve(); } });
        const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(waitMs, 25_000));
        timer.unref?.();
        const cleanup = () => { clearTimeout(timer); off(); };
      });
      events = this.store.readSince(topic, cursor);
    }
    let next = cursor;
    for (const e of events) next = mergeCursor(next, { [e.origin]: e.seq });
    return { events, nextCursor: encodeCursor(next) };
  }

  topics(): Array<TopicSummary & { subscribers: number; lag: number }> {
    return this.store.listTopics().map((t) => {
      const subs = [...this.subs].filter((s) => s.topic === t.topic);
      const headTotal = Object.values(t.head).reduce((a, b) => a + b, 0);
      let lag = 0;
      for (const s of subs) {
        const cur = this.store.getCursor(s.subscriberId, t.topic);
        lag = Math.max(lag, headTotal - Object.values(cur).reduce((a, b) => a + b, 0));
      }
      return { ...t, subscribers: subs.length, lag };
    });
  }

  onLocalEvent(cb: (e: BusEvent) => void): () => void {
    this.emitter.on('event', cb);
    return () => this.emitter.off('event', cb);
  }

  /** How a catch-up RPC is issued to a peer for a topic (prod → fabricBusCatchup).
   *  Overridable in tests. Returns the events the peer had beyond our cursor. */
  private catchupCall: (peer: string, topic: string, cursor: BusCursor) => Promise<BusEvent[]> = async (peer, topic, cursor) => {
    const { fabricBusCatchup } = require('../fabric') as typeof import('../fabric');
    const res = await fabricBusCatchup(peer, topic, cursor);
    const data = res.data as { events?: BusEvent[] } | undefined;
    return Array.isArray(data?.events) ? data!.events : [];
  };

  /** Pull everything this peer has that we are missing, across every known topic. */
  async catchupPeer(peer: string): Promise<void> {
    if (!this.enabled()) return;
    for (const topic of this.store.allTopicNames()) {
      try {
        const events = await this.catchupCall(peer, topic, this.store.maxCursor(topic));
        for (const e of events) this.ingest(e);
      } catch { /* peer unreachable / not bus-capable — the interval retries */ }
    }
  }

  /** Slow safety net (spec ~5 min): catch up from every connected bus peer. */
  async reconcile(): Promise<void> {
    if (!this.enabled()) return;
    let peers: string[] = [];
    try { peers = (require('../fabric') as typeof import('../fabric')).fabricBusPeers(); } catch { peers = []; }
    for (const peer of peers) await this.catchupPeer(peer);
  }

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.reconcileTimer) return;
    const ms = Math.max(30_000, Number(process.env.LM_BUS_RECONCILE_MS) || 5 * 60 * 1000);
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, ms);
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
  }

  statusReport(): { verdict: 'ok' | 'warn' | 'error'; summary: string; detail: unknown } {
    if (!this.enabled()) return { verdict: 'ok', summary: 'bus disabled', detail: { enabled: false } };
    const topics = this.topics();
    const backlog = topics.reduce((a, t) => a + t.events, 0);
    const maxLag = topics.reduce((a, t) => Math.max(a, t.lag), 0);
    return {
      verdict: maxLag > 1000 ? 'warn' : 'ok',
      summary: `${topics.length} topics · ${backlog} events · maxLag ${maxLag}`,
      detail: { topics },
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────
let singleton: Bus | null = null;

/** Production Bus: real store, self node + fanout + catch-up from the live fabric. */
export function getBus(): Bus {
  if (singleton) return singleton;
  const fab = require('../fabric') as {
    fabricSelfNode?: () => string;
    fabricBusPeers?: () => string[];
    fabricPublish?: (node: string, e: BusEvent) => void;
  };
  const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
  const os = require('os') as typeof import('os');
  const store = new BusStore();
  singleton = new Bus({
    store,
    selfNode: fab.fabricSelfNode?.() || os.hostname(),
    enabled: () => { try { return getProjectSettings().busEnabled; } catch { return true; } },
    fanout: (e) => {
      // Cluster-scoped by construction: fabricBusPeers() are same-cluster,
      // bus-capable, connected peers (fleet cross-cluster delivery deferred).
      for (const peer of fab.fabricBusPeers?.() ?? []) fab.fabricPublish?.(peer, e);
    },
  });
  singleton.start();
  return singleton;
}

export function __setBusForTest(b: Bus | null): void { singleton = b; }
