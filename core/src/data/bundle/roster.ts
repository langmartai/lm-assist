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

import type { NodeInfo } from '../types';

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
  return createRoster({
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
}

/** Online state of one node in a snapshot: true / false, or null when the roster is unavailable. */
export function isOnline(s: RosterSnapshot, node: string | undefined | null): boolean | null {
  if (!s.available) return null;
  return !!node && s.peers.has(node);
}
