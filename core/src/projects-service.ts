/**
 * Projects Service
 *
 * Comprehensive API for session projects from ~/.claude/projects/
 * Provides:
 * - List all projects (with/without encoded names)
 * - Get project sessions
 * - Get project tasks with session mapping
 * - Get project storage size
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';
import {
  getProjectsDir,
  encodePath,
  decodePath,
  getClaudeConfigDir,
  legacyEncodeProjectPath,
} from './utils/path-utils';
import {
  TasksService,
  Task,
  TaskListSummary,
} from './tasks-service';
import { getSessionCache, isRealUserPrompt } from './session-cache';

// ============================================================================
// Types
// ============================================================================

export interface GitRemote {
  /** Remote name (e.g., origin, upstream) */
  name: string;
  /** Remote URL */
  url: string;
  /** Remote type (fetch or push) */
  type: 'fetch' | 'push';
}

export interface GitInfo {
  /** Whether this directory is inside a git repository */
  initialized: boolean;
  /** Current branch name (null if detached HEAD) */
  branch: string | null;
  /** Whether this is a bare repository */
  isBare: boolean;
  /** Whether this is a git worktree (linked working tree) */
  isWorktree: boolean;
  /** Path to the main worktree (if this is a linked worktree) */
  mainWorktreePath: string | null;
  /** List of all linked worktrees (from main worktree perspective) */
  worktrees: Array<{
    path: string;
    branch: string | null;
    head: string;
    isCurrent: boolean;
  }>;
  /** Git remotes */
  remotes: GitRemote[];
  /** Short HEAD commit hash */
  headCommit: string | null;
}

export interface Project {
  /** Decoded project path (e.g., /home/ubuntu/my-project) */
  path: string;
  /** Encoded project path for storage */
  encodedPath: string;
  /** Number of sessions in this project */
  sessionCount: number;
  /** Last activity timestamp */
  lastActivity?: Date;
  /** Total storage size in bytes */
  storageSize: number;
  /** Whether CLAUDE.md exists in the project */
  hasClaudeMd: boolean;
  /** Whether the project directory contains a .git folder */
  isGitProject: boolean;
  /** Git repository details (null if not a git project or directory doesn't exist) */
  git: GitInfo | null;
}

export interface ProjectSession {
  /** Session UUID */
  sessionId: string;
  /** Project path this session belongs to */
  projectPath: string;
  /** Encoded project path */
  projectKey: string;
  /** Full path to session file */
  filePath: string;
  /** Session file size in bytes */
  fileSize: number;
  /** Last modified timestamp */
  lastModified: Date;
  /** Whether session is considered active (modified recently) */
  isActive: boolean;
  /** Number of user prompts in this session */
  userPromptCount?: number;
  /** Number of tasks in this session */
  taskCount?: number;
  /** Number of subagent sessions */
  agentCount?: number;
  /** Last user message text (truncated) */
  lastUserMessage?: string;
  /** Model used */
  model?: string;
  /** Total cost in USD */
  totalCostUsd?: number;
  /** Number of turns */
  numTurns?: number;
  /** Session this was forked from */
  forkedFromSessionId?: string;
}

export interface ProjectTask {
  /** Task ID (may be prefixed for multi-session aggregation) */
  taskId: string;
  /** Original task ID without prefix */
  originalId: string;
  /** Task list ID (often a session ID) */
  listId: string;
  /** Resolved session ID if found */
  sessionId?: string;
  /** Full task data */
  task: Task;
  /** Session info if available */
  sessionInfo?: {
    projectPath: string;
    projectKey: string;
    lastModified?: Date;
  };
}

export interface TaskReference {
  /** Session ID where the task was referenced */
  sessionId: string;
  /** Project path */
  projectPath: string;
  /** Task list ID */
  listId: string;
  /** Task ID */
  taskId: string;
  /** Tool name (TaskCreate, TaskUpdate, TaskGet, etc.) */
  toolName: string;
  /** Line number in session file */
  lineNumber: number;
}

export interface ProjectSize {
  /** Project path */
  projectPath: string;
  /** Encoded project path */
  encodedPath: string;
  /** Total size in bytes */
  totalBytes: number;
  /** Number of sessions */
  sessionCount: number;
  /** Size breakdown */
  breakdown: {
    /** Session files total bytes */
    sessions: number;
    /** Task files total bytes */
    tasks: number;
  };
  /** Human readable size */
  formattedSize: string;
}

export interface ListProjectsOptions {
  /** Return encoded paths instead of decoded (default: false) */
  encoded?: boolean;
  /** Include storage size calculation (default: true) */
  includeSize?: boolean;
}

export interface ListSessionsOptions {
  /** Filter for active sessions only */
  active?: boolean;
  /** Activity threshold in milliseconds (default: 60000 = 1 minute) */
  activeThresholdMs?: number;
}

// ============================================================================
// Service Implementation
// ============================================================================

export class ProjectsService {
  private configDir: string;
  private projectsDir: string;
  private tasksDir: string;
  private tasksService: TasksService;

  // File-change-invalidated session list cache
  private _sessionListCache: { result: ProjectSession[]; optionsKey: string } | null = null;
  private _sessionListDirty = true;

  constructor(configDir?: string) {
    this.configDir = configDir || getClaudeConfigDir();
    this.projectsDir = getProjectsDir(this.configDir);
    this.tasksDir = path.join(this.configDir, 'tasks');
    this.tasksService = new TasksService(this.tasksDir);

    // Register with SessionCache file watcher for cache invalidation
    try {
      const sessionCache = getSessionCache();
      sessionCache.onFileEvent(() => {
        this._sessionListDirty = true;
      });
    } catch {
      // SessionCache may not be initialized yet; cache stays dirty by default
    }
  }

  /**
   * Invalidate the session list cache.
   * Call this when external changes may have occurred.
   */
  invalidateSessionListCache(): void {
    this._sessionListDirty = true;
    this._sessionListCache = null;
  }

  // --------------------------------------------------------------------------
  // Project Listing
  // --------------------------------------------------------------------------

  /**
   * List all Claude Code projects
   */
  listProjects(options: ListProjectsOptions = {}): Project[] {
    const { encoded = false, includeSize = true } = options;
    const projects: Project[] = [];

    if (!fs.existsSync(this.projectsDir)) {
      return projects;
    }

    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const encodedPath = dir.name;
      const projectStorageDir = path.join(this.projectsDir, encodedPath);

      // Get session files
      const files = fs.readdirSync(projectStorageDir);
      const sessionFiles = files.filter(
        (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
      );

      // Find last activity, storage size, and most recent session path
      let lastActivity: Date | undefined;
      let storageSize = 0;
      let mostRecentSessionPath: string | undefined;

      for (const file of sessionFiles) {
        const filePath = path.join(projectStorageDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (!lastActivity || stats.mtime > lastActivity) {
            lastActivity = stats.mtime;
            mostRecentSessionPath = filePath;
          }
          if (includeSize) {
            storageSize += stats.size;
          }
        } catch {
          // Skip files that can't be stat'd
        }
      }

      // Extract real project path from session file's cwd field
      // This is more reliable than decoding the directory name since paths with
      // dashes (like "tier-agent") cannot be distinguished from directory separators
      let projectPath = this.extractProjectPathFromSessions(
        projectStorageDir,
        sessionFiles
      );

      // Fallback to decoded path if we couldn't extract from sessions
      if (!projectPath) {
        projectPath = decodePath(encodedPath);
      }

      // Check for CLAUDE.md and .git
      const hasClaudeMd = fs.existsSync(path.join(projectPath, 'CLAUDE.md'));
      const isGitProject = fs.existsSync(path.join(projectPath, '.git'));

      // Detect git info (lightweight — only when directory exists on disk)
      const git = isGitProject ? this.getGitInfo(projectPath) : null;

      projects.push({
        path: encoded ? encodedPath : projectPath,
        encodedPath,
        sessionCount: sessionFiles.length,
        lastActivity,
        storageSize,
        hasClaudeMd,
        isGitProject,
        git,
        _mostRecentSessionPath: mostRecentSessionPath,
      } as any);
    }

    // Post-process: a project is only a git root if no other git project
    // is a parent directory of it (filters out sub-repos inside monorepos)
    const gitPaths = projects
      .filter(p => p.isGitProject)
      .map(p => p.path);
    for (const project of projects) {
      if (project.isGitProject) {
        const hasGitParent = gitPaths.some(
          gp => gp !== project.path && project.path.startsWith(gp + '/')
        );
        if (hasGitParent) {
          (project as any).isGitProject = false;
        }
      }
    }

    // Sort by last activity (newest first)
    projects.sort((a, b) => {
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return b.lastActivity.getTime() - a.lastActivity.getTime();
    });

    return projects;
  }

  /**
   * Extract the real project path from session files by reading the cwd field
   */
  private extractProjectPathFromSessions(
    projectStorageDir: string,
    sessionFiles: string[]
  ): string | null {
    if (sessionFiles.length === 0) {
      return null;
    }

    // Try to read the cwd from the first session file
    const firstFile = path.join(projectStorageDir, sessionFiles[0]);
    try {
      const fd = fs.openSync(firstFile, 'r');
      const buffer = Buffer.alloc(16384); // Read up to 16KB
      const bytesRead = fs.readSync(fd, buffer, 0, 16384, 0);
      fs.closeSync(fd);

      const content = buffer.slice(0, bytesRead).toString('utf8');
      const lines = content.split('\n').slice(0, 20); // Check first 20 lines

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.cwd) {
            return msg.cwd;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Couldn't read the file
    }

    return null;
  }

  /**
   * Get a single project by path or encoded path
   */
  getProject(projectPathOrEncoded: string): Project | null {
    // Try to find the project by checking both the provided path and as encoded path
    let encodedPath: string;
    let projectPath: string;

    // First, check if this is an encoded path that exists
    const possibleStorageDir = path.join(this.projectsDir, projectPathOrEncoded);
    if (
      fs.existsSync(possibleStorageDir) &&
      fs.statSync(possibleStorageDir).isDirectory()
    ) {
      encodedPath = projectPathOrEncoded;
      projectPath = decodePath(projectPathOrEncoded);
    } else {
      // Treat as a project path, encode it
      encodedPath = encodePath(projectPathOrEncoded);
      projectPath = projectPathOrEncoded;

      // If Base64-encoded dir doesn't exist, try legacy dash encoding
      const base64Dir = path.join(this.projectsDir, encodedPath);
      if (!fs.existsSync(base64Dir)) {
        const legacyKey = legacyEncodeProjectPath(projectPathOrEncoded);
        const legacyDir = path.join(this.projectsDir, legacyKey);
        if (fs.existsSync(legacyDir)) {
          encodedPath = legacyKey;
        }
      }
    }

    const projectStorageDir = path.join(this.projectsDir, encodedPath);

    if (!fs.existsSync(projectStorageDir)) {
      return null;
    }

    const files = fs.readdirSync(projectStorageDir);
    const sessionFiles = files.filter(
      (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
    );

    let lastActivity: Date | undefined;
    let storageSize = 0;

    for (const file of sessionFiles) {
      const filePath = path.join(projectStorageDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (!lastActivity || stats.mtime > lastActivity) {
          lastActivity = stats.mtime;
        }
        storageSize += stats.size;
      } catch {
        // Skip
      }
    }

    // Extract real project path from session files
    const realProjectPath = this.extractProjectPathFromSessions(
      projectStorageDir,
      sessionFiles
    );

    // Use real path if available, otherwise use the provided/decoded path
    const finalProjectPath = realProjectPath || projectPath;
    const hasClaudeMd = fs.existsSync(path.join(finalProjectPath, 'CLAUDE.md'));
    const isGitProject = fs.existsSync(path.join(finalProjectPath, '.git'));
    const git = isGitProject ? this.getGitInfo(finalProjectPath) : null;

    return {
      path: finalProjectPath,
      encodedPath,
      sessionCount: sessionFiles.length,
      lastActivity,
      storageSize,
      hasClaudeMd,
      isGitProject,
      git,
    };
  }

  /**
   * Find the actual storage directory for a project path
   * Handles both Base64 and legacy dash-based encodings
   */
  private findProjectStorageDir(projectPath: string): {
    storageDir: string;
    encodedPath: string;
  } | null {
    // First, check if it's already an encoded directory name that exists
    const directDir = path.join(this.projectsDir, projectPath);
    if (fs.existsSync(directDir) && fs.statSync(directDir).isDirectory()) {
      return { storageDir: directDir, encodedPath: projectPath };
    }

    // Try Base64 encoding first (new format)
    const base64Encoded = encodePath(projectPath);
    const base64StorageDir = path.join(this.projectsDir, base64Encoded);
    if (
      fs.existsSync(base64StorageDir) &&
      fs.statSync(base64StorageDir).isDirectory()
    ) {
      return { storageDir: base64StorageDir, encodedPath: base64Encoded };
    }

    // Try legacy dash encoding (handles Windows paths like C:\home\project -> C--home-project)
    const legacyEncoded = legacyEncodeProjectPath(projectPath);
    const legacyStorageDir = path.join(this.projectsDir, legacyEncoded);
    if (
      fs.existsSync(legacyStorageDir) &&
      fs.statSync(legacyStorageDir).isDirectory()
    ) {
      return { storageDir: legacyStorageDir, encodedPath: legacyEncoded };
    }

    // Search through existing directories to find a match
    // This handles edge cases where neither encoding matches
    if (!fs.existsSync(this.projectsDir)) {
      return null;
    }

    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const storageDir = path.join(this.projectsDir, dir.name);
      const files = fs.readdirSync(storageDir).filter(
        (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
      );

      // Try to extract the real path from session files
      const realPath = this.extractProjectPathFromSessions(storageDir, files);
      if (realPath === projectPath) {
        return { storageDir, encodedPath: dir.name };
      }
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Fast Mtime Checks (stat-only, no file reads)
  // --------------------------------------------------------------------------

  /**
   * Get the latest session mtime across all projects.
   * Only does stat calls — no file parsing or cache reads.
   * Returns null if no sessions exist.
   */
  getLatestMtime(): Date | null {
    if (!fs.existsSync(this.projectsDir)) return null;

    let latest: Date | null = null;
    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const storageDir = path.join(this.projectsDir, dir.name);
      const mtime = this.getLatestMtimeInDir(storageDir);
      if (mtime && (!latest || mtime > latest)) {
        latest = mtime;
      }
    }

    return latest;
  }

  /**
   * Get the latest session mtime for a specific project.
   * Only does stat calls — no file parsing or cache reads.
   * Returns null if project not found or has no sessions.
   */
  getProjectLatestMtime(projectPathOrEncoded: string): Date | null {
    const found = this.findProjectStorageDir(projectPathOrEncoded);
    if (!found) return null;
    return this.getLatestMtimeInDir(found.storageDir);
  }

  /**
   * Scan a project directory for the most recent session file mtime.
   */
  private getLatestMtimeInDir(storageDir: string): Date | null {
    let latest: Date | null = null;
    try {
      const files = fs.readdirSync(storageDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue;
        try {
          const mtime = fs.statSync(path.join(storageDir, f)).mtime;
          if (!latest || mtime > latest) latest = mtime;
        } catch {
          // skip files that can't be stat'd
        }
      }
    } catch {
      // skip dirs that can't be read
    }
    return latest;
  }

  // --------------------------------------------------------------------------
  // Session Listing
  // --------------------------------------------------------------------------

  /**
   * Get sessions for a specific project
   */
  getProjectSessions(
    projectPathOrEncoded: string,
    options: ListSessionsOptions = {}
  ): ProjectSession[] {
    const { active, activeThresholdMs = 60000 } = options;

    const found = this.findProjectStorageDir(projectPathOrEncoded);
    if (!found) {
      return [];
    }

    const { storageDir: projectStorageDir, encodedPath } = found;

    const files = fs.readdirSync(projectStorageDir);
    const sessionFiles = files.filter(
      (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
    );

    // Extract real project path from session files
    const realProjectPath =
      this.extractProjectPathFromSessions(projectStorageDir, sessionFiles) ||
      (projectPathOrEncoded.startsWith('/') ? projectPathOrEncoded : decodePath(encodedPath));

    const sessions: ProjectSession[] = [];
    const now = Date.now();
    const sessionCache = getSessionCache();

    // Count agent files for a session
    const countAgentFiles = (sessionId: string): number => {
      const subagentsDir = path.join(projectStorageDir, sessionId, 'subagents');
      if (!fs.existsSync(subagentsDir)) return 0;
      try {
        return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl')).length;
      } catch {
        return 0;
      }
    };

    for (const file of sessionFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectStorageDir, file);

      try {
        const stats = fs.statSync(filePath);
        const isActive = now - stats.mtime.getTime() < activeThresholdMs;

        if (active !== undefined && active !== isActive) {
          continue;
        }

        // Enrich with cache data if available
        const cacheData = sessionCache.getSessionDataSync(filePath);
        const agentCount = countAgentFiles(sessionId);

        const session: ProjectSession = {
          sessionId,
          projectPath: realProjectPath,
          projectKey: encodedPath,
          filePath,
          fileSize: stats.size,
          lastModified: stats.mtime,
          isActive,
        };

        if (cacheData) {
          const realPrompts = cacheData.userPrompts.filter(isRealUserPrompt);
          const lastPrompt = realPrompts[realPrompts.length - 1];
          session.userPromptCount = realPrompts.length;
          session.taskCount = cacheData.tasks.length;
          session.lastUserMessage = lastPrompt?.text?.slice(0, 200);
          session.model = cacheData.model;
          session.totalCostUsd = cacheData.totalCostUsd || undefined;
          session.numTurns = cacheData.numTurns || undefined;
          session.forkedFromSessionId = cacheData.forkedFromSessionId;
        }
        if (agentCount > 0) {
          session.agentCount = agentCount;
        }

        sessions.push(session);
      } catch {
        // Skip files that can't be stat'd
      }
    }

    // Sort by last modified (newest first)
    sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return sessions;
  }

  /**
   * Get all sessions across all projects.
   * Uses file-change-invalidated cache: returns cached result when no
   * session files have been added, modified, or deleted since last scan.
   */
  getAllSessions(options: ListSessionsOptions = {}): ProjectSession[] {
    const optionsKey = JSON.stringify(options);

    // Return cached result if no file changes detected
    if (!this._sessionListDirty && this._sessionListCache && this._sessionListCache.optionsKey === optionsKey) {
      return this._sessionListCache.result;
    }

    const allSessions: ProjectSession[] = [];

    if (!fs.existsSync(this.projectsDir)) {
      return allSessions;
    }

    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      // Pass encoded path directly - getProjectSessions will resolve the real path
      const encodedPath = dir.name;
      const sessions = this.getProjectSessions(encodedPath, options);
      allSessions.push(...sessions);
    }

    // Sort all sessions by last modified (newest first)
    allSessions.sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
    );

    // Cache the result and mark as clean
    this._sessionListCache = { result: allSessions, optionsKey };
    this._sessionListDirty = false;

    return allSessions;
  }

  // --------------------------------------------------------------------------
  // Task Management with Session Mapping
  // --------------------------------------------------------------------------

  /**
   * Get tasks for a project with session mapping
   */
  async getProjectTasks(projectPath: string): Promise<{
    tasks: ProjectTask[];
    sessionCount: number;
    unmappedTasks: ProjectTask[];
  }> {
    const tasks: ProjectTask[] = [];
    const unmappedTasks: ProjectTask[] = [];

    // Get all task lists
    const allTaskLists = await this.tasksService.listTaskLists();

    // Get project sessions
    const projectSessions = this.getProjectSessions(projectPath);
    const projectSessionIds = new Set(projectSessions.map((s) => s.sessionId));

    // Map session IDs to session info
    const sessionInfoMap = new Map<
      string,
      { projectPath: string; projectKey: string; lastModified?: Date }
    >();
    for (const session of projectSessions) {
      sessionInfoMap.set(session.sessionId, {
        projectPath: session.projectPath,
        projectKey: session.projectKey,
        lastModified: session.lastModified,
      });
    }

    // Process each task list
    for (const listSummary of allTaskLists) {
      const listId = listSummary.listId;
      const isSessionId = this.tasksService.isSessionIdFormat(listId);

      // Check if this list belongs to the project
      let belongsToProject = false;
      let sessionId: string | undefined;
      let sessionInfo:
        | { projectPath: string; projectKey: string; lastModified?: Date }
        | undefined;

      if (isSessionId && projectSessionIds.has(listId)) {
        belongsToProject = true;
        sessionId = listId;
        sessionInfo = sessionInfoMap.get(listId);
      } else if (listSummary.sessionInfo) {
        // Check if sessionInfo points to our project (try both Base64 and legacy encoding)
        const encodedProjectPath = encodePath(projectPath);
        const legacyProjectKey = legacyEncodeProjectPath(projectPath);
        if (listSummary.sessionInfo.projectKey === encodedProjectPath ||
            listSummary.sessionInfo.projectKey === legacyProjectKey) {
          belongsToProject = true;
          sessionId = listSummary.sessionInfo.sessionId;
          sessionInfo = {
            projectPath: listSummary.sessionInfo.projectPath,
            projectKey: listSummary.sessionInfo.projectKey,
          };
        }
      }

      if (!belongsToProject) {
        // Try to find via session file search (for non-UUID list IDs)
        if (!isSessionId) {
          const references = await this.searchSessionsForTaskList(
            listId,
            projectPath
          );
          if (references.length > 0) {
            belongsToProject = true;
            sessionId = references[0].sessionId;
            sessionInfo = sessionInfoMap.get(sessionId);
          }
        }
      }

      if (!belongsToProject) continue;

      // Get tasks from this list
      const taskList = await this.tasksService.getTaskList(listId);
      if (!taskList) continue;

      const sessionPrefix = listId.slice(0, 8);

      for (const task of taskList.tasks) {
        const projectTask: ProjectTask = {
          taskId: `${sessionPrefix}:${task.id}`,
          originalId: task.id,
          listId,
          sessionId,
          task,
          sessionInfo,
        };

        if (sessionId) {
          tasks.push(projectTask);
        } else {
          unmappedTasks.push(projectTask);
        }
      }
    }

    return {
      tasks,
      sessionCount: projectSessions.length,
      unmappedTasks,
    };
  }

  /**
   * Search session files for references to a task list
   */
  async searchSessionsForTaskList(
    listId: string,
    projectPath?: string
  ): Promise<TaskReference[]> {
    const references: TaskReference[] = [];
    const sessions = projectPath
      ? this.getProjectSessions(projectPath)
      : this.getAllSessions();

    for (const session of sessions) {
      const sessionRefs = await this.searchSessionFileForTaskReferences(
        session.filePath,
        session.sessionId,
        session.projectPath,
        listId
      );
      references.push(...sessionRefs);
    }

    return references;
  }

  /**
   * Search a single session file for task references
   */
  private async searchSessionFileForTaskReferences(
    filePath: string,
    sessionId: string,
    projectPath: string,
    targetListId?: string
  ): Promise<TaskReference[]> {
    const references: TaskReference[] = [];

    if (!fs.existsSync(filePath)) {
      return references;
    }

    return new Promise((resolve) => {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let lineNumber = 0;

      rl.on('line', (line) => {
        lineNumber++;

        try {
          const record = JSON.parse(line);

          // Look for tool uses related to tasks
          if (record.type === 'assistant' && record.message?.content) {
            const content = record.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_use') {
                  const toolName = block.name;
                  const input = block.input;

                  // Check if this is a task-related tool
                  if (
                    ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(
                      toolName
                    )
                  ) {
                    const listId = input?.listId || input?.taskListId;
                    const taskId = input?.taskId || input?.id;

                    // If we have a target list ID, filter for it
                    if (targetListId && listId !== targetListId) {
                      continue;
                    }

                    if (listId || taskId) {
                      references.push({
                        sessionId,
                        projectPath,
                        listId: listId || sessionId,
                        taskId: taskId || '',
                        toolName,
                        lineNumber,
                      });
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      });

      rl.on('close', () => {
        resolve(references);
      });

      rl.on('error', () => {
        resolve(references);
      });
    });
  }

  // --------------------------------------------------------------------------
  // Cost Calculation
  // --------------------------------------------------------------------------

  /**
   * Get costs for all sessions in a project (including subagents)
   */
  async getProjectCosts(projectPath: string): Promise<{
    projectPath: string;
    totalCostUsd: number;
    sessionCount: number;
    sessions: Array<{
      sessionId: string;
      costUsd: number;
      subagentCostUsd: number;
      totalCostUsd: number;
      model?: string;
      numTurns?: number;
      subagentCount: number;
    }>;
  }> {
    const found = this.findProjectStorageDir(projectPath);

    if (!found) {
      return {
        projectPath,
        totalCostUsd: 0,
        sessionCount: 0,
        sessions: [],
      };
    }

    const { storageDir: projectStorageDir, encodedPath } = found;
    const files = fs.readdirSync(projectStorageDir);
    const sessionFiles = files.filter(
      (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
    );

    const sessions: Array<{
      sessionId: string;
      costUsd: number;
      subagentCostUsd: number;
      totalCostUsd: number;
      model?: string;
      numTurns?: number;
      subagentCount: number;
    }> = [];

    let totalCostUsd = 0;

    for (const file of sessionFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectStorageDir, file);

      // Get main session cost
      const sessionCost = await this.extractSessionCost(filePath);

      // Check for subagents
      let subagentCostUsd = 0;
      let subagentCount = 0;
      const subagentsDir = path.join(projectStorageDir, sessionId, 'subagents');

      if (fs.existsSync(subagentsDir)) {
        const agentFiles = fs.readdirSync(subagentsDir).filter(
          (f) => f.startsWith('agent-') && f.endsWith('.jsonl')
        );

        subagentCount = agentFiles.length;

        for (const agentFile of agentFiles) {
          const agentPath = path.join(subagentsDir, agentFile);
          const agentCost = await this.extractSessionCost(agentPath);
          subagentCostUsd += agentCost.costUsd;
        }
      }

      const sessionTotalCost = sessionCost.costUsd + subagentCostUsd;
      totalCostUsd += sessionTotalCost;

      sessions.push({
        sessionId,
        costUsd: sessionCost.costUsd,
        subagentCostUsd,
        totalCostUsd: sessionTotalCost,
        model: sessionCost.model,
        numTurns: sessionCost.numTurns,
        subagentCount,
      });
    }

    // Sort by total cost descending
    sessions.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    return {
      projectPath,
      totalCostUsd,
      sessionCount: sessions.length,
      sessions,
    };
  }

  /**
   * Extract cost from a session file by reading token usage from assistant messages
   * Cost is calculated from usage data, not from a pre-existing cost field
   */
  private async extractSessionCost(filePath: string): Promise<{
    costUsd: number;
    model?: string;
    numTurns?: number;
  }> {
    if (!fs.existsSync(filePath)) {
      return { costUsd: 0 };
    }

    return new Promise((resolve) => {
      let model: string | undefined;
      let numTurns = 0;
      let totalCostUsd = 0;

      // Token usage tracking
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreateTokens = 0;

      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        try {
          const record = JSON.parse(line);

          // Extract model from system init
          if (record.type === 'system' && record.subtype === 'init' && record.model) {
            model = record.model;
          }

          // Count user messages as turns
          if (record.type === 'user') {
            numTurns++;
          }

          // Extract token usage from assistant messages
          if (record.type === 'assistant' && record.message?.usage) {
            const usage = record.message.usage;
            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cacheReadTokens += usage.cache_read_input_tokens || 0;
            cacheCreateTokens += usage.cache_creation_input_tokens || 0;
          }

          // Extract cost from result message if available (overrides calculated)
          if (record.type === 'result' && record.total_cost_usd !== undefined) {
            totalCostUsd = record.total_cost_usd;
          }
        } catch {
          // Skip invalid JSON lines
        }
      });

      rl.on('close', () => {
        // Calculate cost if not already set from result message
        if (!totalCostUsd && inputTokens > 0) {
          totalCostUsd = this.calculateCost(
            model || '',
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreateTokens
          );
        }

        resolve({ costUsd: totalCostUsd, model, numTurns });
      });

      rl.on('error', () => {
        resolve({ costUsd: 0 });
      });
    });
  }

  /**
   * Calculate cost based on model and token usage
   * See: https://platform.claude.com/docs/en/about-claude/pricing
   */
  private calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreateTokens: number
  ): number {
    // Default: Sonnet 4/4.5 rates
    let inputRate = 3;
    let outputRate = 15;
    let cacheReadRate = 0.3;    // 10% of input
    let cacheCreateRate = 3.75; // 125% of input

    const modelLower = model.toLowerCase();

    if (modelLower.includes('opus-4-6') || modelLower.includes('opus-4.6') || modelLower.includes('opus-4-5') || modelLower.includes('opus-4.5')) {
      // Opus 4.5/4.6: $5 input, $25 output
      inputRate = 5;
      outputRate = 25;
      cacheReadRate = 0.5;
      cacheCreateRate = 6.25;
    } else if (modelLower.includes('opus')) {
      // Opus 4, 4.1, 3: $15 input, $75 output
      inputRate = 15;
      outputRate = 75;
      cacheReadRate = 1.5;
      cacheCreateRate = 18.75;
    } else if (modelLower.includes('haiku-4-5') || modelLower.includes('haiku-4.5')) {
      // Haiku 4.5: $1 input, $5 output
      inputRate = 1;
      outputRate = 5;
      cacheReadRate = 0.1;
      cacheCreateRate = 1.25;
    } else if (modelLower.includes('haiku-3-5') || modelLower.includes('haiku-3.5')) {
      // Haiku 3.5: $0.80 input, $4 output
      inputRate = 0.8;
      outputRate = 4;
      cacheReadRate = 0.08;
      cacheCreateRate = 1.0;
    } else if (modelLower.includes('haiku')) {
      // Haiku 3: $0.25 input, $1.25 output
      inputRate = 0.25;
      outputRate = 1.25;
      cacheReadRate = 0.03;
      cacheCreateRate = 0.30;
    }

    return (inputTokens / 1_000_000) * inputRate +
           (outputTokens / 1_000_000) * outputRate +
           (cacheReadTokens / 1_000_000) * cacheReadRate +
           (cacheCreateTokens / 1_000_000) * cacheCreateRate;
  }

  // --------------------------------------------------------------------------
  // Storage Size
  // --------------------------------------------------------------------------

  /**
   * Get storage size for a project
   */
  getProjectSize(projectPath: string): ProjectSize {
    const found = this.findProjectStorageDir(projectPath);

    let sessionsSize = 0;
    let sessionCount = 0;
    let encodedPath = '';
    let projectStorageDir = '';

    if (found) {
      encodedPath = found.encodedPath;
      projectStorageDir = found.storageDir;

      const files = fs.readdirSync(projectStorageDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;

        const filePath = path.join(projectStorageDir, file);
        try {
          const stats = fs.statSync(filePath);
          sessionsSize += stats.size;
          sessionCount++;
        } catch {
          // Skip
        }
      }
    }

    // Calculate task size for this project
    let tasksSize = 0;
    const projectSessions = this.getProjectSessions(projectPath);
    const sessionIds = new Set(projectSessions.map((s) => s.sessionId));

    if (fs.existsSync(this.tasksDir)) {
      const taskLists = fs.readdirSync(this.tasksDir, { withFileTypes: true });
      for (const taskList of taskLists) {
        if (!taskList.isDirectory()) continue;

        // Check if this task list belongs to the project
        if (sessionIds.has(taskList.name)) {
          const listPath = path.join(this.tasksDir, taskList.name);
          const taskFiles = fs.readdirSync(listPath);
          for (const taskFile of taskFiles) {
            if (!taskFile.endsWith('.json')) continue;
            try {
              const stats = fs.statSync(path.join(listPath, taskFile));
              tasksSize += stats.size;
            } catch {
              // Skip
            }
          }
        }
      }
    }

    const totalBytes = sessionsSize + tasksSize;

    return {
      projectPath,
      encodedPath,
      totalBytes,
      sessionCount,
      breakdown: {
        sessions: sessionsSize,
        tasks: tasksSize,
      },
      formattedSize: this.formatBytes(totalBytes),
    };
  }

  /**
   * Get total storage size across all projects
   */
  getAllProjectsSize(): {
    totalBytes: number;
    formattedSize: string;
    projectCount: number;
    breakdown: {
      sessions: number;
      tasks: number;
    };
    projects: ProjectSize[];
  } {
    const projects = this.listProjects({ includeSize: false });
    const projectSizes: ProjectSize[] = [];

    let totalSessions = 0;
    let totalTasks = 0;

    for (const project of projects) {
      const size = this.getProjectSize(project.path);
      projectSizes.push(size);
      totalSessions += size.breakdown.sessions;
      totalTasks += size.breakdown.tasks;
    }

    const totalBytes = totalSessions + totalTasks;

    return {
      totalBytes,
      formattedSize: this.formatBytes(totalBytes),
      projectCount: projects.length,
      breakdown: {
        sessions: totalSessions,
        tasks: totalTasks,
      },
      projects: projectSizes,
    };
  }

  // --------------------------------------------------------------------------
  // Git Detection
  // --------------------------------------------------------------------------

  /**
   * Detect git repository status for a project directory.
   * Runs git commands in the project directory to extract branch, remotes, worktree info.
   * Returns null if the directory doesn't exist or git is not available.
   */
  getGitInfo(projectPath: string): GitInfo | null {
    if (!fs.existsSync(projectPath)) {
      return null;
    }

    const execGit = (args: string): string | null => {
      try {
        return execSync(`git ${args}`, {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        return null;
      }
    };

    // Check if inside a git repo
    const topLevel = execGit('rev-parse --is-inside-work-tree');
    if (topLevel !== 'true') {
      return { initialized: false, branch: null, isBare: false, isWorktree: false, mainWorktreePath: null, worktrees: [], remotes: [], headCommit: null };
    }

    // Check bare repo
    const isBare = execGit('rev-parse --is-bare-repository') === 'true';

    // Current branch
    let branch: string | null = execGit('rev-parse --abbrev-ref HEAD');
    if (branch === 'HEAD') branch = null; // detached HEAD

    // HEAD commit
    const headCommit = execGit('rev-parse --short HEAD');

    // Worktree detection
    const gitDir = execGit('rev-parse --git-dir');
    const isWorktree = gitDir !== null && gitDir.includes('.git/worktrees');
    let mainWorktreePath: string | null = null;
    if (isWorktree) {
      mainWorktreePath = execGit('rev-parse --path-format=absolute --git-common-dir');
      if (mainWorktreePath && mainWorktreePath.endsWith('/.git')) {
        mainWorktreePath = mainWorktreePath.slice(0, -5);
      } else if (mainWorktreePath && mainWorktreePath.endsWith('\\.git')) {
        mainWorktreePath = mainWorktreePath.slice(0, -5);
      }
    }

    // List worktrees
    const worktrees: GitInfo['worktrees'] = [];
    const worktreeOutput = execGit('worktree list --porcelain');
    if (worktreeOutput) {
      const entries = worktreeOutput.split('\n\n').filter(Boolean);
      for (const entry of entries) {
        const lines = entry.split('\n');
        let wtPath = '';
        let wtBranch: string | null = null;
        let wtHead = '';
        for (const line of lines) {
          if (line.startsWith('worktree ')) wtPath = line.slice(9);
          else if (line.startsWith('HEAD ')) wtHead = line.slice(5, 12); // short hash
          else if (line.startsWith('branch ')) {
            wtBranch = line.slice(7);
            // Strip refs/heads/ prefix
            if (wtBranch.startsWith('refs/heads/')) wtBranch = wtBranch.slice(11);
          }
        }
        if (wtPath) {
          // Normalize for comparison
          const normalizedWtPath = wtPath.replace(/\\/g, '/');
          const normalizedProjectPath = projectPath.replace(/\\/g, '/');
          worktrees.push({
            path: wtPath,
            branch: wtBranch,
            head: wtHead,
            isCurrent: normalizedWtPath === normalizedProjectPath,
          });
        }
      }
    }

    // Remotes
    const remotes: GitRemote[] = [];
    const remoteOutput = execGit('remote -v');
    if (remoteOutput) {
      for (const line of remoteOutput.split('\n')) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (match) {
          remotes.push({
            name: match[1],
            url: match[2],
            type: match[3] as 'fetch' | 'push',
          });
        }
      }
    }

    return {
      initialized: true,
      branch,
      isBare,
      isWorktree,
      mainWorktreePath,
      worktrees,
      remotes,
      headCommit,
    };
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  /**
   * Format bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Decode project path (supports both Base64 and legacy dash encoding)
   */
  decodeProjectPath(encoded: string): string {
    return decodePath(encoded);
  }

  /**
   * Encode project path
   */
  encodeProjectPath(projectPath: string): string {
    return encodePath(projectPath);
  }

  /**
   * Get the tasks service instance
   */
  getTasksService(): TasksService {
    return this.tasksService;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

let _instance: ProjectsService | null = null;

export function createProjectsService(
  configDir?: string
): ProjectsService {
  return new ProjectsService(configDir);
}

export function getProjectsService(): ProjectsService {
  if (!_instance) {
    _instance = new ProjectsService();
  }
  return _instance;
}

export function resetProjectsService(): void {
  _instance = null;
}
