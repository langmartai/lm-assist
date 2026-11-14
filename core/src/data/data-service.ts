// core/src/data/data-service.ts
import type {
  Principal, DataAction, DataRecord, QuerySpec, SearchSpec, AccessRequest, BackendKind, NodeVisibility, SyncMode,
  PeerClient, NodeInfo, PutOptions, DatasetDescriptor, NodeOrigin, ImportPolicy, ImportBucket, ImportOutcome,
} from './types';
import { isNewer, IMPORT_POLICIES, IMPORT_BUCKETS, IMPORT_SAMPLE_MAX } from './types';
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
import { boundQuerySpec, MAX_QUERY_ROWS } from './backends/query-filter';
import { ensureSystemDatasets, ensureTrackedFiles } from './system-datasets';
import { getKeyStore } from './key-store';
import { redactRecord, redactValueDeep, scrubValueDeep } from './redaction';
import { canonicalJson } from './canonical';
import { thisNodeId } from './paths';
import { getProjectSettings } from '../project-settings';
import type { ParsedRequest } from '../routes/index';
import { FabricPeerClient } from './fabric-peer-client';
import { SyncEngine, exportAllRecords } from './sync-engine';
import { KeyedLocks } from './key-lock';

export interface CallCtx { principal: Principal; keyHeader?: string; }
export type DataResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };
export type PublicKey = Omit<import('./types').AccessKey, 'secretHash'>;

export const MAX_RECORD_BYTES = 1_048_576; // 1 MiB — a single data record's serialized cap

/** Hard cap on the tombstone-refill loop in query()/search(). Bounds the extra backend
 *  pages ONE call can burn on a tombstone-heavy window; past it the page returns short
 *  (still honest — the caller's next offset reaches the remainder). 10 × the requested
 *  page covers any realistic tombstone density between 14-day GC sweeps. */
export const TOMBSTONE_REFILL_MAX_PAGES = 10;
/** Most ids a change-notify carries. The bus refuses a payload over its cap (64 KiB) and
 *  notifyChange swallows that throw, so an unbounded id list (a big import) would silently
 *  send NO notify at all. The listener pulls the whole dataset regardless of ids, so past
 *  the bound an empty list ("something changed") is exactly as useful. */
export const MAX_NOTIFY_IDS = 500;
export function boundNotifyIds(ids: string[]): string[] {
  return ids.length > MAX_NOTIFY_IDS ? [] : ids;
}

/** Returns a reason string if the record exceeds the size cap, else undefined. */
export function recordTooLarge(record: DataRecord): string | undefined {
  let n = 0;
  try { n = Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8'); } catch { return 'record is not serializable'; }
  return n > MAX_RECORD_BYTES ? `record is ${n} bytes; the per-record cap is ${MAX_RECORD_BYTES} bytes` : undefined;
}

/** Backends a bundle cannot round-trip: adapters over stores that are derived and rebuild
 *  themselves (knowledge, the system vectors index) or are not record stores at all (file).
 *  Their exportSince/importBatch throw SYNC_NOT_SUPPORTED. */
export const RAW_UNSUPPORTED_BACKENDS: ReadonlySet<BackendKind> = new Set<BackendKind>(['knowledge', 'vectors', 'file']);


/** "Identical content" for import: equal fields, text, metadata and deleted under a
 *  canonical compare. Version, timestamps and origin are deliberately NOT content. */
export function sameRecordContent(a: DataRecord, b: DataRecord): boolean {
  const view = (r: DataRecord) => canonicalJson({ fields: r.fields ?? {}, text: r.text ?? null, metadata: r.metadata ?? null, deleted: r.deleted === true });
  return view(a) === view(b);
}

/** Well-formed enough to store: the fields every reader and the LWW compare rely on. */
function isImportableRecord(r: unknown): r is DataRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as DataRecord;
  return typeof x.id === 'string' && x.id.length > 0
    && typeof x.version === 'number' && Number.isFinite(x.version) && x.version >= 0
    && !!x.fields && typeof x.fields === 'object' && !Array.isArray(x.fields)
    && typeof x.createdAt === 'string' && typeof x.updatedAt === 'string'
    && (x.deleted === undefined || typeof x.deleted === 'boolean');
}

/**
 * PURE per-record import decision (the spec's policy table). A local TOMBSTONE counts as
 * present: a deletion is only ever undone by a record that wins on the policy's terms.
 *  - absent locally           → 'add', written VERBATIM (version/createdAt/updatedAt/deleted
 *                               kept, origin cleared: the record becomes locally owned);
 *  - 'merge'                  → bundle wins LWW ⇒ 'update' verbatim; else skip
 *                               ('skipIdentical' when the content matches, 'skipOlder' otherwise);
 *  - 'add-missing'            → never touches a present record ('skipIdentical' / 'skipExists');
 *  - 'replace'                → identical content ⇒ 'skipIdentical'; else 'update' AS A NEW
 *                               VERSION: max(local, bundle)+1 and updatedAt=now, so the restored
 *                               state out-LWWs every replica.
 */
export function planImportRecord(
  incoming: DataRecord,
  local: DataRecord | null,
  policy: ImportPolicy,
  nowIso: string,
): { bucket: ImportBucket; write?: DataRecord } {
  const verbatim: DataRecord = { ...incoming, origin: undefined };
  if (!local) return { bucket: 'add', write: verbatim };
  const identical = sameRecordContent(incoming, local);
  if (policy === 'add-missing') return { bucket: identical ? 'skipIdentical' : 'skipExists' };
  if (policy === 'merge') {
    // Origins are stripped on BOTH sides: isNewer's last tie-break is origin.machineId, and
    // an owned record has none — a bundle copy of the very same write must not "win" on it.
    if (isNewer(verbatim, { ...local, origin: undefined })) return { bucket: 'update', write: verbatim };
    return { bucket: identical ? 'skipIdentical' : 'skipOlder' };
  }
  if (identical) return { bucket: 'skipIdentical' };
  return {
    bucket: 'update',
    write: { ...verbatim, version: Math.max(local.version, incoming.version) + 1, updatedAt: nowIso },
  };
}

/** The CreateDatasetInput a bundle's dataset line produces (spec: "For a created dataset").
 *  Keeps id/backend/title/scope/syncMode/config/sensitive. visibility/acl come from the
 *  bundle only when the BUNDLE side owned the dataset; a replica's local-only / empty ACL
 *  is an artifact of replication, so a replica line defaults to cross-node-readable / []. */
export function bundleDescriptorToCreateInput(
  descriptor: DatasetDescriptor,
  replicaOf?: NodeOrigin | null,
): import('./dataset-registry').CreateDatasetInput {
  const bundleOwned = !descriptor.origin && !replicaOf;
  return {
    id: descriptor.id,
    backend: descriptor.backend,
    title: descriptor.title,
    scope: descriptor.scope,
    syncMode: descriptor.syncMode,
    config: descriptor.config,
    sensitive: descriptor.sensitive,
    visibility: bundleOwned ? descriptor.visibility : 'cross-node-readable',
    acl: bundleOwned ? (Array.isArray(descriptor.acl) ? descriptor.acl : []) : [],
  };
}

export class DataService {
  private enabledOverride?: boolean; // tests only
  // Per-(dataset,key) promise-chain mutex. Without it, two concurrent CAS put()s on the same
  // key both read the same stored version, both pass the ifVersion compare, and both write —
  // a silent lost update (CAS's entire purpose is multi-writer safety). Serializes ALL puts to
  // a key (not just CAS ones) so a plain put can't slip between a CAS put's read and write.
  // Shareable (deps.locks) so the SyncEngine's tombstone GC deletes under the SAME lock.
  private locks: KeyedLocks;
  constructor(private deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager; notify?: (dataset: string, type: 'changed' | 'deleted', ids: string[]) => void; peers?: PeerClient; locks?: KeyedLocks }) {
    this.locks = deps.locks ?? new KeyedLocks();
  }

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
    const bq = boundQuerySpec(q);
    // Hide tombstones from every consumer at THE seam all backends/callers pass through.
    // Filtered on the TOP-LEVEL flag in code — NOT via a QueryFilter on 'deleted', because
    // getField() prefers fields.* and a user record carrying a `deleted` field would vanish.
    //
    // Because the filter runs AFTER the backend pages, a page could come back short — or
    // EMPTY — while live records remain beyond it, and callers that page until an empty
    // page would silently miss data. So: BOUNDED REFILL — keep fetching subsequent backend
    // pages until the requested limit is filled or the records run out. The iteration cap
    // bounds the work a tombstone-heavy dataset can consume in one call; past the cap the
    // page returns short (honest, but bounded — the next offset still reaches the rest).
    const live: DataRecord[] = [];
    let tombstonesSeen = 0;
    let total: number | undefined;
    let offset = bq.offset;
    for (let i = 0; i < TOMBSTONE_REFILL_MAX_PAGES; i++) {
      const r = await a.value.backend!.query(datasetId, { ...bq, offset });
      const pageLive = r.records.filter((rec) => rec.deleted !== true);
      tombstonesSeen += r.records.length - pageLive.length;
      live.push(...pageLive);
      if (r.total !== undefined) total = r.total;
      offset += r.records.length;
      if (live.length >= bq.limit) break;          // requested window filled
      if (r.records.length < bq.limit) break;      // backend ran out of records
    }
    // total is best-effort under pagination: subtract the tombstones seen across the pages
    // actually fetched (tombstones beyond them can't be counted without a second scan).
    return {
      ok: true,
      value: {
        records: live.slice(0, bq.limit).map(redactRecord),
        total: total !== undefined ? total - tombstonesSeen : undefined,
      },
    };
  }

  async search(ctx: CallCtx, datasetId: string, spec: SearchSpec): Promise<DataResult<Array<DataRecord & { score: number }>>> {
    const a = await this.authorize(ctx, datasetId, 'search');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.search) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" does not support search` };
    // Same honest-pagination concern as query(): filtering tombstones AFTER the backend
    // ranks + truncates can under-fill the requested limit while live matches remain.
    // Search has no offset, so the refill re-asks with a DOUBLED limit (bounded by the
    // same iteration cap + MAX_QUERY_ROWS) until the request is filled or the backend
    // returns fewer than asked (i.e. the corpus is exhausted).
    let results = await backend.search(datasetId, spec);
    let liveResults = results.filter((r) => r.deleted !== true);
    const requested = spec.limit ?? results.length; // backends apply their own default when unset
    let asked = requested;
    for (let i = 0; i < TOMBSTONE_REFILL_MAX_PAGES && liveResults.length < requested; i++) {
      if (results.length < asked) break;            // backend already returned everything it has
      if (asked >= MAX_QUERY_ROWS) break;           // never ask beyond the global row ceiling
      asked = Math.min(asked * 2, MAX_QUERY_ROWS);
      results = await backend.search(datasetId, { ...spec, limit: asked });
      liveResults = results.filter((r) => r.deleted !== true);
    }
    return { ok: true, value: liveResults.slice(0, requested).map((r) => ({ ...redactRecord(r), score: r.score })) };
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
    try { this.deps.notify?.(d.id, type, boundNotifyIds(ids)); } catch { /* bus off / not ready — reconcile heals */ }
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
      // Re-check ownership INSIDE the lock: an auto-demotion (SyncEngine.resolveSuperseded)
      // can land between the entry check and here, and a write acknowledged onto a replica
      // never reaches the fleet (the new owner does not pull from replicas).
      if (this.deps.datasets.get(datasetId)?.origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" became a remote replica (read-only)` };
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

  /** Promise-chain mutex over the shared KeyedLocks (see key-lock.ts). */
  private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.withLock(key, fn);
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
      if (this.deps.datasets.get(datasetId)?.origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" became a remote replica (read-only)` };
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
    const { system, origin, supersedes, ...safe } = input as import('./dataset-registry').CreateDatasetInput & { origin?: unknown };
    void system; void origin; void supersedes;
    return this.allocateDataset(ctx, safe);
  }

  /** Registry create + backend allocation, rolled back when the allocation fails. */
  private async allocateDataset(ctx: CallCtx, safe: import('./dataset-registry').CreateDatasetInput): Promise<DataResult<import('./types').DatasetDescriptor>> {
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

  // Data bundles (export / import) --------------------------------------------------
  //
  // Faithful primitives for point-in-time bundles. Unlike get/query/exportDataset they do
  // NOT redact (a bundle must round-trip bytes, and redaction would permanently overwrite
  // the owner's own data on restore) — which is exactly why they are LOCAL-principal only.
  // The auth boundary for owner/remote callers is the ROUTE, which calls these with the
  // internal {type:'local'} ctx after its own checks.

  /** Unredacted, tombstone-inclusive full read of one dataset (owned or replica). Pages
   *  past the backend's 50k export cap; an export that cannot be proven complete is an
   *  error (EXPORT_INCOMPLETE), never a silently short bundle. */
  async exportRaw(ctx: CallCtx, datasetId: string): Promise<DataResult<DataRecord[]>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'raw export is local-only' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    if (RAW_UNSUPPORTED_BACKENDS.has(d.backend)) {
      return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${d.backend}" is derived or file-backed and is not exported` };
    }
    const backend = this.deps.backends.get(d.backend);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `backend "${d.backend}" unavailable` };
    try {
      const r = await exportAllRecords(backend, datasetId);
      if (!r.complete) return { ok: false, code: 'EXPORT_INCOMPLETE', reason: r.reason };
      return { ok: true, value: r.records };
    } catch (e) {
      return { ok: false, code: 'EXPORT_FAILED', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Faithful import of bundle records into an OWNED dataset, per `planImportRecord`'s policy
   * table. Import never deletes: local records absent from `records` are untouched. Each
   * write runs under the SAME per-key lock put()/del() use, so a concurrent put cannot slip
   * between the read and the write. After a real apply, ONE batched change-notify fires for
   * the dataset so peers pull promptly. `dryRun` computes the identical outcome without a
   * single write. Refuses a replica (READ_ONLY_REPLICA) — taking ownership is a separate,
   * guarded step (takeover).
   */
  async importRaw(
    ctx: CallCtx,
    datasetId: string,
    records: DataRecord[],
    opts: { policy: ImportPolicy; dryRun: boolean },
  ): Promise<DataResult<ImportOutcome>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'raw import is local-only' };
    const policy = opts?.policy;
    if (!IMPORT_POLICIES.includes(policy)) {
      return { ok: false, code: 'BAD_REQUEST', reason: `unknown import policy ${JSON.stringify(policy)} (expected ${IMPORT_POLICIES.join(' | ')})` };
    }
    if (!Array.isArray(records)) return { ok: false, code: 'BAD_REQUEST', reason: 'records must be an array' };
    const d = this.deps.datasets.get(datasetId);
    if (!d) return { ok: false, code: 'NOT_FOUND', reason: `dataset "${datasetId}" not found` };
    if (d.origin) {
      return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a replica of ${d.origin.hostname || d.origin.machineId} — import on the origin, or take it over first` };
    }
    if (d.system) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${datasetId}" is a system dataset` };
    if (d.readOnly) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${datasetId}" is read-only` };
    if (RAW_UNSUPPORTED_BACKENDS.has(d.backend)) {
      return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${d.backend}" is derived or file-backed and is not imported` };
    }
    const backend = this.deps.backends.get(d.backend);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `backend "${d.backend}" unavailable` };

    const dryRun = opts.dryRun !== false; // anything but an explicit false is a plan, never a write
    const counts = Object.fromEntries(IMPORT_BUCKETS.map((b) => [b, 0])) as Record<ImportBucket, number>;
    const samples = Object.fromEntries(IMPORT_BUCKETS.map((b) => [b, [] as string[]])) as Record<ImportBucket, string[]>;
    const note = (bucket: ImportBucket, id: unknown) => {
      counts[bucket]++;
      if (samples[bucket].length < IMPORT_SAMPLE_MAX && typeof id === 'string' && id) samples[bucket].push(id);
    };
    const written: string[] = [];
    // A SYNCED dataset's replicas pull by an updatedAt watermark (sync-engine pullOne:
    // `since` = the newest updatedAt they hold). A record written with the bundle's OLD
    // updatedAt sorts below every replica's watermark and would never reach them — the
    // import would report `add` while the fleet never converges. So every write into a
    // synced dataset is stamped updatedAt=now; version, createdAt and deleted stay verbatim
    // (isNewer compares version first, so LWW only changes on a same-version tie-break).
    // Stamped HERE, not in the pure planImportRecord, so plans compare the bundle as-is.
    const synced = !d.sensitive && !!d.syncMode && d.syncMode !== 'none';
    let failed: { code: string; reason: string } | undefined;

    for (const incoming of records) {
      if (!isImportableRecord(incoming)) { note('invalid', (incoming as { id?: unknown } | null)?.id); continue; }
      if (recordTooLarge(incoming)) { note('tooLarge', incoming.id); continue; }
      const step = async (): Promise<ImportBucket | 'demoted'> => {
        // Re-check ownership inside the lock: an auto-demotion can land mid-import.
        if (!dryRun && this.deps.datasets.get(datasetId)?.origin) return 'demoted';
        const local = await backend.get(datasetId, incoming.id);
        const nowIso = new Date().toISOString();
        const plan = planImportRecord(incoming, local, policy, nowIso);
        if (plan.write && !dryRun) {
          const write = synced ? { ...plan.write, updatedAt: nowIso } : plan.write;
          await backend.put(datasetId, write);
        }
        return plan.bucket;
      };
      let bucket: ImportBucket | 'demoted';
      try {
        bucket = dryRun ? await step() : await this.withKeyLock(`${datasetId}:${incoming.id}`, step);
      } catch (e) {
        // A backend write error (MDB_MAP_FULL, a sql worker failure) mid-import: stop, but
        // still notify what WAS written and report the partial counts — never a raw throw
        // that loses both.
        failed = { code: 'IMPORT_FAILED', reason: `record "${incoming.id}": ${e instanceof Error ? e.message : String(e)}` };
        break;
      }
      if (bucket === 'demoted') {
        failed = { code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" became a replica during the import — the rest was not written` };
        break;
      }
      note(bucket, incoming.id);
      if (!dryRun && (bucket === 'add' || bucket === 'update')) written.push(incoming.id);
    }

    if (written.length) this.notifyChange(d, 'changed', written);
    return { ok: true, value: { dataset: datasetId, policy, dryRun, total: records.length, counts, samples, ...(failed ? { failed } : {}) } };
  }

  /** Create an OWNED dataset from a bundle's descriptor (the rebuilt-origin / new-fleet path)
   *  and allocate its storage. Local-only, like createDataset. `replicaOf` is the bundle
   *  line's marker that the exporting node held it as a replica. Whether creating it is
   *  SAFE (owner online elsewhere ⇒ split brain) is the caller's ownership check. */
  async createDatasetFromBundle(
    ctx: CallCtx,
    descriptor: DatasetDescriptor,
    opts: { replicaOf?: NodeOrigin | null; supersedes?: import('./types').SupersedesMarker } = {},
  ): Promise<DataResult<DatasetDescriptor>> {
    if (ctx.principal.type !== 'local') return { ok: false, code: 'FORBIDDEN', reason: 'dataset creation is local-only' };
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.id !== 'string') {
      return { ok: false, code: 'BAD_REQUEST', reason: 'bundle dataset descriptor is malformed' };
    }
    if (descriptor.system) return { ok: false, code: 'FORBIDDEN', reason: `dataset "${descriptor.id}" is a system dataset` };
    if (RAW_UNSUPPORTED_BACKENDS.has(descriptor.backend)) {
      return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${descriptor.backend}" is derived or file-backed and is not imported` };
    }
    const input = bundleDescriptorToCreateInput(descriptor, opts.replicaOf);
    return this.allocateDataset(ctx, opts.supersedes?.machineId ? { ...input, supersedes: opts.supersedes } : input);
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
  syncManifest(p: Principal): Array<{ id: string; syncMode: SyncMode; ownerNode: string; backend: BackendKind; scope: 'cluster' | 'fleet'; supersedes?: string; supersedesAt?: string }> {
    const readActions: DataAction[] = ['read'];
    const out = [];
    for (const d of this.deps.datasets.list()) {
      if ((d as any).sensitive) continue;
      const syncMode: SyncMode = (d.syncMode || 'none') as SyncMode;
      if (syncMode === 'none') continue;
      const actions = this.deps.manager.evaluateGrants(p, d, readActions);
      if (!actions.length) continue;
      out.push({
        id: d.id, syncMode, ownerNode: d.ownerNode, backend: d.backend, scope: (d.scope ?? 'cluster'),
        // A takeover's marker, so the superseded origin can demote itself (SyncEngine).
        ...(d.supersedes?.machineId ? { supersedes: d.supersedes.machineId, ...(d.supersedes.at ? { supersedesAt: d.supersedes.at } : {}) } : {}),
      });
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
    // ONE lock instance for put/del AND the sync engine's tombstone GC — the GC's
    // check-then-delete must serialize against a concurrent CAS re-create.
    const locks = new KeyedLocks();
    engineInstance = new SyncEngine({ datasets, backends, peers, nodeId, locks });
    instance = new DataService({
      datasets, backends, manager, peers, locks,
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
