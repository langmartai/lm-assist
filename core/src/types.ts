/**
 * Claude CLI Manager Type Definitions
 */

// ============================================================================
// CLI Execution Types
// ============================================================================

export interface ClaudeCliOptions {
  /** Working directory for the CLI */
  cwd: string;
  /** Session ID to create or resume */
  sessionId?: string;
  /** Resume existing session */
  resume?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
  /** Output format: text, json, stream-json */
  outputFormat?: 'text' | 'json' | 'stream-json';
  /** Allowed tools */
  allowedTools?: string[];
  /** Timeout in milliseconds */
  timeout?: number;
  /** Debug categories */
  debug?: string;
  /** Model to use (e.g., 'haiku', 'sonnet', 'opus', or full model ID) */
  model?: string;
  /** Environment variables to pass to the CLI subprocess */
  env?: Record<string, string | undefined>;
}

export interface ClaudeCliResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** The text result */
  result: string;
  /** Session ID used */
  sessionId: string;
  /** Execution duration in ms */
  durationMs: number;
  /** API call duration in ms */
  durationApiMs: number;
  /** Number of turns */
  numTurns: number;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Token usage */
  usage: TokenUsage;
  /** Model usage breakdown */
  modelUsage: Record<string, ModelUsage>;
  /** Error if failed */
  error?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation?: {
    ephemeral5mInputTokens: number;
    ephemeral1hInputTokens: number;
  };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ClaudeCliStreamEvent {
  type: 'system' | 'assistant' | 'result';
  subtype?: string;
  data: SystemInitEvent | AssistantMessageEvent | ResultEvent;
}

export interface SystemInitEvent {
  cwd: string;
  sessionId: string;
  tools: string[];
  mcpServers: string[];
  model: string;
  permissionMode: string;
  slashCommands: string[];
  claudeCodeVersion: string;
  outputStyle: string;
  agents: string[];
  plugins: PluginInfo[];
}

export interface PluginInfo {
  name: string;
  path: string;
}

export interface AssistantMessageEvent {
  model: string;
  id: string;
  content: ContentBlock[];
  usage: TokenUsage;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ResultEvent {
  success: boolean;
  isError: boolean;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  result: string;
  sessionId: string;
  totalCostUsd: number;
  usage: TokenUsage;
  modelUsage: Record<string, ModelUsage>;
}

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  /** Session UUID */
  id: string;
  /** Project path */
  projectPath: string;
  /** Session file path */
  filePath: string;
  /** Session name (if named) */
  name?: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
  /** Number of messages */
  messageCount: number;
  /** Total tokens used */
  totalTokens: number;
  /** Estimated cost */
  estimatedCost: number;
  /** Summary text */
  summary?: string;
}

export interface SessionMessage {
  /** Message UUID */
  uuid: string;
  /** Parent message UUID */
  parentUuid?: string;
  /** Message type */
  type: 'user' | 'assistant' | 'tool_result' | 'summary';
  /** Timestamp */
  timestamp: Date;
  /** Message content */
  content: string | ContentBlock[];
  /** Token usage (for assistant messages) */
  usage?: TokenUsage;
  /** Tool use details */
  toolUse?: ToolUseInfo;
}

export interface ToolUseInfo {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface SessionFilter {
  /** Filter by project path */
  projectPath?: string;
  /** Filter by date range */
  fromDate?: Date;
  toDate?: Date;
  /** Filter by minimum message count */
  minMessages?: number;
  /** Search in summary */
  searchTerm?: string;
}

// ============================================================================
// Project Types
// ============================================================================

export interface Project {
  /** Absolute path to project */
  path: string;
  /** Encoded path for storage */
  encodedPath: string;
  /** Whether CLAUDE.md exists */
  hasClaudeMd: boolean;
  /** CLAUDE.md size in bytes */
  claudeMdSize?: number;
  /** Estimated CLAUDE.md tokens */
  claudeMdTokens?: number;
  /** Session count */
  sessionCount: number;
  /** Last activity */
  lastActivity?: Date;
  /** Total storage size in bytes */
  storageSize?: number;
  /** Last user message from most recent session */
  lastUserMessage?: string;
}

export interface ProjectConfig {
  /** Project path */
  path: string;
  /** Custom CLAUDE.md content */
  claudeMdContent?: string;
  /** Output style override */
  outputStyle?: string;
  /** Default allowed tools */
  defaultAllowedTools?: string[];
}

// ============================================================================
// CLAUDE.md Types
// ============================================================================

export interface ClaudeMdInfo {
  /** File path */
  path: string;
  /** Whether file exists */
  exists: boolean;
  /** File size in bytes */
  sizeBytes: number;
  /** Word count */
  wordCount: number;
  /** Estimated token count */
  estimatedTokens: number;
  /** Last modified */
  lastModified?: Date;
  /** Sections found */
  sections: ClaudeMdSection[];
}

export interface ClaudeMdSection {
  /** Section heading */
  title: string;
  /** Heading level (1-6) */
  level: number;
  /** Start line number */
  startLine: number;
  /** End line number */
  endLine: number;
  /** Content length in chars */
  contentLength: number;
  /** Estimated tokens */
  estimatedTokens: number;
}

export interface ClaudeMdTemplate {
  /** Template name */
  name: string;
  /** Template description */
  description: string;
  /** Template content */
  content: string;
  /** Estimated tokens */
  estimatedTokens: number;
}

// ============================================================================
// Cost Calculator Types
// ============================================================================

export interface ModelPricing {
  /** Model identifier pattern */
  modelPattern: string;
  /** Display name */
  displayName: string;
  /** Input token price per 1M */
  inputPricePerMillion: number;
  /** Output token price per 1M */
  outputPricePerMillion: number;
  /** 5-minute cache write price per 1M */
  cache5mWritePricePerMillion: number;
  /** 1-hour cache write price per 1M */
  cache1hWritePricePerMillion: number;
  /** Cache read price per 1M */
  cacheReadPricePerMillion: number;
}

export interface CostEstimate {
  /** Input cost */
  inputCost: number;
  /** Output cost */
  outputCost: number;
  /** Cache write cost */
  cacheWriteCost: number;
  /** Cache read cost */
  cacheReadCost: number;
  /** Total cost */
  totalCost: number;
  /** Token breakdown */
  tokens: TokenUsage;
  /** Model used */
  model: string;
}

export interface UsageSummary {
  /** Period start */
  periodStart: Date;
  /** Period end */
  periodEnd: Date;
  /** Total messages */
  totalMessages: number;
  /** Total tokens */
  totalTokens: number;
  /** Total cost */
  totalCost: number;
  /** Cost by model */
  costByModel: Record<string, number>;
  /** Cost by day */
  costByDay: Record<string, number>;
  /** Top sessions by cost */
  topSessions: Array<{ sessionId: string; cost: number }>;
}

// ============================================================================
// Migration Types
// ============================================================================

export interface MigrationTarget {
  /** Target hostname or IP */
  host: string;
  /** SSH port */
  port: number;
  /** SSH username */
  username: string;
  /** SSH private key path */
  privateKeyPath?: string;
  /** SSH password (not recommended) */
  password?: string;
  /** Remote home directory */
  remoteHomeDir: string;
  /** Remote project path */
  remoteProjectPath: string;
}

export interface MigrationOptions {
  /** Session IDs to migrate */
  sessionIds: string[];
  /** Source project path */
  sourceProjectPath: string;
  /** Target configuration */
  target: MigrationTarget;
  /** Transform paths (e.g., /home/ubuntu -> /home/opc) */
  pathTransforms: Array<{ from: string; to: string }>;
  /** Verify after migration */
  verify: boolean;
}

export interface MigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** Sessions migrated */
  migratedSessions: string[];
  /** Sessions that failed */
  failedSessions: Array<{ sessionId: string; error: string }>;
  /** Verification results */
  verification?: {
    passed: boolean;
    details: string;
  };
}

// ============================================================================
// Manager Configuration
// ============================================================================

export interface ClaudeCliManagerConfig {
  /** Claude config directory (default: ~/.claude) */
  claudeConfigDir?: string;
  /** Default timeout for CLI calls */
  defaultTimeout?: number;
  /** Default model for cost calculation */
  defaultModel?: string;
  /** Custom model pricing */
  customPricing?: ModelPricing[];
  /** SSH config for remote operations */
  sshConfig?: {
    privateKeyPath?: string;
    knownHostsPath?: string;
  };
}

// ============================================================================
// Tier Agent Types
// ============================================================================

/**
 * Type of tier: implementation (code) or document (markdown)
 */
export type TierType = 'implementation' | 'document';

export interface TierConfig {
  /** Tier name (e.g., 'web', 'api', 'database', 'spec', 'task') */
  tierName: string;
  /** Project root path */
  projectPath: string;
  /** Tier folder path relative to project (default: tierName) */
  tierPath?: string;
  /** Existing session ID to resume */
  sessionId?: string;
  /** Paths with write access (relative to tier folder) */
  writePaths: string[];
  /** Paths with read-only access (absolute or relative to project) */
  readOnlyPaths?: string[];
  /** Allowed bash command patterns */
  allowedBashPatterns?: string[];
  /** Disallowed bash command patterns */
  disallowedBashPatterns?: string[];
  /** Tier-specific instructions (included in prompt) */
  tierInstructions?: string;
  /**
   * Dynamic system prompt append (added to SDK systemPrompt.append)
   * Use for runtime context that shouldn't be in CLAUDE.md
   * Example: "You are the WEB tier agent. Focus on React components."
   */
  systemPromptAppend?: string;
  /** Timeout for CLI execution */
  timeout?: number;

  // ========== New Fields for Document Tiers ==========

  /**
   * Tier type: 'implementation' for code-producing tiers, 'document' for markdown-based tiers
   * @default 'implementation'
   */
  tierType?: TierType;

  /**
   * Document formats supported (for document tiers)
   * @default ['md']
   */
  documentFormats?: string[];

  /**
   * Index file path (for document tiers)
   * @example 'spec/README.md'
   */
  indexFile?: string;

  /**
   * Template paths for document creation (for document tiers)
   * @example { feature: 'templates/feature-spec.md', adr: 'templates/adr.md' }
   */
  documentTemplates?: Record<string, string>;

  /**
   * Archive configuration (for task tier)
   */
  archiveConfig?: {
    /** Enable automatic archiving */
    enabled: boolean;
    /** Archive completed tasks after N days */
    afterDays: number;
    /** Archive directory relative to tier path */
    archiveDir: string;
  };
}

export interface TierAgentResult {
  /** Tier name */
  tierName: string;
  /** Session ID used */
  sessionId: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Result text */
  result: string;
  /** Error if failed */
  error?: string;
  /** Token usage */
  usage: TokenUsage;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Duration in ms */
  durationMs: number;
  /** Timestamp */
  timestamp: Date;
  /** Whether the response format was valid (##CMD:RESULT present) */
  formatValid?: boolean;
  /** Number of recovery attempts made */
  recoveryAttempts?: number;
  /** Parsed commands from the response */
  parsedCommands?: import('./types/orchestrator-commands').ProtocolCommand[];
}

// ============================================================================
// Tier Manager Types
// ============================================================================

/**
 * Git commit configuration for orchestrator
 */
export interface GitCommitConfig {
  /** Enable auto-commit after successful execution */
  enabled: boolean;
  /** Auto-push after commit */
  autoPush?: boolean;
  /** Remote name for push (default: origin) */
  remote?: string;
  /** Co-author for commits */
  coAuthor?: string;
  /** Commit message prefix */
  commitPrefix?: string;
  /** Only commit specific tiers (default: all with changes) */
  tiers?: string[];
  /** Create combined commit vs per-tier commits */
  combinedCommit?: boolean;
}

/**
 * Workflow configuration for spec-first development
 */
export interface WorkflowConfig {
  /**
   * Always route new feature requests to spec tier first
   * @default true
   */
  specFirst: boolean;

  /**
   * Automatically create tasks after spec is created/updated
   * @default true
   */
  autoCreateTasks: boolean;

  /**
   * Require user approval of spec before creating tasks
   * @default false
   */
  requireSpecApproval: boolean;

  /**
   * Automatically archive completed tasks
   * @default true
   */
  archiveCompletedTasks: boolean;

  /**
   * Sync specs with implementation feedback after task completion
   * @default true
   */
  syncSpecsOnCompletion: boolean;

  /**
   * Verify acceptance criteria after each task
   * @default true
   */
  verifyAcceptanceCriteria: boolean;

  /**
   * Record deviations from spec during implementation
   * @default true
   */
  recordDeviations: boolean;
}

/**
 * Default workflow configuration
 */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  specFirst: true,
  autoCreateTasks: true,
  requireSpecApproval: false,
  archiveCompletedTasks: true,
  syncSpecsOnCompletion: true,
  verifyAcceptanceCriteria: true,
  recordDeviations: true,
};

export interface TierManagerConfig {
  /** Project path */
  projectPath: string;
  /** Manager session ID */
  sessionId?: string;
  /** Custom tier configurations (optional - uses defaults if not provided) */
  tierAgents?: TierConfig[];
  /** Manager timeout */
  timeout?: number;
  /** Git commit configuration */
  gitCommit?: GitCommitConfig;

  // ========== New Workflow Configuration ==========

  /**
   * Workflow configuration for spec-first development
   * Controls how spec and task tiers integrate with implementation tiers
   */
  workflow?: Partial<WorkflowConfig>;

  /**
   * Enable spec tier
   * @default true if spec folder exists
   */
  enableSpecTier?: boolean;

  /**
   * Enable task tier
   * @default true if task folder exists
   */
  enableTaskTier?: boolean;
}

/**
 * Git commit result for a single tier
 */
export interface TierGitCommitResult {
  /** Tier name */
  tier: string;
  /** Whether commit succeeded */
  success: boolean;
  /** Commit hash (if successful) */
  commitHash?: string;
  /** Error message (if failed) */
  error?: string;
  /** Files committed */
  filesCommitted?: string[];
  /** Whether push succeeded */
  pushSuccess?: boolean;
  /** Push error (if failed) */
  pushError?: string;
}

/**
 * Overall git commit result
 */
export interface GitCommitResult {
  /** Whether any commits were made */
  committed: boolean;
  /** Individual tier commit results */
  tierCommits: TierGitCommitResult[];
  /** Total files committed */
  totalFilesCommitted: number;
  /** Total lines added */
  totalLinesAdded: number;
  /** Total lines removed */
  totalLinesRemoved: number;
  /** Errors encountered */
  errors: string[];
}

export interface TierManagerResult {
  /** Unique request ID */
  requestId: string;
  /** Original user prompt */
  userPrompt: string;
  /** Task breakdown analysis */
  taskBreakdown: TaskBreakdown | null;
  /** Results from each tier */
  tierResults: TierAgentResult[];
  /** Final evaluation */
  finalEvaluation: string | null;
  /** Overall success */
  success: boolean;
  /** Total duration in ms */
  totalDurationMs: number;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Timestamp */
  timestamp: Date;
  /** Git commit result (if auto-commit enabled) */
  gitCommitResult?: GitCommitResult;
}

export interface TaskBreakdown {
  /** Whether breakdown succeeded */
  success: boolean;
  /** Original user prompt */
  originalPrompt: string;
  /** Reasoning for the breakdown */
  reasoning: string;
  /** Tasks for each tier */
  tasks: TierTask[];
  /** Error if failed */
  error?: string;
}

export interface TierTask {
  /** Target tier name */
  tierName: string;
  /** Task priority (lower = earlier) */
  priority: number;
  /** Prompt for this tier */
  prompt: string;
  /** Dependencies on other tiers */
  dependencies: string[];
}

export interface SessionInfo {
  /** Session ID */
  id: string;
  /** Project path */
  projectPath: string;
  /** Message count */
  messageCount: number;
  /** Estimated cost */
  estimatedCost: number;
  /** Created at */
  createdAt: Date;
  /** Updated at */
  updatedAt: Date;
}

// ============================================================================
// Orchestrator Request Workflow Types
// ============================================================================

/**
 * Status of an orchestrator request
 */
export type OrchestratorRequestStatus =
  | 'pending'      // Queued, waiting to start
  | 'analyzing'    // Breaking down into tier tasks
  | 'executing'    // Tier agents are processing
  | 'evaluating'   // Evaluating tier results
  | 'committing'   // Git commit in progress
  | 'completed'    // Successfully finished
  | 'failed'       // Failed with error
  | 'interrupted'  // Interrupted by new request
  | 'supplemented'; // Merged into another request

/**
 * Action to take when a new request arrives while one is running
 */
export type NewRequestAction =
  | 'interrupt'    // Cancel current, start new
  | 'supplement'   // Merge new prompt into current task
  | 'queue'        // Queue new request (wait for current to finish)
  | 'reject';      // Reject new request

/**
 * Running request state
 */
export interface OrchestratorRequestState {
  /** Request ID */
  requestId: string;
  /** Original user prompt */
  prompt: string;
  /** Current status */
  status: OrchestratorRequestStatus;
  /** Started at */
  startedAt: Date;
  /** Current tier being executed */
  currentTier?: string;
  /** Current task index */
  currentTaskIndex?: number;
  /** Total tasks */
  totalTasks?: number;
  /** Completed tier results so far */
  completedTierResults: TierAgentResult[];
  /** Task breakdown (if available) */
  taskBreakdown?: TaskBreakdown;
  /** Supplementary prompts added */
  supplementaryPrompts: string[];
  /** Whether cancellation was requested */
  cancellationRequested: boolean;
  /** Error if failed */
  error?: string;
}

/**
 * Result of attempting to handle a new request
 */
export interface NewRequestHandlingResult {
  /** Action taken */
  action: NewRequestAction;
  /** New request ID (if started) */
  requestId?: string;
  /** Previous request ID (if interrupted/supplemented) */
  previousRequestId?: string;
  /** Message describing what happened */
  message: string;
  /** Whether the request was accepted */
  accepted: boolean;
}

/**
 * Supplement result
 */
export interface SupplementResult {
  /** Whether supplement was successful */
  success: boolean;
  /** Request ID that was supplemented */
  requestId: string;
  /** The supplementary prompt that was added */
  supplementPrompt: string;
  /** Message */
  message: string;
  /** New tasks added (if re-analyzed) */
  newTasks?: TierTask[];
}

/**
 * Interrupt result
 */
export interface InterruptResult {
  /** Whether interrupt was successful */
  success: boolean;
  /** Request ID that was interrupted */
  interruptedRequestId: string;
  /** Partial results from interrupted request */
  partialResults?: TierAgentResult[];
  /** New request ID that replaced it */
  newRequestId?: string;
  /** Message */
  message: string;
}

// ============================================================================
// Prompt Analysis Types
// ============================================================================

/**
 * Classification of relationship between new prompt and current task
 */
export type PromptRelationship =
  | 'new_task'        // Completely different task - should interrupt
  | 'cancel'          // User wants to cancel/stop current task
  | 'supplement'      // Adds requirements to current task
  | 'modify'          // Changes/corrects current task direction
  | 'clarify'         // Provides clarification for current task
  | 'status'          // Asking about current task status (no action needed)
  | 'unrelated';      // Unrelated query (e.g., general question)

/**
 * Result of analyzing prompt relationship
 */
export interface PromptAnalysisResult {
  /** Classified relationship */
  relationship: PromptRelationship;
  /** Recommended action */
  recommendedAction: NewRequestAction;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reasoning for the classification */
  reasoning: string;
  /** Keywords or phrases that led to this classification */
  indicators: string[];
}

/**
 * Options for submitting a prompt
 */
export interface SubmitPromptOptions {
  /** Force a specific action instead of auto-detecting */
  forceAction?: NewRequestAction;
  /** Skip LLM analysis and use keyword-based detection only */
  fastDetection?: boolean;
  /** Custom cancel keywords to detect */
  cancelKeywords?: string[];
  /** Custom supplement keywords to detect */
  supplementKeywords?: string[];
}

/**
 * Result of submitting a prompt
 */
export interface SubmitPromptResult {
  /** Whether the prompt was processed successfully */
  success: boolean;
  /** Action that was taken */
  action: NewRequestAction | 'start' | 'status';
  /** Analysis result (if performed) */
  analysis?: PromptAnalysisResult;
  /** Request ID (new or current) */
  requestId?: string;
  /** Message describing what happened */
  message: string;
  /** The promise for the request result (if a new request was started) */
  resultPromise?: Promise<TierManagerResult>;
}

// ============================================================================
// Multi-Repo Project Types
// ============================================================================

/**
 * Multi-repo project configuration
 * Supports separate GitHub repositories for each tier
 */
export interface MultiRepoProjectConfig {
  /** Project name (used in repo naming) */
  projectName: string;
  /** Unique project ID (used in repo naming) */
  projectId: string;
  /** Version */
  version: string;
  /** Tier repository configurations */
  tiers: Record<string, TierRepoConfig>;
  /** Orchestrator settings */
  orchestrator: OrchestratorConfig;

  // ========== New Fields ==========

  /**
   * Project template used
   */
  projectTemplate?: string;

  /**
   * Tier templates used
   */
  tierTemplates?: Record<string, string>;

  /**
   * Workflow configuration
   */
  workflow?: WorkflowConfig;
}

/**
 * Individual tier repository configuration
 */
export interface TierRepoConfig {
  /** Repository name (e.g., projectname_id_web) */
  repo: string;
  /** Local path relative to project root (e.g., ./web) */
  path: string;
  /** Selected framework (null if not chosen) */
  framework: string | null;
  /** Remote URL (for cloning) */
  remoteUrl?: string;
  /** Current branch */
  branch?: string;
}

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  /** Default model for orchestration */
  defaultModel: string;
  /** Default timeout in ms */
  timeout: number;
  /** Auto-approve inter-agent requests */
  autoApprove?: boolean;
}

/**
 * All tier names including document tiers
 */
export type AllTierName = 'web' | 'api' | 'database' | 'deploy' | 'spec' | 'task';

/**
 * Project initialization options
 */
export interface ProjectInitOptions {
  /** Project name */
  projectName: string;
  /** Project ID (generated if not provided) */
  projectId?: string;
  /** Parent directory to create project in */
  parentDir: string;
  /** GitHub organization or user (for repo URLs) */
  githubOrg?: string;
  /** Tiers to initialize (default: all including spec and task) */
  tiers?: AllTierName[];
  /** Initial frameworks/templates to set */
  frameworks?: {
    web?: string;
    api?: string;
    database?: string;
    deploy?: string;
  };
  /** Create GitHub repos automatically */
  createRepos?: boolean;

  // ========== New Template Options ==========

  /**
   * Project template to use
   * @example 'saas-starter', 'e-commerce', 'blank'
   */
  projectTemplate?: string;

  /**
   * Tier template selections
   */
  tierTemplates?: {
    spec?: string;      // 'default', 'detailed'
    task?: string;      // 'default', 'agile'
    web?: string;       // 'nextjs', 'react-vite', etc.
    api?: string;       // 'hono', 'express', etc.
    database?: string;  // 'postgresql', 'mongodb', etc.
    deploy?: string;    // 'docker-compose', 'kubernetes', etc.
  };

  /**
   * Component templates to include
   * @example ['auth', 'payments']
   */
  components?: string[];

  /**
   * Enable spec-first workflow
   * @default true
   */
  enableSpecFirst?: boolean;
}

/**
 * Result of project initialization
 */
export interface ProjectInitResult {
  /** Whether initialization succeeded */
  success: boolean;
  /** Created project path */
  projectPath: string;
  /** Project config */
  config: MultiRepoProjectConfig;
  /** Tier paths that were created */
  tierPaths: Record<string, string>;
  /** Git commands to run (if repos not auto-created) */
  gitCommands?: string[];
  /** Error if failed */
  error?: string;

  // ========== New Fields ==========

  /**
   * Templates applied
   */
  templatesApplied?: {
    project?: string;
    tiers: Record<string, string>;
    components?: string[];
  };

  /**
   * Pre-loaded spec documents (if template included them)
   */
  preloadedSpecs?: string[];

  /**
   * Pre-loaded tasks (if template included them)
   */
  preloadedTasks?: string[];

  /**
   * Next steps message for the user
   */
  nextSteps?: string;
}

/**
 * Tier checkout status (for verifying repo structure)
 */
export interface TierCheckoutStatus {
  /** Tier name */
  tier: string;
  /** Expected path */
  expectedPath: string;
  /** Whether tier folder exists */
  exists: boolean;
  /** Whether it's a git repo */
  isGitRepo: boolean;
  /** Current branch (if git repo) */
  branch?: string;
  /** Remote URL (if git repo) */
  remoteUrl?: string;
  /** Whether it has uncommitted changes */
  hasChanges?: boolean;
}
