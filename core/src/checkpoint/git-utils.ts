/**
 * Git Utilities for Checkpoint System
 *
 * Safe git operations using execFileSync (no shell injection).
 * All functions use array arguments instead of string interpolation.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FileChange, FileChangeStatus } from '../types/checkpoint';

/**
 * Execute a git command safely using execFileSync
 *
 * @param args - Array of git command arguments (e.g., ['add', '-A'])
 * @param cwd - Working directory
 * @returns Command output as string
 */
export function gitCommand(args: string[], cwd: string): string {
  try {
    const result = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large diffs
    });
    return result.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const stderr = err.stderr || err.message || 'Unknown git error';
    throw new Error(`Git command failed: git ${args.join(' ')}\n${stderr}`);
  }
}

/**
 * Check if a path is a git repository
 */
export function isGitRepo(repoPath: string): boolean {
  const gitDir = path.join(repoPath, '.git');
  return fs.existsSync(gitDir);
}

/**
 * Ensure path is a git repository, initialize if needed
 */
export function ensureGitRepo(repoPath: string): boolean {
  if (isGitRepo(repoPath)) {
    return true;
  }

  try {
    gitCommand(['init'], repoPath);
    return true;
  } catch (error) {
    console.error('Failed to initialize git repo:', error);
    return false;
  }
}

/**
 * Get current commit hash (HEAD)
 */
export function getCurrentCommit(repoPath: string): string | null {
  try {
    return gitCommand(['rev-parse', 'HEAD'], repoPath);
  } catch {
    // No commits yet
    return null;
  }
}

/**
 * Get current branch name
 */
export function getCurrentBranch(repoPath: string): string {
  try {
    return gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  } catch {
    return 'main';
  }
}

/**
 * Check if working tree is clean (no uncommitted changes)
 */
export function isWorkingTreeClean(repoPath: string): boolean {
  try {
    const status = gitCommand(['status', '--porcelain'], repoPath);
    return status.length === 0;
  } catch {
    return false;
  }
}

/**
 * Stage all changes
 */
export function stageAll(repoPath: string): void {
  gitCommand(['add', '-A'], repoPath);
}

/**
 * Stage specific files
 */
export function stageFiles(repoPath: string, files: string[]): void {
  if (files.length === 0) return;
  gitCommand(['add', '--', ...files], repoPath);
}

/**
 * Create a commit
 */
export function commit(repoPath: string, message: string): string {
  // Stage all changes first
  stageAll(repoPath);

  // Check if there's anything to commit
  const status = gitCommand(['status', '--porcelain'], repoPath);
  if (status.length === 0) {
    // Nothing to commit, return current commit
    return getCurrentCommit(repoPath) || '';
  }

  // Create commit
  gitCommand(['commit', '-m', message], repoPath);

  // Return new commit hash
  return getCurrentCommit(repoPath) || '';
}

/**
 * Get list of changed files since a commit
 */
export function getDiffFiles(repoPath: string, fromCommit: string): string[] {
  try {
    const output = gitCommand(['diff', '--name-only', fromCommit, 'HEAD'], repoPath);
    if (!output) return [];
    return output.split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Get diff stats for a file
 */
export function getDiffStats(
  repoPath: string,
  fromCommit: string,
  filePath: string
): { additions: number; deletions: number } {
  try {
    const output = gitCommand(
      ['diff', '--numstat', fromCommit, 'HEAD', '--', filePath],
      repoPath
    );

    if (!output) {
      return { additions: 0, deletions: 0 };
    }

    const parts = output.split('\t');
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;

    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

/**
 * Get unified diff for a file
 */
export function getFileDiff(
  repoPath: string,
  fromCommit: string,
  filePath: string
): string {
  try {
    return gitCommand(['diff', fromCommit, 'HEAD', '--', filePath], repoPath);
  } catch {
    return '';
  }
}

/**
 * Get file change status (added/modified/deleted)
 */
export function getFileStatus(
  repoPath: string,
  fromCommit: string,
  filePath: string
): FileChangeStatus {
  try {
    const output = gitCommand(
      ['diff', '--name-status', fromCommit, 'HEAD', '--', filePath],
      repoPath
    );

    if (!output) return 'modified';

    const status = output.charAt(0);
    switch (status) {
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case 'M':
      default:
        return 'modified';
    }
  } catch {
    return 'modified';
  }
}

/**
 * Parse full diff output into FileChange array
 */
export function parseDiffOutput(
  repoPath: string,
  fromCommit: string
): FileChange[] {
  const changes: FileChange[] = [];

  try {
    // Get list of changed files with status
    const nameStatus = gitCommand(
      ['diff', '--name-status', fromCommit, 'HEAD'],
      repoPath
    );

    if (!nameStatus) return [];

    const lines = nameStatus.split('\n').filter(line => line.length > 0);

    for (const line of lines) {
      const parts = line.split('\t');
      const statusChar = parts[0].charAt(0);
      const filePath = parts.length > 2 ? parts[2] : parts[1]; // Handle renames
      const oldPath = parts.length > 2 ? parts[1] : undefined;

      let status: FileChangeStatus;
      switch (statusChar) {
        case 'A':
          status = 'added';
          break;
        case 'D':
          status = 'deleted';
          break;
        case 'R':
          status = 'renamed';
          break;
        case 'M':
        default:
          status = 'modified';
      }

      // Get stats
      const stats = getDiffStats(repoPath, fromCommit, filePath);

      // Detect tier from path
      const tier = detectTierFromPath(filePath);

      // Check if binary
      const isBinary = isBinaryFile(filePath);

      changes.push({
        path: filePath,
        tier,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        isBinary,
        oldPath,
      });
    }
  } catch (error) {
    console.error('Failed to parse diff output:', error);
  }

  return changes;
}

/**
 * Detect tier from file path
 */
export function detectTierFromPath(filePath: string): string | undefined {
  const normalized = filePath.toLowerCase();

  if (normalized.startsWith('web/') || normalized.includes('/web/')) {
    return 'web';
  }
  if (normalized.startsWith('api/') || normalized.includes('/api/')) {
    return 'api';
  }
  if (normalized.startsWith('database/') || normalized.includes('/database/')) {
    return 'database';
  }
  if (normalized.startsWith('deploy/') || normalized.includes('/deploy/')) {
    return 'deploy';
  }

  return undefined;
}

/**
 * Check if file is binary based on extension
 */
export function isBinaryFile(filePath: string): boolean {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
    '.db', '.sqlite', '.sqlite3',
  ]);

  const ext = path.extname(filePath).toLowerCase();
  return binaryExtensions.has(ext);
}

/**
 * Git reset --hard to a commit
 */
export function resetHard(repoPath: string, commitHash: string): void {
  gitCommand(['reset', '--hard', commitHash], repoPath);
}

/**
 * Git reset --soft to a commit
 */
export function resetSoft(repoPath: string, commitHash: string): void {
  gitCommand(['reset', '--soft', commitHash], repoPath);
}

/**
 * Git reset --mixed to a commit
 */
export function resetMixed(repoPath: string, commitHash: string): void {
  gitCommand(['reset', '--mixed', commitHash], repoPath);
}

/**
 * Checkout a specific file from a commit
 */
export function checkoutFile(
  repoPath: string,
  commitHash: string,
  filePath: string
): void {
  gitCommand(['checkout', commitHash, '--', filePath], repoPath);
}

/**
 * Checkout multiple files from a commit
 */
export function checkoutFiles(
  repoPath: string,
  commitHash: string,
  files: string[]
): void {
  if (files.length === 0) return;
  gitCommand(['checkout', commitHash, '--', ...files], repoPath);
}

/**
 * Get commit message for a commit
 */
export function getCommitMessage(repoPath: string, commitHash: string): string {
  try {
    return gitCommand(['log', '-1', '--format=%s', commitHash], repoPath);
  } catch {
    return '';
  }
}

/**
 * Get commit date for a commit
 */
export function getCommitDate(repoPath: string, commitHash: string): Date | null {
  try {
    const timestamp = gitCommand(['log', '-1', '--format=%ct', commitHash], repoPath);
    return new Date(parseInt(timestamp, 10) * 1000);
  } catch {
    return null;
  }
}

/**
 * Check if a commit exists
 */
export function commitExists(repoPath: string, commitHash: string): boolean {
  try {
    gitCommand(['cat-file', '-t', commitHash], repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the number of commits between two commits
 */
export function getCommitCount(
  repoPath: string,
  fromCommit: string,
  toCommit: string = 'HEAD'
): number {
  try {
    const output = gitCommand(
      ['rev-list', '--count', `${fromCommit}..${toCommit}`],
      repoPath
    );
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Stash current changes
 */
export function stash(repoPath: string, message?: string): boolean {
  try {
    const args = ['stash', 'push'];
    if (message) {
      args.push('-m', message);
    }
    gitCommand(args, repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pop stashed changes
 */
export function stashPop(repoPath: string): boolean {
  try {
    gitCommand(['stash', 'pop'], repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of files in a directory at a specific commit
 */
export function getFilesAtCommit(
  repoPath: string,
  commitHash: string,
  directory?: string
): string[] {
  try {
    const args = ['ls-tree', '-r', '--name-only', commitHash];
    if (directory) {
      args.push('--', directory);
    }
    const output = gitCommand(args, repoPath);
    if (!output) return [];
    return output.split('\n').filter(line => line.length > 0);
  } catch {
    return [];
  }
}
