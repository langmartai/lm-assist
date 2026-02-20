/**
 * Project Manager
 * Manages Claude Code project folders and configurations
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Project, ProjectConfig } from './types';
import {
  getProjectsDir,
  getProjectStorageDir,
  encodePath,
  decodePath,
  normalizePath,
  getClaudeConfigDir,
  legacyEncodeProjectPath,
} from './utils/path-utils';
import { ClaudeMdManager } from './md-manager';

/**
 * Project Manager class
 */
export class ProjectManager {
  private configDir: string;
  private projectsDir: string;
  private claudeMdManager: ClaudeMdManager;

  constructor(configDir?: string) {
    this.configDir = configDir || getClaudeConfigDir();
    this.projectsDir = getProjectsDir(this.configDir);
    this.claudeMdManager = new ClaudeMdManager();
  }

  /**
   * List all known projects (projects with sessions)
   */
  listProjects(): Project[] {
    const projects: Project[] = [];

    if (!fs.existsSync(this.projectsDir)) {
      return projects;
    }

    const dirs = fs.readdirSync(this.projectsDir);

    for (const encodedPath of dirs) {
      const projectStorageDir = path.join(this.projectsDir, encodedPath);

      if (!fs.statSync(projectStorageDir).isDirectory()) {
        continue;
      }

      const projectPath = decodePath(encodedPath);
      const project = this.getProjectInfo(projectPath);

      if (project) {
        projects.push(project);
      }
    }

    // Sort by last activity
    projects.sort((a, b) => {
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return b.lastActivity.getTime() - a.lastActivity.getTime();
    });

    return projects;
  }

  /**
   * Get detailed project information
   */
  getProjectInfo(projectPath: string): Project | null {
    const normalizedPath = normalizePath(projectPath);
    const encodedPath = encodePath(normalizedPath);
    let storageDir = getProjectStorageDir(normalizedPath, this.configDir);

    // If Base64-encoded dir doesn't exist, try legacy dash encoding
    // (Windows dirs are stored as e.g. C--home-lm-assist, not Base64)
    if (!fs.existsSync(storageDir)) {
      const legacyDir = path.join(getProjectsDir(this.configDir), legacyEncodeProjectPath(normalizedPath));
      if (fs.existsSync(legacyDir)) {
        storageDir = legacyDir;
      }
    }

    // Count sessions and compute storage size
    let sessionCount = 0;
    let lastActivity: Date | undefined;
    let storageSize = 0;
    let mostRecentSessionPath: string | undefined;
    let mostRecentMtime: Date | undefined;

    if (fs.existsSync(storageDir)) {
      const files = fs.readdirSync(storageDir);
      const sessionFiles = files.filter(
        (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
      );
      sessionCount = sessionFiles.length;

      // Find most recent session and compute total storage size
      for (const file of files) {
        const filePath = path.join(storageDir, file);
        const stats = fs.statSync(filePath);
        storageSize += stats.size;

        if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
          if (!lastActivity || stats.mtime > lastActivity) {
            lastActivity = stats.mtime;
            mostRecentSessionPath = filePath;
            mostRecentMtime = stats.mtime;
          }
        }
      }
    }

    // Check for CLAUDE.md
    const claudeMdPath = path.join(normalizedPath, 'CLAUDE.md');
    const hasClaudeMd = fs.existsSync(claudeMdPath);
    let claudeMdSize: number | undefined;
    let claudeMdTokens: number | undefined;

    if (hasClaudeMd) {
      const claudeMdInfo = this.claudeMdManager.getInfo(normalizedPath);
      claudeMdSize = claudeMdInfo.sizeBytes;
      claudeMdTokens = claudeMdInfo.estimatedTokens;
    }

    return {
      path: normalizedPath,
      encodedPath,
      hasClaudeMd,
      claudeMdSize,
      claudeMdTokens,
      sessionCount,
      lastActivity,
      storageSize,
      // Internal: used by route handler to avoid re-scanning for most recent session
      _mostRecentSessionPath: mostRecentSessionPath,
    } as any;
  }

  /**
   * Initialize a new project (create CLAUDE.md if needed)
   */
  initializeProject(projectPath: string, config?: ProjectConfig): Project {
    const normalizedPath = normalizePath(projectPath);

    // Ensure directory exists
    if (!fs.existsSync(normalizedPath)) {
      fs.mkdirSync(normalizedPath, { recursive: true });
    }

    // Create CLAUDE.md if content provided
    if (config?.claudeMdContent) {
      this.claudeMdManager.write(normalizedPath, config.claudeMdContent);
    }

    return this.getProjectInfo(normalizedPath)!;
  }

  /**
   * Check if a path is a valid Claude project (has sessions or CLAUDE.md)
   */
  isValidProject(projectPath: string): boolean {
    const normalizedPath = normalizePath(projectPath);

    // Check for CLAUDE.md
    if (fs.existsSync(path.join(normalizedPath, 'CLAUDE.md'))) {
      return true;
    }

    // Check for sessions
    const storageDir = getProjectStorageDir(normalizedPath, this.configDir);
    if (fs.existsSync(storageDir)) {
      const files = fs.readdirSync(storageDir);
      return files.some((f) => f.endsWith('.jsonl'));
    }

    return false;
  }

  /**
   * Get project storage directory path
   */
  getStorageDir(projectPath: string): string {
    return getProjectStorageDir(normalizePath(projectPath), this.configDir);
  }

  /**
   * Create project storage directory if it doesn't exist
   */
  ensureStorageDir(projectPath: string): string {
    const storageDir = this.getStorageDir(projectPath);
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    return storageDir;
  }

  /**
   * Get total storage size for a project
   */
  getStorageSize(projectPath: string): number {
    const storageDir = this.getStorageDir(projectPath);

    if (!fs.existsSync(storageDir)) {
      return 0;
    }

    let totalSize = 0;
    const files = fs.readdirSync(storageDir);

    for (const file of files) {
      const filePath = path.join(storageDir, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
    }

    return totalSize;
  }

  /**
   * Clean up old sessions for a project
   */
  cleanupSessions(
    projectPath: string,
    options?: { olderThanDays?: number; keepCount?: number }
  ): number {
    const storageDir = this.getStorageDir(projectPath);

    if (!fs.existsSync(storageDir)) {
      return 0;
    }

    const files = fs.readdirSync(storageDir);
    const sessionFiles = files
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map((f) => ({
        name: f,
        path: path.join(storageDir, f),
        mtime: fs.statSync(path.join(storageDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const olderThanDays = options?.olderThanDays || 30;
    const keepCount = options?.keepCount || 10;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    let deletedCount = 0;

    for (let i = 0; i < sessionFiles.length; i++) {
      const session = sessionFiles[i];

      // Keep minimum count
      if (i < keepCount) {
        continue;
      }

      // Delete if older than cutoff
      if (session.mtime < cutoffDate) {
        fs.unlinkSync(session.path);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Delete all project data (sessions only, not the project directory)
   */
  deleteProjectData(projectPath: string): boolean {
    const storageDir = this.getStorageDir(projectPath);

    if (fs.existsSync(storageDir)) {
      fs.rmSync(storageDir, { recursive: true });
      return true;
    }

    return false;
  }

  /**
   * Get CLAUDE.md manager for a project
   */
  getClaudeMdManager(): ClaudeMdManager {
    return this.claudeMdManager;
  }

  /**
   * Get all session files for a project
   */
  getSessionFiles(projectPath: string): Array<{ name: string; path: string; size: number; mtime: Date }> {
    const storageDir = this.getStorageDir(projectPath);

    if (!fs.existsSync(storageDir)) {
      return [];
    }

    const files = fs.readdirSync(storageDir);
    return files
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map((f) => {
        const filePath = path.join(storageDir, f);
        const stats = fs.statSync(filePath);
        return {
          name: f.replace('.jsonl', ''),
          path: filePath,
          size: stats.size,
          mtime: stats.mtime,
        };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
}

/**
 * Create a new project manager instance
 */
export function createProjectManager(configDir?: string): ProjectManager {
  return new ProjectManager(configDir);
}
