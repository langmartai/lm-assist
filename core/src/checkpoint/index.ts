/**
 * Checkpoint Module
 *
 * Exports checkpoint management functionality for task cancellation
 * with state recovery using git-based checkpoints.
 */

// Main classes
export {
  CheckpointManager,
  createCheckpointManager,
  type CheckpointManagerEvents,
} from './checkpoint-manager';

export {
  CheckpointStore,
  createCheckpointStore,
  type CheckpointStoreEvents,
} from './checkpoint-store';

// Git utilities
export * as gitUtils from './git-utils';
export {
  gitCommand,
  isGitRepo,
  ensureGitRepo,
  getCurrentCommit,
  getCurrentBranch,
  isWorkingTreeClean,
  stageAll,
  stageFiles,
  commit,
  getDiffFiles,
  getDiffStats,
  getFileDiff,
  getFileStatus,
  parseDiffOutput,
  detectTierFromPath,
  isBinaryFile,
  resetHard,
  resetSoft,
  resetMixed,
  checkoutFile,
  checkoutFiles,
  getCommitMessage,
  getCommitDate,
  commitExists,
  getCommitCount,
  stash,
  stashPop,
  getFilesAtCommit,
} from './git-utils';

// Re-export types
export type {
  // Status types
  CheckpointStatus,
  CheckpointTrigger,
  CheckpointScope,
  FileChangeStatus,
  RollbackMode,
  // Data types
  FileChange,
  CheckpointDiff,
  Checkpoint,
  // Options types
  CreateCheckpointOptions,
  RollbackOptions,
  CheckpointQueryOptions,
  CheckpointStoreOptions,
  CheckpointManagerOptions,
  CancelExecutionOptions,
  // Result types
  RollbackResult,
  CancelExecutionResult,
  CheckpointListResponse,
  // API types
  CheckpointApi,
} from '../types/checkpoint';
