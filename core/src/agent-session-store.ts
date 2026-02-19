/**
 * Agent Session Store
 *
 * @deprecated This module is deprecated in favor of the execution-centric model.
 * Use EventStore (event-store.ts) for execution tracking and
 * ClaudeSessionReader (claude-session-reader.ts) for reading Claude Code sessions.
 *
 * Migration guide:
 * - For execution tracking: Use createEventStore() and eventStore.startExecution()
 * - For Claude sessions: Use createClaudeSessionReader() to read ~/.claude/projects/
 * - For session queries: Use /executions/* API endpoints instead of /sessions/*
 *
 * This module will be removed in a future version. Target removal: 2026-06-01.
 *
 * Centralized store for tracking all sessions created by tier agents.
 * Provides querying, status tracking, and persistence capabilities.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import type { TierName } from './types/instruction-protocol';
import { getSessionCache, type SessionCacheData, type CachedToolUse, isRealUserPrompt } from './session-cache';
import { legacyEncodeProjectPath } from './utils/path-utils';

// ============================================================================
// Session Cache Converter
// ============================================================================

/**
 * Convert SessionCacheData to ClaudeSessionData
 * Extracts derived fields (fileChanges, dbOperations, gitOperations) from cached toolUses
 * and computes session status from timestamps.
 */
function convertCacheToSessionData(
  cache: SessionCacheData,
  fileMtime: Date,
  includeRawMessages?: boolean,
  rawMessages?: Array<any & { lineIndex: number }>
): ClaudeSessionData {
  // Convert cached tool uses to ClaudeToolUse format
  const toolUses: ClaudeToolUse[] = cache.toolUses.map(t => ({
    id: t.id,
    name: t.name,
    input: t.input,
    turnIndex: t.turnIndex,
    lineIndex: t.lineIndex,
  }));

  // Extract file changes, DB operations, and Git operations from tool uses
  const fileChanges = extractFileChangesFromToolUses(toolUses);
  const dbOperations = extractDbOperationsFromToolUses(toolUses);
  const gitOperations = extractGitOperationsFromToolUses(toolUses);

  // Convert user prompts (pass through promptType for consumers)
  const userPrompts: ClaudeUserPrompt[] = cache.userPrompts.map(p => ({
    turnIndex: p.turnIndex,
    lineIndex: p.lineIndex,
    text: p.text,
    images: p.images,
    timestamp: p.timestamp,
    promptType: p.promptType,
  }));

  // Parse timestamps for status calculation
  const firstTimestamp = cache.firstTimestamp ? new Date(cache.firstTimestamp) : null;
  const lastTimestamp = cache.lastTimestamp ? new Date(cache.lastTimestamp) : null;

  // Determine session status with improved heuristics
  const now = Date.now();
  const msSinceModified = now - fileMtime.getTime();
  const msSinceLastActivity = lastTimestamp ? now - lastTimestamp.getTime() : Infinity;
  const msSinceActivity = Math.min(msSinceModified, msSinceLastActivity);

  // Time thresholds
  const RUNNING_THRESHOLD = 60_000;      // 1 minute
  const IDLE_THRESHOLD = 10 * 60_000;    // 10 minutes

  // Determine if session has result (completed)
  const hasResultMessage = cache.result !== undefined || cache.durationMs > 0;
  const hasAssistantResponse = cache.responses.length > 0;

  let status: ClaudeSessionData['status'];
  let isActive: boolean;

  if (hasResultMessage && cache.success) {
    status = 'completed';
    isActive = false;
  } else if (hasResultMessage && cache.errors && cache.errors.length > 0) {
    status = 'error';
    isActive = false;
  } else if (msSinceActivity < RUNNING_THRESHOLD) {
    status = 'running';
    isActive = true;
  } else if (hasAssistantResponse && msSinceActivity >= IDLE_THRESHOLD) {
    // Has responses and no recent activity - likely completed
    status = 'completed';
    isActive = false;
  } else if (msSinceActivity < IDLE_THRESHOLD) {
    status = 'idle';
    isActive = false;
  } else {
    status = 'stale';
    isActive = false;
  }

  // Build result data
  const data: ClaudeSessionData = {
    sessionId: cache.sessionId,
    cwd: cache.cwd,
    model: cache.model,
    claudeCodeVersion: cache.claudeCodeVersion,
    permissionMode: cache.permissionMode,
    tools: cache.tools,
    mcpServers: cache.mcpServers,
    numTurns: cache.numTurns,
    durationMs: cache.durationMs,
    durationApiMs: cache.durationApiMs,
    totalCostUsd: cache.totalCostUsd,
    usage: {
      inputTokens: cache.usage.inputTokens,
      outputTokens: cache.usage.outputTokens,
      cacheCreationInputTokens: cache.usage.cacheCreationInputTokens,
      cacheReadInputTokens: cache.usage.cacheReadInputTokens,
    },
    result: cache.result,
    errors: cache.errors,
    success: cache.success,
    isActive,
    status,
    lastActivityAt: lastTimestamp || undefined,
    userPrompts,
    toolUses,
    responses: cache.responses,
    systemPrompt: cache.systemPrompt,
    fileChanges,
    dbOperations,
    gitOperations,
    todos: cache.todos,
    tasks: cache.tasks
      .filter(t => t.status !== 'deleted')
      .map(t => ({
        id: t.id,
        subject: t.subject,
        description: t.description,
        activeForm: t.activeForm,
        status: t.status,
        blocks: t.blocks,
        blockedBy: t.blockedBy,
        owner: t.owner,
        metadata: t.metadata,
        turnIndex: t.turnIndex,
        lineIndex: t.lineIndex,
      })),
    thinkingBlocks: cache.thinkingBlocks,
    subagents: cache.subagents.map(s => ({
      agentId: s.agentId,
      toolUseId: s.toolUseId,
      type: s.type as SubagentType,
      prompt: s.prompt,
      description: s.description,
      model: s.model,
      // Parent session indices
      turnIndex: s.turnIndex,
      lineIndex: s.lineIndex,
      userPromptIndex: s.userPromptIndex,
      parentUuid: s.parentUuid,
      // Status
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      // Map cache status to SubagentStatus: 'failed' -> 'error'
      status: (s.status === 'failed' ? 'error' : s.status) as SubagentStatus,
      result: s.result,
      runInBackground: s.runInBackground,
    })),
    subagentProgress: cache.subagentProgress.length > 0 ? cache.subagentProgress : undefined,
    plans: cache.plans && cache.plans.length > 0 ? cache.plans.map(p => ({
      toolUseId: p.toolUseId,
      status: p.status,
      planFile: p.planFile,
      planTitle: p.planTitle,
      planSummary: p.planSummary,
      allowedPrompts: p.allowedPrompts,
      turnIndex: p.turnIndex,
      lineIndex: p.lineIndex,
    })) : undefined,
    teamName: cache.teamName,
    allTeams: cache.allTeams && cache.allTeams.length > 0 ? cache.allTeams : undefined,
    teamOperations: cache.teamOperations && cache.teamOperations.length > 0 ? cache.teamOperations : undefined,
    teamMessages: cache.teamMessages && cache.teamMessages.length > 0 ? cache.teamMessages : undefined,
    // Task ID -> subject map for resolving TaskUpdate references in Team tab
    taskSubjects: cache.tasks.length > 0
      ? Object.fromEntries(cache.tasks.filter(t => t.subject).map(t => [t.id, t.subject]))
      : undefined,
  };

  if (includeRawMessages && rawMessages) {
    data.rawMessages = rawMessages;
  }

  return data;
}

// ============================================================================
// Types
// ============================================================================

export type SessionStatus =
  | 'pending'      // Created but not started
  | 'initializing' // SDK init in progress
  | 'running'      // Actively executing
  | 'waiting'      // Waiting for user input or permission
  | 'completed'    // Successfully finished
  | 'failed'       // Failed with error
  | 'aborted'      // Manually cancelled
  | 'timeout';     // Timed out

export interface AgentSession {
  /** Unique session ID from SDK */
  sessionId: string;
  /** Execution ID for tracking */
  executionId: string;
  /** Tier that owns this session */
  tier: TierName | 'orchestrator';
  /** Current status */
  status: SessionStatus;
  /** Original prompt */
  prompt: string;
  /** Working directory */
  cwd: string;
  /** When session was created */
  createdAt: Date;
  /** When session started executing */
  startedAt?: Date;
  /** When session completed */
  completedAt?: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
  /** Number of turns completed */
  turnCount: number;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Cost in USD */
  costUsd: number;
  /** Error message if failed */
  error?: string;
  /** Result summary if completed */
  result?: string;
  /** Model used */
  model?: string;
  /** Parent session ID (for subagents) */
  parentSessionId?: string;
  /** Child session IDs */
  childSessionIds: string[];
  /** Custom metadata */
  metadata: Record<string, unknown>;
}

export interface SessionQuery {
  /** Filter by tier */
  tier?: TierName | 'orchestrator';
  /** Filter by status */
  status?: SessionStatus | SessionStatus[];
  /** Filter by execution ID */
  executionId?: string;
  /** Filter by parent session */
  parentSessionId?: string;
  /** Created after this date */
  createdAfter?: Date;
  /** Created before this date */
  createdBefore?: Date;
  /** Limit results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  sortBy?: 'createdAt' | 'lastActivityAt' | 'costUsd';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

export interface SessionStats {
  totalSessions: number;
  byStatus: Record<SessionStatus, number>;
  byTier: Record<string, number>;
  activeSessions: number;
  totalCostUsd: number;
  totalTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  averageDurationMs: number;
  averageTurns: number;
}

export interface SessionStoreConfig {
  /** Project path for persistence */
  projectPath: string;
  /** Enable persistence to disk */
  persist?: boolean;
  /** Max sessions to keep in memory */
  maxSessions?: number;
  /** Auto-cleanup completed sessions older than this (ms) */
  cleanupAgeMs?: number;
}

export interface SessionUpdateEvent {
  type: 'session_created' | 'session_updated' | 'session_completed' | 'session_failed' | 'session_deleted';
  session: AgentSession;
  previousStatus?: SessionStatus;
}

// ============================================================================
// Claude Code Session Data Types (from ~/.claude/projects/)
// ============================================================================

/**
 * All possible message types in Claude Code session JSONL files
 */
export type ClaudeSessionMessageType =
  | 'system'           // System messages (init, turn_duration, stop_hook_summary, compact_boundary)
  | 'user'             // User prompts
  | 'assistant'        // Assistant responses
  | 'result'           // Execution results
  | 'progress'         // Progress updates during execution
  | 'summary'          // Context compaction summaries
  | 'file-history-snapshot';  // File state snapshots

/**
 * Known system message subtypes
 */
export type ClaudeSystemSubtype =
  | 'init'              // Session initialization
  | 'turn_duration'     // Duration of a turn
  | 'stop_hook_summary' // Stop hook execution summary
  | 'compact_boundary'; // Context compaction boundary marker

/** Raw message from Claude Code session file */
export interface ClaudeSessionMessage {
  type: ClaudeSessionMessageType;
  subtype?: ClaudeSystemSubtype | string;
  timestamp?: string;
  [key: string]: unknown;
}

/** System init message from Claude Code */
export interface ClaudeSystemInit {
  type: 'system';
  subtype: 'init';
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: string;
  slash_commands: string[];
  claude_code_version: string;
  output_style: string;
  agents?: unknown[];
  plugins?: unknown[];
}

/** Assistant message from Claude Code */
export interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    id: string;
    model: string;
    content: Array<{
      type: 'text' | 'tool_use' | 'thinking';
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      thinking?: string;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    stop_reason?: string;
  };
}

/** Result message from Claude Code */
export interface ClaudeResultMessage {
  type: 'result';
  subtype: 'success' | 'error' | 'cancelled' | 'timeout';
  session_id: string;
  result?: string;
  errors?: string[];
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

/** Tool use extracted from assistant message */
export interface ClaudeToolUse {
  id: string;
  name: string;
  input: unknown;
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
}

/** Simplified file action category */
export type FileActionCategory = 'created' | 'read' | 'deleted' | 'updated';

/** File change extracted from tool uses */
export interface FileChange {
  path: string;
  action: 'read' | 'write' | 'edit' | 'delete' | 'create' | 'copy' | 'move' | 'download' | 'archive' | 'extract' | 'permission' | 'link';
  category: FileActionCategory;
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
  toolName: string;
  remote?: string; // Remote host if via SSH/Docker
}

const ACTION_TO_CATEGORY: Record<FileChange['action'], FileActionCategory> = {
  read: 'read',
  write: 'created',
  edit: 'updated',
  delete: 'deleted',
  create: 'created',
  copy: 'created',
  move: 'updated',
  download: 'created',
  archive: 'created',
  extract: 'created',
  permission: 'updated',
  link: 'created',
};

/** Map a granular file action to a simplified category */
export function getFileActionCategory(action: FileChange['action']): FileActionCategory {
  return ACTION_TO_CATEGORY[action];
}

/** Summarize file changes into deduplicated lists per category. Latest action wins for conflicts. */
export function summarizeFileChanges(changes: FileChange[]): { created: string[]; updated: string[]; deleted: string[]; read: string[] } {
  // Track latest category per path (by lineIndex)
  const latest = new Map<string, { category: FileActionCategory; lineIndex: number }>();

  for (const change of changes) {
    const existing = latest.get(change.path);
    if (!existing || change.lineIndex > existing.lineIndex) {
      latest.set(change.path, { category: change.category, lineIndex: change.lineIndex });
    }
  }

  const result: { created: string[]; updated: string[]; deleted: string[]; read: string[] } = {
    created: [],
    updated: [],
    deleted: [],
    read: [],
  };

  for (const [path, { category }] of latest) {
    result[category].push(path);
  }

  return result;
}

/** Database operation extracted from tool uses */
export interface DbOperation {
  type: 'query' | 'migrate' | 'seed' | 'create' | 'drop' | 'connect' | 'backup';
  tool: string;
  command: string;
  sql: string; // Extracted clean SQL
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
  tables: string[];
  columns: string[];
  remote?: string; // Remote host if via SSH/Docker
}

/** Git operation type */
export type GitOperationType =
  | 'status'
  | 'add'
  | 'commit'
  | 'push'
  | 'pull'
  | 'checkout'
  | 'branch'
  | 'merge'
  | 'diff'
  | 'log'
  | 'clone'
  | 'fetch'
  | 'stash'
  | 'reset'
  | 'rebase'
  | 'init'
  | 'tag'
  | 'remote'
  | 'cherry-pick'
  | 'revert'
  | 'restore'
  | 'show'
  | 'gh_pr'
  | 'gh_issue'
  | 'gh_repo'
  | 'gh_workflow'
  | 'gh_auth'
  | 'other';

/** Git operation extracted from tool uses */
export interface GitOperation {
  /** Operation type */
  type: GitOperationType;
  /** Raw command */
  command: string;
  /** Turn index */
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
  /** Files affected (from git add, commit, diff, etc) */
  files?: string[];
  /** Branch name (from checkout, branch, merge) */
  branch?: string;
  /** Commit message (from commit -m) */
  commitMessage?: string;
  /** Remote name (from push, pull, fetch - e.g., 'origin') */
  remoteName?: string;
  /** Repository URL (from clone, remote add) */
  repoUrl?: string;
  /** SSH/Docker remote host if executed remotely */
  remoteHost?: string;
  /** GitHub PR number (from gh pr) */
  prNumber?: string;
  /** GitHub issue number (from gh issue) */
  issueNumber?: string;
  /** Commit hash/ref (from checkout, cherry-pick, reset) */
  commitRef?: string;
  /** Tag name (from tag) */
  tagName?: string;
  /** Stash reference (from stash) */
  stashRef?: string;
}

// ============================================================================
// Subagent Types (Task tool invocations)
// ============================================================================

/** Subagent type from Task tool */
export type SubagentType =
  | 'Explore'
  | 'Plan'
  | 'Bash'
  | 'general-purpose'
  | 'statusline-setup'
  | 'claude-code-guide'
  | string; // Allow custom agent types

/** Subagent status */
export type SubagentStatus =
  | 'pending'    // Task tool called but not yet started
  | 'running'    // Actively executing
  | 'completed'  // Finished successfully
  | 'error'      // Finished with error
  | 'unknown';   // Cannot determine status

/** Subagent invocation extracted from Task tool call */
export interface SubagentInvocation {
  /** Agent ID (short hash, e.g., 'a9afc2c') */
  agentId: string;
  /** Tool use ID that spawned this agent */
  toolUseId: string;
  /** Agent type (Explore, Plan, Bash, general-purpose, etc.) */
  type: SubagentType;
  /** Task prompt given to the agent */
  prompt: string;
  /** Optional description */
  description?: string;
  /** Model used (if specified) */
  model?: string;
  // ─── Parent Session Indices ───
  /** Turn index where Task tool was called */
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
  /** User prompt index (0-based) - which user prompt triggered this subagent */
  userPromptIndex: number;
  /** UUID of the parent message (from agent_progress, for position matching) */
  parentUuid?: string;
  // ─── Status ───
  /** Timestamp when agent was spawned */
  startedAt?: string;
  /** Timestamp when agent completed */
  completedAt?: string;
  /** Agent status */
  status: SubagentStatus;
  /** Result text (from tool_result) */
  result?: string;
  /** Whether agent ran in background */
  runInBackground?: boolean;
}

/** Progress update from agent_progress message */
export interface SubagentProgressUpdate {
  /** Agent ID */
  agentId: string;
  /** Timestamp of progress update */
  timestamp: string;
  /** Line index in session file */
  lineIndex: number;
  /** Progress message content */
  message?: {
    type: 'user' | 'assistant';
    content?: string;
    toolName?: string;
  };
}

/** Full subagent session data (parsed from agent-*.jsonl file) */
export interface SubagentSessionData {
  /** Agent ID */
  agentId: string;
  /** Parent session ID */
  parentSessionId: string;
  /** Parent message UUID - links to specific message in parent session that spawned this subagent */
  parentUuid?: string;
  /** Working directory */
  cwd: string;
  /** Agent type */
  type: SubagentType;
  /** Task prompt */
  prompt: string;
  /** Status */
  status: SubagentStatus;
  /** Number of turns in agent session */
  numTurns: number;
  /** Model used */
  model?: string;
  /** Claude Code version */
  claudeCodeVersion?: string;
  /** File path to agent session file */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Last activity timestamp */
  lastActivityAt?: Date;
  /** Tool uses in agent session */
  toolUses: ClaudeToolUse[];
  /** Text responses from agent */
  responses: Array<{ turnIndex: number; lineIndex: number; text: string }>;
  /** Token usage (if available) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  /** Conversation messages (user and assistant) */
  conversation?: Array<{
    type: 'user' | 'assistant';
    turnIndex: number;
    lineIndex: number;
    content: string;
    /** Raw content blocks for tool_use, thinking, etc. */
    contentBlocks?: any[];
  }>;
}

/** User prompt from session */
export interface ClaudeUserPrompt {
  /** Turn index */
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
  /** Prompt text */
  text: string;
  /** Timestamp */
  timestamp?: string;
  /** Classification: undefined/'user' = real prompt, others = system-injected */
  promptType?: import('./session-cache').PromptType;
}

/**
 * Parsed sections from a compact/continuation message summary.
 */
export interface CompactMessageSummary {
  /** The header text ("This session is being continued...") */
  header: string;
  /** Primary Request and Intent section content */
  primaryRequestAndIntent?: string;
  /** Key Technical Concepts section content */
  keyTechnicalConcepts?: string;
  /** Any other sections found (section name -> content) */
  otherSections?: Record<string, string>;
}

/**
 * Compact/continuation message from context compaction.
 * These are user messages that start with "This session is being continued from a previous conversation..."
 * and contain a summary of the previous context.
 */
export interface ClaudeCompactMessage {
  /** Line index in JSONL file (0-based) - position in session file */
  lineIndex: number;
  /** Turn index (1-based) - logical position in conversation */
  turnIndex: number;
  /** Timestamp of the message */
  timestamp?: string;
  /** The full text of the compact message (includes summary) */
  text: string;
  /**
   * Order of this compact message (0-based).
   * A session may have multiple compaction events.
   * Order 0 is the first compaction, 1 is the second, etc.
   */
  compactOrder: number;
  /** Parsed summary sections (extracted from text) */
  parsedSummary?: CompactMessageSummary;
}

/**
 * Parse a compact message text to extract structured summary sections.
 *
 * The compact message format is:
 * ```
 * This session is being continued from a previous conversation that ran out of context.
 * The summary below covers the earlier portion of the conversation.
 * Summary:
 * 1. Primary Request and Intent:
 *    [content...]
 * 2. Key Technical Concepts:
 *    [content...]
 * [other numbered sections...]
 * ```
 *
 * @param text - The full compact message text
 * @returns Parsed summary sections
 */
export function parseCompactMessageSummary(text: string): CompactMessageSummary {
  const result: CompactMessageSummary = {
    header: '',
    otherSections: {},
  };

  // Extract the header (first two lines typically)
  const headerPattern = /^(This session is being continued from a previous conversation that ran out of context\.\s*The summary below covers the earlier portion of the conversation\.)/;
  const headerMatch = text.match(headerPattern);
  if (headerMatch) {
    result.header = headerMatch[1].trim();
  }

  // Extract numbered sections using regex
  // Pattern: number followed by period, section title, colon, then content until next section or end
  const sectionPattern = /(\d+)\.\s*([^:]+):\s*([\s\S]*?)(?=\n\d+\.\s*[^:]+:|$)/g;

  let match;
  while ((match = sectionPattern.exec(text)) !== null) {
    const sectionNumber = match[1];
    const sectionTitle = match[2].trim();
    const sectionContent = match[3].trim();

    // Map known sections to specific fields
    if (sectionTitle.toLowerCase().includes('primary request') || sectionTitle.toLowerCase().includes('intent')) {
      result.primaryRequestAndIntent = sectionContent;
    } else if (sectionTitle.toLowerCase().includes('key technical') || sectionTitle.toLowerCase().includes('concepts')) {
      result.keyTechnicalConcepts = sectionContent;
    } else {
      // Store other sections
      result.otherSections![`${sectionNumber}. ${sectionTitle}`] = sectionContent;
    }
  }

  return result;
}

/** Parsed Claude Code session data */
export interface ClaudeSessionData {
  /** Session ID */
  sessionId: string;
  /** Working directory */
  cwd: string;
  /** Model used */
  model: string;
  /** Claude Code version */
  claudeCodeVersion: string;
  /** Permission mode */
  permissionMode: string;
  /** Available tools */
  tools: string[];
  /** MCP servers */
  mcpServers: Array<{ name: string; status: string }>;
  /** Number of turns */
  numTurns: number;
  /** Total duration (ms) */
  durationMs: number;
  /** API duration (ms) */
  durationApiMs: number;
  /** Total cost (USD) */
  totalCostUsd: number;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  /** Final result text */
  result?: string;
  /** Error messages if failed */
  errors?: string[];
  /** Success status */
  success: boolean;
  /** Whether the session is still active/running */
  isActive: boolean;
  /**
   * Session status:
   * - 'running': Actively running (file modified < 60s)
   * - 'completed': Finished successfully (has result message)
   * - 'error': Finished with errors (has result message with errors)
   * - 'interrupted': Session ended mid-conversation (user message with no response)
   * - 'idle': Paused recently (1-10 minutes since last activity)
   * - 'stale': Inactive for a while (> 10 minutes, no result)
   */
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'idle' | 'stale';
  /** Last activity timestamp */
  lastActivityAt?: Date;
  /** Parent session ID if this is an agent session */
  parentSessionId?: string;
  /** Whether this session is an agent (subagent) */
  isAgent?: boolean;
  /** User prompts (text messages from user) */
  userPrompts: ClaudeUserPrompt[];
  /** All tool uses in the session */
  toolUses: ClaudeToolUse[];
  /** All text responses from assistant */
  responses: Array<{ turnIndex: number; lineIndex: number; text: string }>;
  /** System prompt (if available) */
  systemPrompt?: string;
  /** Raw messages (if requested) */
  rawMessages?: ClaudeSessionMessage[];
  /** File changes extracted from tool uses */
  fileChanges?: FileChange[];
  /** Database operations extracted from tool uses */
  dbOperations?: DbOperation[];
  /** Git operations extracted from tool uses */
  gitOperations?: GitOperation[];
  /** Current todos from TodoWrite tool */
  todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string; lineIndex: number }>;
  /** Tasks from TaskCreate/TaskUpdate tools (v2.1.17+) */
  tasks?: Array<{
    id: string;
    subject: string;
    description?: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'deleted';
    blocks?: string[];
    blockedBy?: string[];
    owner?: string;
    metadata?: Record<string, unknown>;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Thinking blocks from assistant messages (extended thinking content) */
  thinkingBlocks?: Array<{ turnIndex: number; lineIndex: number; thinking: string }>;
  /** Subagent invocations from Task tool calls */
  subagents?: SubagentInvocation[];
  /** Progress updates from agent_progress messages */
  subagentProgress?: SubagentProgressUpdate[];
  /** Plans from EnterPlanMode/ExitPlanMode tool calls */
  plans?: Array<{
    toolUseId: string;
    status: 'entering' | 'approved';
    planFile?: string;
    planTitle?: string;
    planSummary?: string;
    allowedPrompts?: Array<{ tool: string; prompt: string }>;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Team name if session is part of a team (first team for backward compat) */
  teamName?: string;
  /** All distinct team names in order of appearance */
  allTeams?: string[];
  /** Team operations from Teammate tool (spawnTeam, cleanup) */
  teamOperations?: Array<{
    operation: 'spawnTeam' | 'cleanup';
    teamName?: string;
    description?: string;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Team messages from SendMessage tool */
  teamMessages?: Array<{
    messageType: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response';
    recipient?: string;
    content?: string;
    summary?: string;
    requestId?: string;
    approve?: boolean;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Task ID -> subject mapping for resolving TaskUpdate references */
  taskSubjects?: Record<string, string>;
}

// ============================================================================
// Extraction Helper Functions
// ============================================================================

/**
 * Extract clean SQL from nested SSH/Docker commands
 * Handles: ssh ... "docker ... psql ... -c \"SQL\""
 */
function extractSql(cmd: string): string {
  let sql = cmd;

  // Extract inner command from SSH wrapper
  if (sql.startsWith('ssh ')) {
    const firstQuote = sql.indexOf('"');
    if (firstQuote !== -1) {
      let lastQuote = sql.length - 1;
      while (lastQuote > firstQuote && sql[lastQuote] !== '"') lastQuote--;
      if (lastQuote > firstQuote) {
        sql = sql.slice(firstQuote + 1, lastQuote);
      }
    }
  }

  // Unescape quotes
  sql = sql.replace(/\\"/g, '"').replace(/\\'/g, "'");

  // Remove docker wrapper
  sql = sql.replace(/docker\s+[\w]+\s+[\w-]+\s+/g, '');

  // Extract SQL from psql -c "..."
  const cMatch = sql.match(/psql\s+[^"]*-c\s+["']([\s\S]+?)["']\s*$/) ||
                 sql.match(/-c\s+["']([\s\S]+?)["']\s*$/) ||
                 sql.match(/-c\s+["']([\s\S]+)['"]/);
  if (cMatch) sql = cMatch[1];

  // Final cleanup
  sql = sql.replace(/\\"/g, '"').replace(/\\'/g, "'");
  sql = sql.replace(/\s+/g, ' ').trim();

  return sql;
}

/**
 * Extract table names from SQL
 */
function extractTables(cmd: string): string[] {
  const sql = extractSql(cmd);
  const tables: string[] = [];

  const runRegex = (regex: RegExp, groupIdx: number, transform?: (s: string) => string | undefined) => {
    let m;
    while ((m = regex.exec(sql)) !== null) {
      const val = transform ? transform(m[groupIdx]) : m[groupIdx];
      if (val) tables.push(val);
    }
  };

  // FROM table
  runRegex(/\bFROM\s+["'`]?([\w.]+)["'`]?/gi, 1, s => {
    const t = s.split('.').pop();
    return t && !['information_schema', 'pg_catalog'].includes(t.toLowerCase()) ? t : undefined;
  });

  // INTO table
  runRegex(/\bINTO\s+["'`]?([\w.]+)["'`]?/gi, 1, s => s.split('.').pop());

  // UPDATE table
  runRegex(/\bUPDATE\s+["'`]?([\w.]+)["'`]?/gi, 1, s => s.split('.').pop());

  // CREATE/ALTER/DROP TABLE
  runRegex(/\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?([\w.]+)["'`]?/gi, 1, s => s.split('.').pop());

  // table_name = 'x' (in WHERE clauses)
  runRegex(/table_name\s*=\s*['"](\w+)['"]/gi, 1);

  return [...new Set(tables.filter(t => t && t.length > 1))];
}

/**
 * Extract column names from SQL
 */
function extractColumns(cmd: string): string[] {
  const sql = extractSql(cmd);
  const columns: string[] = [];

  // Match SELECT ... FROM
  const selectMatch = sql.match(/\bSELECT\s+([\s\S]+?)\bFROM\b/i);
  if (selectMatch) {
    const selectPart = selectMatch[1];
    if (!selectPart.includes('*')) {
      const cols = selectPart.split(',').map(c => {
        const col = c.trim().split(/\s+(?:AS\s+)?/i)[0];
        return col.split('.').pop()?.replace(/["'`]/g, '');
      });
      columns.push(...cols.filter((c): c is string => !!c && c !== '*'));
    }
  }

  // Match INSERT columns
  const insertMatch = sql.match(/\bINSERT\s+INTO\s+[\w."'`]+\s*\(([^)]+)\)/i);
  if (insertMatch) {
    const cols = insertMatch[1].split(',').map(c => c.trim().replace(/["'`]/g, ''));
    columns.push(...cols.filter(c => c));
  }

  // Match UPDATE SET columns
  const setMatches = sql.match(/\bSET\s+([\s\S]+?)(?:\bWHERE\b|$)/i);
  if (setMatches) {
    const cols = setMatches[1].split(',').map(c => {
      const match = c.trim().match(/^["'`]?([\w]+)["'`]?\s*=/);
      return match ? match[1] : null;
    });
    columns.push(...cols.filter((c): c is string => !!c));
  }

  // Match column_name = 'x' in WHERE (for information_schema queries)
  const colNameMatch = sql.match(/column_name\s*=\s*['"](\w+)['"]/gi);
  if (colNameMatch) {
    for (const m of colNameMatch) {
      const val = m.match(/['"](\w+)['"]/);
      if (val) columns.push(val[1]);
    }
  }

  return [...new Set(columns.filter(c => c && c.length > 1))];
}

/**
 * Detect DB operation type from command
 */
function detectDbOperationType(cmd: string): DbOperation['type'] {
  const lower = cmd.toLowerCase();

  if (lower.includes('migrate') || lower.includes('migration')) return 'migrate';
  if (lower.includes('seed')) return 'seed';
  if (lower.includes('pg_dump') || lower.includes('mysqldump') || lower.includes('backup')) return 'backup';
  if (/\bcreate\s+(database|schema)\b/i.test(lower)) return 'create';
  if (/\bdrop\s+(database|schema)\b/i.test(lower)) return 'drop';

  const sql = extractSql(cmd);
  if (/\b(create|alter|drop)\s+table\b/i.test(sql)) return 'migrate';

  return 'query';
}

/**
 * Detect DB tool from command
 */
function detectDbTool(cmd: string): string | null {
  const lower = cmd.toLowerCase();

  if (lower.includes('psql') || lower.includes('postgresql')) return 'psql';
  if (lower.includes('mysql')) return 'mysql';
  if (lower.includes('sqlite')) return 'sqlite3';
  if (lower.includes('prisma')) return 'prisma';
  if (lower.includes('drizzle')) return 'drizzle';
  if (lower.includes('knex')) return 'knex';
  if (lower.includes('pg_dump') || lower.includes('pg_restore')) return 'pg_dump';
  if (lower.includes('mongosh') || lower.includes('mongo')) return 'mongo';
  if (lower.includes('redis-cli')) return 'redis';

  return null;
}

/**
 * Extract remote host from SSH command
 */
function extractRemoteHost(cmd: string): string | null {
  // Match SSH: ssh [options...] [user@]host "..."
  // The regex looks for the host right before the opening quote
  const sshMatch = cmd.match(/ssh\s+[^"]*?\s+(?:[\w.-]+@)?([\d.]+|[\w.-]+)\s+"/);
  if (sshMatch) return sshMatch[1];

  // Match docker (only if not inside SSH)
  const dockerMatch = cmd.match(/docker\s+[\w]+\s+[^"]*?([\w-]+)\s+/);
  if (dockerMatch && !cmd.includes('ssh ')) return `docker:${dockerMatch[1]}`;

  return null;
}

/**
 * Extract inner command from SSH wrapper
 */
function extractInnerCommand(cmd: string): { cmd: string; remote: string | null } {
  const remote = extractRemoteHost(cmd);

  if (!cmd.startsWith('ssh ')) {
    return { cmd, remote };
  }

  // Find the quoted command
  const sshHostMatch = cmd.match(/ssh\s+[^\s]*\s+(?:[\w.-]+@)?([\d.]+|[\w.-]+)\s+"/);
  if (sshHostMatch) {
    const startQuote = cmd.indexOf('"', sshHostMatch.index! + sshHostMatch[0].length - 1);
    if (startQuote !== -1) {
      let endQuote = cmd.length - 1;
      for (let i = cmd.length - 1; i > startQuote; i--) {
        if (cmd[i] === '"' && cmd[i-1] !== '\\') {
          endQuote = i;
          break;
        }
      }
      let innerCmd = cmd.slice(startQuote + 1, endQuote);
      innerCmd = innerCmd.replace(/\\"/g, '"').replace(/\\'/g, "'");
      return { cmd: innerCmd, remote };
    }
  }

  return { cmd, remote };
}

/**
 * Extract file changes from tool uses
 */
function extractFileChangesFromToolUses(toolUses: ClaudeToolUse[]): FileChange[] {
  const files: FileChange[] = [];

  for (const tool of toolUses) {
    const { name, input, turnIndex, lineIndex } = tool;
    const inputObj = input as Record<string, unknown> | undefined;

    let remote: string | undefined;

    // Read tool
    if (name.toLowerCase() === 'read' && inputObj?.file_path) {
      files.push({
        path: String(inputObj.file_path),
        action: 'read',
        category: 'read',
        turnIndex,
        lineIndex,
        toolName: name,
      });
      continue;
    }

    // Write tool
    if (name.toLowerCase() === 'write' && inputObj?.file_path) {
      files.push({
        path: String(inputObj.file_path),
        action: 'write',
        category: 'created',
        turnIndex,
        lineIndex,
        toolName: name,
      });
      continue;
    }

    // Edit tool
    if (name.toLowerCase() === 'edit' && inputObj?.file_path) {
      files.push({
        path: String(inputObj.file_path),
        action: 'edit',
        category: 'updated',
        turnIndex,
        lineIndex,
        toolName: name,
      });
      continue;
    }

    // Glob tool - file pattern search
    if (name.toLowerCase() === 'glob' && inputObj?.pattern) {
      files.push({
        path: inputObj.path ? String(inputObj.path) : String(inputObj.pattern),
        action: 'read',
        category: 'read',
        turnIndex,
        lineIndex,
        toolName: name,
      });
      continue;
    }

    // Grep tool - content search
    if (name.toLowerCase() === 'grep' && inputObj?.pattern) {
      if (inputObj.path) {
        files.push({
          path: String(inputObj.path),
          action: 'read',
          category: 'read',
          turnIndex,
          lineIndex,
          toolName: name,
        });
      }
      continue;
    }

    // NotebookEdit tool
    if (name.toLowerCase() === 'notebookedit' && inputObj?.notebook_path) {
      files.push({
        path: String(inputObj.notebook_path),
        action: 'edit',
        category: 'updated',
        turnIndex,
        lineIndex,
        toolName: name,
      });
      continue;
    }

    // Bash tool - extract file operations from commands
    if (name.toLowerCase() === 'bash' && inputObj?.command) {
      let cmd = String(inputObj.command);

      // Extract command and host from SSH wrapper
      const { cmd: innerCmd, remote: remoteHost } = extractInnerCommand(cmd);
      cmd = innerCmd;
      remote = remoteHost || undefined;

      // File operation patterns
      const patterns: Array<{ regex: RegExp; action: FileChange['action']; group: number }> = [
        // Read operations
        { regex: /\bcat\s+["']?([^\s"'|>]+)["']?/g, action: 'read', group: 1 },
        { regex: /\btail\s+(?:-[nf0-9]+\s+)?["']?([^\s"'|>]+)["']?/g, action: 'read', group: 1 },
        { regex: /\bhead\s+(?:-n?\s*\d+\s+)?["']?([^\s"'|>]+)["']?/g, action: 'read', group: 1 },
        { regex: /\bless\s+["']?([^\s"']+)["']?/g, action: 'read', group: 1 },
        { regex: /\bgrep\s+[^/]*?["']?([^\s"']+)["']?$/g, action: 'read', group: 1 },
        { regex: /\bdiff\s+(?:-[a-z]+\s+)?["']?([^\s"']+)["']?/g, action: 'read', group: 1 },
        { regex: /\b(?:source|\.)\s+["']?([^\s"']+)["']?/g, action: 'read', group: 1 },

        // Write operations (redirects) - exclude stderr redirects (2>, 2>>)
        { regex: /(?<![0-9])>\s*["']?([^\s"']+)["']?/g, action: 'write', group: 1 },
        { regex: /(?<![0-9])>>\s*["']?([^\s"']+)["']?/g, action: 'write', group: 1 },
        { regex: /\btee\s+(?:-a\s+)?["']?([^\s"']+)["']?/g, action: 'write', group: 1 },

        // Download operations
        { regex: /\bcurl\s+[^|]*?-o\s+["']?([^\s"']+)["']?/g, action: 'download', group: 1 },
        { regex: /\bwget\s+(?:[^\s]+\s+)*?-O\s+["']?([^\s"']+)["']?/g, action: 'download', group: 1 },
        { regex: /\bwget\s+(?:-[a-zA-Z]+\s+)*["']?(https?:\/\/[^\s"']+)["']?/g, action: 'download', group: 1 },

        // Copy operations
        { regex: /\bcp\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+)["']?\s+["']?([^\s"']+)["']?/g, action: 'copy', group: 2 },
        { regex: /\bscp\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"':]+:[^\s"']+)["']?/g, action: 'copy', group: 1 },
        { regex: /\brsync\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+)["']?\s+["']?([^\s"']+)["']?/g, action: 'copy', group: 2 },
        { regex: /\bdocker\s+cp\s+[^\s]+\s+["']?([^\s"']+)["']?/g, action: 'copy', group: 1 },

        // Move operations
        { regex: /\bmv\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+)["']?\s+["']?([^\s"']+)["']?/g, action: 'move', group: 2 },

        // Create operations
        { regex: /\btouch\s+["']?([^\s"']+)["']?/g, action: 'create', group: 1 },
        { regex: /\bmkdir\s+(?:-p\s+)?["']?([^\s"']+)["']?/g, action: 'create', group: 1 },

        // Delete operations
        { regex: /\brm\s+(?:-[rf]+\s+)?["']?([^\s"']+)["']?/g, action: 'delete', group: 1 },
        { regex: /\brmdir\s+["']?([^\s"']+)["']?/g, action: 'delete', group: 1 },

        // Edit operations
        { regex: /\bsed\s+-i[^\s]*\s+['"][^'"]+['"]\s+["']?([^\s"']+)["']?/g, action: 'edit', group: 1 },
        { regex: /\bvim?\s+["']?([^\s"']+)["']?/g, action: 'edit', group: 1 },
        { regex: /\bnano\s+["']?([^\s"']+)["']?/g, action: 'edit', group: 1 },
        { regex: /\bpatch\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+)["']?/g, action: 'edit', group: 1 },

        // Archive operations
        { regex: /\btar\s+(?:-?[cC][a-zA-Z]*\s+)+(?:-f\s+)?["']?([^\s"']+\.tar[^\s"']*)["']?/g, action: 'archive', group: 1 },
        { regex: /\bgzip\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+)["']?/g, action: 'archive', group: 1 },
        { regex: /\bzip\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+\.zip)["']?/g, action: 'archive', group: 1 },

        // Extract operations
        { regex: /\btar\s+(?:-?[xX][a-zA-Z]*\s+)+(?:-f\s+)?["']?([^\s"']+\.tar[^\s"']*)["']?/g, action: 'extract', group: 1 },
        { regex: /\bgunzip\s+["']?([^\s"']+)["']?/g, action: 'extract', group: 1 },
        { regex: /\bunzip\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+\.zip)["']?/g, action: 'extract', group: 1 },

        // Permission operations
        { regex: /\bchmod\s+(?:-[a-zA-Z]+\s+)?[0-7]+\s+["']?([^\s"']+)["']?/g, action: 'permission', group: 1 },
        { regex: /\bchown\s+(?:-[a-zA-Z]+\s+)?[^\s]+\s+["']?([^\s"']+)["']?/g, action: 'permission', group: 1 },

        // Link operations
        { regex: /\bln\s+(?:-[sf]+\s+)*["']?([^\s"']+)["']?\s+["']?([^\s"']+)["']?/g, action: 'link', group: 2 },
      ];

      for (const { regex, action, group } of patterns) {
        let match;
        while ((match = regex.exec(cmd)) !== null) {
          const filePath = match[group];
          // Skip obvious non-files and false positives
          if (
            filePath &&
            !filePath.startsWith('-') &&
            (filePath.includes('/') || filePath.includes('.')) &&
            // Filter out /dev/null and stderr redirects
            filePath !== '/dev/null' &&
            !filePath.includes('/dev/null') &&
            // Filter out template literals (${...}) and shell variables ($VAR)
            !filePath.includes('${') &&
            !/^\$[A-Z_]/.test(filePath) &&
            // Filter out HTML/XML tags
            !filePath.startsWith('<') &&
            !filePath.endsWith('>') &&
            !filePath.includes('</') &&
            // Filter out URLs (except for download action)
            (action === 'download' || (!filePath.startsWith('http://') && !filePath.startsWith('https://'))) &&
            // Filter out shell variable expansions that look like code
            !filePath.includes('$(') &&
            // Filter out paths that are clearly code snippets
            !filePath.includes(';') &&
            !filePath.includes('&&') &&
            // Filter out numeric-only paths (likely false positives)
            !/^[0-9]+$/.test(filePath) &&
            // Filter out regex patterns (contain special regex chars)
            !/^[\[\]\\*+?|(){}^$=]/.test(filePath) &&
            !filePath.includes(']/') &&
            !filePath.includes(']=') &&
            // Filter out sed-style regex endings
            !filePath.endsWith('/g') &&
            !filePath.endsWith('/i') &&
            !filePath.endsWith('/gi')
          ) {
            files.push({
              path: filePath,
              action,
              category: getFileActionCategory(action),
              turnIndex,
              lineIndex,
              toolName: name,
              remote,
            });
          }
        }
      }
    }
  }

  return files;
}

/**
 * Extract database operations from tool uses
 */
function extractDbOperationsFromToolUses(toolUses: ClaudeToolUse[]): DbOperation[] {
  const operations: DbOperation[] = [];

  for (const tool of toolUses) {
    const { name, input, turnIndex, lineIndex } = tool;
    const inputObj = input as Record<string, unknown> | undefined;

    // Only process Bash commands
    if (name.toLowerCase() !== 'bash' || !inputObj?.command) continue;

    const cmd = String(inputObj.command);
    const dbTool = detectDbTool(cmd);
    if (!dbTool) continue;

    // Extract remote host and inner command
    const { cmd: innerCmd, remote } = extractInnerCommand(cmd);

    const operation: DbOperation = {
      type: detectDbOperationType(innerCmd),
      tool: dbTool,
      command: cmd,
      sql: extractSql(innerCmd),
      turnIndex,
      lineIndex,
      tables: extractTables(innerCmd),
      columns: extractColumns(innerCmd),
      remote: remote || undefined,
    };

    operations.push(operation);
  }

  return operations;
}

/**
 * Detect git operation type from command
 */
function detectGitOperationType(cmd: string): GitOperationType {
  // GitHub CLI commands
  if (/\bgh\s+pr\b/.test(cmd)) return 'gh_pr';
  if (/\bgh\s+issue\b/.test(cmd)) return 'gh_issue';
  if (/\bgh\s+repo\b/.test(cmd)) return 'gh_repo';
  if (/\bgh\s+(workflow|run)\b/.test(cmd)) return 'gh_workflow';
  if (/\bgh\s+auth\b/.test(cmd)) return 'gh_auth';

  // Git commands
  if (/\bgit\s+status\b/.test(cmd)) return 'status';
  if (/\bgit\s+add\b/.test(cmd)) return 'add';
  if (/\bgit\s+commit\b/.test(cmd)) return 'commit';
  if (/\bgit\s+push\b/.test(cmd)) return 'push';
  if (/\bgit\s+pull\b/.test(cmd)) return 'pull';
  if (/\bgit\s+checkout\b/.test(cmd)) return 'checkout';
  if (/\bgit\s+branch\b/.test(cmd)) return 'branch';
  if (/\bgit\s+merge\b/.test(cmd)) return 'merge';
  if (/\bgit\s+diff\b/.test(cmd)) return 'diff';
  if (/\bgit\s+log\b/.test(cmd)) return 'log';
  if (/\bgit\s+clone\b/.test(cmd)) return 'clone';
  if (/\bgit\s+fetch\b/.test(cmd)) return 'fetch';
  if (/\bgit\s+stash\b/.test(cmd)) return 'stash';
  if (/\bgit\s+reset\b/.test(cmd)) return 'reset';
  if (/\bgit\s+rebase\b/.test(cmd)) return 'rebase';
  if (/\bgit\s+init\b/.test(cmd)) return 'init';
  if (/\bgit\s+tag\b/.test(cmd)) return 'tag';
  if (/\bgit\s+remote\b/.test(cmd)) return 'remote';
  if (/\bgit\s+cherry-pick\b/.test(cmd)) return 'cherry-pick';
  if (/\bgit\s+revert\b/.test(cmd)) return 'revert';
  if (/\bgit\s+restore\b/.test(cmd)) return 'restore';
  if (/\bgit\s+show\b/.test(cmd)) return 'show';

  return 'other';
}

/**
 * Extract files from git command
 */
function extractGitFiles(cmd: string, opType: GitOperationType): string[] {
  const files: string[] = [];

  // git add <files>
  if (opType === 'add') {
    // Match: git add file1 file2 or git add .
    const addMatch = cmd.match(/\bgit\s+add\s+(.+?)(?:\s*&&|\s*$|\s*\|)/);
    if (addMatch) {
      const filesPart = addMatch[1].trim();
      // Split by space but handle quoted paths
      const parts = filesPart.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      for (const part of parts) {
        const cleaned = part.replace(/^["']|["']$/g, '');
        if (!cleaned.startsWith('-') && cleaned !== '.') {
          files.push(cleaned);
        } else if (cleaned === '.') {
          files.push('.');
        }
      }
    }
  }

  // git commit with files
  if (opType === 'commit') {
    // Match files after commit (but before -m)
    const commitMatch = cmd.match(/\bgit\s+commit\s+([^-][^\s]*(?:\s+[^-][^\s]*)*)/);
    if (commitMatch) {
      const parts = commitMatch[1].trim().split(/\s+/);
      for (const part of parts) {
        if (!part.startsWith('-')) {
          files.push(part);
        }
      }
    }
  }

  // git diff <files>
  if (opType === 'diff') {
    // Match: git diff [options] [--] [<path>...]
    const diffMatch = cmd.match(/\bgit\s+diff\s+(?:[^|&]+?)([^\s|&-][^\s|&]*\.[a-z]+)/gi);
    if (diffMatch) {
      for (const match of diffMatch) {
        const fileMatch = match.match(/([^\s]+\.[a-z]+)$/i);
        if (fileMatch) {
          files.push(fileMatch[1]);
        }
      }
    }
  }

  return files;
}

/**
 * Extract branch name from git command
 */
function extractGitBranch(cmd: string, opType: GitOperationType): string | undefined {
  // git checkout <branch>
  if (opType === 'checkout') {
    const match = cmd.match(/\bgit\s+checkout\s+(?:-b\s+)?([^\s-][^\s]*)/);
    if (match && !match[1].includes('/') && !match[1].includes('.')) {
      return match[1];
    }
  }

  // git branch <name> or git branch -d <name>
  if (opType === 'branch') {
    const match = cmd.match(/\bgit\s+branch\s+(?:-[dD]\s+)?([^\s-][^\s]*)/);
    if (match) {
      return match[1];
    }
  }

  // git merge <branch>
  if (opType === 'merge') {
    const match = cmd.match(/\bgit\s+merge\s+([^\s-][^\s]*)/);
    if (match) {
      return match[1];
    }
  }

  // git push/pull origin <branch>
  if (opType === 'push' || opType === 'pull') {
    const match = cmd.match(/\bgit\s+(?:push|pull)\s+\w+\s+([^\s:]+)/);
    if (match) {
      return match[1];
    }
  }

  // git rebase <branch>
  if (opType === 'rebase') {
    const match = cmd.match(/\bgit\s+rebase\s+(?:-i\s+)?([^\s-][^\s]*)/);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Extract commit message from git commit command
 */
function extractCommitMessage(cmd: string): string | undefined {
  // Match heredoc style: -m "$(cat <<'EOF' ... EOF)" (common in Claude Code)
  // This pattern captures multiline commit messages
  const heredocMatch = cmd.match(/-m\s+"\$\(cat\s+<<['"]?EOF['"]?\s*\n([\s\S]*?)\nEOF\s*\)"/);
  if (heredocMatch) {
    return heredocMatch[1].trim();
  }

  // Match simple -m "message" or -m 'message' (single line)
  const simpleMatch = cmd.match(/\bgit\s+commit\s+[^|&]*?-m\s+["']([^"']+)["']/);
  if (simpleMatch) {
    return simpleMatch[1];
  }

  // Match -m without quotes (e.g., -m message-without-spaces)
  const noQuoteMatch = cmd.match(/\bgit\s+commit\s+[^|&]*?-m\s+([^\s"'&|]+)/);
  if (noQuoteMatch && !noQuoteMatch[1].startsWith('$(')) {
    return noQuoteMatch[1];
  }

  return undefined;
}

/**
 * Extract remote name from git command
 */
function extractGitRemoteName(cmd: string, opType: GitOperationType): string | undefined {
  // Shell operators to exclude
  const shellOperators = ['&&', '||', '|', ';', '>', '<', '&', '$'];

  if (opType === 'push' || opType === 'pull' || opType === 'fetch') {
    // Match: git push/pull/fetch <remote> [branch]
    const match = cmd.match(/\bgit\s+(?:push|pull|fetch)\s+([a-zA-Z][a-zA-Z0-9_-]*)/);
    if (match && !shellOperators.includes(match[1])) {
      return match[1];
    }
  }

  if (opType === 'remote') {
    const match = cmd.match(/\bgit\s+remote\s+add\s+([a-zA-Z][a-zA-Z0-9_-]*)/);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Extract repository URL from git command
 */
function extractRepoUrl(cmd: string, opType: GitOperationType): string | undefined {
  if (opType === 'clone') {
    const match = cmd.match(/\bgit\s+clone\s+(?:--[^\s]+\s+)*([^\s]+)/);
    if (match) {
      return match[1];
    }
  }

  if (opType === 'remote') {
    const match = cmd.match(/\bgit\s+remote\s+add\s+\w+\s+([^\s]+)/);
    if (match) {
      return match[1];
    }
  }

  // gh repo clone
  if (opType === 'gh_repo') {
    const match = cmd.match(/\bgh\s+repo\s+clone\s+([^\s]+)/);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Extract commit ref from git command
 */
function extractCommitRef(cmd: string, opType: GitOperationType): string | undefined {
  // git reset <commit>
  if (opType === 'reset') {
    const match = cmd.match(/\bgit\s+reset\s+(?:--[^\s]+\s+)?([a-f0-9]{7,40}|HEAD[~^][0-9]*)/i);
    if (match) {
      return match[1];
    }
  }

  // git cherry-pick <commit>
  if (opType === 'cherry-pick') {
    const match = cmd.match(/\bgit\s+cherry-pick\s+([a-f0-9]{7,40})/i);
    if (match) {
      return match[1];
    }
  }

  // git revert <commit>
  if (opType === 'revert') {
    const match = cmd.match(/\bgit\s+revert\s+([a-f0-9]{7,40})/i);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Extract PR number from gh command
 */
function extractPrNumber(cmd: string): string | undefined {
  const match = cmd.match(/\bgh\s+pr\s+(?:view|checkout|merge|close|review|comment)\s+(\d+)/);
  if (match) {
    return match[1];
  }
  return undefined;
}

/**
 * Extract issue number from gh command
 */
function extractIssueNumber(cmd: string): string | undefined {
  const match = cmd.match(/\bgh\s+issue\s+(?:view|close|comment)\s+(\d+)/);
  if (match) {
    return match[1];
  }
  return undefined;
}

/**
 * Check if command is an actual git/gh command (not just containing "git" in filename)
 */
function isActualGitCommand(cmd: string): boolean {
  // Must start with git or gh, or have them after common shell operators
  // Patterns that indicate actual git commands:
  // - "git status", "gh pr", etc. at start
  // - "cd ... && git ...", "cd ... ; git ..."
  // - "ssh ... 'git ...'"
  return /(?:^|\s|&&|\|\||;|'|")\s*(git|gh)\s+[a-z]/.test(cmd);
}

/**
 * Extract git operations from tool uses
 */
function extractGitOperationsFromToolUses(toolUses: ClaudeToolUse[]): GitOperation[] {
  const operations: GitOperation[] = [];

  for (const tool of toolUses) {
    const { name, input, turnIndex, lineIndex } = tool;
    const inputObj = input as Record<string, unknown> | undefined;

    // Only process Bash commands
    if (name.toLowerCase() !== 'bash' || !inputObj?.command) continue;

    const cmd = String(inputObj.command);

    // Check if this is an actual git/gh command (not just "git" in a filename)
    if (!isActualGitCommand(cmd)) continue;

    // Extract remote host and inner command for SSH/Docker
    const { cmd: innerCmd, remote: remoteHost } = extractInnerCommand(cmd);

    const opType = detectGitOperationType(innerCmd);

    // Skip if we couldn't identify a specific git operation
    if (opType === 'other') continue;

    const operation: GitOperation = {
      type: opType,
      command: cmd,
      turnIndex,
      lineIndex,
      remoteHost: remoteHost || undefined,
    };

    // Extract additional details based on operation type
    const files = extractGitFiles(innerCmd, opType);
    if (files.length > 0) {
      operation.files = files;
    }

    const branch = extractGitBranch(innerCmd, opType);
    if (branch) {
      operation.branch = branch;
    }

    if (opType === 'commit') {
      const message = extractCommitMessage(innerCmd);
      if (message) {
        operation.commitMessage = message;
      }
    }

    const remoteName = extractGitRemoteName(innerCmd, opType);
    if (remoteName) {
      operation.remoteName = remoteName;
    }

    const repoUrl = extractRepoUrl(innerCmd, opType);
    if (repoUrl) {
      operation.repoUrl = repoUrl;
    }

    const commitRef = extractCommitRef(innerCmd, opType);
    if (commitRef) {
      operation.commitRef = commitRef;
    }

    if (opType === 'gh_pr') {
      const prNum = extractPrNumber(innerCmd);
      if (prNum) {
        operation.prNumber = prNum;
      }
    }

    if (opType === 'gh_issue') {
      const issueNum = extractIssueNumber(innerCmd);
      if (issueNum) {
        operation.issueNumber = issueNum;
      }
    }

    if (opType === 'tag') {
      const tagMatch = innerCmd.match(/\bgit\s+tag\s+(?:-[ad]\s+)?([^\s-][^\s]*)/);
      if (tagMatch) {
        operation.tagName = tagMatch[1];
      }
    }

    if (opType === 'stash') {
      const stashMatch = innerCmd.match(/\bgit\s+stash\s+(?:apply|pop|drop)\s+(stash@\{[0-9]+\})/);
      if (stashMatch) {
        operation.stashRef = stashMatch[1];
      }
    }

    operations.push(operation);
  }

  return operations;
}

// ============================================================================
// Session Store Implementation
// ============================================================================

/**
 * @deprecated Use EventStore for execution tracking and ClaudeSessionReader for
 * reading Claude Code sessions. See module-level documentation for migration guide.
 */
export class AgentSessionStore extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();
  private executionIndex: Map<string, string> = new Map(); // executionId -> sessionId
  private config: Required<SessionStoreConfig>;
  private persistPath: string;
  private cleanupInterval?: NodeJS.Timeout;
  // Cache for line counts - keyed by session path, stores {mtime, lineCount}
  private lineCountCache: Map<string, { mtime: number; lineCount: number }> = new Map();
  // Cache for parsed session data - keyed by cacheKey, stores {mtime, data, timestamp}
  // Cache entries expire after 60 seconds or if file mtime changes
  private sessionDataCache: Map<string, {
    mtime: number;
    data: ClaudeSessionData;
    timestamp: number;
    includeRawMessages: boolean;
  }> = new Map();
  private static SESSION_CACHE_TTL_MS = 60000; // 60 seconds

  constructor(config: SessionStoreConfig) {
    super();
    this.config = {
      projectPath: config.projectPath,
      persist: config.persist ?? true,
      maxSessions: config.maxSessions ?? 1000,
      cleanupAgeMs: config.cleanupAgeMs ?? 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    this.persistPath = path.join(config.projectPath, '.lm-assist', 'sessions.json');

    // Load persisted sessions
    if (this.config.persist) {
      this.loadFromDisk();
    }

    // Start cleanup interval
    if (this.config.cleanupAgeMs > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000); // Every hour
    }
  }

  // --------------------------------------------------------------------------
  // Session Management
  // --------------------------------------------------------------------------

  /**
   * Create a new session entry
   */
  createSession(params: {
    sessionId: string;
    executionId: string;
    tier: TierName | 'orchestrator';
    prompt: string;
    cwd: string;
    parentSessionId?: string;
    metadata?: Record<string, unknown>;
  }): AgentSession {
    const now = new Date();

    const session: AgentSession = {
      sessionId: params.sessionId,
      executionId: params.executionId,
      tier: params.tier,
      status: 'pending',
      prompt: params.prompt,
      cwd: params.cwd,
      createdAt: now,
      lastActivityAt: now,
      turnCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      costUsd: 0,
      parentSessionId: params.parentSessionId,
      childSessionIds: [],
      metadata: params.metadata || {},
    };

    this.sessions.set(params.sessionId, session);
    this.executionIndex.set(params.executionId, params.sessionId);

    // Link to parent if exists
    if (params.parentSessionId) {
      const parent = this.sessions.get(params.parentSessionId);
      if (parent) {
        parent.childSessionIds.push(params.sessionId);
      }
    }

    this.emitUpdate('session_created', session);
    this.persist();

    return session;
  }

  /**
   * Update session ID after SDK init (when actual session ID is known)
   */
  updateSessionId(oldSessionId: string, newSessionId: string): AgentSession | null {
    const session = this.sessions.get(oldSessionId);
    if (!session) return null;

    // Update session ID
    session.sessionId = newSessionId;
    session.status = 'initializing';
    session.startedAt = new Date();
    session.lastActivityAt = new Date();

    // Update maps
    this.sessions.delete(oldSessionId);
    this.sessions.set(newSessionId, session);
    this.executionIndex.set(session.executionId, newSessionId);

    this.emitUpdate('session_updated', session, 'pending');
    this.persist();

    return session;
  }

  /**
   * Update session status
   */
  updateStatus(sessionId: string, status: SessionStatus, details?: {
    error?: string;
    result?: string;
  }): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const previousStatus = session.status;
    session.status = status;
    session.lastActivityAt = new Date();

    if (details?.error) session.error = details.error;
    if (details?.result) session.result = details.result;

    if (status === 'completed' || status === 'failed' || status === 'aborted' || status === 'timeout') {
      session.completedAt = new Date();
    }

    const eventType = status === 'completed' ? 'session_completed' :
                      status === 'failed' ? 'session_failed' : 'session_updated';

    this.emitUpdate(eventType, session, previousStatus);
    this.persist();

    return session;
  }

  /**
   * Update session progress (turn count, usage, etc.)
   */
  updateProgress(sessionId: string, progress: {
    turnCount?: number;
    usage?: Partial<AgentSession['usage']>;
    costUsd?: number;
    model?: string;
  }): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (session.status === 'initializing') {
      session.status = 'running';
    }

    session.lastActivityAt = new Date();

    if (progress.turnCount !== undefined) {
      session.turnCount = progress.turnCount;
    }

    if (progress.usage) {
      if (progress.usage.inputTokens !== undefined) {
        session.usage.inputTokens += progress.usage.inputTokens;
      }
      if (progress.usage.outputTokens !== undefined) {
        session.usage.outputTokens += progress.usage.outputTokens;
      }
      if (progress.usage.cacheReadTokens !== undefined) {
        session.usage.cacheReadTokens += progress.usage.cacheReadTokens;
      }
      if (progress.usage.cacheWriteTokens !== undefined) {
        session.usage.cacheWriteTokens += progress.usage.cacheWriteTokens;
      }
    }

    if (progress.costUsd !== undefined) {
      session.costUsd = progress.costUsd;
    }

    if (progress.model) {
      session.model = progress.model;
    }

    this.emitUpdate('session_updated', session);
    this.persist();

    return session;
  }

  /**
   * Mark session as waiting for input
   */
  markWaiting(sessionId: string, reason?: string): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const previousStatus = session.status;
    session.status = 'waiting';
    session.lastActivityAt = new Date();
    if (reason) {
      session.metadata.waitingReason = reason;
    }

    this.emitUpdate('session_updated', session, previousStatus);
    this.persist();

    return session;
  }

  /**
   * Resume session from waiting
   */
  resumeFromWaiting(sessionId: string): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'waiting') return null;

    session.status = 'running';
    session.lastActivityAt = new Date();
    delete session.metadata.waitingReason;

    this.emitUpdate('session_updated', session, 'waiting');
    this.persist();

    return session;
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  /**
   * Get session by ID
   */
  getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get session by execution ID
   */
  getSessionByExecutionId(executionId: string): AgentSession | null {
    const sessionId = this.executionIndex.get(executionId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Query sessions with filters
   */
  querySessions(query: SessionQuery = {}): AgentSession[] {
    let results = Array.from(this.sessions.values());

    // Apply filters
    if (query.tier) {
      results = results.filter(s => s.tier === query.tier);
    }

    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      results = results.filter(s => statuses.includes(s.status));
    }

    if (query.executionId) {
      results = results.filter(s => s.executionId === query.executionId);
    }

    if (query.parentSessionId) {
      results = results.filter(s => s.parentSessionId === query.parentSessionId);
    }

    if (query.createdAfter) {
      results = results.filter(s => s.createdAt >= query.createdAfter!);
    }

    if (query.createdBefore) {
      results = results.filter(s => s.createdAt <= query.createdBefore!);
    }

    // Sort
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder || 'desc';
    results.sort((a, b) => {
      const aVal = sortBy === 'createdAt' ? a.createdAt.getTime() :
                   sortBy === 'lastActivityAt' ? a.lastActivityAt.getTime() :
                   a.costUsd;
      const bVal = sortBy === 'createdAt' ? b.createdAt.getTime() :
                   sortBy === 'lastActivityAt' ? b.lastActivityAt.getTime() :
                   b.costUsd;
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });

    // Pagination
    const offset = query.offset || 0;
    const limit = query.limit || results.length;
    results = results.slice(offset, offset + limit);

    return results;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): AgentSession[] {
    return this.querySessions({
      status: ['pending', 'initializing', 'running', 'waiting'],
    });
  }

  /**
   * Get sessions for a specific tier
   */
  getTierSessions(tier: TierName | 'orchestrator'): AgentSession[] {
    return this.querySessions({ tier });
  }

  /**
   * Get child sessions of a parent
   */
  getChildSessions(parentSessionId: string): AgentSession[] {
    return this.querySessions({ parentSessionId });
  }

  /**
   * Get statistics
   */
  getStats(): SessionStats {
    const sessions = Array.from(this.sessions.values());

    const byStatus: Record<SessionStatus, number> = {
      pending: 0,
      initializing: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
      timeout: 0,
    };

    const byTier: Record<string, number> = {};
    let totalCostUsd = 0;
    const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let totalDurationMs = 0;
    let totalTurns = 0;
    let completedCount = 0;

    for (const session of sessions) {
      byStatus[session.status]++;
      byTier[session.tier] = (byTier[session.tier] || 0) + 1;
      totalCostUsd += session.costUsd;
      totalTokens.input += session.usage.inputTokens;
      totalTokens.output += session.usage.outputTokens;
      totalTokens.cacheRead += session.usage.cacheReadTokens;
      totalTokens.cacheWrite += session.usage.cacheWriteTokens;
      totalTurns += session.turnCount;

      if (session.completedAt && session.startedAt) {
        totalDurationMs += session.completedAt.getTime() - session.startedAt.getTime();
        completedCount++;
      }
    }

    return {
      totalSessions: sessions.length,
      byStatus,
      byTier,
      activeSessions: byStatus.pending + byStatus.initializing + byStatus.running + byStatus.waiting,
      totalCostUsd,
      totalTokens,
      averageDurationMs: completedCount > 0 ? totalDurationMs / completedCount : 0,
      averageTurns: completedCount > 0 ? totalTurns / completedCount : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Cleanup & Persistence
  // --------------------------------------------------------------------------

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Remove from parent's children list
    if (session.parentSessionId) {
      const parent = this.sessions.get(session.parentSessionId);
      if (parent) {
        parent.childSessionIds = parent.childSessionIds.filter(id => id !== sessionId);
      }
    }

    this.sessions.delete(sessionId);
    this.executionIndex.delete(session.executionId);

    this.emitUpdate('session_deleted', session);
    this.persist();

    return true;
  }

  /**
   * Cleanup old completed sessions
   */
  cleanup(): number {
    const cutoff = Date.now() - this.config.cleanupAgeMs;
    const toDelete: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (
        (session.status === 'completed' || session.status === 'failed' ||
         session.status === 'aborted' || session.status === 'timeout') &&
        session.completedAt &&
        session.completedAt.getTime() < cutoff
      ) {
        toDelete.push(sessionId);
      }
    }

    for (const sessionId of toDelete) {
      this.deleteSession(sessionId);
    }

    return toDelete.length;
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessions.clear();
    this.executionIndex.clear();
    this.persist();
  }

  /**
   * Persist sessions to disk
   */
  private persist(): void {
    if (!this.config.persist) return;

    try {
      const dir = path.dirname(this.persistPath);
      // Always try to create directory (mkdirSync with recursive is idempotent)
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        version: '1.0',
        updatedAt: new Date().toISOString(),
        sessions: Array.from(this.sessions.values()).map(s => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          startedAt: s.startedAt?.toISOString(),
          completedAt: s.completedAt?.toISOString(),
          lastActivityAt: s.lastActivityAt.toISOString(),
        })),
      };

      // Atomic write: write to temp file, then rename
      const tempPath = this.persistPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
      fs.renameSync(tempPath, this.persistPath);
    } catch (err) {
      console.error('Failed to persist session store:', err);
    }
  }

  /**
   * Load sessions from disk
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;

      const content = fs.readFileSync(this.persistPath, 'utf-8');

      // Safe JSON parsing with error handling
      let data: { version?: string; sessions?: unknown[] };
      try {
        data = JSON.parse(content);
      } catch (parseError) {
        console.error('Failed to parse session store JSON, starting fresh:', parseError);
        return;
      }

      // Validate data structure
      if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) {
        console.error('Invalid session store format, starting fresh');
        return;
      }

      for (const s of data.sessions) {
        // Validate each session has required fields
        if (!s || typeof s !== 'object') continue;
        const sessionData = s as Record<string, unknown>;
        if (!sessionData.sessionId || !sessionData.executionId) continue;

        const session: AgentSession = {
          ...(sessionData as unknown as AgentSession),
          createdAt: new Date(sessionData.createdAt as string),
          startedAt: sessionData.startedAt ? new Date(sessionData.startedAt as string) : undefined,
          completedAt: sessionData.completedAt ? new Date(sessionData.completedAt as string) : undefined,
          lastActivityAt: new Date(sessionData.lastActivityAt as string),
        };

        this.sessions.set(session.sessionId, session);
        this.executionIndex.set(session.executionId, session.sessionId);
      }
    } catch (err) {
      console.error('Failed to load session store:', err);
    }
  }

  /**
   * Emit session update event
   */
  private emitUpdate(type: SessionUpdateEvent['type'], session: AgentSession, previousStatus?: SessionStatus): void {
    const event: SessionUpdateEvent = {
      type,
      session: { ...session },
      previousStatus,
    };
    this.emit('session_update', event);
    this.emit(type, event);
  }

  /**
   * Stop the store (cleanup interval, etc.)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  // --------------------------------------------------------------------------
  // Claude Code Session Reading
  // --------------------------------------------------------------------------

  /**
   * Get the path to a Claude Code session file.
   * Supports both regular session files ({sessionId}.jsonl) and agent files (agent-{agentId}.jsonl).
   */
  getSessionPath(sessionId: string, cwd?: string): string {
    return this.getSessionPathWithMeta(sessionId, cwd).path;
  }

  /**
   * Get Claude Code session path with metadata (parent session ID if agent)
   */
  getSessionPathWithMeta(sessionId: string, cwd?: string): {
    path: string;
    parentSessionId?: string;
    isAgent?: boolean;
  } {
    const projectCwd = cwd || this.config.projectPath;
    // Claude Code uses format: -home-ubuntu-project (leading dash, all slashes become dashes)
    const projectPathKey = legacyEncodeProjectPath(projectCwd);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);

    // Try regular session file first
    const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionPath)) {
      return { path: sessionPath };
    }

    // Try agent file pattern (agent-{agentId}.jsonl) - top-level agent without parent
    const agentPath = path.join(projectDir, `agent-${sessionId}.jsonl`);
    if (fs.existsSync(agentPath)) {
      return { path: agentPath, isAgent: true };
    }

    // Also check for agent files in nested subagents directories
    if (fs.existsSync(projectDir)) {
      try {
        const entries = fs.readdirSync(projectDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const nestedAgentPath = path.join(projectDir, entry.name, 'subagents', `agent-${sessionId}.jsonl`);
            if (fs.existsSync(nestedAgentPath)) {
              // entry.name is the parent session ID
              return { path: nestedAgentPath, parentSessionId: entry.name, isAgent: true };
            }
          }
        }
      } catch {
        // Ignore errors reading directory
      }
    }

    // If no cwd was specified and session not found, search all projects
    if (!cwd) {
      const foundProject = this.findSessionProject(sessionId);
      if (foundProject) {
        // Recursively call with the found project path
        return this.getSessionPathWithMeta(sessionId, foundProject);
      }
    }

    // Return the default path even if it doesn't exist (for backward compatibility)
    return { path: sessionPath };
  }

  /**
   * Check if a Claude Code session file exists
   */
  sessionExists(sessionId: string, cwd?: string): boolean {
    const sessionPath = this.getSessionPath(sessionId, cwd);
    return fs.existsSync(sessionPath);
  }

  /**
   * Find a session's project path by searching all projects.
   * Returns the cwd (project path) if found, null otherwise.
   */
  findSessionProject(sessionId: string): string | null {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) {
      return null;
    }

    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectDir = path.join(projectsDir, entry.name);

        // Check for regular session file
        const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
        if (fs.existsSync(sessionPath)) {
          return this.extractCwdFromSessionFile(sessionPath) || entry.name;
        }

        // Check for agent file at top level
        const agentPath = path.join(projectDir, `agent-${sessionId}.jsonl`);
        if (fs.existsSync(agentPath)) {
          return this.extractCwdFromSessionFile(agentPath) || entry.name;
        }

        // Check for agent file in nested subagents directories
        try {
          const subEntries = fs.readdirSync(projectDir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory()) {
              const nestedPath = path.join(projectDir, sub.name, 'subagents', `agent-${sessionId}.jsonl`);
              if (fs.existsSync(nestedPath)) {
                return this.extractCwdFromSessionFile(nestedPath) || entry.name;
              }
            }
          }
        } catch {
          // Ignore errors reading subdirectories
        }
      }
    } catch {
      // Ignore errors reading directory
    }

    return null;
  }

  /**
   * Extract the cwd field from the first few lines of a session JSONL file.
   */
  private extractCwdFromSessionFile(filePath: string): string | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
      fs.closeSync(fd);
      const content = buffer.slice(0, bytesRead).toString('utf8');
      for (const line of content.split('\n').slice(0, 20)) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.cwd) return msg.cwd;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return null;
  }

  /**
   * Read Claude Code session data directly from ~/.claude/projects/
   * Returns parsed session data with messages, tool uses, results, etc.
   * If no cwd is provided and session not found, searches all projects.
   *
   * Uses SessionCache for efficient incremental parsing of append-only JSONL files.
   */
  async readSession(sessionId: string, options?: {
    cwd?: string;
    includeRawMessages?: boolean;
  }): Promise<ClaudeSessionData | null> {
    let cwd = options?.cwd;

    // If no cwd provided, try to find the session in all projects
    if (!cwd) {
      const foundProject = this.findSessionProject(sessionId);
      if (foundProject) {
        cwd = foundProject;
      }
    }

    const pathMeta = this.getSessionPathWithMeta(sessionId, cwd);
    const sessionPath = pathMeta.path;

    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);
    const includeRawMessages = options?.includeRawMessages ?? false;

    // Use SessionCache for efficient incremental parsing
    const sessionCache = getSessionCache();
    const cacheData = await sessionCache.getSessionData(sessionPath);

    if (!cacheData) {
      return null;
    }

    // Get raw messages if requested (separate cache)
    let rawMessages: Array<any & { lineIndex: number }> | undefined;
    if (includeRawMessages) {
      rawMessages = await sessionCache.getRawMessages(sessionPath) || undefined;
    }

    // Convert cache data to ClaudeSessionData
    const result = convertCacheToSessionData(cacheData, stats.mtime, includeRawMessages, rawMessages);

    // Add parent session info if this is an agent
    if (pathMeta.parentSessionId) {
      result.parentSessionId = pathMeta.parentSessionId;
      result.isAgent = true;
    } else if (pathMeta.isAgent) {
      result.isAgent = true;
    }

    return result;
  }

  /**
   * Read Claude Code session data synchronously
   * If no cwd is provided and session not found, searches all projects.
   *
   * Uses SessionCache for efficient incremental parsing of append-only JSONL files.
   */
  readSessionSync(sessionId: string, options?: {
    cwd?: string;
    includeRawMessages?: boolean;
  }): ClaudeSessionData | null {
    let cwd = options?.cwd;

    // If no cwd provided, try to find the session in all projects
    if (!cwd) {
      const foundProject = this.findSessionProject(sessionId);
      if (foundProject) {
        cwd = foundProject;
      }
    }

    const pathMeta = this.getSessionPathWithMeta(sessionId, cwd);
    const sessionPath = pathMeta.path;

    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);
    const includeRawMessages = options?.includeRawMessages ?? false;

    // Use SessionCache for efficient incremental parsing
    const sessionCache = getSessionCache();
    const cacheData = sessionCache.getSessionDataSync(sessionPath);

    if (!cacheData) {
      return null;
    }

    // Get raw messages if requested (separate cache)
    let rawMessages: Array<any & { lineIndex: number }> | undefined;
    if (includeRawMessages) {
      rawMessages = sessionCache.getRawMessagesSync(sessionPath) || undefined;
    }

    // Convert cache data to ClaudeSessionData
    const result = convertCacheToSessionData(cacheData, stats.mtime, includeRawMessages, rawMessages);

    // Add parent session info if this is an agent
    if (pathMeta.parentSessionId) {
      result.parentSessionId = pathMeta.parentSessionId;
      result.isAgent = true;
    } else if (pathMeta.isAgent) {
      result.isAgent = true;
    }

    return result;
  }

  /**
   * The pattern that identifies a compact/continuation message.
   * These messages are created when a session runs out of context and is continued.
   */
  static readonly COMPACT_MESSAGE_PATTERN = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.';

  /**
   * Get all compact/continuation messages from a Claude Code session.
   *
   * Compact messages are user prompts that start with:
   * "This session is being continued from a previous conversation that ran out of context..."
   *
   * These indicate context compaction events where the session history was summarized.
   *
   * @param sessionId - The session ID to search
   * @param options - Optional configuration
   * @returns Array of compact messages with their positions, or null if session doesn't exist
   */
  async getCompactMessages(sessionId: string, options?: {
    cwd?: string;
  }): Promise<ClaudeCompactMessage[] | null> {
    const sessionPath = this.getSessionPath(sessionId, options?.cwd);

    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    // Use session cache for efficient incremental reads
    const sessionCache = getSessionCache();
    const rawMessages = await sessionCache.getRawMessages(sessionPath);

    if (!rawMessages) {
      return null;
    }

    const compactMessages: ClaudeCompactMessage[] = [];
    let turnIndex = 0;
    let compactOrder = 0;

    for (const msg of rawMessages) {
      const typedMsg = msg as ClaudeSessionMessage & {
        message?: string | { role?: string; content?: string };
        lineIndex: number;
      };

      // Track turn index for user messages
      if (typedMsg.type === 'user') {
        turnIndex++;

        // Check if this is a compact message
        // User messages have a 'message' field containing the prompt text
        // It can be either a string or an object with { role, content }
        let messageText = '';
        if (typeof typedMsg.message === 'string') {
          messageText = typedMsg.message;
        } else if (typedMsg.message && typeof typedMsg.message === 'object' && typeof typedMsg.message.content === 'string') {
          messageText = typedMsg.message.content;
        }

        if (messageText.startsWith(AgentSessionStore.COMPACT_MESSAGE_PATTERN)) {
          compactMessages.push({
            lineIndex: typedMsg.lineIndex,
            turnIndex,
            timestamp: typedMsg.timestamp,
            text: messageText,
            compactOrder: compactOrder++,
            parsedSummary: parseCompactMessageSummary(messageText),
          });
        }
      }
    }

    return compactMessages;
  }

  /**
   * Synchronous version of getCompactMessages
   * @deprecated Use async getCompactMessages() instead for better performance with caching.
   * This method reads the full file on every call without caching.
   */
  getCompactMessagesSync(sessionId: string, options?: {
    cwd?: string;
  }): ClaudeCompactMessage[] | null {
    const sessionPath = this.getSessionPath(sessionId, options?.cwd);

    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const content = fs.readFileSync(sessionPath, 'utf-8');
    const compactMessages: ClaudeCompactMessage[] = [];
    let turnIndex = 0;
    let compactOrder = 0;

    const lines = content.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.trim()) {
        try {
          const msg = JSON.parse(line) as ClaudeSessionMessage & {
            message?: string | { role?: string; content?: string };
          };

          if (msg.type === 'user') {
            turnIndex++;

            // User messages have a 'message' field containing the prompt text
            // It can be either a string or an object with { role, content }
            let messageText = '';
            if (typeof msg.message === 'string') {
              messageText = msg.message;
            } else if (msg.message && typeof msg.message === 'object' && typeof msg.message.content === 'string') {
              messageText = msg.message.content;
            }

            if (messageText.startsWith(AgentSessionStore.COMPACT_MESSAGE_PATTERN)) {
              compactMessages.push({
                lineIndex,
                turnIndex,
                timestamp: msg.timestamp,
                text: messageText,
                compactOrder: compactOrder++,
                parsedSummary: parseCompactMessageSummary(messageText),
              });
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }

    return compactMessages;
  }

  /**
   * Get session messages starting from a specific line position.
   * Useful for retrieving messages after a compact/continuation point.
   *
   * @param sessionId - The session ID
   * @param fromLineIndex - The line index to start from (0-based, inclusive)
   * @param options - Optional configuration
   * @returns Parsed session data for messages from the given position onwards
   */
  async getMessagesFromPosition(sessionId: string, fromLineIndex: number, options?: {
    cwd?: string;
    includeRawMessages?: boolean;
    /** Maximum number of lines to read (default: all) */
    limit?: number;
  }): Promise<ClaudeSessionData | null> {
    const sessionPath = this.getSessionPath(sessionId, options?.cwd);

    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    // Use session cache for efficient incremental reads
    const sessionCache = getSessionCache();
    const rawMessages = await sessionCache.getRawMessages(sessionPath);

    if (!rawMessages) {
      return null;
    }

    // Filter by line index and apply limit
    const maxLines = options?.limit ?? Number.MAX_SAFE_INTEGER;
    const filteredMessages = rawMessages
      .filter(msg => msg.lineIndex >= fromLineIndex)
      .slice(0, maxLines);

    // Get file mtime for running detection
    const stats = fs.statSync(sessionPath);
    const fileMtime = stats.mtime;

    return this.parseSessionMessages(
      filteredMessages as Array<ClaudeSessionMessage & { lineIndex: number }>,
      options?.includeRawMessages,
      fileMtime
    );
  }

  /**
   * Synchronous version of getMessagesFromPosition
   */
  getMessagesFromPositionSync(sessionId: string, fromLineIndex: number, options?: {
    cwd?: string;
    includeRawMessages?: boolean;
    limit?: number;
  }): ClaudeSessionData | null {
    const sessionPath = this.getSessionPath(sessionId, options?.cwd);

    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    // Use session cache for efficient incremental reads
    const sessionCache = getSessionCache();
    const rawMessages = sessionCache.getRawMessagesSync(sessionPath);

    if (!rawMessages) {
      return null;
    }

    // Filter by line index and apply limit
    const maxLines = options?.limit ?? Number.MAX_SAFE_INTEGER;
    const filteredMessages = rawMessages
      .filter(msg => msg.lineIndex >= fromLineIndex)
      .slice(0, maxLines);

    // Get file mtime for running detection
    const stats = fs.statSync(sessionPath);
    const fileMtime = stats.mtime;

    return this.parseSessionMessages(
      filteredMessages as Array<ClaudeSessionMessage & { lineIndex: number }>,
      options?.includeRawMessages,
      fileMtime
    );
  }

  /**
   * Parse Claude Code session messages into structured data
   * Handles both SDK format and CLI format session files
   */
  private parseSessionMessages(
    messages: Array<ClaudeSessionMessage & { lineIndex: number }>,
    includeRawMessages?: boolean,
    fileMtime?: Date
  ): ClaudeSessionData {
    let sessionId = '';
    let cwd = '';
    let model = '';
    let claudeCodeVersion = '';
    let permissionMode = '';
    let tools: string[] = [];
    let mcpServers: Array<{ name: string; status: string }> = [];
    let numTurns = 0;
    let durationMs = 0;
    let durationApiMs = 0;
    let totalCostUsd = 0;
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    let result: string | undefined;
    let errors: string[] | undefined;
    let success = false;
    let hasResultMessage = false;
    const toolUses: ClaudeToolUse[] = [];
    const responses: Array<{ turnIndex: number; lineIndex: number; text: string; isApiError?: boolean; requestId?: string }> = [];
    const userPrompts: ClaudeUserPrompt[] = [];
    const thinkingBlocks: Array<{ turnIndex: number; lineIndex: number; thinking: string }> = [];
    let systemPrompt: string | undefined;
    // Track all todos by content, keeping latest status for each
    const allTodosMap = new Map<string, { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string; lineIndex: number }>();
    // Track all tasks by id, keeping latest state for each (v2.1.17+ TaskCreate/TaskUpdate)
    const allTasksMap = new Map<string, {
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
    }>();
    // Track subagent invocations from Task tool calls
    const subagentsMap = new Map<string, SubagentInvocation>();
    // Track subagent progress updates
    const subagentProgressList: SubagentProgressUpdate[] = [];
    // Track team data
    let teamName: string | undefined;
    const allTeams: string[] = [];
    const teamOperations: Array<{ operation: 'spawnTeam' | 'cleanup'; teamName?: string; description?: string; turnIndex: number; lineIndex: number }> = [];
    const teamMessages: Array<{ messageType: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'; recipient?: string; content?: string; summary?: string; requestId?: string; approve?: boolean; turnIndex: number; lineIndex: number }> = [];
    // Use a single unified turnIndex counter for proper interleaving of user/assistant messages
    let turnIndex = 0;
    // Track current user prompt index (0-based, increments after each user prompt)
    let currentUserPromptIndex = -1; // Will be 0 after first user prompt
    let firstTimestamp: Date | null = null;
    let lastTimestamp: Date | null = null;

    for (const msg of messages) {
      // Track timestamps for duration calculation
      if (msg.timestamp) {
        const ts = new Date(msg.timestamp as string);
        if (!firstTimestamp) firstTimestamp = ts;
        lastTimestamp = ts;
      }

      // Extract session metadata from any message (present in all messages)
      if (!sessionId && (msg as any).sessionId) {
        sessionId = (msg as any).sessionId;
      }
      if (!cwd && (msg as any).cwd) {
        cwd = (msg as any).cwd;
      }
      if (!teamName && (msg as any).teamName) {
        teamName = (msg as any).teamName;
      }
      if (!claudeCodeVersion && (msg as any).version) {
        claudeCodeVersion = (msg as any).version;
      }

      // System init message (SDK format)
      if (msg.type === 'system' && msg.subtype === 'init') {
        const init = msg as unknown as ClaudeSystemInit;
        sessionId = init.session_id || sessionId;
        cwd = init.cwd || cwd;
        model = init.model || model;
        claudeCodeVersion = init.claude_code_version || claudeCodeVersion;
        permissionMode = init.permissionMode || permissionMode;
        tools = init.tools || tools;
        mcpServers = init.mcp_servers || mcpServers;
      }

      // Assistant message (both SDK and CLI format)
      if (msg.type === 'assistant') {
        const assistantMsg = msg as any;
        turnIndex++;

        // Extract model from message
        if (assistantMsg.message?.model) {
          model = assistantMsg.message.model;
        }

        // Detect Anthropic API error messages (500, overloaded, etc.)
        // These have isApiErrorMessage: true, model: "<synthetic>", and zero usage
        const isApiError = !!(assistantMsg.isApiErrorMessage || assistantMsg.error);

        // Extract text and tool uses from content array
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              if (isApiError) {
                // Extract request_id from the error JSON in the text
                let requestId: string | undefined;
                const reqMatch = block.text.match(/"request_id"\s*:\s*"([^"]+)"/);
                if (reqMatch) requestId = reqMatch[1];
                responses.push({ turnIndex, lineIndex: msg.lineIndex, text: block.text, isApiError: true, requestId });
              } else {
                responses.push({ turnIndex, lineIndex: msg.lineIndex, text: block.text });
              }
            }
            if (block.type === 'tool_use' && block.id && block.name) {
              toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input,
                turnIndex,
                lineIndex: msg.lineIndex,
              });
              // Collect unique tool names
              if (!tools.includes(block.name)) {
                tools.push(block.name);
              }

              // Extract TaskCreate - creates new task
              if (block.name === 'TaskCreate' && block.input) {
                const input = block.input as any;
                // TaskCreate doesn't have id in input - it's assigned by the tool
                // We'll use the tool_use id temporarily, then update from tool_result
                const tempId = `temp-${block.id}`;
                allTasksMap.set(tempId, {
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

              // Extract TaskUpdate - updates existing task
              if (block.name === 'TaskUpdate' && block.input) {
                const input = block.input as any;
                const taskId = input.taskId;
                if (taskId) {
                  const existing = allTasksMap.get(taskId);
                  if (existing) {
                    // Update existing task
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
                          (existing.metadata as Record<string, unknown>)[k] = v;
                        }
                      }
                    }
                    existing.turnIndex = turnIndex; // Update to latest turn
                    existing.lineIndex = msg.lineIndex; // Update to latest line
                  } else {
                    // Task not created in this session, create placeholder
                    allTasksMap.set(taskId, {
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

              // Extract Task tool calls (subagent invocations)
              if (block.name === 'Task' && block.input) {
                const input = block.input as any;
                const subagentType = input.subagent_type || input.type || 'general-purpose';
                const prompt = input.prompt || '';
                // Use tool_use_id as temporary key until we get agentId from progress
                subagentsMap.set(block.id, {
                  agentId: '', // Will be populated from agent_progress
                  toolUseId: block.id,
                  type: subagentType as SubagentType,
                  prompt,
                  description: input.description,
                  model: input.model,
                  // Parent session indices
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  userPromptIndex: Math.max(0, currentUserPromptIndex),
                  // Status
                  startedAt: assistantMsg.timestamp,
                  status: 'pending',
                  runInBackground: input.run_in_background,
                });
              }

              // Extract Teammate tool calls (team operations)
              if (block.name === 'Teammate' && block.input) {
                const input = block.input as any;
                const op = input.operation || 'spawnTeam';
                teamOperations.push({
                  operation: op,
                  teamName: input.team_name,
                  description: input.description,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
                // Populate allTeams from spawnTeam operations
                if (op === 'spawnTeam' && input.team_name && !allTeams.includes(input.team_name)) {
                  allTeams.push(input.team_name);
                }
              }

              // Extract SendMessage tool calls (team messages)
              if (block.name === 'SendMessage' && block.input) {
                const input = block.input as any;
                teamMessages.push({
                  messageType: input.type || 'message',
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
            // Extract thinking blocks (extended thinking content)
            if (block.type === 'thinking' && block.thinking) {
              thinkingBlocks.push({ turnIndex, lineIndex: msg.lineIndex, thinking: block.thinking });
            }
          }
        }

        // Update usage from this message
        const msgUsage = assistantMsg.message?.usage;
        if (msgUsage) {
          usage.inputTokens += msgUsage.input_tokens || 0;
          usage.outputTokens += msgUsage.output_tokens || 0;
          usage.cacheCreationInputTokens += msgUsage.cache_creation_input_tokens || 0;
          usage.cacheReadInputTokens += msgUsage.cache_read_input_tokens || 0;
        }
      }

      // User message - extract text prompts (not tool results)
      if (msg.type === 'user') {
        turnIndex++;  // Use unified counter for proper ordering with assistant messages
        const userMsg = msg as any;
        const content = userMsg.message?.content;

        // Check if this user message has actual text content (not just tool_result)
        let hasTextContent = false;
        if (typeof content === 'string' && content.trim()) {
          hasTextContent = true;
        } else if (Array.isArray(content)) {
          hasTextContent = content.some((b: any) => b.type === 'text' && b.text);
        }
        if (hasTextContent) {
          currentUserPromptIndex++;  // Increment only when we have an actual user prompt
        }

        // Handle plain string content (direct user prompt)
        if (typeof content === 'string' && content.trim()) {
          userPrompts.push({
            turnIndex,
            lineIndex: msg.lineIndex,
            text: content,
            timestamp: userMsg.timestamp,
          });
        }
        // Handle array content (may contain text blocks or tool_result blocks)
        else if (Array.isArray(content)) {
          for (const block of content) {
            // Only extract text prompts, not tool_result blocks
            if (block.type === 'text' && block.text) {
              userPrompts.push({
                turnIndex,
                lineIndex: msg.lineIndex,
                text: block.text,
                timestamp: userMsg.timestamp,
              });
            }
            // Extract TaskCreate results to get assigned task ID
            // Format: "Task #11 created successfully: ..."
            if (block.type === 'tool_result' && block.tool_use_id && typeof block.content === 'string') {
              const taskCreateMatch = block.content.match(/Task #(\d+) created successfully/);
              if (taskCreateMatch) {
                const assignedId = taskCreateMatch[1];
                const tempId = `temp-${block.tool_use_id}`;
                const tempTask = allTasksMap.get(tempId);
                if (tempTask) {
                  // Update task with real ID
                  allTasksMap.delete(tempId);
                  tempTask.id = assignedId;
                  allTasksMap.set(assignedId, tempTask);
                }
              }

              // Extract Task tool results (subagent completion/error)
              // Update subagent status when we get the tool_result
              const subagent = subagentsMap.get(block.tool_use_id);
              if (subagent) {
                subagent.status = block.is_error ? 'error' : 'completed';
                subagent.completedAt = userMsg.timestamp;
                // Extract result text if present
                if (typeof block.content === 'string') {
                  subagent.result = block.content.slice(0, 2000); // Truncate long results
                } else if (Array.isArray(block.content)) {
                  const textContent = block.content.find((c: any) => c.type === 'text');
                  if (textContent?.text) {
                    subagent.result = textContent.text.slice(0, 2000);
                  }
                }
              }
            }
          }
        }

        // Extract todos from toolUseResult.newTodos (TodoWrite tool results)
        // Accumulate all todos, keeping latest status for each unique content
        const toolResult = userMsg.toolUseResult;
        if (toolResult?.newTodos && Array.isArray(toolResult.newTodos)) {
          for (const todo of toolResult.newTodos) {
            if (todo.content) {
              allTodosMap.set(todo.content, {
                content: todo.content,
                status: todo.status || 'pending',
                activeForm: todo.activeForm || '',
                lineIndex: msg.lineIndex,
              });
            }
          }
        }
      }

      // Progress message (may contain agent_progress for subagents)
      if (msg.type === 'progress') {
        const progressData = (msg as any).data;
        if (progressData?.type === 'agent_progress' && progressData.agentId) {
          const agentId = progressData.agentId;
          const parentToolUseId = (msg as any).parentToolUseID;

          // Update subagent with agentId if we have it
          if (parentToolUseId) {
            const subagent = subagentsMap.get(parentToolUseId);
            if (subagent && !subagent.agentId) {
              subagent.agentId = agentId;
              subagent.status = 'running';
            }
          }

          // Track progress update
          const progressUpdate: SubagentProgressUpdate = {
            agentId,
            timestamp: msg.timestamp as string || '',
            lineIndex: msg.lineIndex,
          };

          // Extract message content from progress
          if (progressData.message) {
            const progMsg = progressData.message;
            progressUpdate.message = {
              type: progMsg.type,
            };
            // Extract content from normalized messages if available
            if (progMsg.message?.content) {
              const content = progMsg.message.content;
              if (Array.isArray(content)) {
                const textBlock = content.find((c: any) => c.type === 'text');
                if (textBlock?.text) {
                  progressUpdate.message.content = textBlock.text.slice(0, 500);
                }
                const toolBlock = content.find((c: any) => c.type === 'tool_use');
                if (toolBlock?.name) {
                  progressUpdate.message.toolName = toolBlock.name;
                }
              }
            }
          }

          subagentProgressList.push(progressUpdate);
        }
      }

      // System message with content (may contain system prompt)
      if (msg.type === 'system' && (msg as any).content && !systemPrompt) {
        const content = (msg as any).content;
        if (typeof content === 'string' && content.length > 0 && content.length < 10000) {
          // Only capture if it looks like a system prompt, not a command output
          if (!content.includes('<command-name>') && !content.includes('<local-command')) {
            systemPrompt = content;
          }
        }
      }

      // Result message (SDK format)
      if (msg.type === 'result') {
        hasResultMessage = true;
        const resultMsg = msg as unknown as ClaudeResultMessage;
        sessionId = resultMsg.session_id || sessionId;
        success = resultMsg.subtype === 'success';
        result = resultMsg.result;
        errors = resultMsg.errors;
        numTurns = resultMsg.num_turns || numTurns;
        durationMs = resultMsg.duration_ms || durationMs;
        durationApiMs = resultMsg.duration_api_ms || durationApiMs;
        totalCostUsd = resultMsg.total_cost_usd || totalCostUsd;

        // Use final usage from result (more accurate)
        if (resultMsg.usage) {
          usage = {
            inputTokens: resultMsg.usage.input_tokens,
            outputTokens: resultMsg.usage.output_tokens,
            cacheCreationInputTokens: resultMsg.usage.cache_creation_input_tokens,
            cacheReadInputTokens: resultMsg.usage.cache_read_input_tokens,
          };
        }
      }

    }

    // Calculate duration from timestamps if not set
    if (!durationMs && firstTimestamp && lastTimestamp) {
      durationMs = lastTimestamp.getTime() - firstTimestamp.getTime();
    }

    // Calculate cost if not set (model-specific rates)
    // See: https://platform.claude.com/docs/en/about-claude/pricing
    if (!totalCostUsd && usage.inputTokens > 0) {
      // Per-million token rates by model (USD)
      // Default: Sonnet 4/4.5 rates
      let inputRate = 3;
      let outputRate = 15;
      let cacheReadRate = 0.3;    // 10% of input
      let cacheCreateRate = 3.75; // 125% of input

      const modelLower = model.toLowerCase();

      if (modelLower.includes('opus-4-6') || modelLower.includes('opus-4.6') || modelLower.includes('opus-4-5') || modelLower.includes('opus-4.5')) {
        // Opus 4.5/4.6: $5 input, $25 output
        inputRate = 5;
        outputRate = 25;
        cacheReadRate = 0.5;
        cacheCreateRate = 6.25;
      } else if (modelLower.includes('opus')) {
        // Opus 4, 4.1, 3: $15 input, $75 output
        inputRate = 15;
        outputRate = 75;
        cacheReadRate = 1.5;
        cacheCreateRate = 18.75;
      } else if (modelLower.includes('haiku-4-5') || modelLower.includes('haiku-4.5')) {
        // Haiku 4.5: $1 input, $5 output
        inputRate = 1;
        outputRate = 5;
        cacheReadRate = 0.1;
        cacheCreateRate = 1.25;
      } else if (modelLower.includes('haiku-3-5') || modelLower.includes('haiku-3.5')) {
        // Haiku 3.5: $0.80 input, $4 output
        inputRate = 0.8;
        outputRate = 4;
        cacheReadRate = 0.08;
        cacheCreateRate = 1.0;
      } else if (modelLower.includes('haiku')) {
        // Haiku 3: $0.25 input, $1.25 output
        inputRate = 0.25;
        outputRate = 1.25;
        cacheReadRate = 0.03;
        cacheCreateRate = 0.30;
      }
      // Sonnet (default): $3 input, $15 output

      totalCostUsd = (usage.inputTokens / 1_000_000) * inputRate +
                     (usage.outputTokens / 1_000_000) * outputRate +
                     (usage.cacheReadInputTokens / 1_000_000) * cacheReadRate +
                     (usage.cacheCreationInputTokens / 1_000_000) * cacheCreateRate;
    }

    // Determine success if we have responses
    if (!success && responses.length > 0) {
      success = true;
    }

    // Use numTurns from user messages if not set
    if (!numTurns) {
      numTurns = turnIndex;
    }

    // Extract file changes, DB operations, and Git operations from tool uses
    const fileChanges = extractFileChangesFromToolUses(toolUses);
    const dbOperations = extractDbOperationsFromToolUses(toolUses);
    const gitOperations = extractGitOperationsFromToolUses(toolUses);

    // Determine session status with improved heuristics
    const now = Date.now();
    const msSinceModified = fileMtime ? now - fileMtime.getTime() : Infinity;
    const msSinceLastActivity = lastTimestamp ? now - lastTimestamp.getTime() : Infinity;

    // Use the more recent of file mtime or last message timestamp
    const msSinceActivity = Math.min(msSinceModified, msSinceLastActivity);

    // Time thresholds
    const RUNNING_THRESHOLD = 60_000;      // 1 minute
    const IDLE_THRESHOLD = 10 * 60_000;    // 10 minutes

    // Check last message characteristics
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastMessageIsUser = lastMessage?.type === 'user';

    // Check if there's at least one assistant response
    const hasAssistantResponse = responses.length > 0;

    // Check if the session ended properly (last message is a system message indicating turn end)
    // This includes stop_hook_summary, turn_duration which appear at the end of completed turns
    const lastMessageIndicatesCompletion = lastMessage?.type === 'system' &&
      (lastMessage.subtype === 'stop_hook_summary' || lastMessage.subtype === 'turn_duration');

    // Check if last few messages indicate proper completion (assistant response followed by system messages)
    const recentMessages = messages.slice(-5);
    const hasRecentAssistantThenSystem = recentMessages.some((m, i) =>
      m.type === 'assistant' && recentMessages.slice(i + 1).every(next =>
        next.type === 'system' || next.type === 'progress'
      )
    );

    let status: ClaudeSessionData['status'];
    let isActive: boolean;

    if (hasResultMessage) {
      // Has SDK result message - session is complete
      status = errors && errors.length > 0 ? 'error' : 'completed';
      isActive = false;
    } else if (msSinceActivity < RUNNING_THRESHOLD) {
      // Recently active - likely still running
      status = 'running';
      isActive = true;
    } else if (lastMessageIndicatesCompletion && hasAssistantResponse && !lastMessageIsUser) {
      // CLI session: Last message indicates turn completed, has assistant responses, not waiting for user
      // AND not recently modified = properly completed
      status = 'completed';
      isActive = false;
    } else if (lastMessageIsUser && hasAssistantResponse) {
      // Last message was from user but there was a previous assistant response
      // This could be the user typing a new message, or the session was interrupted
      if (msSinceActivity < IDLE_THRESHOLD) {
        status = 'idle';
        isActive = false;
      } else {
        // User sent a message but never got a response - interrupted
        status = 'interrupted';
        isActive = false;
      }
    } else if (lastMessageIsUser && !hasAssistantResponse) {
      // User sent first message but session ended before any response
      status = 'interrupted';
      isActive = false;
    } else if (hasRecentAssistantThenSystem && msSinceActivity >= IDLE_THRESHOLD) {
      // Assistant responded and session ended with system messages (not waiting for user)
      status = 'completed';
      isActive = false;
    } else if (msSinceActivity < IDLE_THRESHOLD) {
      // Recently active but paused
      status = 'idle';
      isActive = false;
    } else {
      // No result, not recent activity - stale session
      status = 'stale';
      isActive = false;
    }

    const data: ClaudeSessionData = {
      sessionId,
      cwd,
      model,
      claudeCodeVersion,
      permissionMode,
      tools,
      mcpServers,
      numTurns,
      durationMs,
      durationApiMs,
      totalCostUsd,
      usage,
      result,
      errors,
      success,
      isActive,
      status,
      lastActivityAt: lastTimestamp || undefined,
      userPrompts,
      toolUses,
      responses,
      systemPrompt,
      fileChanges,
      dbOperations,
      gitOperations,
      todos: Array.from(allTodosMap.values()),
      tasks: Array.from(allTasksMap.values()),
      thinkingBlocks,
      subagents: Array.from(subagentsMap.values()),
      subagentProgress: subagentProgressList.length > 0 ? subagentProgressList : undefined,
      teamName,
      allTeams: allTeams.length > 0 ? allTeams : undefined,
      teamOperations: teamOperations.length > 0 ? teamOperations : undefined,
      teamMessages: teamMessages.length > 0 ? teamMessages : undefined,
      // Task ID -> subject map for resolving TaskUpdate references in Team tab
      taskSubjects: allTasksMap.size > 0
        ? Object.fromEntries(Array.from(allTasksMap.values()).filter(t => t.subject).map(t => [t.id, t.subject]))
        : undefined,
    };

    if (includeRawMessages) {
      data.rawMessages = messages;
    }

    return data;
  }

  /**
   * List all Claude Code sessions for the project
   */
  listSessions(cwd?: string): string[] {
    const projectCwd = cwd || this.config.projectPath;
    // Claude Code uses format: -home-ubuntu-project (leading dash, all slashes become dashes)
    const projectPathKey = legacyEncodeProjectPath(projectCwd);
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);

    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    return fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''));
  }

  /**
   * List all Claude Code sessions with detailed metadata
   * Uses session cache for fast access to session data
   */
  listSessionsWithDetails(cwd?: string): Array<{
    sessionId: string;
    projectPath: string;
    filePath: string;
    size: number;
    createdAt: string;
    lastModified: string;
    lastUserMessage?: string;
    agentCount?: number;
    userPromptCount?: number;
    taskCount?: number;
    planCount?: number;
  }> {
    const projectCwd = cwd || this.config.projectPath;
    const sessionCache = getSessionCache();

    // Helper to count actual agent files on disk
    const countAgentFiles = (sessionId: string): number => {
      const projectPathKey = legacyEncodeProjectPath(projectCwd);
      const subagentsDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey, sessionId, 'subagents');
      if (!fs.existsSync(subagentsDir)) return 0;
      try {
        return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl')).length;
      } catch {
        return 0;
      }
    };

    // Fast path: if project is fully cached, use memory cache directly
    if (sessionCache.isProjectCached(projectCwd)) {
      const cachedSessions = sessionCache.getProjectSessionsFromCache(projectCwd);

      const sessions = cachedSessions
        .filter(s => s.cacheData.userPrompts.some(isRealUserPrompt)) // Has real conversation
        .map(s => {
          const realPrompts = s.cacheData.userPrompts.filter(isRealUserPrompt);
          const lastPrompt = realPrompts[realPrompts.length - 1];
          // Count actual agent files on disk (more accurate than parsing Task tool calls)
          const agentCount = countAgentFiles(s.sessionId);

          return {
            sessionId: s.sessionId,
            projectPath: projectCwd,
            filePath: s.filePath,
            size: s.cacheData.fileSize,
            createdAt: new Date(s.cacheData.createdAt).toISOString(),
            lastModified: new Date(s.cacheData.fileMtime).toISOString(),
            lastUserMessage: lastPrompt?.text?.slice(0, 200),
            agentCount: agentCount > 0 ? agentCount : undefined,
            userPromptCount: realPrompts.length,
            taskCount: s.cacheData.tasks.length,
            planCount: s.cacheData.plans.length > 0 ? s.cacheData.plans.length : undefined,
            teamName: s.cacheData.teamName,
            allTeams: s.cacheData.allTeams && s.cacheData.allTeams.length > 0 ? s.cacheData.allTeams : undefined,
            forkedFromSessionId: s.cacheData.forkedFromSessionId,
          };
        });

      // Sort by lastModified descending (newest first)
      sessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      return sessions;
    }

    // Slow path: read from disk (fallback for uncached projects)
    const projectPathKey = legacyEncodeProjectPath(projectCwd);
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);

    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const sessions: Array<{
      sessionId: string;
      projectPath: string;
      filePath: string;
      size: number;
      createdAt: string;
      lastModified: string;
      lastUserMessage?: string;
      agentCount?: number;
      userPromptCount?: number;
      taskCount?: number;
      planCount?: number;
      teamName?: string;
      allTeams?: string[];
    }> = [];

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

    for (const file of files) {
      const filePath = path.join(sessionsDir, file);
      try {
        const stats = fs.statSync(filePath);
        const sessionId = file.replace('.jsonl', '');

        // Use cache to get session data (fast, sync)
        const cacheData = sessionCache.getSessionDataSync(filePath);

        // Skip sessions with no real conversation messages
        const realPrompts = cacheData ? cacheData.userPrompts.filter(isRealUserPrompt) : [];
        if (!cacheData || realPrompts.length === 0) {
          continue;
        }

        // Get last real user message from cache
        const lastPrompt = realPrompts[realPrompts.length - 1];
        const lastUserMessage = lastPrompt?.text?.slice(0, 200); // Truncate to 200 chars

        // Count actual agent files on disk (more accurate than parsing Task tool calls)
        const agentCount = countAgentFiles(sessionId);

        sessions.push({
          sessionId,
          projectPath: projectCwd,
          filePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          lastModified: stats.mtime.toISOString(),
          lastUserMessage,
          agentCount: agentCount > 0 ? agentCount : undefined,
          userPromptCount: realPrompts.length,
          taskCount: cacheData.tasks.length,
          planCount: cacheData.plans.length > 0 ? cacheData.plans.length : undefined,
          teamName: cacheData.teamName,
          allTeams: cacheData.allTeams && cacheData.allTeams.length > 0 ? cacheData.allTeams : undefined,
        });
      } catch {
        // Skip files we can't stat
      }
    }

    // Sort by lastModified descending (newest first)
    sessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return sessions;
  }

  /**
   * Check if a session file has actual conversation messages (not just file-history-snapshot)
   * Returns true if session has resumable conversation content
   */
  private hasConversationMessages(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      // Read first 50KB to check for conversation messages
      const readSize = Math.min(stats.size, 50 * 1024);

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, 0);
      fs.closeSync(fd);

      const fileContent = buffer.toString('utf8');
      const lines = fileContent.split('\n').filter(l => l.trim());

      // Check each line for conversation-related types
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const type = parsed.type;
          // These types indicate actual conversation content
          if (type === 'user' || type === 'human' || type === 'assistant' ||
              type === 'summary' || type === 'result') {
            return true;
          }
        } catch {
          // Skip unparseable lines
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get the last user message from a session file (reads last ~2MB for large sessions)
   */
  private getLastUserMessageFromFile(filePath: string): string | undefined {
    try {
      const stats = fs.statSync(filePath);
      const readSize = Math.min(stats.size, 2 * 1024 * 1024); // Read last 2MB for very large sessions
      const startPos = Math.max(0, stats.size - readSize);

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, startPos);
      fs.closeSync(fd);

      const fileContent = buffer.toString('utf8');
      const lines = fileContent.split('\n').filter(l => l.trim());

      // Parse lines from end to find last user message (actual prompt, not tool result)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const line = lines[i];
          // Handle partial line at start if we didn't read from beginning
          if (i === 0 && startPos > 0 && !line.startsWith('{')) continue;

          const parsed = JSON.parse(line);
          if (parsed.type === 'user' || parsed.type === 'human') {
            // Check for actual user prompt (string content, not tool result array)
            const msgContent = parsed.message?.content;

            // Skip if content is an array (tool results)
            if (Array.isArray(msgContent)) continue;

            // Get string content from various possible locations
            const textContent = typeof msgContent === 'string'
              ? msgContent
              : (typeof parsed.content === 'string' ? parsed.content : null);

            if (textContent && textContent.trim()) {
              // Truncate to ~100 words
              const words = textContent.split(/\s+/);
              if (words.length > 100) {
                return words.slice(0, 100).join(' ') + '...';
              }
              return textContent;
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * List all Claude Code projects (directories in ~/.claude/projects/)
   */
  listProjects(): Array<{
    projectKey: string;
    projectPath: string;
    sessionCount: number;
    totalSize: number;
    lastModified: string;
  }> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const projects: Array<{
      projectKey: string;
      projectPath: string;
      sessionCount: number;
      totalSize: number;
      lastModified: string;
    }> = [];

    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const dirPath = path.join(projectsDir, dir.name);
      try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        let totalSize = 0;
        let latestMtime = new Date(0);

        for (const file of files) {
          const filePath = path.join(dirPath, file);
          try {
            const stats = fs.statSync(filePath);
            totalSize += stats.size;
            if (stats.mtime > latestMtime) {
              latestMtime = stats.mtime;
            }
          } catch {
            // Skip files we can't stat
          }
        }

        // Extract real project path from a session file's cwd field
        // This is more reliable than trying to decode the directory name
        // since paths with dashes (like "tier-agent") cannot be distinguished
        // from directory separators in the encoded name
        let projectPath = dir.name.replace(/^-/, '/').replace(/-/g, '/'); // fallback

        if (files.length > 0) {
          const firstFile = path.join(dirPath, files[0]);
          try {
            // Read more of the file to find a cwd field (not always in first line)
            const fd = fs.openSync(firstFile, 'r');
            const buffer = Buffer.alloc(16384); // Read up to 16KB
            const bytesRead = fs.readSync(fd, buffer, 0, 16384, 0);
            fs.closeSync(fd);

            const content = buffer.slice(0, bytesRead).toString('utf8');
            const lines = content.split('\n').slice(0, 20); // Check first 20 lines

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.cwd) {
                  projectPath = msg.cwd;
                  break;
                }
              } catch {
                // Skip malformed lines
              }
            }
          } catch {
            // Keep the fallback decoded path if we can't read the file
          }
        }

        projects.push({
          projectKey: dir.name,
          projectPath,
          sessionCount: files.length,
          totalSize,
          lastModified: latestMtime.toISOString(),
        });
      } catch {
        // Skip directories we can't read
      }
    }

    // Sort by lastModified descending (most recently active first)
    projects.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return projects;
  }

  /**
   * Delete a Claude Code session file
   * @deprecated DISABLED - This operation is dangerous and has been disabled.
   * Claude Code session files should be managed by Claude Code itself.
   */
  deleteClaudeSession(_sessionId: string, _cwd?: string): boolean {
    // DISABLED: Deleting Claude Code session files is dangerous
    // These files are managed by Claude Code and should not be deleted externally.
    // If you need to delete session files, do so manually or through Claude Code.
    console.warn('deleteClaudeSession is disabled - Claude Code session files should not be deleted externally');
    return false;
  }

  /**
   * Cleanup old Claude Code sessions (and optionally session store entries)
   * @deprecated DISABLED - This operation is dangerous and has been disabled.
   * Claude Code session files should be managed by Claude Code itself.
   */
  cleanupClaudeSessions(_options?: {
    cwd?: string;
    maxAgeMs?: number;
    alsoCleanStore?: boolean;
  }): { deletedFiles: number; deletedStoreEntries: number } {
    // DISABLED: Cleaning up Claude Code session files is dangerous
    // These files are managed by Claude Code and should not be deleted externally.
    // If you need to cleanup session files, do so manually or through Claude Code.
    console.warn('cleanupClaudeSessions is disabled - Claude Code session files should not be deleted externally');
    return { deletedFiles: 0, deletedStoreEntries: 0 };
  }

  // ============================================================================
  // Subagent Methods
  // ============================================================================

  /**
   * List all subagent files for a session.
   * Subagent files are stored in two locations:
   * 1. Direct: ~/.claude/projects/{project}/agent-{id}.jsonl
   * 2. Nested: ~/.claude/projects/{project}/{session-id}/subagents/agent-{id}.jsonl
   */
  listSubagentFiles(sessionId: string, cwd?: string): Array<{
    agentId: string;
    filePath: string;
    size: number;
    lastModified: Date;
  }> {
    const projectCwd = cwd || this.config.projectPath;
    const projectPathKey = legacyEncodeProjectPath(projectCwd);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);

    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const subagents: Array<{
      agentId: string;
      filePath: string;
      size: number;
      lastModified: Date;
    }> = [];

    // Pattern 1: Direct agent files in project directory
    const directFiles = fs.readdirSync(projectDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

    for (const file of directFiles) {
      const filePath = path.join(projectDir, file);
      try {
        const stats = fs.statSync(filePath);
        const agentId = file.replace('agent-', '').replace('.jsonl', '');
        subagents.push({
          agentId,
          filePath,
          size: stats.size,
          lastModified: stats.mtime,
        });
      } catch {
        // Skip files we can't stat
      }
    }

    // Pattern 2: Nested subagents directory for the specific session
    const sessionSubagentsDir = path.join(projectDir, sessionId, 'subagents');
    if (fs.existsSync(sessionSubagentsDir)) {
      const nestedFiles = fs.readdirSync(sessionSubagentsDir)
        .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

      for (const file of nestedFiles) {
        const filePath = path.join(sessionSubagentsDir, file);
        try {
          const stats = fs.statSync(filePath);
          const agentId = file.replace('agent-', '').replace('.jsonl', '');
          subagents.push({
            agentId,
            filePath,
            size: stats.size,
            lastModified: stats.mtime,
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }

    // Sort by lastModified descending (most recent first)
    subagents.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return subagents;
  }

  /**
   * Read and parse a subagent session file using SessionCache for efficiency
   */
  async readSubagentSession(agentId: string, cwd?: string): Promise<SubagentSessionData | null> {
    const projectCwd = cwd || this.config.projectPath;
    const projectPathKey = legacyEncodeProjectPath(projectCwd);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);

    // Try to find the agent file in known locations
    let filePath: string | null = null;

    // Pattern 1: Direct in project directory
    const directPath = path.join(projectDir, `agent-${agentId}.jsonl`);
    if (fs.existsSync(directPath)) {
      filePath = directPath;
    }

    // Pattern 2: Search in session subdirectories
    if (!filePath) {
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nestedPath = path.join(projectDir, entry.name, 'subagents', `agent-${agentId}.jsonl`);
          if (fs.existsSync(nestedPath)) {
            filePath = nestedPath;
            break;
          }
        }
      }
    }

    if (!filePath) {
      return null;
    }

    // Read first line to get agent-specific metadata (fast, just 2KB read)
    const firstLineData = this.getAgentFirstLineData(filePath);
    if (!firstLineData) {
      return null;
    }

    const { parentSessionId, parentUuid, agentCwd, claudeCodeVersion: firstLineVersion } = firstLineData;

    // Use SessionCache for efficient parsing of the rest
    const sessionCache = getSessionCache();
    const cacheData = await sessionCache.getSessionData(filePath);

    if (!cacheData) {
      return null;
    }

    // Get file stats for lastActivityAt and status
    const stats = fs.statSync(filePath);
    const msSinceModified = Date.now() - stats.mtime.getTime();

    // Determine status based on file modification time and result
    let status: SubagentStatus = 'unknown';
    if (msSinceModified < 60000) {
      status = 'running';
    } else if (cacheData.result !== undefined) {
      status = cacheData.success ? 'completed' : 'error';
    } else if (cacheData.numTurns > 0) {
      status = 'completed';
    }

    // Extract prompt from first real user prompt
    const firstRealPrompt = cacheData.userPrompts.find(isRealUserPrompt);
    const prompt = firstRealPrompt ? firstRealPrompt.text : '';

    // Convert cached tool uses to ClaudeToolUse format
    const toolUses: ClaudeToolUse[] = cacheData.toolUses.map(t => ({
      id: t.id,
      name: t.name,
      input: t.input,
      turnIndex: t.turnIndex,
      lineIndex: t.lineIndex,
    }));

    // Build conversation from cached data
    // We need rawMessages to build full conversation with contentBlocks
    const rawMessages = await sessionCache.getRawMessages(filePath);
    const conversation: Array<{
      type: 'user' | 'assistant';
      turnIndex: number;
      lineIndex: number;
      content: string;
      contentBlocks?: any[];
    }> = [];

    if (rawMessages) {
      let turnIndex = 0;
      for (const msg of rawMessages) {
        if (msg.type === 'user') {
          turnIndex++;
          const msgContent = msg.message?.content;
          let userText = '';
          if (typeof msgContent === 'string') {
            userText = msgContent;
          } else if (Array.isArray(msgContent)) {
            userText = msgContent
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n');
          }
          conversation.push({
            type: 'user',
            turnIndex,
            lineIndex: msg.lineIndex,
            content: userText,
            contentBlocks: Array.isArray(msgContent) ? msgContent : undefined,
          });
        } else if (msg.type === 'assistant') {
          turnIndex++;
          const content = msg.message?.content;
          let textParts: string[] = [];
          if (Array.isArray(content)) {
            textParts = content
              .filter((c: any) => c.type === 'text' && c.text)
              .map((c: any) => c.text);
          }
          conversation.push({
            type: 'assistant',
            turnIndex,
            lineIndex: msg.lineIndex,
            content: textParts.join('\n'),
            contentBlocks: content,
          });
        }
      }
    }

    return {
      agentId,
      parentSessionId,
      parentUuid: parentUuid || undefined,
      cwd: agentCwd || cacheData.cwd,
      type: 'general-purpose' as SubagentType,  // Default, could be extracted from parent session
      prompt,
      status,
      numTurns: cacheData.numTurns,
      model: cacheData.model,
      claudeCodeVersion: cacheData.claudeCodeVersion || firstLineVersion,
      filePath,
      fileSize: stats.size,
      lastActivityAt: stats.mtime,
      toolUses,
      responses: cacheData.responses,
      usage: cacheData.usage.inputTokens > 0 ? {
        inputTokens: cacheData.usage.inputTokens,
        outputTokens: cacheData.usage.outputTokens,
        cacheCreationInputTokens: cacheData.usage.cacheCreationInputTokens,
        cacheReadInputTokens: cacheData.usage.cacheReadInputTokens,
      } : undefined,
      conversation,
    };
  }

  /**
   * Read first line of agent file to extract agent-specific metadata.
   * This is fast (reads only ~2KB) and gives us parentSessionId, parentUuid, etc.
   */
  private getAgentFirstLineData(filePath: string): {
    parentSessionId: string;
    parentUuid: string;
    agentCwd: string;
    claudeCodeVersion: string;
  } | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(4096);  // Read up to 4KB for first line
      const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
      fs.closeSync(fd);

      if (bytesRead === 0) return null;

      const content = buffer.toString('utf8', 0, bytesRead);
      const firstLine = content.split('\n')[0];
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine);
      return {
        parentSessionId: parsed.sessionId || '',
        parentUuid: parsed.parentUuid || '',
        agentCwd: parsed.cwd || '',
        claudeCodeVersion: parsed.version || '',
      };
    } catch {
      return null;
    }
  }

  /**
   * Get subagents for a session with their current status.
   * Combines subagent invocations from session data with actual subagent file data.
   */
  /**
   * Quickly read the first line of an agent file to get its parentSessionId.
   * This is much faster than parsing the whole file.
   */
  private getAgentParentSessionId(filePath: string): string | null {
    try {
      // Read just enough bytes to get the first line (usually < 1KB)
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buffer, 0, 2048, 0);
      fs.closeSync(fd);

      if (bytesRead === 0) return null;

      const content = buffer.toString('utf8', 0, bytesRead);
      const firstLine = content.split('\n')[0];
      if (!firstLine) return null;

      const parsed = JSON.parse(firstLine);
      return parsed.sessionId || null;
    } catch {
      return null;
    }
  }

  async getSessionSubagents(sessionId: string, cwd?: string): Promise<{
    invocations: SubagentInvocation[];
    sessions: SubagentSessionData[];
  }> {
    // Resolve the actual project path — when no cwd is given, find it from
    // the session file location (same fallback logic as getSessionPath)
    let resolvedCwd = cwd;
    if (!resolvedCwd) {
      const sessionMeta = this.getSessionPathWithMeta(sessionId, cwd);
      if (sessionMeta.path) {
        // Extract project path from the session file path:
        // ~/.claude/projects/{projectKey}/{sessionId}.jsonl → projectKey
        const projectsBase = path.join(os.homedir(), '.claude', 'projects');
        const rel = path.relative(projectsBase, sessionMeta.path);
        const projectKey = rel.split(path.sep)[0]; // e.g. "-home-ubuntu-tier-agent"
        if (projectKey) {
          // Convert key back to path: "-home-ubuntu-tier-agent" → "/home/ubuntu/tier-agent"
          resolvedCwd = projectKey.replace(/^-/, '/').replace(/-/g, '/');
        }
      }
    }

    // Get session data to find subagent invocations
    const sessionData = await this.readSession(sessionId, { cwd: resolvedCwd });

    const invocations = sessionData?.subagents || [];

    // Collect all agent IDs to load
    const agentIdsToLoad = new Set<string>();

    // Add agent IDs from invocations
    for (const invocation of invocations) {
      if (invocation.agentId) {
        agentIdsToLoad.add(invocation.agentId);
      }
    }

    const projectCwd = resolvedCwd || this.config.projectPath;
    const projectPathKey = legacyEncodeProjectPath(projectCwd);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);

    // Check agent files directly in project directory (Pattern 1)
    // Use quick first-line check to filter by parentSessionId
    if (fs.existsSync(projectDir)) {
      const directFiles = fs.readdirSync(projectDir)
        .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

      for (const file of directFiles) {
        const agentId = file.replace('agent-', '').replace('.jsonl', '');
        if (!agentIdsToLoad.has(agentId)) {
          const filePath = path.join(projectDir, file);
          const parentId = this.getAgentParentSessionId(filePath);
          if (parentId === sessionId) {
            agentIdsToLoad.add(agentId);
          }
        }
      }
    }

    // Also check session-specific subagent directory (Pattern 2)
    const sessionSubagentsDir = path.join(projectDir, sessionId, 'subagents');
    if (fs.existsSync(sessionSubagentsDir)) {
      const nestedFiles = fs.readdirSync(sessionSubagentsDir)
        .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

      for (const file of nestedFiles) {
        const agentId = file.replace('agent-', '').replace('.jsonl', '');
        agentIdsToLoad.add(agentId);  // Will be filtered by parentSessionId after loading
      }
    }

    // Load all agent sessions in parallel
    const agentIdArray = Array.from(agentIdsToLoad);
    const loadResults = await Promise.all(
      agentIdArray.map(agentId => this.readSubagentSession(agentId, resolvedCwd))
    );

    // Filter and collect valid sessions
    const sessions: SubagentSessionData[] = [];
    for (const result of loadResults) {
      if (result && result.parentSessionId === sessionId) {
        sessions.push(result);
      }
    }

    // Update invocation status from session data (since Task tool results aren't
    // stored as regular tool_result messages in the parent session)
    // Also copy parentUuid from invocations to sessions (agent files have null parentUuid,
    // but we extracted it from agent_progress messages in the parent session)
    for (const invocation of invocations) {
      if (invocation.agentId) {
        const session = sessions.find(s => s.agentId === invocation.agentId);
        if (session) {
          invocation.status = session.status;
          if (session.status === 'completed' && session.lastActivityAt) {
            invocation.completedAt = session.lastActivityAt.toISOString();
          }
          // Copy parentUuid from invocation to session (for chat timeline positioning)
          if (invocation.parentUuid && !session.parentUuid) {
            session.parentUuid = invocation.parentUuid;
          }
        }
      }
    }

    return { invocations, sessions };
  }

  /**
   * Check if a session has updates since last check.
   * Used for efficient polling - returns current line count and agent IDs.
   * Client compares with its cached values to detect changes.
   *
   * @param sessionId - The session ID to check
   * @param options.cwd - Optional project path
   * @returns Current state or null if session doesn't exist
   */
  checkSessionUpdate(sessionId: string, options?: { cwd?: string }): {
    exists: boolean;
    lineCount: number;
    agentIds: string[];
    lastModified: string;
    fileSize: number;
  } | null {
    const sessionPath = this.getSessionPath(sessionId, options?.cwd);

    try {
      // Single stat call — fast, no file read needed
      const stats = fs.statSync(sessionPath);
      const lastModified = stats.mtime.toISOString();
      const fileSize = stats.size;

      // Use file size as the change indicator (monotonically increasing for JSONL).
      // Avoids reading the entire file just to count lines — critical for large
      // sessions (23MB+ files were taking 300-600ms per read).
      // lineCount is kept for API compatibility but set to fileSize so callers
      // that compare lineCount for changes still work correctly.
      const lineCount = fileSize;

      // Derive project dir from the resolved session path
      // sessionPath is like: ~/.claude/projects/{projectKey}/{sessionId}.jsonl
      const sessionDir = path.dirname(sessionPath);
      const sessionSubagentsDir = path.join(sessionDir, sessionId, 'subagents');

      const agentIds: string[] = [];
      try {
        const files = fs.readdirSync(sessionSubagentsDir)
          .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
        for (const file of files) {
          const agentId = file.replace('agent-', '').replace('.jsonl', '');
          agentIds.push(agentId);
        }
      } catch {
        // Subagents dir doesn't exist — no agents
      }

      return {
        exists: true,
        lineCount,
        agentIds: agentIds.sort(),
        lastModified,
        fileSize,
      };
    } catch {
      return null;
    }
  }

  /**
   * Batch check multiple sessions for updates in a single call.
   * Also supports checking if the session list has changed.
   *
   * For each session: calls checkSessionUpdate and computes changed/agentsChanged
   * based on client-provided known values.
   *
   * For listCheck: uses listSessionsWithDetails with change detection.
   */
  batchCheckSessionUpdate(
    sessions: Array<{ sessionId: string; knownFileSize?: number; knownAgentCount?: number }>,
    listCheck?: { projectPath?: string; knownSessionCount?: number; knownLatestModified?: string },
    options?: { cwd?: string },
  ): {
    sessions: Record<string, {
      exists: boolean;
      lineCount: number;
      fileSize: number;
      agentIds: string[];
      lastModified: string;
      changed: boolean;
      agentsChanged: boolean;
    }>;
    listStatus?: {
      totalSessions: number;
      latestModified: string;
      changed: boolean;
      sessions?: Array<{
        sessionId: string;
        lastModified: string;
        fileSize: number;
        isRunning: boolean;
        numTurns?: number;
        totalCostUsd?: number;
        model?: string;
        lastUserMessage?: string;
        agentCount?: number;
        userPromptCount?: number;
        taskCount?: number;
      }>;
    };
  } {
    const result: Record<string, {
      exists: boolean;
      lineCount: number;
      fileSize: number;
      agentIds: string[];
      lastModified: string;
      changed: boolean;
      agentsChanged: boolean;
    }> = {};

    // Check each session
    for (const req of sessions) {
      const check = this.checkSessionUpdate(req.sessionId, options);
      if (check) {
        const agentCount = check.agentIds.length;
        const changed = req.knownFileSize !== undefined
          ? check.fileSize !== req.knownFileSize
          : true; // No known value = always report as changed
        const agentsChanged = req.knownAgentCount !== undefined
          ? agentCount !== req.knownAgentCount
          : false;

        result[req.sessionId] = {
          exists: check.exists,
          lineCount: check.lineCount,
          fileSize: check.fileSize,
          agentIds: check.agentIds,
          lastModified: check.lastModified,
          changed,
          agentsChanged,
        };
      } else {
        result[req.sessionId] = {
          exists: false,
          lineCount: 0,
          fileSize: 0,
          agentIds: [],
          lastModified: '',
          changed: false,
          agentsChanged: false,
        };
      }
    }

    // Check list status
    let listStatus: {
      totalSessions: number;
      latestModified: string;
      changed: boolean;
      sessions?: Array<{
        sessionId: string;
        lastModified: string;
        fileSize: number;
        isRunning: boolean;
        numTurns?: number;
        totalCostUsd?: number;
        model?: string;
        lastUserMessage?: string;
        agentCount?: number;
        userPromptCount?: number;
        taskCount?: number;
      }>;
    } | undefined;

    if (listCheck) {
      const allSessions = this.listSessionsWithDetails(listCheck.projectPath || options?.cwd);
      const totalSessions = allSessions.length;
      const latestModified = allSessions.length > 0 ? allSessions[0].lastModified : '';

      const countChanged = listCheck.knownSessionCount !== undefined
        ? totalSessions !== listCheck.knownSessionCount
        : true;
      const modifiedChanged = listCheck.knownLatestModified !== undefined
        ? latestModified !== listCheck.knownLatestModified
        : true;
      const changed = countChanged || modifiedChanged;

      listStatus = {
        totalSessions,
        latestModified,
        changed,
      };

      // Only include full session list when changed
      if (changed) {
        const sessionCache = getSessionCache();
        listStatus.sessions = allSessions.map(s => {
          // Check if session is running based on file modification time
          const msSinceModified = Date.now() - new Date(s.lastModified).getTime();
          const isRunning = msSinceModified < 60000;

          // Get cached data for additional fields
          const cacheData = sessionCache.getSessionDataSync(s.filePath);

          return {
            sessionId: s.sessionId,
            lastModified: s.lastModified,
            fileSize: s.size,
            isRunning,
            numTurns: cacheData?.numTurns,
            totalCostUsd: cacheData?.totalCostUsd,
            model: cacheData?.model,
            lastUserMessage: s.lastUserMessage,
            agentCount: s.agentCount,
            userPromptCount: s.userPromptCount,
            taskCount: s.taskCount,
            teamName: cacheData?.teamName,
            allTeams: cacheData?.allTeams && cacheData.allTeams.length > 0 ? cacheData.allTeams : undefined,
          };
        });
      }
    }

    return { sessions: result, listStatus };
  }
}

// ============================================================================
// Conversation Types (for API)
// ============================================================================

/**
 * Level of detail for tool information in conversation
 */
export type ToolDetailLevel = 'none' | 'summary' | 'full';

/**
 * Tool call information with varying detail levels
 */
export interface ConversationToolCall {
  id: string;
  name: string;
  input?: unknown;
  resultSummary?: string;
  result?: string;
  isError?: boolean;
}

/**
 * A message in the conversation
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  turnIndex: number;
  /** Line index in JSONL file (0-based) */
  lineIndex: number;
  content: string;
  timestamp?: string;
  /** Message UUID for linking subagent parentUuid */
  uuid?: string;
  toolCalls?: ConversationToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Options for getting conversation
 */
export interface GetConversationOptions {
  sessionId: string;
  cwd?: string;
  toolDetail?: ToolDetailLevel;
  lastN?: number;
  /** Get messages BEFORE this line index (for "load older" pagination) */
  beforeLine?: number;
  includeSystemPrompt?: boolean;
  /** Filter to include only messages from this turn index onwards */
  fromTurnIndex?: number;
  /** Filter to include only messages up to this turn index */
  toTurnIndex?: number;
}

/**
 * Result of getting conversation
 */
export interface ConversationResult {
  sessionId: string;
  totalMessages: number;
  returnedMessages: number;
  lastLineIndex: number;
  numTurns: number;
  messages: ConversationMessage[];
  systemPrompt?: string;
  model?: string;
  totalCostUsd: number;
  /** Todos from TodoWrite tool */
  todos?: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
    lineIndex: number;
  }>;
  /** Tasks from TaskCreate/TaskUpdate tools */
  tasks?: Array<{
    id: string;
    subject: string;
    description?: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'deleted';
    blocks?: string[];
    blockedBy?: string[];
    owner?: string;
    metadata?: Record<string, unknown>;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Thinking blocks from extended thinking */
  thinkingBlocks?: Array<{
    turnIndex: number;
    lineIndex: number;
    thinking: string;
  }>;
  /** Team name if session is part of a team (first team for backward compat) */
  teamName?: string;
  /** All distinct team names in order of appearance */
  allTeams?: string[];
  /** Team operations from Teammate tool (spawnTeam, cleanup) */
  teamOperations?: Array<{
    operation: 'spawnTeam' | 'cleanup';
    teamName?: string;
    description?: string;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Team messages from SendMessage tool */
  teamMessages?: Array<{
    messageType: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response';
    recipient?: string;
    content?: string;
    summary?: string;
    requestId?: string;
    approve?: boolean;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Task ID -> subject mapping for resolving TaskUpdate references */
  taskSubjects?: Record<string, string>;
}

// ============================================================================
// Conversation Methods Extension
// ============================================================================

/**
 * Extension to AgentSessionStore for conversation retrieval
 */
declare module './agent-session-store' {
  interface AgentSessionStore {
    /**
     * Get conversation from a Claude Code session
     */
    getConversation(options: GetConversationOptions): Promise<ConversationResult | null>;

    /**
     * Get last N messages from a Claude Code session
     */
    getLastMessages(sessionId: string, count: number, options?: {
      cwd?: string;
      toolDetail?: ToolDetailLevel;
    }): Promise<ConversationResult | null>;
  }
}

/**
 * Get conversation from a Claude Code session
 * Uses session cache for efficient incremental reads
 */
AgentSessionStore.prototype.getConversation = async function(
  this: AgentSessionStore,
  options: GetConversationOptions
): Promise<ConversationResult | null> {
  const sessionPath = this.getSessionPath(options.sessionId, options.cwd);

  if (!fs.existsSync(sessionPath)) {
    return null;
  }

  // Use session cache for efficient incremental reads
  const sessionCache = getSessionCache();
  const messages = await sessionCache.getRawMessages(sessionPath);

  if (!messages) {
    return null;
  }

  return parseConversation(messages as Array<ClaudeSessionMessage & { lineIndex: number }>, options);
};

/**
 * Get last N messages from a Claude Code session
 */
AgentSessionStore.prototype.getLastMessages = async function(
  this: AgentSessionStore,
  sessionId: string,
  count: number,
  options?: { cwd?: string; toolDetail?: ToolDetailLevel }
): Promise<ConversationResult | null> {
  return this.getConversation({
    sessionId,
    cwd: options?.cwd,
    toolDetail: options?.toolDetail || 'summary',
    lastN: count,
    includeSystemPrompt: false,
  });
};

/**
 * Parse JSONL messages into conversation format
 */
function parseConversation(
  rawMessages: Array<ClaudeSessionMessage & { lineIndex: number }>,
  options: GetConversationOptions
): ConversationResult {
  const toolDetail = options.toolDetail || 'summary';
  const conversation: ConversationMessage[] = [];

  // Map to track tool results by tool_use_id
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  // Map to track TaskCreate tool_use_id to assigned task ID (from tool_result)
  const taskCreateIdMap = new Map<string, string>();

  // First pass: collect all tool results and extract TaskCreate assigned IDs
  for (const msg of rawMessages) {
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            toolResults.set(block.tool_use_id, {
              content: resultContent,
              isError: block.is_error || false,
            });

            // Extract TaskCreate assigned ID from tool_result
            const taskCreateMatch = resultContent.match(/Task #(\d+) created successfully/);
            if (taskCreateMatch) {
              taskCreateIdMap.set(block.tool_use_id, taskCreateMatch[1]);
            }
          }
        }
      }
    }
  }

  let model: string | undefined;
  let totalCostUsd = 0;
  let systemPrompt: string | undefined;
  // Use a single unified turnIndex counter for proper ordering
  let turnIndex = 0;

  // Storage for todos, tasks, and thinking blocks
  const allTodosMap = new Map<string, { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string; lineIndex: number }>();
  const allTasksMap = new Map<string, {
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
  }>();
  const thinkingBlocks: Array<{ turnIndex: number; lineIndex: number; thinking: string }> = [];
  let teamName: string | undefined;
  const allTeams: string[] = [];
  const teamOperations: Array<{ operation: 'spawnTeam' | 'cleanup'; teamName?: string; description?: string; turnIndex: number; lineIndex: number }> = [];
  const teamMessages: Array<{ messageType: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'; recipient?: string; content?: string; summary?: string; requestId?: string; approve?: boolean; turnIndex: number; lineIndex: number }> = [];

  // Second pass: build conversation
  for (const msg of rawMessages) {
    // Extract system prompt if available
    if (msg.type === 'system' && msg.subtype === 'init') {
      const init = msg as any;
      model = init.model;
    }

    // Extract teamName from root-level field
    if (!teamName && (msg as any).teamName) {
      teamName = (msg as any).teamName;
    }

    // Extract system prompt from system content
    if (msg.type === 'system' && (msg as any).content && !systemPrompt) {
      const content = (msg as any).content;
      if (typeof content === 'string' && content.length > 0 && content.length < 10000) {
        if (!content.includes('<command-name>') && !content.includes('<local-command')) {
          systemPrompt = content;
        }
      }
    }

    // User message (only text prompts, not tool results)
    if (msg.type === 'user') {
      turnIndex++;
      const userMsg = msg as any;
      const content = userMsg.message?.content;
      let textContent = '';

      if (typeof content === 'string') {
        textContent = content;
      } else if (Array.isArray(content)) {
        // Extract only text blocks, skip tool_result blocks
        const textParts = content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text);
        textContent = textParts.join('\n');
      }

      if (textContent.trim()) {
        conversation.push({
          role: 'user',
          turnIndex,
          lineIndex: msg.lineIndex,
          content: textContent,
          timestamp: userMsg.timestamp,
          uuid: userMsg.uuid,
        });
      }
    }

    // Assistant message
    if (msg.type === 'assistant') {
      turnIndex++;
      const assistantMsg = msg as any;
      const content = assistantMsg.message?.content;

      if (assistantMsg.message?.model) {
        model = assistantMsg.message.model;
      }

      let textContent = '';
      const toolCalls: ConversationToolCall[] = [];

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textContent += (textContent ? '\n' : '') + block.text;
          }

          if (block.type === 'tool_use' && toolDetail !== 'none') {
            const toolCall: ConversationToolCall = {
              id: block.id,
              name: block.name,
            };

            // Add input for full detail
            if (toolDetail === 'full' && block.input) {
              toolCall.input = block.input;
            }

            // Add result info if available
            const result = toolResults.get(block.id);
            if (result) {
              toolCall.isError = result.isError;

              if (toolDetail === 'summary') {
                // Create a short summary of the result
                toolCall.resultSummary = summarizeToolResult(result.content, block.name);
              } else if (toolDetail === 'full') {
                toolCall.result = result.content;
                toolCall.resultSummary = summarizeToolResult(result.content, block.name);
              }
            }

            toolCalls.push(toolCall);
          }

          // Extract TodoWrite tool calls
          if (block.type === 'tool_use' && block.name === 'TodoWrite' && block.input) {
            const input = block.input as { todos?: Array<{ content: string; status: string; activeForm: string }> };
            if (input.todos && Array.isArray(input.todos)) {
              for (const todo of input.todos) {
                const key = todo.content;
                allTodosMap.set(key, {
                  content: todo.content,
                  status: (todo.status as 'pending' | 'in_progress' | 'completed') || 'pending',
                  activeForm: todo.activeForm || '',
                  lineIndex: msg.lineIndex,
                });
              }
            }
          }

          // Extract TaskCreate tool calls
          if (block.type === 'tool_use' && block.name === 'TaskCreate' && block.input) {
            const input = block.input as any;
            // Use real ID from tool_result if available, otherwise use temp ID
            const realId = taskCreateIdMap.get(block.id);
            const taskId = realId || `temp-${block.id}`;
            allTasksMap.set(taskId, {
              id: taskId,
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

          // Extract TaskUpdate tool calls
          if (block.type === 'tool_use' && block.name === 'TaskUpdate' && block.input) {
            const input = block.input as any;
            const taskId = input.taskId;
            if (taskId) {
              const existing = allTasksMap.get(taskId);
              if (existing) {
                if (input.status) existing.status = input.status;
                if (input.subject) existing.subject = input.subject;
                if (input.description) existing.description = input.description;
                if (input.activeForm) existing.activeForm = input.activeForm;
                if (input.owner) existing.owner = input.owner;
                if (input.addBlocks) existing.blocks.push(...input.addBlocks);
                if (input.addBlockedBy) existing.blockedBy.push(...input.addBlockedBy);
                if (input.metadata) {
                  existing.metadata = existing.metadata || {};
                  for (const [k, v] of Object.entries(input.metadata)) {
                    if (v === null) {
                      delete existing.metadata[k];
                    } else {
                      (existing.metadata as Record<string, unknown>)[k] = v;
                    }
                  }
                }
                existing.turnIndex = turnIndex;
                existing.lineIndex = msg.lineIndex;
              } else {
                // Create placeholder for task not created in this session
                allTasksMap.set(taskId, {
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

          // Extract Teammate tool calls (team operations)
          if (block.type === 'tool_use' && block.name === 'Teammate' && block.input) {
            const input = block.input as any;
            const op = input.operation || 'spawnTeam';
            teamOperations.push({
              operation: op,
              teamName: input.team_name,
              description: input.description,
              turnIndex,
              lineIndex: msg.lineIndex,
            });
            // Populate allTeams from spawnTeam operations
            if (op === 'spawnTeam' && input.team_name && !allTeams.includes(input.team_name)) {
              allTeams.push(input.team_name);
            }
          }

          // Extract SendMessage tool calls (team messages)
          if (block.type === 'tool_use' && block.name === 'SendMessage' && block.input) {
            const input = block.input as any;
            teamMessages.push({
              messageType: input.type || 'message',
              recipient: input.recipient,
              content: input.content,
              summary: input.summary,
              requestId: input.request_id,
              approve: input.approve,
              turnIndex,
              lineIndex: msg.lineIndex,
            });
          }

          // Extract thinking blocks
          if (block.type === 'thinking' && block.thinking) {
            thinkingBlocks.push({
              turnIndex,
              lineIndex: msg.lineIndex,
              thinking: block.thinking,
            });
          }
        }
      }

      // Extract usage
      let usage: ConversationMessage['usage'] | undefined;
      const msgUsage = assistantMsg.message?.usage;
      if (msgUsage) {
        usage = {
          inputTokens: msgUsage.input_tokens || 0,
          outputTokens: msgUsage.output_tokens || 0,
        };
      }

      if (textContent.trim() || toolCalls.length > 0) {
        const convMsg: ConversationMessage = {
          role: 'assistant',
          turnIndex,
          lineIndex: msg.lineIndex,
          content: textContent || (toolCalls.length > 0 ? `[${toolCalls.length} tool call(s)]` : ''),
          timestamp: assistantMsg.timestamp,
          uuid: assistantMsg.uuid,
        };

        if (toolCalls.length > 0 && toolDetail !== 'none') {
          convMsg.toolCalls = toolCalls;
        }

        if (usage) {
          convMsg.usage = usage;
        }

        conversation.push(convMsg);
      }
    }

    // Result message for cost
    if (msg.type === 'result') {
      const resultMsg = msg as any;
      totalCostUsd = resultMsg.total_cost_usd || totalCostUsd;
    }
  }

  // Sort messages by turnIndex for proper conversation order
  conversation.sort((a, b) => a.turnIndex - b.turnIndex);

  // Turn range filtering (for milestone-based conversation retrieval)
  let turnFiltered = conversation;
  if (options.fromTurnIndex !== undefined || options.toTurnIndex !== undefined) {
    turnFiltered = conversation.filter(m => {
      if (options.fromTurnIndex !== undefined && m.turnIndex < options.fromTurnIndex) return false;
      if (options.toTurnIndex !== undefined && m.turnIndex > options.toTurnIndex) return false;
      return true;
    });
  }

  // Apply beforeLine filter (for "load older" pagination)
  let filteredMessages = turnFiltered;
  if (options.beforeLine !== undefined && options.beforeLine > 0) {
    filteredMessages = conversation.filter(m => (m.lineIndex ?? Infinity) < options.beforeLine!);
  }

  // Apply lastN filter (take last N from filtered messages)
  let resultMessages = filteredMessages;
  const totalMessages = conversation.length;

  if (options.lastN && options.lastN > 0 && options.lastN < filteredMessages.length) {
    resultMessages = filteredMessages.slice(-options.lastN);
  }

  // Track last line index for delta fetching — max lineIndex across ALL messages (not just returned)
  const lastLineIndex = conversation.length > 0
    ? Math.max(...conversation.map(m => m.lineIndex ?? 0))
    : 0;

  // Compute numTurns from max turnIndex across all messages
  const numTurns = conversation.length > 0
    ? Math.max(...conversation.map(m => m.turnIndex ?? 0))
    : 0;

  return {
    sessionId: options.sessionId,
    totalMessages,
    returnedMessages: resultMessages.length,
    lastLineIndex,
    numTurns,
    messages: resultMessages,
    systemPrompt: options.includeSystemPrompt ? systemPrompt : undefined,
    model,
    totalCostUsd,
    todos: Array.from(allTodosMap.values()),
    tasks: Array.from(allTasksMap.values()),
    thinkingBlocks,
    teamName,
    allTeams: allTeams.length > 0 ? allTeams : undefined,
    teamOperations: teamOperations.length > 0 ? teamOperations : undefined,
    teamMessages: teamMessages.length > 0 ? teamMessages : undefined,
    taskSubjects: allTasksMap.size > 0
      ? Object.fromEntries(Array.from(allTasksMap.values()).filter(t => t.subject).map(t => [t.id, t.subject]))
      : undefined,
  };
}

/**
 * Create a short summary of a tool result
 */
function summarizeToolResult(content: string, toolName: string): string {
  if (!content) return 'No result';

  // Handle common tool types
  const lowerName = toolName.toLowerCase();

  // File read tool - show line count
  if (lowerName.includes('read') || lowerName === 'cat') {
    const lines = content.split('\n').length;
    return `Read ${lines} lines`;
  }

  // Write/Edit tool
  if (lowerName.includes('write') || lowerName.includes('edit')) {
    if (content.includes('success') || content.length < 100) {
      return content.slice(0, 100);
    }
    return 'File modified';
  }

  // Bash tool
  if (lowerName === 'bash' || lowerName.includes('shell') || lowerName.includes('exec')) {
    const lines = content.split('\n');
    if (lines.length <= 3) {
      return content.slice(0, 200);
    }
    return `${lines.length} lines of output`;
  }

  // Glob/Grep tool
  if (lowerName.includes('glob') || lowerName.includes('grep') || lowerName.includes('search')) {
    const matches = content.split('\n').filter(l => l.trim()).length;
    return `${matches} matches found`;
  }

  // Default: truncate long results
  if (content.length <= 150) {
    return content;
  }

  return content.slice(0, 147) + '...';
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new AgentSessionStore instance.
 * @deprecated Use createEventStore() for execution tracking and
 * createClaudeSessionReader() for reading Claude Code sessions.
 */
export function createAgentSessionStore(config: SessionStoreConfig): AgentSessionStore {
  return new AgentSessionStore(config);
}
