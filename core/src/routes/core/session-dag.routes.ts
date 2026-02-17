/**
 * Session DAG Routes
 *
 * REST endpoints for querying session conversations, subagent hierarchies,
 * resume branches, team relationships, and task dependencies as DAGs.
 *
 * Endpoints:
 *   GET  /sessions/:sessionId/dag                    Message DAG
 *   GET  /sessions/:sessionId/dag/node/:uuid         Single node with context
 *   GET  /sessions/:sessionId/dag/ancestors/:uuid    Ancestors to root
 *   GET  /sessions/:sessionId/dag/descendants/:uuid  Subtree
 *   GET  /sessions/:sessionId/dag/branches           Fork points
 *   GET  /sessions/:sessionId/session-dag            Cross-session DAG
 *   GET  /sessions/:sessionId/related                Related sessions
 *   GET  /dag/unified/:sessionId                     Session + task DAG
 *   POST /session-dag/batch                          Batch queries
 *   GET  /session-dag/cache/stats                    Cache statistics
 *   POST /session-dag/cache/warm                     Warm cache
 *   POST /session-dag/cache/clear                    Clear cache
 *   POST /session-dag/cache/warm-all                 Background warm
 */

import type { RouteHandler, RouteContext } from '../index';
import { getSessionDagService } from '../../session-dag';
import type { MessageDagOptions, SessionDagOptions, BatchQuery } from '../../session-dag';

export function createSessionDagRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // ========================================================================
    // Message DAG (intra-session)
    // ========================================================================

    // GET /sessions/:sessionId/dag - Full message DAG
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/dag$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const service = getSessionDagService();

        const options: MessageDagOptions = {};
        if (req.query.maxDepth) options.maxDepth = parseInt(req.query.maxDepth, 10);
        if (req.query.branch) options.branch = req.query.branch;
        if (req.query.types) options.types = req.query.types.split(',');
        if (req.query.includeContent === 'true') options.includeContent = true;
        if (req.query.fromLine) options.fromLine = parseInt(req.query.fromLine, 10);
        if (req.query.toLine) options.toLine = parseInt(req.query.toLine, 10);

        const start = Date.now();
        const result = await service.getMessageDag(sessionId, options);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found` },
          };
        }

        return {
          success: true,
          data: {
            sessionId,
            graph: result.graph,
            branches: result.branches,
          },
          durationMs: Date.now() - start,
        };
      },
    },

    // GET /sessions/:sessionId/dag/node/:uuid - Single node with context
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/dag\/node\/(?<uuid>[^/]+)$/,
      handler: async (req) => {
        const { sessionId, uuid } = req.params;
        const service = getSessionDagService();

        const start = Date.now();
        const result = await service.getNode(sessionId, uuid);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Node '${uuid}' not found in session '${sessionId}'` },
          };
        }

        return {
          success: true,
          data: result,
          durationMs: Date.now() - start,
        };
      },
    },

    // GET /sessions/:sessionId/dag/ancestors/:uuid - Walk to root
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/dag\/ancestors\/(?<uuid>[^/]+)$/,
      handler: async (req) => {
        const { sessionId, uuid } = req.params;
        const service = getSessionDagService();

        const start = Date.now();
        const result = await service.getAncestors(sessionId, uuid);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Node '${uuid}' not found in session '${sessionId}'` },
          };
        }

        return {
          success: true,
          data: result,
          durationMs: Date.now() - start,
        };
      },
    },

    // GET /sessions/:sessionId/dag/descendants/:uuid - Subtree
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/dag\/descendants\/(?<uuid>[^/]+)$/,
      handler: async (req) => {
        const { sessionId, uuid } = req.params;
        const service = getSessionDagService();

        const maxDepth = req.query.maxDepth ? parseInt(req.query.maxDepth, 10) : undefined;
        const types = req.query.types ? req.query.types.split(',') : undefined;

        const start = Date.now();
        const result = await service.getDescendants(sessionId, uuid, maxDepth, types);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Node '${uuid}' not found in session '${sessionId}'` },
          };
        }

        return {
          success: true,
          data: result,
          durationMs: Date.now() - start,
        };
      },
    },

    // GET /sessions/:sessionId/dag/branches - Fork points
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/dag\/branches$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const service = getSessionDagService();

        const start = Date.now();
        const result = await service.getBranches(sessionId);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found` },
          };
        }

        return {
          success: true,
          data: result,
          durationMs: Date.now() - start,
        };
      },
    },

    // ========================================================================
    // Session DAG (cross-session)
    // ========================================================================

    // GET /sessions/:sessionId/session-dag - Cross-session DAG
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/session-dag$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const service = getSessionDagService();

        const options: SessionDagOptions = {};
        if (req.query.depth) options.depth = parseInt(req.query.depth, 10);
        if (req.query.includeTeam !== undefined) options.includeTeam = req.query.includeTeam !== 'false';
        if (req.query.includeSubagents !== undefined) options.includeSubagents = req.query.includeSubagents !== 'false';
        if (req.query.includeForks !== undefined) options.includeForks = req.query.includeForks !== 'false';

        const start = Date.now();
        const result = await service.getSessionDag(sessionId, options);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found` },
          };
        }

        return {
          success: true,
          data: {
            graph: result.graph,
            team: result.team,
          },
          durationMs: Date.now() - start,
        };
      },
    },

    // GET /sessions/:sessionId/related - Related sessions
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/related$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const service = getSessionDagService();

        const start = Date.now();
        const result = await service.getRelatedSessions(sessionId);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found` },
          };
        }

        return {
          success: true,
          data: result,
          durationMs: Date.now() - start,
        };
      },
    },

    // ========================================================================
    // Unified DAG (sessions + tasks)
    // ========================================================================

    // GET /dag/unified/:sessionId - Combined session + task DAG
    {
      method: 'GET',
      pattern: /^\/dag\/unified\/(?<sessionId>[^/]+)$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const service = getSessionDagService();

        const start = Date.now();
        const result = await service.getUnifiedDag(sessionId);

        if (!result) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found` },
          };
        }

        return {
          success: true,
          data: result,
          durationMs: Date.now() - start,
        };
      },
    },

    // ========================================================================
    // Batch API
    // ========================================================================

    // POST /session-dag/batch - Execute multiple queries
    {
      method: 'POST',
      pattern: /^\/session-dag\/batch$/,
      handler: async (req) => {
        const body = req.body as { queries?: BatchQuery[] };

        if (!body.queries || !Array.isArray(body.queries)) {
          return {
            success: false,
            error: { code: 'INVALID_INPUT', message: 'queries array is required' },
          };
        }

        const service = getSessionDagService();

        const start = Date.now();
        const results = await service.executeBatch(body.queries);

        return {
          success: true,
          data: {
            results,
            totalQueries: body.queries.length,
            successCount: results.filter(r => r.success).length,
            failureCount: results.filter(r => !r.success).length,
          },
          durationMs: Date.now() - start,
        };
      },
    },

    // ========================================================================
    // Cache Management
    // ========================================================================

    // GET /session-dag/cache/stats - Cache statistics
    {
      method: 'GET',
      pattern: /^\/session-dag\/cache\/stats$/,
      handler: async () => {
        const service = getSessionDagService();
        return {
          success: true,
          data: service.getCacheStats(),
        };
      },
    },

    // POST /session-dag/cache/warm - Warm cache for session(s)
    {
      method: 'POST',
      pattern: /^\/session-dag\/cache\/warm$/,
      handler: async (req) => {
        const body = req.body as { sessionId?: string; sessionIds?: string[] };

        const ids: string[] = [];
        if (body.sessionId) ids.push(body.sessionId);
        if (body.sessionIds) ids.push(...body.sessionIds);

        if (ids.length === 0) {
          return {
            success: false,
            error: { code: 'INVALID_INPUT', message: 'sessionId or sessionIds is required' },
          };
        }

        const service = getSessionDagService();
        const start = Date.now();
        const result = await service.warmDagCache(ids);

        return {
          success: true,
          data: {
            ...result,
            durationMs: Date.now() - start,
          },
        };
      },
    },

    // POST /session-dag/cache/clear - Clear cache
    {
      method: 'POST',
      pattern: /^\/session-dag\/cache\/clear$/,
      handler: async (req) => {
        const body = req.body as { sessionId?: string };
        const service = getSessionDagService();

        if (body.sessionId) {
          service.clearCacheForSession(body.sessionId);
          return {
            success: true,
            data: { message: `Cache cleared for session '${body.sessionId}'` },
          };
        }

        service.clearAllCaches();
        return {
          success: true,
          data: { message: 'All DAG caches cleared' },
        };
      },
    },

    // POST /session-dag/cache/warm-all - Background warm
    {
      method: 'POST',
      pattern: /^\/session-dag\/cache\/warm-all$/,
      handler: async () => {
        const service = getSessionDagService();
        const result = await service.startBackgroundWarm();

        return {
          success: true,
          data: result,
        };
      },
    },
  ];
}
