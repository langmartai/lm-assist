// core/src/data/peer-client.ts
// HubPeerClient: implements PeerClient using the hub machine-proxy relay.
// Mirrors hub fetch helpers from knowledge/remote-sync.ts.
// This is network code — unit-tested indirectly via the live e2e (Task 8).

import { getHubConfig } from '../hub-client/hub-config';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord } from './types';

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

async function proxyFetch(node: string, urlPath: string): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const proxyUrl = `${base}/api/tier-agent/machines/${node}/proxy${urlPath}`;
  const res = await fetch(proxyUrl, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Proxy request to ${node}${urlPath} returned ${res.status}`);
  }
  return res.json();
}

// ── HubPeerClient ────────────────────────────────────────────────────────────

export class HubPeerClient implements PeerClient {
  constructor(private nodeId: string) {}

  async listPeers(): Promise<NodeInfo[]> {
    const json = await hubFetch('/api/tier-agent/machines') as any;
    const machines: any[] = Array.isArray(json) ? json : (json.machines || json.data || []);
    return machines
      .map((m: any) => ({
        node: (m.gatewayId || m.machineId || m.id) as string,
        hostname: (m.hostname || m.machineHostname || '') as string,
        platform: (m.platform || m.machineOS || m.os || '') as string,
      }))
      .filter((m) => m.node && m.node !== this.nodeId);
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
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    const json = await proxyFetch(node, `/data/${encodeURIComponent(dataset)}/export${qs}`) as any;
    const raw = json.data || json;
    // envelope: { records: [...] } or direct array
    return Array.isArray(raw) ? raw : (raw.records ?? []);
  }

  async getFrom(node: string, dataset: string, id: string): Promise<DataRecord | null> {
    try {
      const json = await proxyFetch(
        node,
        `/data/${encodeURIComponent(dataset)}/records/${encodeURIComponent(id)}`,
      ) as any;
      const raw = json.data || json;
      return raw ?? null;
    } catch {
      return null;
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function getHubPeerClient(): HubPeerClient {
  const cfg = getHubConfig();
  const nodeId = cfg.gatewayId || cfg.machineId || '';
  return new HubPeerClient(nodeId);
}
