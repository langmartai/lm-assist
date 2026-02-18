/**
 * Claude Agent SDK Runner
 * Executes prompts using the Claude Agent SDK instead of spawning CLI processes
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  ClaudeCliOptions,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
  SystemInitEvent,
  AssistantMessageEvent,
  ResultEvent,
  TokenUsage,
} from './types';

// Import SDK types
import type {
  Options as SDKOptions,
  Query,
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  PermissionMode,
  SettingSource,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';

// Import change tracker
import {
  ChangeTracker,
  SessionChanges,
  extractFilesFromToolInput,
  getToolAction,
} from './utils/change-tracker';

// Import enhanced SDK event types
import type {
  SdkEvent,
  SdkInitEvent,
  SdkAssistantMessageEvent,
  SdkResultEvent,
  SdkHookEvent,
  SdkPreToolUseEvent,
  SdkPostToolUseEvent,
  SdkSessionEndEvent,
  SdkMcpServerInfo,
  SdkAgentInfo,
  SdkContentBlock,
  SdkTokenUsage,
  SdkUserQuestionEvent,
  SdkPermissionRequestEvent,
} from './types/sdk-events';
import { createSdkEventBase } from './types/sdk-events';
import type { TierName } from './types/instruction-protocol';

// Import event handler types
import type {
  SdkEventHandlerConfig,
  PermissionRequest,
  PermissionResponse,
  UserQuestionRequest,
  UserQuestionResponse,
  UserQuestion,
} from './types/sdk-event-handlers';
import {
  createPermissionRequest,
  createUserQuestionRequest,
  createDefaultPermissionResponse,
  createDefaultQuestionResponse,
} from './types/sdk-event-handlers';

/**
 * Default timeout for SDK execution (5 minutes)
 */
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/**
 * SDK Runner options
 */
export interface SdkRunnerOptions {
  /** Default timeout for execution */
  defaultTimeout?: number;
  /** Load CLAUDE.md from project */
  loadClaudeMd?: boolean;
  /** Permission mode */
  permissionMode?: PermissionMode;
  /** Enable enhanced SDK events (default: true) */
  emitSdkEvents?: boolean;
  /** Default tier for event context */
  tier?: TierName;
  /** Event handler configuration for blocking events */
  eventHandlers?: SdkEventHandlerConfig;
  /** Enable file change tracking (default: true) */
  trackChanges?: boolean;
  /**
   * Append to system prompt (added after preset)
   * Use for tier-specific runtime instructions
   */
  systemPromptAppend?: string;
}

/**
 * System prompt configuration
 */
export type SystemPromptConfig =
  | { type: 'preset'; preset: 'claude_code'; append?: string }
  | { type: 'custom'; content: string }
  | string;

/**
 * Effort level controlling how eagerly Claude spends tokens.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Output configuration (effort and format).
 */
export interface OutputConfig {
  effort?: EffortLevel;
  format?: 'json' | { type: 'json_schema'; schema: Record<string, unknown> };
}

/**
 * Data residency controls for inference.
 */
export type InferenceGeo = 'global' | 'us';

/**
 * Extended thinking configuration for SDK execution
 */
export interface ExtendedThinkingConfig {
  /** Enable extended thinking mode */
  enabled: boolean;
  /** Budget for thinking tokens (minimum 1024). Required for type 'enabled'. */
  budgetTokens?: number;
  /** Thinking type: 'enabled' (legacy) or 'adaptive' (Opus 4.6+) */
  type?: 'enabled' | 'adaptive';
}

/**
 * Extended execute options with tier context and full SDK options
 */
export interface SdkExecuteOptions extends ClaudeCliOptions {
  /** Tier context for events */
  tier?: TierName;
  /** Execution ID for grouping events */
  executionId?: string;
  /** Override event handlers for this execution */
  eventHandlers?: SdkEventHandlerConfig;
  /** Enable file change tracking for this execution */
  trackChanges?: boolean;
  /**
   * Append to system prompt for this execution
   * Overrides the runner-level systemPromptAppend
   * @deprecated Use systemPromptConfig instead
   */
  systemPromptAppend?: string;
  /**
   * Full system prompt configuration
   * Takes precedence over systemPromptAppend
   */
  systemPromptConfig?: SystemPromptConfig;
  /** Setting sources for loading CLAUDE.md and user settings */
  settingSources?: SettingSource[];
  /** Permission mode override */
  permissionMode?: PermissionMode;
  /** Maximum number of turns before stopping */
  maxTurns?: number;
  /** Maximum budget in USD before stopping */
  maxBudgetUsd?: number;
  /** Allowed tools (whitelist) */
  allowedTools?: string[];
  /** Disallowed tools (blacklist) */
  disallowedTools?: string[];
  /** MCP servers to load for this execution */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Extended thinking configuration
   * Enables Claude's reasoning mode with thinking blocks
   */
  extendedThinking?: ExtendedThinkingConfig;
  /**
   * Output configuration (effort level and format)
   */
  outputConfig?: OutputConfig;
  /**
   * Data residency controls for inference
   */
  inferenceGeo?: InferenceGeo;
}

/**
 * Extended result with session changes
 */
export interface SdkExecuteResult extends ClaudeCliResult {
  /** Session changes (files created/modified/deleted) */
  sessionChanges?: SessionChanges;
}

/**
 * Handle for tracking async execution
 */
export interface SdkExecutionHandle {
  /** Execution ID for tracking */
  executionId: string;
  /** Session ID (available after init) */
  sessionId: string;
  /** Promise that resolves when session ID is available */
  sessionReady: Promise<string>;
  /** Promise that resolves with final result */
  result: Promise<SdkExecuteResult>;
  /** Abort the execution */
  abort: () => void;
  /** Check if still running */
  isRunning: () => boolean;
}

/**
 * Claude SDK Runner class
 * Provides the same interface as ClaudeCliRunner but uses the Agent SDK
 */
export class ClaudeSdkRunner extends EventEmitter {
  private defaultTimeout: number;
  private loadClaudeMd: boolean;
  private permissionMode: PermissionMode;
  private emitSdkEvents: boolean;
  private defaultTier?: TierName;
  private defaultEventHandlers?: SdkEventHandlerConfig;
  private trackChanges: boolean;
  private systemPromptAppend?: string;
  private runningQueries: Map<string, { query: Query; abortController: AbortController; changeTracker?: ChangeTracker }> = new Map();
  private pendingBlockingEvents: Map<string, { resolve: (response: unknown) => void; reject: (error: Error) => void }> = new Map();
  private turnIndex: number = 0;

  constructor(options?: SdkRunnerOptions) {
    super();
    this.defaultTimeout = options?.defaultTimeout || DEFAULT_TIMEOUT;
    this.loadClaudeMd = options?.loadClaudeMd ?? true;
    this.permissionMode = options?.permissionMode || 'default';
    this.emitSdkEvents = options?.emitSdkEvents ?? true;
    this.defaultTier = options?.tier;
    this.defaultEventHandlers = options?.eventHandlers;
    this.trackChanges = options?.trackChanges ?? true;
    this.systemPromptAppend = options?.systemPromptAppend;
  }

  /**
   * Execute a prompt using Claude Agent SDK
   */
  async execute(prompt: string, options: SdkExecuteOptions): Promise<SdkExecuteResult> {
    // Dynamic import for ESM module
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const startTime = Date.now();
    const timeout = options.timeout || this.defaultTimeout;
    const sessionId = options.sessionId || `sdk-${Date.now()}`;
    const tier = options.tier || this.defaultTier;
    const executionId = options.executionId || `exec-${Date.now()}`;
    this.turnIndex = 0;

    // Initialize change tracker if enabled
    const shouldTrackChanges = options.trackChanges ?? this.trackChanges;
    let changeTracker: ChangeTracker | undefined;
    if (shouldTrackChanges && options.cwd) {
      changeTracker = new ChangeTracker({
        workingDirectory: options.cwd,
        useGit: true,
        computeHashes: true,
        captureDiffs: true,
      });
      changeTracker.startTracking(executionId);
    }

    // Build SDK options
    const sdkOptions: SDKOptions = {
      cwd: options.cwd,
      permissionMode: options.permissionMode || this.permissionMode,
    };

    // Handle model selection
    if (options.model) {
      sdkOptions.model = options.model;
    }

    // Handle max turns
    if (options.maxTurns !== undefined) {
      sdkOptions.maxTurns = options.maxTurns;
    }

    // Handle max budget
    if (options.maxBudgetUsd !== undefined) {
      // SDK uses max_budget_usd (snake_case in options)
      (sdkOptions as Record<string, unknown>).max_budget_usd = options.maxBudgetUsd;
    }

    // Handle system prompt configuration
    if (options.systemPromptConfig) {
      const config = options.systemPromptConfig;
      if (typeof config === 'string') {
        // Simple string = custom prompt
        sdkOptions.systemPrompt = config;
      } else if (config.type === 'preset') {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: config.preset,
          ...(config.append && { append: config.append }),
        };
      } else if (config.type === 'custom') {
        sdkOptions.systemPrompt = config.content;
      }
      // Use explicit setting sources if provided, otherwise use project
      sdkOptions.settingSources = options.settingSources || ['project'] as SettingSource[];
    } else if (this.loadClaudeMd) {
      // Fallback to legacy behavior
      sdkOptions.settingSources = options.settingSources || ['project'] as SettingSource[];
      // Use append if provided (execution-level overrides runner-level)
      const appendText = options.systemPromptAppend || this.systemPromptAppend;
      if (appendText) {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: appendText,
        };
      } else {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
        };
      }
    } else if (options.settingSources) {
      // Just use explicit setting sources without system prompt
      sdkOptions.settingSources = options.settingSources;
    }

    // Handle session resume - only if session file exists
    if (options.resume && options.sessionId) {
      const sessionExists = this.checkSessionExists(options.cwd || process.cwd(), options.sessionId);
      if (sessionExists) {
        sdkOptions.resume = options.sessionId;
      }
      // If session doesn't exist, we just start a fresh session
    }

    // Handle allowed tools
    if (options.allowedTools && options.allowedTools.length > 0) {
      sdkOptions.allowedTools = options.allowedTools;
    }

    // Handle disallowed tools
    if (options.disallowedTools && options.disallowedTools.length > 0) {
      sdkOptions.disallowedTools = options.disallowedTools;
    }

    // Handle MCP servers
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      sdkOptions.mcpServers = options.mcpServers;
    }

    // Handle extended thinking
    if (options.extendedThinking?.enabled) {
      if (options.extendedThinking.type === 'adaptive') {
        // Opus 4.6+: adaptive thinking (Claude decides when/how much to think)
        (sdkOptions as Record<string, unknown>).thinking = {
          type: 'adaptive',
        };
      } else {
        // Legacy: fixed budget thinking
        (sdkOptions as Record<string, unknown>).thinking = {
          type: 'enabled',
          budget_tokens: Math.max(1024, options.extendedThinking.budgetTokens || 10000),
        };
      }
    }

    // Handle output config (effort and format)
    if (options.outputConfig) {
      const outputConfig: Record<string, unknown> = {};
      if (options.outputConfig.effort) {
        outputConfig.effort = options.outputConfig.effort;
      }
      if (options.outputConfig.format) {
        outputConfig.format = options.outputConfig.format;
      }
      if (Object.keys(outputConfig).length > 0) {
        (sdkOptions as Record<string, unknown>).output_config = outputConfig;
      }
    }

    // Handle inference geo (data residency)
    if (options.inferenceGeo) {
      (sdkOptions as Record<string, unknown>).inference_geo = options.inferenceGeo;
    }

    // Handle env variables for the CLI subprocess
    if (options.env) {
      (sdkOptions as Record<string, unknown>).env = { ...process.env, ...options.env };
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    sdkOptions.abortController = abortController;

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeout);

    // Get event handlers (execution-level overrides instance-level)
    const eventHandlers = options.eventHandlers || this.defaultEventHandlers;

    // Create canUseTool callback for handling permissions and user questions
    if (eventHandlers) {
      // Use 'as any' to bypass complex SDK discriminated union types
      sdkOptions.canUseTool = this.createCanUseToolCallback(
        eventHandlers,
        sessionId,
        tier,
        executionId
      ) as unknown as SDKOptions['canUseTool'];
    }

    try {
      // Execute query
      const queryInstance = query({ prompt, options: sdkOptions });
      this.runningQueries.set(sessionId, { query: queryInstance, abortController, changeTracker });

      let resultText = '';
      let totalUsage: TokenUsage = this.emptyUsage();
      let totalCostUsd = 0;
      let numTurns = 0;
      let apiDurationMs = 0;
      let actualSessionId = sessionId;
      let success = true;
      let error: string | undefined;

      // Process messages
      for await (const message of queryInstance) {
        this.processMessage(message, options, tier, executionId, changeTracker);

        if (message.type === 'system' && (message as SDKSystemMessage).subtype === 'init') {
          const sysMsg = message as SDKSystemMessage;
          actualSessionId = sysMsg.session_id;
        }

        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
          // Extract text content
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              resultText += block.text;
            }
          }
        }

        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            resultText = resultMsg.result;
            totalCostUsd = resultMsg.total_cost_usd;
            numTurns = resultMsg.num_turns;
            apiDurationMs = resultMsg.duration_api_ms;
            totalUsage = {
              inputTokens: resultMsg.usage.input_tokens,
              outputTokens: resultMsg.usage.output_tokens,
              cacheCreationInputTokens: resultMsg.usage.cache_creation_input_tokens,
              cacheReadInputTokens: resultMsg.usage.cache_read_input_tokens,
            };
          } else {
            success = false;
            // Cast through unknown for type safety with SDK error types
            const errorResult = resultMsg as unknown as { subtype: string; errors?: string[]; total_cost_usd: number; num_turns: number; duration_api_ms: number; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } };
            error = errorResult.errors ? errorResult.errors.join('; ') : `Error: ${errorResult.subtype}`;
            totalCostUsd = errorResult.total_cost_usd;
            numTurns = errorResult.num_turns;
            apiDurationMs = errorResult.duration_api_ms;
            totalUsage = {
              inputTokens: errorResult.usage.input_tokens,
              outputTokens: errorResult.usage.output_tokens,
              cacheCreationInputTokens: errorResult.usage.cache_creation_input_tokens,
              cacheReadInputTokens: errorResult.usage.cache_read_input_tokens,
            };
          }
        }
      }

      clearTimeout(timeoutHandle);

      // Stop change tracking and get results
      let sessionChanges: SessionChanges | undefined;
      if (changeTracker) {
        sessionChanges = changeTracker.stopTracking();
        this.emit('session_changes', sessionChanges);
      }

      this.runningQueries.delete(sessionId);

      return {
        success,
        result: resultText,
        sessionId: actualSessionId,
        durationMs: Date.now() - startTime,
        durationApiMs: apiDurationMs,
        numTurns,
        totalCostUsd,
        usage: totalUsage,
        modelUsage: {},
        error,
        sessionChanges,
      };

    } catch (err) {
      clearTimeout(timeoutHandle);

      // Stop change tracking even on error to capture partial changes
      let sessionChanges: SessionChanges | undefined;
      if (changeTracker) {
        sessionChanges = changeTracker.stopTracking();
        this.emit('session_changes', sessionChanges);
      }

      this.runningQueries.delete(sessionId);

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if it was an abort
      if (errorMessage.includes('abort') || errorMessage.includes('AbortError')) {
        return {
          success: false,
          result: '',
          sessionId,
          durationMs: Date.now() - startTime,
          durationApiMs: 0,
          numTurns: 0,
          totalCostUsd: 0,
          usage: this.emptyUsage(),
          modelUsage: {},
          error: `Execution timed out after ${timeout}ms`,
          sessionChanges,
        };
      }

      return {
        success: false,
        result: '',
        sessionId,
        durationMs: Date.now() - startTime,
        durationApiMs: 0,
        numTurns: 0,
        totalCostUsd: 0,
        usage: this.emptyUsage(),
        modelUsage: {},
        error: errorMessage,
        sessionChanges,
      };
    }
  }

  /**
   * Execute with full verbose output and return structured result
   * (Same interface as ClaudeCliRunner for compatibility)
   */
  async executeVerbose(
    prompt: string,
    options: Omit<ClaudeCliOptions, 'verbose' | 'outputFormat'>
  ): Promise<ClaudeCliResult> {
    return this.execute(prompt, {
      ...options,
      verbose: true,
      outputFormat: 'stream-json',
    });
  }

  /**
   * Execute a prompt asynchronously and return a handle immediately.
   * The handle provides:
   * - sessionReady: Promise that resolves with session ID as soon as init message is received
   * - result: Promise that resolves with final result when execution completes
   * - abort(): Method to cancel the execution
   * - isRunning(): Check if execution is still in progress
   *
   * This is useful for parallel execution where you need to track multiple agents.
   */
  executeAsync(prompt: string, options: SdkExecuteOptions): SdkExecutionHandle {
    const executionId = options.executionId || `exec-${Date.now()}`;
    let sessionId = options.sessionId || `sdk-${Date.now()}`;
    let running = true;
    let abortController: AbortController | null = null;

    // Create promises for session ready and final result
    let resolveSessionReady: (sessionId: string) => void;
    let rejectSessionReady: (error: Error) => void;
    const sessionReady = new Promise<string>((resolve, reject) => {
      resolveSessionReady = resolve;
      rejectSessionReady = reject;
    });

    // Start execution in background
    const resultPromise = this.executeWithSessionCallback(
      prompt,
      options,
      executionId,
      (actualSessionId, controller) => {
        sessionId = actualSessionId;
        abortController = controller;
        resolveSessionReady(actualSessionId);
      }
    ).then(result => {
      running = false;
      return result;
    }).catch(err => {
      running = false;
      rejectSessionReady(err);
      throw err;
    });

    return {
      executionId,
      sessionId,
      sessionReady,
      result: resultPromise,
      abort: () => {
        if (abortController) {
          abortController.abort();
        }
        running = false;
      },
      isRunning: () => running,
    };
  }

  /**
   * Internal method that executes with a callback when session is initialized
   */
  private async executeWithSessionCallback(
    prompt: string,
    options: SdkExecuteOptions,
    executionId: string,
    onSessionInit: (sessionId: string, abortController: AbortController) => void
  ): Promise<SdkExecuteResult> {
    // Dynamic import for ESM module
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const startTime = Date.now();
    const timeout = options.timeout || this.defaultTimeout;
    const initialSessionId = options.sessionId || `sdk-${Date.now()}`;
    const tier = options.tier || this.defaultTier;
    this.turnIndex = 0;

    // Initialize change tracker if enabled
    const shouldTrackChanges = options.trackChanges ?? this.trackChanges;
    let changeTracker: ChangeTracker | undefined;
    if (shouldTrackChanges && options.cwd) {
      changeTracker = new ChangeTracker({
        workingDirectory: options.cwd,
        useGit: true,
        computeHashes: true,
        captureDiffs: true,
      });
      changeTracker.startTracking(executionId);
    }

    // Build SDK options
    const sdkOptions: SDKOptions = {
      cwd: options.cwd,
      permissionMode: options.permissionMode || this.permissionMode,
    };

    // Handle model selection
    if (options.model) {
      sdkOptions.model = options.model;
    }

    // Handle max turns
    if (options.maxTurns !== undefined) {
      sdkOptions.maxTurns = options.maxTurns;
    }

    // Handle max budget
    if (options.maxBudgetUsd !== undefined) {
      (sdkOptions as Record<string, unknown>).max_budget_usd = options.maxBudgetUsd;
    }

    // Handle system prompt configuration
    if (options.systemPromptConfig) {
      const config = options.systemPromptConfig;
      if (typeof config === 'string') {
        sdkOptions.systemPrompt = config;
      } else if (config.type === 'preset') {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: config.preset,
          ...(config.append && { append: config.append }),
        };
      } else if (config.type === 'custom') {
        sdkOptions.systemPrompt = config.content;
      }
      sdkOptions.settingSources = options.settingSources || ['project'] as SettingSource[];
    } else if (this.loadClaudeMd) {
      sdkOptions.settingSources = options.settingSources || ['project'] as SettingSource[];
      const appendText = options.systemPromptAppend || this.systemPromptAppend;
      if (appendText) {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: appendText,
        };
      } else {
        sdkOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
        };
      }
    } else if (options.settingSources) {
      sdkOptions.settingSources = options.settingSources;
    }

    // Handle session resume - only if session file exists
    if (options.resume && options.sessionId) {
      const sessionExists = this.checkSessionExists(options.cwd || process.cwd(), options.sessionId);
      if (sessionExists) {
        sdkOptions.resume = options.sessionId;
      }
    }

    // Handle allowed tools
    if (options.allowedTools && options.allowedTools.length > 0) {
      sdkOptions.allowedTools = options.allowedTools;
    }

    // Handle disallowed tools
    if (options.disallowedTools && options.disallowedTools.length > 0) {
      sdkOptions.disallowedTools = options.disallowedTools;
    }

    // Handle MCP servers
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      sdkOptions.mcpServers = options.mcpServers;
    }

    // Handle extended thinking
    if (options.extendedThinking?.enabled) {
      if (options.extendedThinking.type === 'adaptive') {
        // Opus 4.6+: adaptive thinking (Claude decides when/how much to think)
        (sdkOptions as Record<string, unknown>).thinking = {
          type: 'adaptive',
        };
      } else {
        // Legacy: fixed budget thinking
        (sdkOptions as Record<string, unknown>).thinking = {
          type: 'enabled',
          budget_tokens: Math.max(1024, options.extendedThinking.budgetTokens || 10000),
        };
      }
    }

    // Handle output config (effort and format)
    if (options.outputConfig) {
      const outputConfig: Record<string, unknown> = {};
      if (options.outputConfig.effort) {
        outputConfig.effort = options.outputConfig.effort;
      }
      if (options.outputConfig.format) {
        outputConfig.format = options.outputConfig.format;
      }
      if (Object.keys(outputConfig).length > 0) {
        (sdkOptions as Record<string, unknown>).output_config = outputConfig;
      }
    }

    // Handle inference geo (data residency)
    if (options.inferenceGeo) {
      (sdkOptions as Record<string, unknown>).inference_geo = options.inferenceGeo;
    }

    // Handle env variables for the CLI subprocess
    if (options.env) {
      (sdkOptions as Record<string, unknown>).env = { ...process.env, ...options.env };
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    sdkOptions.abortController = abortController;

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeout);

    // Get event handlers
    const eventHandlers = options.eventHandlers || this.defaultEventHandlers;

    if (eventHandlers) {
      sdkOptions.canUseTool = this.createCanUseToolCallback(
        eventHandlers,
        initialSessionId,
        tier,
        executionId
      ) as unknown as SDKOptions['canUseTool'];
    }

    try {
      const queryInstance = query({ prompt, options: sdkOptions });
      this.runningQueries.set(initialSessionId, { query: queryInstance, abortController, changeTracker });

      let resultText = '';
      let totalUsage: TokenUsage = this.emptyUsage();
      let totalCostUsd = 0;
      let numTurns = 0;
      let apiDurationMs = 0;
      let actualSessionId = initialSessionId;
      let success = true;
      let error: string | undefined;
      let sessionCallbackCalled = false;

      for await (const message of queryInstance) {
        this.processMessage(message, options, tier, executionId, changeTracker);

        // Capture session ID from init message and call callback
        if (message.type === 'system' && (message as SDKSystemMessage).subtype === 'init') {
          const sysMsg = message as SDKSystemMessage;
          actualSessionId = sysMsg.session_id;

          // Call session init callback immediately
          if (!sessionCallbackCalled) {
            sessionCallbackCalled = true;
            onSessionInit(actualSessionId, abortController);
          }
        }

        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text') {
              resultText += block.text;
            }
          }
        }

        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            resultText = resultMsg.result;
            totalCostUsd = resultMsg.total_cost_usd;
            numTurns = resultMsg.num_turns;
            apiDurationMs = resultMsg.duration_api_ms;
            totalUsage = {
              inputTokens: resultMsg.usage.input_tokens,
              outputTokens: resultMsg.usage.output_tokens,
              cacheCreationInputTokens: resultMsg.usage.cache_creation_input_tokens,
              cacheReadInputTokens: resultMsg.usage.cache_read_input_tokens,
            };
          } else {
            success = false;
            const errorResult = resultMsg as unknown as { subtype: string; errors?: string[]; total_cost_usd: number; num_turns: number; duration_api_ms: number; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } };
            error = errorResult.errors ? errorResult.errors.join('; ') : `Error: ${errorResult.subtype}`;
            totalCostUsd = errorResult.total_cost_usd;
            numTurns = errorResult.num_turns;
            apiDurationMs = errorResult.duration_api_ms;
            totalUsage = {
              inputTokens: errorResult.usage.input_tokens,
              outputTokens: errorResult.usage.output_tokens,
              cacheCreationInputTokens: errorResult.usage.cache_creation_input_tokens,
              cacheReadInputTokens: errorResult.usage.cache_read_input_tokens,
            };
          }
        }
      }

      clearTimeout(timeoutHandle);

      let sessionChanges: SessionChanges | undefined;
      if (changeTracker) {
        sessionChanges = changeTracker.stopTracking();
        this.emit('session_changes', sessionChanges);
      }

      this.runningQueries.delete(initialSessionId);

      return {
        success,
        result: resultText,
        sessionId: actualSessionId,
        durationMs: Date.now() - startTime,
        durationApiMs: apiDurationMs,
        numTurns,
        totalCostUsd,
        usage: totalUsage,
        modelUsage: {},
        error,
        sessionChanges,
      };

    } catch (err) {
      clearTimeout(timeoutHandle);

      let sessionChanges: SessionChanges | undefined;
      if (changeTracker) {
        sessionChanges = changeTracker.stopTracking();
        this.emit('session_changes', sessionChanges);
      }

      this.runningQueries.delete(initialSessionId);

      const errorMessage = err instanceof Error ? err.message : String(err);

      if (errorMessage.includes('abort') || errorMessage.includes('AbortError')) {
        return {
          success: false,
          result: '',
          sessionId: initialSessionId,
          durationMs: Date.now() - startTime,
          durationApiMs: 0,
          numTurns: 0,
          totalCostUsd: 0,
          usage: this.emptyUsage(),
          modelUsage: {},
          error: `Execution timed out after ${timeout}ms`,
          sessionChanges,
        };
      }

      return {
        success: false,
        result: '',
        sessionId: initialSessionId,
        durationMs: Date.now() - startTime,
        durationApiMs: 0,
        numTurns: 0,
        totalCostUsd: 0,
        usage: this.emptyUsage(),
        modelUsage: {},
        error: errorMessage,
        sessionChanges,
      };
    }
  }

  /**
   * Process SDK message and emit events
   */
  private processMessage(
    message: SDKMessage,
    options: SdkExecuteOptions,
    tier?: TierName,
    executionId?: string,
    changeTracker?: ChangeTracker
  ): void {
    const sessionId = options.sessionId || 'unknown';

    if (message.type === 'system' && (message as SDKSystemMessage).subtype === 'init') {
      const sysMsg = message as SDKSystemMessage;

      // Legacy event format
      const event: SystemInitEvent = {
        cwd: sysMsg.cwd,
        sessionId: sysMsg.session_id,
        tools: sysMsg.tools,
        mcpServers: sysMsg.mcp_servers.map(s => s.name),
        model: sysMsg.model,
        permissionMode: sysMsg.permissionMode,
        slashCommands: sysMsg.slash_commands,
        claudeCodeVersion: sysMsg.claude_code_version,
        outputStyle: sysMsg.output_style,
        agents: sysMsg.agents || [],
        plugins: sysMsg.plugins || [],
      };
      this.emit('system', event);
      this.emit('stream', { type: 'system', subtype: 'init', data: event } as ClaudeCliStreamEvent);

      // Enhanced SDK event
      if (this.emitSdkEvents) {
        // Extract MCP server info safely (SDK returns { name: string, status: string })
        const mcpServers: SdkMcpServerInfo[] = sysMsg.mcp_servers.map((s: { name: string; status: string }) => ({
          name: s.name,
          status: s.status === 'connected' ? 'connected' : 'disconnected',
        }));

        // Extract agent info safely (SDK may return strings or objects)
        const agents: SdkAgentInfo[] = (sysMsg.agents || []).map((a: string | { name?: string; description?: string; tools?: string[]; model?: string }) => {
          if (typeof a === 'string') {
            return { name: a, description: '' };
          }
          return {
            name: a.name || '',
            description: a.description || '',
            tools: a.tools,
            model: a.model,
          };
        });

        // Extract plugin info safely (SDK may return { name, path } objects)
        const plugins: string[] = (sysMsg.plugins || []).map((p: string | { name: string; path?: string }) => {
          if (typeof p === 'string') return p;
          return p.name;
        });

        const sdkEvent: SdkInitEvent = {
          ...createSdkEventBase(sysMsg.session_id, tier, executionId),
          type: 'sdk_init',
          data: {
            cwd: sysMsg.cwd,
            model: sysMsg.model,
            permissionMode: sysMsg.permissionMode,
            tools: sysMsg.tools,
            mcpServers,
            agents,
            slashCommands: sysMsg.slash_commands,
            claudeCodeVersion: sysMsg.claude_code_version,
            outputStyle: sysMsg.output_style,
            plugins,
          },
        };
        this.emit('sdk_event', sdkEvent);
      }
    }

    if (message.type === 'assistant') {
      const assistantMsg = message as SDKAssistantMessage;
      this.turnIndex++;

      // Track file changes from tool_use blocks
      if (changeTracker) {
        for (const block of assistantMsg.message.content) {
          if (block.type === 'tool_use' && block.name && block.input) {
            const toolInput = block.input as Record<string, unknown>;
            const files = extractFilesFromToolInput(block.name, toolInput);
            const action = getToolAction(block.name);
            if (files.length > 0 && action) {
              changeTracker.recordToolChange(
                block.name,
                block.id || '',
                files,
                action
              );
            }
          }
        }
      }

      // Legacy event format
      const event: AssistantMessageEvent = {
        model: assistantMsg.message.model,
        id: assistantMsg.message.id,
        content: assistantMsg.message.content.map((block: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }) => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text || '' };
          }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: block.id || '',
              name: block.name || '',
              input: block.input as Record<string, unknown>,
            };
          }
          if (block.type === 'thinking') {
            return { type: 'thinking' as const, text: block.thinking || '' };
          }
          return { type: block.type as 'text' };
        }),
        usage: {
          inputTokens: assistantMsg.message.usage?.input_tokens || 0,
          outputTokens: assistantMsg.message.usage?.output_tokens || 0,
          cacheCreationInputTokens: assistantMsg.message.usage?.cache_creation_input_tokens || 0,
          cacheReadInputTokens: assistantMsg.message.usage?.cache_read_input_tokens || 0,
        },
      };
      this.emit('assistant', event);
      this.emit('stream', { type: 'assistant', data: event } as ClaudeCliStreamEvent);

      // Enhanced SDK event
      if (this.emitSdkEvents) {
        const usage: SdkTokenUsage = {
          inputTokens: assistantMsg.message.usage?.input_tokens || 0,
          outputTokens: assistantMsg.message.usage?.output_tokens || 0,
          cacheCreationInputTokens: assistantMsg.message.usage?.cache_creation_input_tokens || 0,
          cacheReadInputTokens: assistantMsg.message.usage?.cache_read_input_tokens || 0,
          totalTokens:
            (assistantMsg.message.usage?.input_tokens || 0) +
            (assistantMsg.message.usage?.output_tokens || 0),
        };

        const content: SdkContentBlock[] = assistantMsg.message.content.map((block: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }) => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text || '' };
          }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: block.id || '',
              name: block.name || '',
              input: (block.input as Record<string, unknown>) || {},
            };
          }
          if (block.type === 'thinking') {
            return { type: 'thinking' as const, thinking: block.thinking || '' };
          }
          return { type: 'text' as const, text: '' };
        });

        const sdkEvent: SdkAssistantMessageEvent = {
          ...createSdkEventBase(sessionId, tier, executionId),
          type: 'sdk_assistant',
          data: {
            messageId: assistantMsg.message.id,
            model: assistantMsg.message.model,
            content,
            usage,
            stopReason: assistantMsg.message.stop_reason as 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | undefined,
            turnIndex: this.turnIndex,
          },
        };
        this.emit('sdk_event', sdkEvent);
      }
    }

    if (message.type === 'result') {
      const resultMsg = message as SDKResultMessage;

      // Legacy event format
      const event: ResultEvent = {
        success: resultMsg.subtype === 'success',
        isError: resultMsg.is_error,
        durationMs: resultMsg.duration_ms,
        durationApiMs: resultMsg.duration_api_ms,
        numTurns: resultMsg.num_turns,
        result: resultMsg.subtype === 'success' ? resultMsg.result : '',
        sessionId: resultMsg.session_id,
        totalCostUsd: resultMsg.total_cost_usd,
        usage: {
          inputTokens: resultMsg.usage.input_tokens,
          outputTokens: resultMsg.usage.output_tokens,
          cacheCreationInputTokens: resultMsg.usage.cache_creation_input_tokens,
          cacheReadInputTokens: resultMsg.usage.cache_read_input_tokens,
        },
        modelUsage: {},
      };
      this.emit('result', event);
      this.emit('stream', { type: 'result', data: event } as ClaudeCliStreamEvent);

      // Enhanced SDK event
      if (this.emitSdkEvents) {
        const usage: SdkTokenUsage = {
          inputTokens: resultMsg.usage.input_tokens,
          outputTokens: resultMsg.usage.output_tokens,
          cacheCreationInputTokens: resultMsg.usage.cache_creation_input_tokens,
          cacheReadInputTokens: resultMsg.usage.cache_read_input_tokens,
          totalTokens:
            resultMsg.usage.input_tokens +
            resultMsg.usage.output_tokens,
        };

        const sdkEvent: SdkResultEvent = {
          ...createSdkEventBase(resultMsg.session_id, tier, executionId),
          type: 'sdk_result',
          data: {
            success: resultMsg.subtype === 'success',
            subtype: resultMsg.subtype as 'success' | 'error' | 'cancelled' | 'timeout',
            result: resultMsg.subtype === 'success' ? resultMsg.result : undefined,
            errors: resultMsg.subtype !== 'success' ? (resultMsg as unknown as { errors?: string[] }).errors : undefined,
            numTurns: resultMsg.num_turns,
            durationMs: resultMsg.duration_ms,
            durationApiMs: resultMsg.duration_api_ms,
            totalCostUsd: resultMsg.total_cost_usd,
            usage,
            modelUsage: {},
          },
        };
        this.emit('sdk_event', sdkEvent);
      }
    }
  }

  /**
   * Emit a tool use event (for hook integration)
   */
  emitToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    sessionId: string,
    tier?: TierName,
    executionId?: string,
    decision?: 'allow' | 'block' | 'modify',
    reason?: string
  ): void {
    if (!this.emitSdkEvents) return;

    const event: SdkPreToolUseEvent = {
      ...createSdkEventBase(sessionId, tier, executionId),
      type: 'sdk_hook',
      hookType: 'PreToolUse',
      data: {
        toolName,
        toolInput,
        toolUseId,
        decision,
        reason,
      },
    };
    this.emit('sdk_event', event);
  }

  /**
   * Emit a tool result event (for hook integration)
   */
  emitToolResultEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: unknown,
    toolUseId: string,
    durationMs: number,
    success: boolean,
    sessionId: string,
    tier?: TierName,
    executionId?: string
  ): void {
    if (!this.emitSdkEvents) return;

    const event: SdkPostToolUseEvent = {
      ...createSdkEventBase(sessionId, tier, executionId),
      type: 'sdk_hook',
      hookType: 'PostToolUse',
      data: {
        toolName,
        toolInput,
        toolResponse,
        toolUseId,
        durationMs,
        success,
      },
    };
    this.emit('sdk_event', event);
  }

  /**
   * Emit a session end event
   */
  emitSessionEndEvent(
    sessionId: string,
    reason: 'completed' | 'error' | 'timeout' | 'aborted' | 'user_cancelled',
    totalDurationMs: number,
    numTurns: number,
    totalCostUsd: number,
    tier?: TierName,
    executionId?: string
  ): void {
    if (!this.emitSdkEvents) return;

    const event: SdkSessionEndEvent = {
      ...createSdkEventBase(sessionId, tier, executionId),
      type: 'sdk_hook',
      hookType: 'SessionEnd',
      data: {
        reason,
        totalDurationMs,
        numTurns,
        totalCostUsd,
      },
    };
    this.emit('sdk_event', event);
  }

  /**
   * Check if a session/query is running
   */
  isRunning(sessionId: string): boolean {
    return this.runningQueries.has(sessionId);
  }

  /**
   * Get all running session IDs
   */
  getRunningSessionIds(): string[] {
    return Array.from(this.runningQueries.keys());
  }

  /**
   * Kill a running query
   */
  kill(sessionId: string): boolean {
    const entry = this.runningQueries.get(sessionId);
    if (entry) {
      entry.abortController.abort();
      this.runningQueries.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Kill all running queries
   */
  killAll(): number {
    let killed = 0;
    for (const [sessionId, entry] of this.runningQueries) {
      entry.abortController.abort();
      this.runningQueries.delete(sessionId);
      killed++;
    }
    return killed;
  }

  /**
   * Create canUseTool callback for handling permissions and user questions
   * The SDK canUseTool callback has this signature:
   * (toolName: string, toolInput: Record<string, unknown>, options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string })
   *   => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; message?: string; interrupt?: boolean }>
   */
  private createCanUseToolCallback(
    handlers: SdkEventHandlerConfig,
    sessionId: string,
    tier?: TierName,
    executionId?: string
  ) {
    // Using 'any' for SDK types since they're complex and we handle them internally
    return async (toolName: string, toolInput: Record<string, unknown>, context: { toolUseID: string; suggestions?: unknown[]; signal: AbortSignal }): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; message?: string; interrupt?: boolean }> => {
      const { toolUseID, suggestions } = context;
      // Convert SDK suggestions to string array for internal use
      const suggestionStrings = suggestions ? suggestions.map(s => typeof s === 'string' ? s : JSON.stringify(s)) : undefined;

      // Handle AskUserQuestion tool specially
      if (toolName === 'AskUserQuestion') {
        return this.handleUserQuestionTool(
          toolInput,
          toolUseID,
          handlers,
          sessionId,
          tier,
          executionId
        );
      }

      // Check auto-approved tools
      if (handlers.autoApprovedTools?.includes(toolName)) {
        this.emitToolUseEvent(toolName, toolInput, toolUseID, sessionId, tier, executionId, 'allow', 'auto-approved');
        return { behavior: 'allow', updatedInput: toolInput };
      }

      // Check denied tools
      if (handlers.deniedTools?.includes(toolName)) {
        this.emitToolUseEvent(toolName, toolInput, toolUseID, sessionId, tier, executionId, 'block', 'denied-by-policy');
        return { behavior: 'deny', message: `Tool ${toolName} is not allowed by policy` };
      }

      // If custom handler provided, use it
      if (handlers.onPermissionRequest) {
        const request = createPermissionRequest(
          toolName,
          toolInput,
          toolUseID,
          sessionId,
          tier,
          executionId,
          suggestionStrings
        );

        // Emit permission request event
        this.emitPermissionRequestEvent(request);

        try {
          // Call the handler with timeout
          const handlerTimeout = handlers.handlerTimeout || 60000;
          let timeoutHandle: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<PermissionResponse>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Permission handler timeout')), handlerTimeout);
          });
          const response = await Promise.race([
            handlers.onPermissionRequest(request),
            timeoutPromise,
          ]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          });

          // Emit permission response event
          this.emitPermissionResponseEvent(request, response);

          return {
            behavior: response.behavior === 'allow_with_update' ? 'allow' : response.behavior,
            updatedInput: response.updatedInput || toolInput,
            updatedPermissions: response.updatedPermissions,
            message: response.message,
            interrupt: response.interrupt,
          };
        } catch (err) {
          // Handler error or timeout - use default behavior
          // Map 'prompt' to 'deny' since SDK only supports 'allow' | 'deny'
          const configBehavior = handlers.defaultPermissionBehavior || 'allow';
          const defaultBehavior: 'allow' | 'deny' = configBehavior === 'prompt' ? 'deny' : configBehavior;
          return { behavior: defaultBehavior, updatedInput: toolInput };
        }
      }

      // No handler - use default behavior
      // Map 'prompt' to 'deny' since SDK only supports 'allow' | 'deny'
      const configBehavior = handlers.defaultPermissionBehavior || 'allow';
      const defaultBehavior: 'allow' | 'deny' = configBehavior === 'prompt' ? 'deny' : configBehavior;
      return { behavior: defaultBehavior, updatedInput: toolInput };
    };
  }

  /**
   * Handle AskUserQuestion tool
   */
  private async handleUserQuestionTool(
    toolInput: Record<string, unknown>,
    toolUseId: string,
    handlers: SdkEventHandlerConfig,
    sessionId: string,
    tier?: TierName,
    executionId?: string
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }> {
    // Extract questions from tool input
    const questions: UserQuestion[] = (toolInput.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    }> || []).map(q => ({
      question: q.question,
      header: q.header,
      options: q.options || [],
      multiSelect: q.multiSelect || false,
    }));

    const request = createUserQuestionRequest(
      questions,
      toolUseId,
      sessionId,
      tier,
      executionId,
      toolInput.timeout as number | undefined
    );

    // Emit user question event
    this.emitUserQuestionEvent(request);

    // If custom handler provided, use it
    if (handlers.onUserQuestion) {
      try {
        const handlerTimeout = handlers.handlerTimeout || 60000;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<UserQuestionResponse>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Question handler timeout')), handlerTimeout);
        });
        const response = await Promise.race([
          handlers.onUserQuestion(request),
          timeoutPromise,
        ]).finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        });

        // Emit user answer event
        this.emitUserAnswerEvent(request, response);

        return {
          behavior: 'allow',
          updatedInput: {
            ...toolInput,
            answers: response.answers,
          },
        };
      } catch (err) {
        // Handler error or timeout
        if (handlers.defaultAnswerStrategy === 'skip') {
          return { behavior: 'deny', message: 'Question skipped due to timeout' };
        }
        // Use first option as default
        const defaultResponse = createDefaultQuestionResponse(request);
        this.emitUserAnswerEvent(request, defaultResponse);
        return {
          behavior: 'allow',
          updatedInput: {
            ...toolInput,
            answers: defaultResponse.answers,
          },
        };
      }
    }

    // No handler - use default strategy
    if (handlers.defaultAnswerStrategy === 'skip') {
      return { behavior: 'deny', message: 'No question handler configured' };
    }

    // Use first option as default
    const defaultResponse = createDefaultQuestionResponse(request);
    this.emitUserAnswerEvent(request, defaultResponse);
    return {
      behavior: 'allow',
      updatedInput: {
        ...toolInput,
        answers: defaultResponse.answers,
      },
    };
  }

  /**
   * Emit permission request event
   */
  private emitPermissionRequestEvent(request: PermissionRequest): void {
    if (!this.emitSdkEvents) return;

    const event: SdkPermissionRequestEvent = {
      ...createSdkEventBase(request.sessionId, request.tier, request.executionId),
      type: 'sdk_hook',
      hookType: 'PermissionRequest',
      data: {
        toolName: request.toolName,
        toolInput: request.toolInput,
        toolUseId: request.toolUseId,
        suggestions: request.suggestions,
        decision: 'allow', // Will be updated when response comes
        updatedPermissions: undefined,
      },
    };
    this.emit('sdk_event', event);
    this.emit('blocking_event', { type: 'permission_request', request });
  }

  /**
   * Emit permission response event
   */
  private emitPermissionResponseEvent(request: PermissionRequest, response: PermissionResponse): void {
    if (!this.emitSdkEvents) return;

    const event: SdkPermissionRequestEvent = {
      ...createSdkEventBase(request.sessionId, request.tier, request.executionId),
      type: 'sdk_hook',
      hookType: 'PermissionRequest',
      data: {
        toolName: request.toolName,
        toolInput: request.toolInput,
        toolUseId: request.toolUseId,
        decision: response.behavior === 'allow_with_update' ? 'allow_with_update' : response.behavior,
        updatedPermissions: response.updatedPermissions,
      },
    };
    this.emit('sdk_event', event);
    this.emit('blocking_event_response', { type: 'permission_response', request, response });
  }

  /**
   * Emit user question event
   */
  private emitUserQuestionEvent(request: UserQuestionRequest): void {
    if (!this.emitSdkEvents) return;

    const event: SdkUserQuestionEvent = {
      ...createSdkEventBase(request.sessionId, request.tier, request.executionId),
      type: 'sdk_user_input',
      action: 'question',
      data: {
        questions: request.questions,
        timeout: request.timeout,
      },
    };
    this.emit('sdk_event', event);
    this.emit('blocking_event', { type: 'user_question', request });
  }

  /**
   * Emit user answer event
   */
  private emitUserAnswerEvent(request: UserQuestionRequest, response: UserQuestionResponse): void {
    if (!this.emitSdkEvents) return;

    const event: SdkUserQuestionEvent = {
      ...createSdkEventBase(request.sessionId, request.tier, request.executionId),
      type: 'sdk_user_input',
      action: 'question',
      data: {
        questions: request.questions,
        answers: response.answers as Record<string, string | string[]>,
        timedOut: response.timedOut,
      },
    };
    this.emit('sdk_event', event);
    this.emit('blocking_event_response', { type: 'user_answer', request, response });
  }

  /**
   * Respond to a pending blocking event from external source (e.g., orchestrator)
   */
  respondToBlockingEvent(requestId: string, response: PermissionResponse | UserQuestionResponse): boolean {
    const pending = this.pendingBlockingEvents.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingBlockingEvents.delete(requestId);
      return true;
    }
    return false;
  }

  /**
   * Get pending blocking events
   */
  getPendingBlockingEvents(): string[] {
    return Array.from(this.pendingBlockingEvents.keys());
  }

  /**
   * Create empty usage object
   */
  private emptyUsage(): TokenUsage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  /**
   * Check if a session file exists for the given cwd and sessionId
   * Sessions are stored at ~/.claude/projects/{project-path}/{sessionId}.jsonl
   */
  private checkSessionExists(cwd: string, sessionId: string): boolean {
    try {
      // Convert cwd to project path format used by Claude
      // e.g., /home/ubuntu/sample-project -> -home-ubuntu-sample-project
      const projectPathKey = cwd.replace(/\//g, '-');
      const sessionDir = path.join(os.homedir(), '.claude', 'projects', projectPathKey);
      const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
      return fs.existsSync(sessionFile);
    } catch {
      return false;
    }
  }
}

/**
 * Create a new SDK runner instance
 */
export function createSdkRunner(options?: SdkRunnerOptions): ClaudeSdkRunner {
  return new ClaudeSdkRunner(options);
}
