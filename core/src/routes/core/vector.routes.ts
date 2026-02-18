/**
 * Vector Routes
 *
 * Unified API for vector store operations. Knowledge and milestones
 * are just different `type` values in the same Vectra store.
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
          const { getVectraStore } = require('../../vector/vectra-store');
          const vectra = getVectraStore();
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
                milestone: stats.milestoneVectors,
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
        const validTypes = ['knowledge', 'milestone', 'session'];
        const filter = type && validTypes.includes(type) ? { type } : undefined;

        try {
          const { getVectraStore } = require('../../vector/vectra-store');
          const vectra = getVectraStore();
          const results = await vectra.search(query, limit, filter);
          return { success: true, data: results };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /vectors/index — Index specific items by type
    // Body: { type: "knowledge", ids: ["K001"] }
    //    or { type: "milestone", sessionId: "...", indexes: [0,1] }
    //    Omit ids/indexes to index all of that type
    {
      method: 'POST',
      pattern: /^\/vectors\/index$/,
      handler: async (req) => {
        const { type, ids, sessionId, indexes } = req.body || {};
        if (!type) {
          return { success: false, error: 'type is required (knowledge, milestone)' };
        }

        try {
          const { getVectraStore } = require('../../vector/vectra-store');
          const { extractKnowledgeVectors, extractMilestoneVectors } = require('../../vector/indexer');
          const vectra = getVectraStore();

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

          if (type === 'milestone') {
            if (!sessionId) {
              return { success: false, error: 'sessionId is required for milestone indexing' };
            }

            const { getMilestoneStore } = require('../../milestone/store');
            const { getSessionCache } = require('../../session-cache');
            const milestoneStore = getMilestoneStore();
            const milestones = milestoneStore.getMilestones(sessionId);

            // Get session cache data for richer Phase 1 assistant/thinking vectors
            const sessionEntry = getSessionCache().getAllSessionsFromCache()
              .find((s: any) => s.sessionId === sessionId);
            const sessionCacheData = sessionEntry?.cacheData || null;

            const targetMilestones = indexes && indexes.length > 0
              ? milestones.filter((m: any) => indexes.includes(m.index))
              : milestones;

            const allVectors: Array<{ text: string; metadata: any }> = [];
            for (const m of targetMilestones) {
              allVectors.push(...extractMilestoneVectors(m, undefined, sessionCacheData));
            }

            if (allVectors.length > 0) {
              await vectra.addVectors(allVectors);
            }

            return {
              success: true,
              data: { type, sessionId, milestonesProcessed: targetMilestones.length, vectorsIndexed: allVectors.length },
            };
          }

          return { success: false, error: `Unsupported type: ${type}. Use 'knowledge' or 'milestone'` };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /vectors/reindex — Full reindex by type (async background)
    // Body: { type: "knowledge" } or { type: "milestone" }
    {
      method: 'POST',
      pattern: /^\/vectors\/reindex$/,
      handler: async (req) => {
        const { type } = req.body || {};
        if (!type) {
          return { success: false, error: 'type is required (knowledge, milestone)' };
        }

        try {
          const { getVectraStore } = require('../../vector/vectra-store');
          const vectra = getVectraStore();

          if (type === 'knowledge') {
            const { getKnowledgeStore } = require('../../knowledge/store');
            const { extractKnowledgeVectors } = require('../../vector/indexer');
            const store = getKnowledgeStore();
            const knowledgeIds = store.getAllIds();

            // Collect all vector texts+metadata (cheap, no embedding yet)
            const allVectors: Array<{ text: string; metadata: any }> = [];
            for (const id of knowledgeIds) {
              const knowledge = store.getKnowledge(id);
              if (!knowledge) continue;
              allVectors.push(...extractKnowledgeVectors(knowledge));
            }

            // Run delete + embed + insert in background (embedding is slow on CPU)
            (async () => {
              try {
                const startMs = Date.now();
                console.log(`[Reindex] Starting knowledge: ${allVectors.length} vectors from ${knowledgeIds.length} docs`);
                await vectra.deleteAllByType('knowledge');
                console.log(`[Reindex] Deleted old knowledge vectors in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
                if (allVectors.length > 0) {
                  const embedStart = Date.now();
                  await vectra.addVectors(allVectors);
                  console.log(`[Reindex] Indexed ${allVectors.length} knowledge vectors in ${((Date.now() - embedStart) / 1000).toFixed(1)}s`);
                }
                console.log(`[Reindex] Knowledge done: ${allVectors.length} vectors in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
              } catch (err: any) {
                console.error('[Reindex] Knowledge error:', err.message, err.stack);
              }
            })();

            return {
              success: true,
              data: { status: 'started', type, documentsToProcess: knowledgeIds.length, vectorsToIndex: allVectors.length },
            };
          }

          if (type === 'milestone') {
            const { getMilestoneStore } = require('../../milestone/store');
            const { extractMilestoneVectors } = require('../../vector/indexer');
            const { getSessionCache } = require('../../session-cache');
            const milestoneStore = getMilestoneStore();
            const index = milestoneStore.getIndex();
            const sessionIds = Object.keys(index.sessions);

            // Build sessionId → cacheData map for richer Phase 1 assistant/thinking vectors
            const sessionCacheMap = new Map<string, any>();
            for (const { sessionId: sid, cacheData: cd } of getSessionCache().getAllSessionsFromCache()) {
              sessionCacheMap.set(sid, cd);
            }

            // Collect all milestone vectors
            const allVectors: Array<{ text: string; metadata: any }> = [];
            let totalMilestones = 0;
            for (const sid of sessionIds) {
              const milestones = milestoneStore.getMilestones(sid);
              const cacheData = sessionCacheMap.get(sid) || null;
              for (const m of milestones) {
                allVectors.push(...extractMilestoneVectors(m, undefined, cacheData));
                totalMilestones++;
              }
            }

            // Run async
            (async () => {
              try {
                const startMs = Date.now();
                console.log(`[Reindex] Starting milestones: ${allVectors.length} vectors from ${totalMilestones} milestones`);
                await vectra.deleteAllByType('milestone');
                console.log(`[Reindex] Deleted old milestone vectors in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
                if (allVectors.length > 0) {
                  const embedStart = Date.now();
                  await vectra.addVectors(allVectors);
                  console.log(`[Reindex] Indexed ${allVectors.length} milestone vectors in ${((Date.now() - embedStart) / 1000).toFixed(1)}s`);
                }
                console.log(`[Reindex] Milestones done: ${allVectors.length} vectors in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
              } catch (err: any) {
                console.error('[Reindex] Milestone error:', err.message, err.stack);
              }
            })();

            return {
              success: true,
              data: { status: 'started', type, sessionsToProcess: sessionIds.length, milestonesToProcess: totalMilestones, vectorsToIndex: allVectors.length },
            };
          }

          return { success: false, error: `Unsupported type: ${type}. Use 'knowledge' or 'milestone'` };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // DELETE /vectors — Delete vectors by type and optional ID
    // ?type=knowledge             → delete all knowledge vectors
    // ?type=knowledge&id=K001     → delete specific knowledge doc vectors
    // ?type=milestone&sessionId=X → delete all milestone vectors for a session
    // ?type=milestone&sessionId=X&index=0 → delete specific milestone vectors
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
          const { getVectraStore } = require('../../vector/vectra-store');
          const vectra = getVectraStore();

          if (type === 'knowledge') {
            const id = req.query.id;
            if (id) {
              const deleted = await vectra.deleteKnowledge(id);
              return { success: true, data: { type, id, vectorsDeleted: deleted } };
            }
            const deleted = await vectra.deleteAllByType('knowledge');
            return { success: true, data: { type, vectorsDeleted: deleted } };
          }

          if (type === 'milestone') {
            const sessionId = req.query.sessionId;
            if (!sessionId) {
              const deleted = await vectra.deleteAllByType('milestone');
              return { success: true, data: { type, vectorsDeleted: deleted } };
            }
            const indexParam = req.query.index;
            if (indexParam !== undefined) {
              const milestoneIndex = parseInt(indexParam, 10);
              const deleted = await vectra.deleteMilestone(sessionId, milestoneIndex);
              return { success: true, data: { type, sessionId, milestoneIndex, vectorsDeleted: deleted } };
            }
            const deleted = await vectra.deleteSession(sessionId);
            return { success: true, data: { type, sessionId, vectorsDeleted: deleted } };
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
