// core/src/data/data-service.ts
import type {
  Principal, DataAction, DataRecord, QuerySpec, SearchSpec, AccessRequest, BackendKind, NodeVisibility, SyncMode,
  PeerClient, NodeInfo,
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
import { ensureSystemDatasets, ensureTrackedFiles } from './system-datasets';
import { getKeyStore } from './key-store';
import { redactRecord, redactValueDeep } from './redaction';
import { thisNodeId } from './paths';
import { getProjectSettings } from '../project-settings';
import type { ParsedRequest } from '../routes/index';
import { getSyncQueue } from './sync-queue';
import { HubPeerClient } from './peer-client';
import { SyncEngine } from './sync-engine';

export interface CallCtx { principal: Principal; keyHeader?: string; }
export type DataResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

export class DataService {
  private enabledOverride?: boolean; // tests only
  constructor(private deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager; onLocalWrite?: (dataset: string, id: string) => void; peers?: PeerClient }) {}

  isEnabled(): boolean {
    if (typeof this.enabledOverride === 'boolean') return this.enabledOverride;
    return getProjectSettings().dataServiceEnabled === true;
  }

  resolvePrincipal(req: ParsedRequest): Principal { return this.deps.manager.resolvePrincipal(req); }

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
    if (local) return { ok: true, value: redactRecord(local) };
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
            await a.value.backend!.importBatch(datasetId, [stamped], origin); // lazy-cache locally
            return { ok: true, value: redactRecord(stamped) };
          }
        } catch { /* try next peer */ }
      }
    }
    return { ok: true, value: null };
  }

  async query(ctx: CallCtx, datasetId: string, q: QuerySpec): Promise<DataResult<{ records: DataRecord[]; total?: number }>> {
    const a = await this.authorize(ctx, datasetId, 'query');
    if (!a.ok) return a;
    const r = await a.value.backend!.query(datasetId, q);
    return { ok: true, value: { records: r.records.map(redactRecord), total: r.total } };
  }

  async search(ctx: CallCtx, datasetId: string, spec: SearchSpec): Promise<DataResult<Array<DataRecord & { score: number }>>> {
    const a = await this.authorize(ctx, datasetId, 'search');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.search) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" does not support search` };
    const results = await backend.search(datasetId, spec);
    return { ok: true, value: results.map((r) => ({ ...redactRecord(r), score: r.score })) };
  }

  async admin(ctx: CallCtx, datasetId: string, op: string, args?: Record<string, unknown>): Promise<DataResult<unknown>> {
    const a = await this.authorize(ctx, datasetId, 'manage');
    if (!a.ok) return a;
    const backend = a.value.backend!;
    if (!backend.admin) return { ok: false, code: 'NOT_SUPPORTED', reason: `backend "${backend.kind}" has no admin ops` };
    const result = await backend.admin(datasetId, op, args);
    return { ok: true, value: redactValueDeep(result) };
  }

  async put(ctx: CallCtx, datasetId: string, record: DataRecord): Promise<DataResult<{ id: string }>> {
    const a = await this.authorize(ctx, datasetId, 'write');
    if (!a.ok) return a;
    const d = this.deps.datasets.get(datasetId)!;
    if ((d as any).origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    const existing = await a.value.backend!.get(datasetId, record.id);
    const now = new Date().toISOString();
    const versioned: DataRecord = {
      ...record,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      origin: undefined, // local-owned record (origin is stamped only on replicas)
    };
    const r = await a.value.backend!.put(datasetId, versioned);
    this.deps.onLocalWrite?.(datasetId, record.id);
    return { ok: true, value: r };
  }

  async del(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<boolean>> {
    const a = await this.authorize(ctx, datasetId, 'delete');
    if (!a.ok) return a;
    const d = this.deps.datasets.get(datasetId)!;
    if ((d as any).origin) return { ok: false, code: 'READ_ONLY_REPLICA', reason: `dataset "${datasetId}" is a remote replica (read-only)` };
    return { ok: true, value: await a.value.backend!.delete(datasetId, id) };
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

  // M5 sync helpers ----------------------------------------------------------------

  /** Returns this node's stable id. */
  nodeId(): string { return thisNodeId(); }

  /**
   * Peer-facing single-record read — authorizes 'read' and returns the LOCAL record
   * (redacted) WITHOUT the partial remote-fallback that `get` uses. The peer-facing
   * fetch must serve THIS node's record only; recursing to other peers would cycle.
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
  syncManifest(p: Principal): Array<{ id: string; syncMode: SyncMode; ownerNode: string; backend: BackendKind }> {
    const readActions: DataAction[] = ['read'];
    const out = [];
    for (const d of this.deps.datasets.list()) {
      if ((d as any).sensitive) continue;
      const syncMode: SyncMode = (d.syncMode || 'none') as SyncMode;
      if (syncMode === 'none') continue;
      const actions = this.deps.manager.evaluateGrants(p, d, readActions);
      if (!actions.length) continue;
      out.push({ id: d.id, syncMode, ownerNode: d.ownerNode, backend: d.backend });
    }
    return out;
  }
}

let instance: DataService | null = null;
let engineInstance: SyncEngine | null = null;

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
    const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: thisNodeId() });
    const queue = getSyncQueue();
    const nodeId = thisNodeId();
    const peers = new HubPeerClient(nodeId);
    engineInstance = new SyncEngine({ datasets, backends, peers, nodeId });
    instance = new DataService({ datasets, backends, manager, onLocalWrite: (dataset, id) => queue.markDirty(dataset, id), peers });
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
