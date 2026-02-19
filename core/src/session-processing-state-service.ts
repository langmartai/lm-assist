/**
 * Session Processing State Service
 *
 * Tracks which session messages have been processed for project spec generation.
 * Enables delta updates by remembering the last processed line index for each session.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { legacyEncodeProjectPath } from './utils/path-utils';
// Inline types (project-spec types not included in lm-assist)
interface SessionProgress {
  lastLineIndex: number;
  lastProcessedAt: string;
}

interface SessionProcessingState {
  projectPath: string;
  specExecutionSessionId?: string;
  processedSessions: Record<string, SessionProgress>;
  lastUpdated: string;
}

/**
 * Service for managing session processing state
 */
export class SessionProcessingStateService {
  private projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir || path.join(homedir(), '.claude', 'projects');
  }

  /**
   * Encode a project path to a project key (same as Claude Code)
   */
  private encodeProjectPath(projectPath: string): string {
    return legacyEncodeProjectPath(projectPath);
  }

  /**
   * Get the state file path for a project
   */
  private getStateFilePath(projectPath: string): string {
    const projectKey = this.encodeProjectPath(projectPath);
    return path.join(this.projectsDir, projectKey, 'project-spec-state.json');
  }

  /**
   * Get the current processing state for a project
   */
  getState(projectPath: string): SessionProcessingState {
    const stateFile = this.getStateFilePath(projectPath);

    try {
      if (fs.existsSync(stateFile)) {
        const content = fs.readFileSync(stateFile, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error(`Failed to read state file: ${error}`);
    }

    // Return default state
    return {
      projectPath,
      processedSessions: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Save the processing state for a project
   */
  saveState(projectPath: string, state: SessionProcessingState): void {
    const stateFile = this.getStateFilePath(projectPath);
    const stateDir = path.dirname(stateFile);

    // Ensure directory exists
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  /**
   * Update the progress for a specific session
   */
  updateSessionProgress(
    projectPath: string,
    sessionId: string,
    lastLineIndex: number
  ): void {
    const state = this.getState(projectPath);

    state.processedSessions[sessionId] = {
      lastLineIndex,
      lastProcessedAt: new Date().toISOString(),
    };

    this.saveState(projectPath, state);
  }

  /**
   * Set the session ID of the spec execution itself (to exclude from input)
   */
  setSpecExecutionSessionId(projectPath: string, sessionId: string): void {
    const state = this.getState(projectPath);
    state.specExecutionSessionId = sessionId;
    this.saveState(projectPath, state);
  }

  /**
   * Get the spec execution session ID (to exclude from input)
   */
  getSpecExecutionSessionId(projectPath: string): string | undefined {
    const state = this.getState(projectPath);
    return state.specExecutionSessionId;
  }

  /**
   * Get unprocessed content info for all sessions
   * Returns a map of sessionId -> startLineIndex (where to start reading from)
   */
  getUnprocessedSessionInfo(projectPath: string): Record<string, number> {
    const state = this.getState(projectPath);
    const result: Record<string, number> = {};

    // For each processed session, return the next line to process
    for (const [sessionId, progress] of Object.entries(state.processedSessions)) {
      result[sessionId] = progress.lastLineIndex + 1;
    }

    return result;
  }

  /**
   * Get the last processed line index for a specific session
   * Returns -1 if session hasn't been processed yet
   */
  getLastProcessedLineIndex(projectPath: string, sessionId: string): number {
    const state = this.getState(projectPath);
    return state.processedSessions[sessionId]?.lastLineIndex ?? -1;
  }

  /**
   * Check if a session should be excluded (it's the spec execution session itself)
   */
  shouldExcludeSession(projectPath: string, sessionId: string): boolean {
    const state = this.getState(projectPath);
    return state.specExecutionSessionId === sessionId;
  }

  /**
   * Reset all processing state for a project (for fresh generation)
   */
  resetState(projectPath: string): void {
    const state: SessionProcessingState = {
      projectPath,
      processedSessions: {},
      lastUpdated: new Date().toISOString(),
    };
    this.saveState(projectPath, state);
  }

  /**
   * Batch update multiple session progresses
   */
  batchUpdateProgress(
    projectPath: string,
    updates: Array<{ sessionId: string; lastLineIndex: number }>
  ): void {
    const state = this.getState(projectPath);

    for (const update of updates) {
      state.processedSessions[update.sessionId] = {
        lastLineIndex: update.lastLineIndex,
        lastProcessedAt: new Date().toISOString(),
      };
    }

    this.saveState(projectPath, state);
  }

  /**
   * Get statistics about processing state
   */
  getStats(projectPath: string): {
    totalProcessedSessions: number;
    totalProcessedLines: number;
    lastUpdated: string;
    specExecutionSessionId?: string;
  } {
    const state = this.getState(projectPath);
    const totalProcessedLines = Object.values(state.processedSessions).reduce(
      (sum, progress) => sum + progress.lastLineIndex + 1,
      0
    );

    return {
      totalProcessedSessions: Object.keys(state.processedSessions).length,
      totalProcessedLines,
      lastUpdated: state.lastUpdated,
      specExecutionSessionId: state.specExecutionSessionId,
    };
  }
}

/**
 * Create a SessionProcessingStateService instance
 */
export function createSessionProcessingStateService(
  projectsDir?: string
): SessionProcessingStateService {
  return new SessionProcessingStateService(projectsDir);
}
