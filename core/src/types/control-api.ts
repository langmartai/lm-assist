/**
 * Tier Control API Type Definitions
 *
 * API for monitoring and controlling all tier agents:
 * - Monitor: status, sessions, costs, history
 * - Control: execute, stop, kill, restart
 * - Config: get/set tier configuration
 * - Queue: inter-agent request management
 */

// ============================================================================
// API Response Wrapper
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    timestamp: Date;
    requestId: string;
    durationMs: number;
  };
}

// ============================================================================
// Monitor API
// ============================================================================

export interface MonitorApi {
  /** Get status of all tiers or specific tier */
  getStatus(tier?: string): Promise<ApiResponse<TierStatusResponse>>;

  /** Get session info for a tier */
  getSession(tier: string): Promise<ApiResponse<SessionResponse>>;

  /** Get execution history */
  getHistory(options?: HistoryOptions): Promise<ApiResponse<HistoryResponse>>;

  /** Get cost summary */
  getCosts(options?: CostOptions): Promise<ApiResponse<CostResponse>>;

  /** Get real-time logs (streaming) */
  streamLogs(tier: string, callback: (log: LogEntry) => void): () => void;

  /** Health check */
  health(): Promise<ApiResponse<HealthResponse>>;
}

export interface TierStatusResponse {
  tiers: Record<string, TierStatusInfo>;
  summary: {
    total: number;
    idle: number;
    busy: number;
    error: number;
    uninitialized: number;
  };
}

export interface TierStatusInfo {
  name: string;
  status: "idle" | "busy" | "error" | "uninitialized" | "stopped";
  framework: string | null;
  sessionId: string | null;
  lastActivity: Date | null;
  currentTask: string | null;
  uptime: number;  // ms since last start
}

export interface SessionResponse {
  tier: string;
  sessionId: string;
  sessionPath: string;
  messageCount: number;
  createdAt: Date;
  lastActivity: Date;
  tokensUsed: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUsd: number;
}

export interface HistoryOptions {
  tier?: string;
  limit?: number;
  offset?: number;
  from?: Date;
  to?: Date;
  status?: "success" | "failed" | "all";
}

export interface HistoryResponse {
  executions: ExecutionHistoryEntry[];
  total: number;
  hasMore: boolean;
}

export interface ExecutionHistoryEntry {
  id: string;
  tier: string;
  timestamp: Date;
  prompt: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  filesChanged: string[];
  error?: string;
}

export interface CostOptions {
  tier?: string;
  period?: "day" | "week" | "month" | "all";
  from?: Date;
  to?: Date;
  groupBy?: "tier" | "day" | "model";
}

export interface CostResponse {
  totalCostUsd: number;
  breakdown: CostBreakdown[];
  period: {
    from: Date;
    to: Date;
  };
}

export interface CostBreakdown {
  key: string;  // tier name, date, or model
  costUsd: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  executions: number;
}

export interface LogEntry {
  timestamp: Date;
  tier: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  tiers: Record<string, {
    status: "ok" | "error";
    message?: string;
  }>;
}

// ============================================================================
// Control API
// ============================================================================

/** Progress update for background execution */
export interface BackgroundProgressUpdate {
  currentStep: number;
  totalSteps: number;
  progressPercent: number;
  lastVibeMessage: string;
}

/** Result for background execution completion */
export interface BackgroundExecutionResult {
  success: boolean;
  summary?: string;
  error?: string;
  output?: string;
  artifacts?: Array<{ type: string; path: string }>;
  durationMs?: number;
  costUsd?: number;
  /** Claude Code session ID (for linking to session details) */
  sessionId?: string;
  /** Claude Code session ID (alias for sessionId) */
  claudeSessionId?: string;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** Options for background execution */
export interface BackgroundExecuteOptions extends ExecuteOptions {
  /** Callback for progress updates */
  onProgress?: (progress: BackgroundProgressUpdate) => void;
  /** Callback when execution completes */
  onComplete?: (result: BackgroundExecutionResult) => void;
}

export interface ControlApi {
  /** Execute a task on a specific tier */
  execute(tier: string, prompt: string, options?: ExecuteOptions): Promise<ApiResponse<ExecuteResponse>>;

  /** Execute a task in background mode (returns immediately) */
  executeBackground(
    executionId: string,
    tier: string,
    prompt: string,
    options?: BackgroundExecuteOptions
  ): void;

  /** Execute through orchestrator (auto-routes to tiers) */
  orchestrate(prompt: string, options?: OrchestrateOptions): Promise<ApiResponse<OrchestrateResponse>>;

  /** Stop a running execution */
  stop(tier: string): Promise<ApiResponse<StopResponse>>;

  /** Kill agent process */
  kill(tier: string): Promise<ApiResponse<KillResponse>>;

  /** Kill all agents */
  killAll(): Promise<ApiResponse<KillAllResponse>>;

  /** Restart an agent */
  restart(tier: string): Promise<ApiResponse<RestartResponse>>;
}

export interface ExecuteOptions {
  /** Resume existing session */
  resume?: boolean;
  /** Additional context to inject */
  context?: string;
  /** Timeout in ms */
  timeout?: number;
  /** Async execution (returns immediately) */
  async?: boolean;
  /** Callback URL for async completion */
  callbackUrl?: string;
}

export interface ExecuteResponse {
  executionId: string;
  tier: string;
  status: "completed" | "running" | "queued" | "started";
  result?: string;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  filesChanged?: string[];

  /** Time estimation for the execution */
  estimation?: {
    /** Estimated duration in seconds */
    estimatedSeconds: number;
    /** Min/max range for the estimate */
    estimatedRange: {
      min: number;
      max: number;
    };
    /** Complexity level */
    complexity: "quick" | "medium" | "large";
    /** Human-friendly description (e.g., "Should take about 30 seconds") */
    vibeDescription: string;
  };

  /** Execution metadata */
  meta?: {
    /** When execution started (ISO timestamp) */
    startedAt: string;
    /** Expected completion time (ISO timestamp) */
    expectedEndAt: string;
    /** Tier name */
    tier: string;
    /** Prompt (truncated if long) */
    prompt: string;
  };
}

export interface OrchestrateOptions {
  /** Target specific tiers only */
  tiers?: string[];
  /** Dry run (plan only) */
  dryRun?: boolean;
  /** Allow parallel execution */
  parallel?: boolean;
  /** Timeout in ms */
  timeout?: number;
}

export interface OrchestrateResponse {
  requestId: string;
  status: "completed" | "partial" | "failed";
  plan: {
    reasoning: string;
    tasks: Array<{
      tier: string;
      prompt: string;
      priority: number;
    }>;
  };
  results: Array<{
    tier: string;
    success: boolean;
    result?: string;
    error?: string;
    costUsd: number;
  }>;
  summary: string;
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface StopResponse {
  tier: string;
  stopped: boolean;
  wasRunning: boolean;
}

export interface KillResponse {
  tier: string;
  killed: boolean;
  pid?: number;
}

export interface KillAllResponse {
  killed: number;
  tiers: string[];
}

export interface RestartResponse {
  tier: string;
  restarted: boolean;
  newSessionId: string;
}

// ============================================================================
// Config API
// ============================================================================

export interface ConfigApi {
  /** Get tier configuration */
  getConfig(tier: string): Promise<ApiResponse<TierConfigResponse>>;

  /** Update tier configuration */
  setConfig(tier: string, config: Partial<TierConfigUpdate>): Promise<ApiResponse<TierConfigResponse>>;

  /** Get CLAUDE.md content */
  getClaudeMd(tier: string): Promise<ApiResponse<ClaudeMdResponse>>;

  /** Update CLAUDE.md content */
  setClaudeMd(tier: string, content: string): Promise<ApiResponse<ClaudeMdResponse>>;

  /** Initialize tier with framework */
  initialize(tier: string, framework: string): Promise<ApiResponse<InitializeResponse>>;

  /** List available frameworks for a tier */
  listFrameworks(tier: string): Promise<ApiResponse<FrameworksResponse>>;
}

export interface TierConfigResponse {
  tier: string;
  framework: {
    id: string;
    name: string;
    version?: string;
  } | null;
  language: string | null;
  initialized: boolean;
  paths: {
    root: string;
    write: string[];
    readOnly: string[];
  };
  bash: {
    allowed: string[];
    disallowed: string[];
  };
}

export interface TierConfigUpdate {
  framework?: string;
  paths?: {
    write?: string[];
    readOnly?: string[];
  };
  bash?: {
    allowed?: string[];
    disallowed?: string[];
  };
  instructions?: string;
}

export interface ClaudeMdResponse {
  tier: string;
  path: string;
  content: string;
  lastModified: Date;
  tokenEstimate: number;
}

export interface InitializeResponse {
  tier: string;
  framework: string;
  filesCreated: string[];
  message: string;
}

export interface FrameworksResponse {
  tier: string;
  frameworks: Array<{
    id: string;
    name: string;
    language: string;
    description?: string;
  }>;
}

// ============================================================================
// Queue API (Inter-Agent Requests)
// ============================================================================

export interface QueueApi {
  /** Get pending requests */
  getPending(): Promise<ApiResponse<QueueResponse>>;

  /** Get request by ID */
  getRequest(requestId: string): Promise<ApiResponse<RequestResponse>>;

  /** Approve a pending request */
  approve(requestId: string): Promise<ApiResponse<ApproveResponse>>;

  /** Reject a pending request */
  reject(requestId: string, reason?: string): Promise<ApiResponse<RejectResponse>>;

  /** Get request history */
  getRequestHistory(options?: RequestHistoryOptions): Promise<ApiResponse<RequestHistoryResponse>>;

  /** Submit a new inter-agent request */
  submit(request: SubmitRequest): Promise<ApiResponse<SubmitResponse>>;
}

export interface QueueResponse {
  pending: InterAgentRequestSummary[];
  processing: InterAgentRequestSummary | null;
  queueLength: number;
}

export interface InterAgentRequestSummary {
  id: string;
  sourceTier: string;
  targetTier: string;
  type: string;
  priority: "low" | "normal" | "high";
  status: "pending" | "approved" | "rejected" | "processing" | "completed" | "failed";
  createdAt: Date;
  summary: string;
}

export interface RequestResponse {
  request: InterAgentRequestSummary & {
    payload: unknown;
    result?: unknown;
    error?: string;
  };
}

export interface ApproveResponse {
  requestId: string;
  approved: boolean;
  queuePosition: number;
}

export interface RejectResponse {
  requestId: string;
  rejected: boolean;
  reason?: string;
}

export interface RequestHistoryOptions {
  sourceTier?: string;
  targetTier?: string;
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface RequestHistoryResponse {
  requests: InterAgentRequestSummary[];
  total: number;
  hasMore: boolean;
}

export interface SubmitRequest {
  sourceTier: string;
  targetTier: string;
  type: string;
  payload: unknown;
  priority?: "low" | "normal" | "high";
}

export interface SubmitResponse {
  requestId: string;
  queued: boolean;
  position: number;
}

// ============================================================================
// Combined API Interface
// ============================================================================

export interface TierControlApi {
  monitor: MonitorApi;
  control: ControlApi;
  config: ConfigApi;
  queue: QueueApi;
}

// ============================================================================
// Event Types (for WebSocket/SSE)
// ============================================================================

export type TierEvent =
  | { type: "status_change"; tier: string; status: string; previousStatus: string }
  | { type: "execution_start"; tier: string; executionId: string; prompt: string }
  | { type: "execution_complete"; tier: string; executionId: string; success: boolean; result?: string }
  | {
      type: "execution_error";
      tier: string;
      executionId: string;
      error: string;  // Keep for backwards compatibility
      /** Enhanced error info with recovery suggestions */
      errorInfo?: {
        friendlyMessage: string;
        whatHappened: string;
        technicalDetails?: string;
        recoverySuggestions: Array<{
          id: string;
          type: string;
          label: string;
          description: string;
          action?: {
            type: string;
            endpoint?: string;
            promptSuggestion?: string;
            url?: string;
          };
        }>;
        canAutoRecover: boolean;
      };
    }
  | { type: "request_submitted"; request: InterAgentRequestSummary }
  | { type: "request_approved"; requestId: string }
  | { type: "request_completed"; requestId: string; success: boolean }
  | { type: "cost_update"; tier: string; costUsd: number; totalCostUsd: number }
  | { type: "log"; entry: LogEntry }
  // SDK-specific events
  | { type: "sdk_tool_use"; tier: string; executionId: string; toolName: string; toolUseId: string; input: unknown }
  | { type: "sdk_tool_result"; tier: string; executionId: string; toolName: string; toolUseId: string; success: boolean; durationMs: number }
  | { type: "sdk_subagent_start"; tier: string; executionId: string; agentName: string; agentId: string; prompt: string }
  | { type: "sdk_subagent_stop"; tier: string; executionId: string; agentName: string; agentId: string; success: boolean; durationMs: number }
  | { type: "sdk_mcp_connect"; tier: string; executionId: string; serverName: string; tools: string[] }
  | { type: "sdk_mcp_disconnect"; tier: string; executionId: string; serverName: string; reason: string }
  | { type: "sdk_user_question"; tier: string; executionId: string; questions: unknown[] }
  | { type: "sdk_user_answer"; tier: string; executionId: string; answers: Record<string, string> }
  | { type: "sdk_permission_request"; tier: string; executionId: string; toolName: string; decision: string }
  // Session events
  | { type: "session_update"; timestamp: Date; tier: string; data: SessionUpdateEventData }
  // Progress events (for Vibe Coder UI)
  | {
      type: "execution_progress";
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
  | {
      type: "execution_time_update";
      executionId: string;
      elapsedSeconds: number;
      estimatedTotalSeconds: number;
      estimatedRemainingSeconds: number;
      isOverEstimate: boolean;
      vibeMessage?: string;
    }
  // Reconnection event (for background execution)
  | {
      type: "execution_reconnect";
      executionId: string;
      currentState: {
        tier: string;
        status: "pending" | "running" | "completed" | "failed";
        prompt: string;
        startedAt: string;
        completedAt?: string;
        progress: {
          currentStep: number;
          totalSteps: number;
          progressPercent: number;
          lastVibeMessage: string;
        };
        estimation: {
          estimatedSeconds: number;
          complexity: "quick" | "medium" | "large";
        };
        result?: {
          success: boolean;
          summary?: string;
          error?: string;
        };
      };
    }
  // Visual snapshot events (Phase 5)
  | {
      type: "snapshot_ready";
      executionId: string;
      tier: string;
      snapshot: {
        id: string;
        imageUrl: string;
        thumbnailUrl?: string;
        capturedAt: string;
        triggerType: "scheduled" | "file_change" | "milestone" | "final";
        context?: {
          step: number;
          stepDescription: string;
          filesChanged?: string[];
        };
      };
    }
  | {
      type: "snapshot_error";
      executionId: string;
      tier: string;
      error: string;
    };

export interface SessionUpdateEventData {
  type: 'session_created' | 'session_updated' | 'session_completed' | 'session_failed' | 'session_deleted';
  session: {
    sessionId: string;
    executionId: string;
    tier: string;
    status: string;
  };
  previousStatus?: string;
}

// ============================================================================
// SDK Event Options
// ============================================================================

export interface SdkEventOptions {
  /** Include SDK events in the event stream */
  includeSdkEvents?: boolean;
  /** Filter by SDK hook types */
  sdkHookTypes?: string[];
  /** Filter by MCP server names */
  mcpServers?: string[];
  /** Filter by tool names */
  toolNames?: string[];
}

// ============================================================================
// Deploy API
// ============================================================================

export interface DeployApi {
  /** Execute a deployment plan */
  deploy(options: DeployOptions): Promise<ApiResponse<DeployResponse>>;

  /** Execute a single operation on a target */
  executeOperation(target: DeployTarget, operation: string): Promise<ApiResponse<OperationResponse>>;

  /** Get status of all deployable services */
  getStatus(): Promise<ApiResponse<DeployStatusResponse>>;

  /** Get pending deploy errors that need fixes */
  getErrors(): Promise<ApiResponse<DeployErrorsResponse>>;

  /** Route a deploy error to the appropriate tier for fixing */
  routeError(errorId: string): Promise<ApiResponse<RouteErrorResponse>>;

  /** Restart deployment after a fix */
  restartAfterFix(restartRequest: RestartAfterFixRequest): Promise<ApiResponse<DeployResponse>>;
}

// DeployTarget stub (deploy-operations not included in lm-assist)
export type DeployTarget = 'docker' | 'vercel' | 'aws' | 'gcp' | 'azure' | 'terraform';

export interface DeployOptions {
  /** Deployment plan type */
  plan: 'full' | 'build-only' | 'target';
  /** Target for 'target' plan */
  target?: DeployTarget;
  /** Operations for 'target' plan */
  operations?: string[];
  /** Stop on first error */
  stopOnError?: boolean;
  /** Auto-fix errors by routing to tiers */
  autoFix?: boolean;
  /** Maximum fix attempts */
  maxFixAttempts?: number;
}

export interface DeployResponse {
  /** Plan ID */
  planId: string;
  /** Overall status */
  status: 'success' | 'partial' | 'failed' | 'blocked';
  /** Results for each operation */
  operations: OperationResultSummary[];
  /** Errors that need fixing */
  errorsNeedingFix: DeployErrorSummary[];
  /** Summary message */
  summary: string;
  /** Total duration */
  totalDurationMs: number;
  /** Total cost */
  totalCostUsd: number;
}

export interface OperationResultSummary {
  target: string;
  operation: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  output?: string;
  durationMs?: number;
  error?: string;
}

export interface OperationResponse {
  target: string;
  operation: string;
  status: 'success' | 'failed';
  output: string;
  durationMs: number;
  error?: string;
}

export interface DeployStatusResponse {
  services: {
    web: ServiceStatus;
    api: ServiceStatus;
    database: DatabaseStatus;
  };
  lastDeployment?: {
    planId: string;
    status: string;
    timestamp: Date;
  };
}

export interface ServiceStatus {
  running: boolean;
  port?: number;
  pid?: number;
  uptime?: number;
  lastBuild?: Date;
  buildStatus?: 'success' | 'failed' | 'none';
}

export interface DatabaseStatus {
  connected: boolean;
  migrations: 'up-to-date' | 'pending' | 'failed' | 'unknown';
  lastMigration?: string;
  lastMigrationDate?: Date;
}

export interface DeployErrorsResponse {
  errors: DeployErrorSummary[];
  total: number;
}

export interface DeployErrorSummary {
  id: string;
  code: string;
  message: string;
  fixableTier: 'web' | 'api' | 'database' | 'deploy' | 'unknown';
  suggestedFix: string;
  failedOperation: string;
  timestamp: Date;
  status: 'pending' | 'routing' | 'fixing' | 'fixed' | 'failed';
}

export interface RouteErrorResponse {
  errorId: string;
  routedTo: string;
  fixTaskId: string;
  fixPrompt: string;
}

export interface RestartAfterFixRequest {
  /** Original plan ID */
  planId: string;
  /** Operations to skip */
  skipOperations: string[];
  /** Operation to retry */
  retryOperation: string;
  /** Fix context */
  fixContext: string;
}

// ============================================================================
// Protocol API
// ============================================================================

export interface ProtocolApi {
  /** Parse commands from a tier response */
  parseCommands(response: string): Promise<ApiResponse<ParseCommandsResponse>>;

  /** Validate a tier response format */
  validateResponse(response: string, tierName: string): Promise<ApiResponse<ValidateResponseResponse>>;

  /** Get parsed commands from an execution */
  getExecutionCommands(executionId: string): Promise<ApiResponse<ExecutionCommandsResponse>>;
}

export interface ParseCommandsResponse {
  commands: ParsedCommandSummary[];
  text: string;
  errors: CommandParseErrorSummary[];
}

export interface ParsedCommandSummary {
  type: string;
  tier?: string;
  status?: string;
  jobComplete?: boolean;
  summary?: string;
  raw: string;
}

export interface CommandParseErrorSummary {
  message: string;
  position: number;
  raw?: string;
}

export interface ValidateResponseResponse {
  valid: boolean;
  recoverable: boolean;
  errors: ValidationErrorSummary[];
  hasResultCommand: boolean;
  jobComplete?: boolean;
}

export interface ValidationErrorSummary {
  code: string;
  message: string;
  field?: string;
}

export interface ExecutionCommandsResponse {
  executionId: string;
  tier: string;
  commands: ParsedCommandSummary[];
  jobComplete: boolean;
  status: string;
}

// ============================================================================
// Job Completion API
// ============================================================================

export interface JobApi {
  /** Verify job completion with two-way check */
  verifyCompletion(request: VerifyCompletionRequest): Promise<ApiResponse<VerifyCompletionResponse>>;

  /** Get job completion status for an execution */
  getCompletionStatus(executionId: string): Promise<ApiResponse<CompletionStatusResponse>>;

  /** Make orchestrator decision on incomplete job */
  makeDecision(executionId: string, config?: DecisionConfig): Promise<ApiResponse<DecisionResponse>>;
}

export interface VerifyCompletionRequest {
  /** Execution ID or raw response */
  executionId?: string;
  response?: string;
  /** Original task context */
  originalTask: {
    prompt: string;
    expectedDeliverables?: string[];
    successCriteria?: string[];
  };
  /** Review configuration */
  reviewConfig?: {
    strictness?: 'lenient' | 'moderate' | 'strict';
    requireArtifacts?: boolean;
  };
}

export interface VerifyCompletionResponse {
  verified: boolean;
  tierClaim: {
    jobComplete: boolean;
    status: string;
  };
  orchestratorReview?: {
    verdict: 'approved' | 'needs_revision' | 'needs_clarification' | 'rejected' | 'manual_review';
    acceptCompletion: boolean;
    reasoning: string;
    findings: ReviewFindingSummary[];
    revisionPrompt?: string;
  };
  finalDecision: {
    action: OrchestratorDecisionAction;
    reason: string;
    prompt?: string;
  };
}

export interface ReviewFindingSummary {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
}

export interface CompletionStatusResponse {
  executionId: string;
  tier: string;
  jobComplete: boolean;
  status: 'success' | 'failure' | 'partial' | 'blocked';
  hasPendingQuestion: boolean;
  hasPendingPermission: boolean;
  hasContinuation: boolean;
  continuation?: {
    reason: string;
    message: string;
    workRemaining?: string[];
  };
}

export interface DecisionConfig {
  autoContinueOnReview?: boolean;
  skipOptionalQuestions?: boolean;
  maxContinuationAttempts?: number;
}

export interface DecisionResponse {
  action: OrchestratorDecisionAction;
  reason: string;
  prompt?: string;
  questionRequest?: unknown;
  permissionRequest?: unknown;
}

export type OrchestratorDecisionAction =
  | 'complete'
  | 'continue'
  | 'answer_question'
  | 'handle_permission'
  | 'skip_question_continue'
  | 'fail';

// ============================================================================
// Preflight API
// ============================================================================

export interface PreflightApi {
  /** Run preflight checks */
  runPreflight(options?: PreflightRunOptions): Promise<ApiResponse<PreflightRunResponse>>;

  /** Get current preflight configuration */
  getConfig(): Promise<ApiResponse<PreflightConfigResponse>>;

  /** Check if preflight is needed */
  needsPreflight(): Promise<ApiResponse<PreflightNeededResponse>>;

  /** Get deploy context (only database/ports/git info) */
  getDeployContext(): Promise<ApiResponse<PreflightDeployContextResponse>>;
}

export interface PreflightRunOptions {
  /** Project ID (auto-generated if not provided) */
  projectId?: string;
  /** GitHub organization for git remotes */
  githubOrg?: string;
  /** Tiers to check */
  tiers?: string[];
  /** Checks to skip */
  skipChecks?: string[];
  /** Create missing resources (git, database, folders) */
  createIfMissing?: boolean;
  /** Port range for allocation */
  portRange?: { min: number; max: number };
  /** Environment */
  environment?: 'development' | 'staging' | 'production';
}

export interface PreflightRunResponse {
  passed: boolean;
  checks: PreflightCheckSummary[];
  config?: PreflightConfigSummary;
  errors: PreflightErrorSummary[];
  warnings: PreflightWarningSummary[];
  durationMs: number;
}

export interface PreflightCheckSummary {
  id: string;
  name: string;
  category: 'git' | 'database' | 'ports' | 'environment' | 'files';
  passed: boolean;
  message: string;
  critical: boolean;
  suggestedFix?: string;
}

export interface PreflightConfigSummary {
  projectId: string;
  projectName: string;
  checkedAt: string;
  database: {
    host: string;
    port: number;
    database: string;
    username: string;
    verified: boolean;
  };
  ports: {
    web: number;
    api: number;
    verified: boolean;
  };
  git: {
    projectInitialized: boolean;
    projectRemote?: string;
    tiersInitialized: string[];
  };
  environment: string;
}

export interface PreflightErrorSummary {
  code: string;
  message: string;
  checkId: string;
  recoverable: boolean;
  suggestedFix?: string;
}

export interface PreflightWarningSummary {
  code: string;
  message: string;
  checkId: string;
  suggestion?: string;
}

export interface PreflightConfigResponse {
  exists: boolean;
  config?: PreflightConfigSummary;
  configPath?: string;
  lastCheckedAt?: string;
  isStale?: boolean;
}

export interface PreflightNeededResponse {
  needed: boolean;
  reason: 'no_config' | 'config_stale' | 'not_needed';
  configAge?: number;
  maxAge?: number;
}

export interface PreflightDeployContextResponse {
  available: boolean;
  context?: {
    projectId: string;
    projectName: string;
    database: {
      host: string;
      port: number;
      database: string;
      username: string;
      connectionString: string;
    };
    ports: {
      web: number;
      api: number;
    };
    gitRemotes: Record<string, string>;
    environment: string;
    deployConfig?: {
      webBaseUrl?: string;
      apiBaseUrl?: string;
    };
  };
}

// ============================================================================
// Sessions API (Claude Code Session Files & Monitor)
// ============================================================================

export interface SessionsApi {
  /** Get currently monitored executions */
  getMonitoredExecutions(): Promise<ApiResponse<MonitoredExecutionsResponse>>;

  /** Get monitor summary */
  getMonitorSummary(): Promise<ApiResponse<MonitorSummaryResponse>>;

  /** Abort a monitored execution */
  abortExecution(executionId: string): Promise<ApiResponse<AbortExecutionResponse>>;

  /** Abort all monitored executions */
  abortAll(): Promise<ApiResponse<AbortAllResponse>>;

  // Session file operations (reads from ~/.claude/projects/)

  /** Read session data directly from session file */
  getSession(sessionId: string, options?: {
    cwd?: string;
    includeRawMessages?: boolean;
    /** Include read-only file operations in fileChanges (excluded by default) */
    includeReads?: boolean;
    // ─── Line Index Filters (JSONL file line number) ───
    /** Filter to include only items from this line index onwards */
    fromLineIndex?: number;
    /** Filter to include only items up to this line index */
    toLineIndex?: number;
    // ─── Turn Index Filters (conversation turn number) ───
    /** Filter to include only items from this turn index onwards */
    fromTurnIndex?: number;
    /** Filter to include only items up to this turn index */
    toTurnIndex?: number;
    // ─── User Prompt Index Filters (user message number) ───
    /** Filter to include only items from this user prompt index onwards (0-based) */
    fromUserPromptIndex?: number;
    /** Filter to include only items up to this user prompt index (0-based) */
    toUserPromptIndex?: number;
    /** @deprecated Use fromUserPromptIndex/toUserPromptIndex instead. Limit to last N user prompts */
    lastNUserPrompts?: number;
    /** Set to true to return all data without default limits */
    unlimited?: boolean;
    /** ISO timestamp — return notModified if session file unchanged since this time */
    ifModifiedSince?: string;
  }): Promise<ApiResponse<SessionDataResponse>>;

  /** List all sessions for the project */
  listSessions(cwd?: string, options?: { limit?: number }): Promise<ApiResponse<SessionListResponse>>;

  /** List all projects */
  listProjects(): Promise<ApiResponse<ProjectListResponse>>;

  /** Check if a session file exists */
  sessionExists(sessionId: string, cwd?: string): Promise<ApiResponse<{ exists: boolean }>>;

  // Conversation API (reads and formats Claude Code session messages)

  /**
   * Get conversation messages from a Claude Code session.
   * Returns user prompts and assistant responses in chronological order.
   */
  getConversation(options: GetConversationOptions): Promise<ApiResponse<ConversationResponse>>;

  /**
   * Get the last N messages from a Claude Code session.
   * Shorthand for getConversation with lastN option.
   */
  getLastMessages(sessionId: string, count: number, options?: {
    cwd?: string;
    toolDetail?: ToolDetailLevel;
  }): Promise<ApiResponse<ConversationResponse>>;

  /**
   * Get compact/continuation messages from a Claude Code session.
   * These are user messages created when context was compacted due to running out of context.
   * They contain a summary of the previous conversation.
   */
  getCompactMessages(sessionId: string, cwd?: string): Promise<ApiResponse<CompactMessagesResponse>>;

  /**
   * Get session messages starting from a specific line position.
   * Useful for retrieving messages after a compact/continuation point.
   */
  getMessagesFromPosition(sessionId: string, fromLineIndex: number, options?: {
    cwd?: string;
    includeRawMessages?: boolean;
    limit?: number;
  }): Promise<ApiResponse<PartialSessionResponse>>;

  /**
   * Check if a session has updates since last check.
   * Efficient polling endpoint - returns current line count and agent IDs.
   * Client compares with its cached values to detect changes.
   */
  checkSessionUpdate(sessionId: string, cwd?: string): Promise<ApiResponse<SessionUpdateCheckResponse>>;

  /**
   * Batch check multiple sessions for updates and optionally check if the session list changed.
   * Reduces HTTP overhead by combining multiple polling checks into a single request.
   */
  batchCheckSessions(request: BatchCheckRequest): Promise<ApiResponse<BatchCheckResponse>>;

  // Subagent API (reads from agent-*.jsonl files)

  /**
   * Get subagents for a session.
   * Returns both subagent invocations (from Task tool calls) and their session data.
   */
  getSessionSubagents(sessionId: string, cwd?: string): Promise<ApiResponse<SessionSubagentsResponse>>;

  /**
   * Get a specific subagent session's details.
   */
  getSubagentSession(sessionId: string, agentId: string, cwd?: string): Promise<ApiResponse<SubagentSessionResponse>>;

  /**
   * List all subagent files in the project.
   */
  listSubagentFiles(sessionId?: string, cwd?: string): Promise<ApiResponse<SubagentFilesListResponse>>;

  // Session Cache API

  /**
   * Get cache statistics including memory cache, disk cache, and watcher status.
   */
  getCacheStats(): Promise<ApiResponse<CacheStatsResponse>>;

  /**
   * Warm cache for a project by preloading all session and agent files.
   */
  warmProjectCache(projectPath: string): Promise<ApiResponse<CacheWarmResponse>>;

  /**
   * Clear cache for a specific session or all sessions.
   */
  clearCache(sessionPath?: string): Promise<ApiResponse<CacheClearResponse>>;

  /**
   * Compact the LMDB cache to reclaim disk space.
   */
  compactCache(): Promise<ApiResponse<{ message: string; beforeSize: number; afterSize: number; savedBytes: number }>>;

  /**
   * Start the file watcher for proactive cache updates.
   */
  startCacheWatcher(projectPaths?: string[]): Promise<ApiResponse<CacheWatcherResponse>>;

  /**
   * Stop the file watcher.
   */
  stopCacheWatcher(): Promise<ApiResponse<CacheWatcherResponse>>;

  /**
   * Start background warming of all sessions (most recent first, parallel).
   */
  startBackgroundWarming(options?: {
    concurrency?: number;        // parallel workers, default 5
    batchSize?: number;          // files per batch, default 50
    delayBetweenBatches?: number; // ms between batches, default 200
  }): Promise<ApiResponse<CacheWatcherResponse>>;

  /**
   * Stop background warming.
   */
  stopBackgroundWarming(): Promise<ApiResponse<CacheWatcherResponse>>;
}

export interface MonitoredExecutionResponse {
  executionId: string;
  sessionId: string;
  tier: string;
  status: string;
  isRunning: boolean;
  startTime: string;
  elapsedMs: number;
  turnCount: number;
  costUsd: number;
}

export interface MonitoredExecutionsResponse {
  executions: MonitoredExecutionResponse[];
  total: number;
}

export interface MonitorSummaryResponse {
  total: number;
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  byTier: Record<string, number>;
}

export interface AbortExecutionResponse {
  executionId: string;
  aborted: boolean;
}

export interface AbortAllResponse {
  abortedCount: number;
}

export interface SessionDataResponse {
  sessionId: string;
  cwd: string;
  /** Project path (derived from session file location) */
  projectPath?: string;
  model: string;
  claudeCodeVersion: string;
  permissionMode: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  result?: string;
  errors?: string[];
  success: boolean;
  /** Whether the session is still active/running */
  isActive?: boolean;
  /**
   * Session status:
   * - 'running': Actively running
   * - 'completed': Finished successfully
   * - 'error': Finished with errors
   * - 'interrupted': Session ended mid-conversation
   * - 'idle': Paused recently
   * - 'stale': Inactive for a while
   */
  status?: 'running' | 'completed' | 'error' | 'interrupted' | 'idle' | 'stale';
  /** Last activity timestamp */
  lastActivityAt?: string;
  /** User prompts (text messages from user) */
  userPrompts: Array<{
    turnIndex: number;
    text: string;
    timestamp?: string;
  }>;
  toolUses: Array<{
    id: string;
    name: string;
    input: unknown;
    turnIndex: number;
  }>;
  responses: Array<{ turnIndex: number; text: string }>;
  /** System prompt (if available) */
  systemPrompt?: string;
  /** File changes extracted from tool uses */
  fileChanges?: Array<{
    path: string;
    action: string;
    turnIndex?: number;
    toolName: string;
    remote?: string;
  }>;
  /** Database operations extracted from tool uses */
  dbOperations?: Array<{
    type: string;
    sql: string;
    tables: string[];
    turnIndex?: number;
  }>;
  /** Git operations extracted from tool uses */
  gitOperations?: Array<{
    type: string;
    command: string;
    files?: string[];
    branch?: string;
    commitMessage?: string;
    pr?: string;
    turnIndex?: number;
  }>;
}

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  filePath: string;
  size: number;
  createdAt: string;
  lastModified: string;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
  total: number;
}

export interface ProjectInfo {
  projectKey: string;
  projectPath: string;
  sessionCount: number;
  totalSize: number;
  lastModified: string;
}

export interface ProjectListResponse {
  projects: ProjectInfo[];
  total: number;
}

// ============================================================================
// Subagent Types
// ============================================================================

/** Subagent invocation from Task tool call */
export interface SubagentInvocationResponse {
  /** Agent ID (short hash) */
  agentId: string;
  /** Tool use ID that spawned this agent */
  toolUseId: string;
  /** Agent type (Explore, Plan, Bash, general-purpose, etc.) */
  type: string;
  /** Task prompt given to the agent */
  prompt: string;
  /** Optional description */
  description?: string;
  /** Model used */
  model?: string;
  // ─── Parent Session Indices ───
  /** Turn index where Task tool was called */
  turnIndex: number;
  /** Line index in JSONL file */
  lineIndex: number;
  /** User prompt index (0-based) - which user prompt triggered this subagent */
  userPromptIndex: number;
  // ─── Status ───
  /** Timestamp when agent was spawned */
  startedAt?: string;
  /** Timestamp when agent completed */
  completedAt?: string;
  /** Agent status */
  status: 'pending' | 'running' | 'completed' | 'error' | 'unknown';
  /** Result text (from tool_result) */
  result?: string;
  /** Whether agent ran in background */
  runInBackground?: boolean;
}

/** Full subagent session data */
export interface SubagentSessionResponse {
  /** Agent ID */
  agentId: string;
  /** Parent session ID */
  parentSessionId: string;
  /** Parent message UUID - links to specific message in parent session that spawned this subagent */
  parentUuid?: string;
  /** Working directory */
  cwd: string;
  /** Agent type */
  type: string;
  /** Task prompt */
  prompt: string;
  /** Status */
  status: 'pending' | 'running' | 'completed' | 'error' | 'unknown';
  /** Number of turns in agent session */
  numTurns: number;
  /** Model used */
  model?: string;
  /** Claude Code version */
  claudeCodeVersion?: string;
  /** File path to agent session file */
  filePath: string;
  /** Last activity timestamp */
  lastActivityAt?: string;
  /** Tool uses in agent session */
  toolUses: Array<{
    id: string;
    name: string;
    input?: unknown;
    turnIndex: number;
    lineIndex: number;
  }>;
  /** Text responses from agent */
  responses: Array<{
    turnIndex: number;
    lineIndex: number;
    text: string;
  }>;
  /** Token usage */
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
    contentBlocks?: unknown[];
  }>;
}

/** Response for getSessionSubagents */
export interface SessionSubagentsResponse {
  sessionId: string;
  invocations: SubagentInvocationResponse[];
  sessions: SubagentSessionResponse[];
  totalInvocations: number;
  totalSessions: number;
}

/** Subagent file metadata */
export interface SubagentFileInfo {
  agentId: string;
  filePath: string;
  size: number;
  lastModified: string;
}

/** Response for listSubagentFiles */
export interface SubagentFilesListResponse {
  files: SubagentFileInfo[];
  total: number;
}

// ============================================================================
// Session Cache Types
// ============================================================================

/** Response for getCacheStats */
export interface CacheStatsResponse {
  /** Number of sessions in cache */
  memoryCacheSize: number;
  /** Number of raw message caches */
  rawMemoryCacheSize: number;
  /** Whether file watcher is active */
  isWatching: boolean;
  /** Paths being watched */
  watchedPaths: string[];
  /** Number of pending cache updates */
  pendingUpdates: number;
  /** Number of cache entries (LMDB) */
  diskCacheCount: number;
  /** Approximate size of cache on disk (0 for LMDB — managed via mmap) */
  diskCacheSize: number;
  /** LMDB store statistics */
  lmdb?: {
    /** Number of session entries in LMDB */
    sessionCount: number;
    /** Number of raw message entries in LMDB */
    rawCount: number;
  };
}

/** Response for warmProjectCache */
export interface CacheWarmResponse {
  /** Project path that was warmed */
  projectPath: string;
  /** Number of sessions successfully warmed */
  warmed: number;
  /** Number of errors during warming */
  errors: number;
  /** Current cache stats */
  stats: CacheStatsResponse;
}

/** Response for clearCache */
export interface CacheClearResponse {
  /** Description of what was cleared */
  message: string;
  /** Current cache stats */
  stats: CacheStatsResponse;
}

/** Response for startCacheWatcher/stopCacheWatcher */
export interface CacheWatcherResponse {
  /** Operation result message */
  message: string;
  /** Current cache stats */
  stats: CacheStatsResponse;
}

// ============================================================================
// Conversation Types
// ============================================================================

/**
 * Level of detail for tool information in conversation
 */
export type ToolDetailLevel = 'none' | 'summary' | 'full';

/**
 * A message in the conversation (user or assistant)
 */
export interface ConversationMessage {
  /** Message role */
  role: 'user' | 'assistant';
  /** Turn index (1-based) */
  turnIndex: number;
  /** Message content (text) */
  content: string;
  /** Timestamp when message was sent */
  timestamp?: string;
  /** Tool calls made by assistant (only for assistant messages) */
  toolCalls?: ConversationToolCall[];
  /** Token usage for this message (only for assistant messages) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Tool call information based on detail level
 */
export interface ConversationToolCall {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input (only if detail level is 'full') */
  input?: unknown;
  /** Tool result summary (only if detail level is 'summary' or 'full') */
  resultSummary?: string;
  /** Full tool result (only if detail level is 'full') */
  result?: string;
  /** Whether tool call resulted in error */
  isError?: boolean;
}

/**
 * Options for getting conversation
 */
export interface GetConversationOptions {
  /** Claude Code session ID */
  sessionId: string;
  /** Working directory (defaults to project path) */
  cwd?: string;
  /** Level of detail for tool information */
  toolDetail?: ToolDetailLevel;
  /** Get only last N messages (0 = all) */
  lastN?: number;
  /** Get messages BEFORE this line index (for "load older" pagination) */
  beforeLine?: number;
  /** Include system prompt at the beginning */
  includeSystemPrompt?: boolean;
  /** Filter to include only messages from this turn index onwards */
  fromTurnIndex?: number;
  /** Filter to include only messages up to this turn index */
  toTurnIndex?: number;
}

/**
 * Response for getting conversation
 */
export interface ConversationResponse {
  /** Session ID */
  sessionId: string;
  /** Total number of messages in conversation */
  totalMessages: number;
  /** Number of messages returned */
  returnedMessages: number;
  /** The conversation messages */
  messages: ConversationMessage[];
  /** System prompt (if requested and available) */
  systemPrompt?: string;
  /** Model used */
  model?: string;
  /** Total cost for the session */
  totalCostUsd: number;
}

/**
 * A compact/continuation message from context compaction.
 * Created when a session runs out of context and is continued with a summary.
 */
export interface CompactMessage {
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
   */
  compactOrder: number;
}

/**
 * Response for getting compact/continuation messages
 */
export interface CompactMessagesResponse {
  /** Session ID */
  sessionId: string;
  /** Compact messages found in the session */
  compactMessages: CompactMessage[];
  /** Total number of compact messages */
  total: number;
}

/**
 * Response for getting partial session data from a position
 */
export interface PartialSessionResponse {
  /** Session ID */
  sessionId: string;
  /** The line index we started from */
  fromLineIndex: number;
  /** Model used */
  model: string;
  /** Claude Code version */
  claudeCodeVersion: string;
  /** Number of turns in this partial data */
  numTurns: number;
  /** Total cost (USD) for this portion */
  totalCostUsd: number;
  /** Token usage for this portion */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  /** Final result text (if session completed in this portion) */
  result?: string;
  /** Error messages (if session failed in this portion) */
  errors?: string[];
  /** Success status */
  success: boolean;
  /** Whether the session is still active */
  isActive: boolean;
  /** Session status */
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'idle' | 'stale';
  /** Last activity timestamp */
  lastActivityAt?: Date;
  /** User prompts in this portion */
  userPrompts: Array<{ turnIndex: number; lineIndex: number; text: string; timestamp?: string }>;
  /** Tool uses in this portion */
  toolUses: Array<{ id: string; name: string; input: unknown; turnIndex: number; lineIndex: number }>;
  /** Responses in this portion */
  responses: Array<{ turnIndex: number; lineIndex: number; text: string }>;
  /** File changes in this portion */
  fileChanges?: Array<{ path: string; action: string; turnIndex: number; lineIndex: number; toolName: string }>;
  /** Database operations in this portion */
  dbOperations?: Array<{ type: string; command: string; turnIndex: number; lineIndex: number }>;
  /** Git operations in this portion */
  gitOperations?: Array<{ type: string; command: string; turnIndex: number; lineIndex: number }>;
  /** Todos in this portion */
  todos?: Array<{ content: string; status: string; activeForm: string; lineIndex: number }>;
  /** Tasks in this portion */
  tasks?: Array<{ id: string; subject: string; status: string; turnIndex: number; lineIndex: number }>;
  /** Thinking blocks in this portion */
  thinkingBlocks?: Array<{ turnIndex: number; lineIndex: number; thinking: string }>;
}

/**
 * Response for checking if a session has updates
 * Used for efficient polling - client compares with cached values
 */
export interface SessionUpdateCheckResponse {
  /** Session ID */
  sessionId: string;
  /** Whether the session file exists */
  exists: boolean;
  /** Current number of lines in the session file */
  lineCount: number;
  /** List of subagent IDs associated with this session */
  agentIds: string[];
  /** Last modification time of the session file (ISO string) */
  lastModified: string;
}

// ── Batch Check Types ──

export interface BatchCheckRequest {
  sessions?: Array<{
    sessionId: string;
    knownFileSize?: number;
    knownAgentCount?: number;
  }>;
  listCheck?: {
    projectPath?: string;
    knownSessionCount?: number;
    knownLatestModified?: string;
  };
}

export interface BatchCheckSessionResult {
  exists: boolean;
  lineCount: number;
  fileSize: number;
  agentIds: string[];
  lastModified: string;
  changed: boolean;
  agentsChanged: boolean;
}

export interface BatchCheckListSession {
  sessionId: string;
  projectPath: string;
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
  teamName?: string;
  allTeams?: string[];
  forkedFromSessionId?: string;
}

export interface BatchCheckListStatus {
  totalSessions: number;
  latestModified: string;
  changed: boolean;
  sessions?: BatchCheckListSession[];
}

export interface BatchCheckResponse {
  sessions: Record<string, BatchCheckSessionResult>;
  listStatus?: BatchCheckListStatus;
}

// ============================================================================
// Session Backup API (GitHub-based backup/restore)
// ============================================================================

// Stub types for session backup (not included in lm-assist)
export interface BackupJobStatus { jobId: string; type: string; status: string; }
export interface BackupResult { success: boolean; }
export interface RestoreResult { success: boolean; }
export interface BackedUpSession { sessionId: string; projectPath: string; }
export interface BackupConfig { repoUrl: string; branchStrategy: string; }

export interface SessionBackupApi {
  /** Start async backup job */
  backup(options: SessionBackupRequest): Promise<ApiResponse<SessionBackupJobResponse>>;

  /** Start async restore job */
  restore(options: SessionRestoreRequest): Promise<ApiResponse<SessionBackupJobResponse>>;

  /** Get job status by ID */
  getJobStatus(jobId: string): Promise<ApiResponse<BackupJobStatus>>;

  /** List all backup/restore jobs */
  listJobs(options?: ListJobsOptions): Promise<ApiResponse<ListJobsResponse>>;

  /** List backed up sessions */
  listBackups(options?: ListBackupsOptions): Promise<ApiResponse<ListBackupsResponse>>;

  /** List available branches (hosts) */
  listBranches(): Promise<ApiResponse<ListBranchesResponse>>;

  /** Initialize the backup service */
  initialize(): Promise<ApiResponse<InitializeBackupResponse>>;

  /** Get backup service status */
  getStatus(): Promise<ApiResponse<BackupServiceStatusResponse>>;

  /** Get backup configuration */
  getConfig(): Promise<ApiResponse<BackupConfigResponse>>;

  /** Update backup configuration */
  updateConfig(config: Partial<BackupConfig>): Promise<ApiResponse<BackupConfigResponse>>;

  /** Start async backup of all sessions */
  backupAll(options?: BackupAllRequest): Promise<ApiResponse<BackupAllStatus>>;

  /** Get backup-all progress status */
  getBackupAllStatus(): Promise<ApiResponse<BackupAllStatus>>;
}

export interface BackupAllRequest {
  force?: boolean;
  limit?: number;
}

export interface BackupAllStatus {
  isRunning: boolean;
  startedAt?: string;
  totalProjects: number;
  processedProjects: number;
  totalSessions: number;
  backed: number;
  skipped: number;
  errors: number;
  percentComplete: number;
  currentProject?: string;
  currentSession?: string;
  estimatedTimeRemainingMs?: number;
  lastError?: string;
}

export interface SessionBackupRequest {
  sessionId: string;
  projectPath: string;
  force?: boolean;
}

export interface SessionRestoreRequest {
  sessionId: string;
  targetProjectPath?: string;
  branch?: string;
}

export interface SessionBackupJobResponse {
  jobId: string;
  type: 'backup' | 'restore';
  status: 'pending' | 'running';
  sessionId: string;
  projectPath: string;
}

export interface ListJobsOptions {
  type?: 'backup' | 'restore';
  status?: 'pending' | 'running' | 'completed' | 'failed';
}

export interface ListJobsResponse {
  jobs: BackupJobStatus[];
  total: number;
}

export interface ListBackupsOptions {
  branch?: string;
  limit?: number;
}

export interface ListBackupsResponse {
  backups: BackedUpSession[];
  total: number;
  branch: string;
}

export interface ListBranchesResponse {
  branches: string[];
  currentBranch: string;
}

export interface InitializeBackupResponse {
  initialized: boolean;
  branch: string;
  workDir: string;
}

export interface BackupServiceStatusResponse {
  initialized: boolean;
  repoUrl: string;
  branch: string;
  workDir: string;
  activeJobs: number;
}

export interface BackupConfigResponse {
  repoUrl: string;
  branch: string;
  branchStrategy: 'host' | 'single';
  workDir: string;
}

// ============================================================================
// Claude Code Tasks API (reads/writes ~/.claude/tasks/)
// ============================================================================

import type {
  Task,
  TaskList,
  TaskListSummary,
  CreateTaskInput,
  UpdateTaskInput,
} from '../tasks-service';

export { Task, TaskList, TaskListSummary, CreateTaskInput, UpdateTaskInput };

export interface TasksApi {
  /** List all task lists */
  listTaskLists(): Promise<ApiResponse<ClaudeTaskListsResponse>>;

  /** Get all tasks in a task list */
  getTaskList(listId: string): Promise<ApiResponse<ClaudeTaskListResponse>>;

  /** Get a single task */
  getTask(listId: string, taskId: string): Promise<ApiResponse<ClaudeTaskResponse>>;

  /** Create a new task list */
  createTaskList(listId: string): Promise<ApiResponse<CreateTaskListResponse>>;

  /** Create a new task */
  createTask(listId: string, input: CreateTaskInput): Promise<ApiResponse<ClaudeTaskResponse>>;

  /** Update a task */
  updateTask(listId: string, taskId: string, input: UpdateTaskInput): Promise<ApiResponse<ClaudeTaskResponse>>;

  /** Delete a task */
  deleteTask(listId: string, taskId: string): Promise<ApiResponse<DeleteTaskResponse>>;

  /** Delete a task list */
  deleteTaskList(listId: string): Promise<ApiResponse<DeleteTaskListResponse>>;

  /** Get ready tasks (not blocked) */
  getReadyTasks(listId: string): Promise<ApiResponse<ClaudeReadyTasksResponse>>;

  /** Get dependency graph */
  getDependencyGraph(listId: string): Promise<ApiResponse<ClaudeDependencyGraphResponse>>;
}

export interface ClaudeTaskListsResponse {
  taskLists: TaskListSummary[];
  total: number;
  tasksDir: string;
}

export interface ClaudeTaskListResponse {
  taskList: TaskList;
}

export interface ClaudeTaskResponse {
  task: Task;
}

export interface CreateTaskListResponse {
  listId: string;
  created: boolean;
  path: string;
}

export interface DeleteTaskResponse {
  listId: string;
  taskId: string;
  deleted: boolean;
}

export interface DeleteTaskListResponse {
  listId: string;
  deleted: boolean;
}

export interface ClaudeReadyTasksResponse {
  listId: string;
  readyTasks: Task[];
  total: number;
}

export interface ClaudeDependencyGraphResponse {
  listId: string;
  nodes: Array<{ id: string; subject: string; status: string }>;
  edges: Array<{ from: string; to: string }>;
}

// ============================================================================
// Extended Combined API Interface
// ============================================================================

export interface TierControlApiExtended extends TierControlApi {
  sessions: SessionsApi;
  claudeTasks: TasksApi;
}
