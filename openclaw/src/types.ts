/**
 * OpenClaw Plugin Types for lm-assist
 *
 * Shared types for the channel plugin, API client, session mapping,
 * event bridge, and message handler.
 */

// ============================================================================
// Account & Configuration
// ============================================================================

/**
 * lm-assist account configuration (per OpenClaw account)
 */
export interface LmAssistAccount {
  /** lm-assist API base URL */
  apiUrl: string;
  /** Default project path for Claude Code executions */
  project?: string;
  /** Whether this account is enabled */
  enabled: boolean;
}

/**
 * Resolved account with runtime state
 */
export interface ResolvedAccount extends LmAssistAccount {
  /** Account ID */
  accountId: string;
}

/**
 * Notification verbosity level
 */
export type NotificationLevel = 'minimal' | 'normal' | 'verbose';

/**
 * Notification configuration
 */
export interface NotificationConfig {
  /** Send progress updates */
  progress: boolean;
  /** Send tool use details */
  toolUse: boolean;
  /** Send task list changes */
  taskUpdates: boolean;
  /** Minimum interval between progress notifications (ms) */
  minIntervalMs: number;
  /** Verbosity level */
  level: NotificationLevel;
}

/**
 * Full OpenClaw channel configuration for lm-assist
 */
export interface OpenClawChannelConfig {
  /** Whether the channel is enabled */
  enabled: boolean;
  /** lm-assist API URL */
  apiUrl: string;
  /** DM policy */
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  /** Allowed sender IDs */
  allowFrom: string[];
  /** Default project path */
  defaultProject?: string;
  /** Notification settings */
  notifications: NotificationConfig;
  /** Per-account overrides */
  accounts: Record<string, LmAssistAccount>;
}

// ============================================================================
// Session Mapping
// ============================================================================

/**
 * Session state for a chat user
 */
export type SessionState =
  | 'idle'
  | 'executing'
  | 'waiting_permission'
  | 'waiting_question';

/**
 * Session mapping entry (peerId → session info)
 */
export interface SessionMapping {
  /** Claude Code session ID */
  sessionId: string;
  /** Execution ID for tracking */
  executionId: string;
  /** Project path */
  project: string;
  /** Current state */
  state: SessionState;
  /** When this mapping was created */
  createdAt: string;
  /** Last activity timestamp */
  lastActivityAt: string;
  /** Pending permission request ID (when waiting_permission) */
  pendingPermissionRequestId?: string;
  /** Pending question request ID (when waiting_question) */
  pendingQuestionRequestId?: string;
}

// ============================================================================
// Chat Commands
// ============================================================================

/**
 * Recognized chat commands
 */
export type ChatCommandType =
  | 'status'
  | 'sessions'
  | 'abort'
  | 'project'
  | 'history'
  | 'tasks'
  | 'allow'
  | 'deny'
  | 'help';

/**
 * Parsed chat command
 */
export interface ChatCommand {
  type: ChatCommandType;
  args: string[];
  raw: string;
}

// ============================================================================
// lm-assist API Types (subset needed by plugin)
// ============================================================================

/**
 * Agent execute request (matches core AgentExecuteRequest)
 */
export interface ExecuteRequest {
  prompt: string;
  cwd?: string;
  model?: string;
  background?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  executionId?: string;
  context?: string;
  hooks?: {
    defaultPermissionBehavior?: 'allow' | 'deny' | 'prompt';
    defaultAnswerStrategy?: 'first_option' | 'skip';
    handlerTimeout?: number;
  };
}

/**
 * Background execution response
 */
export interface BackgroundResponse {
  executionId: string;
  sessionId?: string;
  status: 'started' | 'queued';
  statusUrl: string;
  resultUrl: string;
}

/**
 * Execution status response
 */
export interface ExecutionStatus {
  executionId: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  isRunning: boolean;
  startedAt: string;
  endedAt?: string;
}

/**
 * Execution result response
 */
export interface ExecutionResult {
  executionId: string;
  completed: boolean;
  result?: {
    success: boolean;
    result: string;
    sessionId: string;
    executionId: string;
    durationMs: number;
    numTurns: number;
    totalCostUsd: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    error?: string;
  };
  error?: string;
}

/**
 * Session info from agent API
 */
export interface AgentSessionInfo {
  sessionId: string;
  executionId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  turnCount: number;
  costUsd: number;
  waitingFor?: 'permission' | 'question' | 'input';
}

/**
 * Conversation message
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  turnIndex: number;
  content: string;
  timestamp?: string;
}

/**
 * Conversation response
 */
export interface ConversationResponse {
  sessionId: string;
  totalMessages: number;
  returnedMessages: number;
  messages: ConversationMessage[];
  totalCostUsd: number;
}

// ============================================================================
// SSE Event Types (subset for event bridge)
// ============================================================================

export interface SseExecutionStart {
  type: 'execution_start';
  executionId: string;
  tier: string;
  prompt: string;
}

export interface SseExecutionProgress {
  type: 'execution_progress';
  executionId: string;
  tier: string;
  currentStep: number;
  totalSteps: number;
  stepDescription: string;
  progressPercent: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number;
  vibeMessage: string;
}

export interface SseExecutionComplete {
  type: 'execution_complete';
  executionId: string;
  tier: string;
  success: boolean;
  result?: string;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
}

export interface SseExecutionError {
  type: 'execution_error';
  executionId: string;
  tier: string;
  error: string;
}

export interface SseUserQuestion {
  type: 'sdk_user_question';
  executionId: string;
  tier: string;
  sessionId: string;
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
  timeout?: number;
}

export interface SsePermissionRequest {
  type: 'sdk_permission_request';
  executionId: string;
  tier: string;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface SseToolUse {
  type: 'sdk_tool_use';
  executionId: string;
  tier: string;
  toolName: string;
  toolUseId: string;
}

export interface SseToolResult {
  type: 'sdk_tool_result';
  executionId: string;
  tier: string;
  toolName: string;
  toolUseId: string;
  success: boolean;
  durationMs: number;
}

export type SseEvent =
  | SseExecutionStart
  | SseExecutionProgress
  | SseExecutionComplete
  | SseExecutionError
  | SseUserQuestion
  | SsePermissionRequest
  | SseToolUse
  | SseToolResult;

// ============================================================================
// Outbound Message Types
// ============================================================================

/**
 * Message to send to a chat user via OpenClaw
 */
export interface OutboundMessage {
  /** Target peer ID (chat user) */
  peerId: string;
  /** Message text */
  text: string;
  /** Whether this is a reply to a specific message */
  replyTo?: string;
}

/**
 * Inbound message from a chat user via OpenClaw
 */
export interface InboundMessage {
  /** Sender peer ID */
  peerId: string;
  /** Message text */
  text: string;
  /** Channel (whatsapp, telegram, discord, etc.) */
  channel: string;
  /** Account ID */
  accountId: string;
  /** Message ID (for reply threading) */
  messageId?: string;
  /** Timestamp */
  timestamp: string;
}
