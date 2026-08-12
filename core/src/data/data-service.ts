// core/src/data/data-service.ts
import type {
  Principal, DataAction, DataRecord, QuerySpec, SearchSpec, AccessRequest, BackendKind, NodeVisibility, SyncMode,
  PeerClient, NodeInfo, PutOptions, DatasetDescriptor,
} from './types';
import type { DatasetRegistry } from './dataset-registry';
import { getDatasetRegistry } from './dataset-registry';
import type { BackendRegistry } from './backend-registry';
import { BackendRegistry as BReg } from './backend-registry';
import { AccessManager } from './access-manager';
import { CacheBackend } from './backends/cache-backend';
import { VectorBackend } from './backends/vector-backend';
import { KnowledgeBackend } from './backends/knowledge-backend';
import { VectorsBackend } from './backends/vectors-backend';
import { FileBackend } from './backends/file-backend';
import { SqlBackend } from './backends/sql-backend';
import { boundQuerySpec } from './backends/query-filter';
import { ensureSystemDatasets, ensureTrackedFiles } from './system-datasets';
import { getKeyStore } from './key-store';
import { redactRecord, redactValueDeep, scrubValueDeep } from './redaction';
import { thisNodeId } from './paths';
import { getProjectSettings } from '../project-settings';
import type { ParsedRequest } from '../routes/index';
import { FabricPeerClient } from './fabric-peer-client';
import { SyncEngine } from './sync-engine';

export interface CallCtx { principal: Principal; keyHeader?: string; }
export type DataResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };
export type PublicKey = Omit<import('./types').AccessKey, 'secretHash'>;

export const MAX_RECORD_BYTES = 1_048_576; // 1 MiB — a single data record's serialized cap
/** Returns a reason string if the record exceeds the size cap, else undefined. */
export function recordTooLarge(record: DataRecord): string | undefined {
  let n = 0;
  try { n = Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8'); } catch { return 'record is not serializable'; }
  return n > MAX_RECORD_BYTES ? `record is ${n} bytes; the per-record cap is ${MAX_RECORD_BYTES} bytes` : undefined;
}

export class DataService {
  private enabledOverride?: boolean; // tests only
  // Per-(dataset,key) promise-chain mutex. Without it, two concurrent CAS put()s on the same
  // key both read the same stored version, both pass the ifVersion compare, and both write —
  // a silent lost update (CAS's entire purpose is multi-writer safety). Serializes ALL puts to
  // a key (not just CAS ones) so a plain put can't slip between a CAS put's read and write.
  // Uncontended keys stay fast: a Map miss + immediate resolve, no global lock.
  private putLocks = new Map<string, Promise<void>>();
  constructor(private deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager; notify?: (dataset: string, type: 'changed' | 'deleted', ids: string[]) => void; peers?: PeerClient }) {}

  isEnabled(): boolean {
    if (typeof this.enabledOverride === 'boolean') return this.enabledOverride;
    return getProjectSettings().dataServiceEnabled === true;
  }

  resolvePrincipal(req: ParsedRequest): Principal { return this.deps.manager.resolvePrincipal(req); }

  /** Sync-scoped resolver for the 4 node-to-node sync-READ routes only — see AccessManager.resolveSyncPrincipal. */
  resolveSyncPrincipal(req: ParsedRequest): Principal { return this.deps.manager.resolveSyncPrincipal(req); }

  catalog(p: Principal): Array<{ id: string; backend: BackendKind; visibility: NodeVisibility; readOnly: boolean; actions: DataAction[] }> {
    const all: DataAction[] = ['read', 'query', 'search', 'write', 'delete', 'manage'];
    const out = [];
    for (const d of this.deps.datasets.list()) {
      const actions = this.deps.manager.evaluateGrants(p, d, all);
      if (!actions.length) continue;
      out.push({ id: d.id, backend: d.backend, visibility: d.visibility, readOnly: !!d.readOnly, actions });
    }
    return out;
  }

  /** Catalog plus the caller's management capability — one call for the web UI / MCP catalog.
   *  canManage mirrors the local-only management boundary (local principal only). */
  catalogView(p: Principal): { you: { principal: Principal['type']; canManage: boolean }; datasets: ReturnType<DataService['catalog']> } {
    return {
      you: { principal: p.type, canManage: p.type === 'local' },
      datasets: this.catalog(p),
    };
  }

  async requestAccess(p: Principal, req: AccessRequest): Promise<DataResult<{ key: string; keyId: string; grants: import('./types').Grant[]; expiresAt: string }>> {
    const r = await this.deps.manager.requestAccess(p, req);
    if (!r.ok) return { ok: false, code: 'ACCESS_DENIED', reason: r.reason };
    return { ok: true, value: { key: r.key, keyId: r.keyId, grants: r.grants, expiresAt: r.expiresAt } };
  }
  async revoke(p: Principal, keyId: string): Promise<boolean> {
    // M1: only a local (root) caller may revoke. Cloud revocation needs a verified issuer identity
    // (deferred to the cross-node milestone), so cloud callers cannot revoke arbitrary keys.
    if (p.type !== 'local') return false;
    return getKeyStore().revoke(keyId);
  }

  private async authorize(ctx: CallCtx, datasetId: string, action: DataAction): Promise<DataResult<{ backend: ReturnType<BackendRegistry['get']> }>> {
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    const verdict = await this.deps.manager.enforce(ctx.principal, ctx.keyHeader, d, action);
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
    const backend = this.deps.backends.get(d.backend);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `backend "${d.backend}" unavailable` };
    return { ok: true, value: { backend } };
  }

  async get(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<DataRecord | null>> {
    const a = await this.authorize(ctx, datasetId, 'read');
    if (!a.ok) return a;
    const local = await a.value.backend!.get(datasetId, id);
    // A tombstone reads as absent — but for partial datasets it still falls through to the
    // remote fetch: a peer may hold a NEWER legitimate re-create, and importBatch's LWW
    // decides (a stale live copy loses to the tombstone; a newer re-create wins).
    if (local && !local.deleted) return { ok: true, value: redactRecord(local) };
    const d = this.deps.datasets.get(datasetId)!;
    if (d.syncMode === 'partial' && this.deps.peers) {
      let peers: NodeInfo[] = [];
      try { peers = await this.deps.peers.listPeers(); } catch { peers = []; }
      for (const peer of peers) {
        try {
          const rec = await this.deps.peers.getFrom(peer.node, datasetId, id);
          if (rec) {
            const origin = rec.origin ?? { machineId: peer.node, hostname: peer.hostname, os: peer.platform };
            const stamped = { ...rec, origin };
            await a.value.backend!.importBatch(datasetId, [stamped], origin); // lazy-cache locally, LWW-guarded
            // Serve the post-import state, not the raw peer answer: if the local tombstone
            // out-LWWed the fetched copy the record is still deleted, and returning the
            // peer's stale copy would resurrect it for this caller only.
            const after = await a.value.backend!.get(datasetId, id);
            if (after && !after.deleted) return { ok: true, value: redactRecord(after) };
          }
        } catch { /* try next peer */ }
      }
    }
    return { ok: true, value: null };
  }

  async query(ctx: CallCtx, datasetId: string, q: QuerySpec): Promise<DataResult<{ records: DataRecord[]; total?: number }>> {
    const a = await this.authorize(ctx, datasetId, 'query');
    if (!a.ok) return a;
    // Bound the window HERE, at the one seam every backend and every caller passes
    // through — the MCP tools, the REST route, and the internal stores. Doing it in
    // `applyQuery` alone would miss the sql backend, which pages natively and never
    // calls it. See MAX_QUERY_ROWS for why the number is what it is.
    const r = await a.value.backend!.query(datasetId, boundQuerySpec(q));
    // Hide tombstones from every consumer at THE seam all backends/callers pass through.
    // Filtered on the TOP-LEVEL flag in code — NOT via a QueryFilter on 'deleted', because
    // getField() prefers fields.* and a user record carrying a `deleted` field would vanish.
    const live = r.records.filter((rec) => rec.deleted !== true);
    // total is best-effort under pagination: subtract the tombstones seen in this page
    // (tombstones outside the page can't be counted without a second scan).
    const total = r.total !== undefined ? r.total - (r.records.length - live.length) : undefined;
    return { ok: true, value: { records: live.map(redactRecord), total } };
  }

  async search(ctx: CallCtx, datasetId: string, spec: SearchSpec): Promise<DataResult<Array<DataRecord & { score: number }>>> {
    const a = await this.authorize(ctx, datasetId, 'search');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.search) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" does not support search` };
    const results = await backend.search(datasetId, spec);
    return { ok: true, value: results.filter((r) => r.deleted !== true).map((r) => ({ ...redactRecord(r), score: r.score })) };
  }

  async admin(ctx: CallCtx, datasetId: string, op: string, args?: Record<string, unknown>): Promise<DataResult<unknown>> {
    const a = await this.authorize(ctx, datasetId, 'manage');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.admin) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" has no admin ops` };
    const result = await backend.admin(datasetId, op, args);
    return { ok: true, value: redactValueDeep(result) };
  }

  /** Fire a cross-node change-notify onto the bus — ONLY for syncable datasets, and wrapped so a
   *  disabled/not-ready bus (publish throws when busEnabled=false) is a silent no-op; the 300s
   *  reconcile is the safety net. A local-only ('none') dataset never churns the bus. */
  private notifyChange(d: DatasetDescriptor, type: 'changed' | 'deleted', ids: string[]): void {
    if ((d as any).sensitive) return;
    if (!d.syncMode || d.syncMode === 'none') return;
    try { this.deps.notify?.(d.id, type, ids); } catch { /* bus off / not ready — reconcile heals */ }
  }

  async put(ctx: CallCtx, datasetId: string, record: DataRecord, opts?: PutOptions): Promise<DataResult<{ id: string }>> {
    const a = await this.authorize(ctx, datasetId, 'write');
    if (!a.ok) return a;
    const tooBig = recordTooLarge(record);
    if (tooBig) return { ok: false, code: 'RECORD_TOO_LARGE', reason: tooBig };
    const d = this.deps.datasets.get(datasetId)!;
    if ((d as any).origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    const backend = a.value.backend!;
    // The read-compare-write below is the CAS critical section — it must run as one atomic
    // unit per key. Route ALL puts to this key (CAS and non-CAS alike) through the mutex, so a
    // plain put can never slip between a concurrent CAS put's read and write.
    return this.withKeyLock(`${datasetId}:${record.id}`, async () => {
      const existing = await backend.get(datasetId, record.id);
      // A tombstoned record is logically ABSENT for CAS (ifVersion:0 = create-if-absent must
      // work after a delete) — but its version still seeds the counter below, so the
      // re-create out-LWWs the tombstone on every replica.
      const existingLive = existing && !existing.deleted ? existing : null;
      if (opts?.ifVersion !== undefined) {
        const cur = existingLive?.version ?? 0;
        if (cur !== opts.ifVersion) {
          return { ok: false, code: 'CONFLICT', reason: `version mismatch on "${datasetId}/${record.id}": stored ${cur} != ifVersion ${opts.ifVersion}` };
        }
      }
      const now = new Date().toISOString();
      const versioned: DataRecord = {
        ...record,
        version: (existing?.version ?? 0) + 1,
        createdAt: existingLive?.createdAt ?? now,
        updatedAt: now,
        origin: undefined, // local-owned record (origin is stamped only on replicas)
        deleted: undefined, // put always writes a LIVE record — only del() mints tombstones
      };
      const r = await backend.put(datasetId, versioned);
      this.notifyChange(d, 'changed', [record.id]);
      return { ok: true, value: r };
    });
  }

  /** Promise-chain mutex: chains `fn` onto the previous critical section for `key` so
   *  same-key critical sections never overlap, no matter how the previous one settled.
   *  Cleans up its own map entry when drained — but only if no newer waiter has already
   *  replaced it — so the map can't grow unbounded. */
  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.putLocks.get(key) ?? Promise.resolve();
    const mine = prev.then(fn);
    // Settles right after `fn`, but never rejects — so a failed put doesn't poison the chain
    // for the next waiter on this key.
    const tail = mine.then(() => undefined, () => undefined);
    this.putLocks.set(key, tail);
    try {
      return await mine;
    } finally {
      if (this.putLocks.get(key) === tail) this.putLocks.delete(key);
    }
  }

  async del(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<boolean>> {
    const a = await this.authorize(ctx, datasetId, 'delete');
    if (!a.ok) return a;
    const d = this.deps.datasets.get(datasetId)!;
    if ((d as any).origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    const backend = a.value.backend!;
    // Tombstone deletes only where the deletion has to TRAVEL: non-sensitive synced datasets
    // (the same predicate notifyChange uses). A local-only or sensitive dataset never
    // replicates, so a durable marker would be pure residue — hard-delete as before.
    const synced = !(d as any).sensitive && !!d.syncMode && d.syncMode !== 'none';
    if (!synced) {
      const deleted = await backend.delete(datasetId, id);
      if (deleted) this.notifyChange(d, 'deleted', [id]);
      return { ok: true, value: deleted };
    }
    // Deletion reconciliation (bl_bad31392): replace the record with a tombstone instead of
    // removing it, so the delete propagates through the same exportSince/importBatch LWW pull
    // as writes — a peer that misses the bus notify converges on its next reconcile. Runs
    // under the same per-key lock as put() so a concurrent put can't interleave with the
    // read-bump-write below. Payload is dropped: a tombstone carries no data.
    return this.withKeyLock(`${datasetId}:${id}`, async () => {
      const existing = await backend.get(datasetId, id);
      if (!existing || existing.deleted) return { ok: true, value: false }; // idempotent: already gone
      const now = new Date().toISOString();
      const tombstone: DataRecord = {
        id,
        version: existing.version + 1, // out-LWWs the live record on every replica
        fields: {},
        deleted: true,
        createdAt: existing.createdAt || now,
        updatedAt: now,
        origin: undefined, // local-owned marker (origin is stamped only on replicas)
      };
      await backend.put(datasetId, tombstone);
      this.notifyChange(d, 'deleted', [id]);
      return { ok: true, value: true };
    });
  }

  /** Allocate a dataset's backend storage (local-only). Replaces the route's put/del __init__ hack. */
  async initDataset(ctx: CallCtx, datasetId: string): Promise<DataResult<void>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset init is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    const backend = this.deps.backends.get(d.backend);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `backend "${d.backend}" unavailable` };
    await backend.createDataset(d); // may throw (e.g. file hard-exclusion) — caller (route) maps to BAD_REQUEST
    return { ok: true, value: undefined };
  }

  /** Drop a dataset + its backend storage (local-only; refuses system datasets and replicas). */
  async dropDataset(ctx: CallCtx, datasetId: string): Promise<DataResult<{ dropped: boolean }>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset drop is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    if (d.system) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${datasetId}" is a system dataset` };
    if ((d as any).origin) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${datasetId}" is a remote replica` };
    const backend = this.deps.backends.get(d.backend);
    if (backend) { try { await backend.dropDataset(datasetId); } catch { /* best effort — still remove the descriptor */ } }
    const dropped = this.deps.datasets.drop(datasetId);
    return { ok: true, value: { dropped } };
  }

  /** Create a dataset + allocate its backend storage (local-only). Single impl shared by REST + MCP. */
  async createDataset(ctx: CallCtx, input: import('./dataset-registry').CreateDatasetInput): Promise<DataResult<import('./types').DatasetDescriptor>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset creation is local-only' };
    // Callers (route body / MCP args) must never mint a system dataset or stamp a replica
    // origin — those are reserved for internal registration (ensureSystemDatasets / replica upsert).
    const { system, origin, ...safe } = input as import('./dataset-registry').CreateDatasetInput & { origin?: unknown };
    void system; void origin;
    let d: import('./types').DatasetDescriptor;
    try {
      d = this.deps.datasets.create(safe);
    } catch (e) {
      return { ok: false, code: 'BAD_REQUEST', reason: e instanceof Error ? e.message : String(e) };
    }
    const init = await this.initDataset(ctx, d.id);
    if (!init.ok) { this.deps.datasets.drop(d.id); return init; } // roll back the descriptor on alloc failure
    return { ok: true, value: d };
  }

  /** List issued access keys (metadata only — NEVER secretHash). Local-only. */
  async listKeys(ctx: CallCtx): Promise<DataResult<PublicKey[]>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'key listing is local-only' };
    const store = this.deps.manager.keyStore;
    const keys = (store.list() as import('./types').AccessKey[]).map((k) => {
      const { secretHash, ...pub } = k; // strip the hash
      return pub as PublicKey;
    });
    return { ok: true, value: keys };
  }

  /** Trigger a cross-node reconcile (local-only). */
  async sync(ctx: CallCtx): Promise<DataResult<import('./types').SyncStatus>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'sync is local-only' };
    const status = await getSyncEngine().reconcile();
    return { ok: true, value: status };
  }

  /** Current sync engine status (local-only). */
  async syncStatus(ctx: CallCtx): Promise<DataResult<import('./types').SyncStatus>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'sync status is local-only' };
    return { ok: true, value: getSyncEngine().status() };
  }

  /** Local-only, read-only raw SQL on a `sql` dataset. Never reachable by cloud/manage keys. */
  async rawSql(ctx: CallCtx, datasetId: string, sql: string, params: unknown[]): Promise<DataResult<{ rows: unknown[] }>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'raw SQL is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    const backend = this.deps.backends.get(d.backend);
    if (!backend || d.backend !== 'sql' || typeof (backend as any).rawSelect !== 'function') {
      return { ok: false, code: 'NOT_SUPPORTED', reason: `raw SQL is only available on sql datasets` };
    }
    try {
      const rows = await (backend as any).rawSelect(datasetId, String(sql || ''), Array.isArray(params) ? params : []);
      return { ok: true, value: { rows: scrubValueDeep(rows) as unknown[] } };
    } catch (e) {
      return { ok: false, code: 'SQL_ERROR', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // M5 sync helpers ----------------------------------------------------------------

  /** Returns this node's stable id. */
  nodeId(): string { return thisNodeId(); }

  /**
   * Peer-facing single-record read — authorizes 'read' and returns the LOCAL record
   * (redacted) WITHOUT the partial remote-fallback that `get` uses. The peer-facing
   * fetch must serve THIS node's record only; recursing to other peers would cycle.
   * Tombstones ARE served (unlike `get`) — this and exportDataset are the channel a
   * deletion propagates through; the caller's importBatch LWW decides what applies.
   */
  async getRecordRaw(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<DataRecord | null>> {
    const a = await this.authorize(ctx, datasetId, 'read');
    if (!a.ok) return a;
    const rec = await a.value.backend!.get(datasetId, id);
    return { ok: true, value: rec ? redactRecord(rec) : null };
  }

  /** Export records from a dataset changed since the given watermark (ISO string). */
  async exportDataset(ctx: CallCtx, datasetId: string, since?: string): Promise<DataResult<DataRecord[]>> {
    const a = await this.authorize(ctx, datasetId, 'read');
    if (!a.ok) return a;
    const records = await a.value.backend!.exportSince(datasetId, since);
    return { ok: true, value: records.map(redactRecord) };
  }

  /** Returns descriptor stubs for datasets this node advertises as syncable (syncMode !== 'none'). */
  syncManifest(p: Principal): Array<{ id: string; syncMode: SyncMode; ownerNode: string; backend: BackendKind; scope: 'cluster' | 'fleet' }> {
    const readActions: DataAction[] = ['read'];
    const out = [];
    for (const d of this.deps.datasets.list()) {
      if ((d as any).sensitive) continue;
      const syncMode: SyncMode = (d.syncMode || 'none') as SyncMode;
      if (syncMode === 'none') continue;
      const actions = this.deps.manager.evaluateGrants(p, d, readActions);
      if (!actions.length) continue;
      out.push({ id: d.id, syncMode, ownerNode: d.ownerNode, backend: d.backend, scope: (d.scope ?? 'cluster') });
    }
    return out;
  }
}

let instance: DataService | null = null;
let engineInstance: SyncEngine | null = null;

/** The singleton WITHOUT constructing it. Hot-path consumers (the MCP tool/content
 *  overlay providers) use this to serve code defaults until something has legitimately
 *  built the service (boot sync on enabled nodes, data routes, mission store) —
 *  constructing the full stack (dataset watchers, fabric peer, sync engine) from a
 *  tools/list or guide call would leak lifecycle handles into short-lived processes. */
export function peekDataService(): DataService | null {
  return instance;
}

export function getDataService(): DataService {
  if (!instance) {
    const datasets = getDatasetRegistry();
    ensureSystemDatasets(datasets);
    ensureTrackedFiles(datasets);
    const backends = new BReg();
    backends.register(new CacheBackend());
    backends.register(new VectorBackend());
    backends.register(new KnowledgeBackend());
    backends.register(new VectorsBackend());
    backends.register(new FileBackend());
    backends.register(new SqlBackend());
    const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: thisNodeId() });
    const nodeId = thisNodeId();
    const peers = new FabricPeerClient(nodeId);
    engineInstance = new SyncEngine({ datasets, backends, peers, nodeId });
    instance = new DataService({
      datasets, backends, manager, peers,
      // Production change-notify: publish to the W3 bus topic data:<dataset>. Guarded in notifyChange
      // (publish throws when busEnabled=false) so a disabled bus is a silent no-op.
      notify: (dataset, type, ids) => {
        const { getBus } = require('../bus') as typeof import('../bus');
        getBus().publish(`data:${dataset}`, type, { ids });
      },
    });
  }
  return instance;
}

export function getSyncEngine(): SyncEngine {
  if (!engineInstance) {
    // Ensure the engine is created via getDataService()
    getDataService();
  }
  return engineInstance!;
}
