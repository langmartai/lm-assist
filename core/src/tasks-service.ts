/**
 * Claude Code Tasks Service
 *
 * Reads and writes Claude Code task files from ~/.claude/tasks/
 * Each task list is a directory containing individual task JSON files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  projectKey: string;
  filePath: string;
  exists: boolean;
}

export interface TaskList {
  listId: string;
  tasks: Task[];
  taskCount: number;
  path: string;
  /** Session info if listId is a session ID */
  sessionInfo?: SessionInfo;
}

export interface TaskListSummary {
  listId: string;
  taskCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  lastModified: Date;
  /** Session info if listId is a session ID */
  sessionInfo?: SessionInfo;
  /** Last user message from the session (truncated to 100 words) */
  lastUserMessage?: string;
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  blocks?: string[];
  blockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  blocks?: string[];
  blockedBy?: string[];
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Service Implementation
// ============================================================================

export class TasksService {
  private tasksDir: string;
  private sessionStore: import('./agent-session-store').AgentSessionStore | null = null;

  constructor(tasksDir?: string) {
    this.tasksDir = tasksDir || path.join(homedir(), '.claude', 'tasks');
  }

  /**
   * Set the session store for fallback task extraction from session JSONL.
   * When a task directory has no JSON files, tasks are extracted from the session log.
   */
  setSessionStore(store: import('./agent-session-store').AgentSessionStore): void {
    this.sessionStore = store;
  }

  /**
   * Get the base tasks directory
   */
  getTasksDir(): string {
    return this.tasksDir;
  }

  /**
   * Check if a string looks like a UUID (session ID format)
   * Claude session IDs are UUIDs: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   */
  isSessionIdFormat(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }

  /**
   * Find a session by ID across all projects
   * Searches ~/.claude/projects/PROJECT_KEY/SESSION_ID.jsonl
   */
  findSessionById(sessionId: string): SessionInfo | null {
    if (!this.isSessionIdFormat(sessionId)) {
      return null;
    }

    const projectsDir = path.join(homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) {
      return null;
    }

    try {
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of dirs) {
        const sessionFile = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) {
          // Decode project path from directory name
          // e.g., -home-ubuntu-project -> /home/ubuntu/project
          const projectPath = '/' + dir.name.replace(/^-/, '').replace(/-/g, '/');

          return {
            sessionId,
            projectPath,
            projectKey: dir.name,
            filePath: sessionFile,
            exists: true,
          };
        }
      }
    } catch {
      // Ignore errors
    }

    return null;
  }

  /**
   * Get session info for a task list ID if it's a session ID
   */
  getSessionInfo(listId: string): SessionInfo | null {
    return this.findSessionById(listId);
  }

  /**
   * List all task lists (directories)
   */
  async listTaskLists(): Promise<TaskListSummary[]> {
    if (!fs.existsSync(this.tasksDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    const summaries: TaskListSummary[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const listPath = path.join(this.tasksDir, entry.name);
        const tasks = await this.readTasksForList(entry.name, listPath);
        const stat = fs.statSync(listPath);

        // Check if this list ID is a session ID
        const sessionInfo = this.getSessionInfo(entry.name);

        // Get last user message from session if available
        let lastUserMessage: string | undefined;
        if (sessionInfo && this.sessionStore) {
          try {
            lastUserMessage = await this.getLastUserMessageForSession(entry.name, sessionInfo.projectPath);
          } catch {
            // Ignore errors, just don't include the message
          }
        }

        summaries.push({
          listId: entry.name,
          taskCount: tasks.length,
          pendingCount: tasks.filter(t => t.status === 'pending').length,
          inProgressCount: tasks.filter(t => t.status === 'in_progress').length,
          completedCount: tasks.filter(t => t.status === 'completed').length,
          lastModified: stat.mtime,
          sessionInfo: sessionInfo || undefined,
          lastUserMessage,
        });
      }
    }

    // Sort by last modified, newest first
    return summaries.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  /**
   * Get the last user message from a session, truncated to 100 words
   */
  private async getLastUserMessageForSession(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (!this.sessionStore) return undefined;

    try {
      const result = await this.sessionStore.getLastMessages(sessionId, 20, {
        cwd: projectPath,
        toolDetail: 'none',
      });

      if (!result?.messages) return undefined;

      // Find the last user message
      for (let i = result.messages.length - 1; i >= 0; i--) {
        const msg = result.messages[i];
        if (msg.role === 'user' && msg.content) {
          // Truncate to 100 words
          const words = msg.content.split(/\s+/);
          if (words.length > 100) {
            return words.slice(0, 100).join(' ') + '...';
          }
          return msg.content;
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Encode a project path to a project key
   * e.g., /home/ubuntu/tier-agent -> -home-ubuntu-tier-agent
   */
  encodeProjectPath(projectPath: string): string {
    // Normalize path: remove trailing slashes
    const normalized = projectPath.replace(/\/+$/, '');
    // Replace leading / with - and all / with -
    return '-' + normalized.replace(/^\//, '').replace(/\//g, '-');
  }

  /**
   * Get all task lists that belong to a specific project
   * Filters session-based task lists by their sessionInfo.projectKey
   */
  async getTaskListsForProject(projectPath: string): Promise<TaskListSummary[]> {
    const allLists = await this.listTaskLists();

    // Encode project path to project key for comparison
    const targetProjectKey = this.encodeProjectPath(projectPath);

    return allLists.filter(list => {
      if (!list.sessionInfo) return false;
      return list.sessionInfo.projectKey === targetProjectKey;
    });
  }

  /**
   * Get all tasks from all sessions belonging to a project
   * Returns tasks with prefixed IDs: {sessionId.slice(0,8)}:{taskId}
   */
  async getAggregatedTasksForProject(projectPath: string): Promise<{
    tasks: Array<Task & { sessionId: string; originalId: string }>;
    sessionCount: number;
    taskLists: TaskListSummary[];
  }> {
    const projectLists = await this.getTaskListsForProject(projectPath);
    const allTasks: Array<Task & { sessionId: string; originalId: string }> = [];

    for (const listSummary of projectLists) {
      const taskList = await this.getTaskList(listSummary.listId);
      if (taskList && taskList.tasks.length > 0) {
        const sessionPrefix = listSummary.listId.slice(0, 8);
        for (const task of taskList.tasks) {
          allTasks.push({
            ...task,
            id: `${sessionPrefix}:${task.id}`,
            originalId: task.id,
            sessionId: listSummary.listId,
            // Update blockedBy to use prefixed IDs
            blockedBy: task.blockedBy.map(id => `${sessionPrefix}:${id}`),
            blocks: task.blocks.map(id => `${sessionPrefix}:${id}`),
          });
        }
      }
    }

    return {
      tasks: allTasks,
      sessionCount: projectLists.length,
      taskLists: projectLists,
    };
  }

  /**
   * Get all tasks across all task lists in a flat array.
   * Each task is enriched with sessionId, projectPath, and projectName.
   */
  async getAllTasksFlat(): Promise<Array<Task & { sessionId: string; projectPath?: string; projectName?: string }>> {
    if (!fs.existsSync(this.tasksDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    const allTasks: Array<Task & { sessionId: string; projectPath?: string; projectName?: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const listId = entry.name;
      const listPath = path.join(this.tasksDir, listId);
      const rawTasks = await this.readTasksForList(listId, listPath);
      // Filter out deleted tasks (status='deleted' from TaskUpdate)
      const tasks = rawTasks.filter(t => (t.status as string) !== 'deleted');

      if (tasks.length === 0) continue;

      // Get session/project info
      const sessionInfo = this.getSessionInfo(listId);
      const projectPath = sessionInfo?.projectPath;
      const projectName = projectPath ? path.basename(projectPath) : undefined;

      for (const task of tasks) {
        allTasks.push({
          ...task,
          sessionId: listId,
          projectPath,
          projectName,
        });
      }
    }

    return allTasks;
  }

  /**
   * Parse a prefixed task ID into sessionId and originalId
   */
  parseTaskId(prefixedId: string): { sessionPrefix: string; originalId: string } | null {
    const match = prefixedId.match(/^([a-f0-9]{8}):(.+)$/);
    if (!match) return null;
    return { sessionPrefix: match[1], originalId: match[2] };
  }

  /**
   * Find the full session ID from a prefix
   */
  async findSessionByPrefix(prefix: string, projectPath: string): Promise<string | null> {
    const projectLists = await this.getTaskListsForProject(projectPath);
    const match = projectLists.find(list => list.listId.startsWith(prefix));
    return match?.listId || null;
  }

  /**
   * Get all tasks in a task list
   */
  async getTaskList(listId: string): Promise<TaskList | null> {
    const listPath = path.join(this.tasksDir, listId);

    if (!fs.existsSync(listPath)) {
      return null;
    }

    const tasks = await this.readTasksForList(listId, listPath);

    // Check if this list ID is a session ID
    const sessionInfo = this.getSessionInfo(listId);

    return {
      listId,
      tasks,
      taskCount: tasks.length,
      path: listPath,
      sessionInfo: sessionInfo || undefined,
    };
  }

  /**
   * Get a single task
   */
  async getTask(listId: string, taskId: string): Promise<Task | null> {
    // Try reading from JSON file first
    const taskPath = path.join(this.tasksDir, listId, `${taskId}.json`);
    if (fs.existsSync(taskPath)) {
      try {
        const content = fs.readFileSync(taskPath, 'utf-8');
        return JSON.parse(content) as Task;
      } catch {
        // Fall through to list-based lookup
      }
    }

    // Fallback: find task in the full list (handles session JSONL extraction)
    const taskList = await this.getTaskList(listId);
    return taskList?.tasks.find(t => t.id === taskId) || null;
  }

  /**
   * Create a new task list (directory)
   */
  async createTaskList(listId: string): Promise<boolean> {
    const listPath = path.join(this.tasksDir, listId);

    if (fs.existsSync(listPath)) {
      return false; // Already exists
    }

    fs.mkdirSync(listPath, { recursive: true });
    return true;
  }

  /**
   * Create a new task in a list
   */
  async createTask(listId: string, input: CreateTaskInput): Promise<Task> {
    const listPath = path.join(this.tasksDir, listId);

    // Create list directory if it doesn't exist
    if (!fs.existsSync(listPath)) {
      fs.mkdirSync(listPath, { recursive: true });
    }

    // Find next available ID
    const existingTasks = await this.readTasksFromDir(listPath);
    const maxId = existingTasks.reduce((max, t) => {
      const id = parseInt(t.id, 10);
      return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    const newId = String(maxId + 1);

    const task: Task = {
      id: newId,
      subject: input.subject,
      description: input.description || '',
      activeForm: input.activeForm,
      status: input.status || 'pending',
      blocks: input.blocks || [],
      blockedBy: input.blockedBy || [],
      owner: input.owner,
      metadata: input.metadata,
    };

    // Write task file
    const taskPath = path.join(listPath, `${newId}.json`);
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));

    return task;
  }

  /**
   * Update an existing task
   */
  async updateTask(listId: string, taskId: string, input: UpdateTaskInput): Promise<Task | null> {
    const task = await this.getTask(listId, taskId);

    if (!task) {
      return null;
    }

    // Apply updates
    if (input.subject !== undefined) task.subject = input.subject;
    if (input.description !== undefined) task.description = input.description;
    if (input.activeForm !== undefined) task.activeForm = input.activeForm;
    if (input.status !== undefined) task.status = input.status;
    if (input.blocks !== undefined) task.blocks = input.blocks;
    if (input.blockedBy !== undefined) task.blockedBy = input.blockedBy;
    if (input.owner !== undefined) task.owner = input.owner;
    if (input.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...input.metadata };
    }

    // Handle addBlocks and addBlockedBy
    if (input.addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...input.addBlocks])];
    }
    if (input.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...input.addBlockedBy])];
    }

    // Write updated task
    const taskPath = path.join(this.tasksDir, listId, `${taskId}.json`);
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));

    return task;
  }

  /**
   * Delete a task
   */
  async deleteTask(listId: string, taskId: string): Promise<boolean> {
    const taskPath = path.join(this.tasksDir, listId, `${taskId}.json`);

    if (!fs.existsSync(taskPath)) {
      return false;
    }

    fs.unlinkSync(taskPath);

    // Also remove this task from other tasks' blocks/blockedBy arrays
    const tasks = await this.readTasksFromDir(path.join(this.tasksDir, listId));
    for (const task of tasks) {
      let updated = false;
      if (task.blocks.includes(taskId)) {
        task.blocks = task.blocks.filter(id => id !== taskId);
        updated = true;
      }
      if (task.blockedBy.includes(taskId)) {
        task.blockedBy = task.blockedBy.filter(id => id !== taskId);
        updated = true;
      }
      if (updated) {
        const otherTaskPath = path.join(this.tasksDir, listId, `${task.id}.json`);
        fs.writeFileSync(otherTaskPath, JSON.stringify(task, null, 2));
      }
    }

    return true;
  }

  /**
   * Delete an entire task list
   */
  async deleteTaskList(listId: string): Promise<boolean> {
    const listPath = path.join(this.tasksDir, listId);

    if (!fs.existsSync(listPath)) {
      return false;
    }

    // Delete all files in the directory
    const files = fs.readdirSync(listPath);
    for (const file of files) {
      fs.unlinkSync(path.join(listPath, file));
    }

    // Remove the directory
    fs.rmdirSync(listPath);

    return true;
  }

  /**
   * Get ready tasks (not blocked by any incomplete tasks)
   */
  async getReadyTasks(listId: string): Promise<Task[]> {
    const taskList = await this.getTaskList(listId);
    if (!taskList) return [];

    const completedIds = new Set(
      taskList.tasks
        .filter(t => t.status === 'completed')
        .map(t => t.id)
    );

    return taskList.tasks.filter(task => {
      if (task.status === 'completed') return false;
      // Task is ready if all blockedBy tasks are completed
      return task.blockedBy.every(id => completedIds.has(id));
    });
  }

  /**
   * Get dependency graph for a task list
   */
  async getDependencyGraph(listId: string): Promise<{
    nodes: Array<{ id: string; subject: string; status: string }>;
    edges: Array<{ from: string; to: string }>;
  }> {
    const taskList = await this.getTaskList(listId);
    if (!taskList) {
      return { nodes: [], edges: [] };
    }

    const nodes = taskList.tasks.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
    }));

    const edges: Array<{ from: string; to: string }> = [];
    const edgeSet = new Set<string>();
    for (const task of taskList.tasks) {
      for (const blockedId of task.blocks) {
        const key = `${task.id}->${blockedId}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: task.id, to: blockedId });
        }
      }
      for (const blockerId of task.blockedBy) {
        const key = `${blockerId}->${task.id}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: blockerId, to: task.id });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Read tasks for a list, falling back to session JSONL extraction when no JSON files exist.
   */
  private async readTasksForList(listId: string, dirPath: string): Promise<Task[]> {
    const jsonTasks = await this.readTasksFromDir(dirPath);
    if (jsonTasks.length > 0) {
      return jsonTasks;
    }

    // Fallback: extract tasks from session JSONL if this is a session ID
    if (!this.sessionStore || !this.isSessionIdFormat(listId)) {
      return [];
    }

    const sessionInfo = this.findSessionById(listId);
    if (!sessionInfo) {
      return [];
    }

    try {
      const sessionData = await this.sessionStore.readSession(listId, {
        cwd: sessionInfo.projectPath,
      });
      if (!sessionData?.tasks?.length) {
        return [];
      }

      return sessionData.tasks.map(t => ({
        id: t.id,
        subject: t.subject,
        description: t.description || '',
        activeForm: t.activeForm,
        status: t.status,
        blocks: t.blocks || [],
        blockedBy: t.blockedBy || [],
        owner: t.owner,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Read all tasks from a directory
   */
  private async readTasksFromDir(dirPath: string): Promise<Task[]> {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const tasks: Task[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
        const task = JSON.parse(content) as Task;
        tasks.push(task);
      } catch {
        // Skip invalid files
      }
    }

    // Sort by ID (numeric)
    return tasks.sort((a, b) => {
      const aNum = parseInt(a.id, 10);
      const bNum = parseInt(b.id, 10);
      if (isNaN(aNum) || isNaN(bNum)) {
        return a.id.localeCompare(b.id);
      }
      return aNum - bNum;
    });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let _instance: TasksService | null = null;

export function createTasksService(tasksDir?: string): TasksService {
  if (!_instance) {
    _instance = new TasksService(tasksDir);
  }
  return _instance;
}

export function getTasksService(): TasksService {
  if (!_instance) {
    _instance = new TasksService();
  }
  return _instance;
}
