/**
 * Agent API Types
 *
 * Types for the /agent endpoints that expose full Claude Agent SDK options.
 * These endpoints provide direct access to SDK features like model selection,
 * system prompts, hooks, permission modes, and more.
 */

import type { TierName } from './instruction-protocol';
import type {
  PermissionRequest,
  PermissionResponse,
  UserQuestionRequest,
  UserQuestionResponse,
} from './sdk-event-handlers';

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Model shorthand names (SDK shortcuts)
 */
export type ModelShorthand = 'opus' | 'sonnet' | 'haiku';

/**
 * Full model IDs (for explicit selection)
 */
export type ModelId =
  | 'claude-opus-4-6'
  | 'claude-opus-4-5-20251101'
  | 'claude-sonnet-4-20250514'
  | 'claude-haiku-4-5-20241022'
  | string; // Allow custom model IDs

/**
 * Model selection can be shorthand or full ID
 * Named AgentModelSelection to avoid conflict with visual-editor's ModelSelection
 */
export type AgentModelSelection = ModelShorthand | ModelId;

// ============================================================================
// System Prompt Configuration
// ============================================================================

/**
 * Preset system prompt types
 */
export type SystemPromptPreset = 'claude_code';

/**
 * System prompt configuration - can be:
 * - A preset with optional append
 * - A custom string
 */
export type SystemPromptConfig =
  | { type: 'preset'; preset: SystemPromptPreset; append?: string }
  | { type: 'custom'; content: string }
  | string; // Simple string is treated as custom

// ============================================================================
// Permission Configuration
// ============================================================================

/**
 * SDK permission modes
 */
export type AgentPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/**
 * Default behavior when no handler responds
 */
export type DefaultPermissionBehavior = 'allow' | 'deny' | 'prompt';

/**
 * Default strategy for unanswered questions
 */
export type DefaultAnswerStrategy = 'first_option' | 'skip';

// ============================================================================
// Setting Sources
// ============================================================================

/**
 * Sources for loading settings
 */
export type SettingSource = 'project' | 'user';

// ============================================================================
// MCP Server Configuration
// ============================================================================

/**
 * MCP stdio server configuration (command-line servers)
 */
export interface McpStdioServerConfig {
  type?: 'stdio';
  /** Command to run (e.g., 'node', 'npx', 'python') */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
}

/**
 * MCP SSE (Server-Sent Events) server configuration
 */
export interface McpSSEServerConfig {
  type: 'sse';
  /** SSE endpoint URL */
  url: string;
  /** HTTP headers to include in requests */
  headers?: Record<string, string>;
}

/**
 * MCP HTTP server configuration
 */
export interface McpHttpServerConfig {
  type: 'http';
  /** HTTP endpoint URL */
  url: string;
  /** HTTP headers to include in requests */
  headers?: Record<string, string>;
}

/**
 * Union of all MCP server configuration types
 */
export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

/**
 * MCP servers configuration map
 * Keys are server names, values are server configurations
 *
 * @example
 * ```typescript
 * mcpServers: {
 *   'my-server': {
 *     command: 'node',
 *     args: ['./my-mcp-server.js'],
 *     env: { API_KEY: 'xxx' }
 *   },
 *   'sentry': {
 *     type: 'http',
 *     url: 'https://mcp.sentry.dev/mcp',
 *     headers: { 'Authorization': 'Bearer token' }
 *   }
 * }
 * ```
 */
export type McpServersConfig = Record<string, McpServerConfig>;

// ============================================================================
// Hooks Configuration
// ============================================================================

/**
 * Hook types available in the SDK
 */
export type HookType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PermissionRequest';

/**
 * Hook configuration for API (serializable)
 * For HTTP APIs, hooks are defined as patterns/rules rather than functions
 */
export interface HookRule {
  /** Hook type to trigger on */
  hookType: HookType;
  /** Tool name pattern to match (glob or exact) */
  toolPattern?: string;
  /** Action to take when hook triggers */
  action: 'allow' | 'block' | 'log' | 'modify';
  /** Reason for the action (shown to user/logged) */
  reason?: string;
  /** Modified input (for 'modify' action) */
  modifiedInput?: Record<string, unknown>;
}

/**
 * Hooks configuration for agent execution
 */
export interface AgentHooksConfig {
  /** Auto-approved tools (bypass permission checks) */
  autoApprovedTools?: string[];
  /** Denied tools (always blocked) */
  deniedTools?: string[];
  /** Hook rules for custom behavior */
  rules?: HookRule[];
  /** Default behavior when no rule matches */
  defaultPermissionBehavior?: DefaultPermissionBehavior;
  /** Default strategy for unanswered questions */
  defaultAnswerStrategy?: DefaultAnswerStrategy;
  /** Timeout for handler responses (ms) */
  handlerTimeout?: number;
}

// ============================================================================
// Extended Thinking Configuration
// ============================================================================

/**
 * Effort level controlling how eagerly Claude spends tokens.
 * Available on all models; 'max' is Opus 4.6 only.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Output configuration (replaces deprecated output_format).
 * Controls effort and output format.
 */
export interface OutputConfig {
  /** Effort level for token usage (default: 'high') */
  effort?: EffortLevel;
  /** Output format: 'json' for simple JSON, or a JSON schema for structured outputs */
  format?: 'json' | { type: 'json_schema'; schema: Record<string, unknown> };
}

/**
 * Data residency controls for inference.
 */
export type InferenceGeo = 'global' | 'us';

/**
 * Extended thinking configuration for enabling Claude's reasoning mode
 *
 * When enabled, Claude will show its reasoning process through thinking blocks.
 * This is useful for complex tasks that benefit from step-by-step reasoning.
 *
 * Note: Extended thinking requires compatible models (opus, sonnet).
 * Haiku does not support extended thinking.
 *
 * Opus 4.6+ supports adaptive thinking where Claude decides when and how much to think.
 */
export interface ExtendedThinkingConfig {
  /**
   * Enable extended thinking mode
   * When true, Claude will output thinking blocks showing its reasoning
   */
  enabled: boolean;

  /**
   * Budget for thinking tokens (required when type is 'enabled')
   * This limits how many tokens Claude can use for reasoning.
   * Recommended: 10000-50000 for complex tasks
   * Minimum: 1024
   */
  budgetTokens?: number;

  /**
   * Thinking type: 'enabled' (legacy with budget_tokens) or 'adaptive' (Opus 4.6+)
   * When 'adaptive', Claude decides when and how much to think based on complexity.
   * The effort parameter acts as soft guidance instead of budget_tokens.
   * @default 'enabled' for backward compatibility
   */
  type?: 'enabled' | 'adaptive';
}

// ============================================================================
// Agent Execute Request
// ============================================================================

/**
 * Full agent execute request with all SDK options
 */
export interface AgentExecuteRequest {
  /** The prompt to execute */
  prompt: string;

  /** Working directory for the agent */
  cwd?: string;

  /** Model selection (shorthand or full ID) */
  model?: AgentModelSelection;

  /** System prompt configuration */
  systemPrompt?: SystemPromptConfig;

  /** Setting sources for loading CLAUDE.md and user settings */
  settingSources?: SettingSource[];

  /** Permission mode for tool execution */
  permissionMode?: AgentPermissionMode;

  /** Maximum number of turns before stopping */
  maxTurns?: number;

  /** Maximum budget in USD before stopping */
  maxBudgetUsd?: number;

  /** Allowed tools (whitelist) */
  allowedTools?: string[];

  /** Disallowed tools (blacklist) */
  disallowedTools?: string[];

  /** Hooks configuration */
  hooks?: AgentHooksConfig;

  /** MCP servers to load for this execution */
  mcpServers?: McpServersConfig;

  /** Timeout in milliseconds */
  timeout?: number;

  /** Execution ID for tracking */
  executionId?: string;

  /** Tier context for events */
  tier?: TierName;

  /** Run in background (returns immediately) */
  background?: boolean;

  /** Additional context to append to prompt */
  context?: string;

  /**
   * Extended thinking configuration
   * Enables Claude's reasoning mode with thinking blocks
   *
   * @example
   * ```typescript
   * // Legacy (all models):
   * extendedThinking: { enabled: true, budgetTokens: 10000 }
   *
   * // Adaptive (Opus 4.6+):
   * extendedThinking: { enabled: true, type: 'adaptive' }
   * ```
   */
  extendedThinking?: ExtendedThinkingConfig;

  /**
   * Output configuration (effort level and format)
   * Replaces deprecated output_format parameter.
   *
   * @example
   * ```typescript
   * outputConfig: { effort: 'medium' }
   * outputConfig: { effort: 'high', format: 'json' }
   * ```
   */
  outputConfig?: OutputConfig;

  /**
   * Data residency controls for inference
   * 'us' restricts inference to US infrastructure (1.1x pricing multiplier)
   * @default 'global'
   */
  inferenceGeo?: InferenceGeo;
}

/**
 * Session resume request
 */
export interface AgentResumeRequest extends Omit<AgentExecuteRequest, 'systemPrompt' | 'settingSources'> {
  /** Session ID to resume */
  sessionId: string;
}

// ============================================================================
// Agent Execute Response
// ============================================================================

/**
 * Token usage in agent response
 */
export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
}

/**
 * File change tracked during execution
 */
export interface AgentFileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  diff?: string;
}

/**
 * Agent execute response
 */
export interface AgentExecuteResponse {
  /** Whether execution succeeded */
  success: boolean;

  /** Result text from the agent */
  result: string;

  /** Session ID (for resuming) */
  sessionId: string;

  /** Execution ID */
  executionId: string;

  /** Total duration in ms */
  durationMs: number;

  /** API call duration in ms */
  durationApiMs: number;

  /** Number of turns */
  numTurns: number;

  /** Total cost in USD */
  totalCostUsd: number;

  /** Token usage */
  usage: AgentTokenUsage;

  /** Per-model usage */
  modelUsage: Record<string, AgentTokenUsage>;

  /** Error message if failed */
  error?: string;

  /** File changes during execution */
  fileChanges?: AgentFileChange[];
}

/**
 * Background execution response (returns immediately)
 */
export interface AgentBackgroundResponse {
  /** Execution ID for tracking */
  executionId: string;

  /** Session ID (may not be available immediately) */
  sessionId?: string;

  /** Status */
  status: 'started' | 'queued';

  /** URL to poll for status */
  statusUrl: string;

  /** URL to poll for result (waits for completion) */
  resultUrl: string;
}

// ============================================================================
// Execution Status Types (for async/background execution polling)
// ============================================================================

/**
 * Execution status for polling
 */
export type AgentExecutionStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Execution status response (for polling /agent/execution/:id)
 */
export interface AgentExecutionStatusResponse {
  /** Execution ID */
  executionId: string;

  /** Session ID (available once execution starts) */
  sessionId?: string;

  /** Current status */
  status: AgentExecutionStatus;

  /** Whether execution is still running */
  isRunning: boolean;

  /** Tier context */
  tier?: TierName;

  /** When execution started */
  startedAt: Date;

  /** When execution ended (if completed) */
  endedAt?: Date;

  /** URL to Claude Code session (for progress details) */
  claudeSessionUrl?: string;
}

/**
 * Execution result response (returns when completed, or waits)
 */
export interface AgentExecutionResultResponse {
  /** Execution ID */
  executionId: string;

  /** Whether execution completed (false if still running and wait=false) */
  completed: boolean;

  /** The full result (only present if completed) */
  result?: AgentExecuteResponse;

  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Agent Session Types
// ============================================================================

/**
 * Agent session status
 */
export type AgentSessionStatus =
  | 'pending'
  | 'initializing'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'timeout';

/**
 * Agent session info
 */
export interface AgentSessionInfo {
  /** Session ID */
  sessionId: string;

  /** Execution ID */
  executionId: string;

  /** Current status */
  status: AgentSessionStatus;

  /** Tier context */
  tier?: TierName;

  /** When session started */
  startedAt: Date;

  /** When session ended (if completed) */
  endedAt?: Date;

  /** Number of turns so far */
  turnCount: number;

  /** Cost so far in USD */
  costUsd: number;

  /** Token usage so far */
  usage: AgentTokenUsage;

  /** If waiting, what it's waiting for */
  waitingFor?: 'permission' | 'question' | 'input';

  /** Pending permission request */
  pendingPermission?: PermissionRequest;

  /** Pending question */
  pendingQuestion?: UserQuestionRequest;
}

/**
 * Response for permission action
 */
export interface AgentPermissionActionResponse {
  success: boolean;
  sessionId: string;
  toolName: string;
  action: 'allowed' | 'denied';
}

/**
 * Response for question answer
 */
export interface AgentQuestionAnswerResponse {
  success: boolean;
  sessionId: string;
  answers: Record<string, string | string[]>;
}

// ============================================================================
// Agent API Interface
// ============================================================================

/**
 * Agent API methods
 */
export interface AgentApi {
  /**
   * Execute a prompt with full SDK options
   */
  execute(request: AgentExecuteRequest): Promise<AgentExecuteResponse | AgentBackgroundResponse>;

  /**
   * Resume an existing session
   */
  resume(request: AgentResumeRequest): Promise<AgentExecuteResponse | AgentBackgroundResponse>;

  /**
   * Get execution status (for background executions)
   * Returns current status without waiting
   */
  getExecution(executionId: string): Promise<AgentExecutionStatusResponse | null>;

  /**
   * Get execution result (waits for completion if wait=true)
   * @param executionId The execution ID
   * @param wait If true, waits for completion. If false, returns immediately with completed=false if still running
   * @param timeoutMs Optional timeout in milliseconds (only used if wait=true)
   */
  getExecutionResult(executionId: string, wait?: boolean, timeoutMs?: number): Promise<AgentExecutionResultResponse>;

  /**
   * List active executions
   */
  listExecutions(): Promise<AgentExecutionStatusResponse[]>;

  /**
   * Get session status
   */
  getSession(sessionId: string): Promise<AgentSessionInfo | null>;

  /**
   * List active sessions
   */
  listSessions(options?: { tier?: TierName; status?: AgentSessionStatus[] }): Promise<AgentSessionInfo[]>;

  /**
   * Abort a running session
   */
  abort(sessionId: string): Promise<{ success: boolean; sessionId: string }>;

  /**
   * Respond to a pending permission request
   */
  respondToPermission(sessionId: string, response: PermissionResponse): Promise<AgentPermissionActionResponse>;

  /**
   * Answer a pending question
   */
  answerQuestion(sessionId: string, requestId: string, answers: Record<string, string | string[]>): Promise<AgentQuestionAnswerResponse>;
}

// ============================================================================
// HTTP Request/Response Types (for REST API)
// ============================================================================

/**
 * POST /agent/execute request body
 */
export type AgentExecuteRequestBody = AgentExecuteRequest;

/**
 * POST /agent/session/:sessionId/resume request body
 */
export type AgentResumeRequestBody = Omit<AgentResumeRequest, 'sessionId'>;

/**
 * POST /agent/session/:sessionId/permission request body
 */
export interface AgentPermissionRequestBody {
  /** The request ID from the permission request event */
  requestId: string;
  /** The behavior: allow or deny */
  behavior: 'allow' | 'deny';
  /** Modified input (optional) */
  updatedInput?: Record<string, unknown>;
  /** Denial reason (optional) */
  message?: string;
}

/**
 * POST /agent/session/:sessionId/answer request body
 */
export interface AgentAnswerRequestBody {
  /** The request ID from the user question event */
  requestId: string;
  /** Answers keyed by question text */
  answers: Record<string, string | string[]>;
}

/**
 * GET /agent/sessions query parameters
 */
export interface AgentSessionsQuery {
  tier?: TierName;
  status?: string; // Comma-separated AgentSessionStatus values
}
