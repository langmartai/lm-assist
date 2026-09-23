/**
 * Online-peer roster for the bundle layer's ownership guards (spec: "Takeover" step 2 and the
 * import ownership table's OWNER_ONLINE row).
 *
 * It is the SAME peer list the sync engine pulls from — the hub roster filtered to
 * `status=online` (HubPeerClient.listPeers → selectSyncPeers) — so "online" means exactly what
 * replication means by it.
 *
 * The one distinction that matters: a roster that could not be fetched is UNAVAILABLE, never
 * "nobody is online". Treating a hub outage as an empty roster would let a takeover or an
 * import mint a second owner while the real origin is alive — a split brain. Callers refuse
 * ROSTER_UNAVAILABLE unless the operator passes `force`.
 */

import type { ManifestEntry, NodeInfo } from '../types';

export type RosterSnapshot =
  | {
      available: true;
      /** Online peers (this node excluded), keyed by node id (gatewayId). */
      peers: Map<string, NodeInfo>;
      fetchedAt: string;
    }
  | {
      available: false;
      /** Why the roster could not be read (hub not configured, hub down, …). */
      reason: string;
      fetchedAt: string;
    };

/** The seam every ownership guard reads through. Tests inject a fake. */
export interface PeerRoster {
  snapshot(): Promise<RosterSnapshot>;
  /** A peer's sync manifest (the datasets it advertises). Throws when it cannot be read.
   *  Optional: without it the "another online node already OWNS it" probe finds nobody. */
  manifest?(node: string): Promise<ManifestEntry[]>;
  /** Whether `node` is in this node's cluster — a cluster-scoped dataset owned in ANOTHER
   *  cluster is that cluster's own copy, not a competing owner. Default: same cluster. */
  sameCluster?(node: string): Promise<boolean>;
}

/** Who, among the ONLINE peers, already owns a dataset. */
export type OwnerProbe =
  | { kind: 'owner'; peer: NodeInfo }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string };

/**
 * The OWNER_ONLINE guard's second half. Checking only "is the recorded origin online" misses
 * a node that ALREADY took the dataset over (or restored it) while this node's replica still
 * points at the old origin — a takeover or an import-create then mints a second owner that
 * no supersedes marker ever resolves. This reads every online peer's manifest (once per
 * operation — the returned function memoizes) and names the first that advertises the
 * dataset as its own. A manifest that cannot be read makes the answer `unknown`, which
 * callers treat like ROSTER_UNAVAILABLE.
 */
export function ownerProbe(roster: PeerRoster, snapshot: () => Promise<RosterSnapshot>): (id: string, scope?: 'cluster' | 'fleet') => Promise<OwnerProbe> {
  let loaded: Promise<{ entries: Array<{ peer: NodeInfo; list: ManifestEntry[] }>; failures: string[] } | { unavailable: string }> | null = null;
  const load = () => (loaded ??= (async () => {
    const snap = await snapshot();
    if (!snap.available) return { unavailable: snap.reason };
    const entries: Array<{ peer: NodeInfo; list: ManifestEntry[] }> = [];
    const failures: string[] = [];
    if (!roster.manifest) return { entries, failures };
    await Promise.all([...snap.peers.values()].map(async (peer) => {
      try {
        const list = await roster.manifest!(peer.node);
        entries.push({ peer, list: Array.isArray(list) ? list : [] });
      } catch (e) {
        failures.push(`${peer.hostname || peer.node}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
    entries.sort((a, b) => a.peer.node.localeCompare(b.peer.node));
    return { entries, failures };
  })());
  return async (id, scope) => {
    const r = await load();
    if ('unavailable' in r) return { kind: 'unknown', reason: r.unavailable };
    for (const { peer, list } of r.entries) {
      const e = list.find((x) => x && x.id === id && x.ownerNode === peer.node);
      if (!e) continue;
      const s = e.scope ?? scope ?? 'cluster';
      if (s === 'cluster' && roster.sameCluster && !(await roster.sameCluster(peer.node).catch(() => true))) continue;
      return { kind: 'owner', peer };
    }
    if (r.failures.length) return { kind: 'unknown', reason: `could not read the sync manifest of ${r.failures.join('; ')}` };
    return { kind: 'none' };
  };
}

export interface RosterDeps {
  /** Online peers, this node excluded. Throws when the roster cannot be read. */
  listPeers: () => Promise<NodeInfo[]>;
  /** False ⇒ UNAVAILABLE without a network call (no hub URL / key). Default: always true. */
  configured?: () => boolean;
  now?: () => number;
}

/** A roster over any `listPeers` (a PeerClient's, or a test fake). */
export function createRoster(deps: RosterDeps): PeerRoster {
  const now = deps.now ?? Date.now;
  return {
    async snapshot(): Promise<RosterSnapshot> {
      const fetchedAt = new Date(now()).toISOString();
      if (deps.configured && !deps.configured()) {
        return { available: false, reason: 'the hub is not configured on this node, so no fleet roster can be read', fetchedAt };
      }
      let list: NodeInfo[];
      try {
        list = await deps.listPeers();
      } catch (e) {
        return { available: false, reason: `the hub roster could not be read: ${e instanceof Error ? e.message : String(e)}`, fetchedAt };
      }
      if (!Array.isArray(list)) {
        return { available: false, reason: 'the hub roster answered with something that is not a peer list', fetchedAt };
      }
      const peers = new Map<string, NodeInfo>();
      for (const p of list) if (p && typeof p.node === 'string' && p.node) peers.set(p.node, p);
      return { available: true, peers, fetchedAt };
    },
  };
}

/** The production roster: the sync engine's hub peer listing (online, self excluded). */
export function defaultRoster(): PeerRoster {
  let clusterCtx: Promise<{ records: import('../../cluster/cluster-map').ClusterRecord[]; self: string; selfId: string }> | null = null;
  const base = createRoster({
    listPeers: async () => {
      const { getHubPeerClient } = require('../peer-client') as typeof import('../peer-client');
      return getHubPeerClient().listPeers();
    },
    configured: () => {
      try {
        const { isHubConfigured } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
        return isHubConfigured();
      } catch {
        return false;
      }
    },
  });
  return {
    snapshot: () => base.snapshot(),
    async manifest(node: string): Promise<ManifestEntry[]> {
      const { getHubPeerClient } = require('../peer-client') as typeof import('../peer-client');
      return (await getHubPeerClient().manifest(node)).datasets;
    },
    async sameCluster(node: string): Promise<boolean> {
      clusterCtx ??= (async () => {
        const { getClusterRecords } = require('../../cluster/cluster-store') as typeof import('../../cluster/cluster-store');
        const { getMyCluster } = require('../../cluster/cluster-config') as typeof import('../../cluster/cluster-config');
        const { thisNodeId } = require('../paths') as typeof import('../paths');
        return { records: await getClusterRecords(), self: getMyCluster(), selfId: thisNodeId() };
      })();
      const c = await clusterCtx;
      const { clusterOf } = require('../../cluster/cluster-map') as typeof import('../../cluster/cluster-map');
      return clusterOf(node, c.records, c.selfId, c.self) === c.self;
    },
  };
}

/** Online state of one node in a snapshot: true / false, or null when the roster is unavailable. */
export function isOnline(s: RosterSnapshot, node: string | undefined | null): boolean | null {
  if (!s.available) return null;
  return !!node && s.peers.has(node);
}
