// core/src/data/sync-engine.ts
// Backend-agnostic cross-node sync engine (M5 Task 4).
// Pulls 'full' datasets from peers via PeerClient, using BackendRegistry + importBatch LWW.

import type { DatasetRegistry } from './dataset-registry';
import type { BackendRegistry } from './backend-registry';
import type {
  PeerClient, SyncStatus, ManifestEntry, NodeInfo, NodeOrigin, BackendConfig,
} from './types';
import { clusterOf, type ClusterRecord } from '../cluster/cluster-map';

/**
 * Pure helper: decide whether to pull a dataset from a peer based on scope + cluster membership.
 * - 'fleet' scope: always pull (true)
 * - 'cluster' or undefined (defaults to cluster): pull only if peer is in same cluster (return clusterOf(peerNode) === selfCluster)
 */
export function shouldPullDataset(
  scope: 'cluster' | 'fleet' | undefined,
  peerNode: string,
  records: ClusterRecord[],
  selfId: string | null,
  selfCluster: string,
): boolean {
  if (scope === 'fleet') return true;
  return clusterOf(peerNode, records, selfId, selfCluster) === selfCluster;
}

/**
 * Tombstone retention (deletion reconciliation, bl_bad31392).
 *
 * A tombstone must outlive the longest realistic window in which a node can still be
 * carrying the pre-delete live record — once every tombstone for a doc is GC'd fleet-wide,
 * a straggler that slept through the whole retention window re-serves the stale live copy
 * and it re-imports everywhere (`isNewer(stale, null)` is true). 14 days ≈ 4000× the 300s
 * reconcile interval and comfortably covers this fleet's observed offline spans
 * (laptops/Windows boxes off for days, not weeks).
 *
 * The FLOOR guards against a misconfigured/typo'd TTL turning GC into an instant purge —
 * a tombstone collected before peers' next reconcile never propagates, which silently
 * reintroduces the exact ghost-record defect this exists to fix. 1h = 12× the default
 * reconcile interval.
 */
export const TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const TOMBSTONE_GC_FLOOR_MS = 60 * 60 * 1000;

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
    /** Tombstone retention override — clamped to TOMBSTONE_GC_FLOOR_MS, never below. */
    tombstoneTtlMs?: number;
  }) {}

  private tombstoneTtlMs(): number {
    return Math.max(TOMBSTONE_GC_FLOOR_MS, this.deps.tombstoneTtlMs ?? TOMBSTONE_TTL_MS);
  }

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

    // Resolve cluster context once per run (for scope-aware filtering)
    let records: ClusterRecord[] = [];
    let selfCluster = 'default';
    try {
      // Lazy import to avoid circular dependency: sync-engine ↔ cluster-store ↔ data-service
      const { getClusterRecords } = await import('../cluster/cluster-store');
      const { getMyCluster } = await import('../cluster/cluster-config');
      records = await getClusterRecords();
      selfCluster = getMyCluster();
    } catch (e) {
      // Cluster data not available; proceed with defaults (all peers resolve to 'default' cluster)
    }

    const selfId = this.deps.nodeId;

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
        // Scope-aware filtering: skip if this dataset shouldn't be pulled from this peer
        // This guard is checked FIRST, before any syncMode handling, to ensure cluster isolation
        if (!shouldPullDataset(m.scope, peer.node, records, selfId, selfCluster)) continue;

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
            scope: m.scope ?? 'cluster',
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

    // Age-based tombstone GC — bounds what the tombstone design adds to the store.
    // Local-only sweep: it deletes nothing on the basis of any peer's answer, so a failed
    // reconcile above never widens what gets purged here.
    s.tombstonesPurged = await this.gcTombstones(s);

    this._status = s;
    return this.status();
  }

  /**
   * Purge tombstones older than the retention TTL from every synced local dataset.
   * The QueryFilter is only a PREFILTER — getField() prefers `fields.*`, so a user record
   * whose payload happens to carry `deleted: true` can match it. The top-level checks in
   * code below are the authority: only a real tombstone (`rec.deleted === true` at the
   * record level) that is verifiably old is ever removed. Per-dataset failures are
   * reported in `errors`, never fatal to the run.
   */
  private async gcTombstones(s: SyncStatus): Promise<number> {
    const cutoff = new Date(Date.now() - this.tombstoneTtlMs()).toISOString();
    let purged = 0;
    for (const d of this.deps.datasets.list()) {
      if (!d.syncMode || d.syncMode === 'none') continue; // tombstones only exist on synced datasets
      const backend = this.deps.backends.get(d.backend);
      if (!backend) continue;
      try {
        const r = await backend.query(d.id, {
          filter: [{ field: 'deleted', op: 'eq', value: true }],
          limit: 10000,
        });
        for (const rec of r.records) {
          if (rec.deleted !== true) continue;                                   // fields.deleted shadow — NOT a tombstone
          if (typeof rec.updatedAt !== 'string' || !rec.updatedAt) continue;    // unknown age — keep
          if (rec.updatedAt >= cutoff) continue;                                // still within retention
          if (await backend.delete(d.id, rec.id)) purged++;
        }
      } catch (e) {
        s.errors.push(`gc ${d.id}: ` + (e instanceof Error ? e.message : String(e)));
      }
    }
    return purged;
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

    // Ensure a local replica descriptor exists, preserving scope
    this.deps.datasets.upsertReplica({
      id: m.id,
      backend: m.backend,
      ownerNode: m.ownerNode,
      syncMode: m.syncMode,
      scope: m.scope ?? 'cluster',
      config: { kind: m.backend } as BackendConfig,
      origin,
    });

    const backend = this.deps.backends.get(m.backend);
    if (!backend) return { applied: 0, skipped: 0 };

    // Compute watermark = max updatedAt of records already in local replica.
    // EXCEPTION: fleet-scoped metadata datasets (node-clusters, cluster-meta) are tiny
    // and MULTI-WRITER — every node writes its OWN record. A single global per-dataset
    // watermark drops a peer's older record once ANOTHER peer's (or self's) newer record
    // advances `since` past it, so the map never fully converges (stale members, and
    // hostname→gatewayId resolution for cluster_assign breaks). They're cheap to re-pull
    // whole, so always full-sync them (since=undefined) and let importBatch LWW reconcile.
    const local = await backend.exportSince(m.id);
    const since = m.scope === 'fleet'
      ? undefined
      : local.length
        ? local.reduce(
            (mx, r) => (r.updatedAt > mx ? r.updatedAt : mx),
            local[0].updatedAt,
          )
        : undefined;

    // Fetch records newer than the watermark (or ALL records for fleet datasets)
    const peerRecords = await this.deps.peers.exportFrom(peer.node, m.id, since);
    return backend.importBatch(m.id, peerRecords, origin);
  }
}
