/**
 * Tasks Routes
 *
 * Endpoints: /tasks
 * Manages task files in ~/.claude/tasks/
 */

import type { RouteHandler, RouteContext } from '../index';
import { getTasksService } from '../../tasks-service';
import * as path from 'path';
import { homedir } from 'os';

export function createTasksRoutes(ctx: RouteContext): RouteHandler[] {
  const service = getTasksService();

  // Wire up session store for fallback task extraction from session JSONL
  try {
    service.setSessionStore(ctx.getSessionStore());
  } catch {
    // Session store may not be available in all contexts
  }

  return [
    // ========================================================================
    // Task Lists
    // ========================================================================

    // GET /tasks - List all task lists
    {
      method: 'GET',
      pattern: /^\/tasks$/,
      handler: async () => {
        const taskLists = await service.listTaskLists();
        return {
          success: true,
          data: {
            taskLists,
            total: taskLists.length,
            tasksDir: service.getTasksDir(),
          },
        };
      },
    },

    // GET /tasks/all - Get all tasks from all lists in a flat array (batch)
    {
      method: 'GET',
      pattern: /^\/tasks\/all$/,
      handler: async () => {
        const tasks = await service.getAllTasksFlat();
        return {
          success: true,
          data: {
            tasks,
            total: tasks.length,
          },
        };
      },
    },

    // POST /tasks/:listId - Create a new task list
    {
      method: 'POST',
      pattern: /^\/tasks\/(?<listId>[^/]+)$/,
      handler: async (req) => {
        const { listId } = req.params;

        // Check if body contains task data (create task) vs empty (create list)
        if (req.body && (req.body.subject || req.body.description)) {
          // Create a task in the list
          const task = await service.createTask(listId, req.body);
          return {
            success: true,
            data: { task },
          };
        }

        // Create empty task list
        const created = await service.createTaskList(listId);
        return {
          success: true,
          data: {
            listId,
            created,
            path: path.join(service.getTasksDir(), listId),
          },
        };
      },
    },

    // GET /tasks/:listId - Get all tasks in a list
    {
      method: 'GET',
      pattern: /^\/tasks\/(?<listId>[^/]+)$/,
      handler: async (req) => {
        const { listId } = req.params;
        const taskList = await service.getTaskList(listId);

        if (!taskList) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Task list '${listId}' not found`,
            },
          };
        }

        return {
          success: true,
          data: { taskList },
        };
      },
    },

    // DELETE /tasks/:listId - Delete a task list
    {
      method: 'DELETE',
      pattern: /^\/tasks\/(?<listId>[^/]+)$/,
      handler: async (req) => {
        const { listId } = req.params;
        const deleted = await service.deleteTaskList(listId);

        if (!deleted) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Task list '${listId}' not found`,
            },
          };
        }

        return {
          success: true,
          data: { listId, deleted },
        };
      },
    },

    // ========================================================================
    // Ready Tasks & Dependency Graph
    // ========================================================================

    // GET /tasks/:listId/ready - Get ready tasks (not blocked)
    {
      method: 'GET',
      pattern: /^\/tasks\/(?<listId>[^/]+)\/ready$/,
      handler: async (req) => {
        const { listId } = req.params;
        const readyTasks = await service.getReadyTasks(listId);

        return {
          success: true,
          data: {
            listId,
            readyTasks,
            total: readyTasks.length,
          },
        };
      },
    },

    // GET /tasks/:listId/graph - Get dependency graph
    {
      method: 'GET',
      pattern: /^\/tasks\/(?<listId>[^/]+)\/graph$/,
      handler: async (req) => {
        const { listId } = req.params;
        const graph = await service.getDependencyGraph(listId);

        return {
          success: true,
          data: {
            listId,
            ...graph,
          },
        };
      },
    },

    // ========================================================================
    // Individual Tasks
    // ========================================================================

    // GET /tasks/:listId/:taskId - Get a single task
    {
      method: 'GET',
      pattern: /^\/tasks\/(?<listId>[^/]+)\/(?<taskId>[^/]+)$/,
      handler: async (req) => {
        const { listId, taskId } = req.params;

        // Skip special endpoints
        if (taskId === 'ready' || taskId === 'graph') {
          return { success: false, error: { code: 'INVALID', message: 'Invalid task ID' } };
        }

        const task = await service.getTask(listId, taskId);

        if (!task) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Task '${taskId}' not found in list '${listId}'`,
            },
          };
        }

        return {
          success: true,
          data: { task },
        };
      },
    },

    // PUT /tasks/:listId/:taskId - Update a task
    {
      method: 'PUT',
      pattern: /^\/tasks\/(?<listId>[^/]+)\/(?<taskId>[^/]+)$/,
      handler: async (req) => {
        const { listId, taskId } = req.params;
        const task = await service.updateTask(listId, taskId, req.body);

        if (!task) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Task '${taskId}' not found in list '${listId}'`,
            },
          };
        }

        return {
          success: true,
          data: { task },
        };
      },
    },

    // DELETE /tasks/:listId/:taskId - Delete a task
    {
      method: 'DELETE',
      pattern: /^\/tasks\/(?<listId>[^/]+)\/(?<taskId>[^/]+)$/,
      handler: async (req) => {
        const { listId, taskId } = req.params;
        const deleted = await service.deleteTask(listId, taskId);

        if (!deleted) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Task '${taskId}' not found in list '${listId}'`,
            },
          };
        }

        return {
          success: true,
          data: { listId, taskId, deleted },
        };
      },
    },
  ];
}
