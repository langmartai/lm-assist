// core/src/cluster/cluster-store.ts
// Fleet-wide cluster identity datasets (node-clusters + cluster-meta).
// Publishes THIS node's {gatewayId,cluster,hostname,ts} into node-clusters;
// peers pull it via the cross-node sync (M5 / data-service syncMode:'full', scope:'fleet').
import { getDataService, type CallCtx } from '../data/data-service';
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster, clusterName } from './cluster-config';
import type { ClusterRecord } from './cluster-map';
import type { DataRecord } from '../data/types';

const NODE_CLUSTERS = 'node-clusters';
const CLUSTER_META = 'cluster-meta';

// Mirror mission-store.ts:60 — same pattern for a "system" internal caller.
function systemCtx(): CallCtx { return { principal: { type: 'local' } } as CallCtx; }

function selfId(): string {
  const c = getHubConfig();
  return c.gatewayId || c.machineId || '';
}

function rec(id: string, fields: Record<string, unknown>): DataRecord {
  const now = new Date().toISOString();
  return { id, version: 0, fields, createdAt: now, updatedAt: now };
}

// ── Pure mapper (exported for unit tests) ────────────────────────────────────

/**
 * Map raw data-service rows to ClusterRecord[].
 * Normalizes `cluster` via clusterName(); skips rows without a string gatewayId.
 */
export function recordsToClusterRecords(
  rows: Array<{ fields?: Record<string, unknown> }>,
): ClusterRecord[] {
  return (rows || [])
    .map((r) => r.fields || {})
    .filter((f) => typeof f.gatewayId === 'string' && !!f.gatewayId)
    .map((f) => ({
      gatewayId: f.gatewayId as string,
      cluster: clusterName(f.cluster as string),
      hostname: f.hostname as string | undefined,
    }));
}

// ── Dataset bootstrap (idempotent, mirror mission-store.ts:79-88) ────────────

let ensured = false;

export async function ensureClusterDatasets(): Promise<void> {
  const svc = getDataService();
  if (!svc.isEnabled() || ensured) return;
  for (const [id, title] of [
    [NODE_CLUSTERS, 'Node Clusters'],
    [CLUSTER_META, 'Cluster Meta'],
  ] as const) {
    try {
      // cross-node-readable: cloud callers can read via connector with an access key.
      // syncMode:'full' + scope:'fleet': converges across ALL clusters (no cluster boundary).
      await svc.createDataset(systemCtx(), {
        id,
        backend: 'cache',
        title,
        visibility: 'cross-node-readable',
        syncMode: 'full',
        scope: 'fleet',
        config: { kind: 'cache' },
      } as any);
    } catch { /* already exists — fine (mirror mission-store ensureDataset) */ }
  }
  ensured = true;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Publish THIS node's cluster membership into `node-clusters`. */
export async function publishSelf(): Promise<void> {
  const svc = getDataService();
  if (!svc.isEnabled()) return;
  await ensureClusterDatasets();
  const id = selfId();
  if (!id) return;
  await svc.put(
    systemCtx(),
    NODE_CLUSTERS,
    rec(id, {
      gatewayId: id,
      cluster: getMyCluster(),
      hostname: getHubConfig().hostname || '',
      ts: Date.now(),
    }),
  );
}

// ── Read ──────────────────────────────────────────────────────────────────────

/** All node cluster membership records from the fleet-wide dataset. */
export async function getClusterRecords(): Promise<ClusterRecord[]> {
  const svc = getDataService();
  if (!svc.isEnabled()) return [];
  try {
    await ensureClusterDatasets();
    const r = await svc.query(systemCtx(), NODE_CLUSTERS, { limit: 1000 } as any);
    return r.ok ? recordsToClusterRecords(r.value.records) : [];
  } catch { return []; }
}

/** All cluster meta entries (descriptive annotations, optional status). */
export async function getClusterMeta(): Promise<Array<{
  name: string;
  description?: string;
  status?: string;
  ts?: number;
}>> {
  const svc = getDataService();
  if (!svc.isEnabled()) return [];
  try {
    await ensureClusterDatasets();
    const r = await svc.query(systemCtx(), CLUSTER_META, { limit: 1000 } as any);
    if (!r.ok) return [];
    return r.value.records.map((x) => ({
      name: x.fields?.name as string,
      description: x.fields?.description as string | undefined,
      status: x.fields?.status as string | undefined,
      ts: x.fields?.ts as number | undefined,
    }));
  } catch { return []; }
}

/** Upsert a cluster meta annotation. */
export async function setClusterMeta(
  name: string,
  description?: string,
  status?: string,
): Promise<void> {
  const svc = getDataService();
  if (!svc.isEnabled()) return;
  await ensureClusterDatasets();
  const n = clusterName(name);
  await svc.put(
    systemCtx(),
    CLUSTER_META,
    rec(n, { name: n, description, status, ts: Date.now() }),
  );
}
