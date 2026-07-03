/**
 * FabricLink — the byte-level transmission plane over ONE connected W1 Channel
 * (spec T1 + client half of T3). Send = compress (T2) → chunk (>64KB, T1) →
 * pace (T5) → write via the channel's DIRECT leg when policy()==='direct', else
 * the relay floor. Receive = reassemble → decompress → deliver: `res`/`pong`
 * resolve a pending call; `req`/`ping` go to the injected server handler. The
 * channel facade (FabricChannel) is built by the fabric singleton from a
 * PeerLink (policy/peerHasFeature) + its LinkChannel (send/sendControl/onData).
 *
 * FabricLink OWNS the channel's onData once constructed (the sole reader of a
 * connected link) — it MUST forward re-advertised W1 hello frames (0x00) back
 * out via `onHello` so W1's TCP-endpoint re-advertise + link-state keep
 * working; dropping them regresses W1 (see peer-link.ts `readvertise()`).
 */
import {
  encodeEnvelope, encodeBody, FabricFrameReader,
  type Envelope, type TrafficClass,
} from './envelope';
import { splitEnvelope, ChunkAssembler } from './chunking';
import { PendingCalls } from './pending-calls';
import { chooseCompression, applyCompression, decompressPayload } from './compression';
import { LinkMetrics, ClassScheduler } from './metrics';

export interface FabricChannel {
  peer: string;
  policy(): 'direct' | 'relay';
  peerHasFeature(f: string): boolean;
  send(b: Buffer): void;
  sendControl(b: Buffer): void;
  onData(cb: (d: Buffer) => void): void;
}

export type ServerReply = (env: Envelope) => void;
export type ServerHandler = (env: Envelope, reply: ServerReply) => void;

export interface FabricLinkDeps {
  metrics?: LinkMetrics;
  scheduler?: ClassScheduler;
  onServer?: ServerHandler;
  /** Forwarded re-advertised W1 hello frames (0x00) — FabricLink is the sole
   *  reader after connect, so it hands hellos back (e.g. a peer TCP endpoint
   *  that binds after the link came up). */
  onHello?: (hello: import('./protocol').FabricHello) => void;
  compressionEnabled?: () => boolean;
  now?: () => number;
  requestTimeoutMs?: number;
  genId?: () => string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const VALID_CLASSES: ReadonlySet<TrafficClass> = new Set(['control', 'rpc', 'bus', 'bulk']);

export function classOf(env: Envelope): TrafficClass {
  if (env.headers.cls && VALID_CLASSES.has(env.headers.cls)) return env.headers.cls;
  switch (env.kind) {
    case 'ping': case 'pong': return 'control';
    case 'pub': return 'bus';
    case 'xfer': return 'bulk';
    default: return 'rpc'; // req/res/chunk
  }
}

let idCounter = 0;
function defaultId(): string { return `${Date.now().toString(36)}-${(idCounter++).toString(36)}`; }

export class FabricLink {
  metrics: LinkMetrics;
  private scheduler: ClassScheduler;
  private pending = new PendingCalls();
  private reader = new FabricFrameReader();
  private assembler = new ChunkAssembler();
  private compressionEnabled: () => boolean;
  private now: () => number;
  private requestTimeoutMs: number;
  private genId: () => string;

  constructor(private ch: FabricChannel, private deps: FabricLinkDeps = {}) {
    this.metrics = deps.metrics ?? new LinkMetrics(deps.now);
    this.scheduler = deps.scheduler ?? new ClassScheduler({}, deps.now);
    this.compressionEnabled = deps.compressionEnabled ?? (() => true);
    this.now = deps.now ?? (() => Date.now());
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.genId = deps.genId ?? defaultId;
    ch.onData((d) => this.onData(d));
  }

  private onData(chunk: Buffer): void {
    for (const inb of this.reader.push(chunk)) {
      if (inb.kind === 'hello') { this.deps.onHello?.(inb.hello); continue; } // re-advertised W1 hello
      const whole = this.assembler.accept(inb.env);
      if (!whole) continue;
      let payload: Uint8Array;
      try {
        payload = decompressPayload(whole.payload, whole.headers.comp ?? 'none', whole.headers.rawLen ?? whole.payload.length);
      } catch { continue; }
      const env: Envelope = { ...whole, payload };
      this.metrics.recordIn(classOf(env), whole.payload.length);
      this.dispatch(env);
    }
  }

  private dispatch(env: Envelope): void {
    if (env.kind === 'res' || env.kind === 'pong') { this.pending.resolve(env.id, env); return; }
    if (env.kind === 'ping') { this.sendEnvelope({ kind: 'pong', id: env.id, headers: {}, payload: env.payload }).catch(() => {}); return; }
    if (env.kind === 'req') { this.deps.onServer?.(env, (res) => { this.sendEnvelope(res).catch(() => {}); }); return; }
    // pub/xfer are W3/W4 — ignore in W2
  }

  async sendEnvelope(env: Envelope): Promise<void> {
    const cls = classOf(env);
    const path = this.ch.policy();
    const contentType = typeof env.headers['content-type'] === 'string' ? (env.headers['content-type'] as string) : undefined;
    const decision = chooseCompression({
      len: env.payload.length, path, contentType,
      peerHasGzip: this.ch.peerHasFeature('comp-gzip'), enabled: this.compressionEnabled(), head: env.payload,
    });
    const c = applyCompression(env.payload, decision);
    if (c.comp === 'gzip') this.metrics.recordCompSaved(Math.max(0, env.payload.length - c.bytes.length));
    const wire: Envelope = { ...env, headers: { ...env.headers, comp: c.comp, rawLen: c.rawLen }, payload: c.bytes };
    const frames = splitEnvelope(wire);
    for (const f of frames) {
      const buf = encodeEnvelope(f);
      await this.scheduler.schedule(cls, buf.length);
      if (path === 'direct') this.ch.send(buf); else this.ch.sendControl(buf);
      this.metrics.recordOut(cls, buf.length);
    }
  }

  async request(init: {
    method: string; path: string; body?: unknown; query?: Record<string, string>;
    contentType?: string; reqId?: string; cls?: TrafficClass; timeoutMs?: number;
  }): Promise<Envelope> {
    const id = this.genId();
    const reqId = init.reqId ?? id;
    const payload = encodeBody({ body: init.body ?? null, query: init.query ?? {} });
    const env: Envelope = {
      kind: 'req', id,
      headers: {
        method: init.method, path: init.path, reqId, cls: init.cls ?? 'rpc',
        ...(init.contentType ? { 'content-type': init.contentType } : {}),
      },
      payload,
    };
    const timeoutMs = init.timeoutMs ?? this.requestTimeoutMs;
    const waiter = this.pending.register(id, timeoutMs);
    waiter.catch(() => {}); // don't leave an unobserved rejection if the send fails before we return waiter
    try {
      await this.sendEnvelope(env);
    } catch (e) {
      this.pending.reject(id, e as Error);
      throw e;
    }
    return waiter;
  }

  async ping(payload: Uint8Array = new Uint8Array()): Promise<number> {
    const id = this.genId();
    const start = this.now();
    const env: Envelope = { kind: 'ping', id, headers: { cls: 'control' }, payload };
    const waiter = this.pending.register(id, this.requestTimeoutMs);
    waiter.catch(() => {}); // don't leave an unobserved rejection if the send fails before we return waiter
    try {
      await this.sendEnvelope(env);
    } catch (e) {
      this.pending.reject(id, e as Error);
      throw e;
    }
    await waiter;
    const rtt = this.now() - start;
    this.metrics.recordRtt(rtt);
    return rtt;
  }

  failInflight(err: Error): void {
    this.pending.rejectAll(err);
    this.assembler = new ChunkAssembler(); // drop any partial multi-chunk reassembly on link teardown
  }

  /**
   * The underlying channel changed (a relay→direct upgrade, or any other
   * reconnect — see peer-link.ts's onChannel()) while this SAME FabricLink
   * instance stays attached: fabric/index.ts's attachFabricLink calls this on
   * every swap, right before re-registering this link's reader on the new
   * channel via the (now dynamic) facade. Resets everything tied to the OLD
   * byte stream:
   *  - `reader` (FabricFrameReader): a length-prefix parse mid-flight on the
   *    dead channel is meaningless — actively corrupting — applied to bytes
   *    from a DIFFERENT stream, so it's replaced with a clean instance.
   *    failInflight() does not touch this (a fully-stopped link has no new
   *    stream coming, so there's nothing to protect against); a live swap
   *    does, which is the one thing channelSwapped() adds on top of it.
   *  - `assembler` (ChunkAssembler) + any pending request/ping: both belong
   *    to the dead channel and will never see their `fin`/response there —
   *    reused via failInflight() itself, so this is a swap without tearing
   *    the FabricLink down (object identity + metrics + scheduler survive;
   *    fabric/index.ts never recreates the FabricLink on a swap, only on a
   *    fresh attach for a peer that had none).
   */
  channelSwapped(): void {
    this.reader = new FabricFrameReader();
    this.failInflight(new Error(`fabric channel for ${this.ch.peer} swapped`));
  }
}
