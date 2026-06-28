/**
 * Cluster management routes.
 *
 *   GET  /cluster/list           → overview of all clusters + their members
 *   POST /cluster/assign         → assign a node to a cluster (proxy to target)
 *   POST /cluster/unassign       → assign a node to 'default' cluster
 *   POST /cluster/describe       → annotate a cluster with description/status
 *   POST /cluster/self           → loopback-only: set THIS node's cluster
 */
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getMyCluster, setMyCluster } from '../../cluster/cluster-config';
import { clustersOverview, type ClusterRecord } from '../../cluster/cluster-map';
import {
  getClusterRecords,
  getClusterMeta,
  setClusterMeta,
  publishSelf,
} from '../../cluster/cluster-store';
import { proxyPost } from '../../data/peer-client';
import { getSyncEngine } from '../../data/data-service';
import { getHubConfig } from '../../hub-client/hub-config';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { notifyLocalWorkersOfClusterChange } from '../../worker-role/cluster-change-notify';

// ── Pure helper (exported for unit tests) ────────────────────────────────────

/**
 * Resolve a `node` argument (gatewayId OR hostname) to a canonical gatewayId.
 *
 *   - Known online gatewayId → passes through unchanged.
 *   - gatewayId found in records (possibly offline) → passes through.
 *   - hostname found in records → returns that record's gatewayId.
 *   - Unknown → null (caller should respond BAD_NODE).
 *
 * PURE — no I/O.
 */
export function resolveNodeId(
  node: string,
  records: ClusterRecord[],
  online: string[],
): string | null {
  if (online.includes(node)) return node;
  const byId = records.find((r) => r.gatewayId === node);
  if (byId) return node;
  const byHost = records.find((r) => r.hostname === node);
  if (byHost) return byHost.gatewayId;
  return null;
}

// ── Hub helper ────────────────────────────────────────────────────────────────

async function fetchAllOnlineIds(): Promise<string[]> {
  const cfg = getHubConfig();
  if (!cfg.hubUrl || !cfg.apiKey) return [];
  try {
    const base = cfg.hubUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const res = await fetch(`${base}/api/tier-agent/machines`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return [];
    const json = await res.json() as any;
    const machines: any[] = Array.isArray(json) ? json : (json.machines || json.data || []);
    return machines
      .filter((m) => String(m?.status || '').toLowerCase() === 'online')
      .map((m) => String(m.gatewayId || m.machineId || m.id || ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createClusterRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /cluster/list — full cluster overview using all online nodes (not cluster-scoped)
    {
      method: 'GET',
      pattern: /^\/cluster\/list$/,
      handler: async () => {
        const start = Date.now();
        const cfg = getHubConfig();
        const selfId = cfg.gatewayId || cfg.machineId || '';
        const [allOnlineIds, records, meta] = await Promise.all([
          fetchAllOnlineIds(),
          getClusterRecords(),
          getClusterMeta(),
        ]);
        const overview = clustersOverview(records, allOnlineIds, selfId, getMyCluster());
        const metaMap = new Map(meta.map((m) => [m.name, m]));
        const clusters = overview.map((c) => ({
          ...c,
          description: metaMap.get(c.name)?.description,
          status: metaMap.get(c.name)?.status,
        }));
        return wrapResponse({ clusters, myCluster: getMyCluster() }, start);
      },
    },

    // POST /cluster/assign {node, cluster} — assign a node to a cluster
    {
      method: 'POST',
      pattern: /^\/cluster\/assign$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { node?: string; cluster?: string };
        if (!b.node || !b.cluster) {
          return wrapError('INVALID_INPUT', 'node and cluster are required', start);
        }
        const cfg = getHubConfig();
        const selfId = cfg.gatewayId || cfg.machineId || '';
        const [records, online] = await Promise.all([getClusterRecords(), fetchAllOnlineIds()]);
        const targetId = resolveNodeId(b.node, records, online);
        if (!targetId) return wrapError('BAD_NODE', `unknown node: ${b.node}`, start);
        if (targetId === selfId) {
          const oldCluster = getMyCluster();
          const cluster = setMyCluster(b.cluster);
          await publishSelf();
          getSyncEngine().reconcile().catch(() => {}); // pull peers now so this node's view converges (push isn't hub-relayed)
          if (oldCluster !== cluster) {
            // Fire-and-forget: tell LOCAL active workers this node moved cluster so a
            // controller/orchestrator can re-place them. Helper never throws.
            notifyLocalWorkersOfClusterChange(oldCluster, cluster).catch(() => {});
          }
          return wrapResponse({ assigned: true, node: selfId, cluster: getMyCluster() }, start);
        }
        const result = await proxyPost(targetId, '/cluster/self', { cluster: b.cluster });
        getSyncEngine().reconcile().catch(() => {}); // pull the target's just-changed record now — no manual /data/sync needed
        return wrapResponse(result, start);
      },
    },

    // POST /cluster/unassign {node} — reset a node's cluster to 'default'
    {
      method: 'POST',
      pattern: /^\/cluster\/unassign$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { node?: string };
        if (!b.node) return wrapError('INVALID_INPUT', 'node is required', start);
        const cfg = getHubConfig();
        const selfId = cfg.gatewayId || cfg.machineId || '';
        const [records, online] = await Promise.all([getClusterRecords(), fetchAllOnlineIds()]);
        const targetId = resolveNodeId(b.node, records, online);
        if (!targetId) return wrapError('BAD_NODE', `unknown node: ${b.node}`, start);
        if (targetId === selfId) {
          const oldCluster = getMyCluster();
          setMyCluster('default');
          await publishSelf();
          getSyncEngine().reconcile().catch(() => {}); // pull peers now so this node's view converges
          if (oldCluster !== 'default') {
            // Fire-and-forget: notify LOCAL active workers; new cluster is 'default'.
            notifyLocalWorkersOfClusterChange(oldCluster, 'default').catch(() => {});
          }
          return wrapResponse({ assigned: true, node: selfId, cluster: 'default' }, start);
        }
        const result = await proxyPost(targetId, '/cluster/self', { cluster: 'default' });
        getSyncEngine().reconcile().catch(() => {}); // pull the target's just-changed record now
        return wrapResponse(result, start);
      },
    },

    // POST /cluster/describe {cluster?, description, status?} — annotate a cluster
    {
      method: 'POST',
      pattern: /^\/cluster\/describe$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = (req.body || {}) as { cluster?: string; description?: string; status?: string };
        if (typeof b.description !== 'string') {
          return wrapError('INVALID_INPUT', 'description is required', start);
        }
        const clusterTarget = typeof b.cluster === 'string' ? b.cluster : getMyCluster();
        await setClusterMeta(clusterTarget, b.description, b.status);
        return wrapResponse({ described: true, cluster: clusterTarget }, start);
      },
    },

    // POST /cluster/self {cluster} — loopback/fleet-internal only
    {
      method: 'POST',
      pattern: /^\/cluster\/self$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const b = (req.body || {}) as { cluster?: string };
        if (!b.cluster) return wrapError('INVALID_INPUT', 'cluster is required', start);
        const oldCluster = getMyCluster();
        const cluster = setMyCluster(b.cluster);
        await publishSelf();
        if (oldCluster !== cluster) {
          // Fire-and-forget: notify LOCAL active workers this node moved cluster so a
          // controller/orchestrator can re-place them. Helper never throws.
          notifyLocalWorkersOfClusterChange(oldCluster, cluster).catch(() => {});
        }
        return wrapResponse({ cluster }, start);
      },
    },
  ];
}
