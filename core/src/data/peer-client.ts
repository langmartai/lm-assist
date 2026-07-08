// core/src/data/peer-client.ts
// HubPeerClient: implements PeerClient using the hub machine-proxy relay.
// Mirrors hub fetch helpers from knowledge/remote-sync.ts.
// This is network code — unit-tested indirectly via the live e2e (Task 8).

import { getHubConfig } from '../hub-client/hub-config';
import { hubFetch, proxyFetch, proxyPost, proxyGet } from '../hub-client/hub-proxy';
import { sameClusterIds } from '../cluster/cluster-map';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord } from './types';
import type { ClusterRecord } from '../cluster/cluster-map';

// ── Peer selection helper ────────────────────────────────────────────────────

/**
 * Pure helper: given the raw machines array from the hub `/api/tier-agent/machines`
 * endpoint, return only online peers (status === 'online') excluding this node.
 *
 * Keeping this as a standalone pure function makes it trivial to unit-test without
 * any network or hub dependency.
 */
export function selectSyncPeers(machines: any[], selfId: string): NodeInfo[] {
  return machines
    .filter((m) => (m.status || '').toLowerCase() === 'online')
    .map((m: any) => ({
      node: (m.gatewayId || m.machineId || m.id) as string,
      hostname: (m.hostname || m.machineHostname || '') as string,
      platform: (m.platform || m.machineOS || m.os || '') as string,
    }))
    .filter((m) => m.node && m.node !== selfId);
}

/**
 * Pure helper: filter online ids to those in the same cluster as selfCluster.
 * Delegates to sameClusterIds for deterministic cluster membership resolution.
 */
export function filterOnlineToCluster(
  allOnline: string[],
  records: ClusterRecord[],
  selfId: string | null,
  selfCluster: string,
): string[] {
  return sameClusterIds(allOnline, records, selfId, selfCluster);
}

// ── Hub HTTP helpers ─────────────────────────────────────────────────────────
// Canonical impl now lives in ../hub-client/hub-proxy (imported above). Re-exported here so
// existing importers (mission/cluster/fleet routes, resolution, node-builds, auth-status) keep
// importing proxyPost/proxyGet FROM peer-client unchanged.
export { proxyPost, proxyGet };

// ── Error code helpers ───────────────────────────────────────────────────────

const AUTH_DENY_CODES = new Set(['KEY_REQUIRED', 'KEY_EXPIRED', 'KEY_INVALID', 'KEY_REVOKED', 'KEY_WRONG_NODE']);

function isAuthDenial(json: unknown): boolean {
  if (json && typeof json === 'object') {
    const code = (json as any).error?.code ?? (json as any).code;
    if (typeof code === 'string' && AUTH_DENY_CODES.has(code)) return true;
  }
  return false;
}

// ── HubPeerClient ────────────────────────────────────────────────────────────

export class HubPeerClient implements PeerClient {
  // Cache: keyed by "node:dataset", stores { key, expMs }
  private keyCache = new Map<string, { key: string; expMs: number }>();

  constructor(private nodeId: string) {}

  /**
   * Mint (or return a cached) scoped read key for a given peer dataset.
   * The key is valid on the peer node and presented as x-lm-access-key on
   * proxied GETs so `enforce` accepts the cloud-principal request.
   */
  private async keyFor(node: string, dataset: string): Promise<string | null> {
    const cacheKey = `${node}:${dataset}`;
    const cached = this.keyCache.get(cacheKey);
    // Use cached key if it won't expire in the next 30 seconds
    if (cached && cached.expMs - Date.now() > 30_000) return cached.key;
    try {
      const res = await proxyPost(node, '/data/access', {
        intent: 'lm-assist cross-node sync',
        grants: [{ dataset, actions: ['read'] }],
      });
      const data = (res as any).data ?? res;
      if (!data?.key) return null;
      this.keyCache.set(cacheKey, {
        key: data.key,
        expMs: Date.parse(data.expiresAt) || (Date.now() + 3_000_000),
      });
      return data.key;
    } catch {
      return null;
    }
  }

  /** Invalidate cached key for a peer+dataset so the next call re-mints. */
  private evictKey(node: string, dataset: string): void {
    this.keyCache.delete(`${node}:${dataset}`);
  }

  async listPeers(): Promise<NodeInfo[]> {
    const json = await hubFetch('/api/tier-agent/machines') as any;
    const machines: any[] = Array.isArray(json) ? json : (json.machines || json.data || []);
    return selectSyncPeers(machines, this.nodeId);
  }

  async manifest(node: string): Promise<{ node: string; datasets: ManifestEntry[] }> {
    const json = await proxyFetch(node, '/data/sync/manifest') as any;
    const raw = json.data || json;
    // raw is { node, datasets: [{id,syncMode,ownerNode,backend},...] }
    return {
      node: raw.node ?? node,
      datasets: Array.isArray(raw.datasets) ? raw.datasets : [],
    };
  }

  async exportFrom(node: string, dataset: string, since?: string): Promise<DataRecord[]> {
    const urlPath = `/data/${encodeURIComponent(dataset)}/export`;
    const body: Record<string, string> = {};
    if (since) body.since = since;

    const key = await this.keyFor(node, dataset);
    if (key) body.key = key;

    let json: unknown;
    try {
      json = await proxyPost(node, urlPath, body);
    } catch {
      return [];
    }

    // If the response contains an auth denial, invalidate and retry once with a fresh key
    if (isAuthDenial(json)) {
      this.evictKey(node, dataset);
      const freshKey = await this.keyFor(node, dataset);
      if (!freshKey) return [];
      try {
        json = await proxyPost(node, urlPath, { ...body, key: freshKey });
      } catch {
        return [];
      }
      if (isAuthDenial(json)) return [];
    }

    const raw = (json as any).data || json;
    // envelope: { records: [...] } or direct array
    return Array.isArray(raw) ? raw : (raw.records ?? []);
  }

  async getFrom(node: string, dataset: string, id: string): Promise<DataRecord | null> {
    const urlPath = `/data/${encodeURIComponent(dataset)}/fetch`;

    const key = await this.keyFor(node, dataset);
    const body: Record<string, string> = { id };
    if (key) body.key = key;

    let json: unknown;
    try {
      json = await proxyPost(node, urlPath, body);
    } catch {
      return null;
    }

    // If the response contains an auth denial, invalidate and retry once with a fresh key
    if (isAuthDenial(json)) {
      this.evictKey(node, dataset);
      const freshKey = await this.keyFor(node, dataset);
      if (!freshKey) return null;
      try {
        json = await proxyPost(node, urlPath, { id, key: freshKey });
      } catch {
        return null;
      }
      if (isAuthDenial(json)) return null;
    }

    const raw = (json as any).data ?? json;
    return raw ?? null;
  }
}

/** Shared fetch: all online gateway-ids fleet-wide (no cluster filter). */
async function fetchAllOnlineIds(): Promise<string[]> {
  const json = (await hubFetch('/api/tier-agent/machines')) as any;
  const machines: any[] = Array.isArray(json) ? json : json.machines || json.data || [];
  return machines
    .filter((m) => (m.status || '').toLowerCase() === 'online')
    .map((m) => (m.gatewayId || m.machineId || m.id) as string)
    .filter((id): id is string => typeof id === 'string' && !!id);
}

/** All online gateway-ids fleet-wide (no cluster filter). Used by scope=fleet fan-out. */
export async function listAllOnlineNodeIds(): Promise<string[]> {
  return fetchAllOnlineIds();
}

/** Online gateway-ids IN THIS NODE'S CLUSTER (including self). */
export async function listOnlineNodeIds(): Promise<string[]> {
  const allOnline = await fetchAllOnlineIds();
  const selfId = getHubConfig().gatewayId || getHubConfig().machineId || null;

  // Lazy-import to avoid circular dependency with cluster-store
  const { getClusterRecords } = await import('../cluster/cluster-store');
  const { getMyCluster } = await import('../cluster/cluster-config');

  const records = await getClusterRecords().catch(() => []);
  return filterOnlineToCluster(allOnline, records, selfId, getMyCluster());
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function getHubPeerClient(): HubPeerClient {
  const cfg = getHubConfig();
  const nodeId = cfg.gatewayId || cfg.machineId || '';
  return new HubPeerClient(nodeId);
}
