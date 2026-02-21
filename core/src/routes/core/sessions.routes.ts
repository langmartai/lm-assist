/**
 * Sessions & Monitor Routes
 *
 * Endpoints: /sessions (read-only session access), /monitor
 *
 * Note: Legacy /sessions/* endpoints for execution tracking have been removed.
 * Use /executions/* for execution tracking.
 */

import type { RouteHandler, RouteContext } from '../index';
import { getSessionCache, isRealUserPrompt } from '../../session-cache';

export function createSessionsRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // ========================================================================
    // Monitor Endpoints
    // ========================================================================

    // POST /monitor/parallel - Monitor parallel executions
    {
      method: 'POST',
      pattern: /^\/monitor\/parallel$/,
      handler: async (req, api) => {
        return {
          success: true,
          data: {
            message: 'For parallel execution monitoring, use the SSE stream endpoint',
            streamUrl: '/stream',
            usage: 'Start multiple background executions via POST /execute/:tier with background=true, then connect to /stream to receive progress events',
          },
        };
      },
    },

    // POST /monitor/wait-all - Wait for all monitored executions
    {
      method: 'POST',
      pattern: /^\/monitor\/wait-all$/,
      handler: async (req, api) => {
        const response = await api.sessions.getMonitoredExecutions();
        if (!response.success || !response.data) {
          return { success: true, data: { message: 'No active executions.', activeCount: 0, executions: [], streamUrl: '/stream' } };
        }

        const executions = response.data.executions || [];
        const activeCount = executions.filter((e: any) => e.status === 'running').length;

        return {
          success: true,
          data: {
            message: activeCount > 0
              ? `${activeCount} execution(s) still running. Use SSE stream for real-time updates.`
              : 'No active executions to wait for.',
            activeCount,
            executions: executions.map((e: any) => ({
              executionId: e.executionId,
              tier: e.tier,
              status: e.status,
            })),
            streamUrl: '/stream',
          },
        };
      },
    },

    // GET /monitor/executions - Get monitored executions
    {
      method: 'GET',
      pattern: /^\/monitor\/executions$/,
      handler: async (req, api) => api.sessions.getMonitoredExecutions(),
    },

    // GET /monitor/summary - Get monitor summary
    {
      method: 'GET',
      pattern: /^\/monitor\/summary$/,
      handler: async (req, api) => api.sessions.getMonitorSummary(),
    },

    // POST /monitor/abort/:executionId - Abort execution
    {
      method: 'POST',
      pattern: /^\/monitor\/abort\/(?<executionId>[^/]+)$/,
      handler: async (req, api) => api.sessions.abortExecution(req.params.executionId),
    },

    // POST /monitor/abort-all - Abort all executions
    {
      method: 'POST',
      pattern: /^\/monitor\/abort-all$/,
      handler: async (req, api) => api.sessions.abortAll(),
    },

    // ========================================================================
    // Sessions API (reads from ~/.claude/projects/)
    // ========================================================================

    // GET /sessions - List sessions
    // Query params: cwd, limit
    {
      method: 'GET',
      pattern: /^\/sessions$/,
      handler: async (req, api) => {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
        return api.sessions.listSessions(req.query.cwd, { limit });
      },
    },

    // POST /sessions/batch-check - Batch check multiple sessions for updates
    {
      method: 'POST',
      pattern: /^\/sessions\/batch-check$/,
      handler: async (req, api) => {
        const body = req.body as {
          sessions?: Array<{ sessionId: string; knownFileSize?: number; knownAgentCount?: number }>;
          listCheck?: { projectPath?: string; knownSessionCount?: number; knownLatestModified?: string };
        };
        return api.sessions.batchCheckSessions(body);
      },
    },

    // GET /sessions/batch-check - Batch check via query params (for proxied environments where POST body is stripped)
    // Query params: listCheck.projectPath, listCheck.knownSessionCount, listCheck.knownLatestModified, sessions (JSON array)
    {
      method: 'GET',
      pattern: /^\/sessions\/batch-check$/,
      handler: async (req, api) => {
        const body: {
          sessions?: Array<{ sessionId: string; knownFileSize?: number; knownAgentCount?: number }>;
          listCheck?: { projectPath?: string; knownSessionCount?: number; knownLatestModified?: string };
        } = {};

        // Parse listCheck params
        const projectPath = req.query['listCheck.projectPath'];
        const knownSessionCount = req.query['listCheck.knownSessionCount'];
        const knownLatestModified = req.query['listCheck.knownLatestModified'];
        if (projectPath || knownSessionCount !== undefined || knownLatestModified) {
          body.listCheck = {};
          if (projectPath) body.listCheck.projectPath = projectPath;
          if (knownSessionCount !== undefined) body.listCheck.knownSessionCount = Number(knownSessionCount);
          if (knownLatestModified) body.listCheck.knownLatestModified = knownLatestModified;
        }

        // Parse sessions from JSON query param
        const sessions = req.query['sessions'];
        if (sessions) {
          try {
            body.sessions = JSON.parse(sessions);
          } catch {
            // ignore parse errors
          }
        }

        return api.sessions.batchCheckSessions(body);
      },
    },

    // GET /sessions/:sessionId - Get session
    // Query params: cwd, includeRawMessages, includeReads, fromLineIndex, toLineIndex, fromTurnIndex, toTurnIndex,
    //               fromUserPromptIndex, toUserPromptIndex, lastNUserPrompts (deprecated), unlimited,
    //               ifModifiedSince (ISO timestamp — returns notModified if session file unchanged)
    // Note: By default, returns last 50 user prompts. Use unlimited=true to get all data.
    // Note: By default, read-only file operations are excluded from fileChanges. Use includeReads=true to include them.
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)$/,
      handler: async (req, api) => api.sessions.getSession(
        req.params.sessionId,
        {
          cwd: req.query.cwd,
          includeRawMessages: req.query.includeRawMessages === 'true',
          // Line index filters (accept both fromLineIndex and fromLine aliases)
          fromLineIndex: (req.query.fromLineIndex || req.query.fromLine) ? parseInt(req.query.fromLineIndex || req.query.fromLine, 10) : undefined,
          toLineIndex: (req.query.toLineIndex || req.query.toLine) ? parseInt(req.query.toLineIndex || req.query.toLine, 10) : undefined,
          // Turn index filters
          fromTurnIndex: req.query.fromTurnIndex ? parseInt(req.query.fromTurnIndex, 10) : undefined,
          toTurnIndex: req.query.toTurnIndex ? parseInt(req.query.toTurnIndex, 10) : undefined,
          // User prompt index filters
          fromUserPromptIndex: req.query.fromUserPromptIndex ? parseInt(req.query.fromUserPromptIndex, 10) : undefined,
          toUserPromptIndex: req.query.toUserPromptIndex ? parseInt(req.query.toUserPromptIndex, 10) : undefined,
          // Deprecated
          lastNUserPrompts: req.query.lastNUserPrompts ? parseInt(req.query.lastNUserPrompts, 10) : undefined,
          // Skip default limit
          unlimited: req.query.unlimited === 'true',
          // Include read-only file operations in fileChanges (excluded by default)
          includeReads: req.query.includeReads === 'true',
          // Conditional fetch — return notModified if session unchanged since this timestamp
          ifModifiedSince: req.query.ifModifiedSince,
        }
      ),
    },

    // GET /sessions/:sessionId/exists - Check if session exists
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/exists$/,
      handler: async (req, api) => api.sessions.sessionExists(
        req.params.sessionId,
        req.query.cwd
      ),
    },

    // ========================================================================
    // Conversation API (Session Messages)
    // ========================================================================

    // GET /sessions/:sessionId/conversation - Get full conversation
    // Query params: cwd, toolDetail, lastN, beforeLine, includeSystemPrompt
    // Default lastN=50 to avoid loading entire large sessions
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/conversation$/,
      handler: async (req, api) => api.sessions.getConversation({
        sessionId: req.params.sessionId,
        cwd: req.query.cwd,
        toolDetail: req.query.toolDetail as 'none' | 'summary' | 'full' | undefined,
        lastN: req.query.lastN ? parseInt(req.query.lastN) : (req.query.fromTurnIndex || req.query.toTurnIndex ? undefined : 50),
        beforeLine: req.query.beforeLine ? parseInt(req.query.beforeLine) : undefined,
        includeSystemPrompt: req.query.includeSystemPrompt === 'true',
        fromTurnIndex: req.query.fromTurnIndex ? parseInt(req.query.fromTurnIndex) : undefined,
        toTurnIndex: req.query.toTurnIndex ? parseInt(req.query.toTurnIndex) : undefined,
      }),
    },

    // GET /sessions/:sessionId/messages/last/:count - Get last N messages
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/messages\/last\/(?<count>\d+)$/,
      handler: async (req, api) => api.sessions.getLastMessages(
        req.params.sessionId,
        parseInt(req.params.count),
        {
          cwd: req.query.cwd,
          toolDetail: req.query.toolDetail as 'none' | 'summary' | 'full' | undefined,
        }
      ),
    },

    // GET /sessions/:sessionId/compact-messages - Get compact/continuation messages
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/compact-messages$/,
      handler: async (req, api) => api.sessions.getCompactMessages(
        req.params.sessionId,
        req.query.cwd
      ),
    },

    // GET /sessions/:sessionId/from/:lineIndex - Get messages from a specific line position
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/from\/(?<lineIndex>\d+)$/,
      handler: async (req, api) => api.sessions.getMessagesFromPosition(
        req.params.sessionId,
        parseInt(req.params.lineIndex, 10),
        {
          cwd: req.query.cwd,
          includeRawMessages: req.query.includeRawMessages === 'true',
          limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
        }
      ),
    },

    // GET /sessions/:sessionId/has-update - Check if session has updates
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/has-update$/,
      handler: async (req, api) => api.sessions.checkSessionUpdate(
        req.params.sessionId,
        req.query.cwd
      ),
    },

    // ========================================================================
    // Subagent API (Task/Subagent Files)
    // ========================================================================

    // GET /sessions/:sessionId/subagents - List subagents for a session
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/subagents$/,
      handler: async (req, api) => api.sessions.getSessionSubagents(
        req.params.sessionId,
        req.query.cwd
      ),
    },

    // GET /sessions/:sessionId/subagents/:agentId - Get specific subagent details
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/subagents\/(?<agentId>[^/]+)$/,
      handler: async (req, api) => api.sessions.getSubagentSession(
        req.params.sessionId,
        req.params.agentId,
        req.query.cwd
      ),
    },

    // GET /sessions/:sessionId/forks - Find all sessions forked from a given session
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/forks$/,
      handler: async (req, api) => {
        const cache = getSessionCache();
        const projectPath = req.query.cwd || ctx.projectPath;
        if (!projectPath) {
          return { success: false, error: 'No project path provided' };
        }
        const sessions = cache.getProjectSessionsFromCache(projectPath);
        const forks = sessions
          .filter(s => s.cacheData.forkedFromSessionId === req.params.sessionId)
          .map(s => ({
            sessionId: s.sessionId,
            forkedFromSessionId: s.cacheData.forkedFromSessionId,
            forkPointUuid: s.cacheData.forkPointUuid,
            lastModified: new Date(s.cacheData.fileMtime).toISOString(),
            userPromptCount: s.cacheData.userPrompts.filter(isRealUserPrompt).length,
          }));
        return { success: true, forks };
      },
    },

    // GET /sessions/subagents/files - List all subagent files in project
    {
      method: 'GET',
      pattern: /^\/sessions\/subagents\/files$/,
      handler: async (req, api) => api.sessions.listSubagentFiles(
        req.query.sessionId,
        req.query.cwd
      ),
    },

    // ========================================================================
    // Session Cache API
    // ========================================================================

    // GET /session-cache/stats - Get cache statistics
    {
      method: 'GET',
      pattern: /^\/session-cache\/stats$/,
      handler: async (req, api) => api.sessions.getCacheStats(),
    },

    // POST /session-cache/warm - Warm cache for a project
    {
      method: 'POST',
      pattern: /^\/session-cache\/warm$/,
      handler: async (req, api) => {
        const body = req.body as { projectPath?: string };
        if (!body.projectPath) {
          return { success: false, error: 'projectPath is required' };
        }
        return api.sessions.warmProjectCache(body.projectPath);
      },
    },

    // POST /session-cache/clear - Clear cache
    {
      method: 'POST',
      pattern: /^\/session-cache\/clear$/,
      handler: async (req, api) => {
        const body = req.body as { sessionPath?: string };
        return api.sessions.clearCache(body.sessionPath);
      },
    },

    // POST /session-cache/watcher/start - Start cache watcher
    {
      method: 'POST',
      pattern: /^\/session-cache\/watcher\/start$/,
      handler: async (req, api) => {
        const body = req.body as { projectPaths?: string[] };
        return api.sessions.startCacheWatcher(body.projectPaths);
      },
    },

    // POST /session-cache/watcher/stop - Stop cache watcher
    {
      method: 'POST',
      pattern: /^\/session-cache\/watcher\/stop$/,
      handler: async (req, api) => api.sessions.stopCacheWatcher(),
    },

    // POST /session-cache/warming/start - Deprecated (LMDB provides instant reads)
    {
      method: 'POST',
      pattern: /^\/session-cache\/warming\/start$/,
      handler: async () => ({
        success: true,
        data: {
          message: 'Background warming is no longer needed. LMDB mmap provides instant reads with no warmup.',
          deprecated: true,
        },
      }),
    },

    // POST /session-cache/warming/stop - Deprecated (LMDB provides instant reads)
    {
      method: 'POST',
      pattern: /^\/session-cache\/warming\/stop$/,
      handler: async () => ({
        success: true,
        data: {
          message: 'Background warming is no longer needed. LMDB mmap provides instant reads with no warmup.',
          deprecated: true,
        },
      }),
    },
  ];
}
