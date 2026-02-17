/**
 * Agent Session Monitor
 *
 * Monitors session progress using SDK events.
 * Integrates with AgentSessionStore for tracking and the SDK runner for events.
 */

import { EventEmitter } from 'events';
import type { TierName } from './types/instruction-protocol';
import type { AgentSessionStore, AgentSession, SessionStatus } from './agent-session-store';
import type { ClaudeSdkRunner, SdkExecutionHandle } from './sdk-runner';
import type {
  SdkEvent,
  SdkInitEvent,
  SdkAssistantMessageEvent,
  SdkResultEvent,
  SdkUserQuestionEvent,
  SdkPermissionRequestEvent,
} from './types/sdk-events';

// ============================================================================
// Types
// ============================================================================

export interface MonitoredExecution {
  /** Execution handle from SDK runner */
  handle: SdkExecutionHandle;
  /** Tier being executed */
  tier: TierName | 'orchestrator';
  /** Session in the store */
  session: AgentSession;
  /** Start time */
  startTime: Date;
}

export interface SessionMonitorConfig {
  /** Session store instance */
  sessionStore: AgentSessionStore;
  /** SDK runner instance */
  sdkRunner: ClaudeSdkRunner;
  /** Emit detailed progress events */
  emitDetailedProgress?: boolean;
  /** Progress update interval (ms) for polling-based monitoring */
  progressIntervalMs?: number;
}

export interface ProgressEvent {
  sessionId: string;
  executionId: string;
  tier: TierName | 'orchestrator';
  status: SessionStatus;
  turnCount: number;
  elapsedMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd: number;
}

export interface CompletionEvent {
  sessionId: string;
  executionId: string;
  tier: TierName | 'orchestrator';
  success: boolean;
  result?: string;
  error?: string;
  durationMs: number;
  turnCount: number;
  costUsd: number;
}

// ============================================================================
// Session Monitor Implementation
// ============================================================================

export class AgentSessionMonitor extends EventEmitter {
  private sessionStore: AgentSessionStore;
  private sdkRunner: ClaudeSdkRunner;
  private config: Required<Omit<SessionMonitorConfig, 'sessionStore' | 'sdkRunner'>>;
  private monitoredExecutions: Map<string, MonitoredExecution> = new Map();
  private progressInterval?: NodeJS.Timeout;

  constructor(config: SessionMonitorConfig) {
    super();
    this.sessionStore = config.sessionStore;
    this.sdkRunner = config.sdkRunner;
    this.config = {
      emitDetailedProgress: config.emitDetailedProgress ?? true,
      progressIntervalMs: config.progressIntervalMs ?? 5000,
    };

    // Subscribe to SDK events
    this.setupSdkEventListeners();

    // Start progress polling
    if (this.config.progressIntervalMs > 0) {
      this.progressInterval = setInterval(() => this.emitProgressUpdates(), this.config.progressIntervalMs);
    }
  }

  // --------------------------------------------------------------------------
  // Execution Monitoring
  // --------------------------------------------------------------------------

  /**
   * Start monitoring an execution.
   * Call this immediately after executeAsync() to begin tracking.
   */
  monitorExecution(
    handle: SdkExecutionHandle,
    tier: TierName | 'orchestrator',
    prompt: string,
    cwd: string,
    options?: {
      parentSessionId?: string;
      metadata?: Record<string, unknown>;
    }
  ): AgentSession {
    // Create session in store
    const session = this.sessionStore.createSession({
      sessionId: handle.sessionId, // Initial session ID (may be updated)
      executionId: handle.executionId,
      tier,
      prompt,
      cwd,
      parentSessionId: options?.parentSessionId,
      metadata: options?.metadata,
    });

    // Track monitored execution
    const monitored: MonitoredExecution = {
      handle,
      tier,
      session,
      startTime: new Date(),
    };
    this.monitoredExecutions.set(handle.executionId, monitored);

    // Wait for session to be ready (SDK init)
    handle.sessionReady.then(actualSessionId => {
      // Update session ID if different
      if (actualSessionId !== session.sessionId) {
        this.sessionStore.updateSessionId(session.sessionId, actualSessionId);
        session.sessionId = actualSessionId;
      } else {
        this.sessionStore.updateStatus(session.sessionId, 'initializing');
      }

      this.emit('session_started', {
        sessionId: actualSessionId,
        executionId: handle.executionId,
        tier,
      });
    }).catch(err => {
      this.sessionStore.updateStatus(session.sessionId, 'failed', {
        error: err.message || String(err),
      });
      this.monitoredExecutions.delete(handle.executionId);
    });

    // Wait for result
    handle.result.then(result => {
      this.handleCompletion(handle.executionId, result);
    }).catch(err => {
      this.handleError(handle.executionId, err);
    });

    return session;
  }

  /**
   * Monitor multiple executions in parallel
   */
  monitorParallelExecutions(
    executions: Array<{
      handle: SdkExecutionHandle;
      tier: TierName | 'orchestrator';
      prompt: string;
      cwd: string;
      parentSessionId?: string;
      metadata?: Record<string, unknown>;
    }>
  ): AgentSession[] {
    return executions.map(exec =>
      this.monitorExecution(exec.handle, exec.tier, exec.prompt, exec.cwd, {
        parentSessionId: exec.parentSessionId,
        metadata: exec.metadata,
      })
    );
  }

  /**
   * Get all currently monitored executions
   */
  getMonitoredExecutions(): MonitoredExecution[] {
    return Array.from(this.monitoredExecutions.values());
  }

  /**
   * Get a specific monitored execution
   */
  getMonitoredExecution(executionId: string): MonitoredExecution | undefined {
    return this.monitoredExecutions.get(executionId);
  }

  /**
   * Abort a monitored execution
   */
  abortExecution(executionId: string): boolean {
    const monitored = this.monitoredExecutions.get(executionId);
    if (!monitored) return false;

    monitored.handle.abort();
    this.sessionStore.updateStatus(monitored.session.sessionId, 'aborted');
    this.monitoredExecutions.delete(executionId);

    this.emit('session_aborted', {
      sessionId: monitored.session.sessionId,
      executionId,
      tier: monitored.tier,
    });

    return true;
  }

  /**
   * Abort all monitored executions
   */
  abortAll(): number {
    let count = 0;
    for (const executionId of this.monitoredExecutions.keys()) {
      if (this.abortExecution(executionId)) {
        count++;
      }
    }
    return count;
  }

  // --------------------------------------------------------------------------
  // SDK Event Handling
  // --------------------------------------------------------------------------

  private setupSdkEventListeners(): void {
    // Listen to SDK events
    this.sdkRunner.on('sdk_event', (event: SdkEvent) => {
      this.handleSdkEvent(event);
    });

    // Listen to blocking events (user questions, permissions)
    this.sdkRunner.on('blocking_event', (event: { type: string; request: unknown }) => {
      this.handleBlockingEvent(event);
    });
  }

  private handleSdkEvent(event: SdkEvent): void {
    const executionId = event.executionId;
    if (!executionId) return;

    const monitored = this.monitoredExecutions.get(executionId);
    if (!monitored) return;

    const session = monitored.session;

    switch (event.type) {
      case 'sdk_init': {
        const initEvent = event as SdkInitEvent;
        this.sessionStore.updateProgress(session.sessionId, {
          model: initEvent.data.model,
        });
        this.sessionStore.updateStatus(session.sessionId, 'running');
        break;
      }

      case 'sdk_assistant': {
        const assistantEvent = event as SdkAssistantMessageEvent;
        this.sessionStore.updateProgress(session.sessionId, {
          turnCount: assistantEvent.data.turnIndex,
          usage: {
            inputTokens: assistantEvent.data.usage.inputTokens,
            outputTokens: assistantEvent.data.usage.outputTokens,
            cacheReadTokens: assistantEvent.data.usage.cacheReadInputTokens,
            cacheWriteTokens: assistantEvent.data.usage.cacheCreationInputTokens,
          },
          model: assistantEvent.data.model,
        });

        if (this.config.emitDetailedProgress) {
          this.emit('turn_completed', {
            sessionId: session.sessionId,
            executionId,
            tier: monitored.tier,
            turnIndex: assistantEvent.data.turnIndex,
            usage: assistantEvent.data.usage,
          });
        }
        break;
      }

      case 'sdk_result': {
        const resultEvent = event as SdkResultEvent;
        this.sessionStore.updateProgress(session.sessionId, {
          turnCount: resultEvent.data.numTurns,
          costUsd: resultEvent.data.totalCostUsd,
          usage: {
            inputTokens: resultEvent.data.usage.inputTokens,
            outputTokens: resultEvent.data.usage.outputTokens,
            cacheReadTokens: resultEvent.data.usage.cacheReadInputTokens,
            cacheWriteTokens: resultEvent.data.usage.cacheCreationInputTokens,
          },
        });
        break;
      }

      case 'sdk_user_input': {
        const questionEvent = event as SdkUserQuestionEvent;
        if (questionEvent.action === 'question' && !questionEvent.data.answers) {
          // Waiting for user input
          this.sessionStore.markWaiting(session.sessionId, 'user_question');
          this.emit('waiting_for_input', {
            sessionId: session.sessionId,
            executionId,
            tier: monitored.tier,
            type: 'user_question',
            questions: questionEvent.data.questions,
          });
        } else if (questionEvent.data.answers) {
          // Input received
          this.sessionStore.resumeFromWaiting(session.sessionId);
        }
        break;
      }

      case 'sdk_hook': {
        if ((event as SdkPermissionRequestEvent).hookType === 'PermissionRequest') {
          const permEvent = event as SdkPermissionRequestEvent;
          if (!permEvent.data.decision) {
            // Waiting for permission
            this.sessionStore.markWaiting(session.sessionId, 'permission_request');
            this.emit('waiting_for_input', {
              sessionId: session.sessionId,
              executionId,
              tier: monitored.tier,
              type: 'permission_request',
              toolName: permEvent.data.toolName,
            });
          } else {
            // Permission granted/denied
            this.sessionStore.resumeFromWaiting(session.sessionId);
          }
        }
        break;
      }
    }
  }

  private handleBlockingEvent(event: { type: string; request: unknown }): void {
    // Already handled in handleSdkEvent via sdk_user_input and sdk_hook events
    // This is for additional handling if needed
  }

  private handleCompletion(executionId: string, result: {
    success: boolean;
    result: string;
    sessionId: string;
    error?: string;
    totalCostUsd: number;
    numTurns: number;
    durationMs: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    };
  }): void {
    const monitored = this.monitoredExecutions.get(executionId);
    if (!monitored) return;

    const session = monitored.session;
    const status: SessionStatus = result.success ? 'completed' : 'failed';

    this.sessionStore.updateProgress(session.sessionId, {
      turnCount: result.numTurns,
      costUsd: result.totalCostUsd,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadInputTokens,
        cacheWriteTokens: result.usage.cacheCreationInputTokens,
      },
    });

    this.sessionStore.updateStatus(session.sessionId, status, {
      result: result.result,
      error: result.error,
    });

    this.monitoredExecutions.delete(executionId);

    const completionEvent: CompletionEvent = {
      sessionId: session.sessionId,
      executionId,
      tier: monitored.tier,
      success: result.success,
      result: result.result,
      error: result.error,
      durationMs: result.durationMs,
      turnCount: result.numTurns,
      costUsd: result.totalCostUsd,
    };

    this.emit('session_completed', completionEvent);
  }

  private handleError(executionId: string, error: Error): void {
    const monitored = this.monitoredExecutions.get(executionId);
    if (!monitored) return;

    this.sessionStore.updateStatus(monitored.session.sessionId, 'failed', {
      error: error.message || String(error),
    });

    this.monitoredExecutions.delete(executionId);

    this.emit('session_failed', {
      sessionId: monitored.session.sessionId,
      executionId,
      tier: monitored.tier,
      error: error.message || String(error),
    });
  }

  // --------------------------------------------------------------------------
  // Progress Updates
  // --------------------------------------------------------------------------

  private emitProgressUpdates(): void {
    for (const [executionId, monitored] of this.monitoredExecutions) {
      if (!monitored.handle.isRunning()) continue;

      const session = this.sessionStore.getSession(monitored.session.sessionId);
      if (!session) continue;

      const progressEvent: ProgressEvent = {
        sessionId: session.sessionId,
        executionId,
        tier: monitored.tier,
        status: session.status,
        turnCount: session.turnCount,
        elapsedMs: Date.now() - monitored.startTime.getTime(),
        usage: {
          inputTokens: session.usage.inputTokens,
          outputTokens: session.usage.outputTokens,
        },
        costUsd: session.costUsd,
      };

      this.emit('progress', progressEvent);
    }
  }

  // --------------------------------------------------------------------------
  // Convenience Methods
  // --------------------------------------------------------------------------

  /**
   * Wait for all monitored executions to complete
   */
  async waitForAll(): Promise<CompletionEvent[]> {
    const results: CompletionEvent[] = [];

    const promises = Array.from(this.monitoredExecutions.values()).map(async monitored => {
      try {
        const result = await monitored.handle.result;
        return {
          sessionId: monitored.session.sessionId,
          executionId: monitored.handle.executionId,
          tier: monitored.tier,
          success: result.success,
          result: result.result,
          error: result.error,
          durationMs: result.durationMs,
          turnCount: result.numTurns,
          costUsd: result.totalCostUsd,
        } as CompletionEvent;
      } catch (err) {
        return {
          sessionId: monitored.session.sessionId,
          executionId: monitored.handle.executionId,
          tier: monitored.tier,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - monitored.startTime.getTime(),
          turnCount: 0,
          costUsd: 0,
        } as CompletionEvent;
      }
    });

    const completedResults = await Promise.all(promises);
    results.push(...completedResults);

    return results;
  }

  /**
   * Wait for a specific execution to complete
   */
  async waitForExecution(executionId: string): Promise<CompletionEvent | null> {
    const monitored = this.monitoredExecutions.get(executionId);
    if (!monitored) return null;

    try {
      const result = await monitored.handle.result;
      return {
        sessionId: monitored.session.sessionId,
        executionId,
        tier: monitored.tier,
        success: result.success,
        result: result.result,
        error: result.error,
        durationMs: result.durationMs,
        turnCount: result.numTurns,
        costUsd: result.totalCostUsd,
      };
    } catch (err) {
      return {
        sessionId: monitored.session.sessionId,
        executionId,
        tier: monitored.tier,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - monitored.startTime.getTime(),
        turnCount: 0,
        costUsd: 0,
      };
    }
  }

  /**
   * Get summary of all monitored executions
   */
  getSummary(): {
    total: number;
    running: number;
    waiting: number;
    completed: number;
    failed: number;
    byTier: Record<string, number>;
  } {
    const summary = {
      total: this.monitoredExecutions.size,
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      byTier: {} as Record<string, number>,
    };

    for (const monitored of this.monitoredExecutions.values()) {
      const session = this.sessionStore.getSession(monitored.session.sessionId);
      if (!session) continue;

      summary.byTier[monitored.tier] = (summary.byTier[monitored.tier] || 0) + 1;

      switch (session.status) {
        case 'running':
        case 'initializing':
          summary.running++;
          break;
        case 'waiting':
          summary.waiting++;
          break;
        case 'completed':
          summary.completed++;
          break;
        case 'failed':
        case 'aborted':
        case 'timeout':
          summary.failed++;
          break;
      }
    }

    return summary;
  }

  /**
   * Stop the monitor
   */
  stop(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    this.removeAllListeners();
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createAgentSessionMonitor(config: SessionMonitorConfig): AgentSessionMonitor {
  return new AgentSessionMonitor(config);
}
