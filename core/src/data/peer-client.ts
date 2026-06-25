// core/src/data/peer-client.ts
// HubPeerClient: implements PeerClient using the hub machine-proxy relay.
// Mirrors hub fetch helpers from knowledge/remote-sync.ts.
// This is network code — unit-tested indirectly via the live e2e (Task 8).

import { getHubConfig } from '../hub-client/hub-config';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord } from './types';

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

// ── Hub HTTP Helpers ─────────────────────────────────────────────────────────

function getHubHttpUrl(): string {
  const cfg = getHubConfig();
  return (cfg.hubUrl || '')
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:');
}

async function hubFetch(urlPath: string): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const res = await fetch(`${base}${urlPath}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Hub returned ${res.status} for ${urlPath}`);
  }
  return res.json();
}

interface ProxyGetOptions {
  extraHeaders?: Record<string, string>;
}

async function proxyFetch(node: string, urlPath: string, opts?: ProxyGetOptions): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const proxyUrl = `${base}/api/tier-agent/machines/${node}/proxy${urlPath}`;
  const res = await fetch(proxyUrl, {
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(opts?.extraHeaders ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Proxy request to ${node}${urlPath} returned ${res.status}`);
  }
  return res.json();
}

async function proxyPost(node: string, urlPath: string, body: unknown): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const proxyUrl = `${base}/api/tier-agent/machines/${node}/proxy${urlPath}`;
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Proxy POST to ${node}${urlPath} returned ${res.status}`);
  }
  return res.json();
}

/**
 * Server-side GET proxy via hub machine-relay.
 * Uses the hub Bearer token stored on this node — the browser cannot use this directly.
 * For cross-node operations, call this from a route handler so the local Core proxies for the browser.
 */
export async function proxyGet(node: string, urlPath: string): Promise<unknown> {
  return proxyFetch(node, urlPath);
}

// Re-export proxyPost for callers that need server-side POST proxying (e.g. mission routes).
// The browser cannot use this — it has no hub Bearer token.
export { proxyPost };

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

/** All fleet machine gateway-ids currently `status:"online"` (INCLUDING this node). */
export async function listOnlineNodeIds(): Promise<string[]> {
  const json = (await hubFetch('/api/tier-agent/machines')) as any;
  const machines: any[] = Array.isArray(json) ? json : json.machines || json.data || [];
  return machines
    .filter((m) => (m.status || '').toLowerCase() === 'online')
    .map((m) => (m.gatewayId || m.machineId || m.id) as string)
    .filter((id): id is string => typeof id === 'string' && !!id);
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function getHubPeerClient(): HubPeerClient {
  const cfg = getHubConfig();
  const nodeId = cfg.gatewayId || cfg.machineId || '';
  return new HubPeerClient(nodeId);
}
