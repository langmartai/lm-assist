/**
 * Type System Index (lm-assist)
 *
 * Exports all types from the type system.
 * Stripped of: vibe-coder, journey, preflight, project-spec, request-history
 */

// Core protocol types
export * from './instruction-protocol';
export * from './response-protocol';
export * from './error-protocol';
export * from './orchestrator-commands';

// Event types
export * from './sdk-events';
export * from './sdk-event-handlers';

// Tier types
export * from './orchestrator';
export * from './control-api';

// New tier types
export * from './spec-tier';
export * from './task-tier';

// Template types
export * from './templates';

// Visual editor types
export * from './visual-editor';

// Checkpoint types (rename FileChange to avoid conflict with orchestrator.ts)
export {
  CheckpointStatus,
  CheckpointTrigger,
  CheckpointScope,
  FileChangeStatus,
  FileChange as CheckpointFileChange,
  CheckpointDiff,
  Checkpoint,
  CreateCheckpointOptions,
  RollbackMode,
  RollbackOptions,
  RollbackResult,
  CheckpointQueryOptions,
  CheckpointListResponse,
  CheckpointStoreOptions,
  CheckpointManagerOptions,
  CancelExecutionOptions,
  CancelExecutionResult,
  CheckpointApi,
} from './checkpoint';

// Agent API types (direct SDK access)
export * from './agent-api';
