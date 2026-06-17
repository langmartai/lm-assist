// core/src/data/data-service.ts
import type {
  Principal, DataAction, DataRecord, QuerySpec, AccessRequest, BackendKind, NodeVisibility,
} from './types';
import type { DatasetRegistry } from './dataset-registry';
import { getDatasetRegistry } from './dataset-registry';
import type { BackendRegistry } from './backend-registry';
import { BackendRegistry as BReg } from './backend-registry';
import { AccessManager } from './access-manager';
import { CacheBackend } from './backends/cache-backend';
import { getKeyStore } from './key-store';
import { redactRecord } from './redaction';
import { thisNodeId } from './paths';
import { getProjectSettings } from '../project-settings';
import type { ParsedRequest } from '../routes/index';

export interface CallCtx { principal: Principal; keyHeader?: string; }
export type DataResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

export class DataService {
  private enabledOverride?: boolean; // tests only
  constructor(private deps: { datasets: DatasetRegistry; backends: BackendRegistry; manager: AccessManager }) {}

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
    const rec = await a.value.backend!.get(datasetId, id);
    return { ok: true, value: rec ? redactRecord(rec) : null };
  }

  async query(ctx: CallCtx, datasetId: string, q: QuerySpec): Promise<DataResult<{ records: DataRecord[]; total?: number }>> {
    const a = await this.authorize(ctx, datasetId, 'query');
    if (!a.ok) return a;
    const r = await a.value.backend!.query(datasetId, q);
    return { ok: true, value: { records: r.records.map(redactRecord), total: r.total } };
  }

  async put(ctx: CallCtx, datasetId: string, record: DataRecord): Promise<DataResult<{ id: string }>> {
    const a = await this.authorize(ctx, datasetId, 'write');
    if (!a.ok) return a;
    return { ok: true, value: await a.value.backend!.put(datasetId, record) };
  }

  async del(ctx: CallCtx, datasetId: string, id: string): Promise<DataResult<boolean>> {
    const a = await this.authorize(ctx, datasetId, 'delete');
    if (!a.ok) return a;
    return { ok: true, value: await a.value.backend!.delete(datasetId, id) };
  }
}

let instance: DataService | null = null;
export function getDataService(): DataService {
  if (!instance) {
    const datasets = getDatasetRegistry();
    const backends = new BReg();
    backends.register(new CacheBackend());
    const manager = new AccessManager({ datasets, keys: getKeyStore(), nodeId: thisNodeId() });
    instance = new DataService({ datasets, backends, manager });
  }
  return instance;
}
