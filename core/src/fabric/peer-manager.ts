/**
 * Supervises one PeerLink per online in-cluster peer. W1 opens links
 * proactively on roster reconcile (keeps them while the peer is online) —
 * this exercises the fabric fleet-wide and gives /fabric/status real rows;
 * W2's traffic reuses the warm links. Retry pacing uses backoffMs(attempts)
 * measured from the link's `since`.
 */
import { backoffMs, type LinkCore } from './link-state';
import type { PeerLinkSnapshot } from './peer-link';

export interface PeerLinkLike {
  peer: string;
  core: LinkCore;
  open(): Promise<void>;
  adopt(ch: unknown): void;
  close(): void;
  markPeerOffline(): void;
  snapshot(): PeerLinkSnapshot;
}

export interface PeerManagerDeps {
  listPeers(): Promise<string[]>;     // online in-cluster gatewayIds, excluding self
  makeLink(peer: string): PeerLinkLike;
  now(): number;
  reconcileMs?: number;               // default 30s
}

export class PeerManager {
  private links = new Map<string, PeerLinkLike>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  constructor(private deps: PeerManagerDeps) {}

  start(): void {
    if (this.timer) return;
    const ms = this.deps.reconcileMs ?? 30_000;
    this.timer = setInterval(() => { void this.reconcile(); }, ms);
    this.timer.unref?.();
    void this.reconcile();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;       // reentrancy guard (interval + manual)
    this.reconciling = true;
    try {
      let online: string[];
      try { online = await this.deps.listPeers(); } catch { return; } // roster unavailable → keep current state
      const onlineSet = new Set(online);
      for (const [peer, link] of this.links) {
        if (!onlineSet.has(peer) && link.core.state !== 'idle') link.markPeerOffline();
      }
      for (const peer of online) {
        let link = this.links.get(peer);
        if (!link) {
          link = this.deps.makeLink(peer);
          this.links.set(peer, link);
          await link.open();
          continue;
        }
        const s = link.core.state;
        if (s === 'idle' || s === 'discovered') { await link.open(); continue; }
        if (s === 'failed' && this.deps.now() - link.core.since >= backoffMs(link.core.attempts)) {
          await link.open();
        }
        // 'legacy' links are NOT retried here (a legacy peer stays legacy until it
        // reconnects to the hub — the roster event path in a later wave re-HELLOs).
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** Inbound fabric channel from Task 4's demux — adopt on (or create) the peer's link. */
  acceptInbound(ch: { peerGatewayId?: string }): void {
    const peer = ch.peerGatewayId || 'unknown';
    let link = this.links.get(peer);
    if (!link) {
      link = this.deps.makeLink(peer);
      this.links.set(peer, link);
    }
    link.adopt(ch);
  }

  snapshot(): PeerLinkSnapshot[] {
    return [...this.links.values()].map((l) => l.snapshot());
  }
}
