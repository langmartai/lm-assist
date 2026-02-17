/**
 * Checkpoint & Rollback Types
 *
 * Types for the git-based checkpoint system that enables task cancellation
 * with state recovery.
 */

/**
 * Checkpoint status lifecycle
 */
export type CheckpointStatus =
  | 'created'     // Checkpoint created, not yet active
  | 'active'      // Execution in progress
  | 'completed'   // Execution completed successfully
  | 'failed'      // Execution failed
  | 'rolled_back' // User rolled back to this checkpoint
  | 'kept'        // User kept changes after viewing diff
  | 'abandoned'   // User abandoned without decision
  | 'expired'     // TTL expired, eligible for cleanup
  | 'deleted';    // Soft deleted

/**
 * What triggered checkpoint creation
 */
export type CheckpointTrigger =
  | 'execution_start'  // Auto-created at execution start
  | 'tier_start'       // Auto-created when tier begins
  | 'milestone'        // Created at milestone completion
  | 'manual'           // User-initiated checkpoint
  | 'auto_save';       // Periodic auto-save

/**
 * Scope for rollback operations
 */
export type CheckpointScope =
  | 'project'  // Rollback entire project
  | 'tier'     // Rollback specific tier only
  | 'files';   // Rollback specific files only

/**
 * File change status
 */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * Individual file change in a diff
 */
export interface FileChange {
  /** File path relative to project root */
  path: string;
  /** Which tier this file belongs to */
  tier?: string;
  /** Type of change */
  status: FileChangeStatus;
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
  /** Unified diff content (optional, for detailed view) */
  diff?: string;
  /** Whether file is binary */
  isBinary?: boolean;
  /** Old path if renamed */
  oldPath?: string;
}

/**
 * Diff between checkpoint and current state
 */
export interface CheckpointDiff {
  /** Checkpoint this diff is from */
  checkpointId: string;
  /** Commit hash at checkpoint */
  fromCommit: string;
  /** Current commit hash (or HEAD) */
  toCommit: string;
  /** List of changed files */
  files: FileChange[];
  /** Summary statistics */
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
    /** Files grouped by tier */
    byTier: Record<string, number>;
  };
}

/**
 * Core checkpoint record
 */
export interface Checkpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Project ID this checkpoint belongs to */
  projectId: string;
  /** Git commit hash at checkpoint */
  commitHash: string;
  /** Git branch name */
  branch: string;
  /** Associated execution ID */
  executionId?: string;
  /** Associated tier (if tier-specific) */
  tier?: string;
  /** Current status */
  status: CheckpointStatus;
  /** What triggered this checkpoint */
  trigger: CheckpointTrigger;
  /** Human-readable label */
  label: string;
  /** Optional description */
  description?: string;
  /** Original prompt that initiated execution */
  prompt?: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** When checkpoint expires (for cleanup) */
  expiresAt?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a checkpoint
 */
export interface CreateCheckpointOptions {
  /** Optional custom label */
  label?: string;
  /** Optional description */
  description?: string;
  /** Trigger type */
  trigger?: CheckpointTrigger;
  /** Associated execution ID */
  executionId?: string;
  /** Associated tier */
  tier?: string;
  /** Original prompt */
  prompt?: string;
  /** Scope of checkpoint */
  scope?: CheckpointScope;
  /** Time-to-live in milliseconds */
  ttlMs?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Rollback mode
 */
export type RollbackMode =
  | 'hard'   // git reset --hard (discard all changes)
  | 'soft'   // git reset --soft (keep changes staged)
  | 'mixed'; // git reset --mixed (keep changes unstaged)

/**
 * Options for rollback operation
 */
export interface RollbackOptions {
  /** Checkpoint ID to rollback to */
  checkpointId: string;
  /** Scope of rollback */
  scope?: CheckpointScope;
  /** Specific tier to rollback (if scope is 'tier') */
  tier?: string;
  /** Specific files to rollback (if scope is 'files') */
  files?: string[];
  /** Rollback mode */
  mode?: RollbackMode;
  /** Create backup checkpoint before rollback */
  createBackup?: boolean;
  /** Dry run - don't actually rollback, just show what would change */
  dryRun?: boolean;
}

/**
 * Result of rollback operation
 */
export interface RollbackResult {
  /** Whether rollback succeeded */
  success: boolean;
  /** Number of files restored */
  filesRestored: number;
  /** List of restored file paths */
  restoredFiles: string[];
  /** Any errors encountered */
  errors: string[];
  /** Backup checkpoint ID (if createBackup was true) */
  backupCheckpointId?: string;
  /** The checkpoint that was rolled back to */
  checkpoint: Checkpoint;
}

/**
 * Options for querying checkpoints
 */
export interface CheckpointQueryOptions {
  /** Filter by execution ID */
  executionId?: string;
  /** Filter by tier */
  tier?: string;
  /** Filter by status */
  status?: CheckpointStatus | CheckpointStatus[];
  /** Filter by trigger */
  trigger?: CheckpointTrigger | CheckpointTrigger[];
  /** Include expired checkpoints */
  includeExpired?: boolean;
  /** Maximum number to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Response from listing checkpoints
 */
export interface CheckpointListResponse {
  /** List of checkpoints */
  checkpoints: Checkpoint[];
  /** Total count (for pagination) */
  total: number;
  /** Whether there are more results */
  hasMore: boolean;
}

/**
 * Checkpoint store options
 */
export interface CheckpointStoreOptions {
  /** Project path */
  projectPath: string;
  /** Whether to persist to disk */
  persist?: boolean;
  /** Maximum checkpoints to keep */
  maxCheckpoints?: number;
  /** Default TTL in milliseconds */
  defaultTtlMs?: number;
}

/**
 * Checkpoint manager options
 */
export interface CheckpointManagerOptions {
  /** Project path */
  projectPath: string;
  /** Project ID */
  projectId?: string;
  /** Whether to persist checkpoints */
  persist?: boolean;
  /** Maximum checkpoints to keep */
  maxCheckpoints?: number;
  /** Default TTL in milliseconds (default: 7 days) */
  defaultTtlMs?: number;
  /** Auto-create checkpoint on execution start */
  autoCheckpoint?: boolean;
}

/**
 * Cancel execution options
 */
export interface CancelExecutionOptions {
  /** Execution ID to cancel */
  executionId: string;
  /** Whether to rollback changes */
  rollback?: boolean;
  /** Whether to keep changes */
  keepChanges?: boolean;
  /** Rollback scope if rolling back */
  rollbackScope?: CheckpointScope;
  /** Specific tier to rollback */
  rollbackTier?: string;
  /** Specific files to rollback */
  rollbackFiles?: string[];
}

/**
 * Result of cancel execution
 */
export interface CancelExecutionResult {
  /** Whether execution was aborted */
  aborted: boolean;
  /** Whether changes were rolled back */
  rolledBack: boolean;
  /** The checkpoint associated with this execution */
  checkpoint?: Checkpoint;
  /** Diff of changes made during execution */
  diff?: CheckpointDiff;
  /** Whether user needs to make rollback decision */
  pendingDecision: boolean;
  /** Error message if any */
  error?: string;
}

/**
 * Checkpoint API interface for control-api
 */
export interface CheckpointApi {
  /** Create a new checkpoint */
  create(options?: CreateCheckpointOptions): Promise<Checkpoint>;
  /** Get checkpoint by ID */
  get(id: string): Promise<Checkpoint | null>;
  /** List checkpoints with optional filters */
  list(options?: CheckpointQueryOptions): Promise<CheckpointListResponse>;
  /** Get diff from checkpoint to current state */
  getDiff(checkpointId: string): Promise<CheckpointDiff>;
  /** Rollback to checkpoint */
  rollback(options: RollbackOptions): Promise<RollbackResult>;
  /** Mark checkpoint as kept (user kept changes) */
  keep(checkpointId: string): Promise<void>;
  /** Delete checkpoint */
  delete(checkpointId: string): Promise<void>;
  /** Get checkpoint for execution */
  getForExecution(executionId: string): Promise<Checkpoint | null>;
  /** Cancel execution with optional rollback */
  cancelExecution(options: CancelExecutionOptions): Promise<CancelExecutionResult>;
}
