'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { dedupedRequest } from '@/lib/request-dedupe';

export interface ClusterMember {
  gatewayId: string;
  online: boolean;
  hostname?: string;
}

export interface Cluster {
  name: string;
  members: ClusterMember[];
  leader: string | null;
  description?: string;
  status?: string;
}

export interface ClusterList {
  clusters: Cluster[];
  myCluster: string;
}

const NAMED_BADGES = [
  'badge-blue', 'badge-green', 'badge-purple', 'badge-orange',
  'badge-cyan', 'badge-pink', 'badge-amber', 'badge-yellow',
];

/** Deterministic badge color class per cluster name; 'default' is always neutral. */
export function clusterBadge(name: string): string {
  if (!name || name === 'default') return 'badge-default';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAMED_BADGES[h % NAMED_BADGES.length];
}

/**
 * Fleet cluster map + mutations, backed by the Core /cluster/* routes.
 * /cluster/list returns the fleet-wide map (every node's cluster) from whichever
 * node serves it, so a single fetch covers all nodes. Writes (assign/unassign/
 * describe) proxy to the target node over the hub relay and then refresh.
 */
export function useClusters() {
  const { apiClient, proxy } = useAppMode();
  const [data, setData] = useState<ClusterList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const machineId = proxy.machineId || undefined;

  /**
   * @param force Bypass the read dedupe. Always set after a write — an assign/
   *   unassign/describe must never be followed by a cached pre-write list.
   */
  const load = useCallback(async (force = false) => {
    setError(null);
    try {
      // Deduped: /cluster/list is fetched on mount and again when the api client
      // upgrades local->hybrid, and both the machine dropdown and any cluster
      // page ask for the same fleet-wide map. There is no poller here.
      const d = await dedupedRequest(
        `cluster-list:${machineId ?? 'self'}`,
        3000,
        () => apiClient.fetchPath<ClusterList>('/cluster/list', { machineId }),
        { force },
      );
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiClient, machineId]);

  /** Public refresh is always authoritative (user-initiated). */
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // gatewayId -> cluster name, for badging nodes in the dropdown/elsewhere.
  // Keyed by BOTH gatewayId and hostname so a node string in either form resolves.
  const clusterByGateway = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.clusters ?? []) {
      for (const mem of c.members) {
        m.set(mem.gatewayId, c.name);
        if (mem.hostname) m.set(mem.hostname, c.name);
      }
    }
    return m;
  }, [data]);

  const assignNode = useCallback(
    async (node: string, cluster: string) => {
      await apiClient.fetchPath('/cluster/assign', {
        method: 'POST',
        body: { node, cluster },
        machineId,
      });
      await refresh();
    },
    [apiClient, machineId, refresh],
  );

  const unassignNode = useCallback(
    async (node: string) => {
      await apiClient.fetchPath('/cluster/unassign', {
        method: 'POST',
        body: { node },
        machineId,
      });
      await refresh();
    },
    [apiClient, machineId, refresh],
  );

  const describeCluster = useCallback(
    async (cluster: string, description: string, status?: string) => {
      await apiClient.fetchPath('/cluster/describe', {
        method: 'POST',
        body: { cluster, description, status },
        machineId,
      });
      await refresh();
    },
    [apiClient, machineId, refresh],
  );

  return {
    clusters: data?.clusters ?? [],
    myCluster: data?.myCluster ?? 'default',
    clusterByGateway,
    loading,
    error,
    refresh,
    assignNode,
    unassignNode,
    describeCluster,
  };
}
