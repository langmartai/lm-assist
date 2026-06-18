// core/src/data/backends/vectors-backend.ts
// System-dataset adapter over the EXISTING vector store (getVectorStore). Vectors are derived,
// bulk-managed data: there is no clean per-record generic identity, so get/put/delete are
// NOT_SUPPORTED and all mutation flows through declared `admin` ops that delegate to the store.
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin,
} from '../types';
import { applyQuery } from './query-filter';
import { getVectorStore } from '../../vector/vector-store';

function vectorHitToRecord(h: any): DataRecord & { score: number } {
  return {
    // composite id so multiple parts of one doc don't collide (vectors are non-record-addressable;
    // this id is a read-only projection field, not a storage key)
    id: [h.knowledgeId || h.sessionId || '', h.partId].filter(Boolean).join('#'),
    version: 1,
    fields: { type: h.type, contentType: h.contentType, sessionId: h.sessionId, knowledgeId: h.knowledgeId, partId: h.partId, origin: h.origin },
    text: h.text,
    createdAt: h.timestamp || '', updatedAt: h.timestamp || '',
    score: h.score,
  };
}

export class VectorsBackend implements StorageBackend {
  readonly kind: BackendKind = 'vectors';

  async createDataset(_d: DatasetDescriptor): Promise<void> { /* store self-manages */ }
  async dropDataset(_id: string): Promise<void> { /* never drop the vector store */ }

  async get(_dataset: string, _id: string): Promise<DataRecord | null> {
    throw new Error('NOT_SUPPORTED: vectors are bulk-managed; use search/query or data_admin ops');
  }
  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> {
    throw new Error('NOT_SUPPORTED: vectors are derived data; they are (re)built via the knowledge/session pipelines, not written directly');
  }
  async delete(_dataset: string, _id: string): Promise<boolean> {
    throw new Error('NOT_SUPPORTED: delete vectors via data_admin ops (delete-knowledge/delete-session/delete-all-by-type)');
  }

  async query(_dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    // No raw record listing; query is FTS-only over the vector text via the store's pure search,
    // then the shared filter/sort/limit is applied. Without a query string, returns empty.
    if (!q.fts) return { records: [], total: 0 };
    const hits = await getVectorStore().search(q.fts, q.limit ?? 50);
    return applyQuery(hits.map(vectorHitToRecord), q);
  }

  async search(_dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>> {
    const hits = await getVectorStore().hybridSearch(s.query, s.limit ?? 20);
    return hits.map(vectorHitToRecord);
  }

  async admin(_dataset: string, op: string, args?: Record<string, unknown>): Promise<unknown> {
    const a = args || {};
    const store = getVectorStore();
    switch (op) {
      case 'stats':
        return await store.getStatsByType();
      case 'rebuild-fts':
        await store.rebuildFtsIndex();
        return { ok: true };
      case 'delete-knowledge': {
        const id = String(a.knowledgeId || '');
        if (!id) throw new Error('delete-knowledge: knowledgeId is required');
        return { deleted: await store.deleteKnowledge(id) };
      }
      case 'delete-session': {
        const id = String(a.sessionId || '');
        if (!id) throw new Error('delete-session: sessionId is required');
        return { deleted: await store.deleteSession(id) };
      }
      case 'delete-all-by-type': {
        const t = String(a.type || '');
        if (t !== 'session' && t !== 'knowledge') throw new Error("delete-all-by-type: type must be 'session' or 'knowledge'");
        return { deleted: await store.deleteAllByType(t) };
      }
      default:
        throw new Error(`unknown admin op: ${op}`);
    }
  }

  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> {
    throw new Error('SYNC_NOT_SUPPORTED: vectors is a system dataset');
  }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    throw new Error('SYNC_NOT_SUPPORTED: vectors is a system dataset');
  }
}
