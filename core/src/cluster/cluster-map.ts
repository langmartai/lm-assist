// Pure resolvers over the (gatewayId → cluster) records synced via the
// fleet-wide `node-clusters` dataset. No I/O — trivially testable.

export interface ClusterRecord { gatewayId: string; cluster: string; hostname?: string }

function buildMap(records: ClusterRecord[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of records) if (r?.gatewayId) m.set(r.gatewayId, r.cluster || 'default');
  return m;
}

export function clusterOf(gatewayId: string, records: ClusterRecord[], selfId: string | null, selfCluster: string): string {
  if (selfId && gatewayId === selfId) return selfCluster;        // local identity is authoritative for self
  return buildMap(records).get(gatewayId) ?? 'default';
}

export function sameClusterIds(onlineIds: string[], records: ClusterRecord[], selfId: string | null, selfCluster: string): string[] {
  return onlineIds.filter((id) => clusterOf(id, records, selfId, selfCluster) === selfCluster);
}

export function clustersOverview(
  records: ClusterRecord[],
  onlineIds: string[],
  selfId: string | null,
  selfCluster: string,
): Array<{ name: string; members: Array<{ gatewayId: string; online: boolean; hostname?: string }>; leader: string | null }> {
  const onlineSet = new Set(onlineIds);
  // union of all known ids (records + online), resolved to a cluster
  const ids = new Set<string>([...records.map((r) => r.gatewayId), ...onlineIds]);
  const hostById = new Map(records.map((r) => [r.gatewayId, r.hostname]));
  const byCluster = new Map<string, Array<{ gatewayId: string; online: boolean; hostname?: string }>>();
  for (const id of ids) {
    const c = clusterOf(id, records, selfId, selfCluster);
    const arr = byCluster.get(c) ?? [];
    arr.push({ gatewayId: id, online: onlineSet.has(id), hostname: hostById.get(id) });
    byCluster.set(c, arr);
  }
  return [...byCluster.entries()].map(([name, members]) => ({
    name,
    members: members.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId)),
    leader: members.filter((m) => m.online).map((m) => m.gatewayId).sort()[0] ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}
