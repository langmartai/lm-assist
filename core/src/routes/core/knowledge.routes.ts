/**
 * Knowledge Routes
 *
 * REST API for knowledge CRUD, comments, batch review, and search.
 * Vector indexing is decoupled — use /vectors/* endpoints instead.
 *
 * Endpoints:
 *   GET    /knowledge                         # List (filters: project, type, status)
 *   GET    /knowledge/:id                     # Get full document
 *   GET    /knowledge/:id/parts/:partId       # Get specific part
 *   POST   /knowledge                         # Create
 *   PUT    /knowledge/:id                     # Update
 *   DELETE /knowledge/:id                     # Delete
 *   GET    /knowledge/:id/comments            # Get comments (query: includeAddressed)
 *   POST   /knowledge/:id/comments            # Add comment
 *   PUT    /knowledge/comments/:commentId     # Update comment state
 *   POST   /knowledge/review                  # Trigger batch review
 *   GET    /knowledge/review/status           # Review process status
 *   GET    /knowledge/search                  # Hybrid search (vector + FTS)
 */

import type { RouteHandler, RouteContext } from '../index';
import { getKnowledgeStore } from '../../knowledge/store';
import { KNOWLEDGE_TYPES, COMMENT_TYPES } from '../../knowledge/types';
import type { KnowledgeType, KnowledgeCommentType } from '../../knowledge/types';

// File-change-invalidated cache for /knowledge/generate/stats
let _statsCache: { candidates: number; generated: number } | null = null;
let _statsCacheDirty = true;

// Register invalidation with SessionCache (deferred to avoid import-order issues)
let _statsWatcherRegistered = false;
function ensureStatsWatcher(): void {
  if (_statsWatcherRegistered) return;
  _statsWatcherRegistered = true;
  try {
    const { getSessionCache } = require('../../session-cache');
    const cache = getSessionCache();
    cache.onFileEvent(() => {
      _statsCacheDirty = true;
    });
  } catch {
    // SessionCache not ready; cache stays dirty
  }
}

export function createKnowledgeRoutes(_ctx: RouteContext): RouteHandler[] {
  ensureStatsWatcher();
  return [
    // GET /knowledge — List all knowledge documents
    // ?origin=local|remote|all (default: all) — filter by origin
    {
      method: 'GET',
      pattern: /^\/knowledge$/,
      handler: async (req) => {
        const store = getKnowledgeStore();
        const project = req.query.project;
        const type = req.query.type as KnowledgeType | undefined;
        // status defaults to 'active'; pass 'all' to list all statuses
        const statusParam = req.query.status || 'active';
        const status = statusParam === 'all' ? undefined : statusParam;
        // origin filter: 'local' = only local, 'remote' = only remote, 'all'/undefined = all
        const originParam = req.query.origin as string | undefined;
        const origin = (originParam === 'local' || originParam === 'remote') ? originParam : undefined;

        const list = store.getKnowledgeList(
          project || undefined,
          type && KNOWLEDGE_TYPES.includes(type) ? type : undefined,
          status,
          origin,
        );

        return { success: true, data: list };
      },
    },

    // GET /knowledge/search — Hybrid search (vector + FTS + content-match)
    {
      method: 'GET',
      pattern: /^\/knowledge\/search$/,
      handler: async (req) => {
        const query = req.query.query || req.query.q;
        if (!query) {
          return { success: false, error: 'query parameter is required' };
        }

        const limit = parseInt(req.query.limit || '0', 10) || 0; // 0 = no limit

        try {
          const { getVectorStore } = require('../../vector/vector-store');
          const vectorStore = getVectorStore();
          const knowledgeStore = getKnowledgeStore();

          // Hybrid search: vector + FTS with RRF merge
          const fetchCount = limit > 0 ? Math.max(limit * 2, 15) : 50;
          const hybridResults = await vectorStore.hybridSearch(query, fetchCount, { type: 'knowledge' });

          // Convert to scored format
          const merged = hybridResults.map((r: any) => ({
            type: 'knowledge' as const,
            id: r.partId || r.knowledgeId || '',
            sessionId: r.sessionId,
            score: r.score,
            finalScore: 0,
            timestamp: r.timestamp || '',
            knowledgeId: r.knowledgeId,
            partId: r.partId,
            projectPath: r.projectPath,
            phase: r.phase as 1 | 2 | undefined,
            machineId: r.machineId || undefined,
          }));

          // Filter orphaned vectors (knowledge deleted but vectors remain)
          const valid: any[] = merged.filter((r: any) => {
            const kId = (r.knowledgeId || r.id || '').split('.')[0];
            if (!kId) return false;
            // For remote knowledge, look up with machineId
            return r.machineId
              ? !!knowledgeStore.getKnowledge(kId, r.machineId)
              : !!knowledgeStore.getKnowledge(kId);
          });

          // Content-match boost + supplementary knowledge scan
          if (query.length > 15) {
            const qLower = query.toLowerCase().trim();
            const existingIds = new Set(valid.map((r: any) => r.partId || r.id));
            let changed = false;

            // 1. Boost existing results that contain the query
            for (const r of valid) {
              const kId = (r.knowledgeId || r.id || '').split('.')[0];
              const knowledge = r.machineId
                ? knowledgeStore.getKnowledge(kId, r.machineId)
                : knowledgeStore.getKnowledge(kId);
              if (!knowledge) continue;
              const part = r.partId ? knowledge.parts.find((p: any) => p.partId === r.partId) : null;
              const haystack = [part?.title || '', part?.summary || '', part?.content || ''].join(' ').toLowerCase();
              if (haystack.includes(qLower)) {
                r.score *= 2.0;
                changed = true;
              }
            }

            // 2. Scan all knowledge for content matches not in RRF pool
            const injectionScore = Math.max(...valid.map((r: any) => r.score), 0.03);
            const allKnowledge = knowledgeStore.getAllKnowledge();
            for (const k of allKnowledge) {
              for (const part of k.parts) {
                if (existingIds.has(part.partId)) continue;
                const haystack = [part.title, part.summary, part.content].join(' ').toLowerCase();
                if (haystack.includes(qLower)) {
                  valid.push({
                    type: 'knowledge' as const,
                    id: part.partId,
                    sessionId: k.sourceSessionId || '',
                    score: injectionScore,
                    finalScore: 0,
                    timestamp: k.sourceTimestamp || k.createdAt || '',
                    knowledgeId: k.id,
                    partId: part.partId,
                    projectPath: k.project,
                    machineId: k.machineId || undefined,
                  });
                  existingIds.add(part.partId);
                  changed = true;
                }
              }
            }

            if (changed) valid.sort((a: any, b: any) => {
              const diff = b.score - a.score;
              if (Math.abs(diff) > 0.0001) return diff;
              return new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime();
            });
          }

          // Enrich results with knowledge/part titles for UI display
          const enriched = (limit > 0 ? valid.slice(0, limit) : valid).map((r: any) => {
            const kId = r.knowledgeId || (r.id || '').split('.')[0] || '';
            const knowledge = r.machineId
              ? knowledgeStore.getKnowledge(kId, r.machineId)
              : knowledgeStore.getKnowledge(kId);
            const knowledgeTitle = knowledge?.title || '';
            const knowledgeType = knowledge?.type || '';
            let partTitle = '';
            if (knowledge && r.partId) {
              const part = knowledge.parts.find((p: any) => p.partId === r.partId);
              partTitle = part?.title || '';
            }
            if (!knowledge) return r;
            return {
              ...r, knowledgeTitle, partTitle, knowledgeType,
              origin: knowledge.origin || 'local',
              machineHostname: knowledge.machineHostname,
              machineOS: knowledge.machineOS,
            };
          });

          return { success: true, data: enriched };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /knowledge/review/status — Review process status
    {
      method: 'GET',
      pattern: /^\/knowledge\/review\/status$/,
      handler: async () => {
        try {
          const { getKnowledgeReviewer } = require('../../knowledge/reviewer');
          const reviewer = getKnowledgeReviewer();
          return { success: true, data: reviewer.getStatus() };
        } catch {
          return { success: true, data: { status: 'not_initialized' } };
        }
      },
    },

    // POST /knowledge/review — Trigger batch review
    {
      method: 'POST',
      pattern: /^\/knowledge\/review$/,
      handler: async () => {
        try {
          const { getKnowledgeReviewer } = require('../../knowledge/reviewer');
          const reviewer = getKnowledgeReviewer();
          const result = await reviewer.review();
          return { success: true, data: result };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /knowledge/generate/stats — Candidate + generated counts
    // With ?project=... : scans one project for candidates
    // Without project  : scans all projects for candidates (cached, invalidated on file change)
    {
      method: 'GET',
      pattern: /^\/knowledge\/generate\/stats$/,
      handler: async (req) => {
        try {
          const store = getKnowledgeStore();
          const generatedCount = store.getGeneratedAgentIds().size;
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();

          const project = req.query.project;
          if (project) {
            const candidates = await generator.discoverExploreSessions(project);
            return {
              success: true,
              data: { candidates: candidates.length, generated: generatedCount },
            };
          }

          // Return cached stats if no file changes detected
          if (!_statsCacheDirty && _statsCache) {
            // Re-read generatedCount (cheap) since knowledge can be generated without file changes
            return {
              success: true,
              data: { candidates: _statsCache.candidates, generated: generatedCount },
            };
          }

          // Scan all projects for total candidates
          try {
            const { getProjectsService } = require('../../projects-service');
            const service = getProjectsService();
            const projects = service.listProjects({ includeSize: false });
            let totalCandidates = 0;
            for (const p of projects) {
              try {
                const candidates = await generator.discoverExploreSessions((p as any).path);
                totalCandidates += candidates.length;
              } catch { /* skip */ }
            }

            // Cache the result
            _statsCache = { candidates: totalCandidates, generated: generatedCount };
            _statsCacheDirty = false;

            return {
              success: true,
              data: { candidates: totalCandidates, generated: generatedCount },
            };
          } catch {
            return {
              success: true,
              data: { candidates: 0, generated: generatedCount },
            };
          }
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /knowledge/generate/candidates — List explore agent candidates for knowledge generation
    // With ?project=... : scans one project
    // Without project  : scans all projects
    {
      method: 'GET',
      pattern: /^\/knowledge\/generate\/candidates$/,
      handler: async (req) => {
        try {
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();
          const project = req.query.project;

          if (project) {
            const candidates = await generator.discoverExploreSessions(project);
            return { success: true, data: candidates };
          }

          // Scan all projects
          const { createProjectsService } = require('../../projects-service');
          const service = createProjectsService();
          const projects = service.listProjects({ includeSize: false });
          const allCandidates: any[] = [];
          for (const p of projects) {
            try {
              const candidates = await generator.discoverExploreSessions((p as any).path);
              // Tag each candidate with its project
              for (const c of candidates) {
                (c as any).project = (p as any).path;
              }
              allCandidates.push(...candidates);
            } catch { /* skip */ }
          }
          // Sort all by timestamp descending
          allCandidates.sort((a, b) => {
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;
            return b.timestamp.localeCompare(a.timestamp);
          });
          return { success: true, data: allCandidates };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /knowledge/generate — Generate knowledge from an explore agent session
    {
      method: 'POST',
      pattern: /^\/knowledge\/generate$/,
      handler: async (req) => {
        const { sessionId, agentId, project } = req.body || {};
        if (!sessionId || !agentId || !project) {
          return { success: false, error: 'sessionId, agentId, and project are required' };
        }

        try {
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();
          const knowledge = await generator.generateFromExplore(sessionId, agentId, project);
          return { success: true, data: knowledge };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /knowledge/:id/regenerate — Regenerate knowledge from its original explore source
    {
      method: 'POST',
      pattern: /^\/knowledge\/(?<id>K\d+)\/regenerate$/,
      handler: async (req) => {
        try {
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();
          const knowledge = await generator.regenerateKnowledge(req.params.id);
          return { success: true, data: knowledge };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /knowledge/generate/all — Batch generate knowledge from all candidates
    // With project: generates for one project
    // Without project: generates across all projects
    {
      method: 'POST',
      pattern: /^\/knowledge\/generate\/all$/,
      handler: async (req) => {
        const { project } = req.body || {};

        try {
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();

          if (project) {
            const result = await generator.generateAll(project);
            return { success: true, data: result };
          }

          // Generate across all projects
          const { createProjectsService } = require('../../projects-service');
          const service = createProjectsService();
          const projects = service.listProjects({ includeSize: false });
          let totalGenerated = 0;
          let totalErrors = 0;
          let stopped = false;

          for (const p of projects) {
            if (stopped) break;
            try {
              const result = await generator.generateAll((p as any).path);
              totalGenerated += result.generated;
              totalErrors += result.errors;
              stopped = result.stopped;
            } catch { /* skip */ }
          }

          return { success: true, data: { generated: totalGenerated, errors: totalErrors, stopped } };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // POST /knowledge/generate/stop — Stop batch generation
    {
      method: 'POST',
      pattern: /^\/knowledge\/generate\/stop$/,
      handler: async () => {
        try {
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();
          generator.stop();
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /knowledge/generate/status — Get generation status
    {
      method: 'GET',
      pattern: /^\/knowledge\/generate\/status$/,
      handler: async () => {
        try {
          const { getKnowledgeGenerator } = require('../../knowledge/generator');
          const generator = getKnowledgeGenerator();
          return { success: true, data: generator.getStatus() };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /knowledge/:id — Get full document
    {
      method: 'GET',
      pattern: /^\/knowledge\/(?<id>K\d+)$/,
      handler: async (req) => {
        const store = getKnowledgeStore();
        const knowledge = store.getKnowledge(req.params.id);
        if (!knowledge) {
          return { success: false, error: 'Not found' };
        }
        return { success: true, data: knowledge };
      },
    },

    // GET /knowledge/:id/parts/:partId — Get specific part
    {
      method: 'GET',
      pattern: /^\/knowledge\/(?<id>K\d+)\/parts\/(?<partId>K\d+\.\d+)$/,
      handler: async (req) => {
        const store = getKnowledgeStore();
        const part = store.getKnowledgePart(req.params.id, req.params.partId);
        if (!part) {
          return { success: false, error: 'Not found' };
        }
        return { success: true, data: part };
      },
    },

    // POST /knowledge — Create new knowledge document
    {
      method: 'POST',
      pattern: /^\/knowledge$/,
      handler: async (req) => {
        const { title, type, project, parts, markdown, status } = req.body || {};

        // Option 1: Create from raw Markdown
        if (markdown) {
          const store = getKnowledgeStore();
          const knowledge = store.createKnowledgeFromMd(markdown);
          if (!knowledge) {
            return { success: false, error: 'Failed to parse markdown' };
          }

          return { success: true, data: knowledge };
        }

        // Option 2: Create from structured data
        if (!title || !type) {
          return { success: false, error: 'title and type are required (or provide markdown)' };
        }
        if (!KNOWLEDGE_TYPES.includes(type)) {
          return { success: false, error: `type must be one of: ${KNOWLEDGE_TYPES.join(', ')}` };
        }
        if (status && !['active', 'outdated', 'archived'].includes(status)) {
          return { success: false, error: 'status must be one of: active, outdated, archived' };
        }

        const store = getKnowledgeStore();
        const knowledge = store.createKnowledge({
          title,
          type,
          project: project || '',
          parts: parts || [],
          status,
        });

        return { success: true, data: knowledge };
      },
    },

    // PUT /knowledge/:id — Update existing document
    {
      method: 'PUT',
      pattern: /^\/knowledge\/(?<id>K\d+)$/,
      handler: async (req) => {
        const store = getKnowledgeStore();
        const { markdown, title, type, project, status, parts } = req.body || {};

        // Validate type and status if provided
        if (type && !KNOWLEDGE_TYPES.includes(type)) {
          return { success: false, error: `type must be one of: ${KNOWLEDGE_TYPES.join(', ')}` };
        }
        if (status && !['active', 'outdated', 'archived'].includes(status)) {
          return { success: false, error: 'status must be one of: active, outdated, archived' };
        }

        let knowledge;

        if (markdown) {
          knowledge = store.updateKnowledgeFromMd(req.params.id, markdown);
        } else {
          knowledge = store.updateKnowledge(req.params.id, { title, type, project, status, parts });
        }

        if (!knowledge) {
          return { success: false, error: 'Not found or invalid markdown' };
        }

        return { success: true, data: knowledge };
      },
    },

    // DELETE /knowledge — Delete ALL knowledge
    {
      method: 'DELETE',
      pattern: /^\/knowledge$/,
      handler: async () => {
        try {
          const store = getKnowledgeStore();
          const all = store.getKnowledgeList();
          let deleted = 0;
          for (const k of all) {
            if (store.deleteKnowledge(k.id)) deleted++;
          }

          return { success: true, data: { deleted } };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // DELETE /knowledge/:id — Delete document
    {
      method: 'DELETE',
      pattern: /^\/knowledge\/(?<id>K\d+)$/,
      handler: async (req) => {
        const store = getKnowledgeStore();
        const deleted = store.deleteKnowledge(req.params.id);

        if (!deleted) {
          return { success: false, error: 'Not found' };
        }

        return { success: true };
      },
    },

    // GET /knowledge/:id/comments — Get comments
    {
      method: 'GET',
      pattern: /^\/knowledge\/(?<id>K\d+)\/comments$/,
      handler: async (req) => {
        const store = getKnowledgeStore();
        const includeAddressed = req.query.includeAddressed === 'true';
        const comments = store.getComments(req.params.id, includeAddressed);
        return { success: true, data: comments };
      },
    },

    // POST /knowledge/:id/comments — Add comment
    {
      method: 'POST',
      pattern: /^\/knowledge\/(?<id>K\d+)\/comments$/,
      handler: async (req) => {
        const { partId, type, content, source } = req.body || {};

        if (!type || !COMMENT_TYPES.includes(type)) {
          return { success: false, error: `type must be one of: ${COMMENT_TYPES.join(', ')}` };
        }
        if (!content) {
          return { success: false, error: 'content is required' };
        }

        const store = getKnowledgeStore();

        // Verify knowledge exists
        const knowledge = store.getKnowledge(req.params.id);
        if (!knowledge) {
          return { success: false, error: 'Knowledge document not found' };
        }

        // Verify part exists if specified
        if (partId && !knowledge.parts.find(p => p.partId === partId)) {
          return { success: false, error: `Part ${partId} not found in ${req.params.id}` };
        }

        const comment = store.addComment({
          knowledgeId: req.params.id,
          partId,
          type: type as KnowledgeCommentType,
          content,
          source: source || 'user',
        });

        return { success: true, data: comment };
      },
    },

    // POST /knowledge/remote-sync — Trigger remote knowledge sync
    {
      method: 'POST',
      pattern: /^\/knowledge\/remote-sync$/,
      handler: async (req) => {
        try {
          const { sync } = require('../../knowledge/remote-sync');
          const project = req.body?.project;

          // Fire-and-forget — returns immediately
          (async () => {
            try {
              await sync(project);
            } catch (err: any) {
              console.error('[RemoteSync] Background sync error:', err.message);
            }
          })();

          return { success: true, data: { started: true } };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // GET /knowledge/remote-sync/status — Get remote sync status
    {
      method: 'GET',
      pattern: /^\/knowledge\/remote-sync\/status$/,
      handler: async () => {
        try {
          const { getSyncStatus } = require('../../knowledge/remote-sync');
          return { success: true, data: getSyncStatus() };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // DELETE /knowledge/remote — Delete all remote knowledge
    {
      method: 'DELETE',
      pattern: /^\/knowledge\/remote$/,
      handler: async () => {
        try {
          const store = getKnowledgeStore();
          const remoteList = store.getKnowledgeList(undefined, undefined, undefined, 'remote');
          let deleted = 0;

          for (const k of remoteList) {
            if (k.machineId) {
              if (store.deleteRemoteKnowledge(k.machineId, k.id)) deleted++;
            }
          }

          // Also delete remote vectors
          try {
            const { getVectorStore } = require('../../vector/vector-store');
            const vectra = getVectorStore();
            await vectra.deleteAllRemoteKnowledge();
          } catch { /* best-effort */ }

          return { success: true, data: { deleted } };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    },

    // PUT /knowledge/comments/:commentId — Update comment state
    {
      method: 'PUT',
      pattern: /^\/knowledge\/comments\/(?<commentId>C\d+)$/,
      handler: async (req) => {
        const { knowledgeId, state, addressedBy } = req.body || {};

        if (!knowledgeId) {
          return { success: false, error: 'knowledgeId is required' };
        }
        if (!state || !['not_addressed', 'addressed'].includes(state)) {
          return { success: false, error: 'state must be "not_addressed" or "addressed"' };
        }

        const store = getKnowledgeStore();
        const updated = store.updateCommentState(knowledgeId, req.params.commentId, state, addressedBy);

        if (!updated) {
          return { success: false, error: 'Comment not found' };
        }

        return { success: true };
      },
    },
  ];
}
