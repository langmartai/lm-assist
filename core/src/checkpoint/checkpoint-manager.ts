/**
 * Checkpoint Manager
 *
 * Main class for managing checkpoints and rollback operations.
 * Uses git for state management and CheckpointStore for metadata.
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  CheckpointStore,
  createCheckpointStore,
} from './checkpoint-store';
import {
  ensureGitRepo,
  getCurrentCommit,
  getCurrentBranch,
  isWorkingTreeClean,
  commit,
  resetHard,
  resetSoft,
  resetMixed,
  checkoutFiles,
  parseDiffOutput,
  getDiffStats,
  getFileDiff,
  commitExists,
  detectTierFromPath,
  isBinaryFile,
} from './git-utils';
import type {
  Checkpoint,
  CheckpointStatus,
  CheckpointTrigger,
  CheckpointDiff,
  CheckpointManagerOptions,
  CreateCheckpointOptions,
  RollbackOptions,
  RollbackResult,
  CheckpointQueryOptions,
  CheckpointListResponse,
  FileChange,
} from '../types/checkpoint';

const DEFAULT_MAX_CHECKPOINTS = 100;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Checkpoint manager events
 */
export interface CheckpointManagerEvents {
  checkpoint_created: { checkpoint: Checkpoint };
  checkpoint_activated: { checkpoint: Checkpoint };
  checkpoint_completed: { checkpoint: Checkpoint };
  checkpoint_failed: { checkpoint: Checkpoint; error: string };
  rollback_started: { checkpoint: Checkpoint; options: RollbackOptions };
  rollback_completed: { checkpoint: Checkpoint; result: RollbackResult };
  rollback_failed: { checkpoint: Checkpoint; error: string };
}

/**
 * Checkpoint Manager
 */
export class CheckpointManager extends EventEmitter {
  private readonly projectPath: string;
  private readonly projectId: string;
  private readonly store: CheckpointStore;
  private readonly autoCheckpoint: boolean;
  private readonly defaultTtlMs: number;

  constructor(options: CheckpointManagerOptions) {
    super();
    this.projectPath = options.projectPath;
    this.projectId = options.projectId || this.generateProjectId();
    this.autoCheckpoint = options.autoCheckpoint ?? true;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;

    // Create store
    this.store = createCheckpointStore({
      projectPath: this.projectPath,
      persist: options.persist ?? true,
      maxCheckpoints: options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS,
      defaultTtlMs: this.defaultTtlMs,
    });

    // Ensure git repo exists
    ensureGitRepo(this.projectPath);
  }

  /**
   * Generate a short project ID
   */
  private generateProjectId(): string {
    return randomUUID().slice(0, 8);
  }

  /**
   * Generate a unique checkpoint ID
   */
  private generateCheckpointId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 6);
    return `cp_${timestamp}_${random}`;
  }

  /**
   * Generate human-readable label for checkpoint
   */
  private generateLabel(options: CreateCheckpointOptions): string {
    if (options.label) {
      return options.label;
    }

    const trigger = options.trigger || 'manual';
    const tier = options.tier ? ` (${options.tier})` : '';
    const date = new Date().toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    switch (trigger) {
      case 'execution_start':
        return `Before execution${tier} - ${date}`;
      case 'tier_start':
        return `Before ${options.tier || 'tier'} - ${date}`;
      case 'milestone':
        return `Milestone${tier} - ${date}`;
      case 'auto_save':
        return `Auto-save${tier} - ${date}`;
      case 'manual':
      default:
        return `Manual checkpoint${tier} - ${date}`;
    }
  }

  /**
   * Format commit message for checkpoint
   */
  private formatCommitMessage(
    checkpointId: string,
    label: string,
    options: CreateCheckpointOptions
  ): string {
    const parts = [`[CHECKPOINT] ${label}`];

    if (options.executionId) {
      parts.push(`\nExecution: ${options.executionId}`);
    }
    if (options.tier) {
      parts.push(`\nTier: ${options.tier}`);
    }
    if (options.prompt) {
      const truncatedPrompt = options.prompt.length > 100
        ? options.prompt.slice(0, 100) + '...'
        : options.prompt;
      parts.push(`\nPrompt: ${truncatedPrompt}`);
    }

    parts.push(`\nCheckpoint ID: ${checkpointId}`);

    return parts.join('');
  }

  /**
   * Create a new checkpoint
   */
  async createCheckpoint(options: CreateCheckpointOptions = {}): Promise<Checkpoint> {
    const checkpointId = this.generateCheckpointId();
    const label = this.generateLabel(options);
    const commitMessage = this.formatCommitMessage(checkpointId, label, options);

    // Commit current state
    const commitHash = commit(this.projectPath, commitMessage);
    const branch = getCurrentBranch(this.projectPath);

    // Calculate expiration
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    // Create checkpoint record
    const checkpoint: Checkpoint = {
      id: checkpointId,
      projectId: this.projectId,
      commitHash,
      branch,
      executionId: options.executionId,
      tier: options.tier,
      status: 'created',
      trigger: options.trigger || 'manual',
      label,
      description: options.description,
      prompt: options.prompt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,
      metadata: options.metadata,
    };

    // Save to store
    this.store.save(checkpoint);

    this.emit('checkpoint_created', { checkpoint });

    return checkpoint;
  }

  /**
   * Create checkpoint for execution start
   */
  async createExecutionCheckpoint(
    executionId: string,
    prompt: string,
    tier?: string
  ): Promise<Checkpoint> {
    return this.createCheckpoint({
      trigger: 'execution_start',
      executionId,
      prompt,
      tier,
      label: tier
        ? `Before ${tier} execution`
        : 'Before execution',
    });
  }

  /**
   * Activate a checkpoint (execution started)
   */
  activateCheckpoint(checkpointId: string): boolean {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint) return false;

    this.store.updateStatus(checkpointId, 'active');
    checkpoint.status = 'active';

    this.emit('checkpoint_activated', { checkpoint });
    return true;
  }

  /**
   * Mark checkpoint as completed
   */
  completeCheckpoint(checkpointId: string): boolean {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint) return false;

    this.store.updateStatus(checkpointId, 'completed');
    checkpoint.status = 'completed';

    this.emit('checkpoint_completed', { checkpoint });
    return true;
  }

  /**
   * Mark checkpoint as failed
   */
  failCheckpoint(checkpointId: string, error: string): boolean {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint) return false;

    this.store.updateStatus(checkpointId, 'failed');
    checkpoint.status = 'failed';

    this.emit('checkpoint_failed', { checkpoint, error });
    return true;
  }

  /**
   * Get diff from checkpoint to current state
   */
  async getDiff(checkpointId: string): Promise<CheckpointDiff> {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    // Verify commit exists
    if (!commitExists(this.projectPath, checkpoint.commitHash)) {
      throw new Error(`Checkpoint commit no longer exists: ${checkpoint.commitHash}`);
    }

    // Get current commit
    const currentCommit = getCurrentCommit(this.projectPath) || 'HEAD';

    // Parse diff
    const files = parseDiffOutput(this.projectPath, checkpoint.commitHash);

    // Calculate stats
    const stats = {
      filesChanged: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      byTier: {} as Record<string, number>,
    };

    // Group by tier
    for (const file of files) {
      if (file.tier) {
        stats.byTier[file.tier] = (stats.byTier[file.tier] || 0) + 1;
      }
    }

    return {
      checkpointId,
      fromCommit: checkpoint.commitHash,
      toCommit: currentCommit,
      files,
      stats,
    };
  }

  /**
   * Get detailed diff for a specific file
   */
  async getFileDiff(checkpointId: string, filePath: string): Promise<FileChange | null> {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint) return null;

    const diff = getFileDiff(this.projectPath, checkpoint.commitHash, filePath);
    const stats = getDiffStats(this.projectPath, checkpoint.commitHash, filePath);
    const tier = detectTierFromPath(filePath);
    const binary = isBinaryFile(filePath);

    return {
      path: filePath,
      tier,
      status: 'modified', // Simplified
      additions: stats.additions,
      deletions: stats.deletions,
      diff: binary ? undefined : diff,
      isBinary: binary,
    };
  }

  /**
   * Rollback to a checkpoint
   */
  async rollback(options: RollbackOptions): Promise<RollbackResult> {
    const checkpoint = this.store.get(options.checkpointId);
    if (!checkpoint) {
      return {
        success: false,
        filesRestored: 0,
        restoredFiles: [],
        errors: [`Checkpoint not found: ${options.checkpointId}`],
        checkpoint: null as unknown as Checkpoint,
      };
    }

    // Verify commit exists
    if (!commitExists(this.projectPath, checkpoint.commitHash)) {
      return {
        success: false,
        filesRestored: 0,
        restoredFiles: [],
        errors: [`Checkpoint commit no longer exists: ${checkpoint.commitHash}`],
        checkpoint,
      };
    }

    this.emit('rollback_started', { checkpoint, options });

    let backupCheckpointId: string | undefined;

    try {
      // Create backup if requested
      if (options.createBackup) {
        const backup = await this.createCheckpoint({
          trigger: 'manual',
          label: `Backup before rollback to ${checkpoint.label}`,
          description: `Auto-backup created before rolling back to checkpoint ${checkpoint.id}`,
        });
        backupCheckpointId = backup.id;
      }

      // Dry run - just return what would change
      if (options.dryRun) {
        const diff = await this.getDiff(options.checkpointId);
        return {
          success: true,
          filesRestored: diff.files.length,
          restoredFiles: diff.files.map(f => f.path),
          errors: [],
          backupCheckpointId,
          checkpoint,
        };
      }

      const scope = options.scope || 'project';
      const mode = options.mode || 'hard';
      let restoredFiles: string[] = [];

      // IMPORTANT: Capture diff BEFORE rollback operations
      // After reset, HEAD will be at checkpoint commit, making diff empty
      const diff = await this.getDiff(options.checkpointId);

      if (scope === 'project') {
        // Full project rollback
        switch (mode) {
          case 'hard':
            resetHard(this.projectPath, checkpoint.commitHash);
            break;
          case 'soft':
            resetSoft(this.projectPath, checkpoint.commitHash);
            break;
          case 'mixed':
            resetMixed(this.projectPath, checkpoint.commitHash);
            break;
        }

        restoredFiles = diff.files.map(f => f.path);
      } else if (scope === 'tier' && options.tier) {
        // Tier-specific rollback
        const tierFiles = diff.files
          .filter(f => f.tier === options.tier)
          .map(f => f.path);

        if (tierFiles.length > 0) {
          checkoutFiles(this.projectPath, checkpoint.commitHash, tierFiles);
          restoredFiles = tierFiles;
        }
      } else if (scope === 'files' && options.files && options.files.length > 0) {
        // File-specific rollback
        checkoutFiles(this.projectPath, checkpoint.commitHash, options.files);
        restoredFiles = options.files;
      }

      // Update checkpoint status
      this.store.updateStatus(options.checkpointId, 'rolled_back');
      checkpoint.status = 'rolled_back';

      const result: RollbackResult = {
        success: true,
        filesRestored: restoredFiles.length,
        restoredFiles,
        errors: [],
        backupCheckpointId,
        checkpoint,
      };

      this.emit('rollback_completed', { checkpoint, result });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.emit('rollback_failed', { checkpoint, error: errorMessage });

      return {
        success: false,
        filesRestored: 0,
        restoredFiles: [],
        errors: [errorMessage],
        backupCheckpointId,
        checkpoint,
      };
    }
  }

  /**
   * Keep changes (don't rollback)
   */
  async keepChanges(checkpointId: string): Promise<boolean> {
    return this.store.updateStatus(checkpointId, 'kept');
  }

  /**
   * Get checkpoint by ID
   */
  getCheckpoint(id: string): Checkpoint | null {
    return this.store.get(id);
  }

  /**
   * List checkpoints with optional filters
   */
  listCheckpoints(options?: CheckpointQueryOptions): CheckpointListResponse {
    return this.store.query(options);
  }

  /**
   * Get checkpoint for an execution
   */
  getExecutionCheckpoint(executionId: string): Checkpoint | null {
    return this.store.getByExecutionId(executionId);
  }

  /**
   * Update checkpoint status
   */
  updateStatus(id: string, status: CheckpointStatus): boolean {
    return this.store.updateStatus(id, status);
  }

  /**
   * Delete a checkpoint
   */
  deleteCheckpoint(id: string): boolean {
    return this.store.delete(id);
  }

  /**
   * Cleanup old checkpoints
   */
  cleanupOldCheckpoints(): number {
    return this.store.cleanupExpired();
  }

  /**
   * Get statistics
   */
  getStats() {
    return this.store.getStats();
  }

  /**
   * Get the store for direct access
   */
  getStore(): CheckpointStore {
    return this.store;
  }

  /**
   * Check if auto-checkpoint is enabled
   */
  isAutoCheckpointEnabled(): boolean {
    return this.autoCheckpoint;
  }
}

/**
 * Create a checkpoint manager instance
 */
export function createCheckpointManager(
  options: CheckpointManagerOptions
): CheckpointManager {
  return new CheckpointManager(options);
}
