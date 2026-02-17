/**
 * Task Tier Type Definitions
 *
 * Aligned with Task schema from tasks-service.ts
 * Extended fields are stored in the metadata property.
 */

import type { ImplementationTierName } from './instruction-protocol';
import type { Task } from '../tasks-service';

// Re-export Task types as the base
export type {
  Task,
  TaskList,
  TaskListSummary,
  CreateTaskInput,
  UpdateTaskInput,
} from '../tasks-service';

// ============================================================================
// Task Status (aligned with Task)
// ============================================================================

/**
 * Task status - matches Task.status
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

// ============================================================================
// Backwards Compatibility Types
// ============================================================================

/**
 * TaskDocument - Task with typed metadata and convenience properties
 *
 * Core Task fields:
 * - id, subject, description, activeForm, status, blocks, blockedBy, owner, metadata
 *
 * Extended fields stored in metadata are exposed as optional properties for backwards compatibility.
 */
export interface TaskDocument extends Task {
  // Convenience aliases (these should access metadata.* in implementation)
  /** @deprecated Use subject instead */
  title?: string;
  /** @deprecated Use blockedBy instead */
  dependencies?: TaskDependency[];
  /** Stored in metadata.path - file path if needed */
  path?: string;
  /** Stored in metadata.createdAt */
  createdAt?: string;
  /** Stored in metadata.updatedAt */
  updatedAt?: string;
  /** Stored in metadata.tier */
  tier?: ImplementationTierName | 'multi-tier';
  /** Stored in metadata.type */
  type?: TaskType;
  /** Stored in metadata.priority */
  priority?: TaskPriority;
  /** Stored in metadata.objective */
  objective?: string;
  /** Stored in metadata.specReference */
  specReference?: TaskSpecReference;
  /** Stored in metadata.specId */
  specId?: string;
  /** Stored in metadata.instructions */
  instructions?: string[];
  /** Stored in metadata.expectedArtifacts */
  expectedArtifacts?: TaskExpectedArtifact[];
  /** Stored in metadata.actualArtifacts */
  actualArtifacts?: TaskActualArtifact[];
  /** Stored in metadata.acceptanceCriteria */
  acceptanceCriteria?: TaskAcceptanceCriterion[];
  /** Stored in metadata.executionLog */
  executionLog?: TaskExecutionEntry[];
  /** Stored in metadata.execution */
  execution?: TaskExecutionDetails;
  /** Stored in metadata.tags */
  tags?: string[];
  /** Stored in metadata.notes */
  notes?: string;
  /** Stored in metadata.parentTaskId */
  parentTaskId?: string;
  /** Stored in metadata.subTaskIds */
  subTaskIds?: string[];
  /** Stored in metadata for backwards compatibility */
  implementation?: TaskImplementation;
}

/**
 * TaskImplementation - for backwards compatibility
 */
export interface TaskImplementation {
  instructions: string[];
  expectedArtifacts: TaskExpectedArtifact[];
  patterns?: string[];
  targetFiles?: string[];
  actualArtifacts?: TaskActualArtifact[];
}

/**
 * Task dependency - simplified for Task compatibility
 * @deprecated Use blockedBy/blocks arrays directly
 */
export interface TaskDependency {
  taskId: string;
  type: 'blocks' | 'requires' | 'relates';
  satisfied: boolean;
  description?: string;
}

/**
 * Task execution events
 */
export type TaskExecutionEvent =
  | 'created'
  | 'started'
  | 'impl_assigned'
  | 'impl_started'
  | 'impl_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'unblocked'
  | 'cancelled'
  | 'retried'
  | 'status_changed'
  | 'note_added';

/**
 * Result data from task tier operations
 */
export interface TaskTierResult {
  tier: 'task';
  tasksCreated?: string[];
  tasksUpdated?: string[];
  tasksFound?: Task[];
  breakdown?: TaskBreakdownResult;
  readyTasks?: string[];
  blockedTasks?: Array<{ taskId: string; blockedBy: string[] }>;
  executionOrder?: string[];
}

// ============================================================================
// Extended Metadata Types
// ============================================================================

/**
 * Type of task (stored in metadata.type)
 */
export type TaskType =
  | 'implementation'
  | 'bug-fix'
  | 'refactor'
  | 'spike'
  | 'tech-debt'
  | 'multi-tier';

/**
 * Priority level (stored in metadata.priority)
 */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Reference to source specification (stored in metadata.specReference)
 */
export interface TaskSpecReference {
  specPath: string;
  section?: string;
  userStoryId?: string;
  requirementId?: string;
}

/**
 * Expected artifact from task (stored in metadata.expectedArtifacts)
 */
export interface TaskExpectedArtifact {
  type: 'file' | 'endpoint' | 'table' | 'component' | 'migration' | 'test';
  expected: string;
  description?: string;
}

/**
 * Actual artifact created by task (stored in metadata.actualArtifacts)
 */
export interface TaskActualArtifact {
  type: 'file' | 'endpoint' | 'table' | 'component' | 'migration' | 'test';
  path: string;
  action: 'created' | 'modified' | 'deleted';
  description?: string;
}

/**
 * Acceptance criterion (stored in metadata.acceptanceCriteria)
 */
export interface TaskAcceptanceCriterion {
  id: string;
  description: string;
  status: 'pending' | 'met' | 'not-met' | 'partial';
  evidence?: string;
  specCriterionId?: string;
}

/**
 * Execution log entry (stored in metadata.executionLog)
 */
export interface TaskExecutionEntry {
  timestamp: string;
  event: string;
  details: string;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

/**
 * Execution details for in-progress tasks (stored in metadata.execution)
 */
export interface TaskExecutionDetails {
  executionId: string;
  tier: ImplementationTierName;
  sessionId?: string;
  startedAt: string;
  lastProgressAt?: string;
  progressPercent?: number;
  currentStage?: string;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
}

/**
 * Extended metadata stored in Task.metadata
 */
export interface TaskMetadata {
  // Core extended fields
  tier?: ImplementationTierName | 'multi-tier';
  type?: TaskType;
  priority?: TaskPriority;
  objective?: string;

  // Spec reference
  specReference?: TaskSpecReference;
  specId?: string;

  // Implementation details
  instructions?: string[];
  expectedArtifacts?: TaskExpectedArtifact[];
  actualArtifacts?: TaskActualArtifact[];
  patterns?: string[];
  targetFiles?: string[];

  // Acceptance criteria
  acceptanceCriteria?: TaskAcceptanceCriterion[];

  // Execution tracking
  executionLog?: TaskExecutionEntry[];
  execution?: TaskExecutionDetails;

  // Organization
  tags?: string[];
  notes?: string;
  parentTaskId?: string;
  subTaskIds?: string[];

  // Timestamps
  createdAt?: string;
  updatedAt?: string;

  // Allow additional fields
  [key: string]: unknown;
}

// ============================================================================
// Task Breakdown Types
// ============================================================================

/**
 * Result of breaking down a specification into tasks
 */
export interface TaskBreakdownResult {
  success: boolean;
  specPath: string;
  tasks: Task[];
  taskIds: string[];
  executionOrder: string[];
  dependencyGraph: TaskDependencyGraph;
  totalComplexity: 'simple' | 'moderate' | 'complex';
  warnings?: string[];
  error?: string;
}

/**
 * Dependency graph for task execution
 */
export interface TaskDependencyGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  parallelGroups: string[][];
}

// ============================================================================
// Task Query Types
// ============================================================================

/**
 * Query options for listing tasks
 */
export interface TaskQuery {
  status?: TaskStatus | TaskStatus[];
  tier?: (ImplementationTierName | 'multi-tier') | (ImplementationTierName | 'multi-tier')[];
  type?: TaskType | TaskType[];
  priority?: TaskPriority | TaskPriority[];
  specPath?: string;
  tags?: string[];
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'priority' | 'createdAt' | 'updatedAt' | 'status';
  sortDirection?: 'asc' | 'desc';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a new task ID
 */
export function generateTaskId(prefix: string = 'TASK'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${prefix}-${timestamp}-${random}`.toUpperCase();
}

/**
 * Get metadata from a Task
 */
export function getTaskMetadata(task: { metadata?: Record<string, unknown> }): TaskMetadata {
  return (task.metadata || {}) as TaskMetadata;
}

/**
 * Check if a task is blocked (has incomplete blockedBy)
 */
export function isTaskBlocked(task: { blockedBy: string[] }, completedTaskIds: Set<string>): boolean {
  return task.blockedBy.some(id => !completedTaskIds.has(id));
}

/**
 * Get blocking task IDs that are not yet completed
 */
export function getBlockingTaskIds(task: { blockedBy: string[] }, completedTaskIds: Set<string>): string[] {
  return task.blockedBy.filter(id => !completedTaskIds.has(id));
}

/**
 * Calculate task completion percentage from acceptance criteria
 */
export function calculateTaskCompletion(metadata: TaskMetadata): number {
  const criteria = metadata.acceptanceCriteria || [];
  if (criteria.length === 0) return 0;

  const met = criteria.filter(c => c.status === 'met').length;
  const partial = criteria.filter(c => c.status === 'partial').length;

  return Math.round(((met + partial * 0.5) / criteria.length) * 100);
}

/**
 * Map old status values to new Task status
 */
export function mapLegacyStatus(oldStatus: string): TaskStatus {
  switch (oldStatus) {
    case 'pending':
    case 'blocked':
      return 'pending';
    case 'active':
    case 'impl_started':
      return 'in_progress';
    case 'done':
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'completed'; // Treat as completed with error in metadata
    default:
      return 'pending';
  }
}
