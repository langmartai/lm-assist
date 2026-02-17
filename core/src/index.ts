/**
 * LM-Assist Core
 *
 * TypeScript wrapper for Claude Code CLI management providing:
 * - CLI execution with streaming output
 * - Session storage observation and management
 * - Project folder management
 * - CLAUDE.md file management
 * - Token usage and cost calculation
 *
 * @packageDocumentation
 */

// Export all types (imports from ./types which has been stripped for lm-assist)
export * from './types';

// Runners
export { ClaudeCliRunner, createCliRunner } from './cli-runner';
export { ClaudeSdkRunner, createSdkRunner, type SdkRunnerOptions, type SdkExecuteOptions, type SdkExecuteResult, type SdkExecutionHandle } from './sdk-runner';

// Session management
export { SessionManager, createSessionManager } from './session-manager';
export { ProjectManager, createProjectManager } from './project-manager';
export { ClaudeMdManager, createClaudeMdManager } from './md-manager';
export { CostCalculator, createCostCalculator, DEFAULT_MODEL_PRICING } from './cost-calculator';

// ttyd
export { TtydManager, TtydInstanceStore, createTtydManager, getTtydManager, type TtydProcess, type TtydInstanceRecord, type ClaudeProcessInfo, type SessionProcessStatus, type TtydStartResult } from './ttyd-manager';
export { ProcessStatusStore, getProcessStatusStore, type ProcessRunningInfo } from './process-status-store';
export { SessionIdentifier, getSessionIdentifier, normalizeTerminalText, extractFingerprints, scoreSessionMatch, type IdentificationResult } from './session-identifier';
export { getTtydProxyUrl, handleTtydProxyRequest, handleTtydProxyUpgrade, isTtydProxyPath } from './ttyd-proxy';

// Tasks
export { TasksService, createTasksService, getTasksService } from './tasks-service';
export { TaskStore, getTaskStore, createTaskStore, disposeAllTaskStores, type TaskSnapshot, type SessionSnapshot, type AdhocWorkRecord, type TaskStoreConfig, type TaskStoreEvents } from './task-store';

// Projects
export {
  ProjectsService, createProjectsService, getProjectsService, resetProjectsService,
  type Project, type ProjectSession, type ProjectTask, type TaskReference, type ProjectSize,
  type ListProjectsOptions, type ListSessionsOptions,
  // Backward compat aliases
  ProjectsService as ClaudeProjectsService,
  createProjectsService as createClaudeProjectsService,
  getProjectsService as getClaudeProjectsService,
  resetProjectsService as resetClaudeProjectsService,
  type Project as ClaudeProject,
} from './projects-service';

// Tier stubs (minimal)
export { TierAgent, TierAgentFactory, type RunnerType, type TierConfigExtended, type FactoryOptions, type TierAgentExecutionHandle } from './tier-agent';
export { TierManager, createTierManager, TierManagerProtocolResult, type TierManagerConfigExtended, type ExecuteTierDirectOptions } from './tier-manager';

// Control API and server
export { TierControlApiImpl, createControlApi } from './control-api';
export { TierRestServer, createRestServer, startServer } from './rest-server';

// Event store
export { EventStore, createEventStore, type ExecutionAgentType } from './event-store';

// Session reader
export {
  SessionReader, createSessionReader, getSessionReader, resetSessionReader,
  type SessionSummary, type SessionInfo, type ProjectInfo, type SubagentFileInfo, type SessionReaderConfig,
  ClaudeSessionReader, createClaudeSessionReader, getClaudeSessionReader, resetClaudeSessionReader,
  type ClaudeSessionSummary, type ClaudeSessionInfo, type ClaudeProjectInfo, type ClaudeSessionReaderConfig,
} from './session-reader';

// Session DAG
export { SessionDagService, getSessionDagService } from './session-dag';
export type {
  DagNode, DagEdge, DagGraph,
  MessageNode, MessageNodeType,
  SessionNode, SessionNodeType,
  BranchInfo, ForkPointInfo, MessageNodeContext,
  RelatedSessions, UnifiedDag,
  MessageDagOptions, SessionDagOptions,
  BatchQuery, BatchResult, DagCacheStats,
} from './session-dag';

// Agent session store and monitor
export {
  AgentSessionStore, createAgentSessionStore,
  type AgentSession, type SessionStatus, type SessionQuery, type SessionStats,
  type SessionStoreConfig, type SessionUpdateEvent,
  type ClaudeSessionMessageType, type ClaudeSystemSubtype, type ClaudeSessionMessage,
  type ClaudeSystemInit, type ClaudeAssistantMessage, type ClaudeResultMessage,
  type ClaudeToolUse, type ClaudeUserPrompt, type ClaudeSessionData,
  type FileActionCategory, type FileChange, getFileActionCategory, summarizeFileChanges,
  type DbOperation, type GitOperation, type GitOperationType,
  type ToolDetailLevel, type ConversationToolCall, type ConversationMessage,
  type GetConversationOptions, type ConversationResult,
} from './agent-session-store';
export {
  AgentSessionMonitor, createAgentSessionMonitor,
  type MonitoredExecution, type SessionMonitorConfig, type ProgressEvent, type CompletionEvent,
} from './agent-session-monitor';

// Checkpoint
export {
  CheckpointManager, createCheckpointManager,
  CheckpointStore, createCheckpointStore,
  gitUtils, gitCommand, isGitRepo, ensureGitRepo, getCurrentCommit, getCurrentBranch,
  isWorkingTreeClean, stageAll, stageFiles, commit as gitCommit,
  getDiffFiles, getDiffStats, getFileDiff, getFileStatus, parseDiffOutput,
  detectTierFromPath, isBinaryFile, resetHard, resetSoft, resetMixed,
  checkoutFile, checkoutFiles, getCommitMessage, getCommitDate, commitExists,
  getCommitCount, stash, stashPop, getFilesAtCommit,
  type CheckpointManagerEvents, type CheckpointStoreEvents,
} from './checkpoint';

// Hub client
export {
  HubClient, getHubClient, createHubClient,
  type HubClientOptions, type HubClientEvents,
} from './hub-client';
export { getHubConfig, saveGatewayId, clearGatewayId, isHubConfigured, type HubConfig } from './hub-client/hub-config';
export { WebSocketClient, type WebSocketClientOptions } from './hub-client/websocket-client';
export { ApiRelayHandler, type ApiRelayHandlerOptions, type ApiRelayRequest, type ApiRelayResponse, type ServiceRoute } from './hub-client/api-relay-handler';
export { ConsoleRelayHandler, getConsoleRelayHandler, type ConsoleRelayOptions, type ConsoleSession } from './hub-client/console-relay-handler';
export { SessionCacheSync, getSessionCacheSync, type SessionSummary as SessionCacheSummary, type SessionCacheSyncOptions } from './hub-client/session-cache-sync';

// Utilities (named exports to avoid conflicts with ./types)
export { getSessionFilePath, getProjectsDir } from './utils/path-utils';
export { readJsonlFile, type RawSessionRecord } from './utils/jsonl-parser';
export { ChangeTracker } from './utils/change-tracker';
export { GitManager, commitOrchestratedChanges, type OrchestratorCommitResult } from './utils/git-manager';

// Note: orchestrator, control-api, and agent-api types are already exported via './types'

// Agent teams types
export * from './types/agent-teams';

// Event store types
export type {
  StoredEvent, ExecutionRecord, EventQueryOptions, ExecutionQueryOptions,
  EventStoreConfig, OutputChunkType,
} from './event-store';

// Session processing state
export { SessionProcessingStateService, createSessionProcessingStateService } from './session-processing-state-service';

// Prompt loader
export {
  loadTierPrompts, loadAllTierPrompts, clearPromptCache, reloadTierPrompts,
  getPromptsDir, hasCustomPrompts, type TierPrompts,
} from './prompt-loader';

// Re-export commonly used types
export type {
  ClaudeCliOptions, ClaudeCliResult, ClaudeCliStreamEvent,
  Session, SessionMessage, SessionFilter,
  ProjectConfig, ClaudeMdInfo, ClaudeMdSection, ClaudeMdTemplate,
  ModelPricing, CostEstimate, UsageSummary, TokenUsage,
  TierConfig, TierAgentResult, TierManagerConfig, TierManagerResult,
  TaskBreakdown, TierTask,
} from './types';

/**
 * Create a fully configured Claude CLI Manager
 */
export interface ClaudeCliManagerOptions {
  /** Claude config directory (default: ~/.claude) */
  configDir?: string;
  /** Default timeout for CLI calls in ms */
  defaultTimeout?: number;
  /** Default model for cost calculation */
  defaultModel?: string;
}

/**
 * Combined manager providing access to all functionality
 */
export class ClaudeCliManager {
  public readonly cli: import('./cli-runner').ClaudeCliRunner;
  public readonly sessions: import('./session-manager').SessionManager;
  public readonly projects: import('./project-manager').ProjectManager;
  public readonly claudeMd: import('./md-manager').ClaudeMdManager;
  public readonly costs: import('./cost-calculator').CostCalculator;

  constructor(options?: ClaudeCliManagerOptions) {
    const { ClaudeCliRunner } = require('./cli-runner');
    const { SessionManager } = require('./session-manager');
    const { ProjectManager } = require('./project-manager');
    const { ClaudeMdManager } = require('./md-manager');
    const { CostCalculator } = require('./cost-calculator');

    this.cli = new ClaudeCliRunner({ defaultTimeout: options?.defaultTimeout });
    this.sessions = new SessionManager(options?.configDir);
    this.projects = new ProjectManager(options?.configDir);
    this.claudeMd = new ClaudeMdManager();
    this.costs = new CostCalculator({ defaultModel: options?.defaultModel });
  }

  /**
   * Execute a prompt in a project directory
   */
  async execute(
    projectPath: string,
    prompt: string,
    options?: Partial<import('./types').ClaudeCliOptions>
  ): Promise<import('./types').ClaudeCliResult> {
    return this.cli.executeVerbose(prompt, {
      cwd: projectPath,
      ...options,
    });
  }

  /**
   * Get project overview including CLAUDE.md analysis
   */
  async getProjectOverview(projectPath: string): Promise<{
    project: import('./types').Project | null;
    claudeMd: import('./types').ClaudeMdInfo;
    recentSessions: import('./types').Session[];
    totalCost: number;
    impact: {
      tokensPerRequest: number;
      costPerRequestUsd: number;
      monthlyCostUsd: number;
    };
  }> {
    const project = this.projects.getProjectInfo(projectPath);
    const claudeMd = this.claudeMd.getInfo(projectPath);
    const recentSessions = await this.sessions.listProjectSessions(projectPath);
    const impact = this.claudeMd.estimateImpact(projectPath);

    // Calculate total cost
    let totalCost = 0;
    for (const session of recentSessions.slice(0, 100)) {
      totalCost += session.estimatedCost;
    }

    return {
      project,
      claudeMd,
      recentSessions: recentSessions.slice(0, 10),
      totalCost,
      impact,
    };
  }

  /**
   * Get usage summary for a time period
   */
  async getUsageSummary(
    projectPath?: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<import('./types').UsageSummary> {
    const sessions = await this.sessions.listAllSessions({
      projectPath,
      fromDate,
      toDate,
    });

    const data: Array<{
      sessionId: string;
      date: Date;
      model: string;
      tokens: import('./types').TokenUsage;
    }> = [];

    for (const session of sessions) {
      const usage = await this.sessions.getSessionUsage(
        session.projectPath,
        session.id
      );

      data.push({
        sessionId: session.id,
        date: session.updatedAt,
        model: 'claude-opus-4-6', // Default model
        tokens: usage.tokens,
      });
    }

    return this.costs.createUsageSummary(data);
  }
}

/**
 * Create a new Claude CLI Manager instance
 */
export function createClaudeCliManager(
  options?: ClaudeCliManagerOptions
): ClaudeCliManager {
  return new ClaudeCliManager(options);
}

// Default export
export default ClaudeCliManager;
