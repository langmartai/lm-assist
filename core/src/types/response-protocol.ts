/**
 * Response Protocol Types
 *
 * Defines the structured response format returned from tier agents to orchestrator.
 * Supports success, partial, failure, and error states with detailed information.
 */

import type { TierName, ArtifactType, ErrorType, ImplementationTierName } from './instruction-protocol';
import type { SpecTierResult, SpecFeedback, SpecDeviation } from './spec-tier';
import type { TaskTierResult, TaskActualArtifact } from './task-tier';

// ============================================================================
// Response Status
// ============================================================================

export type ResponseStatus =
  | 'success'    // Task completed successfully
  | 'partial'    // Task partially completed (some criteria met)
  | 'failure'    // Task failed but recoverable
  | 'error'      // Unrecoverable error
  | 'blocked'    // Blocked by dependency
  | 'timeout'    // Timed out
  | 'cancelled'; // Cancelled by user/orchestrator

// ============================================================================
// Tier Agent Response Schema (Tier Agent -> Orchestrator)
// ============================================================================

/**
 * Complete response packet from tier agent to orchestrator
 */
export interface TierResponse {
  /** Response protocol version */
  protocolVersion: '1.0' | '1.1';

  /** Task ID this responds to */
  taskId: string;

  /** Parent request ID */
  requestId: string;

  /** Responding tier */
  tier: TierName;

  /** Overall status */
  status: ResponseStatus;

  /** Execution timing */
  timing: ResponseTiming;

  /** Structured result data */
  result: TaskResult;

  /** Artifacts created/modified */
  artifacts: Artifact[];

  /** Validation results */
  validation: ValidationResult;

  /** Error details (if status is not 'success') */
  error?: ErrorDetail;

  /** Suggestions for follow-up actions */
  followUp?: FollowUpSuggestion[];

  /** Resource usage */
  usage: ResourceUsage;

  // ========== Protocol 1.1 Fields ==========

  /**
   * Document outputs (for spec/task tiers)
   * @since 1.1
   */
  documents?: {
    created: string[];
    updated: string[];
    deleted: string[];
  };

  /**
   * Task references (for task tier operations)
   * @since 1.1
   */
  tasks?: {
    created: string[];
    completed: string[];
    blocked: string[];
  };

  /**
   * Feedback for spec synchronization (from implementation tiers)
   * @since 1.1
   */
  feedback?: TierFeedback;
}

/**
 * Feedback from implementation tiers for spec synchronization
 * @since Protocol 1.1
 */
export interface TierFeedback {
  /** Artifacts created/modified */
  artifacts: TaskActualArtifact[];

  /** Schemas for database tier */
  schemas?: {
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; nullable: boolean }>;
    }>;
  };

  /** Endpoints for API tier */
  endpoints?: Array<{
    method: string;
    path: string;
    handler: string;
    file: string;
  }>;

  /** Components for web tier */
  components?: Array<{
    name: string;
    path: string;
    props?: string[];
  }>;

  /** Deviations from spec */
  deviations?: SpecDeviation[];

  /** Evidence for acceptance criteria */
  criteriaEvidence?: Array<{
    criteriaId: string;
    specPath: string;
    evidence: string;
    status: 'verified' | 'failed' | 'partial';
  }>;
}

// ============================================================================
// Response Timing
// ============================================================================

export interface ResponseTiming {
  /** When execution started */
  startedAt: string; // ISO 8601

  /** When execution completed */
  completedAt: string; // ISO 8601

  /** Total duration in ms */
  durationMs: number;

  /** API call duration in ms */
  apiDurationMs: number;

  /** Number of LLM turns */
  turns: number;
}

// ============================================================================
// Task Result
// ============================================================================

export interface TaskResult {
  /** Brief summary of what was accomplished */
  summary: string;

  /** Detailed description of changes made */
  description: string;

  /** Reasoning/explanation (if requested) */
  reasoning?: string;

  /** Tier-specific result data */
  data: TierResultData;

  /** Criteria completion status */
  criteriaStatus: CriteriaStatus[];
}

// ============================================================================
// Tier-Specific Result Data
// ============================================================================

/** Union type for tier-specific result data */
export type TierResultData =
  | WebTierResult
  | ApiTierResult
  | DatabaseTierResult
  | DeployTierResult
  | SpecTierResult
  | TaskTierResult
  | GenericTierResult;

export interface GenericTierResult {
  tier: TierName;
  [key: string]: unknown;
}

export interface WebTierResult {
  tier: 'web';
  pages?: PageResult[];
  components?: ComponentResult[];
  routes?: RouteResult[];
  styles?: StyleResult[];
  hooks?: HookResult[];
}

export interface PageResult {
  name: string;
  path: string;
  route: string;
  props?: string[];
  dependencies?: string[];
}

export interface ComponentResult {
  name: string;
  path: string;
  type: 'functional' | 'class' | 'hoc' | 'wrapper';
  props?: PropDefinition[];
  exports?: string[];
}

export interface PropDefinition {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

export interface RouteResult {
  path: string;
  component: string;
  layout?: string;
  protected?: boolean;
}

export interface StyleResult {
  path: string;
  type: 'css' | 'scss' | 'module' | 'tailwind';
  classes?: string[];
}

export interface HookResult {
  name: string;
  path: string;
  params?: string[];
  returns?: string;
}

export interface ApiTierResult {
  tier: 'api';
  endpoints?: EndpointResult[];
  services?: ServiceResult[];
  middleware?: MiddlewareResult[];
  types?: TypeResult[];
  validationSchemas?: ValidationSchemaResult[];
}

export interface EndpointResult {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: string;
  file: string;
  auth?: {
    required: boolean;
    roles?: string[];
  };
  request?: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: string; // Type name
  };
  response?: {
    success: string; // Type name
    error?: string;
  };
}

export interface ServiceResult {
  name: string;
  path: string;
  methods: string[];
  dependencies?: string[];
}

export interface MiddlewareResult {
  name: string;
  path: string;
  appliedTo: string[]; // Route patterns
}

export interface TypeResult {
  name: string;
  path: string;
  kind: 'interface' | 'type' | 'enum' | 'class';
  exported: boolean;
}

export interface ValidationSchemaResult {
  name: string;
  path: string;
  library: 'zod' | 'yup' | 'joi' | 'custom';
}

export interface DatabaseTierResult {
  tier: 'database';
  schemas?: SchemaResult[];
  migrations?: MigrationResult[];
  seeds?: SeedResult[];
  functions?: FunctionResult[];
  indexes?: IndexResult[];
}

export interface SchemaResult {
  name: string;
  path: string;
  type: 'table' | 'view' | 'materialized_view';
  columns: ColumnDefinition[];
  constraints?: string[];
  indexes?: string[];
}

export interface ColumnDefinition {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey?: boolean;
  foreignKey?: {
    table: string;
    column: string;
  };
}

export interface MigrationResult {
  id: string;
  name: string;
  path: string;
  direction: 'up' | 'down' | 'both';
  description: string;
  breaking: boolean;
  dependencies?: string[]; // Other migration IDs
}

export interface SeedResult {
  name: string;
  path: string;
  table: string;
  rowCount: number;
}

export interface FunctionResult {
  name: string;
  path: string;
  type: 'function' | 'procedure' | 'trigger';
  params?: string[];
  returns?: string;
}

export interface IndexResult {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  type?: 'btree' | 'hash' | 'gin' | 'gist';
}

export interface DeployTierResult {
  tier: 'deploy';
  builds?: BuildResult[];
  deployments?: DeploymentResult[];
  migrationsExecuted?: MigrationExecutionResult[];
  cicd?: CICDResult[];
  infrastructure?: InfrastructureResult[];
}

export interface BuildResult {
  tier: TierName;
  output: string;
  size?: number;
  duration: number;
  success: boolean;
  warnings?: string[];
}

export interface DeploymentResult {
  tier: TierName;
  environment: string;
  version?: string;
  url?: string;
  success: boolean;
  timestamp: string;
}

export interface MigrationExecutionResult {
  migrationId: string;
  direction: 'up' | 'down';
  success: boolean;
  executedAt: string;
  duration: number;
}

export interface CICDResult {
  type: 'github_actions' | 'gitlab_ci' | 'jenkins' | 'custom';
  path: string;
  workflows: string[];
}

export interface InfrastructureResult {
  type: 'docker' | 'kubernetes' | 'terraform' | 'cloudformation';
  path: string;
  resources: string[];
}

// ============================================================================
// Criteria Status
// ============================================================================

export interface CriteriaStatus {
  /** Criterion description */
  criterion: string;

  /** Whether it was met */
  met: boolean;

  /** Details about how it was met or why not */
  details?: string;

  /** Evidence (e.g., file path, output) */
  evidence?: string;
}

// ============================================================================
// Artifacts
// ============================================================================

export interface Artifact {
  /** Unique artifact ID */
  id: string;

  /** Type of artifact */
  type: ArtifactType;

  /** Action taken */
  action: 'created' | 'modified' | 'deleted' | 'unchanged';

  /** File path (if applicable) */
  path?: string;

  /** Human-readable name */
  name: string;

  /** Description of the artifact */
  description: string;

  /** Content hash for change detection */
  contentHash?: string;

  /** Size in bytes (if applicable) */
  size?: number;

  /** Related artifacts */
  relatedTo?: string[]; // Artifact IDs

  /** Tier-specific artifact metadata */
  metadata?: ArtifactMetadata;
}

export type ArtifactMetadata =
  | ComponentArtifactMeta
  | EndpointArtifactMeta
  | SchemaArtifactMeta
  | MigrationArtifactMeta;

export interface ComponentArtifactMeta {
  kind: 'component';
  props?: string[];
  exports?: string[];
  dependencies?: string[];
}

export interface EndpointArtifactMeta {
  kind: 'endpoint';
  method: string;
  route: string;
  auth?: boolean;
}

export interface SchemaArtifactMeta {
  kind: 'schema';
  tableName: string;
  columns?: string[];
}

export interface MigrationArtifactMeta {
  kind: 'migration';
  migrationId: string;
  breaking: boolean;
}

// ============================================================================
// Validation Results
// ============================================================================

export interface ValidationResult {
  /** Overall validation passed */
  passed: boolean;

  /** Individual check results */
  checks: ValidationCheckResult[];

  /** Warnings (non-blocking issues) */
  warnings: ValidationWarning[];

  /** Suggestions for improvement */
  suggestions?: string[];
}

export interface ValidationCheckResult {
  /** Check name */
  name: string;

  /** Check type */
  type: 'typescript' | 'eslint' | 'test' | 'build' | 'schema' | 'custom';

  /** Whether check passed */
  passed: boolean;

  /** Error message if failed */
  error?: string;

  /** Output from check */
  output?: string;

  /** Whether this check was blocking */
  blocking: boolean;
}

export interface ValidationWarning {
  /** Warning code */
  code: string;

  /** Warning message */
  message: string;

  /** Affected file/line */
  location?: {
    file: string;
    line?: number;
    column?: number;
  };

  /** Severity */
  severity: 'info' | 'warning';
}

// ============================================================================
// Error Details
// ============================================================================

export type ErrorCode =
  | 'FILE_NOT_FOUND'
  | 'FILE_PERMISSION_DENIED'
  | 'SYNTAX_ERROR'
  | 'TYPE_ERROR'
  | 'IMPORT_ERROR'
  | 'DEPENDENCY_MISSING'
  | 'DEPENDENCY_VERSION_MISMATCH'
  | 'VALIDATION_FAILED'
  | 'BUILD_FAILED'
  | 'TEST_FAILED'
  | 'TIMEOUT'
  | 'RESOURCE_EXHAUSTED'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'CONFLICT'
  | 'CONSTRAINT_VIOLATION'
  | 'SCHEMA_MISMATCH'
  | 'MIGRATION_FAILED'
  | 'DEPLOYMENT_FAILED'
  | 'ROLLBACK_REQUIRED'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN_ERROR';

export interface ErrorDetail {
  /** Error code for programmatic handling */
  code: ErrorCode;

  /** Error type classification */
  type: ErrorType;

  /** Human-readable error message */
  message: string;

  /** Detailed explanation */
  details?: string;

  /** Stack trace (if applicable) */
  stack?: string;

  /** Whether this error is recoverable */
  recoverable: boolean;

  /** Recovery hints */
  recoveryHints?: RecoveryHint[];

  /** Related errors (for cascading failures) */
  causedBy?: ErrorDetail;

  /** Files involved in the error */
  affectedFiles?: string[];

  /** Retry information */
  retry?: RetryInfo;
}

export interface RecoveryHint {
  /** Description of what to try */
  action: string;

  /** Likelihood of success */
  likelihood: 'high' | 'medium' | 'low';

  /** Whether orchestrator can attempt automatically */
  automatable: boolean;

  /** Command or instruction to execute */
  instruction?: string;
}

export interface RetryInfo {
  /** Whether retry is recommended */
  shouldRetry: boolean;

  /** Recommended delay before retry in ms */
  delayMs?: number;

  /** What to change on retry */
  modifications?: string;

  /** Maximum additional retries recommended */
  maxRetries?: number;
}

// ============================================================================
// Follow-up Suggestions
// ============================================================================

export interface FollowUpSuggestion {
  /** Type of follow-up */
  type: 'test' | 'deploy' | 'documentation' | 'refactor' | 'integration' | 'review';

  /** Target tier (if cross-tier) */
  targetTier?: TierName;

  /** Description */
  description: string;

  /** Priority */
  priority: 'high' | 'medium' | 'low';

  /** Suggested prompt for orchestrator */
  suggestedPrompt?: string;

  /** Whether this blocks other work */
  blocking?: boolean;
}

// ============================================================================
// Resource Usage
// ============================================================================

export interface ResourceUsage {
  /** Token usage breakdown */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };

  /** Cost in USD */
  costUsd: number;

  /** Model used */
  model: string;

  /** Files read */
  filesRead: number;

  /** Files written */
  filesWritten: number;

  /** Bash commands executed */
  bashCommands: number;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a success response
 */
export function createSuccessResponse(
  taskId: string,
  requestId: string,
  tier: TierName,
  result: Partial<TaskResult>,
  artifacts: Artifact[] = [],
  usage: Partial<ResourceUsage> = {}
): TierResponse {
  const now = new Date().toISOString();
  return {
    protocolVersion: '1.1',
    taskId,
    requestId,
    tier,
    status: 'success',
    timing: {
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      apiDurationMs: 0,
      turns: 1,
    },
    result: {
      summary: result.summary || 'Task completed',
      description: result.description || '',
      reasoning: result.reasoning,
      data: result.data || { tier },
      criteriaStatus: result.criteriaStatus || [],
    },
    artifacts,
    validation: {
      passed: true,
      checks: [],
      warnings: [],
    },
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUsd: 0,
      model: 'claude-opus-4-6',
      filesRead: 0,
      filesWritten: artifacts.filter(a => a.action !== 'deleted').length,
      bashCommands: 0,
      ...usage,
    },
  };
}

/**
 * Create an error response
 */
export function createErrorResponse(
  taskId: string,
  requestId: string,
  tier: TierName,
  error: Partial<ErrorDetail>,
  usage: Partial<ResourceUsage> = {}
): TierResponse {
  const now = new Date().toISOString();
  return {
    protocolVersion: '1.1',
    taskId,
    requestId,
    tier,
    status: error.recoverable ? 'failure' : 'error',
    timing: {
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      apiDurationMs: 0,
      turns: 1,
    },
    result: {
      summary: `Error: ${error.message || 'Unknown error'}`,
      description: error.details || '',
      data: { tier },
      criteriaStatus: [],
    },
    artifacts: [],
    validation: {
      passed: false,
      checks: [],
      warnings: [],
    },
    error: {
      code: error.code || 'UNKNOWN_ERROR',
      type: error.type || 'unknown',
      message: error.message || 'Unknown error occurred',
      details: error.details,
      recoverable: error.recoverable ?? false,
      recoveryHints: error.recoveryHints,
      retry: error.retry,
    },
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUsd: 0,
      model: 'claude-opus-4-6',
      filesRead: 0,
      filesWritten: 0,
      bashCommands: 0,
      ...usage,
    },
  };
}
