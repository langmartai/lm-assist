// core/src/data/backends/knowledge-backend.ts
// System-dataset adapter over the EXISTING knowledge store (getKnowledgeStore) + vector store
// (getVectorStore, for search). Delegates to the stores' own methods so every invariant the
// /knowledge routes maintain (index.json consistency, knowledge<->vector linkage) holds unchanged.
// This adapter NEVER reaches into store internals and NEVER duplicates store logic.
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin,
} from '../types';
import { applyQuery } from './query-filter';
import { getKnowledgeStore } from '../../knowledge/store';
import { getVectorStore } from '../../vector/vector-store';
import type { Knowledge } from '../../knowledge/types';

/** Map an existing Knowledge document to the generic DataRecord shape. */
export function knowledgeToRecord(k: Knowledge): DataRecord {
  return {
    id: k.id,
    version: 1, // knowledge has no generic version; system datasets are not LWW-synced
    fields: {
      title: k.title, type: k.type, project: k.project, status: k.status, parts: k.parts,
      origin: k.origin, machineId: k.machineId, sourceSessionId: k.sourceSessionId,
      reviewRating: k.reviewRating,
    },
    text: (k.parts || []).map((p) => p.content).join('\n\n'),
    metadata: { partCount: (k.parts || []).length },
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  };
}

export class KnowledgeBackend implements StorageBackend {
  readonly kind: BackendKind = 'knowledge';

  // createDataset/dropDataset are no-ops: the knowledge store owns its own storage lifecycle.
  async createDataset(_d: DatasetDescriptor): Promise<void> { /* store self-manages */ }
  async dropDataset(_id: string): Promise<void> { /* never drop the knowledge store */ }

  async get(_dataset: string, id: string): Promise<DataRecord | null> {
    const k = getKnowledgeStore().getKnowledge(id);
    return k ? knowledgeToRecord(k) : null;
  }

  async query(_dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const records = getKnowledgeStore().getAllKnowledge().map(knowledgeToRecord);
    return applyQuery(records, q);
  }

  async search(_dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>> {
    const limit = s.limit ?? 20;
    const hits = await getVectorStore().hybridSearch(s.query, limit, { type: 'knowledge' });
    const store = getKnowledgeStore();
    const out: Array<DataRecord & { score: number }> = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const kid = h.knowledgeId;
      if (!kid || seen.has(kid)) continue;
      seen.add(kid);
      const k = store.getKnowledge(kid);
      if (k) out.push({ ...knowledgeToRecord(k), score: h.score });
    }
    return out.slice(0, limit);
  }

  async delete(_dataset: string, id: string): Promise<boolean> {
    const removed = getKnowledgeStore().deleteKnowledge(id);
    if (removed) {
      // mirror the /knowledge delete route: drop the linked vectors too (invariant: knowledge<->vector)
      try { await getVectorStore().deleteKnowledge(id); } catch { /* best effort */ }
    }
    return removed;
  }

  // put + admin land in Task 3.
  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> { throw new Error('not implemented'); }

  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> {
    throw new Error('SYNC_NOT_SUPPORTED: knowledge is a system dataset (uses its own remote-sync)');
  }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    throw new Error('SYNC_NOT_SUPPORTED: knowledge is a system dataset (uses its own remote-sync)');
  }
}
