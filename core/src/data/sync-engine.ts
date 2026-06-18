// core/src/data/sync-engine.ts
// Backend-agnostic cross-node sync engine (M5 Task 4).
// Pulls 'full' datasets from peers via PeerClient, using BackendRegistry + importBatch LWW.

import type { DatasetRegistry } from './dataset-registry';
import type { BackendRegistry } from './backend-registry';
import type {
  PeerClient, SyncStatus, ManifestEntry, NodeInfo, NodeOrigin, BackendConfig,
} from './types';

export class SyncEngine {
  private _status: SyncStatus = {
    lastRun: null,
    peersChecked: 0,
    datasetsReplicated: 0,
    recordsApplied: 0,
    recordsSkipped: 0,
    errors: [],
  };

  constructor(private deps: {
    datasets: DatasetRegistry;
    backends: BackendRegistry;
    peers: PeerClient;
    nodeId: string;
  }) {}

  status(): SyncStatus {
    return { ...this._status, errors: [...this._status.errors] };
  }

  async reconcile(): Promise<SyncStatus> {
    const s: SyncStatus = {
      lastRun: new Date().toISOString(),
      peersChecked: 0,
      datasetsReplicated: 0,
      recordsApplied: 0,
      recordsSkipped: 0,
      errors: [],
    };

    let peers: NodeInfo[] = [];
    try {
      peers = await this.deps.peers.listPeers();
    } catch (e) {
      s.errors.push('listPeers: ' + (e instanceof Error ? e.message : String(e)));
    }

    for (const peer of peers) {
      if (peer.node === this.deps.nodeId) continue;
      s.peersChecked++;

      let entries: ManifestEntry[] = [];
      try {
        entries = (await this.deps.peers.manifest(peer.node)).datasets;
      } catch (e) {
        s.errors.push(`manifest ${peer.node}: ` + (e instanceof Error ? e.message : String(e)));
        continue;
      }

      for (const m of entries) {
        if (m.syncMode === 'partial') {
          // Register the descriptor so local code knows the dataset exists as partial
          // (enables read-through in DataService.get), but do NOT eagerly pull records.
          const origin: NodeOrigin = {
            machineId: peer.node,
            hostname: peer.hostname,
            os: peer.platform,
          };
          this.deps.datasets.upsertReplica({
            id: m.id,
            backend: m.backend,
            ownerNode: m.ownerNode,
            syncMode: 'partial',
            config: { kind: m.backend } as BackendConfig,
            origin,
          });
          continue;
        }
        // 'none' and any unknown modes are skipped entirely
        if (m.syncMode !== 'full') continue;
        try {
          const r = await this.pullOne(peer, m);
          s.datasetsReplicated++;
          s.recordsApplied += r.applied;
          s.recordsSkipped += r.skipped;
        } catch (e) {
          s.errors.push(`pull ${peer.node}/${m.id}: ` + (e instanceof Error ? e.message : String(e)));
        }
      }
    }

    this._status = s;
    return this.status();
  }

  /**
   * Pull a single dataset from a peer.
   * Used by reconcile and the dataset_updated event handler (Task 5).
   */
  async pullDataset(node: string, datasetId: string): Promise<{ applied: number; skipped: number }> {
    const { datasets } = await this.deps.peers.manifest(node);
    const m = datasets.find((d) => d.id === datasetId);
    if (!m || m.syncMode !== 'full') return { applied: 0, skipped: 0 };

    const peers = await this.deps.peers.listPeers();
    const peer = peers.find((p) => p.node === node) ?? { node, hostname: '', platform: '' };
    return this.pullOne(peer, m);
  }

  private async pullOne(
    peer: NodeInfo,
    m: ManifestEntry,
  ): Promise<{ applied: number; skipped: number }> {
    const origin: NodeOrigin = {
      machineId: peer.node,
      hostname: peer.hostname,
      os: peer.platform,
    };

    // Ensure a local replica descriptor exists
    this.deps.datasets.upsertReplica({
      id: m.id,
      backend: m.backend,
      ownerNode: m.ownerNode,
      syncMode: m.syncMode,
      config: { kind: m.backend } as BackendConfig,
      origin,
    });

    const backend = this.deps.backends.get(m.backend);
    if (!backend) return { applied: 0, skipped: 0 };

    // Compute watermark = max updatedAt of records already in local replica
    const local = await backend.exportSince(m.id);
    const since = local.length
      ? local.reduce(
          (mx, r) => (r.updatedAt > mx ? r.updatedAt : mx),
          local[0].updatedAt,
        )
      : undefined;

    // Fetch only records newer than watermark
    const records = await this.deps.peers.exportFrom(peer.node, m.id, since);
    return backend.importBatch(m.id, records, origin);
  }
}
