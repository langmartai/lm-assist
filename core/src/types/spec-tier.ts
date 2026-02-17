/**
 * Spec Tier Type Definitions
 *
 * Types for the Product Specification tier which manages:
 * - Business requirements
 * - Feature specifications
 * - API contracts
 * - Data model definitions
 * - Architecture Decision Records (ADRs)
 */

import type { TierName, ImplementationTierName } from './instruction-protocol';

// ============================================================================
// Document Status & Lifecycle
// ============================================================================

/**
 * Status of a specification document
 */
export type SpecDocumentStatus =
  | 'draft'           // Initial creation, not yet reviewed
  | 'review'          // Under review
  | 'approved'        // Approved for implementation
  | 'tasks_generated' // Tasks have been generated from this spec
  | 'in_progress'     // Implementation started (at least one task impl_started)
  | 'implemented'     // All tasks completed
  | 'verified'        // Acceptance criteria verified
  | 'deprecated';     // No longer active

/**
 * Type of specification document
 */
export type SpecDocumentType =
  | 'feature'         // Feature specification
  | 'requirement'     // Business requirement
  | 'api-contract'    // API endpoint contract
  | 'data-model'      // Data model/schema definition
  | 'adr'             // Architecture Decision Record
  | 'integration'     // Integration specification
  | 'user-flow'       // User flow/journey
  | 'project-spec';   // Auto-generated project specification

// ============================================================================
// Base Document Interface
// ============================================================================

/**
 * Active session tracking for a spec
 */
export interface SpecActiveSession {
  /** Claude Code session ID */
  sessionId: string;
  /** Execution ID (from Agent API) */
  executionId?: string;
  /** When the session started working on this spec */
  startedAt: string; // ISO 8601
  /** Last activity timestamp */
  lastActivityAt: string; // ISO 8601
  /** What operation is being performed */
  operation: 'execute' | 'task_breakdown' | 'implementation' | 'review';
  /** Optional progress info */
  progress?: {
    currentStep?: string;
    percent?: number;
  };
}

/**
 * Session history entry for a spec
 */
export interface SpecSessionHistoryEntry {
  /** Claude Code session ID */
  sessionId: string;
  /** Execution ID (from Agent API) */
  executionId?: string;
  /** When the session started */
  startedAt: string; // ISO 8601
  /** When the session ended */
  endedAt: string; // ISO 8601
  /** What operation was performed */
  operation: 'execute' | 'task_breakdown' | 'implementation' | 'review';
  /** Result status */
  status: 'completed' | 'failed' | 'aborted';
  /** Summary of what was done */
  summary?: string;
}

/**
 * Base interface for all spec documents
 */
export interface SpecDocumentBase {
  /** Document ID (e.g., 'FR-001', 'FEAT-user-auth') */
  id: string;

  /** Document type */
  type: SpecDocumentType;

  /** Human-readable title */
  title: string;

  /** Current status */
  status: SpecDocumentStatus;

  /** File path relative to spec tier root */
  path: string;

  /** Version number (semver or sequential) */
  version: string;

  /** Creation timestamp */
  createdAt: string; // ISO 8601

  /** Last update timestamp */
  updatedAt: string; // ISO 8601

  /** Author/owner */
  author?: string;

  /** Tags for categorization */
  tags?: string[];

  /** Related document IDs */
  relatedDocs?: string[];

  /** IDs of tasks generated from this spec (legacy: just IDs) */
  linkedTasks?: string[];

  /** Structured reference to linked tasks (new format) */
  linkedTasksRef?: LinkedTasksRef;

  /** Timestamp when tasks were generated */
  tasksGeneratedAt?: string; // ISO 8601

  /** Project key for this spec (derived from project path) */
  projectKey?: string;

  /** Summary of linked task statuses */
  taskStatusSummary?: TaskStatusSummary;

  /** Currently active session working on this spec */
  activeSession?: SpecActiveSession;

  /** History of sessions that worked on this spec */
  sessionHistory?: SpecSessionHistoryEntry[];
}

/**
 * Reference to linked tasks in a task list
 */
export interface LinkedTasksRef {
  /** Task list ID (from TasksService) */
  listId: string;
  /** Task IDs within that list */
  taskIds: string[];
}

/**
 * Summary of task statuses for a spec
 */
export interface TaskStatusSummary {
  pending: number;
  active: number;
  impl_started: number;
  blocked: number;
  done: number;
  failed: number;
  total: number;
}

// ============================================================================
// Feature Specification
// ============================================================================

/**
 * Complete feature specification document
 */
export interface FeatureSpec extends SpecDocumentBase {
  type: 'feature';

  /** Feature overview */
  overview: string;

  /** User stories for this feature */
  userStories: UserStory[];

  /** Acceptance criteria */
  acceptanceCriteria: AcceptanceCriterion[];

  /** Technical requirements */
  technicalRequirements: TechnicalRequirement[];

  /** API contracts for this feature */
  apiContracts?: ApiContractRef[];

  /** Data models for this feature */
  dataModels?: DataModelRef[];

  /** Dependencies on other features or systems */
  dependencies?: FeatureDependency[];

  /** What is explicitly out of scope */
  outOfScope?: string[];

  /** Implementation notes and decisions */
  implementationNotes?: ImplementationNote[];

  /** Linked task IDs */
  linkedTasks?: string[];
}

/**
 * User story within a feature
 */
export interface UserStory {
  /** User story ID (e.g., 'US-001') */
  id: string;

  /** As a [role] */
  role: string;

  /** I want to [action] */
  action: string;

  /** So that [benefit] */
  benefit: string;

  /** Priority */
  priority: 'must' | 'should' | 'could' | 'wont';

  /** Status */
  status: 'pending' | 'in_progress' | 'done';
}

/**
 * Acceptance criterion
 */
export interface AcceptanceCriterion {
  /** Criterion ID (e.g., 'AC-001') */
  id: string;

  /** Description of the criterion */
  description: string;

  /** Verification status */
  status: 'pending' | 'verified' | 'failed' | 'partial';

  /** How it was verified */
  verifiedBy?: 'automated' | 'manual' | 'task';

  /** Task ID that verified this */
  verifiedByTaskId?: string;

  /** Evidence of verification */
  evidence?: CriterionEvidence[];
}

/**
 * Evidence that a criterion was met
 */
export interface CriterionEvidence {
  /** Type of evidence */
  type: 'file' | 'endpoint' | 'test' | 'screenshot' | 'log';

  /** Reference to the evidence */
  reference: string;

  /** Description */
  description?: string;
}

/**
 * Technical requirement
 */
export interface TechnicalRequirement {
  /** Requirement ID */
  id: string;

  /** Tier this requirement applies to */
  tier: TierName;

  /** Requirement description */
  description: string;

  /** Implementation status */
  status: 'pending' | 'implemented' | 'verified';

  /** Implementation details (filled after implementation) */
  implementation?: {
    files: string[];
    notes?: string;
  };
}

/**
 * Reference to an API contract
 */
export interface ApiContractRef {
  /** Contract document ID */
  contractId: string;

  /** Contract document path */
  path: string;

  /** Endpoints covered */
  endpoints: string[];
}

/**
 * Reference to a data model
 */
export interface DataModelRef {
  /** Data model document ID */
  modelId: string;

  /** Data model document path */
  path: string;

  /** Tables/collections covered */
  tables: string[];
}

/**
 * Feature dependency
 */
export interface FeatureDependency {
  /** Dependency type */
  type: 'feature' | 'system' | 'external';

  /** Reference ID or name */
  reference: string;

  /** Description of the dependency */
  description: string;

  /** Whether dependency is satisfied */
  satisfied: boolean;
}

/**
 * Implementation note recorded during development
 */
export interface ImplementationNote {
  /** Timestamp */
  timestamp: string;

  /** Note content */
  content: string;

  /** Task ID that created this note */
  taskId?: string;

  /** Type of note */
  type: 'decision' | 'deviation' | 'clarification' | 'issue';
}

// ============================================================================
// API Contract
// ============================================================================

/**
 * API contract document
 */
export interface ApiContract extends SpecDocumentBase {
  type: 'api-contract';

  /** API base path */
  basePath?: string;

  /** Endpoints defined in this contract */
  endpoints: ApiEndpointSpec[];

  /** Common schemas used across endpoints */
  schemas?: ApiSchema[];

  /** Authentication requirements */
  authentication?: ApiAuthSpec;
}

/**
 * API endpoint specification
 */
export interface ApiEndpointSpec {
  /** Endpoint ID */
  id: string;

  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** Endpoint path (with params like :id) */
  path: string;

  /** Description */
  description: string;

  /** Request specification */
  request?: {
    params?: Record<string, ApiParamSpec>;
    query?: Record<string, ApiParamSpec>;
    headers?: Record<string, ApiParamSpec>;
    body?: ApiBodySpec;
  };

  /** Response specifications */
  responses: Record<string, ApiResponseSpec>;

  /** Implementation status */
  implemented: boolean;

  /** Actual implementation (filled after implementation) */
  implementation?: {
    file: string;
    handler: string;
    actualPath?: string;  // If different from spec
  };
}

/**
 * API parameter specification
 */
export interface ApiParamSpec {
  type: string;
  required: boolean;
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

/**
 * API request body specification
 */
export interface ApiBodySpec {
  contentType: string;
  schema: string | object;  // Schema name or inline
  required: boolean;
}

/**
 * API response specification
 */
export interface ApiResponseSpec {
  description: string;
  contentType?: string;
  schema?: string | object;
  example?: unknown;
}

/**
 * API schema definition
 */
export interface ApiSchema {
  name: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, ApiSchemaProperty>;
  items?: ApiSchemaProperty;  // For arrays
  required?: string[];
}

/**
 * API schema property
 */
export interface ApiSchemaProperty {
  type: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  nullable?: boolean;
  ref?: string;  // Reference to another schema
}

/**
 * API authentication specification
 */
export interface ApiAuthSpec {
  type: 'none' | 'bearer' | 'api-key' | 'oauth2' | 'basic';
  location?: 'header' | 'query' | 'cookie';
  name?: string;
  description?: string;
}

// ============================================================================
// Data Model
// ============================================================================

/**
 * Data model document
 */
export interface DataModel extends SpecDocumentBase {
  type: 'data-model';

  /** Database type */
  database: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite' | 'other';

  /** Tables/collections defined */
  tables: DataTableSpec[];

  /** Relationships between tables */
  relationships?: DataRelationship[];

  /** Indexes defined */
  indexes?: DataIndexSpec[];
}

/**
 * Table/collection specification
 */
export interface DataTableSpec {
  /** Table name */
  name: string;

  /** Description */
  description?: string;

  /** Columns/fields */
  columns: DataColumnSpec[];

  /** Primary key column(s) */
  primaryKey: string | string[];

  /** Implementation status */
  implemented: boolean;

  /** Actual implementation (filled after implementation) */
  implementation?: {
    migrationFile?: string;
    schemaFile?: string;
  };
}

/**
 * Column/field specification
 */
export interface DataColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  description?: string;
  constraints?: string[];
}

/**
 * Relationship specification
 */
export interface DataRelationship {
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  from: { table: string; column: string };
  to: { table: string; column: string };
  onDelete?: 'cascade' | 'set-null' | 'restrict' | 'no-action';
  onUpdate?: 'cascade' | 'set-null' | 'restrict' | 'no-action';
}

/**
 * Index specification
 */
export interface DataIndexSpec {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  type?: 'btree' | 'hash' | 'gin' | 'gist';
}

// ============================================================================
// Architecture Decision Record
// ============================================================================

/**
 * Architecture Decision Record (ADR)
 */
export interface ArchitectureDecisionRecord extends SpecDocumentBase {
  type: 'adr';

  /** ADR number */
  number: number;

  /** Decision status */
  decisionStatus: 'proposed' | 'accepted' | 'deprecated' | 'superseded';

  /** Context and problem statement */
  context: string;

  /** Decision made */
  decision: string;

  /** Options considered */
  options: AdrOption[];

  /** Consequences of the decision */
  consequences: {
    positive: string[];
    negative: string[];
    neutral?: string[];
  };

  /** ADR this supersedes (if any) */
  supersedes?: string;

  /** ADRs that supersede this (if any) */
  supersededBy?: string;
}

/**
 * Option considered in ADR
 */
export interface AdrOption {
  title: string;
  description: string;
  pros: string[];
  cons: string[];
  selected: boolean;
}

// ============================================================================
// Requirement Document
// ============================================================================

/**
 * Business requirement document
 */
export interface RequirementDoc extends SpecDocumentBase {
  type: 'requirement';

  /** Requirement category */
  category: 'functional' | 'non-functional' | 'business' | 'technical';

  /** Priority */
  priority: 'critical' | 'high' | 'medium' | 'low';

  /** Description of the requirement */
  description: string;

  /** Rationale */
  rationale?: string;

  /** Success metrics */
  metrics?: RequirementMetric[];

  /** Features that implement this requirement */
  implementedBy?: string[];
}

/**
 * Requirement metric
 */
export interface RequirementMetric {
  name: string;
  target: string;
  current?: string;
  met: boolean;
}

// ============================================================================
// Spec Feedback (from implementation tiers)
// ============================================================================

/**
 * Feedback from an implementation tier to update specs
 */
export interface SpecFeedback {
  /** Task ID that generated this feedback */
  taskId: string;

  /** Tier that provided feedback */
  tier: ImplementationTierName;

  /** Timestamp */
  timestamp: string;

  /** Artifacts created/modified */
  artifacts: SpecFeedbackArtifact[];

  /** Deviations from spec */
  deviations?: SpecDeviation[];

  /** Criteria evidence */
  criteriaEvidence?: CriterionEvidence[];
}

/**
 * Artifact from implementation feedback
 */
export interface SpecFeedbackArtifact {
  type: 'file' | 'endpoint' | 'table' | 'component' | 'schema';
  name: string;
  path: string;
  action: 'created' | 'modified' | 'deleted';
  details?: Record<string, unknown>;
}

/**
 * Deviation from specification
 */
export interface SpecDeviation {
  /** Spec document path */
  specPath: string;

  /** What was expected */
  expected: string;

  /** What was actually implemented */
  actual: string;

  /** Reason for deviation */
  reason: string;

  /** Timestamp */
  timestamp: string;

  /** Task that made the deviation */
  taskId: string;
}

// ============================================================================
// Spec Tier Commands
// ============================================================================

/**
 * Commands that can be sent to the spec tier
 */
export type SpecCommand =
  | SpecCreateCommand
  | SpecUpdateCommand
  | SpecSyncCommand
  | SpecQueryCommand
  | SpecStatusCommand;

export interface SpecCreateCommand {
  type: 'CREATE_SPEC';
  documentType: SpecDocumentType;
  content: Partial<FeatureSpec | ApiContract | DataModel | RequirementDoc | ArchitectureDecisionRecord>;
}

export interface SpecUpdateCommand {
  type: 'UPDATE_SPEC';
  path: string;
  updates: Record<string, unknown>;
}

export interface SpecSyncCommand {
  type: 'SYNC_FROM_TASK';
  taskId: string;
  tier: ImplementationTierName;
  feedback: SpecFeedback;
}

export interface SpecQueryCommand {
  type: 'QUERY_SPECS';
  query: {
    type?: SpecDocumentType;
    status?: SpecDocumentStatus;
    tags?: string[];
    search?: string;
  };
}

export interface SpecStatusCommand {
  type: 'UPDATE_STATUS';
  path: string;
  status: SpecDocumentStatus;
  completedTasks?: string[];
}

// ============================================================================
// Spec Tier Response Data
// ============================================================================

/**
 * Result data from spec tier operations
 */
export interface SpecTierResult {
  tier: 'spec';

  /** Documents created */
  documentsCreated?: string[];

  /** Documents updated */
  documentsUpdated?: string[];

  /** Documents queried */
  documentsFound?: SpecDocumentBase[];

  /** Criteria updated */
  criteriaUpdated?: {
    specPath: string;
    criteriaId: string;
    newStatus: AcceptanceCriterion['status'];
  }[];

  /** Deviations recorded */
  deviationsRecorded?: number;

  /** Feature status changes */
  statusChanges?: {
    specPath: string;
    oldStatus: SpecDocumentStatus;
    newStatus: SpecDocumentStatus;
  }[];
}
