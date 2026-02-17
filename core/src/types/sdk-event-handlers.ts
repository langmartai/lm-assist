/**
 * SDK Event Handler Types
 *
 * Defines interfaces for handling blocking SDK events like:
 * - User questions (AskUserQuestion tool)
 * - Permission requests (canUseTool callback)
 * - Subagent approval
 *
 * The orchestrator implements these handlers to respond to blocking events.
 */

import type { TierName } from './instruction-protocol';
import type { SdkTokenUsage } from './sdk-events';

// ============================================================================
// Permission Request Handler
// ============================================================================

/**
 * Permission request from SDK when a tool needs approval
 */
export interface PermissionRequest {
  /** Request ID for tracking */
  requestId: string;
  /** Session ID */
  sessionId: string;
  /** Execution ID */
  executionId?: string;
  /** Tier context */
  tier?: TierName;
  /** Tool name requesting permission */
  toolName: string;
  /** Tool input parameters */
  toolInput: Record<string, unknown>;
  /** Tool use ID from SDK */
  toolUseId: string;
  /** Suggested permissions from SDK */
  suggestions?: string[];
  /** Timestamp */
  timestamp: string;
}

/**
 * Response to a permission request
 */
export interface PermissionResponse {
  /** Original request ID */
  requestId: string;
  /** Decision: allow, deny, or allow with modifications */
  behavior: 'allow' | 'deny' | 'allow_with_update';
  /** Modified tool input (for allow_with_update) */
  updatedInput?: Record<string, unknown>;
  /** Updated permissions to apply for future requests */
  updatedPermissions?: string[];
  /** Denial reason */
  message?: string;
  /** Whether to interrupt execution */
  interrupt?: boolean;
}

/**
 * Permission handler function type
 */
export type PermissionHandler = (
  request: PermissionRequest
) => Promise<PermissionResponse>;

// ============================================================================
// User Question Handler
// ============================================================================

/**
 * Question option from AskUserQuestion tool
 */
export interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Single question from AskUserQuestion
 */
export interface UserQuestion {
  /** Question text */
  question: string;
  /** Short header/label */
  header: string;
  /** Available options */
  options: QuestionOption[];
  /** Allow multiple selections */
  multiSelect: boolean;
}

/**
 * Question type indicating urgency/importance
 */
export type QuestionType = 'blocking' | 'optional';

/**
 * User question request from SDK
 */
export interface UserQuestionRequest {
  /** Request ID for tracking */
  requestId: string;
  /** Session ID */
  sessionId: string;
  /** Execution ID */
  executionId?: string;
  /** Tier context */
  tier?: TierName;
  /** Tool use ID from SDK */
  toolUseId: string;
  /** Questions to answer */
  questions: UserQuestion[];
  /** Timeout in ms (optional) */
  timeout?: number;
  /** Timestamp */
  timestamp: string;
  /** Question type: blocking (must answer) or optional (can proceed with default) */
  questionType?: QuestionType;
  /** Whether the requested job is complete (always false when asking questions) */
  jobComplete?: boolean;
  /** Whether orchestrator can proceed with default option */
  canProceedWithDefault?: boolean;
  /** Default option label if canProceedWithDefault is true */
  defaultOption?: string;
}

/**
 * Response to user questions
 */
export interface UserQuestionResponse {
  /** Original request ID */
  requestId: string;
  /** Answers keyed by question text */
  answers: Record<string, string | string[]>;
  /** Whether the response timed out */
  timedOut?: boolean;
}

/**
 * User question handler function type
 */
export type UserQuestionHandler = (
  request: UserQuestionRequest
) => Promise<UserQuestionResponse>;

// ============================================================================
// Subagent Approval Handler
// ============================================================================

/**
 * Subagent spawn request
 */
export interface SubagentApprovalRequest {
  /** Request ID for tracking */
  requestId: string;
  /** Session ID */
  sessionId: string;
  /** Execution ID */
  executionId?: string;
  /** Parent tier context */
  tier?: TierName;
  /** Subagent name */
  agentName: string;
  /** Subagent description */
  description: string;
  /** Task prompt for subagent */
  prompt: string;
  /** Tools the subagent will use */
  tools: string[];
  /** Model for subagent */
  model?: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Response to subagent approval request
 */
export interface SubagentApprovalResponse {
  /** Original request ID */
  requestId: string;
  /** Whether to allow the subagent */
  approved: boolean;
  /** Modified prompt (optional) */
  modifiedPrompt?: string;
  /** Restricted tools (optional) */
  restrictedTools?: string[];
  /** Denial reason */
  reason?: string;
}

/**
 * Subagent approval handler function type
 */
export type SubagentApprovalHandler = (
  request: SubagentApprovalRequest
) => Promise<SubagentApprovalResponse>;

// ============================================================================
// Combined Event Handler Interface
// ============================================================================

/**
 * Configuration for SDK event handlers
 */
export interface SdkEventHandlerConfig {
  /** Handler for permission requests */
  onPermissionRequest?: PermissionHandler;
  /** Handler for user questions */
  onUserQuestion?: UserQuestionHandler;
  /** Handler for subagent approval */
  onSubagentApproval?: SubagentApprovalHandler;
  /** Default permission behavior when no handler provided */
  defaultPermissionBehavior?: 'allow' | 'deny' | 'prompt';
  /** Default answer strategy when no handler provided */
  defaultAnswerStrategy?: 'first_option' | 'skip' | 'prompt';
  /** Auto-approve subagents by default */
  autoApproveSubagents?: boolean;
  /** Tools to auto-approve without handler */
  autoApprovedTools?: string[];
  /** Tools to always deny */
  deniedTools?: string[];
  /** Timeout for handler responses (ms) */
  handlerTimeout?: number;
}

/**
 * SDK event handler interface for orchestrator integration
 */
export interface SdkEventHandler {
  /** Handle permission request */
  handlePermissionRequest(request: PermissionRequest): Promise<PermissionResponse>;
  /** Handle user question */
  handleUserQuestion(request: UserQuestionRequest): Promise<UserQuestionResponse>;
  /** Handle subagent approval */
  handleSubagentApproval(request: SubagentApprovalRequest): Promise<SubagentApprovalResponse>;
}

// ============================================================================
// Blocking Event Status
// ============================================================================

/**
 * Status of a blocking event
 */
export type BlockingEventStatus = 'pending' | 'responded' | 'timed_out' | 'cancelled';

/**
 * Stored blocking event with response tracking
 */
export interface StoredBlockingEvent {
  /** Event ID */
  id: string;
  /** Event type */
  type: 'permission_request' | 'user_question' | 'subagent_approval';
  /** Request data */
  request: PermissionRequest | UserQuestionRequest | SubagentApprovalRequest;
  /** Response data (if responded) */
  response?: PermissionResponse | UserQuestionResponse | SubagentApprovalResponse;
  /** Current status */
  status: BlockingEventStatus;
  /** Created timestamp */
  createdAt: string;
  /** Responded timestamp */
  respondedAt?: string;
  /** Handler that responded */
  respondedBy?: 'auto' | 'orchestrator' | 'user' | 'policy';
  /** Duration waiting for response (ms) */
  waitDurationMs?: number;
}

// ============================================================================
// Policy-Based Auto-Response
// ============================================================================

/**
 * Policy for auto-responding to blocking events
 */
export interface BlockingEventPolicy {
  /** Policy ID */
  id: string;
  /** Policy name */
  name: string;
  /** Policy type */
  type: 'permission' | 'question' | 'subagent';
  /** Conditions to match */
  conditions: PolicyCondition[];
  /** Response to apply when conditions match */
  response: PolicyResponse;
  /** Priority (higher = checked first) */
  priority: number;
  /** Whether policy is enabled */
  enabled: boolean;
}

/**
 * Condition for policy matching
 */
export interface PolicyCondition {
  /** Field to check */
  field: string;
  /** Operator */
  operator: 'equals' | 'contains' | 'matches' | 'in' | 'not_in';
  /** Value to compare */
  value: string | string[] | RegExp;
}

/**
 * Response from policy
 */
export interface PolicyResponse {
  /** For permissions: behavior */
  behavior?: 'allow' | 'deny';
  /** For questions: answer strategy */
  answerStrategy?: 'first_option' | 'specific' | 'skip';
  /** Specific answer value */
  answerValue?: string | Record<string, string>;
  /** For subagents: approved */
  approved?: boolean;
  /** Message/reason */
  message?: string;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a permission request
 */
export function createPermissionRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  sessionId: string,
  tier?: TierName,
  executionId?: string,
  suggestions?: string[]
): PermissionRequest {
  return {
    requestId: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    executionId,
    tier,
    toolName,
    toolInput,
    toolUseId,
    suggestions,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a user question request
 */
export function createUserQuestionRequest(
  questions: UserQuestion[],
  toolUseId: string,
  sessionId: string,
  tier?: TierName,
  executionId?: string,
  timeout?: number
): UserQuestionRequest {
  return {
    requestId: `question-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    executionId,
    tier,
    toolUseId,
    questions,
    timeout,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a subagent approval request
 */
export function createSubagentApprovalRequest(
  agentName: string,
  description: string,
  prompt: string,
  tools: string[],
  sessionId: string,
  tier?: TierName,
  executionId?: string,
  model?: string
): SubagentApprovalRequest {
  return {
    requestId: `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    executionId,
    tier,
    agentName,
    description,
    prompt,
    tools,
    model,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Default Handlers
// ============================================================================

/**
 * Create default permission response (allow)
 */
export function createDefaultPermissionResponse(
  requestId: string,
  behavior: 'allow' | 'deny' = 'allow'
): PermissionResponse {
  return {
    requestId,
    behavior,
  };
}

/**
 * Create default question response (first option)
 */
export function createDefaultQuestionResponse(
  request: UserQuestionRequest
): UserQuestionResponse {
  const answers: Record<string, string | string[]> = {};

  for (const q of request.questions) {
    if (q.options.length > 0) {
      if (q.multiSelect) {
        answers[q.question] = [q.options[0].label];
      } else {
        answers[q.question] = q.options[0].label;
      }
    }
  }

  return {
    requestId: request.requestId,
    answers,
  };
}

/**
 * Create default subagent approval response
 */
export function createDefaultSubagentApprovalResponse(
  requestId: string,
  approved: boolean = true
): SubagentApprovalResponse {
  return {
    requestId,
    approved,
  };
}
