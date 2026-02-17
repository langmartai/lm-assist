/**
 * SDK Event Types
 *
 * Enhanced event types for Claude Agent SDK integration.
 * These types capture SDK-specific events not present in CLI runner output.
 */

import type { TierName } from './instruction-protocol';

// ============================================================================
// Base Event Types
// ============================================================================

/**
 * Base interface for all SDK events
 */
export interface SdkEventBase {
  /** Event timestamp (ISO 8601) */
  timestamp: string;
  /** Session ID */
  sessionId: string;
  /** Optional tier context */
  tier?: TierName;
  /** Execution ID for grouping events */
  executionId?: string;
}

// ============================================================================
// System Events
// ============================================================================

/**
 * Session initialization event
 */
export interface SdkInitEvent extends SdkEventBase {
  type: 'sdk_init';
  data: {
    cwd: string;
    model: string;
    permissionMode: string;
    tools: string[];
    mcpServers: SdkMcpServerInfo[];
    agents: SdkAgentInfo[];
    slashCommands: string[];
    claudeCodeVersion: string;
    outputStyle: string;
    plugins: string[];
  };
}

/**
 * MCP server info from SDK init
 */
export interface SdkMcpServerInfo {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  tools?: string[];
  serverInfo?: {
    name: string;
    version: string;
  };
}

/**
 * Agent info from SDK init
 */
export interface SdkAgentInfo {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
}

// ============================================================================
// Hook Events
// ============================================================================

/**
 * Hook event types matching SDK hook names
 */
export type SdkHookType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest';

/**
 * Pre-tool use hook event
 */
export interface SdkPreToolUseEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'PreToolUse';
  data: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    decision?: 'allow' | 'block' | 'modify';
    reason?: string;
    modifiedInput?: Record<string, unknown>;
  };
}

/**
 * Post-tool use hook event
 */
export interface SdkPostToolUseEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'PostToolUse';
  data: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolResponse: unknown;
    toolUseId: string;
    durationMs: number;
    success: boolean;
  };
}

/**
 * Post-tool use failure hook event
 */
export interface SdkPostToolUseFailureEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'PostToolUseFailure';
  data: {
    toolName: string;
    toolInput: Record<string, unknown>;
    error: string;
    toolUseId: string;
    recoverable: boolean;
  };
}

/**
 * Session start hook event
 */
export interface SdkSessionStartEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'SessionStart';
  data: {
    isResume: boolean;
    model: string;
    cwd: string;
  };
}

/**
 * Session end hook event
 */
export interface SdkSessionEndEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'SessionEnd';
  data: {
    reason: 'completed' | 'error' | 'timeout' | 'aborted' | 'user_cancelled';
    totalDurationMs: number;
    numTurns: number;
    totalCostUsd: number;
  };
}

/**
 * Stop hook event
 */
export interface SdkStopEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'Stop';
  data: {
    reason: string;
    cleanExit: boolean;
  };
}

/**
 * User prompt submit hook event
 */
export interface SdkUserPromptSubmitEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'UserPromptSubmit';
  data: {
    prompt: string;
    addedContext?: string;
    validated: boolean;
  };
}

/**
 * Pre-compact hook event
 */
export interface SdkPreCompactEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'PreCompact';
  data: {
    tokensBefore: number;
    preservedContext?: string[];
  };
}

/**
 * Permission request hook event
 */
export interface SdkPermissionRequestEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'PermissionRequest';
  data: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    suggestions?: string[];
    decision: 'allow' | 'deny' | 'allow_with_update';
    updatedPermissions?: string[];
  };
}

/**
 * Union of all hook events
 */
export type SdkHookEvent =
  | SdkPreToolUseEvent
  | SdkPostToolUseEvent
  | SdkPostToolUseFailureEvent
  | SdkSessionStartEvent
  | SdkSessionEndEvent
  | SdkStopEvent
  | SdkUserPromptSubmitEvent
  | SdkPreCompactEvent
  | SdkPermissionRequestEvent
  | SdkSubagentStartEvent
  | SdkSubagentStopEvent;

// ============================================================================
// Subagent Events
// ============================================================================

/**
 * Subagent start event
 */
export interface SdkSubagentStartEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'SubagentStart';
  data: {
    agentName: string;
    agentId: string;
    parentSessionId: string;
    description: string;
    prompt: string;
    tools: string[];
    model?: string;
  };
}

/**
 * Subagent stop event
 */
export interface SdkSubagentStopEvent extends SdkEventBase {
  type: 'sdk_hook';
  hookType: 'SubagentStop';
  data: {
    agentName: string;
    agentId: string;
    parentSessionId: string;
    success: boolean;
    result?: string;
    error?: string;
    durationMs: number;
    usage: SdkTokenUsage;
    costUsd: number;
  };
}

// ============================================================================
// MCP Events
// ============================================================================

/**
 * MCP server connection event
 */
export interface SdkMcpConnectEvent extends SdkEventBase {
  type: 'sdk_mcp';
  action: 'connect';
  data: {
    serverName: string;
    serverType: 'stdio' | 'http' | 'sse';
    tools: string[];
    serverInfo: {
      name: string;
      version: string;
    };
  };
}

/**
 * MCP server disconnection event
 */
export interface SdkMcpDisconnectEvent extends SdkEventBase {
  type: 'sdk_mcp';
  action: 'disconnect';
  data: {
    serverName: string;
    reason: 'normal' | 'error' | 'timeout';
    error?: string;
  };
}

/**
 * MCP tool call event
 */
export interface SdkMcpToolCallEvent extends SdkEventBase {
  type: 'sdk_mcp';
  action: 'tool_call';
  data: {
    serverName: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
  };
}

/**
 * MCP tool result event
 */
export interface SdkMcpToolResultEvent extends SdkEventBase {
  type: 'sdk_mcp';
  action: 'tool_result';
  data: {
    serverName: string;
    toolName: string;
    toolUseId: string;
    success: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  };
}

/**
 * Union of all MCP events
 */
export type SdkMcpEvent =
  | SdkMcpConnectEvent
  | SdkMcpDisconnectEvent
  | SdkMcpToolCallEvent
  | SdkMcpToolResultEvent;

// ============================================================================
// User Input Events
// ============================================================================

/**
 * User question event (AskUserQuestion tool)
 */
export interface SdkUserQuestionEvent extends SdkEventBase {
  type: 'sdk_user_input';
  action: 'question';
  data: {
    questions: Array<{
      question: string;
      header: string;
      options: Array<{
        label: string;
        description: string;
      }>;
      multiSelect: boolean;
    }>;
    answers?: Record<string, string | string[]>;
    timeout?: number;
    timedOut?: boolean;
  };
}

/**
 * User confirmation event (for permissions)
 */
export interface SdkUserConfirmationEvent extends SdkEventBase {
  type: 'sdk_user_input';
  action: 'confirmation';
  data: {
    toolName: string;
    description: string;
    confirmed: boolean;
    updatedPermissions?: string[];
  };
}

/**
 * Union of all user input events
 */
export type SdkUserInputEvent = SdkUserQuestionEvent | SdkUserConfirmationEvent;

// ============================================================================
// Message Events (Enhanced)
// ============================================================================

/**
 * Token usage from SDK
 */
export interface SdkTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
}

/**
 * Content block types from SDK messages
 */
export type SdkContentBlockType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'redacted_thinking';

/**
 * Text content block
 */
export interface SdkTextBlock {
  type: 'text';
  text: string;
}

/**
 * Tool use content block
 */
export interface SdkToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content block
 */
export interface SdkToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * Thinking content block
 */
export interface SdkThinkingBlock {
  type: 'thinking';
  thinking: string;
}

/**
 * Content block union
 */
export type SdkContentBlock =
  | SdkTextBlock
  | SdkToolUseBlock
  | SdkToolResultBlock
  | SdkThinkingBlock;

/**
 * Enhanced assistant message event
 */
export interface SdkAssistantMessageEvent extends SdkEventBase {
  type: 'sdk_assistant';
  data: {
    messageId: string;
    model: string;
    content: SdkContentBlock[];
    usage: SdkTokenUsage;
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    turnIndex: number;
  };
}

/**
 * Enhanced result event
 */
export interface SdkResultEvent extends SdkEventBase {
  type: 'sdk_result';
  data: {
    success: boolean;
    subtype: 'success' | 'error' | 'cancelled' | 'timeout';
    result?: string;
    errors?: string[];
    numTurns: number;
    durationMs: number;
    durationApiMs: number;
    totalCostUsd: number;
    usage: SdkTokenUsage;
    modelUsage: Record<string, SdkTokenUsage>;
  };
}

// ============================================================================
// Streaming Events
// ============================================================================

/**
 * Streaming delta event for real-time text output
 */
export interface SdkStreamDeltaEvent extends SdkEventBase {
  type: 'sdk_stream';
  action: 'delta';
  data: {
    blockType: 'text' | 'thinking';
    delta: string;
    blockIndex: number;
  };
}

/**
 * Streaming block start event
 */
export interface SdkStreamBlockStartEvent extends SdkEventBase {
  type: 'sdk_stream';
  action: 'block_start';
  data: {
    blockType: SdkContentBlockType;
    blockIndex: number;
    toolUseId?: string;
    toolName?: string;
  };
}

/**
 * Streaming block stop event
 */
export interface SdkStreamBlockStopEvent extends SdkEventBase {
  type: 'sdk_stream';
  action: 'block_stop';
  data: {
    blockType: SdkContentBlockType;
    blockIndex: number;
  };
}

/**
 * Union of all streaming events
 */
export type SdkStreamEvent =
  | SdkStreamDeltaEvent
  | SdkStreamBlockStartEvent
  | SdkStreamBlockStopEvent;

// ============================================================================
// Combined SDK Event Union
// ============================================================================

/**
 * All SDK event types
 */
export type SdkEvent =
  | SdkInitEvent
  | SdkHookEvent
  | SdkMcpEvent
  | SdkUserInputEvent
  | SdkAssistantMessageEvent
  | SdkResultEvent
  | SdkStreamEvent;

/**
 * SDK event type discriminator
 */
export type SdkEventType = SdkEvent['type'];

// ============================================================================
// Event Helpers
// ============================================================================

/**
 * Create a base event with common fields
 */
export function createSdkEventBase(
  sessionId: string,
  tier?: TierName,
  executionId?: string
): SdkEventBase {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    tier,
    executionId,
  };
}

/**
 * Check if an event is a hook event
 */
export function isSdkHookEvent(event: SdkEvent): event is SdkHookEvent {
  return event.type === 'sdk_hook';
}

/**
 * Check if an event is an MCP event
 */
export function isSdkMcpEvent(event: SdkEvent): event is SdkMcpEvent {
  return event.type === 'sdk_mcp';
}

/**
 * Check if an event is a user input event
 */
export function isSdkUserInputEvent(event: SdkEvent): event is SdkUserInputEvent {
  return event.type === 'sdk_user_input';
}

/**
 * Check if an event is a stream event
 */
export function isSdkStreamEvent(event: SdkEvent): event is SdkStreamEvent {
  return event.type === 'sdk_stream';
}

// ============================================================================
// Compatibility Layer
// ============================================================================

/**
 * Convert SDK token usage to legacy format
 */
export function toTokenUsageLegacy(usage: SdkTokenUsage): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
  };
}

/**
 * Convert legacy token usage to SDK format
 */
export function fromTokenUsageLegacy(legacy: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): SdkTokenUsage {
  return {
    inputTokens: legacy.inputTokens,
    outputTokens: legacy.outputTokens,
    cacheCreationInputTokens: legacy.cacheCreationInputTokens || 0,
    cacheReadInputTokens: legacy.cacheReadInputTokens || 0,
    totalTokens:
      legacy.inputTokens +
      legacy.outputTokens +
      (legacy.cacheCreationInputTokens || 0) +
      (legacy.cacheReadInputTokens || 0),
  };
}
