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
}

const DEFAULT_HELLO_TIMEOUT_MS = 5000;

export class PeerLink {
  core: LinkCore;
  private ch: LinkChannel | null = null;
  private counters = { helloOk: 0, helloTimeouts: 0, inboundAdopted: 0 };

  constructor(readonly peer: string, private deps: PeerLinkDeps) {
    this.core = { state: 'discovered', since: deps.now(), attempts: 0, lastError: null };
  }

  private hello(kind: FabricHello['kind']): Buffer {
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features: ['status'], node: this.deps.selfNode });
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
    } else {
      this.counters.helloTimeouts++;
      this.reduce({ type: 'hello-timeout' });
      try { ch.close(); } catch { /* best-effort */ }
      this.ch = null;
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
          ch.sendControl(this.hello('hello-ack'));
          this.reduce({ type: 'hello-ok' });
          this.counters.helloOk++;
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
          if (f.kind === 'control' && parseFabricControl(f.msg)) {
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
    if (this.ch) { try { this.ch.close(); } catch { /* best-effort */ } this.ch = null; }
    this.reduce({ type: 'peer-offline' });
  }

  close(): void {
    this.markPeerOffline();
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
    };
  }
}
