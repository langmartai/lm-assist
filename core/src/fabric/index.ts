/**
 * Fabric singleton. initFabric(selfNode) is called from the hub-client's
 * `authenticated` handler (the same place initTransport runs, so gatewayId is
 * known). Gated on projectSettings.fabricEnabled — the W1 kill-switch.
 */
import { openChannel } from '../transport';
import { PeerLink, type PeerLinkSnapshot, type LinkChannel } from './peer-link';
import { PeerManager, type PeerLinkLike } from './peer-manager';

export interface FabricStatus {
  enabled: boolean;
  self: { node: string; cluster: string };
  peers: PeerLinkSnapshot[];
}

interface FabricTestDeps {
  selfNode: string;
  cluster: string;
  listPeers: () => Promise<string[]>;
  makeLink: (peer: string) => PeerLinkLike;
}

let mgr: PeerManager | null = null;
let self = { node: '', cluster: 'default' };

export function initFabric(selfNode: string): void {
  // Lazy requires keep boot-order safe (settings/cluster/peer-client each read files).
  const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
  if (!getProjectSettings().fabricEnabled) { stopFabric(); return; }
  if (mgr && self.node === selfNode) return; // reconnect with same id → keep links
  stopFabric();
  const { getMyCluster } = require('../cluster/cluster-config') as typeof import('../cluster/cluster-config');
  const { listOnlineNodeIds } = require('../data/peer-client') as typeof import('../data/peer-client');
  self = { node: selfNode, cluster: safeCluster(getMyCluster) };
  mgr = new PeerManager({
    listPeers: async () => (await listOnlineNodeIds()).filter((id) => id !== selfNode),
    makeLink: (peer) => new PeerLink(peer, {
      openChannel: (p) => openChannel(p) as unknown as Promise<LinkChannel>,
      selfNode,
      now: () => Date.now(),
    }),
    now: () => Date.now(),
  });
  mgr.start();
}

function safeCluster(getMyCluster: () => string): string {
  try { return getMyCluster(); } catch { return 'default'; }
}

export function stopFabric(): void {
  mgr?.stop();
  mgr = null;
}

export function getFabricStatus(): FabricStatus {
  return { enabled: !!mgr, self: { ...self }, peers: mgr ? mgr.snapshot() : [] };
}

/** Inbound fabric channel (routed by inbound-router). */
export function fabricAcceptInbound(ch: unknown): void {
  mgr?.acceptInbound(ch as { peerGatewayId?: string });
}

/** Test seam: init with fully injected deps (no transport/hub). */
export function __initFabricForTest(deps: FabricTestDeps): void {
  stopFabric();
  self = { node: deps.selfNode, cluster: deps.cluster };
  mgr = new PeerManager({ listPeers: deps.listPeers, makeLink: deps.makeLink, now: () => Date.now() });
}
