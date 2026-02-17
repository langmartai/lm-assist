/**
 * Orchestrator Command Types
 *
 * Defines the structured commands that orchestrator and tier agents can output.
 * These commands are parsed from LLM text output (##CMD:...##END format).
 *
 * Communication commands use the same types as SDK event handlers for unified handling.
 */

import type {
  UserQuestionRequest,
  UserQuestionResponse,
  PermissionRequest,
  PermissionResponse,
  SubagentApprovalRequest,
  SubagentApprovalResponse,
} from './sdk-event-handlers';

// ============================================================================
// Command Type Enum
// ============================================================================

/**
 * All command types that can be output by orchestrator or tier agents
 */
export type ProtocolCommandType =
  // Control commands (system state)
  | 'INTERRUPT'
  | 'SUPPLEMENT'
  | 'CANCEL'
  | 'STATUS'
  | 'COMPLETE'
  // Tier execution commands
  | 'TIER'
  // Flow commands (orchestration)
  | 'SEQUENCE'
  | 'PARALLEL'
  | 'EVALUATE'
  | 'RETRY'
  // Communication commands (SDK-compatible)
  | 'USER_QUESTION'
  | 'USER_QUESTION_RESPONSE'
  | 'PERMISSION_REQUEST'
  | 'PERMISSION_RESPONSE'
  | 'SUBAGENT_APPROVAL'
  | 'SUBAGENT_RESPONSE'
  // Tier response commands
  | 'RESULT';

// ============================================================================
// Base Command Interface
// ============================================================================

/**
 * Base interface for all parsed commands
 */
export interface BaseCommand {
  /** Command type */
  type: ProtocolCommandType;
  /** Raw command text (for debugging) */
  raw: string;
}

// ============================================================================
// Control Commands
// ============================================================================

/**
 * Interrupt current task and optionally start new one
 */
export interface InterruptCommand extends BaseCommand {
  type: 'INTERRUPT';
  payload: {
    reason: string;
    preserveCompleted?: boolean;
    newTask?: {
      prompt: string;
      tiers?: string[];
      sequence?: TierTaskDef[];
    };
  };
}

/**
 * Add requirements to current running task
 */
export interface SupplementCommand extends BaseCommand {
  type: 'SUPPLEMENT';
  payload: {
    reason: string;
    additions: TierTaskDef[];
  };
}

/**
 * Cancel current task
 */
export interface CancelCommand extends BaseCommand {
  type: 'CANCEL';
  payload: {
    reason: string;
    cleanup?: boolean;
  };
}

/**
 * Report current status
 */
export interface StatusCommand extends BaseCommand {
  type: 'STATUS';
  payload: {
    detail?: 'brief' | 'full';
    includeLogs?: boolean;
  };
}

/**
 * Mark orchestration complete
 */
export interface CompleteCommand extends BaseCommand {
  type: 'COMPLETE';
  payload: {
    summary: string;
    artifacts?: string[];
    nextSteps?: string[];
  };
}

// ============================================================================
// Tier Execution Commands
// ============================================================================

/**
 * Task definition for a tier
 */
export interface TierTaskDef {
  tier: string;
  prompt: string;
  order?: number;
  context?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  dependencies?: string[];
}

/**
 * Execute task on specific tier
 */
export interface TierCommand extends BaseCommand {
  type: 'TIER';
  /** Target tier name (from TIER:xxx) */
  tier: string;
  payload: {
    prompt: string;
    context?: string;
    priority?: 'critical' | 'high' | 'normal' | 'low';
    dependencies?: string[];
  };
}

/**
 * Execute tiers in sequence
 */
export interface SequenceCommand extends BaseCommand {
  type: 'SEQUENCE';
  payload: {
    tasks: TierTaskDef[];
  };
}

/**
 * Execute tiers in parallel
 */
export interface ParallelCommand extends BaseCommand {
  type: 'PARALLEL';
  payload: {
    tiers: TierTaskDef[];
    waitForAll?: boolean;
  };
}

/**
 * Evaluate tier results
 */
export interface EvaluateCommand extends BaseCommand {
  type: 'EVALUATE';
  payload: {
    tiers: string[];
    criteria?: string[];
    onFailure?: 'retry' | 'continue' | 'abort';
  };
}

/**
 * Retry failed tier
 */
export interface RetryCommand extends BaseCommand {
  type: 'RETRY';
  payload: {
    tier: string;
    modifications?: string;
    maxAttempts?: number;
  };
}

// ============================================================================
// Communication Commands (SDK-Compatible)
// ============================================================================

/**
 * Ask user a question (SDK UserQuestionRequest)
 */
export interface UserQuestionCommand extends BaseCommand {
  type: 'USER_QUESTION';
  payload: UserQuestionRequest;
}

/**
 * Respond to user question (SDK UserQuestionResponse)
 */
export interface UserQuestionResponseCommand extends BaseCommand {
  type: 'USER_QUESTION_RESPONSE';
  payload: UserQuestionResponse;
}

/**
 * Request permission (SDK PermissionRequest)
 */
export interface PermissionRequestCommand extends BaseCommand {
  type: 'PERMISSION_REQUEST';
  payload: PermissionRequest;
}

/**
 * Respond to permission request (SDK PermissionResponse)
 */
export interface PermissionResponseCommand extends BaseCommand {
  type: 'PERMISSION_RESPONSE';
  payload: PermissionResponse;
}

/**
 * Request subagent approval (SDK SubagentApprovalRequest)
 */
export interface SubagentApprovalCommand extends BaseCommand {
  type: 'SUBAGENT_APPROVAL';
  payload: SubagentApprovalRequest;
}

/**
 * Respond to subagent approval (SDK SubagentApprovalResponse)
 */
export interface SubagentResponseCommand extends BaseCommand {
  type: 'SUBAGENT_RESPONSE';
  payload: SubagentApprovalResponse;
}

// ============================================================================
// Tier Response Commands
// ============================================================================

/**
 * Tier response result status
 */
export type TierResultStatus = 'success' | 'failure' | 'partial' | 'blocked';

/**
 * Continuation reason when job is not complete
 */
export type ContinuationReason = 'review_needed' | 'complex_task' | 'clarification_needed';

/**
 * Continuation info when tier needs more work/interaction
 */
export interface TierContinuation {
  /** Why continuation is needed */
  reason: ContinuationReason;
  /** Human-readable explanation */
  message: string;
  /** List of remaining work items */
  workRemaining?: string[];
  /** Whether orchestrator can tell tier to proceed without answering */
  canProceedWithoutAnswer: boolean;
}

/**
 * Artifact created/modified by tier
 */
export interface TierArtifact {
  type: string;
  path: string;
  description?: string;
  action?: 'created' | 'modified' | 'deleted';
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * Error details for failed tier
 */
export interface TierError {
  code: string;
  message: string;
  recoverable?: boolean;
}

/**
 * Blocking event reference (when tier is waiting)
 */
export interface BlockingEventRef {
  type: 'user_question' | 'permission_request' | 'subagent_approval';
  requestId: string;
}

/**
 * Result command from tier agent
 */
export interface ResultCommand extends BaseCommand {
  type: 'RESULT';
  payload: {
    /** Tier name */
    tier: string;
    /** Result status */
    status: TierResultStatus;
    /** Whether the requested job is FULLY complete */
    jobComplete: boolean;
    /** Brief summary */
    summary: string;
    /** Artifacts created/modified */
    artifacts: TierArtifact[];
    /** Exports for other tiers */
    exports: Record<string, unknown>;
    /** Suggested next steps */
    nextSteps?: string[];
    /** Error details (if status is failure) */
    error?: TierError;
    /** Blocking event (if status is blocked) */
    blockingEvent?: BlockingEventRef;
    /** Continuation info (if jobComplete is false) */
    continuation?: TierContinuation;
  };
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Union of all command types
 */
export type ProtocolCommand =
  // Control
  | InterruptCommand
  | SupplementCommand
  | CancelCommand
  | StatusCommand
  | CompleteCommand
  // Tier execution
  | TierCommand
  | SequenceCommand
  | ParallelCommand
  | EvaluateCommand
  | RetryCommand
  // Communication
  | UserQuestionCommand
  | UserQuestionResponseCommand
  | PermissionRequestCommand
  | PermissionResponseCommand
  | SubagentApprovalCommand
  | SubagentResponseCommand
  // Tier response
  | ResultCommand;

// ============================================================================
// Parse Result
// ============================================================================

/**
 * Result of parsing LLM output for commands
 */
export interface CommandParseResult {
  /** Whether parsing was successful */
  success: boolean;
  /** Extracted commands */
  commands: ProtocolCommand[];
  /** Text content before/between/after commands */
  textContent: string;
  /** Parse errors if any */
  errors: CommandParseError[];
}

/**
 * Parse error details
 */
export interface CommandParseError {
  /** Error type */
  type: 'invalid_format' | 'invalid_json' | 'unknown_command' | 'missing_required';
  /** Error message */
  message: string;
  /** Raw text that caused the error */
  raw?: string;
  /** Position in original text */
  position?: number;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isControlCommand(cmd: ProtocolCommand): cmd is
  | InterruptCommand
  | SupplementCommand
  | CancelCommand
  | StatusCommand
  | CompleteCommand {
  return ['INTERRUPT', 'SUPPLEMENT', 'CANCEL', 'STATUS', 'COMPLETE'].includes(cmd.type);
}

export function isTierExecutionCommand(cmd: ProtocolCommand): cmd is
  | TierCommand
  | SequenceCommand
  | ParallelCommand
  | EvaluateCommand
  | RetryCommand {
  return ['TIER', 'SEQUENCE', 'PARALLEL', 'EVALUATE', 'RETRY'].includes(cmd.type);
}

export function isCommunicationCommand(cmd: ProtocolCommand): cmd is
  | UserQuestionCommand
  | UserQuestionResponseCommand
  | PermissionRequestCommand
  | PermissionResponseCommand
  | SubagentApprovalCommand
  | SubagentResponseCommand {
  return [
    'USER_QUESTION',
    'USER_QUESTION_RESPONSE',
    'PERMISSION_REQUEST',
    'PERMISSION_RESPONSE',
    'SUBAGENT_APPROVAL',
    'SUBAGENT_RESPONSE',
  ].includes(cmd.type);
}

export function isResultCommand(cmd: ProtocolCommand): cmd is ResultCommand {
  return cmd.type === 'RESULT';
}
