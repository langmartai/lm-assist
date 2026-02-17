/**
 * Claude Tasks API Implementation
 *
 * Extracted from control-api.ts - manage Claude Code task files.
 */

import type {
  TasksApi,
  CreateTaskInput,
  UpdateTaskInput,
} from '../types/control-api';
import { getTasksService } from '../tasks-service';

export function createTasksApiImpl(): TasksApi {
  const service = getTasksService();

  return {
    listTaskLists: async () => {
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

    getTaskList: async (listId: string) => {
      const taskList = await service.getTaskList(listId);
      if (!taskList) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `Task list '${listId}' not found` },
        };
      }
      return { success: true, data: { taskList } };
    },

    getTask: async (listId: string, taskId: string) => {
      const task = await service.getTask(listId, taskId);
      if (!task) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `Task '${taskId}' not found in list '${listId}'` },
        };
      }
      return { success: true, data: { task } };
    },

    createTaskList: async (listId: string) => {
      const created = await service.createTaskList(listId);
      return {
        success: true,
        data: {
          listId,
          created,
          path: `${service.getTasksDir()}/${listId}`,
        },
      };
    },

    createTask: async (listId: string, input: CreateTaskInput) => {
      const task = await service.createTask(listId, input);
      return { success: true, data: { task } };
    },

    updateTask: async (listId: string, taskId: string, input: UpdateTaskInput) => {
      const task = await service.updateTask(listId, taskId, input);
      if (!task) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `Task '${taskId}' not found in list '${listId}'` },
        };
      }
      return { success: true, data: { task } };
    },

    deleteTask: async (listId: string, taskId: string) => {
      const deleted = await service.deleteTask(listId, taskId);
      if (!deleted) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `Task '${taskId}' not found in list '${listId}'` },
        };
      }
      return { success: true, data: { listId, taskId, deleted } };
    },

    deleteTaskList: async (listId: string) => {
      const deleted = await service.deleteTaskList(listId);
      if (!deleted) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `Task list '${listId}' not found` },
        };
      }
      return { success: true, data: { listId, deleted } };
    },

    getReadyTasks: async (listId: string) => {
      const readyTasks = await service.getReadyTasks(listId);
      return {
        success: true,
        data: { listId, readyTasks, total: readyTasks.length },
      };
    },

    getDependencyGraph: async (listId: string) => {
      const graph = await service.getDependencyGraph(listId);
      return { success: true, data: { listId, ...graph } };
    },
  };
}
