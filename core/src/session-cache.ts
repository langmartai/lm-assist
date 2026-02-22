/**
 * Session Cache Layer — LMDB-backed
 *
 * Provides efficient caching for Claude Code session JSONL files.
 * Uses LMDB (memory-mapped database) as the storage backend for
 * instant reads with zero warmup on server startup.
 *
 * Key optimizations:
 * 1. LMDB memory-mapped reads — sync ~0ms via OS page cache
 * 2. Incremental parsing — only parse new lines when file grows (append-only)
 * 3. Line index tracking for efficient delta updates
 * 4. Separate sub-database for raw messages (optional, large)
 * 5. Async batched writes via lmdb-js
 *
 * Cache invalidation:
 * - File size decreased (file was truncated/replaced) -> full reparse
 * - File mtime older than cache -> full reparse (shouldn't happen)
 * - File size increased -> parse only new lines, merge with cache
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import chokidar, { FSWatcher } from 'chokidar';
import { getStartupProfiler } from './startup-profiler';
import { SessionCacheStore } from './session-cache-store';
import { getDataDir, legacyEncodeProjectPath } from './utils/path-utils';

// ─── Types ──────────────────────────────────────────────────

export type PromptType = 'user' | 'command' | 'command_output' | 'system_caveat' | 'hook_result';

export interface CachedUserPrompt {
  turnIndex: number;
  lineIndex: number;
  text: string;
  images?: number;
  timestamp?: string;
  /** Classification of the prompt. Undefined means 'user' (backward compat, saves space). */
  promptType?: PromptType;
}

/**
 * Classify a user message as a real user prompt or a system-injected message.
 * System messages are identified by their XML tag prefixes.
 */
export function classifyUserPrompt(text: string, isMeta?: boolean): PromptType {
  const trimmed = text.trimStart();
  if (isMeta || trimmed.startsWith('<local-command-caveat>')) return 'system_caveat';
  if (trimmed.startsWith('<command-name>')) return 'command';
  if (trimmed.startsWith('<local-command-stdout>')) return 'command_output';
  if (trimmed.startsWith('<user-prompt-submit-hook>')) return 'hook_result';
  return 'user';
}

/**
 * Returns true if the prompt is a real user prompt (not system-injected).
 */
export function isRealUserPrompt(prompt: CachedUserPrompt): boolean {
  return !prompt.promptType || prompt.promptType === 'user';
}

export interface CachedToolUse {
  id: string;
  name: string;
  input: any;
  turnIndex: number;
  lineIndex: number;
}

export interface CachedResponse {
  turnIndex: number;
  lineIndex: number;
  text: string;
  isApiError?: boolean;
  requestId?: string;
}

export interface CachedThinkingBlock {
  turnIndex: number;
  lineIndex: number;
  thinking: string;
}

export interface CachedTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
  turnIndex: number;
  lineIndex: number;
}

export interface CachedTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
  lineIndex: number;
}

export interface CachedPlan {
  toolUseId: string;
  status: 'entering' | 'approved';
  planFile?: string;
  planTitle?: string;
  planSummary?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  turnIndex: number;
  lineIndex: number;
}


export interface CachedSubagent {
  agentId: string;
  toolUseId: string;
  type: string;
  prompt: string;
  description?: string;
  model?: string;
  // ─── Parent Session Indices ───
  turnIndex: number;
  lineIndex: number;
  userPromptIndex: number;  // Index of the user prompt that triggered this subagent
  parentUuid?: string;  // UUID of the parent message (from agent_progress)
  // ─── Subagent Status ───
  startedAt?: string;
  completedAt?: string;
  status: string;
  result?: string;
  runInBackground?: boolean;
}

export interface CachedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface SessionCacheData {
  // Cache metadata
  version: number;
  sessionId: string;
  filePath: string;
  fileSize: number;
  fileMtime: number;
  lastLineIndex: number;
  lastTurnIndex: number;
  /** Byte offset of the end of parsed content (for seeking on incremental parse) */
  lastByteOffset?: number;
  createdAt: number;

  // Session metadata
  cwd: string;
  model: string;
  claudeCodeVersion: string;
  permissionMode: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  systemPrompt?: string;

  // Incremental arrays (with lineIndex for delta updates)
  userPrompts: CachedUserPrompt[];
  toolUses: CachedToolUse[];
  responses: CachedResponse[];
  thinkingBlocks: CachedThinkingBlock[];

  // Aggregated data (maps serialized as arrays of [key, value])
  tasks: CachedTask[];
  todos: CachedTodo[];
  subagents: CachedSubagent[];
  subagentProgress: any[];
  plans: CachedPlan[];

  // Team data
  teamName?: string;
  allTeams: string[];
  teamOperations: Array<{ operation: 'spawnTeam' | 'cleanup'; teamName?: string; description?: string; turnIndex: number; lineIndex: number }>;
  teamMessages: Array<{ messageType: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'; recipient?: string; content?: string; summary?: string; requestId?: string; approve?: boolean; turnIndex: number; lineIndex: number }>;

  // Stats
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: CachedUsage;

  // Result info
  result?: string;
  errors?: string[];
  success: boolean;

  // Fork tracking
  forkedFromSessionId?: string;
  forkPointUuid?: string;

  // Timestamps
  firstTimestamp?: string;
  lastTimestamp?: string;
}

// Separate cache for raw messages (large, optional)
export interface RawMessagesCache {
  version: number;
  sessionId: string;
  fileSize: number;
  fileMtime: number;
  lastLineIndex: number;
  /** Byte offset of the end of parsed content (for seeking on incremental parse) */
  lastByteOffset?: number;
  messages: Array<any & { lineIndex: number }>;
}

// ─── Constants ──────────────────────────────────────────────────

const CACHE_VERSION = 9; // v9: Add promptType classification for system-injected messages

// ─── SessionCache Class ──────────────────────────────────────────────────

export class SessionCache {
  private store: SessionCacheStore;

  // File watcher for proactive cache updates
  private watcher: FSWatcher | null = null;
  private watchedPaths: Set<string> = new Set();
  private pendingUpdates: Map<string, NodeJS.Timeout> = new Map();
  private updateDebounceMs = 500;  // Debounce file changes
  private isWatching = false;

  // onChange callbacks for session data updates
  private onChangeCallbacks: Array<(sessionId: string, cacheData: SessionCacheData) => void> = [];

  // onFileEvent callbacks for raw file system events (add/change/unlink)
  private onFileEventCallbacks: Array<(event: 'add' | 'change' | 'unlink', filePath: string) => void> = [];

  constructor(baseDir?: string) {
    const profiler = getStartupProfiler();
    profiler.start('lmdbOpen', 'LMDB Open', 'SessionCache');
    const cacheDir = baseDir || path.join(getDataDir(), 'session-cache');
    this.store = new SessionCacheStore(cacheDir);
    profiler.end('lmdbOpen');
  }

  /**
   * Register a callback that fires when a session's cache data is updated.
   * Called after successful getSessionData() with new/changed data.
   */
  onSessionChange(cb: (sessionId: string, cacheData: SessionCacheData) => void): void {
    this.onChangeCallbacks.push(cb);
  }

  /**
   * Register a callback for raw file system events (add/change/unlink).
   * Fires immediately when chokidar detects a file event, before parsing.
   */
  onFileEvent(cb: (event: 'add' | 'change' | 'unlink', filePath: string) => void): void {
    this.onFileEventCallbacks.push(cb);
  }

  private fireFileEvent(event: 'add' | 'change' | 'unlink', filePath: string): void {
    for (const cb of this.onFileEventCallbacks) {
      try {
        cb(event, filePath);
      } catch {
        // Don't let callback errors affect watcher operations
      }
    }
  }

  private fireOnChange(cacheData: SessionCacheData): void {
    if (this.onChangeCallbacks.length === 0 || !cacheData.sessionId) return;
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(cacheData.sessionId, cacheData);
      } catch {
        // Don't let callback errors affect cache operations
      }
    }
  }

  /**
   * Start watching session directories for file changes.
   * When files are added or modified, proactively update the cache.
   */
  startWatching(projectPaths?: string[]): void {
    if (this.isWatching) return;

    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    // Build watch paths
    const watchPaths: string[] = [];
    if (projectPaths && projectPaths.length > 0) {
      // Watch specific projects
      for (const projectPath of projectPaths) {
        const projectKey = legacyEncodeProjectPath(projectPath);
        const projectDir = path.join(projectsDir, projectKey);
        if (fs.existsSync(projectDir)) {
          watchPaths.push(projectDir);
        }
      }
    } else {
      // Watch all projects
      if (fs.existsSync(projectsDir)) {
        watchPaths.push(projectsDir);
      }
    }

    if (watchPaths.length === 0) {
      return;
    }

    this.watcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,  // Don't trigger events for existing files
      depth: 3,  // Watch up to 3 levels deep (project/session/subagents/agent-*.jsonl)
      ignored: [
        /node_modules/,
        /\.git/,
        /\.lmdb/,        // Ignore LMDB files
      ],
      awaitWriteFinish: {
        stabilityThreshold: 300,  // Wait for file to stabilize
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (filePath) => {
      if (filePath.endsWith('.jsonl')) {
        this.fireFileEvent('add', filePath);
        this.scheduleUpdate(filePath);
      }
    });

    this.watcher.on('change', (filePath) => {
      if (filePath.endsWith('.jsonl')) {
        this.fireFileEvent('change', filePath);
        this.scheduleUpdate(filePath);
      }
    });

    this.watcher.on('unlink', (filePath) => {
      if (filePath.endsWith('.jsonl')) {
        this.fireFileEvent('unlink', filePath);
      }
    });

    this.watcher.on('error', (error) => {
      console.error('[SessionCache] Watcher error:', error);
    });

    this.isWatching = true;
    watchPaths.forEach(p => this.watchedPaths.add(p));
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.isWatching = false;
    this.watchedPaths.clear();

    // Clear pending updates
    for (const timeout of this.pendingUpdates.values()) {
      clearTimeout(timeout);
    }
    this.pendingUpdates.clear();
  }

  /**
   * Schedule a debounced cache update for a file
   */
  private scheduleUpdate(filePath: string): void {
    // Clear existing pending update for this file
    const existing = this.pendingUpdates.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule new update
    const timeout = setTimeout(() => {
      this.pendingUpdates.delete(filePath);
      this.warmCache(filePath).catch(err => {
        // Silently ignore errors during background warming
      });
    }, this.updateDebounceMs);

    this.pendingUpdates.set(filePath, timeout);
  }

  /**
   * Proactively warm the cache for a file
   */
  async warmCache(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;

    try {
      // This will update the cache if needed
      await this.getSessionData(filePath);
    } catch (err) {
      // Silently ignore errors during background warming
    }
  }

  /**
   * Warm cache for all session files in a project
   */
  async warmProjectCache(projectPath: string): Promise<{ warmed: number; errors: number }> {
    const projectKey = legacyEncodeProjectPath(projectPath);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

    if (!fs.existsSync(projectDir)) {
      return { warmed: 0, errors: 0 };
    }

    let warmed = 0;
    let errors = 0;

    // Find all JSONL files
    const files: string[] = [];

    // Main session files
    const mainFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(projectDir, f));
    files.push(...mainFiles);

    // Subagent files in session subdirectories
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subagentsDir = path.join(projectDir, entry.name, 'subagents');
        if (fs.existsSync(subagentsDir)) {
          const agentFiles = fs.readdirSync(subagentsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(subagentsDir, f));
          files.push(...agentFiles);
        }
      }
    }

    // Warm cache in parallel (with concurrency limit)
    const CONCURRENCY = 10;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(f => this.warmCache(f))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          warmed++;
        } else {
          errors++;
        }
      }
    }

    return { warmed, errors };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryCacheSize: number;
    rawMemoryCacheSize: number;
    isWatching: boolean;
    watchedPaths: string[];
    pendingUpdates: number;
    lmdb: {
      sessionCount: number;
      rawCount: number;
    };
  } {
    return {
      memoryCacheSize: this.store.sessionCount,
      rawMemoryCacheSize: this.store.rawCount,
      isWatching: this.isWatching,
      watchedPaths: Array.from(this.watchedPaths),
      pendingUpdates: this.pendingUpdates.size,
      lmdb: {
        sessionCount: this.store.sessionCount,
        rawCount: this.store.rawCount,
      },
    };
  }

  /**
   * Returns false — no warming needed with LMDB (instant reads via mmap).
   * @deprecated Kept for backward compatibility with callers.
   */
  isWarming(): boolean {
    return false;
  }

  /**
   * Resolves immediately — no warming needed with LMDB.
   * @deprecated Kept for backward compatibility with callers.
   */
  waitForWarming(_intervalMs = 2000): Promise<void> {
    return Promise.resolve();
  }

  /**
   * No-op — warming is not needed with LMDB (instant reads via mmap).
   * @deprecated Kept for backward compatibility with callers.
   */
  startBackgroundWarming(_options?: {
    concurrency?: number;
    batchSize?: number;
    delayBetweenBatches?: number;
  }): void {
    console.log('[SessionCache] Background warming is no longer needed (LMDB mmap provides instant reads)');
  }

  /**
   * No-op — warming is not needed with LMDB.
   * @deprecated Kept for backward compatibility with callers.
   */
  stopBackgroundWarming(): void {
    // No-op
  }

  /**
   * No-op — kept for backward compatibility. Callbacks fire immediately
   * since data is always available via LMDB.
   * @deprecated
   */
  onWarmingComplete(cb: () => void): void {
    // Fire immediately since data is always available with LMDB
    try { cb(); } catch { /* ignore */ }
  }

  /**
   * Check if cache is valid for the given file stats
   */
  private isCacheValid(cache: SessionCacheData | null, stats: fs.Stats): 'valid' | 'append' | 'invalid' {
    if (!cache) return 'invalid';

    // Version mismatch — force full reparse
    if (cache.version !== CACHE_VERSION) return 'invalid';

    const fileMtime = stats.mtime.getTime();
    const fileSize = stats.size;

    // File was replaced or truncated
    if (fileSize < cache.fileSize) return 'invalid';

    // File mtime is older than cache (shouldn't happen, but handle it)
    if (fileMtime < cache.fileMtime) return 'invalid';

    // File unchanged
    if (fileSize === cache.fileSize && fileMtime === cache.fileMtime) return 'valid';

    // File grew (append-only) - can do incremental update
    if (fileSize > cache.fileSize) return 'append';

    return 'invalid';
  }

  /**
   * Parse new lines from a session file using byte offset seeking.
   * If lastByteOffset is available, seeks directly to new content (~0ms).
   * Otherwise falls back to reading from the beginning and skipping lines.
   */
  private async parseNewLines(
    sessionPath: string,
    startLineIndex: number,
    startTurnIndex: number,
    existingCache: SessionCacheData
  ): Promise<{
    newMessages: Array<any & { lineIndex: number }>;
    lastLineIndex: number;
    lastTurnIndex: number;
    lastByteOffset: number;
  }> {
    const newMessages: Array<any & { lineIndex: number }> = [];

    // Build a set of already-cached lineIndexes to avoid duplicates.
    const cachedLineIndexes = new Set<number>();
    for (const p of existingCache.userPrompts) cachedLineIndexes.add(p.lineIndex);
    for (const t of existingCache.toolUses) cachedLineIndexes.add(t.lineIndex);
    for (const r of existingCache.responses) cachedLineIndexes.add(r.lineIndex);
    for (const tb of existingCache.thinkingBlocks) cachedLineIndexes.add(tb.lineIndex);

    let lineIndex: number;
    let turnIndex = startTurnIndex;
    let byteOffset: number;

    if (existingCache.lastByteOffset && existingCache.lastByteOffset > 0) {
      // Fast path: seek directly to new content using byte offset
      const fileStream = fs.createReadStream(sessionPath, { start: existingCache.lastByteOffset });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = startLineIndex + 1; // Lines after the last parsed one
      byteOffset = existingCache.lastByteOffset;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
        if (line.trim() && !cachedLineIndexes.has(lineIndex)) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
            if (msg.type === 'assistant') {
              turnIndex++;
            }
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    } else {
      // Fallback: read from beginning (first incremental after cache load without byte offset)
      const fileStream = fs.createReadStream(sessionPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = 0;
      byteOffset = 0;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
        if (lineIndex > startLineIndex && line.trim() && !cachedLineIndexes.has(lineIndex)) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
            if (msg.type === 'assistant') {
              turnIndex++;
            }
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    }

    return {
      newMessages,
      lastLineIndex: lineIndex - 1,
      lastTurnIndex: turnIndex,
      lastByteOffset: byteOffset,
    };
  }

  /**
   * Merge new messages into existing cache
   */
  private mergeNewMessages(
    cache: SessionCacheData,
    newMessages: Array<any & { lineIndex: number }>,
    stats: fs.Stats
  ): SessionCacheData {
    // Deep clone cache to avoid mutations
    const updated: SessionCacheData = JSON.parse(JSON.stringify(cache));
    updated.fileSize = stats.size;
    updated.fileMtime = stats.mtime.getTime();

    let turnIndex = cache.lastTurnIndex;
    let lastTimestamp: string | undefined = cache.lastTimestamp;

    for (const msg of newMessages) {
      // Track timestamps
      if (msg.timestamp) {
        lastTimestamp = msg.timestamp;
      }

      // Extract session metadata
      if (!updated.sessionId && msg.sessionId) {
        // Fork detection (two patterns):
        // 1. Legacy: file-based sessionId differs from content sessionId (old fork behavior)
        // 2. CLI --fork-session: explicit `forkedFrom` field with parent sessionId
        const fileBasedId = path.basename(updated.filePath, '.jsonl');
        if (msg.sessionId !== fileBasedId && !fileBasedId.startsWith('agent-')) {
          updated.forkedFromSessionId = msg.sessionId;
          updated.forkPointUuid = msg.parentUuid || undefined;
        } else if (msg.forkedFrom?.sessionId) {
          updated.forkedFromSessionId = msg.forkedFrom.sessionId;
          updated.forkPointUuid = msg.forkedFrom.messageUuid || undefined;
        }
        updated.sessionId = msg.sessionId;
      }
      if (!updated.cwd && msg.cwd) {
        updated.cwd = msg.cwd;
      }
      if (!updated.claudeCodeVersion && msg.version) {
        updated.claudeCodeVersion = msg.version;
      }
      if (!updated.teamName && msg.teamName) {
        updated.teamName = msg.teamName;
      }

      // System init message
      if (msg.type === 'system' && msg.subtype === 'init') {
        updated.sessionId = msg.session_id || updated.sessionId;
        updated.cwd = msg.cwd || updated.cwd;
        updated.model = msg.model || updated.model;
        updated.claudeCodeVersion = msg.claude_code_version || updated.claudeCodeVersion;
        updated.permissionMode = msg.permissionMode || updated.permissionMode;
        updated.tools = msg.tools || updated.tools;
        updated.mcpServers = msg.mcp_servers || updated.mcpServers;
      }

      // User message
      if (msg.type === 'user') {
        const content = msg.message?.content;
        let text = '';
        let images = 0;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') text += block.text;
            if (block.type === 'image') images++;
          }
        } else if (typeof content === 'string') {
          text = content;
        }

        if (text || images > 0) {
          const promptType = classifyUserPrompt(text, msg.isMeta);
          updated.userPrompts.push({
            turnIndex,
            lineIndex: msg.lineIndex,
            text,
            images: images > 0 ? images : undefined,
            timestamp: msg.timestamp,
            promptType: promptType !== 'user' ? promptType : undefined,
          });
        }

        // Extract tool_result blocks — handle both string and array content formats
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              // Extract text from tool_result content (may be string or array of text blocks)
              let resultText = '';
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter((b: any) => b.type === 'text' && b.text)
                  .map((b: any) => b.text)
                  .join('\n');
              }

              // TaskCreate result mapping: "Task #N created successfully: ..."
              const taskCreateMatch = resultText.match(/Task #(\d+) created successfully/);
              if (taskCreateMatch) {
                const assignedId = taskCreateMatch[1];
                const tempId = `temp-${block.tool_use_id}`;
                const tempIdx = updated.tasks.findIndex(t => t.id === tempId);
                if (tempIdx >= 0) {
                  updated.tasks[tempIdx].id = assignedId;
                }
              }

              // Mark subagent as completed/error when we see the tool_result for its Task tool_use
              const subagent = updated.subagents.find(s => s.toolUseId === block.tool_use_id);
              if (subagent && subagent.status !== 'completed' && resultText) {
                subagent.status = block.is_error ? 'error' : 'completed';
                subagent.result = resultText;
                subagent.completedAt = msg.timestamp || new Date().toISOString();
              }
            }
          }
        }

      }

      // Assistant message
      if (msg.type === 'assistant') {
        turnIndex++;

        if (msg.message?.model) {
          updated.model = msg.message.model;
        }

        // Detect Anthropic API error messages (500, overloaded, etc.)
        // These have isApiErrorMessage: true, model: "<synthetic>", and zero usage
        const isApiError = !!(msg.isApiErrorMessage || msg.error);

        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              if (isApiError) {
                let requestId: string | undefined;
                const reqMatch = block.text.match(/"request_id"\s*:\s*"([^"]+)"/);
                if (reqMatch) requestId = reqMatch[1];
                updated.responses.push({
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  text: block.text,
                  isApiError: true,
                  requestId,
                });
              } else {
                updated.responses.push({
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  text: block.text,
                });
              }
            }

            if (block.type === 'tool_use' && block.id && block.name) {
              updated.toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input,
                turnIndex,
                lineIndex: msg.lineIndex,
              });

              if (!updated.tools.includes(block.name)) {
                updated.tools.push(block.name);
              }

              // Extract TaskCreate
              if (block.name === 'TaskCreate' && block.input) {
                const input = block.input;
                const tempId = `temp-${block.id}`;
                updated.tasks.push({
                  id: tempId,
                  subject: input.subject || '',
                  description: input.description,
                  activeForm: input.activeForm,
                  status: 'pending',
                  blocks: [],
                  blockedBy: input.blockedBy || [],
                  owner: input.owner,
                  metadata: input.metadata,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
              }

              // Extract TaskUpdate
              if (block.name === 'TaskUpdate' && block.input) {
                const input = block.input;
                const taskId = input.taskId;
                if (taskId) {
                  const existingIdx = updated.tasks.findIndex(t => t.id === taskId);
                  if (existingIdx >= 0) {
                    const existing = updated.tasks[existingIdx];
                    if (input.status) existing.status = input.status;
                    if (input.subject) existing.subject = input.subject;
                    if (input.description) existing.description = input.description;
                    if (input.activeForm) existing.activeForm = input.activeForm;
                    if (input.owner !== undefined) existing.owner = input.owner;
                    if (input.addBlocks) existing.blocks.push(...input.addBlocks);
                    if (input.addBlockedBy) existing.blockedBy.push(...input.addBlockedBy);
                    if (input.metadata) {
                      existing.metadata = existing.metadata || {};
                      for (const [k, v] of Object.entries(input.metadata)) {
                        if (v === null) {
                          delete existing.metadata[k];
                        } else {
                          existing.metadata[k] = v;
                        }
                      }
                    }
                    existing.turnIndex = turnIndex;
                    existing.lineIndex = msg.lineIndex;
                  } else if (input.status !== 'deleted') {
                    // Only create placeholder for non-delete updates
                    // (deleted tasks that weren't created in this session are skipped)
                    updated.tasks.push({
                      id: taskId,
                      subject: input.subject || `Task #${taskId}`,
                      description: input.description,
                      activeForm: input.activeForm,
                      status: input.status || 'pending',
                      blocks: input.addBlocks || [],
                      blockedBy: input.addBlockedBy || [],
                      owner: input.owner,
                      metadata: input.metadata,
                      turnIndex,
                      lineIndex: msg.lineIndex,
                    });
                  }
                }
              }

              // Extract EnterPlanMode
              if (block.name === 'EnterPlanMode') {
                updated.plans.push({
                  toolUseId: block.id,
                  status: 'entering',
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
              }

              // Extract ExitPlanMode
              if (block.name === 'ExitPlanMode' && block.input) {
                const input = block.input;
                const planContent: string = input.plan || '';
                // Extract title from first markdown heading
                const titleMatch = planContent.match(/^#\s+(.+)/m);
                const planTitle = titleMatch ? titleMatch[1].trim() : undefined;
                // First 300 chars as summary
                const planSummary = planContent.length > 300
                  ? planContent.slice(0, 300) + '...'
                  : planContent || undefined;

                // Check if a pending planFile was captured from a Write call earlier
                const pendingFile = (updated as any)._pendingPlanFile;

                updated.plans.push({
                  toolUseId: block.id,
                  status: 'approved',
                  planFile: pendingFile,
                  planTitle,
                  planSummary,
                  allowedPrompts: input.allowedPrompts,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });

                delete (updated as any)._pendingPlanFile;
              }

              // Detect Write/Edit tool calls to ~/.claude/plans/ and capture planFile
              if ((block.name === 'Write' || block.name === 'Edit') && block.input) {
                const filePath: string = block.input.file_path || '';
                const planMatch = filePath.match(/\.claude\/plans\/([^\s/]+\.md)$/);
                if (planMatch) {
                  const planFileName = planMatch[1];
                  // Try to attach to existing approved plan without a file
                  let attached = false;
                  for (let pi = updated.plans.length - 1; pi >= 0; pi--) {
                    if (updated.plans[pi].status === 'approved' && !updated.plans[pi].planFile) {
                      updated.plans[pi].planFile = planFileName;
                      attached = true;
                      break;
                    }
                  }
                  // If no plan yet, hold it for the next ExitPlanMode
                  if (!attached) {
                    (updated as any)._pendingPlanFile = planFileName;
                  }
                }
              }

              // Extract Task tool calls (subagents)
              if (block.name === 'Task' && block.input) {
                const input = block.input;
                updated.subagents.push({
                  agentId: '',
                  toolUseId: block.id,
                  type: input.subagent_type || input.type || 'general-purpose',
                  prompt: input.prompt || '',
                  description: input.description,
                  model: input.model,
                  // Parent session indices
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  userPromptIndex: Math.max(0, updated.userPrompts.length - 1),
                  // Status
                  startedAt: msg.timestamp,
                  status: 'pending',
                  runInBackground: input.run_in_background,
                });
              }

              // Extract Teammate tool calls (team operations)
              if (block.name === 'Teammate' && block.input) {
                const input = block.input;
                const op = (input.operation || 'spawnTeam') as 'spawnTeam' | 'cleanup';
                updated.teamOperations.push({
                  operation: op,
                  teamName: input.team_name,
                  description: input.description,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
                // Populate allTeams from spawnTeam operations
                if (op === 'spawnTeam' && input.team_name) {
                  if (!updated.allTeams.includes(input.team_name)) {
                    updated.allTeams.push(input.team_name);
                  }
                }
              }

              // Extract SendMessage tool calls (team messages)
              if (block.name === 'SendMessage' && block.input) {
                const input = block.input;
                updated.teamMessages.push({
                  messageType: (input.type || 'message') as 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response',
                  recipient: input.recipient,
                  content: input.content,
                  summary: input.summary,
                  requestId: input.request_id,
                  approve: input.approve,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
              }
            }

            if (block.type === 'thinking' && block.thinking) {
              updated.thinkingBlocks.push({
                turnIndex,
                lineIndex: msg.lineIndex,
                thinking: block.thinking,
              });
            }
          }
        }

        // Update usage
        if (msg.message?.usage) {
          const u = msg.message.usage;
          updated.usage.inputTokens += u.input_tokens || 0;
          updated.usage.outputTokens += u.output_tokens || 0;
          updated.usage.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
          updated.usage.cacheReadInputTokens += u.cache_read_input_tokens || 0;
        }
      }

      // Result message
      if (msg.type === 'result') {
        updated.result = msg.result;
        if (msg.subtype === 'error' || msg.error) {
          updated.errors = updated.errors || [];
          updated.errors.push(msg.error || msg.result || 'Unknown error');
        }
        updated.success = msg.subtype === 'success';
        if (msg.duration_ms) updated.durationMs = msg.duration_ms;
        if (msg.duration_api_ms) updated.durationApiMs = msg.duration_api_ms;
        if (msg.total_cost_usd) updated.totalCostUsd = msg.total_cost_usd;
        if (msg.usage) {
          updated.usage = {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
            cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
          };
        }
      }

      // Progress message - update subagent agentId and parentUuid from agent_progress
      if (msg.type === 'progress' && msg.data?.type === 'agent_progress' && msg.data.agentId) {
        const agentId = msg.data.agentId;
        const parentToolUseId = msg.parentToolUseID;
        const parentUuid = msg.parentUuid;
        if (parentToolUseId) {
          const subagent = updated.subagents.find(s => s.toolUseId === parentToolUseId);
          if (subagent && !subagent.agentId) {
            subagent.agentId = agentId;
            subagent.status = 'running';
            if (parentUuid) {
              subagent.parentUuid = parentUuid;
            }
          }
        }
      }
    }

    updated.lastLineIndex = newMessages.length > 0
      ? newMessages[newMessages.length - 1].lineIndex
      : cache.lastLineIndex;
    updated.lastTurnIndex = turnIndex;
    updated.lastTimestamp = lastTimestamp;
    updated.numTurns = turnIndex;

    return updated;
  }

  /**
   * Create initial cache from full file parse
   */
  private async createInitialCache(
    sessionPath: string,
    stats: fs.Stats
  ): Promise<SessionCacheData> {
    const messages: Array<any & { lineIndex: number }> = [];

    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineIndex = 0;
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex });
        } catch {
          // Skip invalid JSON
        }
      }
      lineIndex++;
    }

    // Create empty cache structure
    const cache: SessionCacheData = {
      version: CACHE_VERSION,
      sessionId: '',
      filePath: sessionPath,
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: -1,
      lastTurnIndex: 0,
      lastByteOffset: stats.size, // Full file was read, so offset = file size
      createdAt: Date.now(),

      cwd: '',
      model: '',
      claudeCodeVersion: '',
      permissionMode: '',
      tools: [],
      mcpServers: [],

      userPrompts: [],
      toolUses: [],
      responses: [],
      thinkingBlocks: [],

      tasks: [],
      todos: [],
      subagents: [],
      subagentProgress: [],
      plans: [],

      allTeams: [],
      teamOperations: [],
      teamMessages: [],

      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
      totalCostUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },

      success: false,
    };

    // Merge all messages into cache
    return this.mergeNewMessages(cache, messages, stats);
  }

  /**
   * Get session data from LMDB cache only (no parsing).
   * Returns null if not cached. Used by delta fast path to avoid
   * triggering expensive incremental parsing.
   */
  getSessionDataFromMemory(sessionPath: string): SessionCacheData | null {
    return this.store.getSessionData(sessionPath) || null;
  }

  async getSessionData(sessionPath: string): Promise<SessionCacheData | null> {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    // Single lookup from LMDB (sync, ~0ms via mmap)
    let cache = this.store.getSessionData(sessionPath);

    const validity = this.isCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache;
    }

    if (validity === 'append' && cache) {
      // File grew - incremental update
      const { newMessages, lastLineIndex, lastTurnIndex, lastByteOffset } = await this.parseNewLines(
        sessionPath,
        cache.lastLineIndex,
        cache.lastTurnIndex,
        cache
      );

      if (newMessages.length > 0) {
        cache = this.mergeNewMessages(cache, newMessages, stats);
        cache.lastLineIndex = lastLineIndex;
        cache.lastTurnIndex = lastTurnIndex;
        cache.lastByteOffset = lastByteOffset;

        // Write to LMDB (async, auto-batched)
        await this.store.putSessionData(sessionPath, cache);
        this.fireOnChange(cache);
      } else {
        // No new messages but update byte offset for next seek
        cache.lastByteOffset = lastByteOffset;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();
        await this.store.putSessionData(sessionPath, cache);
      }

      return cache;
    }

    // Invalid or no cache - full reparse
    console.log(`[SessionCache] Full parse required for ${path.basename(sessionPath)}`);
    const startTime = Date.now();

    cache = await this.createInitialCache(sessionPath, stats);

    console.log(`[SessionCache] Parsed ${cache.lastLineIndex + 1} lines in ${Date.now() - startTime}ms`);

    // Save to LMDB
    await this.store.putSessionData(sessionPath, cache);
    this.fireOnChange(cache);

    return cache;
  }

  /**
   * Get raw messages (separate cache for large data)
   */
  async getRawMessages(sessionPath: string): Promise<Array<any & { lineIndex: number }> | null> {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    // Single lookup from LMDB (sync, ~0ms via mmap)
    let cache = this.store.getRawMessages(sessionPath);

    // Check validity using same logic as getSessionData
    const validity = this.isRawCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache.messages;
    }

    if (validity === 'append' && cache) {
      // File grew (append-only) - incremental update with byte offset seeking
      const { messages: newMessages, lastByteOffset } = await this.parseRawNewLines(
        sessionPath, cache.lastLineIndex, cache.lastByteOffset
      );

      if (newMessages.length > 0) {
        cache.messages.push(...newMessages);
        cache.lastLineIndex = newMessages[newMessages.length - 1].lineIndex;
        cache.lastByteOffset = lastByteOffset;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();

        // Write to LMDB (async, auto-batched)
        await this.store.putRawMessages(sessionPath, cache);
      } else {
        cache.lastByteOffset = lastByteOffset;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();
        await this.store.putRawMessages(sessionPath, cache);
      }

      return cache.messages;
    }

    // Full reparse needed
    const messages: Array<any & { lineIndex: number }> = [];

    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineIndex = 0;
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex });
        } catch {
          // Skip invalid JSON
        }
      }
      lineIndex++;
    }

    // Save to LMDB
    const rawCache: RawMessagesCache = {
      version: CACHE_VERSION,
      sessionId: path.basename(sessionPath, '.jsonl'),
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: lineIndex - 1,
      lastByteOffset: stats.size,
      messages,
    };

    await this.store.putRawMessages(sessionPath, rawCache);

    return messages;
  }

  /**
   * Check if raw cache is valid for the given file stats
   */
  private isRawCacheValid(cache: RawMessagesCache | null, stats: fs.Stats): 'valid' | 'append' | 'invalid' {
    if (!cache) return 'invalid';

    // Version mismatch — force full reparse
    if (cache.version !== CACHE_VERSION) return 'invalid';

    const fileMtime = stats.mtime.getTime();
    const fileSize = stats.size;

    // File was replaced or truncated
    if (fileSize < cache.fileSize) return 'invalid';

    // File mtime is older than cache (shouldn't happen)
    if (fileMtime < cache.fileMtime) return 'invalid';

    // Exact match
    if (fileSize === cache.fileSize && fileMtime === cache.fileMtime) return 'valid';

    // File grew (append-only)
    if (fileSize > cache.fileSize) return 'append';

    return 'invalid';
  }

  /**
   * Parse new raw lines from a session file starting after lastLineIndex
   */
  private async parseRawNewLines(
    sessionPath: string,
    startLineIndex: number,
    lastByteOffset?: number
  ): Promise<{ messages: Array<any & { lineIndex: number }>; lastByteOffset: number }> {
    const newMessages: Array<any & { lineIndex: number }> = [];
    let lineIndex: number;
    let byteOffset: number;

    if (lastByteOffset && lastByteOffset > 0) {
      // Fast path: seek directly to new content
      const fileStream = fs.createReadStream(sessionPath, { start: lastByteOffset });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = startLineIndex + 1;
      byteOffset = lastByteOffset;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    } else {
      // Fallback: read from beginning
      const fileStream = fs.createReadStream(sessionPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = 0;
      byteOffset = 0;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (lineIndex > startLineIndex && line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    }

    return { messages: newMessages, lastByteOffset: byteOffset };
  }

  /**
   * Clear cache for a session
   */
  clearCache(sessionPath: string): void {
    this.store.clear(sessionPath).catch(() => {});
  }

  /**
   * Clear all caches
   */
  clearAllCaches(): void {
    this.store.clear().catch(() => {});
  }

  /**
   * Compact the LMDB database to reclaim disk space.
   * Stops file watcher, deletes the data file, reopens, restarts watcher.
   * All cached data is lost and will be lazily reparsed on next access.
   */
  async compactCache(): Promise<{ beforeSize: number; afterSize: number }> {
    // Stop watcher during compaction
    const wasWatching = this.isWatching;
    const watchedPaths = [...this.watchedPaths];
    if (wasWatching) {
      this.stopWatching();
    }

    const result = await this.store.compact();

    // Restart watcher
    if (wasWatching) {
      this.startWatching(watchedPaths.length > 0 ? watchedPaths : undefined);
    }

    return result;
  }

  /**
   * Get cached session data synchronously.
   * Uses LMDB cache (sync read via mmap), falls back to full parse if needed.
   * Note: On cache miss or invalidation, the LMDB write is fire-and-forget
   * since LMDB writes are async but the parse itself is synchronous.
   */
  getSessionDataSync(sessionPath: string): SessionCacheData | null {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    // Single lookup from LMDB (sync, ~0ms via mmap)
    let cache = this.store.getSessionData(sessionPath);

    const validity = this.isCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache;
    }

    if (validity === 'append' && cache) {
      // File grew - incremental update (sync version)
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.split('\n');
      const newMessages: Array<any & { lineIndex: number }> = [];
      let turnIndex = cache.lastTurnIndex;

      for (let lineIndex = cache.lastLineIndex + 1; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
            if (msg.type === 'assistant') {
              turnIndex++;
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }

      if (newMessages.length > 0) {
        cache = this.mergeNewMessages(cache, newMessages, stats);
        cache.lastLineIndex = lines.length - 1;
        cache.lastTurnIndex = turnIndex;

        // Fire-and-forget async write to LMDB
        this.store.putSessionData(sessionPath, cache).catch(() => {});
      }

      return cache;
    }

    // Invalid or no cache - full reparse (sync)
    console.log(`[SessionCache] Full parse (sync) required for ${path.basename(sessionPath)}`);
    const startTime = Date.now();

    const content = fs.readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n');
    const messages: Array<any & { lineIndex: number }> = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex });
        } catch {
          // Skip invalid JSON
        }
      }
    }

    // Create empty cache structure
    cache = {
      version: CACHE_VERSION,
      sessionId: '',
      filePath: sessionPath,
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: -1,
      lastTurnIndex: 0,
      createdAt: Date.now(),

      cwd: '',
      model: '',
      claudeCodeVersion: '',
      permissionMode: '',
      tools: [],
      mcpServers: [],

      userPrompts: [],
      toolUses: [],
      responses: [],
      thinkingBlocks: [],

      tasks: [],
      todos: [],
      subagents: [],
      subagentProgress: [],
      plans: [],

      allTeams: [],
      teamOperations: [],
      teamMessages: [],

      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
      totalCostUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },

      success: false,
    };

    // Merge all messages into cache
    cache = this.mergeNewMessages(cache, messages, stats);

    console.log(`[SessionCache] Parsed (sync) ${cache.lastLineIndex + 1} lines in ${Date.now() - startTime}ms`);

    // Fire-and-forget async write to LMDB
    this.store.putSessionData(sessionPath, cache).catch(() => {});

    return cache;
  }

  /**
   * Get raw messages synchronously (separate cache for large data)
   */
  getRawMessagesSync(sessionPath: string): Array<any & { lineIndex: number }> | null {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    // Single lookup from LMDB (sync, ~0ms via mmap)
    let cache = this.store.getRawMessages(sessionPath);

    const validity = this.isRawCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache.messages;
    }

    if (validity === 'append' && cache) {
      // File grew (append-only) - incremental update
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.split('\n');
      const newMessages: Array<any & { lineIndex: number }> = [];

      for (let lineIndex = cache.lastLineIndex + 1; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
          } catch {
            // Skip invalid JSON
          }
        }
      }

      if (newMessages.length > 0) {
        cache.messages.push(...newMessages);
        cache.lastLineIndex = lines.length - 1;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();

        // Fire-and-forget async write to LMDB
        this.store.putRawMessages(sessionPath, cache).catch(() => {});
      }

      return cache.messages;
    }

    // Full reparse needed
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n');
    const messages: Array<any & { lineIndex: number }> = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex });
        } catch {
          // Skip invalid JSON
        }
      }
    }

    // Save to LMDB (fire-and-forget)
    const rawCache: RawMessagesCache = {
      version: CACHE_VERSION,
      sessionId: path.basename(sessionPath, '.jsonl'),
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: lines.length - 1,
      messages,
    };

    this.store.putRawMessages(sessionPath, rawCache).catch(() => {});

    return messages;
  }

  /**
   * Get all cached sessions (across all projects), excluding subagent sessions.
   * Iterates LMDB store — instant, no disk reads or parsing.
   */
  getAllSessionsFromCache(): Array<{
    sessionId: string;
    filePath: string;
    cacheData: SessionCacheData;
  }> {
    const results: Array<{ sessionId: string; filePath: string; cacheData: SessionCacheData }> = [];
    for (const { key: filePath, value: cacheData } of this.store.allSessions()) {
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      if (normalizedFilePath.includes('/subagents/')) continue;
      const sessionId = path.basename(filePath, '.jsonl');
      if (sessionId.startsWith('agent-')) continue;
      results.push({ sessionId, filePath, cacheData });
    }
    return results;
  }

  /**
   * Get all cached sessions for a project (fast, LMDB-backed)
   * Returns sessions in cache for the given project path
   */
  getProjectSessionsFromCache(projectPath: string): Array<{
    sessionId: string;
    filePath: string;
    cacheData: SessionCacheData;
  }> {
    const projectKey = legacyEncodeProjectPath(projectPath);
    const results: Array<{
      sessionId: string;
      filePath: string;
      cacheData: SessionCacheData;
    }> = [];

    for (const { key: filePath, value: cacheData } of this.store.allSessions()) {
      // Check if this session belongs to the project (normalize separators for cross-platform)
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      if (normalizedFilePath.includes(`/projects/${projectKey}/`) && !normalizedFilePath.includes('/subagents/')) {
        const sessionId = path.basename(filePath, '.jsonl');
        // Skip agent files
        if (!sessionId.startsWith('agent-')) {
          results.push({ sessionId, filePath, cacheData });
        }
      }
    }

    return results;
  }

  /**
   * Check if a project's sessions are fully cached
   */
  isProjectCached(projectPath: string): boolean {
    const projectKey = legacyEncodeProjectPath(projectPath);
    const projectsDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

    if (!fs.existsSync(projectsDir)) return true;

    const files = fs.readdirSync(projectsDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

    for (const file of files) {
      const filePath = path.join(projectsDir, file);
      if (!this.store.getSessionData(filePath)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get cache stats
   */
  getStats(): { memoryCacheSize: number; diskCacheCount: number; diskCacheSize: number } {
    return {
      memoryCacheSize: this.store.sessionCount + this.store.rawCount,
      diskCacheCount: this.store.sessionCount + this.store.rawCount,
      diskCacheSize: 0, // LMDB manages its own file; size is dynamic via mmap
    };
  }

  /**
   * Close the LMDB store. Call on server shutdown.
   */
  close(): void {
    this.store.close();
  }
}

// Singleton instance
let sessionCacheInstance: SessionCache | null = null;

export function getSessionCache(): SessionCache {
  if (!sessionCacheInstance) {
    const profiler = getStartupProfiler();
    profiler.start('sessionCache', 'SessionCache');
    sessionCacheInstance = new SessionCache();
    // Auto-start watching for file changes
    profiler.start('sessionCacheWatcher', 'File Watcher', 'SessionCache');
    sessionCacheInstance.startWatching();
    profiler.end('sessionCacheWatcher');
    // No background warming needed — LMDB provides instant reads via mmap.
    // Cache entries are created on-demand as sessions are accessed.
    profiler.end('sessionCache');
    const lmdbMs = profiler.get('lmdbOpen')?.toFixed(1) ?? '?';
    const watchMs = profiler.get('sessionCacheWatcher')?.toFixed(1) ?? '?';
    console.log(`[SessionCache] LMDB-backed cache initialized (lmdb: ${lmdbMs}ms, watcher: ${watchMs}ms)`);
  }
  return sessionCacheInstance;
}

/**
 * Initialize cache for a specific project.
 * With LMDB, there's no warmup — entries are created on-demand.
 * warmProjectCache still ensures all JSONL files have been parsed into LMDB at least once.
 */
export async function initSessionCache(projectPath?: string): Promise<{
  warmed: number;
  errors: number;
  stats: ReturnType<SessionCache['getCacheStats']>;
}> {
  const cache = getSessionCache();

  let warmed = 0;
  let errors = 0;

  if (projectPath) {
    const result = await cache.warmProjectCache(projectPath);
    warmed = result.warmed;
    errors = result.errors;
  }

  return {
    warmed,
    errors,
    stats: cache.getCacheStats(),
  };
}

/**
 * Stop the cache watcher and close LMDB (for cleanup)
 */
export function stopSessionCache(): void {
  if (sessionCacheInstance) {
    sessionCacheInstance.stopWatching();
    sessionCacheInstance.close();
  }
}

/**
 * No-op — warming is not needed with LMDB.
 * @deprecated Kept for backward compatibility.
 */
export function startBackgroundWarming(_options?: {
  concurrency?: number;
  batchSize?: number;
  delayBetweenBatches?: number;
}): void {
  // No-op — LMDB provides instant reads
}

/**
 * No-op — warming is not needed with LMDB.
 * @deprecated Kept for backward compatibility.
 */
export function stopBackgroundWarming(): void {
  // No-op
}

export default SessionCache;
