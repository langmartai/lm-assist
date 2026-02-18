/**
 * Task Store
 *
 * Read-only aggregation layer that watches Claude Code session files
 * for task state changes. Tasks exist ON TOP of sessions, extracted
 * and aggregated from session files.
 *
 * Key principles:
 * - TaskStore is READ-ONLY (no direct task file modification)
 * - Task input is ONE-WAY: execution prompt → LLM session manages tasks
 * - File watching via mtime timestamps to detect updates
 * - Sessions are simple workers, no cross-session awareness
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as chokidar from 'chokidar';
import { TasksService, Task } from './tasks-service';
import { SessionReader, SessionSummary } from './session-reader';
import { AgentSessionStore } from './agent-session-store';
import { getSessionCache, type SessionCacheData, isRealUserPrompt } from './session-cache';

// ============================================================================
// Types
// ============================================================================

/**
 * Task snapshot - task state at a point in time
 */
export interface TaskSnapshot {
  /** Task ID (prefixed with session short ID: {sessionId.slice(0,8)}:{taskId}) */
  id: string;
  /** Original task ID within session */
  originalId: string;
  /** Session ID this task belongs to */
  sessionId: string;
  /** Task subject */
  subject: string;
  /** Task description */
  description: string;
  /** Active form text (shown when in progress) */
  activeForm?: string;
  /** Task status */
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  /** Task IDs this task blocks */
  blocks: string[];
  /** Task IDs blocking this task */
  blockedBy: string[];
  /** Task owner */
  owner?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** When this snapshot was taken */
  snapshotAt: Date;
}

/**
 * Session snapshot - session state with tasks
 */
export interface SessionSnapshot {
  /** Session ID */
  sessionId: string;
  /** Project path */
  projectPath: string;
  /** Project key (encoded path) */
  projectKey: string;
  /** Session file path */
  filePath: string;
  /** Whether session file exists on disk */
  exists: boolean;
  /** Last modified time of session file */
  lastModified: Date;
  /** Tasks in this session */
  tasks: TaskSnapshot[];
  /** Number of file changes detected in session */
  fileChangeCount: number;
  /** Whether this session has ad-hoc work (file changes but no tasks) */
  hasAdhocWork: boolean;
  /** Session status */
  status: 'active' | 'completed' | 'error' | 'unknown';
  /** Last user message from session (first 100 words) */
  lastUserMessage?: string;
  /** When this snapshot was taken */
  snapshotAt: Date;
}

/**
 * Ad-hoc work record - session with file changes but no tasks
 */
export interface AdhocWorkRecord {
  /** Session ID */
  sessionId: string;
  /** Project path */
  projectPath: string;
  /** Number of file changes */
  fileChangeCount: number;
  /** Sample of changed files (first 10) */
  changedFiles: string[];
  /** Session last modified */
  lastModified: Date;
  /** Whether session is still active */
  isActive: boolean;
}

/**
 * Task store configuration
 */
export interface TaskStoreConfig {
  /** Project path to scope the store */
  projectPath: string;
  /** Claude config directory (default: ~/.claude) */
  claudeConfigDir?: string;
  /** Enable file watching (default: true) */
  watchEnabled?: boolean;
  /** Watch debounce interval in ms (default: 500) */
  watchDebounceMs?: number;
  /** Auto-refresh interval in ms (default: 0 = disabled) */
  autoRefreshMs?: number;
  /** Enable persistence to disk (default: true) */
  persistEnabled?: boolean;
}

/**
 * Session scan state for incremental updates
 */
export interface SessionScanState {
  /** Last line index scanned in session JSONL */
  lastLineIndex: number;
  /** Last modified time when scanned */
  lastModifiedMs: number;
  /** File size when scanned */
  fileSizeBytes: number;
}

/**
 * Persisted store state
 */
export interface TaskStorePersistedState {
  /** Version for migration */
  version: number;
  /** Project path this state belongs to */
  projectPath: string;
  /** When state was last saved */
  savedAt: string;
  /** Session scan states keyed by sessionId */
  sessionScans: Record<string, SessionScanState>;
  /** Cached session snapshots */
  sessions: Record<string, SessionSnapshot>;
  /** Cached task snapshots */
  tasks: Record<string, TaskSnapshot>;
}

/**
 * Task store event types
 */
export interface TaskStoreEvents {
  'task:created': (task: TaskSnapshot) => void;
  'task:updated': (task: TaskSnapshot, previous: TaskSnapshot) => void;
  'task:completed': (task: TaskSnapshot) => void;
  'session:updated': (session: SessionSnapshot) => void;
  'adhoc:detected': (record: AdhocWorkRecord) => void;
  'refresh': () => void;
  'error': (error: Error) => void;
}

// ============================================================================
// Task Store Implementation
// ============================================================================

const STORE_STATE_VERSION = 1;

export class TaskStore extends EventEmitter {
  private config: Required<TaskStoreConfig> & { persistEnabled: boolean };
  private sessions: Map<string, SessionSnapshot> = new Map();
  private taskIndex: Map<string, TaskSnapshot> = new Map();
  private sessionScans: Map<string, SessionScanState> = new Map();
  private watcher: chokidar.FSWatcher | null = null;
  private persistPath: string;
  private tasksService: TasksService;
  private sessionReader: SessionReader;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastMtimes: Map<string, number> = new Map();
  private isInitialized = false;

  constructor(config: TaskStoreConfig) {
    super();
    this.config = {
      projectPath: config.projectPath,
      claudeConfigDir: config.claudeConfigDir || path.join(os.homedir(), '.claude'),
      watchEnabled: config.watchEnabled ?? true,
      watchDebounceMs: config.watchDebounceMs ?? 500,
      autoRefreshMs: config.autoRefreshMs ?? 0,
      persistEnabled: config.persistEnabled ?? true,
    };

    // Persistence path: {projectPath}/.lm-assist/task-store.json
    this.persistPath = path.join(config.projectPath, '.lm-assist', 'task-store.json');

    this.tasksService = new TasksService(
      path.join(this.config.claudeConfigDir, 'tasks')
    );
    this.sessionReader = new SessionReader({
      configDir: this.config.claudeConfigDir,
      defaultCwd: this.config.projectPath,
    });

    // Enable session JSONL fallback for task extraction
    // When task files don't exist, tasks are extracted from TaskCreate/TaskUpdate tool calls
    const sessionStore = new AgentSessionStore({
      projectPath: this.config.projectPath,
      persist: false,
    });
    this.tasksService.setSessionStore(sessionStore);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Initialize the store - load initial state and start watching
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Load persisted state first (if enabled and exists)
    if (this.config.persistEnabled) {
      await this.loadFromDisk();
    }

    // Refresh to get latest state (incremental if we have persisted state)
    await this.refresh();

    // Start file watching if enabled
    if (this.config.watchEnabled) {
      this.startWatching();
    }

    // Start auto-refresh timer if configured
    if (this.config.autoRefreshMs > 0) {
      this.refreshTimer = setInterval(() => {
        this.refresh().catch(err => this.emit('error', err));
      }, this.config.autoRefreshMs);
    }

    this.isInitialized = true;
  }

  /**
   * Stop watching and clean up
   */
  async dispose(): Promise<void> {
    // Save state before disposing
    if (this.config.persistEnabled && this.isInitialized) {
      await this.saveToDisk();
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.sessions.clear();
    this.taskIndex.clear();
    this.sessionScans.clear();
    this.lastMtimes.clear();
    this.isInitialized = false;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * Load persisted state from disk
   */
  private async loadFromDisk(): Promise<void> {
    try {
      if (!fs.existsSync(this.persistPath)) {
        return;
      }

      const content = fs.readFileSync(this.persistPath, 'utf-8');
      const state: TaskStorePersistedState = JSON.parse(content);

      // Check version compatibility
      if (state.version !== STORE_STATE_VERSION) {
        console.warn(`TaskStore: Ignoring persisted state with version ${state.version} (expected ${STORE_STATE_VERSION})`);
        return;
      }

      // Check project path matches
      if (state.projectPath !== this.config.projectPath) {
        console.warn(`TaskStore: Ignoring persisted state for different project`);
        return;
      }

      // Restore session scan states
      for (const [sessionId, scanState] of Object.entries(state.sessionScans)) {
        this.sessionScans.set(sessionId, scanState);
      }

      // Restore sessions (convert dates)
      for (const [sessionId, session] of Object.entries(state.sessions)) {
        this.sessions.set(sessionId, {
          ...session,
          lastModified: new Date(session.lastModified),
          snapshotAt: new Date(session.snapshotAt),
          tasks: session.tasks.map(t => ({
            ...t,
            snapshotAt: new Date(t.snapshotAt),
          })),
        });
      }

      // Restore task index (convert dates)
      for (const [taskId, task] of Object.entries(state.tasks)) {
        this.taskIndex.set(taskId, {
          ...task,
          snapshotAt: new Date(task.snapshotAt),
        });
      }

      console.log(`TaskStore: Loaded ${this.sessions.size} sessions, ${this.taskIndex.size} tasks from disk`);
    } catch (err) {
      console.error('TaskStore: Failed to load persisted state:', err);
    }
  }

  /**
   * Save current state to disk
   */
  async saveToDisk(): Promise<void> {
    if (!this.config.persistEnabled) return;

    try {
      // Ensure directory exists
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state: TaskStorePersistedState = {
        version: STORE_STATE_VERSION,
        projectPath: this.config.projectPath,
        savedAt: new Date().toISOString(),
        sessionScans: Object.fromEntries(this.sessionScans),
        sessions: Object.fromEntries(this.sessions),
        tasks: Object.fromEntries(this.taskIndex),
      };

      // Write atomically (write to temp file, then rename)
      const tempPath = `${this.persistPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
      fs.renameSync(tempPath, this.persistPath);
    } catch (err) {
      console.error('TaskStore: Failed to save state:', err);
    }
  }

  // --------------------------------------------------------------------------
  // File Watching
  // --------------------------------------------------------------------------

  private startWatching(): void {
    const projectKey = this.sessionReader.cwdToProjectKey(this.config.projectPath);
    const watchPaths = [
      // Watch task files
      path.join(this.config.claudeConfigDir, 'tasks'),
      // Watch session files for this project
      path.join(this.config.claudeConfigDir, 'projects', projectKey),
    ];

    // Filter to existing paths
    const existingPaths = watchPaths.filter(p => fs.existsSync(p));
    if (existingPaths.length === 0) return;

    this.watcher = chokidar.watch(existingPaths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.watchDebounceMs,
        pollInterval: 100,
      },
    });

    // Debounced refresh
    let refreshTimeout: NodeJS.Timeout | null = null;
    const debouncedRefresh = () => {
      if (refreshTimeout) clearTimeout(refreshTimeout);
      refreshTimeout = setTimeout(() => {
        this.refresh().catch(err => this.emit('error', err));
      }, this.config.watchDebounceMs);
    };

    this.watcher.on('add', debouncedRefresh);
    this.watcher.on('change', debouncedRefresh);
    this.watcher.on('unlink', debouncedRefresh);
    this.watcher.on('error', err => this.emit('error', err));
  }

  // --------------------------------------------------------------------------
  // Core Refresh Logic
  // --------------------------------------------------------------------------

  /**
   * Refresh store state from disk
   */
  async refresh(): Promise<void> {
    const previousTasks = new Map(this.taskIndex);
    const previousSessions = new Map(this.sessions);

    // Build new state in temporary maps (atomic update pattern)
    const newSessions = new Map<string, SessionSnapshot>();
    const newTaskIndex = new Map<string, TaskSnapshot>();
    const newSessionScans = new Map<string, SessionScanState>();

    // Get all sessions for this project
    const sessionSummaries = this.sessionReader.listSessions(this.config.projectPath);

    for (const summary of sessionSummaries) {
      // Check if we need to update this session (incremental scan)
      const existingScan = this.sessionScans.get(summary.sessionId);
      const existingSession = this.sessions.get(summary.sessionId);

      // Skip if file hasn't changed since last scan
      if (existingScan && existingSession) {
        const filePath = this.sessionReader.getSessionFilePath(summary.sessionId, this.config.projectPath);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs === existingScan.lastModifiedMs && stats.size === existingScan.fileSizeBytes) {
            // No change - reuse cached session
            newSessions.set(existingSession.sessionId, existingSession);
            newSessionScans.set(summary.sessionId, existingScan);
            for (const task of existingSession.tasks) {
              newTaskIndex.set(task.id, task);
            }
            continue;
          }
        } catch {
          // If stat fails, do full rescan
        }
      }

      // Load or update session snapshot
      const snapshot = await this.loadSessionSnapshot(summary, existingScan);
      if (snapshot) {
        newSessions.set(snapshot.session.sessionId, snapshot.session);
        newSessionScans.set(summary.sessionId, snapshot.scanState);

        // Index tasks
        for (const task of snapshot.session.tasks) {
          newTaskIndex.set(task.id, task);
        }
      }
    }

    // Atomic swap - replace old maps with new ones
    this.sessions = newSessions;
    this.taskIndex = newTaskIndex;
    this.sessionScans = newSessionScans;

    // Emit events after swap (for task changes)
    for (const task of this.taskIndex.values()) {
      const previousTask = previousTasks.get(task.id);
      if (!previousTask) {
        this.emit('task:created', task);
      } else if (this.hasTaskChanged(previousTask, task)) {
        this.emit('task:updated', task, previousTask);
        if (task.status === 'completed' && previousTask.status !== 'completed') {
          this.emit('task:completed', task);
        }
      }
    }

    // Emit session update events
    for (const snapshot of this.sessions.values()) {
      const previousSession = previousSessions.get(snapshot.sessionId);
      if (!previousSession || previousSession.lastModified.getTime() !== snapshot.lastModified.getTime()) {
        this.emit('session:updated', snapshot);
      }

      // Emit ad-hoc detection
      if (snapshot.hasAdhocWork) {
        this.emit('adhoc:detected', {
          sessionId: snapshot.sessionId,
          projectPath: snapshot.projectPath,
          fileChangeCount: snapshot.fileChangeCount,
          changedFiles: [],
          lastModified: snapshot.lastModified,
          isActive: snapshot.status === 'active',
        });
      }
    }

    // Save updated state to disk
    if (this.config.persistEnabled) {
      await this.saveToDisk();
    }

    this.emit('refresh');
  }

  private async loadSessionSnapshot(
    summary: SessionSummary,
    existingScan?: SessionScanState
  ): Promise<{ session: SessionSnapshot; scanState: SessionScanState } | null> {
    const snapshotAt = new Date();
    const tasks: TaskSnapshot[] = [];
    const sessionPrefix = summary.sessionId.slice(0, 8);
    const filePath = this.sessionReader.getSessionFilePath(summary.sessionId, this.config.projectPath);

    // Get file stats for scan state tracking
    let fileStats: fs.Stats;
    try {
      fileStats = fs.statSync(filePath);
    } catch {
      return null;
    }

    // Get tasks from ~/.claude/tasks/{sessionId}/*.json
    const taskList = await this.tasksService.getTaskList(summary.sessionId);
    if (taskList && taskList.tasks) {
      for (const task of taskList.tasks) {
        tasks.push({
          id: `${sessionPrefix}:${task.id}`,
          originalId: task.id,
          sessionId: summary.sessionId,
          subject: task.subject,
          description: task.description,
          activeForm: task.activeForm,
          status: task.status,
          blocks: task.blocks.map(id => `${sessionPrefix}:${id}`),
          blockedBy: task.blockedBy.map(id => `${sessionPrefix}:${id}`),
          owner: task.owner,
          metadata: task.metadata,
          snapshotAt,
        });
      }
    }

    // Use session cache for metadata instead of reading the entire file
    let status: SessionSnapshot['status'] = 'unknown';
    let fileChangeCount = 0;
    let hasAdhocWork = false;
    let lastUserMessage: string | undefined;
    let totalLineCount = 0;

    try {
      const cache = getSessionCache();
      const cacheData = await cache.getSessionData(filePath);

      if (cacheData) {
        totalLineCount = cacheData.lastLineIndex + 1;

        // Determine status from cache
        if (cacheData.errors && cacheData.errors.length > 0) {
          status = 'error';
        } else if (cacheData.success || cacheData.result) {
          status = 'completed';
        } else {
          // Check if session is still active (modified recently)
          const msSinceModified = Date.now() - fileStats.mtimeMs;
          status = msSinceModified < 600000 ? 'active' : 'completed';
        }

        // Extract last real user message from cached user prompts
        if (cacheData.userPrompts && cacheData.userPrompts.length > 0) {
          const realPrompts = cacheData.userPrompts.filter(isRealUserPrompt);
          const lastPrompt = realPrompts[realPrompts.length - 1];
          if (lastPrompt.text) {
            const words = lastPrompt.text.trim().split(/\s+/);
            lastUserMessage = words.slice(0, 100).join(' ');
            if (words.length > 100) {
              lastUserMessage += '...';
            }
          }
        }

        // Count file changes from cached tool uses (for ad-hoc work detection)
        if (tasks.length === 0 && cacheData.toolUses) {
          const startLine = existingScan?.lastLineIndex || 0;
          for (const toolUse of cacheData.toolUses) {
            if (toolUse.lineIndex < startLine) continue;
            const toolName = toolUse.name?.toLowerCase() || '';
            if (['write', 'edit', 'notebookedit'].includes(toolName)) {
              fileChangeCount++;
            } else if (toolName === 'bash') {
              const cmd = toolUse.input?.command || '';
              if (cmd.includes('>') || cmd.includes('mv ') || cmd.includes('cp ') ||
                  cmd.includes('rm ') || cmd.includes('mkdir ') || cmd.includes('touch ')) {
                fileChangeCount++;
              }
            }
          }

          // Add any existing file change count from previous scan
          const existingSession = this.sessions.get(summary.sessionId);
          if (existingSession) {
            fileChangeCount += existingSession.fileChangeCount;
          }

          hasAdhocWork = fileChangeCount > 0;
        }
      }
    } catch {
      // Ignore cache errors, keep unknown status
    }

    const scanState: SessionScanState = {
      lastLineIndex: totalLineCount,
      lastModifiedMs: fileStats.mtimeMs,
      fileSizeBytes: fileStats.size,
    };

    const session: SessionSnapshot = {
      sessionId: summary.sessionId,
      projectPath: summary.projectPath,
      projectKey: summary.projectKey,
      filePath,
      exists: true, // We verified file exists via statSync above
      lastModified: summary.lastModified,
      tasks,
      fileChangeCount,
      hasAdhocWork,
      status,
      lastUserMessage,
      snapshotAt,
    };

    return { session, scanState };
  }

  private hasTaskChanged(prev: TaskSnapshot, curr: TaskSnapshot): boolean {
    return (
      prev.status !== curr.status ||
      prev.subject !== curr.subject ||
      prev.description !== curr.description ||
      prev.owner !== curr.owner ||
      JSON.stringify(prev.blocks) !== JSON.stringify(curr.blocks) ||
      JSON.stringify(prev.blockedBy) !== JSON.stringify(curr.blockedBy)
    );
  }

  // --------------------------------------------------------------------------
  // Read-Only Query Methods
  // --------------------------------------------------------------------------

  /**
   * Get all tasks across all sessions
   */
  getAllTasks(): TaskSnapshot[] {
    return Array.from(this.taskIndex.values());
  }

  /**
   * Get tasks for a specific session
   */
  getTasksForSession(sessionId: string): TaskSnapshot[] {
    const session = this.sessions.get(sessionId);
    return session?.tasks || [];
  }

  /**
   * Get a single task by ID
   */
  getTaskById(taskId: string): TaskSnapshot | null {
    return this.taskIndex.get(taskId) || null;
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: TaskSnapshot['status']): TaskSnapshot[] {
    return this.getAllTasks().filter(t => t.status === status);
  }

  /**
   * Get ready tasks (not blocked by incomplete tasks)
   */
  getReadyTasks(): TaskSnapshot[] {
    const completedIds = new Set(
      this.getAllTasks()
        .filter(t => t.status === 'completed')
        .map(t => t.id)
    );

    return this.getAllTasks().filter(task => {
      // Exclude completed and deleted tasks
      if (task.status === 'completed' || task.status === 'deleted') return false;
      return task.blockedBy.every(id => completedIds.has(id));
    });
  }

  /**
   * Get all session snapshots
   */
  getSessionSnapshots(): SessionSnapshot[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a single session snapshot
   */
  getSessionSnapshot(sessionId: string): SessionSnapshot | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get ad-hoc work records (sessions with file changes but no tasks)
   */
  getAdhocWork(): AdhocWorkRecord[] {
    return Array.from(this.sessions.values())
      .filter(s => s.hasAdhocWork)
      .map(s => ({
        sessionId: s.sessionId,
        projectPath: s.projectPath,
        fileChangeCount: s.fileChangeCount,
        changedFiles: [], // TODO: Extract actual file paths
        lastModified: s.lastModified,
        isActive: s.status === 'active',
      }));
  }

  // --------------------------------------------------------------------------
  // Parent Task Management
  // --------------------------------------------------------------------------

  /**
   * Get parent tasks (intent tasks) for a session
   */
  getParentTasks(sessionId?: string): TaskSnapshot[] {
    let tasks = this.getAllTasks();
    if (sessionId) {
      tasks = tasks.filter(t => t.sessionId === sessionId);
    }
    return tasks.filter(t => t.metadata?.isIntent === true);
  }

  /**
   * Get child tasks for a parent task
   * Checks both:
   * 1. Parent's blockedBy array (preferred - uses standard dependency system)
   * 2. Child's metadata.parentTaskId (legacy fallback)
   */
  getChildTasks(parentTaskId: string): TaskSnapshot[] {
    // Extract original ID and session from prefixed ID
    const originalId = parentTaskId.includes(':') ? parentTaskId.split(':')[1] : parentTaskId;
    const sessionId = parentTaskId.includes(':') ? parentTaskId.split(':')[0] : null;

    // First, find the parent task to check its blockedBy
    const parent = this.getTaskById(parentTaskId);
    if (parent && parent.blockedBy && parent.blockedBy.length > 0) {
      // Parent has blockedBy - those are the children
      const allTasks = this.getAllTasks();
      return allTasks.filter(t => {
        // Check if this task is in parent's blockedBy list
        return parent.blockedBy.some((blockerId: string) =>
          blockerId === t.id || blockerId === t.originalId ||
          (sessionId && `${sessionId}:${t.originalId}` === blockerId)
        );
      });
    }

    // Fallback: check metadata.parentTaskId on children
    return this.getAllTasks().filter(t => {
      const parentRef = t.metadata?.parentTaskId;
      if (!parentRef) return false;
      // Match either full prefixed ID or original ID
      return parentRef === parentTaskId || parentRef === originalId;
    });
  }

  /**
   * Check if a parent task should be auto-completed
   * Returns list of parent tasks that have all children completed
   */
  getCompletableParentTasks(sessionId?: string): TaskSnapshot[] {
    const parentTasks = this.getParentTasks(sessionId);
    const completable: TaskSnapshot[] = [];

    for (const parent of parentTasks) {
      // Skip already completed parents
      if (parent.status === 'completed') continue;

      const children = this.getChildTasks(parent.id);

      // If no children, not completable via this mechanism
      if (children.length === 0) continue;

      // Check if all children are completed
      const allChildrenComplete = children.every(
        c => c.status === 'completed' || c.status === 'deleted'
      );

      if (allChildrenComplete) {
        completable.push(parent);
      }
    }

    return completable;
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /**
   * Get store statistics
   */
  getStats(): {
    totalTasks: number;
    byStatus: Record<string, number>;
    totalSessions: number;
    activeSessions: number;
    adhocSessions: number;
  } {
    const tasks = this.getAllTasks();
    const sessions = this.getSessionSnapshots();

    return {
      totalTasks: tasks.length,
      byStatus: {
        pending: tasks.filter(t => t.status === 'pending').length,
        in_progress: tasks.filter(t => t.status === 'in_progress').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        deleted: tasks.filter(t => t.status === 'deleted').length,
      },
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === 'active').length,
      adhocSessions: sessions.filter(s => s.hasAdhocWork).length,
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

const stores: Map<string, TaskStore> = new Map();

/**
 * Get or create a TaskStore for a project
 */
export function getTaskStore(projectPath: string): TaskStore {
  const normalized = path.resolve(projectPath);
  if (!stores.has(normalized)) {
    stores.set(normalized, new TaskStore({ projectPath: normalized }));
  }
  return stores.get(normalized)!;
}

/**
 * Create a new TaskStore instance
 */
export function createTaskStore(config: TaskStoreConfig): TaskStore {
  return new TaskStore(config);
}

/**
 * Dispose all stores
 */
export async function disposeAllTaskStores(): Promise<void> {
  for (const store of stores.values()) {
    await store.dispose();
  }
  stores.clear();
}
