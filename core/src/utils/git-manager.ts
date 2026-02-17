/**
 * Git Manager
 *
 * Handles git operations for the orchestrator:
 * - Staging changes
 * - Creating commits with structured messages
 * - Pushing to remotes
 * - Branch management
 */

import { spawnSync, SpawnSyncReturns } from 'child_process';
import * as path from 'path';
import type { SessionChanges, TrackedFileChange } from './change-tracker';

// ============================================================================
// Types
// ============================================================================

/**
 * Git operation result
 */
export interface GitOperationResult {
  success: boolean;
  operation: 'stage' | 'commit' | 'push' | 'branch' | 'status' | 'reset';
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Commit info for creating commits
 */
export interface CommitInfo {
  /** Request ID for traceability */
  requestId: string;
  /** Tier name (if tier-specific commit) */
  tier?: string;
  /** Task description/summary */
  taskSummary: string;
  /** Detailed description of changes */
  description?: string;
  /** Files that were changed */
  filesChanged?: string[];
  /** Co-author attribution */
  coAuthor?: string;
  /** Additional metadata for commit body */
  metadata?: Record<string, string | number>;
}

/**
 * Push options
 */
export interface PushOptions {
  /** Remote name (default: origin) */
  remote?: string;
  /** Branch to push (default: current branch) */
  branch?: string;
  /** Set upstream tracking */
  setUpstream?: boolean;
  /** Force push (use with caution) */
  force?: boolean;
}

/**
 * Git commit result
 */
export interface GitCommitResult extends GitOperationResult {
  operation: 'commit';
  /** Commit hash (short) */
  commitHash?: string;
  /** Full commit message */
  commitMessage?: string;
  /** Files included in commit */
  filesCommitted?: string[];
  /** Lines added */
  linesAdded?: number;
  /** Lines removed */
  linesRemoved?: number;
}

/**
 * Git push result
 */
export interface GitPushResult extends GitOperationResult {
  operation: 'push';
  /** Remote name */
  remote?: string;
  /** Branch name */
  branch?: string;
  /** Remote URL */
  remoteUrl?: string;
}

/**
 * Git status info
 */
export interface GitStatusInfo {
  /** Is this a git repository */
  isGitRepo: boolean;
  /** Current branch name */
  branch?: string;
  /** Current commit hash */
  commitHash?: string;
  /** Are there uncommitted changes */
  hasChanges: boolean;
  /** Are there staged changes */
  hasStaged: boolean;
  /** Are there unstaged changes */
  hasUnstaged: boolean;
  /** Are there untracked files */
  hasUntracked: boolean;
  /** Number of commits ahead of remote */
  aheadBy?: number;
  /** Number of commits behind remote */
  behindBy?: number;
  /** Staged files */
  stagedFiles: string[];
  /** Modified files (unstaged) */
  modifiedFiles: string[];
  /** Untracked files */
  untrackedFiles: string[];
}

/**
 * Git manager configuration
 */
export interface GitManagerConfig {
  /** Working directory */
  workingDirectory: string;
  /** Default remote name */
  defaultRemote?: string;
  /** Default branch for push */
  defaultBranch?: string;
  /** Default co-author for commits */
  defaultCoAuthor?: string;
  /** Whether to auto-push after commit */
  autoPush?: boolean;
  /** Whether to sign commits */
  signCommits?: boolean;
  /** Commit message prefix */
  commitPrefix?: string;
}

// ============================================================================
// Git Manager Implementation
// ============================================================================

/**
 * Git Manager for orchestrator git operations
 */
export class GitManager {
  private config: Required<GitManagerConfig>;
  private isGitRepo: boolean;

  constructor(config: GitManagerConfig) {
    this.config = {
      workingDirectory: config.workingDirectory,
      defaultRemote: config.defaultRemote ?? 'origin',
      defaultBranch: config.defaultBranch ?? '',
      defaultCoAuthor: config.defaultCoAuthor ?? 'Claude <noreply@anthropic.com>',
      autoPush: config.autoPush ?? false,
      signCommits: config.signCommits ?? false,
      commitPrefix: config.commitPrefix ?? '',
    };
    this.isGitRepo = this.checkGitRepo();
  }

  /**
   * Check if working directory is a git repository
   */
  private checkGitRepo(): boolean {
    const result = this.runGit(['rev-parse', '--git-dir']);
    return result.status === 0;
  }

  /**
   * Run a git command safely
   */
  private runGit(args: string[], options?: { maxBuffer?: number }): SpawnSyncReturns<string> {
    return spawnSync('git', args, {
      cwd: this.config.workingDirectory,
      encoding: 'utf-8',
      maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
    });
  }

  /**
   * Get current git status
   */
  getStatus(): GitStatusInfo {
    if (!this.isGitRepo) {
      return {
        isGitRepo: false,
        hasChanges: false,
        hasStaged: false,
        hasUnstaged: false,
        hasUntracked: false,
        stagedFiles: [],
        modifiedFiles: [],
        untrackedFiles: [],
      };
    }

    // Get branch
    const branchResult = this.runGit(['branch', '--show-current']);
    const branch = branchResult.status === 0 ? branchResult.stdout.trim() : undefined;

    // Get commit hash
    const commitResult = this.runGit(['rev-parse', '--short', 'HEAD']);
    const commitHash = commitResult.status === 0 ? commitResult.stdout.trim() : undefined;

    // Get status
    const statusResult = this.runGit(['status', '--porcelain']);
    const statusLines = statusResult.status === 0
      ? statusResult.stdout.split('\n').filter(l => l.trim())
      : [];

    const stagedFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of statusLines) {
      const staged = line[0];
      const unstaged = line[1];
      const file = line.substring(3).trim();

      if (staged !== ' ' && staged !== '?') {
        stagedFiles.push(file);
      }
      if (unstaged !== ' ' && unstaged !== '?') {
        modifiedFiles.push(file);
      }
      if (staged === '?' && unstaged === '?') {
        untrackedFiles.push(file);
      }
    }

    // Get ahead/behind status
    let aheadBy: number | undefined;
    let behindBy: number | undefined;

    const trackingResult = this.runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (trackingResult.status === 0) {
      const [behind, ahead] = trackingResult.stdout.trim().split('\t').map(Number);
      aheadBy = ahead;
      behindBy = behind;
    }

    return {
      isGitRepo: true,
      branch,
      commitHash,
      hasChanges: statusLines.length > 0,
      hasStaged: stagedFiles.length > 0,
      hasUnstaged: modifiedFiles.length > 0,
      hasUntracked: untrackedFiles.length > 0,
      aheadBy,
      behindBy,
      stagedFiles,
      modifiedFiles,
      untrackedFiles,
    };
  }

  /**
   * Get current branch name
   */
  getCurrentBranch(): string | undefined {
    const result = this.runGit(['branch', '--show-current']);
    return result.status === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * Stage files for commit
   */
  stageFiles(files?: string[]): GitOperationResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'stage', error: 'Not a git repository' };
    }

    const args = files && files.length > 0
      ? ['add', '--', ...files]
      : ['add', '-A'];

    const result = this.runGit(args);

    if (result.status !== 0) {
      return {
        success: false,
        operation: 'stage',
        error: result.stderr || 'Failed to stage files',
      };
    }

    return {
      success: true,
      operation: 'stage',
      message: files ? `Staged ${files.length} files` : 'Staged all changes',
      details: { files: files || ['all'] },
    };
  }

  /**
   * Stage specific file patterns
   */
  stagePattern(pattern: string): GitOperationResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'stage', error: 'Not a git repository' };
    }

    const result = this.runGit(['add', pattern]);

    if (result.status !== 0) {
      return {
        success: false,
        operation: 'stage',
        error: result.stderr || 'Failed to stage files',
      };
    }

    return {
      success: true,
      operation: 'stage',
      message: `Staged files matching: ${pattern}`,
    };
  }

  /**
   * Reset staged changes
   */
  unstageAll(): GitOperationResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'reset', error: 'Not a git repository' };
    }

    const result = this.runGit(['reset', 'HEAD']);

    return {
      success: result.status === 0,
      operation: 'reset',
      message: result.status === 0 ? 'Unstaged all changes' : undefined,
      error: result.status !== 0 ? (result.stderr || 'Failed to unstage') : undefined,
    };
  }

  /**
   * Build a structured commit message
   */
  buildCommitMessage(info: CommitInfo): string {
    const lines: string[] = [];

    // Subject line
    const prefix = this.config.commitPrefix ? `${this.config.commitPrefix} ` : '';
    const tierPrefix = info.tier ? `[${info.tier}] ` : '';
    lines.push(`${prefix}${tierPrefix}${info.taskSummary}`);
    lines.push('');

    // Description
    if (info.description) {
      lines.push(info.description);
      lines.push('');
    }

    // Files changed
    if (info.filesChanged && info.filesChanged.length > 0) {
      lines.push('Files changed:');
      for (const file of info.filesChanged.slice(0, 20)) {
        lines.push(`  - ${file}`);
      }
      if (info.filesChanged.length > 20) {
        lines.push(`  ... and ${info.filesChanged.length - 20} more`);
      }
      lines.push('');
    }

    // Metadata
    if (info.metadata) {
      for (const [key, value] of Object.entries(info.metadata)) {
        lines.push(`${key}: ${value}`);
      }
      lines.push('');
    }

    // Request ID for traceability
    lines.push(`Request-ID: ${info.requestId}`);

    // Co-author
    const coAuthor = info.coAuthor || this.config.defaultCoAuthor;
    if (coAuthor) {
      lines.push('');
      lines.push(`Co-Authored-By: ${coAuthor}`);
    }

    return lines.join('\n');
  }

  /**
   * Create a commit
   */
  commit(info: CommitInfo): GitCommitResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'commit', error: 'Not a git repository' };
    }

    // Check if there are staged changes
    const status = this.getStatus();
    if (!status.hasStaged) {
      return {
        success: false,
        operation: 'commit',
        error: 'No staged changes to commit',
      };
    }

    // Build commit message
    const message = this.buildCommitMessage(info);

    // Build commit command
    const args = ['commit', '-m', message];
    if (this.config.signCommits) {
      args.push('-S');
    }

    const result = this.runGit(args);

    if (result.status !== 0) {
      return {
        success: false,
        operation: 'commit',
        error: result.stderr || 'Failed to create commit',
      };
    }

    // Get commit hash
    const hashResult = this.runGit(['rev-parse', '--short', 'HEAD']);
    const commitHash = hashResult.status === 0 ? hashResult.stdout.trim() : undefined;

    // Get diff stats
    const statsResult = this.runGit(['diff', '--shortstat', 'HEAD~1..HEAD']);
    let linesAdded = 0;
    let linesRemoved = 0;
    if (statsResult.status === 0) {
      const match = statsResult.stdout.match(/(\d+) insertion[s]?\(\+\).*?(\d+) deletion[s]?\(-\)/);
      if (match) {
        linesAdded = parseInt(match[1], 10);
        linesRemoved = parseInt(match[2], 10);
      }
    }

    return {
      success: true,
      operation: 'commit',
      message: `Created commit ${commitHash}`,
      commitHash,
      commitMessage: message,
      filesCommitted: status.stagedFiles,
      linesAdded,
      linesRemoved,
    };
  }

  /**
   * Push to remote
   */
  push(options?: PushOptions): GitPushResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'push', error: 'Not a git repository' };
    }

    const remote = options?.remote || this.config.defaultRemote;
    // Use || instead of ?? to handle empty strings
    const branch = options?.branch || this.config.defaultBranch || this.getCurrentBranch();

    if (!branch) {
      return {
        success: false,
        operation: 'push',
        error: 'Could not determine branch to push',
      };
    }

    const args = ['push'];
    if (options?.setUpstream) {
      args.push('-u');
    }
    if (options?.force) {
      args.push('--force-with-lease');
    }
    args.push(remote, branch);

    const result = this.runGit(args);

    if (result.status !== 0) {
      return {
        success: false,
        operation: 'push',
        error: result.stderr || 'Failed to push',
        remote,
        branch,
      };
    }

    // Get remote URL
    const urlResult = this.runGit(['remote', 'get-url', remote]);
    const remoteUrl = urlResult.status === 0 ? urlResult.stdout.trim() : undefined;

    return {
      success: true,
      operation: 'push',
      message: `Pushed to ${remote}/${branch}`,
      remote,
      branch,
      remoteUrl,
    };
  }

  /**
   * Commit and optionally push
   */
  commitAndPush(info: CommitInfo, pushOptions?: PushOptions): {
    commit: GitCommitResult;
    push?: GitPushResult;
  } {
    const commitResult = this.commit(info);

    if (!commitResult.success) {
      return { commit: commitResult };
    }

    // Push if auto-push enabled or explicitly requested
    if (this.config.autoPush || pushOptions) {
      const pushResult = this.push(pushOptions);
      return { commit: commitResult, push: pushResult };
    }

    return { commit: commitResult };
  }

  /**
   * Create a branch
   */
  createBranch(branchName: string, checkout: boolean = true): GitOperationResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'branch', error: 'Not a git repository' };
    }

    const args = checkout
      ? ['checkout', '-b', branchName]
      : ['branch', branchName];

    const result = this.runGit(args);

    if (result.status !== 0) {
      return {
        success: false,
        operation: 'branch',
        error: result.stderr || 'Failed to create branch',
      };
    }

    return {
      success: true,
      operation: 'branch',
      message: `Created branch ${branchName}${checkout ? ' and checked out' : ''}`,
      details: { branchName, checkout },
    };
  }

  /**
   * Checkout a branch
   */
  checkoutBranch(branchName: string): GitOperationResult {
    if (!this.isGitRepo) {
      return { success: false, operation: 'branch', error: 'Not a git repository' };
    }

    const result = this.runGit(['checkout', branchName]);

    if (result.status !== 0) {
      return {
        success: false,
        operation: 'branch',
        error: result.stderr || 'Failed to checkout branch',
      };
    }

    return {
      success: true,
      operation: 'branch',
      message: `Checked out branch ${branchName}`,
    };
  }

  /**
   * Get recent commits
   */
  getRecentCommits(count: number = 10): Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    date: Date;
  }> {
    if (!this.isGitRepo) return [];

    const result = this.runGit([
      'log',
      `--max-count=${count}`,
      '--format=%H|%h|%s|%an|%aI',
    ]);

    if (result.status !== 0) return [];

    return result.stdout
      .split('\n')
      .filter(l => l.trim())
      .map(line => {
        const [hash, shortHash, subject, author, date] = line.split('|');
        return {
          hash,
          shortHash,
          subject,
          author,
          date: new Date(date),
        };
      });
  }

  /**
   * Check if there are unpushed commits
   */
  hasUnpushedCommits(): boolean {
    const status = this.getStatus();
    return (status.aheadBy ?? 0) > 0;
  }

  /**
   * Get diff summary for uncommitted changes
   */
  getDiffSummary(): {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
  } {
    if (!this.isGitRepo) {
      return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    }

    const result = this.runGit(['diff', '--shortstat']);
    if (result.status !== 0 || !result.stdout.trim()) {
      return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    }

    const filesMatch = result.stdout.match(/(\d+) files? changed/);
    const insertionsMatch = result.stdout.match(/(\d+) insertions?\(\+\)/);
    const deletionsMatch = result.stdout.match(/(\d+) deletions?\(-\)/);

    return {
      filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
      linesRemoved: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
    };
  }
}

// ============================================================================
// Orchestrator Git Operations
// ============================================================================

/**
 * Result of committing tier changes
 */
export interface TierCommitResult {
  tier: string;
  workingDirectory: string;
  staged: GitOperationResult;
  commit?: GitCommitResult;
  push?: GitPushResult;
  sessionChanges?: SessionChanges;
}

/**
 * Result of committing all orchestrated changes
 */
export interface OrchestratorCommitResult {
  requestId: string;
  success: boolean;
  tierCommits: TierCommitResult[];
  totalFilesCommitted: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  errors: string[];
}

/**
 * Options for orchestrator commit
 */
export interface OrchestratorCommitOptions {
  /** Request ID for traceability */
  requestId: string;
  /** Task summary for commit message */
  taskSummary: string;
  /** Detailed description */
  description?: string;
  /** Whether to push after commit */
  push?: boolean;
  /** Push options */
  pushOptions?: PushOptions;
  /** Tiers to commit (default: all with changes) */
  tiers?: string[];
  /** Whether to create a single combined commit (default: false = per-tier commits) */
  combinedCommit?: boolean;
  /** Co-author for commits */
  coAuthor?: string;
}

/**
 * Commit orchestrated changes across multiple tier repositories
 */
export function commitOrchestratedChanges(
  tierResults: Array<{
    tier: string;
    workingDirectory: string;
    sessionChanges?: SessionChanges;
    success: boolean;
  }>,
  options: OrchestratorCommitOptions
): OrchestratorCommitResult {
  const result: OrchestratorCommitResult = {
    requestId: options.requestId,
    success: true,
    tierCommits: [],
    totalFilesCommitted: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    errors: [],
  };

  // Filter to successful tiers with changes
  const tiersToCommit = tierResults.filter(t => {
    if (!t.success) return false;
    if (options.tiers && !options.tiers.includes(t.tier)) return false;
    if (!t.sessionChanges || t.sessionChanges.changes.length === 0) return false;
    return true;
  });

  for (const tierResult of tiersToCommit) {
    const gitManager = new GitManager({
      workingDirectory: tierResult.workingDirectory,
      autoPush: options.push,
    });

    // Check if git repo
    const status = gitManager.getStatus();
    if (!status.isGitRepo) {
      result.errors.push(`${tierResult.tier}: Not a git repository`);
      continue;
    }

    // Stage all changes
    const stageResult = gitManager.stageFiles();
    if (!stageResult.success) {
      result.errors.push(`${tierResult.tier}: Failed to stage - ${stageResult.error}`);
      result.tierCommits.push({
        tier: tierResult.tier,
        workingDirectory: tierResult.workingDirectory,
        staged: stageResult,
        sessionChanges: tierResult.sessionChanges,
      });
      continue;
    }

    // Build commit info
    const commitInfo: CommitInfo = {
      requestId: options.requestId,
      tier: tierResult.tier,
      taskSummary: options.taskSummary,
      description: options.description,
      filesChanged: tierResult.sessionChanges?.changes.map(c => c.relativePath),
      coAuthor: options.coAuthor,
      metadata: {
        'Files-Created': tierResult.sessionChanges?.summary.filesCreated ?? 0,
        'Files-Modified': tierResult.sessionChanges?.summary.filesModified ?? 0,
        'Files-Deleted': tierResult.sessionChanges?.summary.filesDeleted ?? 0,
        'Lines-Added': tierResult.sessionChanges?.summary.totalLinesAdded ?? 0,
        'Lines-Removed': tierResult.sessionChanges?.summary.totalLinesRemoved ?? 0,
      },
    };

    // Commit and optionally push
    const { commit, push } = gitManager.commitAndPush(commitInfo, options.push ? options.pushOptions : undefined);

    result.tierCommits.push({
      tier: tierResult.tier,
      workingDirectory: tierResult.workingDirectory,
      staged: stageResult,
      commit,
      push,
      sessionChanges: tierResult.sessionChanges,
    });

    if (commit.success) {
      result.totalFilesCommitted += commit.filesCommitted?.length ?? 0;
      result.totalLinesAdded += commit.linesAdded ?? 0;
      result.totalLinesRemoved += commit.linesRemoved ?? 0;
    } else {
      result.errors.push(`${tierResult.tier}: Commit failed - ${commit.error}`);
      result.success = false;
    }

    if (push && !push.success) {
      result.errors.push(`${tierResult.tier}: Push failed - ${push.error}`);
    }
  }

  return result;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a git manager instance
 */
export function createGitManager(config: GitManagerConfig): GitManager {
  return new GitManager(config);
}

/**
 * Quick utility to check if a directory is a git repo
 */
export function isGitRepository(workingDirectory: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd: workingDirectory,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

/**
 * Get git status for a directory
 */
export function getGitStatus(workingDirectory: string): GitStatusInfo {
  const manager = new GitManager({ workingDirectory });
  return manager.getStatus();
}
