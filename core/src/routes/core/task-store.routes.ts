/**
 * Task Store Routes
 *
 * Endpoints: /task-store
 * Read-only aggregation of tasks from Claude Code sessions.
 *
 * Key principles:
 * - All endpoints are READ-ONLY (no POST/PUT/DELETE for task modification)
 * - Tasks are modified through execution prompts to LLM sessions
 * - This API is for orchestrator and monitoring use
 */

import type { RouteHandler, RouteContext } from '../index';
import { getTaskStore, TaskStore } from '../../task-store';

// Store instance cache
let storeInstance: TaskStore | null = null;

async function getStore(projectPath: string): Promise<TaskStore> {
  if (!storeInstance) {
    storeInstance = getTaskStore(projectPath);
    await storeInstance.initialize();
  }
  return storeInstance;
}

export function createTaskStoreRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // ========================================================================
    // Store Status & Statistics
    // ========================================================================

    // GET /task-store - Get store status and statistics
    {
      method: 'GET',
      pattern: /^\/task-store$/,
      handler: async () => {
        const store = await getStore(ctx.projectPath);
        const stats = store.getStats();

        return {
          success: true,
          data: {
            projectPath: ctx.projectPath,
            stats,
            note: 'Read-only store. Tasks are modified via execution prompts to LLM sessions.',
          },
        };
      },
    },

    // POST /task-store/refresh - Force refresh from disk
    {
      method: 'POST',
      pattern: /^\/task-store\/refresh$/,
      handler: async () => {
        const store = await getStore(ctx.projectPath);
        await store.refresh();
        const stats = store.getStats();

        return {
          success: true,
          data: {
            message: 'Store refreshed from disk',
            stats,
          },
        };
      },
    },

    // ========================================================================
    // Tasks (Read-Only)
    // ========================================================================

    // GET /task-store/tasks - Get all aggregated tasks
    {
      method: 'GET',
      pattern: /^\/task-store\/tasks$/,
      handler: async (req) => {
        const store = await getStore(ctx.projectPath);
        let tasks = store.getAllTasks();

        // Optional status filter
        const statusFilter = req.query?.status as string | undefined;
        if (statusFilter) {
          tasks = tasks.filter(t => t.status === statusFilter);
        }

        return {
          success: true,
          data: {
            tasks,
            total: tasks.length,
          },
        };
      },
    },

    // GET /task-store/tasks/ready - Get ready tasks (not blocked)
    {
      method: 'GET',
      pattern: /^\/task-store\/tasks\/ready$/,
      handler: async () => {
        const store = await getStore(ctx.projectPath);
        const readyTasks = store.getReadyTasks();

        return {
          success: true,
          data: {
            tasks: readyTasks,
            total: readyTasks.length,
          },
        };
      },
    },

    // GET /task-store/tasks/:taskId - Get single task by ID
    {
      method: 'GET',
      pattern: /^\/task-store\/tasks\/(?<taskId>[^/]+)$/,
      handler: async (req) => {
        const { taskId } = req.params;

        // Skip special endpoints
        if (taskId === 'ready') {
          return { success: false, error: { code: 'INVALID', message: 'Invalid task ID' } };
        }

        const store = await getStore(ctx.projectPath);
        const task = store.getTaskById(taskId);

        if (!task) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Task '${taskId}' not found`,
            },
          };
        }

        return {
          success: true,
          data: { task },
        };
      },
    },

    // ========================================================================
    // Sessions (Read-Only)
    // ========================================================================

    // GET /task-store/sessions - Get all session snapshots
    {
      method: 'GET',
      pattern: /^\/task-store\/sessions$/,
      handler: async () => {
        const store = await getStore(ctx.projectPath);
        const sessions = store.getSessionSnapshots();

        return {
          success: true,
          data: {
            sessions,
            total: sessions.length,
          },
        };
      },
    },

    // GET /task-store/sessions/:sessionId - Get single session snapshot
    {
      method: 'GET',
      pattern: /^\/task-store\/sessions\/(?<sessionId>[^/]+)$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const store = await getStore(ctx.projectPath);
        const session = store.getSessionSnapshot(sessionId);

        if (!session) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Session '${sessionId}' not found`,
            },
          };
        }

        return {
          success: true,
          data: { session },
        };
      },
    },

    // GET /task-store/sessions/:sessionId/tasks - Get tasks for a session
    {
      method: 'GET',
      pattern: /^\/task-store\/sessions\/(?<sessionId>[^/]+)\/tasks$/,
      handler: async (req) => {
        const { sessionId } = req.params;
        const store = await getStore(ctx.projectPath);
        const tasks = store.getTasksForSession(sessionId);

        return {
          success: true,
          data: {
            sessionId,
            tasks,
            total: tasks.length,
          },
        };
      },
    },

    // ========================================================================
    // Ad-hoc Work Detection (Read-Only)
    // ========================================================================

    // GET /task-store/adhoc - Get sessions with ad-hoc work (no tasks)
    {
      method: 'GET',
      pattern: /^\/task-store\/adhoc$/,
      handler: async () => {
        const store = await getStore(ctx.projectPath);
        const adhocWork = store.getAdhocWork();

        return {
          success: true,
          data: {
            adhocWork,
            total: adhocWork.length,
            note: 'Sessions with file changes but no tasks. Consider using hooks to enforce task creation.',
          },
        };
      },
    },

    // ========================================================================
    // Parent Task (Intent) Management
    // ========================================================================

    // GET /task-store/intents - Get all parent/intent tasks
    {
      method: 'GET',
      pattern: /^\/task-store\/intents$/,
      handler: async (req) => {
        const store = await getStore(ctx.projectPath);
        const sessionId = req.query?.sessionId as string | undefined;
        const parentTasks = store.getParentTasks(sessionId);

        return {
          success: true,
          data: {
            intents: parentTasks,
            total: parentTasks.length,
          },
        };
      },
    },

    // GET /task-store/intents/:taskId/children - Get child tasks for a parent
    {
      method: 'GET',
      pattern: /^\/task-store\/intents\/(?<taskId>[^/]+)\/children$/,
      handler: async (req) => {
        const { taskId } = req.params;
        const store = await getStore(ctx.projectPath);
        const children = store.getChildTasks(taskId);

        return {
          success: true,
          data: {
            parentTaskId: taskId,
            children,
            total: children.length,
          },
        };
      },
    },

    // POST /task-store/check-parent-completion - Check for completable parent tasks (read-only)
    // Returns parent tasks that have all children completed, for hook to instruct Claude to complete them
    {
      method: 'POST',
      pattern: /^\/task-store\/check-parent-completion$/,
      handler: async (req) => {
        const { sessionId } = req.body || {};
        const store = await getStore(ctx.projectPath);

        // Refresh to get latest state
        await store.refresh();

        const completable = store.getCompletableParentTasks(sessionId);

        return {
          success: true,
          data: {
            completableParents: completable.map(p => ({
              id: p.originalId, // Use original ID for TaskUpdate
              sessionId: p.sessionId,
              subject: p.subject,
              childCount: store.getChildTasks(p.id).length,
            })),
            total: completable.length,
            // This message can be used by hooks to instruct Claude
            instruction: completable.length > 0
              ? `IMPORTANT: The following parent task(s) have all children completed. Please mark them as completed using TaskUpdate:\n${completable.map(p => `- Task #${p.originalId}: "${p.subject}"`).join('\n')}`
              : null,
          },
        };
      },
    },
  ];
}
