// core/src/cluster/cluster-store.ts
// Fleet-wide cluster identity datasets (node-clusters + cluster-meta).
// Publishes THIS node's {gatewayId,cluster,hostname,ts} into node-clusters;
// peers pull it via the cross-node sync (M5 / data-service syncMode:'full', scope:'fleet').
import { getDataService, type CallCtx } from '../data/data-service';
import { getDatasetRegistry } from '../data/dataset-registry';
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster, clusterName } from './cluster-config';
import type { ClusterRecord } from './cluster-map';
import type { DataRecord, AclRule } from '../data/types';

const NODE_CLUSTERS = 'node-clusters';
const CLUSTER_META = 'cluster-meta';

// Relayed cross-node sync requests resolve to a 'cloud' principal (api-relay tags
// x-relay-source:hub → access-manager.resolvePrincipal → {type:'cloud'}), which is
// granted ONLY what a matching ACL rule allows. Without an ACL these datasets are
// invisible to peers in the sync manifest (syncManifest/evaluateGrants → no read),
// so the map never converges. Grant fleet-wide READ ('*') so any peer can pull it;
// keep writes local (each node publishes only its OWN record via systemCtx/local).
// Mirrors system-datasets.ts GATING_ACL.
export const CLUSTER_ACL: AclRule[] = [
  { principal: '*', actions: ['read', 'query', 'search'] },
  { principal: 'local', actions: ['write', 'delete', 'manage'] },
];

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
      // visibility cross-node-readable + acl '*':read → relayed peers (cloud principals)
      // can pull the dataset to converge. syncMode:'full' + scope:'fleet': converges
      // across ALL clusters (no cluster boundary).
      await svc.createDataset(systemCtx(), {
        id,
        backend: 'cache',
        title,
        visibility: 'cross-node-readable',
        syncMode: 'full',
        scope: 'fleet',
        acl: CLUSTER_ACL,
        config: { kind: 'cache' },
      } as any);
    } catch { /* already exists — fine (mirror mission-store ensureDataset) */ }
    // Ensure the ACL is present even on datasets created by an earlier build: 0.1.120
    // created these WITHOUT an acl, so relayed 'cloud' peers got no read grant and the
    // dataset was omitted from the cross-node sync manifest → the map never converged.
    // Idempotent in-place patch of the existing descriptor (getDatasetRegistry() is the
    // same instance the data service uses). No-ops if the dataset isn't registered.
    try { getDatasetRegistry().update(id, { acl: CLUSTER_ACL }); } catch { /* not registered yet */ }
  }
  ensured = true;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Historically flushed the dirty-record queue so a cluster change converged fast. W4 retired the
 *  SyncQueue + the (already-dead) dataset_updated push: the DataService.put that writes node-clusters
 *  now self-publishes a data:node-clusters change-notify onto the bus (within-cluster convergence),
 *  and the 300s reconcile covers cross-cluster. So this is a no-op kept only for call-site stability. */
async function forceFlush(): Promise<void> {
  /* no-op — change-notify + reconcile replace the retired flushNow */
}

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
  await forceFlush(); // announce the membership change to peers now (don't wait for the flush timer)
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

/**
 * Strict variant for consumers where "couldn't read the map" must NOT look
 * like "there are no clusters" (the monitor election). Disabled data service
 * is a legitimate steady state → empty; a failed ensure/query THROWS.
 */
export async function getClusterRecordsStrict(): Promise<ClusterRecord[]> {
  const svc = getDataService();
  if (!svc.isEnabled()) return [];
  await ensureClusterDatasets();
  const r = await svc.query(systemCtx(), NODE_CLUSTERS, { limit: 1000 } as any);
  if (!r.ok) throw new Error(`cluster map query failed: ${(r as { error?: { message?: string } }).error?.message ?? 'unknown'}`);
  return recordsToClusterRecords(r.value.records);
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
  await forceFlush(); // announce the cluster-meta change to peers now
}
