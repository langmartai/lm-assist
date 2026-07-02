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

/**
 * Shared kill-switch read (Fix 3): used both to gate PeerManager.reconcile() on
 * every tick (mid-session flips take effect without a restart) and to report
 * getFabricStatus() honestly. Any settings-read failure defaults to enabled —
 * matches the pre-fix boot-time behavior of an unguarded getProjectSettings() call.
 */
function fabricSettingEnabled(): boolean {
  try {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    return getProjectSettings().fabricEnabled;
  } catch {
    return true;
  }
}

export function initFabric(selfNode: string): void {
  // Lazy requires keep boot-order safe (settings/cluster/peer-client each read files).
  if (!fabricSettingEnabled()) { stopFabric(); return; }
  if (mgr && self.node === selfNode) { mgr.retryFailedNow(); return; } // reconnect with same id → keep links, re-kick any failed ones now
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
      selfTcp: () => selfTcpEndpoint,
    }),
    now: () => Date.now(),
    enabled: fabricSettingEnabled,
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

/** This node's direct-TCP endpoint, set by the TCP listener at boot; advertised
 *  to peers in the fabric HELLO so a same-LAN peer can open a kernel-TCP channel. */
let selfTcpEndpoint: import('./protocol').FabricTcpEndpoint | null = null;

export function setFabricSelfTcp(ep: import('./protocol').FabricTcpEndpoint | null): void {
  selfTcpEndpoint = ep;
  // The listener binds AFTER initFabric sent the first HELLOs, so re-advertise
  // on every live link now that our endpoint is known.
  mgr?.readvertiseAll();
}

/** The peer's advertised direct-TCP endpoint (learned via its HELLO on the warm
 *  fabric link), or null if unknown / peer runs no listener / not fabric-linked. */
export function getPeerTcpEndpoint(peer: string): import('./protocol').FabricTcpEndpoint | null {
  return mgr?.peerTcp(peer) ?? null;
}

export function getFabricStatus(): FabricStatus {
  const settingOn = fabricSettingEnabled();
  return { enabled: !!mgr && settingOn, self: { ...self }, peers: mgr ? mgr.snapshot() : [] };
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
