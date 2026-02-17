/**
 * Instruction Protocol Types
 *
 * Defines the structured instruction format sent from orchestrator to tier agents.
 * Ensures clear objectives, expected outputs, and error handling guidance.
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Tier names for the multi-tier agent system
 *
 * Implementation tiers: web, api, database, deploy
 * Document tiers: spec, task
 */
export type TierName = 'web' | 'api' | 'database' | 'deploy' | 'spec' | 'task';

/**
 * Implementation-only tiers (code-producing)
 */
export type ImplementationTierName = 'web' | 'api' | 'database' | 'deploy';

/**
 * Document-based tiers (markdown-producing)
 */
export type DocumentTierName = 'spec' | 'task';

/**
 * Type guard: Check if tier is an implementation tier
 */
export function isImplementationTier(tier: TierName): tier is ImplementationTierName {
  return ['web', 'api', 'database', 'deploy'].includes(tier);
}

/**
 * Type guard: Check if tier is a document tier
 */
export function isDocumentTier(tier: TierName): tier is DocumentTierName {
  return ['spec', 'task'].includes(tier);
}

export type ArtifactType =
  | 'file_created'
  | 'file_modified'
  | 'file_deleted'
  | 'component'
  | 'page'
  | 'endpoint'
  | 'schema'
  | 'migration'
  | 'type_definition'
  | 'test'
  | 'configuration';

// ============================================================================
// Task Instruction Schema (Orchestrator -> Tier Agent)
// ============================================================================

/**
 * Complete instruction packet sent from orchestrator to tier agent
 */
export interface TierInstruction {
  /** Instruction protocol version for compatibility */
  protocolVersion: '1.0';

  /** Unique task identifier for tracking */
  taskId: string;

  /** Parent request ID (links to orchestrator request) */
  requestId: string;

  /** Target tier identifier */
  tier: TierName;

  /** Task metadata */
  meta: TaskMeta;

  /** The actual task specification */
  task: TaskSpec;

  /** Expected output format */
  expectedOutput: OutputSpec;

  /** Context from other tiers or previous executions */
  context: TaskContext;

  /** Error handling guidance */
  errorHandling: ErrorGuidance;

  /** Success criteria for validation */
  successCriteria: SuccessCriteria;
}

// ============================================================================
// Task Metadata
// ============================================================================

export interface TaskMeta {
  /** Human-readable task title */
  title: string;

  /** Priority level (affects timeout and retry behavior) */
  priority: 'critical' | 'high' | 'normal' | 'low';

  /** Estimated scope (affects timeout) */
  estimatedScope: 'trivial' | 'small' | 'medium' | 'large' | 'complex';

  /** Timeout override in ms */
  timeoutMs?: number;

  /** Maximum retry attempts */
  maxRetries?: number;

  /** Tags for filtering/categorization */
  tags?: string[];

  /** Timestamp of instruction creation */
  createdAt: string; // ISO 8601
}

// ============================================================================
// Task Specification
// ============================================================================

export interface TaskSpec {
  /** Clear, imperative objective statement */
  objective: string;

  /** Detailed requirements */
  requirements: string[];

  /** Constraints and boundaries */
  constraints: string[];

  /** Acceptance criteria (what makes this task "done") */
  acceptanceCriteria: string[];

  /** References to files/patterns to follow */
  references?: TaskReference[];

  /** Specific files to modify (if known) */
  targetFiles?: string[];

  /** Tier-specific parameters */
  tierParams?: TierSpecificParams;
}

export interface TaskReference {
  /** Type of reference */
  type: 'file' | 'pattern' | 'documentation' | 'example';

  /** Path or identifier */
  path: string;

  /** Description of what to reference */
  description: string;
}

// ============================================================================
// Tier-Specific Parameters
// ============================================================================

/** Union type for tier-specific parameters */
export type TierSpecificParams =
  | WebTierParams
  | ApiTierParams
  | DatabaseTierParams
  | DeployTierParams
  | SpecTierParams
  | TaskTierParams;

// ============================================================================
// Spec Tier Parameters
// ============================================================================

export interface SpecTierParams {
  tier: 'spec';
  /** Type of specification document */
  documentType?: 'feature' | 'requirement' | 'contract' | 'data-model' | 'adr';
  /** Whether this is creating new or updating existing */
  operation?: 'create' | 'update' | 'sync';
  /** Feature path for updates */
  featurePath?: string;
  /** Spec feedback from implementation tier */
  feedback?: {
    tier: ImplementationTierName;
    artifacts?: unknown[];
    deviations?: unknown[];
  };
}

// ============================================================================
// Task Tier Parameters
// ============================================================================

export interface TaskTierParams {
  tier: 'task';
  /** Type of task operation */
  operation?: 'breakdown' | 'status_update' | 'archive' | 'query';
  /** Spec paths to break down */
  specPaths?: string[];
  /** Task IDs for status updates */
  taskIds?: string[];
  /** New status for tasks */
  newStatus?: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled';
}

export interface WebTierParams {
  tier: 'web';
  componentType?: 'page' | 'component' | 'hook' | 'utility' | 'layout';
  styling?: 'css' | 'tailwind' | 'styled-components' | 'css-modules' | 'scss';
  stateManagement?: 'local' | 'context' | 'zustand' | 'redux' | 'jotai';
  framework?: 'react' | 'vue' | 'svelte' | 'next' | 'astro';
}

export interface ApiTierParams {
  tier: 'api';
  endpointType?: 'rest' | 'graphql' | 'websocket' | 'grpc';
  authRequired?: boolean;
  methods?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  responseFormat?: 'json' | 'stream' | 'binary';
  framework?: 'hono' | 'express' | 'fastify' | 'nestjs';
}

export interface DatabaseTierParams {
  tier: 'database';
  operationType?: 'schema' | 'migration' | 'seed' | 'function' | 'index' | 'view';
  migrationDirection?: 'up' | 'down' | 'both';
  breakingChange?: boolean;
  database?: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
}

export interface DeployTierParams {
  tier: 'deploy';
  targetEnvironment?: 'development' | 'staging' | 'production';
  deploymentType?: 'build' | 'deploy' | 'migrate' | 'rollback' | 'test';
  affectedTiers?: TierName[];
  platform?: 'docker' | 'kubernetes' | 'vercel' | 'aws' | 'gcp';
}

// ============================================================================
// Output Specification
// ============================================================================

export interface OutputSpec {
  /** Expected output format */
  format: 'structured' | 'freeform';

  /** Expected artifact types */
  expectedArtifacts: ArtifactType[];

  /** Whether to include reasoning/explanation */
  includeReasoning: boolean;

  /** Whether to include validation results */
  includeValidation: boolean;
}

// ============================================================================
// Task Context
// ============================================================================

export interface TaskContext {
  /** Results from prerequisite tier executions */
  prerequisiteResults?: PrerequisiteResult[];

  /** Relevant exports from other tiers */
  tierExports?: TierExportContext;

  /** Session history summary (if resuming) */
  sessionContext?: string;

  /** User's original request (for reference) */
  originalRequest?: string;

  /** Related tasks in this orchestration */
  relatedTasks?: RelatedTask[];
}

export interface PrerequisiteResult {
  taskId: string;
  tier: TierName;
  status: 'success' | 'partial' | 'failure';
  summary: string;
  artifacts?: ArtifactSummary[];
  relevantOutput?: string; // Truncated, relevant portion
}

export interface ArtifactSummary {
  type: ArtifactType;
  name: string;
  path: string;
  description?: string;
}

export interface TierExportContext {
  /** Database schemas relevant to this task */
  schemas?: Array<{
    name: string;
    columns: string[];
    path: string;
  }>;

  /** API endpoints relevant to this task */
  endpoints?: Array<{
    method: string;
    path: string;
    handler: string;
  }>;

  /** Components relevant to this task */
  components?: Array<{
    name: string;
    path: string;
    props?: string[];
  }>;

  /** Type definitions relevant to this task */
  types?: Array<{
    name: string;
    path: string;
    tier: TierName;
  }>;
}

export interface RelatedTask {
  taskId: string;
  tier: TierName;
  objective: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

// ============================================================================
// Error Handling Guidance
// ============================================================================

export interface ErrorGuidance {
  /** Known potential issues and how to handle them */
  knownIssues?: KnownIssue[];

  /** What to do on specific error types */
  recoveryStrategies: RecoveryStrategy[];

  /** When to escalate vs retry */
  escalationPolicy: EscalationPolicy;

  /** Dependencies that could fail */
  dependencies?: DependencySpec[];
}

export interface KnownIssue {
  /** Pattern or condition that indicates this issue */
  pattern: string;

  /** Description of the issue */
  description: string;

  /** Recommended action */
  action: 'retry' | 'skip' | 'alternative' | 'escalate';

  /** Alternative approach if action is 'alternative' */
  alternative?: string;
}

export interface RecoveryStrategy {
  /** Error type this strategy handles */
  errorType: ErrorType;

  /** Strategy to apply */
  strategy: 'retry' | 'partial_complete' | 'rollback' | 'escalate' | 'skip';

  /** Maximum retries for this error type */
  maxRetries?: number;

  /** Delay between retries in ms */
  retryDelayMs?: number;

  /** Instructions for partial completion */
  partialInstructions?: string;
}

export type ErrorType =
  | 'file_not_found'
  | 'permission_denied'
  | 'syntax_error'
  | 'type_error'
  | 'dependency_missing'
  | 'timeout'
  | 'external_service'
  | 'validation_failed'
  | 'conflict'
  | 'unknown';

export interface EscalationPolicy {
  /** When to escalate to orchestrator */
  escalateOn: ErrorType[];

  /** When to mark as non-recoverable */
  failOn: ErrorType[];

  /** Message template for escalation */
  escalationTemplate?: string;
}

export interface DependencySpec {
  /** Name of the dependency */
  name: string;

  /** Type of dependency */
  type: 'file' | 'endpoint' | 'schema' | 'package' | 'service';

  /** Path or identifier */
  identifier: string;

  /** Whether task can proceed without it */
  optional: boolean;
}

// ============================================================================
// Success Criteria
// ============================================================================

export interface SuccessCriteria {
  /** Required outcomes for success */
  required: Criterion[];

  /** Optional outcomes (nice to have) */
  optional?: Criterion[];

  /** Validation checks to run */
  validations?: ValidationCheck[];
}

export interface Criterion {
  /** Human-readable description */
  description: string;

  /** Machine-checkable condition (optional) */
  check?: CriterionCheck;
}

export interface CriterionCheck {
  /** Type of check */
  type: 'file_exists' | 'file_contains' | 'endpoint_responds' | 'type_valid' | 'custom';

  /** Target of the check */
  target: string;

  /** Expected value or pattern */
  expected?: string;
}

export interface ValidationCheck {
  /** Type of validation */
  type: 'typescript' | 'eslint' | 'test' | 'build' | 'custom';

  /** Command to run (for custom) */
  command?: string;

  /** Whether failure blocks success */
  blocking: boolean;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a default TierInstruction with sensible defaults
 */
export function createTierInstruction(
  tier: TierName,
  objective: string,
  options?: Partial<TierInstruction>
): TierInstruction {
  const now = new Date().toISOString();
  const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const requestId = options?.requestId || `req-${Date.now()}`;

  return {
    protocolVersion: '1.0',
    taskId,
    requestId,
    tier,
    meta: {
      title: objective.substring(0, 100),
      priority: 'normal',
      estimatedScope: 'medium',
      createdAt: now,
      ...options?.meta,
    },
    task: {
      objective,
      requirements: [],
      constraints: [],
      acceptanceCriteria: [],
      ...options?.task,
    },
    expectedOutput: {
      format: 'structured',
      expectedArtifacts: [],
      includeReasoning: true,
      includeValidation: true,
      ...options?.expectedOutput,
    },
    context: {
      ...options?.context,
    },
    errorHandling: {
      recoveryStrategies: [
        { errorType: 'syntax_error', strategy: 'retry', maxRetries: 2 },
        { errorType: 'type_error', strategy: 'retry', maxRetries: 2 },
        { errorType: 'file_not_found', strategy: 'escalate' },
        { errorType: 'permission_denied', strategy: 'escalate' },
      ],
      escalationPolicy: {
        escalateOn: ['dependency_missing', 'external_service'],
        failOn: ['permission_denied'],
      },
      ...options?.errorHandling,
    },
    successCriteria: {
      required: [{ description: 'Task objective completed' }],
      ...options?.successCriteria,
    },
  };
}
