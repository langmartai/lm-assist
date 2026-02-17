/**
 * Hook Event Store
 *
 * Read-only store that watches the Claude Code hook events log file
 * (~/.claude/hook-events.jsonl) for new events.
 *
 * Key principles:
 * - HookEventStore is READ-ONLY (hooks append to the file)
 * - Append-only JSONL format for efficient tail-based watching
 * - Incremental reading via line offset tracking
 * - Query APIs for filtering by session, hook type, tool, time range
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import * as chokidar from 'chokidar';
import { getStartupProfiler } from './startup-profiler';

// ============================================================================
// Types
// ============================================================================

/**
 * Hook event as stored in JSONL
 */
export interface HookEvent {
  /** Unix timestamp in milliseconds */
  ts: number;
  /** Session ID */
  sid: string;
  /** Claude Code process ID */
  pid: number;
  /** Hook type */
  hook: HookType;
  /** Event type (derived from hook) */
  event: string;
  /** Target category */
  target?: string;
  /** Tool name */
  tool?: string;
  /** Tool use ID (links Pre/Post events) */
  tuid?: string;
  /** Subagent ID */
  agentId?: string;
  /** Subagent type */
  agentType?: string;
  /** Success/failure */
  ok: boolean;
  /** Decision made by hook */
  decision?: string;
  /** Error message if failed */
  err?: string;
}

/**
 * Hook event with transaction ID (assigned by store for delta sync)
 */
export interface HookEventWithTid extends HookEvent {
  /** Transaction ID - monotonically increasing, assigned by store */
  tid: number;
}

/**
 * All 12 Claude Code hook types
 */
export type HookType =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PermissionRequest'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'PreCompact';

/**
 * Hook event store configuration
 */
export interface HookEventStoreConfig {
  /** Path to hook events file (default: ~/.claude/hook-events.jsonl) */
  eventsFilePath?: string;
  /** Enable file watching (default: true) */
  watchEnabled?: boolean;
  /** Watch debounce interval in ms (default: 100) */
  watchDebounceMs?: number;
  /** Max events to keep in memory (default: 10000, 0 = unlimited) */
  maxEvents?: number;
  /** Auto-prune old events older than this (ms, default: 0 = never) */
  pruneOlderThanMs?: number;
}

/**
 * Query options for filtering events
 */
export interface HookEventQuery {
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by process ID */
  pid?: number;
  /** Filter by hook type(s) */
  hookTypes?: HookType[];
  /** Filter by tool name(s) */
  tools?: string[];
  /** Filter by tool use ID */
  toolUseId?: string;
  /** Filter by target type */
  target?: string;
  /** Filter by success/failure */
  ok?: boolean;
  /** Start time (inclusive) */
  startTime?: Date | number;
  /** End time (inclusive) */
  endTime?: Date | number;
  /** Get events after this transaction ID (exclusive) for delta sync */
  afterTid?: number;
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order (default: 'desc' = newest first) */
  order?: 'asc' | 'desc';
}

/**
 * Delta response for incremental sync
 */
export interface HookEventDeltaResponse {
  /** Events since the requested tid */
  events: HookEventWithTid[];
  /** Number of events returned */
  count: number;
  /** Last tid in this response (use for next delta request) */
  lastTid: number;
  /** Whether there are more events (hit limit) */
  hasMore: boolean;
}

/**
 * Session summary with event counts
 */
export interface SessionEventSummary {
  /** Session ID */
  sessionId: string;
  /** Process ID */
  pid: number;
  /** First event timestamp */
  startTime: Date;
  /** Last event timestamp */
  endTime: Date;
  /** Total event count */
  totalEvents: number;
  /** Event counts by hook type */
  hookCounts: Partial<Record<HookType, number>>;
  /** Tool usage counts */
  toolCounts: Record<string, number>;
  /** Whether session has errors */
  hasErrors: boolean;
  /** Error count */
  errorCount: number;
}

/**
 * Store statistics
 */
export interface HookEventStoreStats {
  /** Total events in store */
  totalEvents: number;
  /** Unique sessions */
  uniqueSessions: number;
  /** Events by hook type */
  hookTypeCounts: Partial<Record<HookType, number>>;
  /** Oldest event timestamp */
  oldestEvent?: Date;
  /** Newest event timestamp */
  newestEvent?: Date;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Last file modified time */
  lastModified?: Date;
  /** Last transaction ID (for delta sync) */
  lastTid: number;
}

/**
 * Hook event store event types
 */
export interface HookEventStoreEvents {
  'event:new': (event: HookEventWithTid) => void;
  'event:batch': (events: HookEventWithTid[]) => void;
  'session:start': (sessionId: string, event: HookEventWithTid) => void;
  'session:end': (sessionId: string, event: HookEventWithTid) => void;
  'error': (error: Error) => void;
  'refresh': () => void;
}

// ============================================================================
// Hook Event Store Implementation
// ============================================================================

export class HookEventStore extends EventEmitter {
  private config: Required<HookEventStoreConfig>;
  private events: HookEventWithTid[] = [];
  private eventIndex: Map<string, HookEventWithTid[]> = new Map(); // sessionId -> events
  private toolUseIndex: Map<string, HookEventWithTid[]> = new Map(); // tuid -> events
  private tidIndex: Map<number, HookEventWithTid> = new Map(); // tid -> event (for fast lookup)
  private watcher: chokidar.FSWatcher | null = null;
  private lastReadOffset = 0;
  private lastFileSize = 0;
  private isInitialized = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private nextTid = 1; // Monotonically increasing transaction ID

  constructor(config: HookEventStoreConfig = {}) {
    super();
    this.config = {
      eventsFilePath: config.eventsFilePath || path.join(os.homedir(), '.claude', 'hook-events.jsonl'),
      watchEnabled: config.watchEnabled ?? true,
      watchDebounceMs: config.watchDebounceMs ?? 100,
      maxEvents: config.maxEvents ?? 10000,
      pruneOlderThanMs: config.pruneOlderThanMs ?? 0,
    };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Initialize the store - load existing events and start watching
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    const profiler = getStartupProfiler();

    // Load existing events
    profiler.start('hookEventsLoad', 'Load Events (async)', 'HookEventStore');
    await this.loadEvents();
    const loadMs = profiler.end('hookEventsLoad');
    console.log(`[HookEventStore] Loaded ${this.events.length} events in ${loadMs.toFixed(1)}ms`);

    // Start file watching if enabled
    if (this.config.watchEnabled) {
      this.startWatching();
    }

    this.isInitialized = true;
  }

  /**
   * Dispose the store - stop watching and clear data
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.events = [];
    this.eventIndex.clear();
    this.toolUseIndex.clear();
    this.tidIndex.clear();
    this.nextTid = 1;
    this.isInitialized = false;
  }

  // --------------------------------------------------------------------------
  // File Reading
  // --------------------------------------------------------------------------

  /**
   * Load all events from the file
   */
  private async loadEvents(): Promise<void> {
    const filePath = this.config.eventsFilePath;

    if (!fs.existsSync(filePath)) {
      return;
    }

    const stats = fs.statSync(filePath);
    this.lastFileSize = stats.size;

    const newEvents: HookEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream });
      let lineNumber = 0;

      rl.on('line', (line) => {
        lineNumber++;
        if (line.trim()) {
          try {
            const event = JSON.parse(line) as HookEvent;
            newEvents.push(event);
          } catch (err) {
            // Skip malformed lines
          }
        }
      });

      rl.on('close', () => {
        this.lastReadOffset = lineNumber;
        resolve();
      });

      rl.on('error', reject);
    });

    // Add events and update indices (assign tids)
    for (const event of newEvents) {
      this.addEventToStore(event, false);
    }

    // Prune if needed
    this.pruneIfNeeded();

    this.emit('refresh');
  }

  /**
   * Read new events since last read (incremental)
   */
  private async readNewEvents(): Promise<HookEventWithTid[]> {
    const filePath = this.config.eventsFilePath;

    if (!fs.existsSync(filePath)) {
      return [];
    }

    const stats = fs.statSync(filePath);

    // File was truncated or replaced - reload from beginning
    if (stats.size < this.lastFileSize) {
      this.events = [];
      this.eventIndex.clear();
      this.toolUseIndex.clear();
      this.tidIndex.clear();
      this.lastReadOffset = 0;
      this.lastFileSize = 0;
      this.nextTid = 1;
      await this.loadEvents();
      return this.events;
    }

    // No new data
    if (stats.size === this.lastFileSize) {
      return [];
    }

    this.lastFileSize = stats.size;

    const newEvents: HookEvent[] = [];
    let currentLine = 0;

    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream });

      rl.on('line', (line) => {
        currentLine++;
        // Skip already-read lines
        if (currentLine <= this.lastReadOffset) {
          return;
        }
        if (line.trim()) {
          try {
            const event = JSON.parse(line) as HookEvent;
            newEvents.push(event);
          } catch (err) {
            // Skip malformed lines
          }
        }
      });

      rl.on('close', () => {
        this.lastReadOffset = currentLine;
        resolve();
      });

      rl.on('error', reject);
    });

    // Add new events to store and collect events with tids
    const eventsWithTids: HookEventWithTid[] = [];
    for (const event of newEvents) {
      const eventWithTid = this.addEventToStore(event, true);
      eventsWithTids.push(eventWithTid);
    }

    // Prune if needed
    this.pruneIfNeeded();

    if (eventsWithTids.length > 0) {
      this.emit('event:batch', eventsWithTids);
    }

    return eventsWithTids;
  }

  /**
   * Add an event to the store and update indices
   * @returns The event with assigned tid
   */
  private addEventToStore(event: HookEvent, emitNew: boolean): HookEventWithTid {
    // Assign tid to the event
    const eventWithTid: HookEventWithTid = {
      ...event,
      tid: this.nextTid++,
    };

    this.events.push(eventWithTid);

    // Update tid index for fast lookup
    this.tidIndex.set(eventWithTid.tid, eventWithTid);

    // Update session index
    const sessionEvents = this.eventIndex.get(eventWithTid.sid) || [];
    sessionEvents.push(eventWithTid);
    this.eventIndex.set(eventWithTid.sid, sessionEvents);

    // Update tool use index
    if (eventWithTid.tuid) {
      const tuidEvents = this.toolUseIndex.get(eventWithTid.tuid) || [];
      tuidEvents.push(eventWithTid);
      this.toolUseIndex.set(eventWithTid.tuid, tuidEvents);
    }

    if (emitNew) {
      this.emit('event:new', eventWithTid);

      // Emit session start/end
      if (eventWithTid.hook === 'SessionStart') {
        this.emit('session:start', eventWithTid.sid, eventWithTid);
      } else if (eventWithTid.hook === 'SessionEnd') {
        this.emit('session:end', eventWithTid.sid, eventWithTid);
      }
    }

    return eventWithTid;
  }

  /**
   * Prune old events if limits are exceeded
   */
  private pruneIfNeeded(): void {
    // Prune by count
    if (this.config.maxEvents > 0 && this.events.length > this.config.maxEvents) {
      const removeCount = this.events.length - this.config.maxEvents;
      const removed = this.events.splice(0, removeCount);

      // Rebuild indices for removed events
      for (const event of removed) {
        // Remove from tid index
        this.tidIndex.delete(event.tid);

        const sessionEvents = this.eventIndex.get(event.sid);
        if (sessionEvents) {
          const idx = sessionEvents.indexOf(event);
          if (idx >= 0) sessionEvents.splice(idx, 1);
          if (sessionEvents.length === 0) this.eventIndex.delete(event.sid);
        }
        if (event.tuid) {
          const tuidEvents = this.toolUseIndex.get(event.tuid);
          if (tuidEvents) {
            const idx = tuidEvents.indexOf(event);
            if (idx >= 0) tuidEvents.splice(idx, 1);
            if (tuidEvents.length === 0) this.toolUseIndex.delete(event.tuid);
          }
        }
      }
    }

    // Prune by age
    if (this.config.pruneOlderThanMs > 0) {
      const cutoff = Date.now() - this.config.pruneOlderThanMs;
      const originalLength = this.events.length;

      this.events = this.events.filter((e) => e.ts >= cutoff);

      if (this.events.length < originalLength) {
        // Rebuild indices
        this.rebuildIndices();
      }
    }
  }

  /**
   * Rebuild indices from events array
   */
  private rebuildIndices(): void {
    this.eventIndex.clear();
    this.toolUseIndex.clear();
    this.tidIndex.clear();

    for (const event of this.events) {
      // Rebuild tid index
      this.tidIndex.set(event.tid, event);

      const sessionEvents = this.eventIndex.get(event.sid) || [];
      sessionEvents.push(event);
      this.eventIndex.set(event.sid, sessionEvents);

      if (event.tuid) {
        const tuidEvents = this.toolUseIndex.get(event.tuid) || [];
        tuidEvents.push(event);
        this.toolUseIndex.set(event.tuid, tuidEvents);
      }
    }
  }

  // --------------------------------------------------------------------------
  // File Watching
  // --------------------------------------------------------------------------

  /**
   * Start watching the events file for changes
   */
  private startWatching(): void {
    const filePath = this.config.eventsFilePath;
    const dir = path.dirname(filePath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.watchDebounceMs,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', () => {
      this.handleFileChange();
    });

    this.watcher.on('add', () => {
      this.handleFileChange();
    });

    this.watcher.on('error', (error) => {
      this.emit('error', error);
    });
  }

  /**
   * Handle file change with debouncing
   */
  private handleFileChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        await this.readNewEvents();
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }, this.config.watchDebounceMs);
  }

  // --------------------------------------------------------------------------
  // Query APIs
  // --------------------------------------------------------------------------

  /**
   * Query events with filters
   */
  query(options: HookEventQuery = {}): HookEventWithTid[] {
    let results = [...this.events];

    // Filter by afterTid (for delta sync) - efficient since events are ordered by tid
    if (options.afterTid !== undefined) {
      results = results.filter((e) => e.tid > options.afterTid!);
    }

    // Filter by session
    if (options.sessionId) {
      const sessionEvents = this.eventIndex.get(options.sessionId) || [];
      if (options.afterTid !== undefined) {
        // If we already filtered by afterTid, intersect with session events
        const sessionTids = new Set(sessionEvents.map((e) => e.tid));
        results = results.filter((e) => sessionTids.has(e.tid));
      } else {
        results = [...sessionEvents];
      }
    }

    // Filter by tool use ID
    if (options.toolUseId) {
      const tuidEvents = this.toolUseIndex.get(options.toolUseId) || [];
      if (options.afterTid !== undefined || options.sessionId) {
        const tuidTids = new Set(tuidEvents.map((e) => e.tid));
        results = results.filter((e) => tuidTids.has(e.tid));
      } else {
        results = [...tuidEvents];
      }
    }

    // Filter by PID
    if (options.pid !== undefined) {
      results = results.filter((e) => e.pid === options.pid);
    }

    // Filter by hook types
    if (options.hookTypes && options.hookTypes.length > 0) {
      const types = new Set(options.hookTypes);
      results = results.filter((e) => types.has(e.hook));
    }

    // Filter by tools
    if (options.tools && options.tools.length > 0) {
      const tools = new Set(options.tools);
      results = results.filter((e) => e.tool && tools.has(e.tool));
    }

    // Filter by target
    if (options.target) {
      results = results.filter((e) => e.target === options.target);
    }

    // Filter by success/failure
    if (options.ok !== undefined) {
      results = results.filter((e) => e.ok === options.ok);
    }

    // Filter by time range
    if (options.startTime) {
      const startTs = typeof options.startTime === 'number' ? options.startTime : options.startTime.getTime();
      results = results.filter((e) => e.ts >= startTs);
    }
    if (options.endTime) {
      const endTs = typeof options.endTime === 'number' ? options.endTime : options.endTime.getTime();
      results = results.filter((e) => e.ts <= endTs);
    }

    // Sort
    if (options.order === 'asc') {
      results.sort((a, b) => a.ts - b.ts);
    } else {
      results.sort((a, b) => b.ts - a.ts);
    }

    // Pagination
    if (options.offset) {
      results = results.slice(options.offset);
    }
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Get all events for a session
   */
  getSessionEvents(sessionId: string): HookEventWithTid[] {
    return [...(this.eventIndex.get(sessionId) || [])];
  }

  /**
   * Get events by tool use ID (links PreToolUse/PostToolUse)
   */
  getToolUseEvents(toolUseId: string): HookEventWithTid[] {
    return [...(this.toolUseIndex.get(toolUseId) || [])];
  }

  /**
   * Get session summary
   */
  getSessionSummary(sessionId: string): SessionEventSummary | null {
    const events = this.eventIndex.get(sessionId);
    if (!events || events.length === 0) return null;

    const hookCounts: Partial<Record<HookType, number>> = {};
    const toolCounts: Record<string, number> = {};
    let errorCount = 0;
    let pid = 0;

    for (const event of events) {
      hookCounts[event.hook] = (hookCounts[event.hook] || 0) + 1;
      if (event.tool) {
        toolCounts[event.tool] = (toolCounts[event.tool] || 0) + 1;
      }
      if (!event.ok || event.err) {
        errorCount++;
      }
      if (event.pid) {
        pid = event.pid;
      }
    }

    return {
      sessionId,
      pid,
      startTime: new Date(events[0].ts),
      endTime: new Date(events[events.length - 1].ts),
      totalEvents: events.length,
      hookCounts,
      toolCounts,
      hasErrors: errorCount > 0,
      errorCount,
    };
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.eventIndex.keys());
  }

  /**
   * Get store statistics
   */
  getStats(): HookEventStoreStats {
    const hookTypeCounts: Partial<Record<HookType, number>> = {};
    for (const event of this.events) {
      hookTypeCounts[event.hook] = (hookTypeCounts[event.hook] || 0) + 1;
    }

    let fileSizeBytes = 0;
    let lastModified: Date | undefined;
    if (fs.existsSync(this.config.eventsFilePath)) {
      const stats = fs.statSync(this.config.eventsFilePath);
      fileSizeBytes = stats.size;
      lastModified = stats.mtime;
    }

    return {
      totalEvents: this.events.length,
      uniqueSessions: this.eventIndex.size,
      hookTypeCounts,
      oldestEvent: this.events.length > 0 ? new Date(this.events[0].ts) : undefined,
      newestEvent: this.events.length > 0 ? new Date(this.events[this.events.length - 1].ts) : undefined,
      fileSizeBytes,
      lastModified,
      lastTid: this.nextTid - 1, // Last assigned tid
    };
  }

  /**
   * Get recent events (convenience method)
   */
  getRecentEvents(limit = 100): HookEventWithTid[] {
    return this.query({ limit, order: 'desc' });
  }

  /**
   * Get events since a timestamp
   */
  getEventsSince(timestamp: Date | number): HookEventWithTid[] {
    return this.query({ startTime: timestamp, order: 'asc' });
  }

  /**
   * Get failed events
   */
  getFailedEvents(limit = 100): HookEventWithTid[] {
    return this.query({ ok: false, limit, order: 'desc' });
  }

  /**
   * Get events after a specific transaction ID (for delta sync)
   * This is the primary method for incremental synchronization
   */
  getEventsAfterTid(afterTid: number, limit = 1000): HookEventDeltaResponse {
    // Use binary search to find start position since events are ordered by tid
    let left = 0;
    let right = this.events.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.events[mid].tid <= afterTid) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Get events from the found position
    const sliceEnd = Math.min(left + limit, this.events.length);
    const events = this.events.slice(left, sliceEnd);
    const hasMore = sliceEnd < this.events.length;

    return {
      events,
      count: events.length,
      lastTid: events.length > 0 ? events[events.length - 1].tid : afterTid,
      hasMore,
    };
  }

  /**
   * Get the last (highest) transaction ID
   */
  getLastTid(): number {
    return this.nextTid - 1;
  }

  /**
   * Get an event by its transaction ID
   */
  getEventByTid(tid: number): HookEventWithTid | undefined {
    return this.tidIndex.get(tid);
  }

  /**
   * Force refresh from disk
   */
  async refresh(): Promise<void> {
    await this.readNewEvents();
    this.emit('refresh');
  }

  /**
   * Clear all events from memory (does not delete file)
   */
  clear(): void {
    this.events = [];
    this.eventIndex.clear();
    this.toolUseIndex.clear();
    this.tidIndex.clear();
    this.lastReadOffset = 0;
    this.lastFileSize = 0;
    this.nextTid = 1;
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

const storeInstances = new Map<string, HookEventStore>();

/**
 * Get or create a HookEventStore instance
 */
export function getHookEventStore(config?: HookEventStoreConfig): HookEventStore {
  const key = config?.eventsFilePath || 'default';
  let store = storeInstances.get(key);

  if (!store) {
    store = new HookEventStore(config);
    storeInstances.set(key, store);
  }

  return store;
}

/**
 * Create a new HookEventStore instance (not cached)
 */
export function createHookEventStore(config?: HookEventStoreConfig): HookEventStore {
  return new HookEventStore(config);
}

/**
 * Dispose all cached store instances
 */
export function disposeAllHookEventStores(): void {
  for (const store of storeInstances.values()) {
    store.dispose();
  }
  storeInstances.clear();
}
