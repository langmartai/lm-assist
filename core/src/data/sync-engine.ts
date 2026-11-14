// core/src/data/sync-engine.ts
// Backend-agnostic cross-node sync engine (M5 Task 4).
// Pulls 'full' datasets from peers via PeerClient, using BackendRegistry + importBatch LWW.

import type { DatasetRegistry } from './dataset-registry';
import type { BackendRegistry } from './backend-registry';
import type {
  PeerClient, SyncStatus, ManifestEntry, NodeInfo, NodeOrigin, BackendConfig, DataRecord, StorageBackend,
} from './types';
import { isNewer } from './types';
import { clusterOf, type ClusterRecord } from '../cluster/cluster-map';
import { KeyedLocks } from './key-lock';

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

/** Rows one `exportSince` call returns at most when the backend does not say otherwise —
 *  the sql engine's `LIMIT 50000` and the cache backend's CACHE_MAX_SCAN. */
export const EXPORT_PAGE_CAP = 50_000;
/** Backstop on the watermark loop: 1000 pages × 50k rows is far past any real dataset,
 *  and a loop that stops advancing is reported long before this. */
const EXPORT_MAX_PAGES = 1000;

/** Version, then updatedAt — the LWW order WITHOUT isNewer's origin tie-break. Import
 *  re-stamps `origin` on every landed record, so an origin compare would call two copies
 *  of the same write "different"; only a real newer write counts here. */
export function strictlyNewer(a: { version: number; updatedAt: string }, b: { version: number; updatedAt: string }): boolean {
  if (a.version !== b.version) return a.version > b.version;
  return a.updatedAt > b.updatedAt;
}

/**
 * One `exportSince` page with the cache backend's scan cap lifted. That backend scans in
 * KEY order and stops after `maxScan` matching rows, THEN sorts by updatedAt — so a capped
 * page is an arbitrary key-range, not "the oldest N", and a watermark loop over it would
 * skip every unscanned record older than the page's newest. Lifting the cap makes one call
 * complete. It is restored before this returns: CacheBackend.exportSince runs its whole
 * scan synchronously inside the call, so no other caller can observe the lifted value.
 * Backends without a `maxScan` (sql: `ORDER BY updated_at LIMIT`) page correctly as-is.
 */
function exportPage(backend: StorageBackend, dataset: string, since: string | undefined): Promise<DataRecord[]> {
  const b = backend as StorageBackend & { maxScan?: unknown };
  if (typeof b.maxScan !== 'number') return backend.exportSince(dataset, since);
  const prev = b.maxScan;
  b.maxScan = Number.POSITIVE_INFINITY;
  try {
    return backend.exportSince(dataset, since);
  } finally {
    b.maxScan = prev;
  }
}

/**
 * Every record in a dataset — tombstones included, UNREDACTED — for bundles and for the
 * auto-demotion stranded check. `exportSince` alone caps at 50k rows, which the sync pull
 * tolerates (the next tick continues) but a point-in-time copy must not. Loops on the
 * updatedAt watermark (inclusive `since`, so boundary ties re-appear and are de-duped by
 * id, keeping the newer copy if a write landed between pages) until a page comes back
 * short. NEVER truncates silently: a full page that adds no new id — more rows share one
 * updatedAt than a page holds — returns `complete:false` with the reason.
 */
export async function exportAllRecords(
  backend: StorageBackend,
  dataset: string,
  opts: { pageCap?: number } = {},
): Promise<{ complete: true; records: DataRecord[] } | { complete: false; reason: string; records: DataRecord[] }> {
  const pageCap = opts.pageCap ?? EXPORT_PAGE_CAP;
  const seen = new Map<string, DataRecord>();
  let since: string | undefined;
  for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
    const rows = await exportPage(backend, dataset, since);
    let fresh = 0;
    let max = since;
    for (const r of rows) {
      const prev = seen.get(r.id);
      if (!prev) { seen.set(r.id, r); fresh++; } else if (strictlyNewer(r, prev)) seen.set(r.id, r);
      if (typeof r.updatedAt === 'string' && (max === undefined || r.updatedAt > max)) max = r.updatedAt;
    }
    if (rows.length < pageCap) return { complete: true, records: [...seen.values()] };
    if (fresh === 0 || max === since) {
      return {
        complete: false,
        records: [...seen.values()],
        reason: `export of "${dataset}" cannot advance: more than ${pageCap} records share updatedAt ${since ?? max ?? '(none)'}`,
      };
    }
    since = max;
  }
  return { complete: false, records: [...seen.values()], reason: `export of "${dataset}" exceeded ${EXPORT_MAX_PAGES} pages` };
}

/** "hostname (node)" when the roster gave a hostname — node ids alone are opaque in logs. */
function peerLabel(peer: NodeInfo): string {
  return peer.hostname ? `${peer.hostname} (${peer.node})` : peer.node;
}

export class SyncEngine {
  private _status: SyncStatus = {
    lastRun: null,
    peersChecked: 0,
    datasetsReplicated: 0,
    recordsApplied: 0,
    recordsSkipped: 0,
    errors: [],
  };

  /** Per-record lock the tombstone GC deletes under. MUST be the same instance
   *  DataService put/del use (getDataService wires that) or the GC's re-check
   *  still races a concurrent re-create; standalone engines get a private one. */
  private locks: KeyedLocks;

  constructor(private deps: {
    datasets: DatasetRegistry;
    backends: BackendRegistry;
    peers: PeerClient;
    nodeId: string;
    /** Tombstone retention override — clamped to TOMBSTONE_GC_FLOOR_MS, never below. */
    tombstoneTtlMs?: number;
    /** Share DataService's per-key put/del lock so GC cannot race a re-create. */
    locks?: KeyedLocks;
  }) {
    this.locks = deps.locks ?? new KeyedLocks();
  }

  private tombstoneTtlMs(): number {
    return Math.max(TOMBSTONE_GC_FLOOR_MS, this.deps.tombstoneTtlMs ?? TOMBSTONE_TTL_MS);
  }

  status(): SyncStatus {
    return { ...this._status, errors: [...this._status.errors] };
  }

  /** The run in flight. reconcile() is single-flight: the 300 s interval, the boot run and a
   *  manual /data/sync share one pass instead of racing each other through
   *  resolveSuperseded's check-then-demote window. */
  private inflight: Promise<SyncStatus> | null = null;

  reconcile(): Promise<SyncStatus> {
    if (this.inflight) return this.inflight;
    const run = this.reconcileOnce().finally(() => { if (this.inflight === run) this.inflight = null; });
    this.inflight = run;
    return run;
  }

  private async reconcileOnce(): Promise<SyncStatus> {
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
    const { records, selfCluster } = await this.clusterContext();
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

        // A peer that TOOK OVER a dataset this node still owns — i.e. this node is the
        // superseded origin, back online. Only the explicit marker naming THIS node
        // triggers it; any other dual-owner cause keeps today's LWW merge below.
        if (m.supersedes && m.supersedes === selfId) {
          const localDesc = this.deps.datasets.get(m.id);
          // Two takeovers in OPPOSITE directions (this node took it back from the peer after
          // the peer took it from us): each side's manifest names the other. The NEWER
          // takeover wins deterministically — the side holding it keeps ownership and merely
          // pulls — so the two can never both demote in one round and leave zero owners. A
          // peer marker without a time (old build) never out-ranks our own marker.
          const ourTakeoverWins = !!localDesc?.supersedes && localDesc.supersedes.machineId === peer.node
            && (!m.supersedesAt || (localDesc.supersedes.at || '') >= m.supersedesAt);
          if (localDesc && !localDesc.origin && !ourTakeoverWins) {
            try {
              const r = await this.resolveSuperseded(peer, m, s);
              s.datasetsReplicated++;
              s.recordsApplied += r.applied;
              s.recordsSkipped += r.skipped;
            } catch (e) {
              s.errors.push(`takeover ${m.id} by ${peerLabel(peer)}: ` + (e instanceof Error ? e.message : String(e)));
            }
            continue;
          }
        }

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

  /** Cluster context for scope-aware pull filtering — the SAME inputs for the
   *  reconcile loop and the notify-driven pullDataset path. Falls back to defaults
   *  (all peers resolve to 'default') when cluster data is unavailable. */
  private async clusterContext(): Promise<{ records: ClusterRecord[]; selfCluster: string }> {
    try {
      // Lazy import to avoid circular dependency: sync-engine ↔ cluster-store ↔ data-service
      const { getClusterRecords } = await import('../cluster/cluster-store');
      const { getMyCluster } = await import('../cluster/cluster-config');
      return { records: await getClusterRecords(), selfCluster: getMyCluster() };
    } catch {
      return { records: [], selfCluster: 'default' };
    }
  }

  /**
   * Purge tombstones older than the retention TTL from every synced local dataset.
   * The QueryFilter is only a PREFILTER — getField() prefers `fields.*`, so a user record
   * whose payload happens to carry `deleted: true` can match it. The checks in code below
   * are the authority: at delete time the record is RE-READ under the same per-key lock
   * DataService.put/del use, and only a record that is STILL a real tombstone (`deleted
   * === true` at the top level) and STILL expired is removed — the query snapshot alone
   * would race a legitimate CAS re-create (ifVersion:0 over a tombstone) landing between
   * the query and the delete, hard-deleting the brand-new live record. Per-dataset
   * failures are reported in `errors`, never fatal to the run.
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
          const deleted = await this.locks.withLock(`${d.id}:${rec.id}`, async () => {
            const cur = await backend.get(d.id, rec.id);                        // re-read: the snapshot may be stale
            if (!cur || cur.deleted !== true) return false;                     // re-created (or already gone) — keep
            if (typeof cur.updatedAt !== 'string' || !cur.updatedAt) return false;
            if (cur.updatedAt >= cutoff) return false;                          // refreshed within retention — keep
            return backend.delete(d.id, rec.id);
          });
          if (deleted) purged++;
        }
      } catch (e) {
        s.errors.push(`gc ${d.id}: ` + (e instanceof Error ? e.message : String(e)));
      }
    }
    return purged;
  }

  /**
   * Pull a single dataset from a peer.
   * Used by the bus change-notify path (sync-listener) — and gated by the SAME
   * shouldPullDataset check as the reconcile loop: a foreign-cluster origin's notify
   * must not pull a dataset the reconcile loop would refuse (tombstones included).
   */
  async pullDataset(node: string, datasetId: string): Promise<{ applied: number; skipped: number }> {
    const { datasets } = await this.deps.peers.manifest(node);
    const m = datasets.find((d) => d.id === datasetId);
    if (!m || m.syncMode !== 'full') return { applied: 0, skipped: 0 };

    const { records, selfCluster } = await this.clusterContext();
    if (!shouldPullDataset(m.scope, node, records, this.deps.nodeId, selfCluster)) {
      console.debug(`[sync-engine] pull of ${datasetId} from ${node} refused by cluster scope (scope=${m.scope ?? 'cluster'}, self=${selfCluster})`);
      return { applied: 0, skipped: 0 };
    }

    const peers = await this.deps.peers.listPeers();
    const peer = peers.find((p) => p.node === node) ?? { node, hostname: '', platform: '' };
    return this.pullOne(peer, m);
  }

  /**
   * Auto-demotion of a returning superseded origin (data-bundle design). This node owns
   * `m.id`, but `peer` took it over while this node was away (its manifest names us in
   * `supersedes`).
   *  1. Pull the peer's FULL copy LWW — exactly the dual-owner merge — so nothing of the
   *     peer's is lost here.
   *  2. Count local records a demotion would STRAND: strictly newer than the peer's copy,
   *     or missing on the peer. (A local tombstone the peer never had strands nothing —
   *     there is no record to lose.) If any: stay dual-owner and say so in status.errors;
   *     the peer, still an owner that lists this dataset, pulls them on its next reconcile.
   *  3. Otherwise demote to a read-only replica of the peer.
   */
  private async resolveSuperseded(peer: NodeInfo, m: ManifestEntry, s: SyncStatus): Promise<{ applied: number; skipped: number }> {
    const origin: NodeOrigin = { machineId: peer.node, hostname: peer.hostname, os: peer.platform };
    const backend = this.deps.backends.get(m.backend);
    if (!backend) return { applied: 0, skipped: 0 };

    const who = peerLabel(peer);
    const peerRecords = await this.deps.peers.exportFrom(peer.node, m.id);
    const applied = await backend.importBatch(m.id, peerRecords, origin);

    // The peer copy must be COMPLETE for the stranded count to mean anything. One export is
    // capped (sql LIMIT / cache maxScan, in key order — not pageable from here), and a peer
    // client answers [] on any transport error. Either way: stay dual-owner, and say why
    // instead of reporting a misleading "N records not yet on P".
    if (peerRecords.length >= EXPORT_PAGE_CAP) {
      s.errors.push(`takeover ${m.id} by ${who}: cannot read ${who}'s full copy (${peerRecords.length} rows hit the ${EXPORT_PAGE_CAP}-row export cap) — staying dual-owner`);
      return applied;
    }

    const local = await exportAllRecords(backend, m.id);
    const theirs = new Map(peerRecords.map((r) => [r.id, r]));
    let stranded = 0;
    for (const rec of local.records) {
      const peerCopy = theirs.get(rec.id);
      if (!peerCopy) { if (rec.deleted !== true) stranded++; continue; }
      if (strictlyNewer(rec, peerCopy)) stranded++;
    }
    if (!local.complete) {
      // Cannot prove nothing would be stranded — staying an owner is the safe side.
      s.errors.push(`takeover ${m.id} by ${who}: local export incomplete (${local.reason}) — staying dual-owner`);
      return applied;
    }
    if (stranded > 0) {
      const empty = peerRecords.length === 0 ? ` (${who} returned no records — unreachable, or its copy is empty)` : '';
      s.errors.push(`takeover ${m.id} by ${who}: ${stranded} local records not yet on ${who}${empty} — staying dual-owner until ${who} pulls them`);
      return applied;
    }
    this.deps.datasets.demoteToReplica(m.id, origin, peer.node);
    console.log(`[sync-engine] ${m.id}: taken over by ${who}; nothing stranded — demoted to a read-only replica`);
    return applied;
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

    // This node TOOK OVER the dataset from `peer`, which is back and still an owner: it may
    // hold records written while it was partitioned (or ones our replica never pulled
    // before the takeover). Those sort BELOW our watermark — our own post-takeover writes
    // advanced it — so a watermark pull would never fetch them, the peer would count them
    // stranded forever, and neither side would ever converge. Pull its FULL copy instead.
    const localDesc = this.deps.datasets.get(m.id);
    const fromSuperseded = !!localDesc && !localDesc.origin && localDesc.supersedes?.machineId === peer.node;

    // Compute watermark = max updatedAt of records already in local replica.
    // EXCEPTION: fleet-scoped metadata datasets (node-clusters, cluster-meta) are tiny
    // and MULTI-WRITER — every node writes its OWN record. A single global per-dataset
    // watermark drops a peer's older record once ANOTHER peer's (or self's) newer record
    // advances `since` past it, so the map never fully converges (stale members, and
    // hostname→gatewayId resolution for cluster_assign breaks). They're cheap to re-pull
    // whole, so always full-sync them (since=undefined) and let importBatch LWW reconcile.
    const local = await backend.exportSince(m.id);
    const since = m.scope === 'fleet' || fromSuperseded
      ? undefined
      : local.length
        ? local.reduce(
            (mx, r) => (r.updatedAt > mx ? r.updatedAt : mx),
            local[0].updatedAt,
          )
        : undefined;

    // Fetch records newer than the watermark (or ALL records for fleet datasets)
    const peerRecords = await this.deps.peers.exportFrom(peer.node, m.id, since);
    if (!fromSuperseded) return backend.importBatch(m.id, peerRecords, origin);
    return this.adoptFromSuperseded(backend, m.id, peerRecords, local, origin, peer);
  }

  /**
   * LWW-merge the superseded origin's full copy, then RE-STAMP every record it actually
   * won (version+1, updatedAt=now, owned): our downstream replicas pull by an updatedAt
   * watermark too, and the adopted records carry the peer's OLD updatedAt — without the
   * re-stamp they would reach this node and stop here. A record this node deleted and whose
   * tombstone the retention GC already purged comes back here — the LWW outcome, and far
   * better than a permanent divergence — so the count is logged.
   */
  private async adoptFromSuperseded(
    backend: StorageBackend,
    dataset: string,
    peerRecords: DataRecord[],
    local: DataRecord[],
    origin: NodeOrigin,
    peer: NodeInfo,
  ): Promise<{ applied: number; skipped: number }> {
    const mine = new Map(local.map((r) => [r.id, r]));
    const wins = peerRecords.filter((r) => isNewer({ ...r, origin }, mine.get(r.id) ?? null));
    const res = await backend.importBatch(dataset, peerRecords, origin);
    let restamped = 0;
    let resurrected = 0;
    for (const w of wins) {
      await this.locks.withLock(`${dataset}:${w.id}`, async () => {
        const cur = await backend.get(dataset, w.id);
        // Only the exact copy importBatch just landed — a concurrent local write wins as is.
        if (!cur || cur.version !== w.version || cur.updatedAt !== w.updatedAt || cur.origin?.machineId !== origin.machineId) return;
        await backend.put(dataset, { ...cur, version: cur.version + 1, updatedAt: new Date().toISOString(), origin: undefined });
        restamped++;
        if (!mine.has(w.id) && w.deleted !== true) resurrected++;
      });
    }
    if (restamped) {
      console.log(`[sync-engine] ${dataset}: adopted ${restamped} record(s) from ${peerLabel(peer)} (the node this one took it over from)`
        + (resurrected ? `; ${resurrected} were absent here — new on ${peerLabel(peer)}, or deleted here with the tombstone already purged` : ''));
    }
    return res;
  }
}
