/**
 * One managed fabric link to a peer. The HELLO handshake rides sendControl
 * (the ALWAYS-present TLS relay floor), so it works before/without a direct
 * leg. Path policy (spec N2): general traffic direct ONLY when via==='host'
 * (same LAN); otherwise the relay floor. W1 carries no payload traffic —
 * policy() is the hook W2's framing will consult per send.
 */
import { FrameReader } from '../file-transfer/frame';
import { encodeFabricControl, parseFabricControl, FABRIC_TAG, FABRIC_VERSION, type FabricHello } from './protocol';
import { reduceLink, type LinkCore, type LinkState } from './link-state';

export interface LinkChannel {
  mode: 'bidi' | 'oneway' | 'relay';
  via: 'host' | 'static' | 'srflx' | null;
  rtt: number | null;
  sendControl(b: Buffer): void;
  onData(cb: (d: Buffer) => void): void;
  onClose(cb: (r?: string) => void): void;
  close(): void;
}

export interface PeerLinkDeps {
  openChannel(peer: string): Promise<LinkChannel>;
  selfNode: string;
  now(): number;
  helloTimeoutMs?: number;
  /** This node's direct-TCP endpoint to advertise in the HELLO, or null if it
   *  runs no TCP listener. Read live at hello-build time. */
  selfTcp?: () => import('./protocol').FabricTcpEndpoint | null;
}

export interface PeerLinkSnapshot {
  peer: string;
  state: LinkState | 'degraded';
  mode: LinkChannel['mode'] | null;
  via: LinkChannel['via'];
  rttMs: number | null;
  pathInUse: 'direct' | 'relay-floor' | 'legacy-proxy' | null;
  since: number;
  lastError: string | null;
  attempts: number;
  counters: { helloOk: number; helloTimeouts: number; inboundAdopted: number };
  /** Peer's advertised direct-TCP endpoint (from its HELLO), for diagnostics. */
  peerTcp?: import('./protocol').FabricTcpEndpoint | null;
}

const DEFAULT_HELLO_TIMEOUT_MS = 5000;

export class PeerLink {
  core: LinkCore;
  private ch: LinkChannel | null = null;
  private counters = { helloOk: 0, helloTimeouts: 0, inboundAdopted: 0 };
  private peerFeatureList: string[] = [];
  private connectedCb: ((ch: LinkChannel) => void) | null = null;
  private connectedFired = false;

  constructor(readonly peer: string, private deps: PeerLinkDeps) {
    this.core = { state: 'discovered', since: deps.now(), attempts: 0, lastError: null };
  }

  private peerTcpEndpoint: import('./protocol').FabricTcpEndpoint | null = null;

  /** The peer's advertised direct-TCP endpoint (from its HELLO), or null. */
  peerTcp(): import('./protocol').FabricTcpEndpoint | null {
    return this.peerTcpEndpoint;
  }

  /**
   * Ingest a peer HELLO delivered POST-connect by the owning FabricLink. W2's
   * FabricLink takes over the channel's onData once it attaches (the sole
   * reader of a connected link — see fabric-link.ts's header comment), so
   * PeerLink's own onData handlers (adopt()'s persistent listener / the
   * awaitFabricReply() promise executor below) never see a hello that arrives
   * after that point. Those pre-W2 handlers both updated `peerTcpEndpoint`
   * inline from ANY parsed control message that carried a `tcp` field,
   * regardless of hello vs hello-ack — this mirrors exactly that one update,
   * nothing else (no re-ack, no state-reduce, no counters — those only apply
   * to the initial handshake, which still runs through adopt()/open() as
   * before). Without this, a peer whose FabricLink attaches before a
   * tcp-bearing hello arrives would keep a stale/null peerTcpEndpoint for the
   * life of the connection, permanently losing the direct-TCP-for-LAN fast
   * path (readvertise() / setFabricSelfTcp→readvertiseAll, W1) until the next
   * full reconnect.
   */
  ingestPeerHello(hello: FabricHello): void {
    if (hello.tcp) this.peerTcpEndpoint = hello.tcp;
  }

  /** Re-send our HELLO on the live link so a peer picks up a self field that
   *  changed after the link came up (e.g. the TCP endpoint, which is set once
   *  the listener binds — after initFabric already sent the first HELLO). */
  readvertise(): void {
    if (this.ch && this.core.state === 'connected') {
      try { this.ch.sendControl(this.hello('hello')); } catch { /* best-effort */ }
    }
  }

  /** Fired once when the link reaches connected (hello-ok), with the live channel. */
  onConnected(cb: (ch: LinkChannel) => void): void {
    this.connectedCb = cb;
    if (this.connectedFired && this.ch) cb(this.ch); // late subscriber on an already-connected link
  }
  peerFeatures(): string[] { return [...this.peerFeatureList]; }
  peerHasFeature(f: string): boolean { return this.peerFeatureList.includes(f); }

  private fireConnected(): void {
    if (this.connectedFired || !this.ch) return;
    this.connectedFired = true;
    try { this.connectedCb?.(this.ch); } catch { /* best-effort */ }
  }

  private hello(kind: FabricHello['kind']): Buffer {
    const tcp = this.deps.selfTcp?.() ?? undefined;
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features: ['status', 'rpc', 'comp-gzip'], node: this.deps.selfNode, ...(tcp ? { tcp } : {}) });
  }

  private reduce(ev: Parameters<typeof reduceLink>[1]): void {
    this.core = reduceLink(this.core, ev, this.deps.now());
  }

  /** Initiator: open a channel, send hello, await any fabric reply (ack or crossed hello). */
  async open(): Promise<void> {
    this.reduce({ type: 'open-requested' });
    let ch: LinkChannel;
    try {
      ch = await this.deps.openChannel(this.peer);
    } catch (e) {
      this.reduce({ type: 'open-failed', error: (e as Error).message });
      return;
    }
    this.attach(ch);
    ch.sendControl(this.hello('hello'));
    const confirmed = await this.awaitFabricReply(ch);
    if (confirmed) {
      this.counters.helloOk++;
      this.reduce({ type: 'hello-ok' });
      this.fireConnected();
    } else {
      this.counters.helloTimeouts++;
      this.reduce({ type: 'hello-timeout' });
      this.ch = null; // null BEFORE close — Channel.close() fires onClose synchronously (reliable.ts teardown)
      try { ch.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * Answerer: adopt an inbound fabric channel (Task 4 routed it; hello replays
   * via onData). Ordering here matters: attach the onData frame reader FIRST,
   * THEN call attach(ch) (which registers onClose). Task 4's inbound router
   * (inbound-router.ts ~L94-104) only guarantees data-before-close delivery
   * ordering when the handler attaches onData before onClose — the onData
   * attach queues the replay drain microtask ahead of any close microtask
   * queued when onClose attaches. Attaching onClose first would risk the
   * replayed hello frame losing the race to a close.
   */
  adopt(ch: LinkChannel): void {
    this.counters.inboundAdopted++;
    const reader = new FrameReader();
    ch.onData((chunk) => {
      let frames; try { frames = reader.push(chunk); } catch { return; }
      for (const f of frames) {
        if (f.kind !== 'control') continue;
        const msg = parseFabricControl(f.msg);
        if (msg?.kind === 'hello') {
          if (msg.tcp) this.peerTcpEndpoint = msg.tcp;
          ch.sendControl(this.hello('hello-ack'));
          this.reduce({ type: 'hello-ok' });
          this.counters.helloOk++;
          this.peerFeatureList = msg.features ?? [];
          this.fireConnected();
        }
      }
    });
    this.attach(ch);
  }

  private attach(ch: LinkChannel): void {
    this.ch = ch;
    ch.onClose((reason) => {
      if (this.ch === ch) {
        this.ch = null;
        this.reduce({ type: 'channel-closed', error: reason });
      }
    });
  }

  private awaitFabricReply(ch: LinkChannel): Promise<boolean> {
    const timeoutMs = this.deps.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    return new Promise((resolve) => {
      const reader = new FrameReader();
      const timer = setTimeout(() => resolve(false), timeoutMs);
      ch.onData((chunk) => {
        let frames; try { frames = reader.push(chunk); } catch { return; }
        for (const f of frames) {
          if (f.kind !== 'control') continue;
          const msg = parseFabricControl(f.msg);
          if (msg) {
            if (msg.tcp) this.peerTcpEndpoint = msg.tcp;
            this.peerFeatureList = msg.features ?? [];
            clearTimeout(timer);
            resolve(true);
            return;
          }
        }
      });
    });
  }

  /** Spec N2 path policy: direct ONLY on a same-LAN host candidate. */
  policy(): 'direct' | 'relay' {
    return this.ch?.via === 'host' ? 'direct' : 'relay';
  }

  markPeerOffline(): void {
    const ch2 = this.ch;
    this.ch = null; // null BEFORE close — Channel.close() fires onClose synchronously (reliable.ts teardown)
    if (ch2) { try { ch2.close(); } catch { /* best-effort */ } }
    this.reduce({ type: 'peer-offline' });
  }

  close(): void {
    this.markPeerOffline();
  }

  /**
   * Hub re-auth (spec N5): a failed link becomes immediately retryable. since=0
   * makes the backoffMs gate in PeerManager.reconcile() pass on the very next
   * tick (now - 0 >= any capped backoff), instead of waiting out the timer.
   */
  resetRetry(): void {
    if (this.core.state === 'failed') this.core = { ...this.core, attempts: 0, since: 0 };
  }

  snapshot(): PeerLinkSnapshot {
    const connected = this.core.state === 'connected' && !!this.ch;
    const degraded = connected && this.ch!.mode === 'relay';
    return {
      peer: this.peer,
      state: degraded ? 'degraded' : this.core.state,
      mode: this.ch?.mode ?? null,
      via: this.ch?.via ?? null,
      rttMs: this.ch?.rtt ?? null,
      pathInUse: connected ? (this.policy() === 'direct' ? 'direct' : 'relay-floor')
        : this.core.state === 'legacy' ? 'legacy-proxy' : null,
      since: this.core.since,
      lastError: this.core.lastError,
      attempts: this.core.attempts,
      counters: { ...this.counters },
      peerTcp: this.peerTcpEndpoint,
    };
  }
}
