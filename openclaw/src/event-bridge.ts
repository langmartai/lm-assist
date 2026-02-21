/**
 * Event Bridge
 *
 * Hybrid approach for monitoring lm-assist executions:
 * - SSE subscription to /stream for real-time blocking events
 *   (sdk_user_question, sdk_permission_request)
 * - Polling /agent/execution/:id for execution lifecycle
 *   (status, completion, errors)
 *
 * This design works because:
 * - Blocking events (questions/permissions) are forwarded to SSE by control-api
 * - Execution lifecycle is tracked via the agent API background execution system
 */

import http from 'http';
import https from 'https';
import type {
  SseEvent,
  SseUserQuestion,
  SsePermissionRequest,
  OutboundMessage,
  NotificationConfig,
} from './types';
import type { LmAssistClient } from './api-client';
import {
  formatExecutionComplete,
  formatUserQuestion,
  formatPermissionRequest,
  formatToolUse,
  chunkMessage,
} from './formatter';
import type { SessionMap } from './session-map';

/**
 * Callback to send a message to a chat user
 */
export type SendCallback = (message: OutboundMessage) => Promise<void>;

/**
 * Callback when a blocking event (question/permission) arrives
 */
export type BlockingEventCallback = (
  peerId: string,
  event: SseUserQuestion | SsePermissionRequest
) => void;

interface ActiveExecution {
  /** Execution ID */
  executionId: string;
  /** Peer ID (chat user) */
  peerId: string;
  /** Polling interval timer */
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Last known status */
  lastStatus: string;
}

interface ActiveStream {
  /** The http.ClientRequest (for cleanup) */
  request: http.ClientRequest;
}

export class EventBridge {
  private executions = new Map<string, ActiveExecution>();
  private sseStream: ActiveStream | null = null;
  private sendCallback: SendCallback;
  private blockingCallback: BlockingEventCallback;
  private sessionMap: SessionMap;
  private config: NotificationConfig;
  private apiClient: LmAssistClient;
  private streamBaseUrl: string;

  constructor(options: {
    apiUrl: string;
    apiClient: LmAssistClient;
    sendCallback: SendCallback;
    blockingCallback: BlockingEventCallback;
    sessionMap: SessionMap;
    notificationConfig: NotificationConfig;
  }) {
    this.streamBaseUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiClient = options.apiClient;
    this.sendCallback = options.sendCallback;
    this.blockingCallback = options.blockingCallback;
    this.sessionMap = options.sessionMap;
    this.config = options.notificationConfig;
  }

  // ============================================================================
  // Execution Tracking
  // ============================================================================

  /**
   * Start monitoring an execution (SSE + polling)
   */
  subscribe(executionId: string, peerId: string): void {
    // Stop any existing monitoring for this execution
    this.unsubscribe(executionId);

    // Start polling for execution status
    const pollInterval = Math.max(this.config.minIntervalMs, 3000);
    const pollTimer = setInterval(() => {
      this.pollExecutionStatus(executionId, peerId);
    }, pollInterval);

    this.executions.set(executionId, {
      executionId,
      peerId,
      pollTimer,
      lastStatus: 'running',
    });

    // Ensure SSE stream is connected for blocking events
    this.ensureSseStream();
  }

  /**
   * Stop monitoring an execution
   */
  unsubscribe(executionId: string): void {
    const exec = this.executions.get(executionId);
    if (exec) {
      if (exec.pollTimer) clearInterval(exec.pollTimer);
      this.executions.delete(executionId);
    }

    // Disconnect SSE if no more executions
    if (this.executions.size === 0) {
      this.disconnectSse();
    }
  }

  /**
   * Stop all monitoring
   */
  unsubscribeAll(): void {
    for (const [id] of this.executions) {
      this.unsubscribe(id);
    }
    this.disconnectSse();
  }

  /**
   * Get count of active executions
   */
  get activeCount(): number {
    return this.executions.size;
  }

  // ============================================================================
  // Polling (Execution Lifecycle)
  // ============================================================================

  private async pollExecutionStatus(executionId: string, peerId: string): Promise<void> {
    const exec = this.executions.get(executionId);
    if (!exec) return;

    try {
      const status = await this.apiClient.getExecutionStatus(executionId);
      if (!status) return;

      // Update session ID if now available
      if (status.sessionId) {
        this.sessionMap.updateSessionId(peerId, status.sessionId);
      }

      // Check for completion
      if (!status.isRunning && exec.lastStatus === 'running') {
        exec.lastStatus = status.status;

        // Fetch the result for the completion message
        const result = await this.apiClient.getExecutionResult(executionId);
        if (result?.completed && result.result) {
          const text = formatExecutionComplete({
            type: 'execution_complete',
            executionId,
            tier: 'agent',
            success: result.result.success,
            result: result.result.result,
            sessionId: result.result.sessionId,
            durationMs: result.result.durationMs,
            costUsd: result.result.totalCostUsd,
            numTurns: result.result.numTurns,
          }, this.config.level);
          this.send(peerId, text);
        } else if (result?.error) {
          this.send(peerId, `*Error:* ${result.error}`);
        }

        // Clean up
        this.sessionMap.complete(peerId);
        this.unsubscribe(executionId);
      }
    } catch {
      // Ignore poll errors — will retry next interval
    }
  }

  // ============================================================================
  // SSE Stream (Blocking Events)
  // ============================================================================

  /**
   * Connect to the global SSE stream for blocking events
   */
  private ensureSseStream(): void {
    if (this.sseStream) return;

    const url = `${this.streamBaseUrl}/stream`;
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;

    const req = httpModule.get(url, {
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          this.processSSEMessage(part);
        }
      });

      res.on('end', () => {
        this.sseStream = null;
        // Reconnect if we still have active executions
        if (this.executions.size > 0) {
          setTimeout(() => this.ensureSseStream(), 3000);
        }
      });

      res.on('error', () => {
        this.sseStream = null;
      });
    });

    req.on('error', () => {
      this.sseStream = null;
    });

    this.sseStream = { request: req };
  }

  private disconnectSse(): void {
    if (this.sseStream) {
      this.sseStream.request.destroy();
      this.sseStream = null;
    }
  }

  // ============================================================================
  // SSE Parsing
  // ============================================================================

  private processSSEMessage(raw: string): void {
    let eventType = '';
    let dataStr = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr += line.slice(6);
      } else if (line.startsWith(':')) {
        return; // Comment/ping
      }
    }

    if (!dataStr || !eventType) return;

    let data: SseEvent;
    try {
      data = JSON.parse(dataStr) as SseEvent;
    } catch {
      return;
    }

    // Only handle blocking events — lifecycle is handled by polling
    this.handleSseEvent(data);
  }

  private handleSseEvent(event: SseEvent): void {
    // Find the peer for this execution
    const executionId = 'executionId' in event ? (event as any).executionId : null;
    if (!executionId) return;

    const exec = this.executions.get(executionId);
    if (!exec) return;

    const peerId = exec.peerId;

    switch (event.type) {
      case 'sdk_user_question':
        this.handleUserQuestion(event as SseUserQuestion, peerId);
        break;
      case 'sdk_permission_request':
        this.handlePermissionRequest(event as SsePermissionRequest, peerId);
        break;
      case 'sdk_tool_use':
        if (this.config.toolUse) {
          const text = formatToolUse(event as any);
          this.send(peerId, text);
        }
        break;
      default:
        break;
    }
  }

  // ============================================================================
  // Blocking Event Handlers
  // ============================================================================

  private handleUserQuestion(event: SseUserQuestion, peerId: string): void {
    const text = formatUserQuestion(event);
    this.send(peerId, text);

    this.sessionMap.setPendingQuestion(peerId, event.requestId);
    this.blockingCallback(peerId, event);
  }

  private handlePermissionRequest(event: SsePermissionRequest, peerId: string): void {
    const text = formatPermissionRequest(event);
    this.send(peerId, text);

    this.sessionMap.setPendingPermission(peerId, event.requestId);
    this.blockingCallback(peerId, event);
  }

  // ============================================================================
  // Send
  // ============================================================================

  private send(peerId: string, text: string): void {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      this.sendCallback({ peerId, text: chunk }).catch(() => {
        // Silently ignore send failures
      });
    }
  }
}
