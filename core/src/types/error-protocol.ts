/**
 * Error Protocol Types
 *
 * Defines error classification, recovery strategies, and error handling flow
 * for the tier-agent system.
 */

import type { TierName, ErrorType } from './instruction-protocol';
import type { TierResponse, ErrorDetail, ErrorCode } from './response-protocol';

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Error classification for routing to appropriate handler
 */
export interface ErrorClassification {
  /** Primary error category */
  category: ErrorCategory;

  /** Whether error is recoverable */
  recoverability: 'recoverable' | 'partially_recoverable' | 'non_recoverable';

  /** Recommended action */
  action: ErrorAction;

  /** Scope of impact */
  scope: ErrorScope;
}

export type ErrorCategory =
  | 'code_error'          // Syntax, type, logic errors
  | 'file_system_error'   // File not found, permissions
  | 'dependency_error'    // Missing packages, version conflicts
  | 'validation_error'    // Schema validation, type checking
  | 'external_error'      // APIs, services, network
  | 'resource_error'      // Timeout, memory, rate limits
  | 'configuration_error' // Config, environment issues
  | 'user_error';         // Invalid input, bad request

export type ErrorAction =
  | 'retry_same'          // Retry with same parameters
  | 'retry_modified'      // Retry with modifications
  | 'partial_complete'    // Mark as partial success
  | 'skip_and_continue'   // Skip this step, continue
  | 'rollback'            // Undo changes and fail
  | 'escalate'            // Escalate to orchestrator/user
  | 'fail';               // Fail immediately

export type ErrorScope =
  | 'task'                // Only this task affected
  | 'tier'                // Entire tier affected
  | 'request'             // Entire orchestration request affected
  | 'system';             // System-wide issue

// ============================================================================
// Error Recovery
// ============================================================================

/**
 * Error recovery result
 */
export interface RecoveryResult {
  /** Whether recovery was attempted */
  attempted: boolean;

  /** Whether recovery succeeded */
  success: boolean;

  /** Strategy used */
  strategy: string;

  /** New result (if recovery succeeded) */
  result?: TierResponse;

  /** Why recovery failed (if applicable) */
  failureReason?: string;

  /** Next recommended action */
  nextAction: ErrorAction;

  /** Number of attempts made */
  attemptsMade: number;

  /** Total time spent on recovery */
  recoveryDurationMs: number;
}

/**
 * Recovery attempt tracking
 */
export interface RecoveryAttempt {
  /** Attempt number */
  attempt: number;

  /** Strategy tried */
  strategy: string;

  /** Timestamp */
  timestamp: string;

  /** Duration in ms */
  durationMs: number;

  /** Outcome */
  outcome: 'success' | 'failure' | 'partial';

  /** Details about what happened */
  details?: string;

  /** Modified instruction used (if any) */
  modifiedInstruction?: string;
}

// ============================================================================
// Dependency Failures
// ============================================================================

/**
 * Dependency failure propagation
 */
export interface DependencyFailure {
  /** The dependency that failed */
  dependency: {
    taskId: string;
    tier: TierName;
    type: 'prerequisite' | 'parallel' | 'output';
  };

  /** How this affects the current task */
  impact: 'blocking' | 'degraded' | 'none';

  /** Whether to wait for retry */
  waitForRetry: boolean;

  /** Maximum wait time in ms */
  maxWaitMs?: number;

  /** Alternative approach if available */
  alternative?: {
    description: string;
    canProceed: boolean;
  };
}

// ============================================================================
// Error Aggregation
// ============================================================================

/**
 * Error aggregation for orchestrator
 */
export interface ErrorAggregation {
  /** Total errors encountered */
  totalErrors: number;

  /** Errors by category */
  byCategory: Partial<Record<ErrorCategory, number>>;

  /** Errors by tier */
  byTier: Partial<Record<TierName, ErrorSummary[]>>;

  /** Critical errors (blocking) */
  critical: ErrorSummary[];

  /** Warnings (non-blocking) */
  warnings: ErrorSummary[];

  /** Recovery attempts made */
  recoveryAttempts: RecoveryAttempt[];

  /** Overall recommendation */
  recommendation: {
    action: 'proceed' | 'retry' | 'partial_success' | 'fail';
    reason: string;
    confidence: 'high' | 'medium' | 'low';
  };
}

export interface ErrorSummary {
  taskId: string;
  tier: TierName;
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  recovered: boolean;
}

// ============================================================================
// Error Code Mapping
// ============================================================================

/**
 * Map error codes to classifications
 */
export const ERROR_CLASSIFICATIONS: Record<ErrorCode, ErrorClassification> = {
  FILE_NOT_FOUND: {
    category: 'file_system_error',
    recoverability: 'recoverable',
    action: 'escalate',
    scope: 'task',
  },
  FILE_PERMISSION_DENIED: {
    category: 'file_system_error',
    recoverability: 'non_recoverable',
    action: 'fail',
    scope: 'task',
  },
  SYNTAX_ERROR: {
    category: 'code_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  TYPE_ERROR: {
    category: 'code_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  IMPORT_ERROR: {
    category: 'dependency_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  DEPENDENCY_MISSING: {
    category: 'dependency_error',
    recoverability: 'recoverable',
    action: 'escalate',
    scope: 'tier',
  },
  DEPENDENCY_VERSION_MISMATCH: {
    category: 'dependency_error',
    recoverability: 'recoverable',
    action: 'escalate',
    scope: 'tier',
  },
  VALIDATION_FAILED: {
    category: 'validation_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  BUILD_FAILED: {
    category: 'code_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'tier',
  },
  TEST_FAILED: {
    category: 'validation_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  TIMEOUT: {
    category: 'resource_error',
    recoverability: 'recoverable',
    action: 'retry_same',
    scope: 'task',
  },
  RESOURCE_EXHAUSTED: {
    category: 'resource_error',
    recoverability: 'partially_recoverable',
    action: 'partial_complete',
    scope: 'request',
  },
  EXTERNAL_SERVICE_ERROR: {
    category: 'external_error',
    recoverability: 'recoverable',
    action: 'retry_same',
    scope: 'task',
  },
  AUTHENTICATION_FAILED: {
    category: 'external_error',
    recoverability: 'non_recoverable',
    action: 'fail',
    scope: 'request',
  },
  AUTHORIZATION_FAILED: {
    category: 'external_error',
    recoverability: 'non_recoverable',
    action: 'fail',
    scope: 'task',
  },
  CONFLICT: {
    category: 'validation_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  CONSTRAINT_VIOLATION: {
    category: 'validation_error',
    recoverability: 'recoverable',
    action: 'retry_modified',
    scope: 'task',
  },
  SCHEMA_MISMATCH: {
    category: 'validation_error',
    recoverability: 'recoverable',
    action: 'escalate',
    scope: 'tier',
  },
  MIGRATION_FAILED: {
    category: 'code_error',
    recoverability: 'partially_recoverable',
    action: 'rollback',
    scope: 'tier',
  },
  DEPLOYMENT_FAILED: {
    category: 'external_error',
    recoverability: 'recoverable',
    action: 'rollback',
    scope: 'tier',
  },
  ROLLBACK_REQUIRED: {
    category: 'validation_error',
    recoverability: 'partially_recoverable',
    action: 'rollback',
    scope: 'tier',
  },
  INTERNAL_ERROR: {
    category: 'code_error',
    recoverability: 'non_recoverable',
    action: 'fail',
    scope: 'system',
  },
  UNKNOWN_ERROR: {
    category: 'code_error',
    recoverability: 'partially_recoverable',
    action: 'escalate',
    scope: 'task',
  },
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Classify an error by its code
 */
export function classifyError(code: ErrorCode): ErrorClassification {
  return ERROR_CLASSIFICATIONS[code] || ERROR_CLASSIFICATIONS.UNKNOWN_ERROR;
}

/**
 * Check if an error is recoverable
 */
export function isRecoverable(error: ErrorDetail): boolean {
  const classification = classifyError(error.code);
  return classification.recoverability !== 'non_recoverable';
}

/**
 * Get recommended action for an error
 */
export function getRecommendedAction(error: ErrorDetail): ErrorAction {
  const classification = classifyError(error.code);
  return classification.action;
}

/**
 * Determine if retry should be attempted
 */
export function shouldRetry(error: ErrorDetail, attemptsMade: number, maxRetries: number): boolean {
  if (!isRecoverable(error)) return false;
  if (attemptsMade >= maxRetries) return false;

  const action = getRecommendedAction(error);
  return action === 'retry_same' || action === 'retry_modified';
}

/**
 * Calculate retry delay with exponential backoff
 */
export function calculateRetryDelay(
  attemptsMade: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000
): number {
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptsMade), maxDelayMs);
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

/**
 * Create an error aggregation from multiple responses
 */
export function aggregateErrors(responses: TierResponse[]): ErrorAggregation {
  const aggregation: ErrorAggregation = {
    totalErrors: 0,
    byCategory: {},
    byTier: {},
    critical: [],
    warnings: [],
    recoveryAttempts: [],
    recommendation: {
      action: 'proceed',
      reason: 'No errors encountered',
      confidence: 'high',
    },
  };

  for (const response of responses) {
    if (response.error) {
      aggregation.totalErrors++;

      const classification = classifyError(response.error.code);
      aggregation.byCategory[classification.category] =
        (aggregation.byCategory[classification.category] || 0) + 1;

      if (!aggregation.byTier[response.tier]) {
        aggregation.byTier[response.tier] = [];
      }

      const summary: ErrorSummary = {
        taskId: response.taskId,
        tier: response.tier,
        code: response.error.code,
        message: response.error.message,
        recoverable: response.error.recoverable,
        recovered: response.status === 'success' || response.status === 'partial',
      };

      aggregation.byTier[response.tier]!.push(summary);

      if (classification.scope === 'request' || classification.scope === 'system') {
        aggregation.critical.push(summary);
      } else if (response.error.recoverable) {
        aggregation.warnings.push(summary);
      } else {
        aggregation.critical.push(summary);
      }
    }
  }

  // Determine overall recommendation
  if (aggregation.critical.length > 0) {
    const hasNonRecoverable = aggregation.critical.some(e => !e.recoverable);
    if (hasNonRecoverable) {
      aggregation.recommendation = {
        action: 'fail',
        reason: `${aggregation.critical.length} critical non-recoverable error(s)`,
        confidence: 'high',
      };
    } else {
      aggregation.recommendation = {
        action: 'retry',
        reason: `${aggregation.critical.length} critical but recoverable error(s)`,
        confidence: 'medium',
      };
    }
  } else if (aggregation.warnings.length > 0) {
    const allRecovered = aggregation.warnings.every(e => e.recovered);
    if (allRecovered) {
      aggregation.recommendation = {
        action: 'proceed',
        reason: 'All errors recovered',
        confidence: 'high',
      };
    } else {
      aggregation.recommendation = {
        action: 'partial_success',
        reason: `${aggregation.warnings.length} warning(s), some unrecovered`,
        confidence: 'medium',
      };
    }
  }

  return aggregation;
}
