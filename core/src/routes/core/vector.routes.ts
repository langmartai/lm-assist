/**
 * Vector Routes
 *
 * Unified API for vector store operations. Knowledge entries
 * are the primary vector type in the store.
 *
 * Endpoints:
 *   GET    /vectors/status    # Store status: total vectors, breakdown by type, initialized
 *   GET    /vectors/search    # Semantic search: ?q=...&type=knowledge&limit=10
 *   POST   /vectors/index     # Index items by type + IDs
 *   POST   /vectors/reindex   # Full reindex by type (async)
 *   DELETE /vectors           # Delete vectors by type and optional ID
 */

import type { RouteHandler, RouteContext } from '../index';

export function createVectorRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /vectors/status — Store status with breakdown by type
    {
      method: 'GET',
      pattern: /^\/vectors\/status$/,
      handler: async () => {
        try {
          const { getVectorStore } = require('../../vector/vector-store');
          const vectra = getVectorStore();
          const stats = await vectra.getStatsByType();

          // Count stale knowledge vectors (indexed but source doc deleted)
          let staleKnowledge = 0;
          if (stats.isInitialized && stats.knowledgeVectors > 0) {
            try {
              const { getKnowledgeStore } = require('../../knowledge/store');
              const store = getKnowledgeStore();
              const indexedIds = await vectra.getIndexedKnowledgeIds();
              for (const id of indexedIds) {
                if (!store.getKnowledge(id)) staleKnowledge++;
              }
            } catch { /* best-effort */ }
          }

          return {
            success: true,
            data: {
              initialized: stats.isInitialized,
              totalVectors: stats.totalVectors,
              byType: {
                knowledge: stats.knowledgeVectors,
                session: stats.sessionVectors,
              },
              stale: {
                knowledge: staleKnowledge,
              },
            },
          };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /vectors/search — Semantic search with optional type filter
    {
      method: 'GET',
      pattern: /^\/vectors\/search$/,
      handler: async (req) => {
        const query = req.query.q || req.query.query;
        if (!query) {
          return { success: false, error: 'q parameter is required' };
        }

        const limit = parseInt(req.query.limit || '10', 10);
        const type = req.query.type as string | undefined;
        const validTypes = ['knowledge', 'session'];
        const filter = type && validTypes.includes(type) ? { type } : undefined;

        try {
          const { getVectorStore } = require('../../vector/vector-store');
          const vectra = getVectorStore();
          const results = await vectra.search(query, limit, filter);
          return { success: true, data: results };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /vectors/index — Index specific items by type
    // Body: { type: "knowledge", ids: ["K001"] }
    {
      method: 'POST',
      pattern: /^\/vectors\/index$/,
      handler: async (req) => {
        const { type, ids } = req.body || {};
        if (!type) {
          return { success: false, error: 'type is required (knowledge)' };
        }

        try {
          const { getVectorStore } = require('../../vector/vector-store');
          const { extractKnowledgeVectors } = require('../../vector/indexer');
          const vectra = getVectorStore();

          if (type === 'knowledge') {
            const { getKnowledgeStore } = require('../../knowledge/store');
            const store = getKnowledgeStore();

            const targetIds: string[] = ids && ids.length > 0 ? ids : store.getAllIds();
            const allVectors: Array<{ text: string; metadata: any }> = [];

            for (const id of targetIds) {
              const knowledge = store.getKnowledge(id);
              if (!knowledge) continue;
              allVectors.push(...extractKnowledgeVectors(knowledge));
            }

            if (allVectors.length > 0) {
              await vectra.addVectors(allVectors);
            }

            return {
              success: true,
              data: { type, documentsProcessed: targetIds.length, vectorsIndexed: allVectors.length },
            };
          }

          return { success: false, error: `Unsupported type: ${type}. Use 'knowledge'` };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /vectors/reindex — Full reindex by type (async background)
    // Body: { type: "knowledge" }
    {
      method: 'POST',
      pattern: /^\/vectors\/reindex$/,
      handler: async (req) => {
        const { type } = req.body || {};
        if (!type) {
          return { success: false, error: 'type is required (knowledge)' };
        }

        try {
          const { getVectorStore } = require('../../vector/vector-store');
          const vectra = getVectorStore();

          if (type === 'knowledge') {
            const { getKnowledgeStore } = require('../../knowledge/store');
            const { extractKnowledgeVectors } = require('../../vector/indexer');
            const store = getKnowledgeStore();

            // Get all knowledge (local + remote) for reindex
            const allKnowledge = store.getAllKnowledge();

            // Collect all vector texts+metadata (cheap, no embedding yet), skip BAD-rated
            const allVectors: Array<{ text: string; metadata: any }> = [];
            let badSkipped = 0;
            let excludedSkipped = 0;
            for (const knowledge of allKnowledge) {
              if (knowledge.reviewRating === 'bad') { badSkipped++; continue; }
              if (knowledge.status === 'excluded') { excludedSkipped++; continue; }
              const remoteOrigin = knowledge.origin === 'remote' && knowledge.machineId
                ? { machineId: knowledge.machineId, machineHostname: knowledge.machineHostname || '', machineOS: knowledge.machineOS || '' }
                : undefined;
              allVectors.push(...extractKnowledgeVectors(knowledge, knowledge.project, remoteOrigin));
            }

            // Run delete + embed + insert in background (embedding is slow on CPU)
            const { setReindexStatus } = require('../../vector/vector-store');
            setReindexStatus({ type: 'knowledge', status: 'running', vectorsIndexed: 0, startedAt: new Date().toISOString(), completedAt: null });
            (async () => {
              try {
                const startMs = Date.now();
                console.log(`[Reindex] Starting knowledge: ${allVectors.length} vectors from ${allKnowledge.length} docs (${badSkipped} BAD + ${excludedSkipped} excluded skipped)`);
                // Full reindex: delete all knowledge vectors (local + remote) and re-add
                await vectra.deleteAllByType('knowledge');
                console.log(`[Reindex] Deleted old knowledge vectors in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
                if (allVectors.length > 0) {
                  const embedStart = Date.now();
                  await vectra.addVectors(allVectors);
                  console.log(`[Reindex] Indexed ${allVectors.length} knowledge vectors in ${((Date.now() - embedStart) / 1000).toFixed(1)}s`);
                }
                await vectra.rebuildFtsIndex();
                setReindexStatus({ status: 'done', vectorsIndexed: allVectors.length, completedAt: new Date().toISOString() });
                console.log(`[Reindex] Knowledge done: ${allVectors.length} vectors in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
              } catch (err: any) {
                setReindexStatus({ status: 'error', completedAt: new Date().toISOString() });
                console.error('[Reindex] Knowledge error:', err.message, err.stack);
              }
            })();

            return {
              success: true,
              data: { status: 'started', type, documentsToProcess: allKnowledge.length, vectorsToIndex: allVectors.length, badSkipped, excludedSkipped },
            };
          }

          return { success: false, error: `Unsupported type: ${type}. Use 'knowledge'` };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /vectors/reindex-status — Status of the most recent reindex operation
    {
      method: 'GET',
      pattern: /^\/vectors\/reindex-status$/,
      handler: async () => {
        try {
          const { getReindexStatus } = require('../../vector/vector-store');
          return { success: true, data: getReindexStatus() };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // DELETE /vectors — Delete vectors by type and optional ID
    // ?type=knowledge             → delete all knowledge vectors
    // ?type=knowledge&id=K001     → delete specific knowledge doc vectors
    // ?type=session&sessionId=X   → delete all session vectors
    {
      method: 'DELETE',
      pattern: /^\/vectors$/,
      handler: async (req) => {
        const type = req.query.type as string;
        if (!type) {
          return { success: false, error: 'type query parameter is required' };
        }

        try {
          const { getVectorStore } = require('../../vector/vector-store');
          const vectra = getVectorStore();

          if (type === 'knowledge') {
            const id = req.query.id;
            if (id) {
              const deleted = await vectra.deleteKnowledge(id);
              return { success: true, data: { type, id, vectorsDeleted: deleted } };
            }
            const deleted = await vectra.deleteAllByType('knowledge');
            return { success: true, data: { type, vectorsDeleted: deleted } };
          }

          if (type === 'session') {
            const sessionId = req.query.sessionId;
            if (!sessionId) {
              const deleted = await vectra.deleteAllByType('session');
              return { success: true, data: { type, vectorsDeleted: deleted } };
            }
            const deleted = await vectra.deleteSession(sessionId);
            return { success: true, data: { type, sessionId, vectorsDeleted: deleted } };
          }

          return { success: false, error: `Unsupported type: ${type}` };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },
  ];
}
