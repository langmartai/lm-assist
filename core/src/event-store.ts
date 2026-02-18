/**
 * Event Store
 *
 * Persistent storage and query interface for all tier-agent events.
 * Supports in-memory and file-based persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { TierEvent, LogEntry } from './types/control-api';
import type {
  SdkEvent,
  SdkEventType,
  SdkHookEvent,
  SdkMcpEvent,
  SdkUserInputEvent,
  SdkContentBlock,
  isSdkHookEvent,
  isSdkMcpEvent,
  isSdkUserInputEvent,
} from './types/sdk-events';
import type {
  StoredBlockingEvent,
  PermissionRequest,
  PermissionResponse,
  UserQuestionRequest,
  UserQuestionResponse,
  SubagentApprovalRequest,
  SubagentApprovalResponse,
} from './types/sdk-event-handlers';

import type { SessionChanges, TrackedFileChange } from './utils/change-tracker';

// ============================================================================
// Types
// ============================================================================

/**
 * Output chunk types for execution records
 */
export type OutputChunkType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'redacted_thinking'
  | 'mcp_tool_call'
  | 'mcp_tool_result'
  | 'hook_event'
  | 'subagent_start'
  | 'subagent_result'
  | 'user_question'
  | 'user_answer';

/**
 * Stored event with metadata
 */
export interface StoredEvent {
  /** Unique event ID */
  id: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event type */
  type: TierEvent['type'] | SdkEventType;
  /** Full event data */
  data: TierEvent | SdkEvent;
  /** Associated tier (if applicable) */
  tier?: string;
  /** Associated execution ID (if applicable) */
  executionId?: string;
  /** Associated request ID (if applicable) */
  requestId?: string;
  /** SDK-specific metadata */
  sdkMetadata?: {
    /** Hook type if this is a hook event */
    hookType?: string;
    /** MCP server name if this is an MCP event */
    mcpServer?: string;
    /** Tool name if this event involves a tool */
    toolName?: string;
    /** Subagent name if this event involves a subagent */
    subagentName?: string;
  };
}

/**
 * Agent type for execution classification
 */
export type ExecutionAgentType = 'spec' | 'task' | 'tier' | 'orchestrator';

/**
 * Execution record with full details
 */
export interface ExecutionRecord {
  /** Execution ID */
  id: string;
  /** Tier name */
  tier: string;
  /** Agent type for finer classification */
  agentType?: ExecutionAgentType;
  /** Start timestamp */
  startedAt: Date;
  /** End timestamp */
  completedAt?: Date;
  /** Current status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Input prompt */
  prompt: string;
  /** Additional context provided */
  context?: string;
  /** Claude Code session ID (from Agent SDK) - the actual session in ~/.claude/projects/ */
  claudeSessionId?: string;
  /** @deprecated Use claudeSessionId instead */
  sessionId?: string;
  /** Output result (streamed chunks concatenated) */
  output: string;
  /** Output chunks (for streaming) */
  outputChunks: Array<{
    timestamp: Date;
    content: string;
    type: OutputChunkType;
    /** Optional metadata for specific chunk types */
    metadata?: {
      /** Tool use ID for tool_use/tool_result chunks */
      toolUseId?: string;
      /** Tool name for tool_use/tool_result/mcp chunks */
      toolName?: string;
      /** MCP server name for mcp chunks */
      mcpServer?: string;
      /** Subagent ID for subagent chunks */
      subagentId?: string;
      /** Success indicator for result chunks */
      success?: boolean;
      /** Duration in ms for result chunks */
      durationMs?: number;
    };
  }>;
  /** Error message if failed */
  error?: string;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Cost in USD */
  costUsd?: number;
  /** Duration in ms */
  durationMs?: number;
  /** Files changed */
  filesChanged: string[];
  /** Related event IDs */
  eventIds: string[];
  /** Session changes with full details */
  sessionChanges?: SessionChanges;
}

/**
 * Event query options
 */
export interface EventQueryOptions {
  /** Filter by event type(s) */
  types?: (TierEvent['type'] | SdkEventType)[];
  /** Filter by tier */
  tier?: string;
  /** Filter by execution ID */
  executionId?: string;
  /** Filter by request ID */
  requestId?: string;
  /** From timestamp */
  from?: Date;
  /** To timestamp */
  to?: Date;
  /** Limit results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  order?: 'asc' | 'desc';
  /** Filter by SDK hook type */
  sdkHookType?: string;
  /** Filter by MCP server name */
  mcpServer?: string;
  /** Filter by tool name */
  toolName?: string;
  /** Include only SDK events */
  sdkOnly?: boolean;
}

/**
 * Execution query options
 */
export interface ExecutionQueryOptions {
  /** Filter by tier */
  tier?: string;
  /** Filter by agent type */
  agentType?: ExecutionAgentType;
  /** Filter by status */
  status?: ExecutionRecord['status'] | 'all';
  /** Filter by Claude session ID */
  claudeSessionId?: string;
  /** From timestamp */
  from?: Date;
  /** To timestamp */
  to?: Date;
  /** Limit results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Event store configuration
 */
export interface EventStoreConfig {
  /** Project path for file storage */
  projectPath: string;
  /** Enable file persistence */
  persist?: boolean;
  /** Max events to keep in memory */
  maxEvents?: number;
  /** Max executions to keep in memory */
  maxExecutions?: number;
}

// ============================================================================
// Event Store Implementation
// ============================================================================

export class EventStore {
  private config: Required<EventStoreConfig>;
  private events: StoredEvent[] = [];
  private executions: Map<string, ExecutionRecord> = new Map();
  private blockingEvents: Map<string, StoredBlockingEvent> = new Map();
  private sessionChanges: Map<string, SessionChanges> = new Map();
  private listeners: Set<(event: StoredEvent) => void> = new Set();
  private blockingEventListeners: Set<(event: StoredBlockingEvent) => void> = new Set();
  private sessionChangesListeners: Set<(changes: SessionChanges) => void> = new Set();
  private storageDir: string;

  constructor(config: EventStoreConfig) {
    this.config = {
      projectPath: config.projectPath,
      persist: config.persist ?? true,
      maxEvents: config.maxEvents ?? 10000,
      maxExecutions: config.maxExecutions ?? 1000,
    };

    this.storageDir = path.join(config.projectPath, '.lm-assist');

    // Load existing data if persistence enabled
    if (this.config.persist) {
      this.ensureStorageDir();
      this.loadFromDisk();
    }
  }

  // --------------------------------------------------------------------------
  // Event Management
  // --------------------------------------------------------------------------

  /**
   * Record a new event
   */
  recordEvent(event: TierEvent): StoredEvent {
    const stored: StoredEvent = {
      id: uuidv4(),
      timestamp: new Date(),
      type: event.type,
      data: event,
      tier: this.extractTier(event),
      executionId: this.extractExecutionId(event),
      requestId: this.extractRequestId(event),
    };

    this.events.unshift(stored);

    // Link to execution if applicable
    if (stored.executionId) {
      const execution = this.executions.get(stored.executionId);
      if (execution) {
        execution.eventIds.push(stored.id);
      }
    }

    // Trim if over limit
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(0, this.config.maxEvents);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    }

    // Persist
    if (this.config.persist) {
      this.appendEventToDisk(stored);
    }

    return stored;
  }

  /**
   * Record an SDK event
   */
  recordSdkEvent(event: SdkEvent): StoredEvent {
    const stored: StoredEvent = {
      id: uuidv4(),
      timestamp: new Date(event.timestamp),
      type: event.type,
      data: event,
      tier: event.tier,
      executionId: event.executionId,
      sdkMetadata: this.extractSdkMetadata(event),
    };

    this.events.unshift(stored);

    // Link to execution if applicable
    if (stored.executionId) {
      const execution = this.executions.get(stored.executionId);
      if (execution) {
        execution.eventIds.push(stored.id);

        // Add to output chunks based on event type
        this.addSdkEventToOutputChunks(execution, event);
      }
    }

    // Trim if over limit
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(0, this.config.maxEvents);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    }

    // Persist
    if (this.config.persist) {
      this.appendEventToDisk(stored);
    }

    return stored;
  }

  /**
   * Extract SDK-specific metadata from an event
   */
  private extractSdkMetadata(event: SdkEvent): StoredEvent['sdkMetadata'] {
    if (event.type === 'sdk_hook') {
      const hookEvent = event as SdkHookEvent;
      return {
        hookType: hookEvent.hookType,
        toolName: 'toolName' in hookEvent.data ? hookEvent.data.toolName : undefined,
        subagentName: 'agentName' in hookEvent.data ? hookEvent.data.agentName : undefined,
      };
    }

    if (event.type === 'sdk_mcp') {
      const mcpEvent = event as SdkMcpEvent;
      return {
        mcpServer: mcpEvent.data.serverName,
        toolName: 'toolName' in mcpEvent.data ? mcpEvent.data.toolName : undefined,
      };
    }

    return undefined;
  }

  /**
   * Add SDK event to execution's output chunks
   */
  private addSdkEventToOutputChunks(execution: ExecutionRecord, event: SdkEvent): void {
    const timestamp = new Date(event.timestamp);

    switch (event.type) {
      case 'sdk_assistant': {
        const assistantEvent = event as import('./types/sdk-events').SdkAssistantMessageEvent;
        for (const block of assistantEvent.data.content) {
          if (block.type === 'text') {
            execution.outputChunks.push({
              timestamp,
              content: block.text,
              type: 'text',
            });
          } else if (block.type === 'tool_use') {
            execution.outputChunks.push({
              timestamp,
              content: JSON.stringify(block.input),
              type: 'tool_use',
              metadata: {
                toolUseId: block.id,
                toolName: block.name,
              },
            });
          } else if (block.type === 'thinking') {
            execution.outputChunks.push({
              timestamp,
              content: block.thinking,
              type: 'thinking',
            });
          }
        }
        break;
      }

      case 'sdk_hook': {
        const hookEvent = event as SdkHookEvent;
        if (hookEvent.hookType === 'PreToolUse' || hookEvent.hookType === 'PostToolUse') {
          execution.outputChunks.push({
            timestamp,
            content: JSON.stringify(hookEvent.data),
            type: 'hook_event',
            metadata: {
              toolName: hookEvent.data.toolName,
              toolUseId: hookEvent.data.toolUseId,
            },
          });
        } else if (hookEvent.hookType === 'SubagentStart') {
          const startEvent = hookEvent as import('./types/sdk-events').SdkSubagentStartEvent;
          execution.outputChunks.push({
            timestamp,
            content: startEvent.data.prompt,
            type: 'subagent_start',
            metadata: {
              subagentId: startEvent.data.agentId,
            },
          });
        } else if (hookEvent.hookType === 'SubagentStop') {
          const stopEvent = hookEvent as import('./types/sdk-events').SdkSubagentStopEvent;
          execution.outputChunks.push({
            timestamp,
            content: stopEvent.data.result || stopEvent.data.error || '',
            type: 'subagent_result',
            metadata: {
              subagentId: stopEvent.data.agentId,
              success: stopEvent.data.success,
              durationMs: stopEvent.data.durationMs,
            },
          });
        }
        break;
      }

      case 'sdk_mcp': {
        const mcpEvent = event as SdkMcpEvent;
        if (mcpEvent.action === 'tool_call') {
          execution.outputChunks.push({
            timestamp,
            content: JSON.stringify(mcpEvent.data.input),
            type: 'mcp_tool_call',
            metadata: {
              mcpServer: mcpEvent.data.serverName,
              toolName: mcpEvent.data.toolName,
              toolUseId: mcpEvent.data.toolUseId,
            },
          });
        } else if (mcpEvent.action === 'tool_result') {
          const resultEvent = mcpEvent as import('./types/sdk-events').SdkMcpToolResultEvent;
          execution.outputChunks.push({
            timestamp,
            content: JSON.stringify(resultEvent.data.result || resultEvent.data.error),
            type: 'mcp_tool_result',
            metadata: {
              mcpServer: resultEvent.data.serverName,
              toolName: resultEvent.data.toolName,
              toolUseId: resultEvent.data.toolUseId,
              success: resultEvent.data.success,
              durationMs: resultEvent.data.durationMs,
            },
          });
        }
        break;
      }

      case 'sdk_user_input': {
        const inputEvent = event as SdkUserInputEvent;
        if (inputEvent.action === 'question') {
          const questionEvent = inputEvent as import('./types/sdk-events').SdkUserQuestionEvent;
          execution.outputChunks.push({
            timestamp,
            content: JSON.stringify(questionEvent.data.questions),
            type: 'user_question',
          });
          if (questionEvent.data.answers) {
            execution.outputChunks.push({
              timestamp,
              content: JSON.stringify(questionEvent.data.answers),
              type: 'user_answer',
            });
          }
        }
        break;
      }
    }
  }

  /**
   * Query events
   */
  queryEvents(options: EventQueryOptions = {}): {
    events: StoredEvent[];
    total: number;
    hasMore: boolean;
  } {
    let filtered = [...this.events];

    // Apply filters
    if (options.types && options.types.length > 0) {
      filtered = filtered.filter(e => options.types!.includes(e.type as TierEvent['type']));
    }
    if (options.tier) {
      filtered = filtered.filter(e => e.tier === options.tier);
    }
    if (options.executionId) {
      filtered = filtered.filter(e => e.executionId === options.executionId);
    }
    if (options.requestId) {
      filtered = filtered.filter(e => e.requestId === options.requestId);
    }
    if (options.from) {
      filtered = filtered.filter(e => e.timestamp >= options.from!);
    }
    if (options.to) {
      filtered = filtered.filter(e => e.timestamp <= options.to!);
    }

    // SDK-specific filters
    if (options.sdkOnly) {
      filtered = filtered.filter(e => e.type.startsWith('sdk_'));
    }
    if (options.sdkHookType) {
      filtered = filtered.filter(e =>
        e.sdkMetadata?.hookType === options.sdkHookType
      );
    }
    if (options.mcpServer) {
      filtered = filtered.filter(e =>
        e.sdkMetadata?.mcpServer === options.mcpServer
      );
    }
    if (options.toolName) {
      filtered = filtered.filter(e =>
        e.sdkMetadata?.toolName === options.toolName
      );
    }

    // Sort
    if (options.order === 'asc') {
      filtered.reverse();
    }

    const total = filtered.length;
    const offset = options.offset || 0;
    const limit = options.limit || 100;

    filtered = filtered.slice(offset, offset + limit);

    return {
      events: filtered,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Query SDK events specifically
   */
  querySdkEvents(options: Omit<EventQueryOptions, 'sdkOnly'> & {
    hookTypes?: string[];
  } = {}): {
    events: StoredEvent[];
    total: number;
    hasMore: boolean;
  } {
    let filtered = this.events.filter(e => e.type.startsWith('sdk_'));

    // Apply filters
    if (options.types && options.types.length > 0) {
      filtered = filtered.filter(e => options.types!.includes(e.type as SdkEventType));
    }
    if (options.tier) {
      filtered = filtered.filter(e => e.tier === options.tier);
    }
    if (options.executionId) {
      filtered = filtered.filter(e => e.executionId === options.executionId);
    }
    if (options.from) {
      filtered = filtered.filter(e => e.timestamp >= options.from!);
    }
    if (options.to) {
      filtered = filtered.filter(e => e.timestamp <= options.to!);
    }
    if (options.hookTypes && options.hookTypes.length > 0) {
      filtered = filtered.filter(e =>
        e.sdkMetadata?.hookType && options.hookTypes!.includes(e.sdkMetadata.hookType)
      );
    }
    if (options.mcpServer) {
      filtered = filtered.filter(e =>
        e.sdkMetadata?.mcpServer === options.mcpServer
      );
    }
    if (options.toolName) {
      filtered = filtered.filter(e =>
        e.sdkMetadata?.toolName === options.toolName
      );
    }

    // Sort
    if (options.order === 'asc') {
      filtered.reverse();
    }

    const total = filtered.length;
    const offset = options.offset || 0;
    const limit = options.limit || 100;

    filtered = filtered.slice(offset, offset + limit);

    return {
      events: filtered,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get single event by ID
   */
  getEvent(eventId: string): StoredEvent | undefined {
    return this.events.find(e => e.id === eventId);
  }

  /**
   * Subscribe to new events
   */
  subscribe(callback: (event: StoredEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // --------------------------------------------------------------------------
  // Execution Management
  // --------------------------------------------------------------------------

  /**
   * Start a new execution
   */
  startExecution(tier: string, prompt: string, options?: {
    context?: string;
    sessionId?: string;
    /** @deprecated Use claudeSessionId instead */
    claudeSessionId?: string;
    agentType?: ExecutionAgentType;
  }): ExecutionRecord {
    const execution: ExecutionRecord = {
      id: uuidv4(),
      tier,
      agentType: options?.agentType,
      startedAt: new Date(),
      status: 'running',
      prompt,
      context: options?.context,
      claudeSessionId: options?.claudeSessionId,
      sessionId: options?.claudeSessionId || options?.sessionId, // Backward compat
      output: '',
      outputChunks: [],
      filesChanged: [],
      eventIds: [],
    };

    this.executions.set(execution.id, execution);

    // Trim if over limit
    if (this.executions.size > this.config.maxExecutions) {
      const oldest = Array.from(this.executions.entries())
        .filter(([_, e]) => e.status === 'completed' || e.status === 'failed')
        .sort((a, b) => a[1].startedAt.getTime() - b[1].startedAt.getTime())[0];
      if (oldest) {
        this.executions.delete(oldest[0]);
      }
    }

    // Record start event
    this.recordEvent({
      type: 'execution_start',
      tier,
      executionId: execution.id,
      prompt,
    });

    return execution;
  }

  /**
   * Append output chunk to execution
   */
  appendOutput(executionId: string, content: string, type: 'text' | 'tool_use' | 'thinking' = 'text'): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;

    execution.outputChunks.push({
      timestamp: new Date(),
      content,
      type,
    });
    execution.output += content;
  }

  /**
   * Complete an execution
   */
  completeExecution(executionId: string, result: {
    success: boolean;
    output?: string;
    error?: string;
    usage?: ExecutionRecord['usage'];
    costUsd?: number;
    filesChanged?: string[];
  }): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;

    execution.completedAt = new Date();
    execution.status = result.success ? 'completed' : 'failed';
    if (result.output) execution.output = result.output;
    if (result.error) execution.error = result.error;
    if (result.usage) execution.usage = result.usage;
    if (result.costUsd) execution.costUsd = result.costUsd;
    if (result.filesChanged) execution.filesChanged = result.filesChanged;
    execution.durationMs = execution.completedAt.getTime() - execution.startedAt.getTime();

    // Record completion event
    if (result.success) {
      this.recordEvent({
        type: 'execution_complete',
        tier: execution.tier,
        executionId,
        success: true,
        result: execution.output,
      });
    } else {
      this.recordEvent({
        type: 'execution_error',
        tier: execution.tier,
        executionId,
        error: result.error || 'Unknown error',
      });
    }

    // Persist
    if (this.config.persist) {
      this.saveExecutionToDisk(execution);
    }
  }

  /**
   * Get execution by ID
   */
  getExecution(executionId: string): ExecutionRecord | undefined {
    return this.executions.get(executionId);
  }

  /**
   * Query executions
   */
  queryExecutions(options: ExecutionQueryOptions = {}): {
    executions: ExecutionRecord[];
    total: number;
    hasMore: boolean;
  } {
    let filtered = Array.from(this.executions.values());

    // Apply filters
    if (options.tier) {
      filtered = filtered.filter(e => e.tier === options.tier);
    }
    if (options.agentType) {
      filtered = filtered.filter(e => e.agentType === options.agentType);
    }
    if (options.status && options.status !== 'all') {
      filtered = filtered.filter(e => e.status === options.status);
    }
    if (options.claudeSessionId) {
      filtered = filtered.filter(e => e.claudeSessionId === options.claudeSessionId);
    }
    if (options.from) {
      filtered = filtered.filter(e => e.startedAt >= options.from!);
    }
    if (options.to) {
      filtered = filtered.filter(e => e.startedAt <= options.to!);
    }

    // Sort by start time desc
    filtered.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const total = filtered.length;
    const offset = options.offset || 0;
    const limit = options.limit || 50;

    filtered = filtered.slice(offset, offset + limit);

    return {
      executions: filtered,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get execution by Claude session ID
   */
  getExecutionByClaudeSessionId(claudeSessionId: string): ExecutionRecord | undefined {
    for (const execution of this.executions.values()) {
      if (execution.claudeSessionId === claudeSessionId) {
        return execution;
      }
    }
    return undefined;
  }

  /**
   * Update the Claude session ID for an execution
   * (useful when SDK returns the actual session ID after starting)
   */
  updateClaudeSessionId(executionId: string, claudeSessionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (!execution) return false;

    execution.claudeSessionId = claudeSessionId;
    execution.sessionId = claudeSessionId; // Backward compat

    // Persist
    if (this.config.persist && (execution.status === 'completed' || execution.status === 'failed')) {
      this.saveExecutionToDisk(execution);
    }

    return true;
  }

  /**
   * Get running executions
   */
  getRunningExecutions(): ExecutionRecord[] {
    return Array.from(this.executions.values())
      .filter(e => e.status === 'running');
  }

  /**
   * Get executions grouped by tier
   */
  getExecutionsByTier(): Record<string, ExecutionRecord[]> {
    const byTier: Record<string, ExecutionRecord[]> = {};
    for (const execution of this.executions.values()) {
      if (!byTier[execution.tier]) {
        byTier[execution.tier] = [];
      }
      byTier[execution.tier].push(execution);
    }
    // Sort each tier's executions by start time desc
    for (const tier of Object.keys(byTier)) {
      byTier[tier].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }
    return byTier;
  }

  /**
   * Get execution statistics by tier
   */
  getExecutionStatsByTier(): Record<string, {
    total: number;
    completed: number;
    failed: number;
    running: number;
    totalCostUsd: number;
    avgDurationMs: number;
  }> {
    const stats: Record<string, {
      total: number;
      completed: number;
      failed: number;
      running: number;
      totalCostUsd: number;
      totalDurationMs: number;
      completedCount: number;
    }> = {};

    for (const execution of this.executions.values()) {
      if (!stats[execution.tier]) {
        stats[execution.tier] = {
          total: 0,
          completed: 0,
          failed: 0,
          running: 0,
          totalCostUsd: 0,
          totalDurationMs: 0,
          completedCount: 0,
        };
      }

      const tierStats = stats[execution.tier];
      tierStats.total++;

      switch (execution.status) {
        case 'completed':
          tierStats.completed++;
          break;
        case 'failed':
          tierStats.failed++;
          break;
        case 'running':
          tierStats.running++;
          break;
      }

      if (execution.costUsd) {
        tierStats.totalCostUsd += execution.costUsd;
      }
      if (execution.durationMs) {
        tierStats.totalDurationMs += execution.durationMs;
        tierStats.completedCount++;
      }
    }

    // Convert to final format with avgDurationMs
    const result: Record<string, {
      total: number;
      completed: number;
      failed: number;
      running: number;
      totalCostUsd: number;
      avgDurationMs: number;
    }> = {};

    for (const [tier, tierStats] of Object.entries(stats)) {
      result[tier] = {
        total: tierStats.total,
        completed: tierStats.completed,
        failed: tierStats.failed,
        running: tierStats.running,
        totalCostUsd: tierStats.totalCostUsd,
        avgDurationMs: tierStats.completedCount > 0
          ? tierStats.totalDurationMs / tierStats.completedCount
          : 0,
      };
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Blocking Event Management
  // --------------------------------------------------------------------------

  /**
   * Store a blocking event (permission request, user question, etc.)
   */
  storeBlockingEvent(event: StoredBlockingEvent): void {
    this.blockingEvents.set(event.id, event);

    // Notify listeners
    for (const listener of this.blockingEventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Blocking event listener error:', e);
      }
    }

    // Persist
    if (this.config.persist) {
      this.saveBlockingEventsToDisk();
    }
  }

  /**
   * Update blocking event with response
   */
  updateBlockingEventResponse(
    eventId: string,
    response: PermissionResponse | UserQuestionResponse | SubagentApprovalResponse,
    respondedBy: string
  ): boolean {
    const event = this.blockingEvents.get(eventId);
    if (!event) return false;

    event.response = response;
    event.status = 'responded';
    event.respondedAt = new Date().toISOString();
    event.respondedBy = respondedBy as StoredBlockingEvent['respondedBy'];
    event.waitDurationMs = new Date(event.respondedAt).getTime() - new Date(event.createdAt).getTime();

    // Notify listeners
    for (const listener of this.blockingEventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Blocking event listener error:', e);
      }
    }

    // Persist
    if (this.config.persist) {
      this.saveBlockingEventsToDisk();
    }

    return true;
  }

  /**
   * Get blocking event by ID
   */
  getBlockingEvent(eventId: string): StoredBlockingEvent | undefined {
    return this.blockingEvents.get(eventId);
  }

  /**
   * Get pending blocking events
   */
  getPendingBlockingEvents(): StoredBlockingEvent[] {
    return Array.from(this.blockingEvents.values())
      .filter(e => e.status === 'pending');
  }

  /**
   * Query blocking events
   */
  queryBlockingEvents(options: {
    type?: StoredBlockingEvent['type'];
    status?: StoredBlockingEvent['status'];
    tier?: string;
    executionId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  } = {}): StoredBlockingEvent[] {
    let filtered = Array.from(this.blockingEvents.values());

    if (options.type) {
      filtered = filtered.filter(e => e.type === options.type);
    }
    if (options.status) {
      filtered = filtered.filter(e => e.status === options.status);
    }
    if (options.tier) {
      filtered = filtered.filter(e => {
        const request = e.request as { tier?: string };
        return request.tier === options.tier;
      });
    }
    if (options.executionId) {
      filtered = filtered.filter(e => {
        const request = e.request as { executionId?: string };
        return request.executionId === options.executionId;
      });
    }
    if (options.from) {
      filtered = filtered.filter(e => new Date(e.createdAt) >= options.from!);
    }
    if (options.to) {
      filtered = filtered.filter(e => new Date(e.createdAt) <= options.to!);
    }

    // Sort by created time desc
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Subscribe to blocking events
   */
  subscribeToBlockingEvents(callback: (event: StoredBlockingEvent) => void): () => void {
    this.blockingEventListeners.add(callback);
    return () => this.blockingEventListeners.delete(callback);
  }

  /**
   * Cancel a pending blocking event
   */
  cancelBlockingEvent(eventId: string): boolean {
    const event = this.blockingEvents.get(eventId);
    if (!event || event.status !== 'pending') return false;

    event.status = 'cancelled';
    event.respondedAt = new Date().toISOString();

    // Persist
    if (this.config.persist) {
      this.saveBlockingEventsToDisk();
    }

    return true;
  }

  /**
   * Get blocking event statistics
   */
  getBlockingEventStats(): {
    total: number;
    pending: number;
    responded: number;
    timedOut: number;
    cancelled: number;
    byType: Record<string, number>;
    byRespondedBy: Record<string, number>;
    avgWaitDurationMs: number;
  } {
    const events = Array.from(this.blockingEvents.values());
    const byType: Record<string, number> = {};
    const byRespondedBy: Record<string, number> = {};
    let totalWaitDuration = 0;
    let respondedCount = 0;

    for (const event of events) {
      byType[event.type] = (byType[event.type] || 0) + 1;

      if (event.respondedBy) {
        byRespondedBy[event.respondedBy] = (byRespondedBy[event.respondedBy] || 0) + 1;
      }

      if (event.waitDurationMs) {
        totalWaitDuration += event.waitDurationMs;
        respondedCount++;
      }
    }

    return {
      total: events.length,
      pending: events.filter(e => e.status === 'pending').length,
      responded: events.filter(e => e.status === 'responded').length,
      timedOut: events.filter(e => e.status === 'timed_out').length,
      cancelled: events.filter(e => e.status === 'cancelled').length,
      byType,
      byRespondedBy,
      avgWaitDurationMs: respondedCount > 0 ? totalWaitDuration / respondedCount : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Session Changes Management
  // --------------------------------------------------------------------------

  /**
   * Store session changes for an execution
   */
  storeSessionChanges(changes: SessionChanges): void {
    // Store with session ID as key
    this.sessionChanges.set(changes.sessionId, changes);

    // Also link to execution if available
    if (changes.executionId) {
      const execution = this.executions.get(changes.executionId);
      if (execution) {
        execution.sessionChanges = changes;
        execution.filesChanged = changes.changes.map(c => c.relativePath);
      }
    }

    // Notify listeners
    for (const listener of this.sessionChangesListeners) {
      try {
        listener(changes);
      } catch (e) {
        console.error('Session changes listener error:', e);
      }
    }

    // Persist
    if (this.config.persist) {
      this.saveSessionChangesToDisk();
    }
  }

  /**
   * Get session changes by session ID
   */
  getSessionChanges(sessionId: string): SessionChanges | undefined {
    return this.sessionChanges.get(sessionId);
  }

  /**
   * Get session changes by execution ID
   */
  getSessionChangesByExecution(executionId: string): SessionChanges | undefined {
    for (const changes of this.sessionChanges.values()) {
      if (changes.executionId === executionId) {
        return changes;
      }
    }
    return undefined;
  }

  /**
   * Query session changes
   */
  querySessionChanges(options: {
    workingDirectory?: string;
    from?: Date;
    to?: Date;
    minFilesChanged?: number;
    hasCreated?: boolean;
    hasModified?: boolean;
    hasDeleted?: boolean;
    filePattern?: string;
    limit?: number;
  } = {}): SessionChanges[] {
    let filtered = Array.from(this.sessionChanges.values());

    if (options.workingDirectory) {
      filtered = filtered.filter(c => c.workingDirectory === options.workingDirectory);
    }
    if (options.from) {
      filtered = filtered.filter(c => c.startedAt >= options.from!);
    }
    if (options.to) {
      filtered = filtered.filter(c => c.startedAt <= options.to!);
    }
    if (options.minFilesChanged !== undefined) {
      filtered = filtered.filter(c => c.changes.length >= options.minFilesChanged!);
    }
    if (options.hasCreated) {
      filtered = filtered.filter(c => c.summary.filesCreated > 0);
    }
    if (options.hasModified) {
      filtered = filtered.filter(c => c.summary.filesModified > 0);
    }
    if (options.hasDeleted) {
      filtered = filtered.filter(c => c.summary.filesDeleted > 0);
    }
    if (options.filePattern) {
      const pattern = new RegExp(options.filePattern);
      filtered = filtered.filter(c =>
        c.changes.some(change => pattern.test(change.relativePath))
      );
    }

    // Sort by start time desc
    filtered.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Get all file changes across all sessions
   */
  getAllFileChanges(options: {
    action?: TrackedFileChange['action'];
    filePattern?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  } = {}): Array<TrackedFileChange & { sessionId: string; executionId?: string }> {
    const allChanges: Array<TrackedFileChange & { sessionId: string; executionId?: string }> = [];

    for (const session of this.sessionChanges.values()) {
      if (options.from && session.startedAt < options.from) continue;
      if (options.to && session.startedAt > options.to) continue;

      for (const change of session.changes) {
        if (options.action && change.action !== options.action) continue;
        if (options.filePattern && !new RegExp(options.filePattern).test(change.relativePath)) continue;

        allChanges.push({
          ...change,
          sessionId: session.sessionId,
          executionId: session.executionId,
        });
      }
    }

    // Sort by newest first (based on after.modifiedAt if available)
    allChanges.sort((a, b) => {
      const aTime = a.after?.modifiedAt?.getTime() || 0;
      const bTime = b.after?.modifiedAt?.getTime() || 0;
      return bTime - aTime;
    });

    if (options.limit) {
      return allChanges.slice(0, options.limit);
    }

    return allChanges;
  }

  /**
   * Subscribe to session changes
   */
  subscribeToSessionChanges(callback: (changes: SessionChanges) => void): () => void {
    this.sessionChangesListeners.add(callback);
    return () => this.sessionChangesListeners.delete(callback);
  }

  /**
   * Get session changes statistics
   */
  getSessionChangesStats(): {
    totalSessions: number;
    totalFilesCreated: number;
    totalFilesModified: number;
    totalFilesDeleted: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    byWorkingDirectory: Record<string, number>;
    recentlyChanged: string[];
  } {
    const sessions = Array.from(this.sessionChanges.values());
    const byWorkingDirectory: Record<string, number> = {};
    const fileChangeFrequency: Record<string, number> = {};

    let totalFilesCreated = 0;
    let totalFilesModified = 0;
    let totalFilesDeleted = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    for (const session of sessions) {
      byWorkingDirectory[session.workingDirectory] =
        (byWorkingDirectory[session.workingDirectory] || 0) + 1;

      totalFilesCreated += session.summary.filesCreated;
      totalFilesModified += session.summary.filesModified;
      totalFilesDeleted += session.summary.filesDeleted;
      totalLinesAdded += session.summary.totalLinesAdded;
      totalLinesRemoved += session.summary.totalLinesRemoved;

      for (const change of session.changes) {
        fileChangeFrequency[change.relativePath] =
          (fileChangeFrequency[change.relativePath] || 0) + 1;
      }
    }

    // Get most recently changed files
    const recentlyChanged = Object.entries(fileChangeFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file]) => file);

    return {
      totalSessions: sessions.length,
      totalFilesCreated,
      totalFilesModified,
      totalFilesDeleted,
      totalLinesAdded,
      totalLinesRemoved,
      byWorkingDirectory,
      recentlyChanged,
    };
  }

  private getSessionChangesFilePath(): string {
    return path.join(this.storageDir, 'session-changes.json');
  }

  private saveSessionChangesToDisk(): void {
    try {
      const changes = Array.from(this.sessionChanges.values());
      fs.writeFileSync(
        this.getSessionChangesFilePath(),
        JSON.stringify(changes, null, 2)
      );
    } catch (e) {
      console.error('Failed to persist session changes:', e);
    }
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /**
   * Get event statistics
   */
  getStats(): {
    totalEvents: number;
    totalExecutions: number;
    runningExecutions: number;
    eventsByType: Record<string, number>;
    executionsByStatus: Record<string, number>;
    executionsByTier: Record<string, number>;
    sdkStats: {
      totalSdkEvents: number;
      hookEventsByType: Record<string, number>;
      mcpEventsByServer: Record<string, number>;
      toolUsageByName: Record<string, number>;
    };
  } {
    const eventsByType: Record<string, number> = {};
    const hookEventsByType: Record<string, number> = {};
    const mcpEventsByServer: Record<string, number> = {};
    const toolUsageByName: Record<string, number> = {};
    let totalSdkEvents = 0;

    for (const event of this.events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;

      // SDK-specific stats
      if (event.type.startsWith('sdk_')) {
        totalSdkEvents++;

        if (event.sdkMetadata?.hookType) {
          hookEventsByType[event.sdkMetadata.hookType] =
            (hookEventsByType[event.sdkMetadata.hookType] || 0) + 1;
        }

        if (event.sdkMetadata?.mcpServer) {
          mcpEventsByServer[event.sdkMetadata.mcpServer] =
            (mcpEventsByServer[event.sdkMetadata.mcpServer] || 0) + 1;
        }

        if (event.sdkMetadata?.toolName) {
          toolUsageByName[event.sdkMetadata.toolName] =
            (toolUsageByName[event.sdkMetadata.toolName] || 0) + 1;
        }
      }
    }

    const executionsByStatus: Record<string, number> = {};
    const executionsByTier: Record<string, number> = {};
    let runningCount = 0;

    for (const execution of this.executions.values()) {
      executionsByStatus[execution.status] = (executionsByStatus[execution.status] || 0) + 1;
      executionsByTier[execution.tier] = (executionsByTier[execution.tier] || 0) + 1;
      if (execution.status === 'running') runningCount++;
    }

    return {
      totalEvents: this.events.length,
      totalExecutions: this.executions.size,
      runningExecutions: runningCount,
      eventsByType,
      executionsByStatus,
      executionsByTier,
      sdkStats: {
        totalSdkEvents,
        hookEventsByType,
        mcpEventsByServer,
        toolUsageByName,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private getEventsFilePath(): string {
    return path.join(this.storageDir, 'events.jsonl');
  }

  private getExecutionsFilePath(): string {
    return path.join(this.storageDir, 'executions.json');
  }

  private loadFromDisk(): void {
    // Load events
    const eventsPath = this.getEventsFilePath();
    if (fs.existsSync(eventsPath)) {
      try {
        const content = fs.readFileSync(eventsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        // Load last N events
        const recentLines = lines.slice(-this.config.maxEvents);
        for (const line of recentLines) {
          try {
            const event = JSON.parse(line);
            event.timestamp = new Date(event.timestamp);
            this.events.push(event);
          } catch {
            // Skip invalid lines
          }
        }

        // Reverse so newest first
        this.events.reverse();
      } catch (e) {
        console.error('Failed to load events:', e);
      }
    }

    // Load executions
    const executionsPath = this.getExecutionsFilePath();
    if (fs.existsSync(executionsPath)) {
      try {
        const content = fs.readFileSync(executionsPath, 'utf-8');
        const data = JSON.parse(content);

        for (const exec of data) {
          exec.startedAt = new Date(exec.startedAt);
          if (exec.completedAt) exec.completedAt = new Date(exec.completedAt);
          for (const chunk of exec.outputChunks || []) {
            chunk.timestamp = new Date(chunk.timestamp);
          }
          this.executions.set(exec.id, exec);
        }
      } catch (e) {
        console.error('Failed to load executions:', e);
      }
    }

    // Load blocking events
    const blockingEventsPath = this.getBlockingEventsFilePath();
    if (fs.existsSync(blockingEventsPath)) {
      try {
        const content = fs.readFileSync(blockingEventsPath, 'utf-8');
        const data = JSON.parse(content);

        for (const event of data) {
          this.blockingEvents.set(event.id, event);
        }
      } catch (e) {
        console.error('Failed to load blocking events:', e);
      }
    }

    // Load session changes
    const sessionChangesPath = this.getSessionChangesFilePath();
    if (fs.existsSync(sessionChangesPath)) {
      try {
        const content = fs.readFileSync(sessionChangesPath, 'utf-8');
        const data = JSON.parse(content);

        for (const changes of data) {
          // Convert date strings back to Date objects
          changes.startedAt = new Date(changes.startedAt);
          if (changes.completedAt) changes.completedAt = new Date(changes.completedAt);

          // Convert file snapshot dates
          for (const change of changes.changes || []) {
            if (change.before?.modifiedAt) change.before.modifiedAt = new Date(change.before.modifiedAt);
            if (change.after?.modifiedAt) change.after.modifiedAt = new Date(change.after.modifiedAt);
          }
          for (const toolChange of changes.toolChanges || []) {
            if (toolChange.timestamp) toolChange.timestamp = new Date(toolChange.timestamp);
          }

          this.sessionChanges.set(changes.sessionId, changes);
        }
      } catch (e) {
        console.error('Failed to load session changes:', e);
      }
    }
  }

  private appendEventToDisk(event: StoredEvent): void {
    try {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.getEventsFilePath(), line);
    } catch (e) {
      console.error('Failed to persist event:', e);
    }
  }

  private saveExecutionToDisk(execution: ExecutionRecord): void {
    try {
      // Save all completed executions
      const completed = Array.from(this.executions.values())
        .filter(e => e.status !== 'running')
        .slice(-this.config.maxExecutions);

      fs.writeFileSync(
        this.getExecutionsFilePath(),
        JSON.stringify(completed, null, 2)
      );
    } catch (e) {
      console.error('Failed to persist execution:', e);
    }
  }

  private getBlockingEventsFilePath(): string {
    return path.join(this.storageDir, 'blocking-events.json');
  }

  private saveBlockingEventsToDisk(): void {
    try {
      const events = Array.from(this.blockingEvents.values());
      fs.writeFileSync(
        this.getBlockingEventsFilePath(),
        JSON.stringify(events, null, 2)
      );
    } catch (e) {
      console.error('Failed to persist blocking events:', e);
    }
  }

  /**
   * Clear all stored data
   */
  clear(): void {
    this.events = [];
    this.executions.clear();
    this.blockingEvents.clear();
    this.sessionChanges.clear();

    if (this.config.persist) {
      try {
        const eventsPath = this.getEventsFilePath();
        const executionsPath = this.getExecutionsFilePath();
        const blockingEventsPath = this.getBlockingEventsFilePath();
        const sessionChangesPath = this.getSessionChangesFilePath();
        if (fs.existsSync(eventsPath)) fs.unlinkSync(eventsPath);
        if (fs.existsSync(executionsPath)) fs.unlinkSync(executionsPath);
        if (fs.existsSync(blockingEventsPath)) fs.unlinkSync(blockingEventsPath);
        if (fs.existsSync(sessionChangesPath)) fs.unlinkSync(sessionChangesPath);
      } catch (e) {
        console.error('Failed to clear storage:', e);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private extractTier(event: TierEvent): string | undefined {
    if ('tier' in event) return event.tier;
    if (event.type === 'request_submitted') return event.request.sourceTier;
    return undefined;
  }

  private extractExecutionId(event: TierEvent): string | undefined {
    if ('executionId' in event) return event.executionId;
    return undefined;
  }

  private extractRequestId(event: TierEvent): string | undefined {
    if ('requestId' in event) return event.requestId;
    if (event.type === 'request_submitted') return event.request.id;
    return undefined;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createEventStore(config: EventStoreConfig): EventStore {
  return new EventStore(config);
}
