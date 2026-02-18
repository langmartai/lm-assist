/**
 * Session Projects Routes
 *
 * REST API for session projects from ~/.claude/projects/
 * Endpoints: /projects
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  ProjectsService,
  createProjectsService,
} from '../../projects-service';
import { getSessionCache, isRealUserPrompt } from '../../session-cache';

// Lazy-loaded service instance
let projectsService: ProjectsService | null = null;

function getService(): ProjectsService {
  if (!projectsService) {
    projectsService = createProjectsService();
  }
  return projectsService;
}

export function createSessionProjectsRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // ========================================================================
    // Project Listing
    // ========================================================================

    // GET /projects - List all Claude Code projects
    {
      method: 'GET',
      pattern: /^\/projects$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const encoded = req.query.encoded === 'true';
        const includeSize = req.query.includeSize !== 'false';

        const projects = service.listProjects({ encoded, includeSize });

        // Enrich with lastUserMessage from most recent session (batch via Promise.all)
        const cache = getSessionCache();
        await Promise.all(projects.map(async (project: any) => {
          const sessionPath = project._mostRecentSessionPath;
          delete project._mostRecentSessionPath;

          if (sessionPath) {
            const sessionData = cache.getSessionDataFromMemory(sessionPath)
              || await cache.getSessionData(sessionPath);
            if (sessionData && sessionData.userPrompts.length > 0) {
              const realPrompts = sessionData.userPrompts.filter(isRealUserPrompt);
              const lastPrompt = realPrompts[realPrompts.length - 1];
              if (lastPrompt.text) {
                project.lastUserMessage = lastPrompt.text.length > 200
                  ? lastPrompt.text.substring(0, 200) + '...'
                  : lastPrompt.text;
              }
            }
          }
        }));

        return {
          success: true,
          data: {
            projects,
            total: projects.length,
          },
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // GET /projects/size - Get total storage size across all projects
    {
      method: 'GET',
      pattern: /^\/projects\/size$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const sizeInfo = service.getAllProjectsSize();

        return {
          success: true,
          data: sizeInfo,
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // GET /projects/costs - Get costs for all projects
    {
      method: 'GET',
      pattern: /^\/projects\/costs$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        try {
          const projects = service.listProjects({ includeSize: false });
          const projectCosts: Array<{
            projectPath: string;
            projectName: string;
            totalCostUsd: number;
            sessionCount: number;
          }> = [];

          let grandTotalCostUsd = 0;
          let totalSessionCount = 0;

          for (const project of projects) {
            // Use encodedPath for lookup since it's guaranteed to match the storage directory
            const costs = await service.getProjectCosts(project.encodedPath);
            projectCosts.push({
              projectPath: project.path,
              projectName: project.path.split('/').pop() || project.path,
              totalCostUsd: costs.totalCostUsd,
              sessionCount: costs.sessionCount,
            });
            grandTotalCostUsd += costs.totalCostUsd;
            totalSessionCount += costs.sessionCount;
          }

          // Sort by cost descending
          projectCosts.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

          return {
            success: true,
            data: {
              totalCostUsd: grandTotalCostUsd,
              projectCount: projects.length,
              sessionCount: totalSessionCount,
              projects: projectCosts,
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_CALC_ERROR',
              message: error instanceof Error ? error.message : 'Failed to calculate costs',
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }
      },
    },

    // GET /projects/sessions - Get all sessions across all projects
    // Query params: active, activeThresholdMs, ifModifiedSince (ISO timestamp — returns notModified if unchanged)
    {
      method: 'GET',
      pattern: /^\/projects\/sessions$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        // Fast not-modified check: only stat calls, no file reads
        const ifModifiedSince = req.query.ifModifiedSince;
        if (ifModifiedSince) {
          const clientTime = new Date(ifModifiedSince).getTime();
          if (!isNaN(clientTime)) {
            const latest = service.getLatestMtime();
            if (latest && latest.getTime() <= clientTime) {
              return {
                success: true,
                data: { notModified: true, lastModified: latest.toISOString() },
                meta: { timestamp: new Date(), durationMs: Date.now() - start },
              };
            }
          }
        }

        const active = req.query.active === 'true' ? true :
                       req.query.active === 'false' ? false : undefined;
        const activeThresholdMs = req.query.activeThresholdMs
          ? parseInt(req.query.activeThresholdMs, 10)
          : undefined;

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 0;

        const sessions = service.getAllSessions({ active, activeThresholdMs });

        // Include lastModified so clients can use it for subsequent ifModifiedSince
        const lastModified = sessions.length > 0
          ? sessions[0].lastModified  // already sorted newest-first
          : undefined;

        // When ifModifiedSince is provided, only return sessions that changed.
        // The client already has unchanged sessions cached.
        const clientTime = ifModifiedSince ? new Date(ifModifiedSince).getTime() : 0;
        let outputSessions = ifModifiedSince
          ? sessions.filter(s => s.lastModified.getTime() > clientTime)
          : sessions;

        // Apply server-side limit (after sort, before enrichment)
        if (limit > 0 && !ifModifiedSince && outputSessions.length > limit) {
          outputSessions = outputSessions.slice(0, limit);
        }

        // Enrich with running process status from cached store (O(1) lookups)
        const { getProcessStatusStore } = await import('../../process-status-store');
        const processStore = getProcessStatusStore();
        const runningSessions = processStore.getRunningSessionMap();

        const enrichedSessions = outputSessions.map(s => {
          const running = runningSessions.get(s.sessionId);
          return { ...s, running: running || undefined, isRunning: !!running };
        });

        return {
          success: true,
          data: {
            sessions: enrichedSessions,
            total: sessions.length,
            lastModified,
            runningCount: runningSessions.size,
            processStatus: processStore.getStats(),
          },
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // ========================================================================
    // Single Project Operations (must come after static routes)
    // ========================================================================

    // GET /projects/:projectPath - Get single project
    // projectPath can be encoded (legacy dash format or Base64) or URL-encoded absolute path
    {
      method: 'GET',
      pattern: /^\/projects\/(?<projectPath>[^/]+)$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        // Decode the URL-encoded project path parameter
        const projectPathParam = decodeURIComponent(req.params.projectPath);

        // Pass directly to getProject - it handles both encoded paths (like -home-ubuntu-tier-agent)
        // and decoded absolute paths (like /home/ubuntu/tier-agent)
        const project = service.getProject(projectPathParam);

        if (!project) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Project not found: ${projectPathParam}` },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }

        return {
          success: true,
          data: project,
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // GET /projects/:projectPath/sessions - Get sessions for a project
    // Query params: active, activeThresholdMs, ifModifiedSince (ISO timestamp — returns notModified if unchanged)
    {
      method: 'GET',
      pattern: /^\/projects\/(?<projectPath>[^/]+)\/sessions$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const projectPathParam = decodeURIComponent(req.params.projectPath);

        // Fast not-modified check: only stat calls, no file reads
        const ifModifiedSince = req.query.ifModifiedSince;
        if (ifModifiedSince) {
          const clientTime = new Date(ifModifiedSince).getTime();
          if (!isNaN(clientTime)) {
            const latest = service.getProjectLatestMtime(projectPathParam);
            if (latest && latest.getTime() <= clientTime) {
              return {
                success: true,
                data: { notModified: true, lastModified: latest.toISOString() },
                meta: { timestamp: new Date(), durationMs: Date.now() - start },
              };
            }
          }
        }

        const active = req.query.active === 'true' ? true :
                       req.query.active === 'false' ? false : undefined;
        const activeThresholdMs = req.query.activeThresholdMs
          ? parseInt(req.query.activeThresholdMs, 10)
          : undefined;

        // Pass directly - service handles both encoded and decoded paths
        const sessions = service.getProjectSessions(projectPathParam, {
          active,
          activeThresholdMs,
        });

        // Get the real project path from sessions if available
        const realProjectPath = sessions.length > 0 ? sessions[0].projectPath : projectPathParam;

        // Include lastModified so clients can use it for subsequent ifModifiedSince
        const lastModified = sessions.length > 0
          ? sessions[0].lastModified  // already sorted newest-first
          : undefined;

        // When ifModifiedSince is provided, only return sessions that changed.
        // The client already has unchanged sessions cached.
        const clientTime = ifModifiedSince ? new Date(ifModifiedSince).getTime() : 0;
        const outputSessions = ifModifiedSince
          ? sessions.filter(s => s.lastModified.getTime() > clientTime)
          : sessions;

        return {
          success: true,
          data: {
            projectPath: realProjectPath,
            sessions: outputSessions,
            total: sessions.length,
            lastModified,
          },
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // GET /projects/:projectPath/tasks - Get tasks for a project with session mapping
    {
      method: 'GET',
      pattern: /^\/projects\/(?<projectPath>[^/]+)\/tasks$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const projectPathParam = decodeURIComponent(req.params.projectPath);

        try {
          // Pass directly - service handles both encoded and decoded paths
          const result = await service.getProjectTasks(projectPathParam);

          // Get the real project path from sessions if available
          const realProjectPath = result.tasks.length > 0 && result.tasks[0].sessionInfo
            ? result.tasks[0].sessionInfo.projectPath
            : projectPathParam;

          return {
            success: true,
            data: {
              projectPath: realProjectPath,
              tasks: result.tasks,
              totalTasks: result.tasks.length,
              sessionCount: result.sessionCount,
              unmappedTasks: result.unmappedTasks,
              unmappedCount: result.unmappedTasks.length,
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_ERROR',
              message: error instanceof Error ? error.message : 'Failed to get tasks',
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }
      },
    },

    // GET /projects/:projectPath/size - Get storage size for a project
    {
      method: 'GET',
      pattern: /^\/projects\/(?<projectPath>[^/]+)\/size$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const projectPathParam = decodeURIComponent(req.params.projectPath);

        // Pass directly - service handles both encoded and decoded paths
        const sizeInfo = service.getProjectSize(projectPathParam);

        return {
          success: true,
          data: sizeInfo,
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // GET /projects/:projectPath/costs - Get costs for all sessions in a project
    // Calculates total cost including subagents
    {
      method: 'GET',
      pattern: /^\/projects\/(?<projectPath>[^/]+)\/costs$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const projectPathParam = decodeURIComponent(req.params.projectPath);

        try {
          const costInfo = await service.getProjectCosts(projectPathParam);

          return {
            success: true,
            data: costInfo,
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_CALC_ERROR',
              message: error instanceof Error ? error.message : 'Failed to calculate costs',
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }
      },
    },

    // ========================================================================
    // Utility Endpoints
    // ========================================================================

    // POST /projects/decode - Decode an encoded project path
    {
      method: 'POST',
      pattern: /^\/projects\/decode$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const { encoded } = req.body;

        if (!encoded) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: 'encoded path required' },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }

        const decoded = service.decodeProjectPath(encoded);

        return {
          success: true,
          data: { encoded, decoded },
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // POST /projects/encode - Encode a project path
    {
      method: 'POST',
      pattern: /^\/projects\/encode$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const { path: projectPath } = req.body;

        if (!projectPath) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: 'path required' },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }

        const encoded = service.encodeProjectPath(projectPath);

        return {
          success: true,
          data: { path: projectPath, encoded },
          meta: { timestamp: new Date(), durationMs: Date.now() - start },
        };
      },
    },

    // POST /projects/search-task-references - Search for task references in sessions
    {
      method: 'POST',
      pattern: /^\/projects\/search-task-references$/,
      handler: async (req, api) => {
        const start = Date.now();
        const service = getService();

        const { listId, projectPath } = req.body;

        if (!listId) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: 'listId required' },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }

        try {
          const references = await service.searchSessionsForTaskList(
            listId,
            projectPath
          );

          return {
            success: true,
            data: {
              listId,
              projectPath: projectPath || 'all',
              references,
              total: references.length,
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_ERROR',
              message: error instanceof Error ? error.message : 'Search failed',
            },
            meta: { timestamp: new Date(), durationMs: Date.now() - start },
          };
        }
      },
    },
  ];
}
