/**
 * lm-assist API Client
 *
 * Typed HTTP client for the lm-assist REST API.
 * Used by the OpenClaw plugin to execute prompts, monitor sessions,
 * and respond to blocking events.
 */

import type {
  ExecuteRequest,
  BackgroundResponse,
  ExecutionStatus,
  ExecutionResult,
  AgentSessionInfo,
  ConversationResponse,
} from './types';

/**
 * API response wrapper (matches lm-assist ApiResponse<T>)
 */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class LmAssistClient {
  private baseUrl: string;

  constructor(apiUrl: string) {
    // Strip trailing slash
    this.baseUrl = apiUrl.replace(/\/+$/, '');
  }

  // ============================================================================
  // Health
  // ============================================================================

  /**
   * Check if lm-assist API is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetch('/health');
      return res.success === true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Agent Execution
  // ============================================================================

  /**
   * Execute a prompt via Claude Code SDK (background mode)
   */
  async execute(
    prompt: string,
    options: Partial<ExecuteRequest> = {}
  ): Promise<BackgroundResponse> {
    const body: ExecuteRequest = {
      ...options,
      prompt,
      background: true,
      hooks: {
        defaultPermissionBehavior: 'prompt',
        defaultAnswerStrategy: 'skip',
        handlerTimeout: 300_000, // 5 min — wait for chat user reply
        ...options.hooks,
      },
    };
    const res = await this.fetch<BackgroundResponse>('/agent/execute', {
      method: 'POST',
      body,
    });
    return this.unwrap(res);
  }

  /**
   * Resume an existing session with a new prompt
   */
  async resume(
    sessionId: string,
    prompt: string,
    options: Partial<ExecuteRequest> = {}
  ): Promise<BackgroundResponse> {
    const body = {
      ...options,
      sessionId,
      prompt,
      background: true,
      hooks: {
        defaultPermissionBehavior: 'prompt' as const,
        defaultAnswerStrategy: 'skip' as const,
        handlerTimeout: 300_000,
        ...options.hooks,
      },
    };
    const res = await this.fetch<BackgroundResponse>('/agent/resume', {
      method: 'POST',
      body,
    });
    return this.unwrap(res);
  }

  // ============================================================================
  // Execution Polling
  // ============================================================================

  /**
   * Get execution status
   */
  async getExecutionStatus(executionId: string): Promise<ExecutionStatus | null> {
    try {
      const res = await this.fetch<ExecutionStatus>(`/agent/execution/${executionId}`);
      return res.data ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get execution result (non-blocking)
   */
  async getExecutionResult(executionId: string): Promise<ExecutionResult | null> {
    try {
      const res = await this.fetch<ExecutionResult>(
        `/agent/execution/${executionId}/result?wait=false`
      );
      return res.data ?? null;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * List active agent sessions
   */
  async listSessions(): Promise<AgentSessionInfo[]> {
    const res = await this.fetch<AgentSessionInfo[]>('/agent/sessions');
    return res.data ?? [];
  }

  /**
   * Abort a running session
   */
  async abortSession(sessionId: string): Promise<boolean> {
    try {
      const res = await this.fetch(`/agent/session/${sessionId}/abort`, {
        method: 'POST',
      });
      return res.success === true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Blocking Event Responses
  // ============================================================================

  /**
   * Respond to a pending permission request
   */
  async respondToPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny'
  ): Promise<boolean> {
    try {
      const res = await this.fetch(`/agent/session/${sessionId}/permission`, {
        method: 'POST',
        body: { requestId, behavior },
      });
      return res.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Answer a pending user question
   */
  async answerQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): Promise<boolean> {
    try {
      const res = await this.fetch(`/agent/session/${sessionId}/answer`, {
        method: 'POST',
        body: { requestId, answers },
      });
      return res.success === true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Conversation History
  // ============================================================================

  /**
   * Get session conversation history
   */
  async getConversation(
    sessionId: string,
    options: { lastN?: number; toolDetail?: 'none' | 'summary' | 'full' } = {}
  ): Promise<ConversationResponse | null> {
    const params = new URLSearchParams();
    if (options.lastN) params.set('lastN', String(options.lastN));
    if (options.toolDetail) params.set('toolDetail', options.toolDetail);
    const qs = params.toString();
    const path = `/sessions/${sessionId}/conversation${qs ? '?' + qs : ''}`;
    try {
      const res = await this.fetch<ConversationResponse>(path);
      return res.data ?? null;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // SSE Stream URL
  // ============================================================================

  /**
   * Get the SSE stream URL for an execution
   */
  getStreamUrl(executionId?: string): string {
    const base = `${this.baseUrl}/stream`;
    return executionId ? `${base}?executionId=${executionId}` : base;
  }

  // ============================================================================
  // Internal HTTP
  // ============================================================================

  private async fetch<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (options.body) {
      init.body = JSON.stringify(options.body);
    }

    const response = await globalThis.fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`lm-assist API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<ApiResponse<T>>;
  }

  private unwrap<T>(res: ApiResponse<T>): T {
    if (!res.success || !res.data) {
      const msg = res.error?.message ?? 'Unknown API error';
      throw new Error(`lm-assist API: ${msg}`);
    }
    return res.data;
  }
}
