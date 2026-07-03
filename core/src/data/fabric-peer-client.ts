// core/src/data/fabric-peer-client.ts
// PeerClient that carries data-service sync over the W2 fabric (spec §5 S2.2) with a HubPeerClient
// fallback for legacy/ineligible peers. Fabric eligibility = dataSyncViaFabric on AND a fabric link
// to the peer exists AND the peer advertised the 'data' HELLO feature (Task 10). The sync RPCs land
// on the peer as a read-only PEER principal (Tasks 2/3) — no minted access key, no 1MB body cap
// (fabric chunks; >8MB responses ride a bulk handle transparently via fabricRequest).
import { HubPeerClient } from './peer-client';
import type { PeerClient, NodeInfo, ManifestEntry, DataRecord } from './types';

interface FabricPeerDeps {
  eligible?: (node: string) => boolean;
  request?: (node: string, init: { method: string; path: string; body?: unknown }) => Promise<{ status: number; data?: unknown }>;
  settings?: () => { dataSyncViaFabric: boolean };
}

/** Unwrap the Core route envelope `{ success, data, meta }` (also tolerates a raw payload). */
function unwrap(data: unknown): any {
  if (data && typeof data === 'object' && 'success' in (data as any) && 'data' in (data as any)) return (data as any).data;
  return data;
}

export class FabricPeerClient implements PeerClient {
  private eligible: (node: string) => boolean;
  private request: (node: string, init: { method: string; path: string; body?: unknown }) => Promise<{ status: number; data?: unknown }>;
  private settings: () => { dataSyncViaFabric: boolean };

  constructor(private nodeId: string, private hub: HubPeerClient = new HubPeerClient(nodeId), deps?: FabricPeerDeps) {
    this.settings = deps?.settings ?? (() => {
      const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
      return { dataSyncViaFabric: getProjectSettings().dataSyncViaFabric };
    });
    // Cast to `any` (not `typeof import('../fabric')`): fabricDataPeer/fabricDataRequest are added
    // in Task 8. A statically-typed cast would resolve the real (current) export shape and fail to
    // compile until Task 8 lands; `any` keeps this file buildable standalone, and both call sites
    // pick up the real functions automatically at runtime as soon as Task 8 ships them.
    this.eligible = deps?.eligible ?? ((node) => {
      const { fabricDataPeer } = require('../fabric') as any;
      return fabricDataPeer(node);
    });
    this.request = deps?.request ?? (async (node, init) => {
      const { fabricDataRequest } = require('../fabric') as any;
      return fabricDataRequest(node, init);
    });
  }

  /** The hub roster is the only source of the online-peer list (no fabric equivalent). */
  listPeers(): Promise<NodeInfo[]> { return this.hub.listPeers(); }

  private useFabric(node: string): boolean {
    return this.settings().dataSyncViaFabric && this.eligible(node);
  }

  async manifest(node: string): Promise<{ node: string; datasets: ManifestEntry[] }> {
    if (this.useFabric(node)) {
      try {
        const res = await this.request(node, { method: 'GET', path: '/data/sync/manifest' });
        const raw = unwrap(res.data);
        return { node: raw?.node ?? node, datasets: Array.isArray(raw?.datasets) ? raw.datasets : [] };
      } catch { /* fall through to hub */ }
    }
    return this.hub.manifest(node);
  }

  async exportFrom(node: string, dataset: string, since?: string): Promise<DataRecord[]> {
    if (this.useFabric(node)) {
      try {
        const res = await this.request(node, { method: 'POST', path: `/data/${dataset}/export`, body: since ? { since } : {} });
        const raw = unwrap(res.data);
        return Array.isArray(raw) ? raw : (raw?.records ?? []);
      } catch { /* fall through to hub */ }
    }
    return this.hub.exportFrom(node, dataset, since);
  }

  async getFrom(node: string, dataset: string, id: string): Promise<DataRecord | null> {
    if (this.useFabric(node)) {
      try {
        const res = await this.request(node, { method: 'POST', path: `/data/${dataset}/fetch`, body: { id } });
        const raw = unwrap(res.data);
        return raw ?? null;
      } catch { /* fall through to hub */ }
    }
    return this.hub.getFrom(node, dataset, id);
  }
}
