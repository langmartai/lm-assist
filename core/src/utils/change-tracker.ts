/**
 * Session Change Tracker
 *
 * Tracks file system changes during agent sessions:
 * - Pre/post execution file snapshots
 * - Git diff integration
 * - Content hashing
 * - Tool result file extraction
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Represents a file's state at a point in time
 */
export interface FileSnapshot {
  path: string;
  relativePath: string;
  exists: boolean;
  size?: number;
  modifiedAt?: Date;
  contentHash?: string;
  isDirectory: boolean;
  permissions?: string;
}

/**
 * Represents a change to a file
 */
export interface TrackedFileChange {
  path: string;
  relativePath: string;
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;  // For renames
  before?: FileSnapshot;
  after?: FileSnapshot;
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * Summary of all changes in a session
 */
export interface SessionChanges {
  sessionId: string;
  executionId?: string;
  workingDirectory: string;
  startedAt: Date;
  completedAt?: Date;
  gitBranch?: string;
  gitCommitBefore?: string;
  gitCommitAfter?: string;
  changes: TrackedFileChange[];
  summary: {
    filesCreated: number;
    filesModified: number;
    filesDeleted: number;
    filesRenamed: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
  };
  toolChanges: ToolTrackedFileChange[];
}

/**
 * File change attributed to a specific tool
 */
export interface ToolTrackedFileChange {
  toolName: string;
  toolUseId: string;
  files: string[];
  action: 'write' | 'edit' | 'delete' | 'create';
  timestamp: Date;
}

/**
 * Configuration for change tracker
 */
export interface ChangeTrackerConfig {
  /** Working directory to track */
  workingDirectory: string;
  /** Whether to use git for change detection */
  useGit?: boolean;
  /** Whether to compute content hashes */
  computeHashes?: boolean;
  /** File patterns to include (glob) */
  includePatterns?: string[];
  /** File patterns to exclude (glob) */
  excludePatterns?: string[];
  /** Maximum file size to hash (bytes) */
  maxHashFileSize?: number;
  /** Whether to capture diffs */
  captureDiffs?: boolean;
  /** Maximum diff size to capture */
  maxDiffSize?: number;
}

const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '*.log',
  '.DS_Store',
  'coverage/**',
  '.tier-agent/**',
];

/**
 * Tracks file system changes during agent sessions
 */
export class ChangeTracker {
  private config: Required<ChangeTrackerConfig>;
  private preSnapshot: Map<string, FileSnapshot> = new Map();
  private toolChanges: ToolTrackedFileChange[] = [];
  private sessionId: string;
  private executionId?: string;
  private startedAt?: Date;
  private gitCommitBefore?: string;
  private isGitRepo: boolean = false;

  constructor(config: ChangeTrackerConfig) {
    this.config = {
      workingDirectory: config.workingDirectory,
      useGit: config.useGit ?? true,
      computeHashes: config.computeHashes ?? true,
      includePatterns: config.includePatterns ?? ['**/*'],
      excludePatterns: config.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
      maxHashFileSize: config.maxHashFileSize ?? 1024 * 1024, // 1MB
      captureDiffs: config.captureDiffs ?? true,
      maxDiffSize: config.maxDiffSize ?? 10000, // 10KB
    };
    this.sessionId = crypto.randomUUID();
    this.isGitRepo = this.checkGitRepo();
  }

  /**
   * Check if the working directory is a git repository
   * Uses spawnSync with array args (safe from injection)
   */
  private checkGitRepo(): boolean {
    try {
      const result = spawnSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the current git branch
   * Uses spawnSync with array args (safe from injection)
   */
  getGitBranch(): string | undefined {
    if (!this.isGitRepo) return undefined;
    try {
      const result = spawnSync('git', ['branch', '--show-current'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
      });
      return result.status === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the current git commit hash
   * Uses spawnSync with array args (safe from injection)
   */
  getGitCommit(): string | undefined {
    if (!this.isGitRepo) return undefined;
    try {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
      });
      return result.status === 0 ? result.stdout.trim().substring(0, 8) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Compute SHA256 hash of file content
   */
  private computeHash(filePath: string): string | undefined {
    if (!this.config.computeHashes) return undefined;
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > this.config.maxHashFileSize) return undefined;
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    } catch {
      return undefined;
    }
  }

  /**
   * Create a snapshot of a single file
   */
  private snapshotFile(absolutePath: string): FileSnapshot {
    const relativePath = path.relative(this.config.workingDirectory, absolutePath);

    try {
      const stats = fs.statSync(absolutePath);
      return {
        path: absolutePath,
        relativePath,
        exists: true,
        size: stats.size,
        modifiedAt: stats.mtime,
        contentHash: stats.isFile() ? this.computeHash(absolutePath) : undefined,
        isDirectory: stats.isDirectory(),
        permissions: stats.mode.toString(8).slice(-3),
      };
    } catch {
      return {
        path: absolutePath,
        relativePath,
        exists: false,
        isDirectory: false,
      };
    }
  }

  /**
   * Get list of tracked files using git or file system
   */
  private getTrackedFiles(): string[] {
    if (this.config.useGit && this.isGitRepo) {
      return this.getGitTrackedFiles();
    }
    return this.getFileSystemFiles();
  }

  /**
   * Get files tracked by git
   * Uses spawnSync with array args (safe from injection)
   */
  private getGitTrackedFiles(): string[] {
    try {
      // Get all tracked files + untracked files
      const tracked = spawnSync('git', ['ls-files'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const files = [
        ...(tracked.stdout?.split('\n') || []),
        ...(untracked.stdout?.split('\n') || []),
      ].filter(f => f.trim());

      return files.map(f => path.join(this.config.workingDirectory, f));
    } catch {
      return this.getFileSystemFiles();
    }
  }

  /**
   * Get files from file system (fallback)
   */
  private getFileSystemFiles(): string[] {
    const files: string[] = [];

    const walk = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(this.config.workingDirectory, fullPath);

          // Check exclusions
          if (this.shouldExclude(relativePath)) continue;

          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    walk(this.config.workingDirectory);
    return files;
  }

  /**
   * Check if a path should be excluded
   */
  private shouldExclude(relativePath: string): boolean {
    for (const pattern of this.config.excludePatterns) {
      if (this.matchGlob(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Simple glob matching
   */
  private matchGlob(filePath: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\*\*/g, '{{DOUBLE_STAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{DOUBLE_STAR}}/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`).test(filePath);
  }

  /**
   * Start tracking - takes initial snapshot
   */
  startTracking(executionId?: string): void {
    this.executionId = executionId;
    this.startedAt = new Date();
    this.gitCommitBefore = this.getGitCommit();
    this.preSnapshot.clear();
    this.toolChanges = [];

    const files = this.getTrackedFiles();
    for (const file of files) {
      const snapshot = this.snapshotFile(file);
      this.preSnapshot.set(file, snapshot);
    }
  }

  /**
   * Record a tool's file operation
   */
  recordToolChange(toolName: string, toolUseId: string, files: string[], action: 'write' | 'edit' | 'delete' | 'create'): void {
    this.toolChanges.push({
      toolName,
      toolUseId,
      files: files.map(f => path.isAbsolute(f) ? f : path.join(this.config.workingDirectory, f)),
      action,
      timestamp: new Date(),
    });
  }

  /**
   * Get git diff for a file
   * Uses spawnSync with array args (safe from injection)
   */
  private getFileDiff(filePath: string): string | undefined {
    if (!this.config.captureDiffs || !this.isGitRepo) return undefined;

    try {
      const result = spawnSync('git', ['diff', '--', filePath], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
        maxBuffer: this.config.maxDiffSize * 2,
      });

      if (result.status !== 0 || !result.stdout) {
        // Try diff for untracked files
        const untrackedResult = spawnSync('git', ['diff', '--no-index', '/dev/null', filePath], {
          cwd: this.config.workingDirectory,
          encoding: 'utf-8',
          maxBuffer: this.config.maxDiffSize * 2,
        });

        const diff = untrackedResult.stdout || '';
        return diff.length > this.config.maxDiffSize
          ? diff.substring(0, this.config.maxDiffSize) + '\n... [truncated]'
          : diff || undefined;
      }

      const diff = result.stdout;
      return diff.length > this.config.maxDiffSize
        ? diff.substring(0, this.config.maxDiffSize) + '\n... [truncated]'
        : diff || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Count lines added/removed from diff
   */
  private countDiffLines(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;

    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed++;
      }
    }

    return { added, removed };
  }

  /**
   * Stop tracking and compute changes
   */
  stopTracking(): SessionChanges {
    const completedAt = new Date();
    const gitCommitAfter = this.getGitCommit();
    const changes: TrackedFileChange[] = [];

    // Get current files
    const currentFiles = new Set(this.getTrackedFiles());
    const processedFiles = new Set<string>();

    // Check for modified and deleted files
    for (const [filePath, beforeSnapshot] of this.preSnapshot) {
      processedFiles.add(filePath);
      const afterSnapshot = this.snapshotFile(filePath);

      if (!afterSnapshot.exists && beforeSnapshot.exists) {
        // File was deleted
        changes.push({
          path: filePath,
          relativePath: beforeSnapshot.relativePath,
          action: 'deleted',
          before: beforeSnapshot,
          after: afterSnapshot,
        });
      } else if (afterSnapshot.exists && beforeSnapshot.exists) {
        // Check if modified
        const hashChanged = beforeSnapshot.contentHash !== afterSnapshot.contentHash;
        const sizeChanged = beforeSnapshot.size !== afterSnapshot.size;
        const timeChanged = beforeSnapshot.modifiedAt?.getTime() !== afterSnapshot.modifiedAt?.getTime();

        if (hashChanged || sizeChanged || timeChanged) {
          const diff = this.getFileDiff(filePath);
          const diffLines = diff ? this.countDiffLines(diff) : { added: 0, removed: 0 };

          changes.push({
            path: filePath,
            relativePath: beforeSnapshot.relativePath,
            action: 'modified',
            before: beforeSnapshot,
            after: afterSnapshot,
            diff,
            linesAdded: diffLines.added,
            linesRemoved: diffLines.removed,
          });
        }
      }
    }

    // Check for created files
    for (const filePath of currentFiles) {
      if (!processedFiles.has(filePath)) {
        const afterSnapshot = this.snapshotFile(filePath);
        if (afterSnapshot.exists && !afterSnapshot.isDirectory) {
          const diff = this.getFileDiff(filePath);
          const diffLines = diff ? this.countDiffLines(diff) : { added: 0, removed: 0 };

          changes.push({
            path: filePath,
            relativePath: afterSnapshot.relativePath,
            action: 'created',
            after: afterSnapshot,
            diff,
            linesAdded: diffLines.added,
            linesRemoved: 0,
          });
        }
      }
    }

    // Detect renames using git
    if (this.isGitRepo && this.config.useGit) {
      this.detectRenames(changes);
    }

    // Calculate summary
    const summary = {
      filesCreated: changes.filter(c => c.action === 'created').length,
      filesModified: changes.filter(c => c.action === 'modified').length,
      filesDeleted: changes.filter(c => c.action === 'deleted').length,
      filesRenamed: changes.filter(c => c.action === 'renamed').length,
      totalLinesAdded: changes.reduce((sum, c) => sum + (c.linesAdded || 0), 0),
      totalLinesRemoved: changes.reduce((sum, c) => sum + (c.linesRemoved || 0), 0),
    };

    return {
      sessionId: this.sessionId,
      executionId: this.executionId,
      workingDirectory: this.config.workingDirectory,
      startedAt: this.startedAt!,
      completedAt,
      gitBranch: this.getGitBranch(),
      gitCommitBefore: this.gitCommitBefore,
      gitCommitAfter,
      changes,
      summary,
      toolChanges: this.toolChanges,
    };
  }

  /**
   * Detect file renames using git
   * Uses spawnSync with array args (safe from injection)
   */
  private detectRenames(changes: TrackedFileChange[]): void {
    try {
      const result = spawnSync('git', ['diff', '--name-status', '-M'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
      });

      if (result.status !== 0) return;

      const lines = result.stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/^R\d*\t(.+)\t(.+)$/);
        if (match) {
          const [, oldPath, newPath] = match;
          const oldFullPath = path.join(this.config.workingDirectory, oldPath);
          const newFullPath = path.join(this.config.workingDirectory, newPath);

          // Find and update the changes
          const deletedIdx = changes.findIndex(c => c.path === oldFullPath && c.action === 'deleted');
          const createdIdx = changes.findIndex(c => c.path === newFullPath && c.action === 'created');

          if (deletedIdx !== -1 && createdIdx !== -1) {
            // Convert to rename
            const deleted = changes[deletedIdx];
            const created = changes[createdIdx];

            changes[createdIdx] = {
              path: newFullPath,
              relativePath: created.relativePath,
              action: 'renamed',
              oldPath: oldFullPath,
              before: deleted.before,
              after: created.after,
              diff: created.diff,
              linesAdded: created.linesAdded,
              linesRemoved: deleted.linesRemoved,
            };

            // Remove the deleted entry
            changes.splice(deletedIdx, 1);
          }
        }
      }
    } catch {
      // Ignore rename detection errors
    }
  }

  /**
   * Get changes since last git commit (useful for quick checks)
   * Uses spawnSync with array args (safe from injection)
   */
  getGitChanges(): TrackedFileChange[] {
    if (!this.isGitRepo) return [];

    const changes: TrackedFileChange[] = [];

    try {
      // Get staged + unstaged changes
      const result = spawnSync('git', ['status', '--porcelain'], {
        cwd: this.config.workingDirectory,
        encoding: 'utf-8',
      });

      if (result.status !== 0) return [];

      const lines = result.stdout.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const status = line.substring(0, 2);
        const filePath = line.substring(3).trim();
        const fullPath = path.join(this.config.workingDirectory, filePath);

        let action: TrackedFileChange['action'] = 'modified';
        if (status.includes('A') || status.includes('?')) {
          action = 'created';
        } else if (status.includes('D')) {
          action = 'deleted';
        } else if (status.includes('R')) {
          action = 'renamed';
        }

        const diff = this.getFileDiff(fullPath);
        const diffLines = diff ? this.countDiffLines(diff) : { added: 0, removed: 0 };

        changes.push({
          path: fullPath,
          relativePath: filePath,
          action,
          diff,
          linesAdded: diffLines.added,
          linesRemoved: diffLines.removed,
          after: this.snapshotFile(fullPath),
        });
      }
    } catch {
      // Ignore errors
    }

    return changes;
  }
}

/**
 * Extract file paths from tool input
 */
export function extractFilesFromToolInput(toolName: string, input: Record<string, unknown>): string[] {
  const files: string[] = [];

  // Common file path parameter names
  const fileParams = ['file_path', 'path', 'filePath', 'file', 'filename', 'target', 'destination', 'source'];

  for (const param of fileParams) {
    const value = input[param];
    if (typeof value === 'string' && value.length > 0) {
      files.push(value);
    }
  }

  // Handle specific tools
  switch (toolName.toLowerCase()) {
    case 'write':
    case 'edit':
    case 'read':
      if (typeof input.file_path === 'string') {
        files.push(input.file_path);
      }
      break;

    case 'bash':
      // Try to extract file paths from bash commands
      const command = input.command as string;
      if (command) {
        const bashFiles = extractFilesFromBashCommand(command);
        files.push(...bashFiles);
      }
      break;

    case 'glob':
    case 'grep':
      if (typeof input.path === 'string') {
        files.push(input.path);
      }
      break;
  }

  return [...new Set(files)]; // Dedupe
}

/**
 * Extract file paths from bash commands
 */
export function extractFilesFromBashCommand(command: string): string[] {
  const files: string[] = [];

  // Common file-modifying commands
  const patterns = [
    // touch, rm, mv, cp followed by paths
    /(?:touch|rm|mv|cp|mkdir|rmdir)\s+(?:-[a-zA-Z]+\s+)*([^\s|&;>]+)/g,
    // Redirects: > file, >> file
    /(?:>|>>)\s*([^\s|&;]+)/g,
    // git add, git rm
    /git\s+(?:add|rm)\s+(?:-[a-zA-Z]+\s+)*([^\s|&;]+)/g,
    // npm/yarn/pnpm init/create
    /(?:npm|yarn|pnpm)\s+(?:init|create)\s+(?:-[a-zA-Z]+\s+)*([^\s|&;]+)?/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      if (match[1] && !match[1].startsWith('-')) {
        files.push(match[1]);
      }
    }
  }

  return files;
}

/**
 * Determine tool action type
 */
export function getToolAction(toolName: string): 'write' | 'edit' | 'delete' | 'create' | undefined {
  const toolLower = toolName.toLowerCase();

  if (toolLower === 'write' || toolLower === 'notebookedit') {
    return 'write';
  }
  if (toolLower === 'edit') {
    return 'edit';
  }
  if (toolLower === 'bash') {
    return 'write'; // Bash can do anything, default to write
  }

  return undefined;
}

/**
 * Create a change tracker instance
 */
export function createChangeTracker(config: ChangeTrackerConfig): ChangeTracker {
  return new ChangeTracker(config);
}

/**
 * Quick utility to get current git changes
 */
export function getGitChanges(workingDirectory: string): TrackedFileChange[] {
  const tracker = new ChangeTracker({ workingDirectory });
  return tracker.getGitChanges();
}

/**
 * Format session changes as a human-readable summary
 */
export function formatSessionChanges(changes: SessionChanges): string {
  const lines: string[] = [];

  lines.push(`Session Changes: ${changes.sessionId}`);
  lines.push(`Directory: ${changes.workingDirectory}`);
  if (changes.gitBranch) {
    lines.push(`Branch: ${changes.gitBranch}`);
  }
  if (changes.gitCommitBefore && changes.gitCommitAfter && changes.gitCommitBefore !== changes.gitCommitAfter) {
    lines.push(`Commits: ${changes.gitCommitBefore} → ${changes.gitCommitAfter}`);
  }
  lines.push('');

  lines.push(`Summary:`);
  lines.push(`  Created: ${changes.summary.filesCreated} files`);
  lines.push(`  Modified: ${changes.summary.filesModified} files`);
  lines.push(`  Deleted: ${changes.summary.filesDeleted} files`);
  if (changes.summary.filesRenamed > 0) {
    lines.push(`  Renamed: ${changes.summary.filesRenamed} files`);
  }
  lines.push(`  Lines: +${changes.summary.totalLinesAdded} / -${changes.summary.totalLinesRemoved}`);
  lines.push('');

  if (changes.changes.length > 0) {
    lines.push('Changes:');
    for (const change of changes.changes) {
      const prefix = change.action === 'created' ? '+'
        : change.action === 'deleted' ? '-'
        : change.action === 'renamed' ? '→'
        : 'M';

      let line = `  ${prefix} ${change.relativePath}`;
      if (change.linesAdded || change.linesRemoved) {
        line += ` (+${change.linesAdded || 0}/-${change.linesRemoved || 0})`;
      }
      if (change.oldPath) {
        const oldRelative = path.relative(changes.workingDirectory, change.oldPath);
        line = `  ${prefix} ${oldRelative} → ${change.relativePath}`;
      }
      lines.push(line);
    }
  }

  if (changes.toolChanges.length > 0) {
    lines.push('');
    lines.push('Tool Operations:');
    for (const tc of changes.toolChanges) {
      lines.push(`  ${tc.toolName} (${tc.action}): ${tc.files.map(f => path.relative(changes.workingDirectory, f)).join(', ')}`);
    }
  }

  return lines.join('\n');
}
