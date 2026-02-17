/**
 * Session Reader
 *
 * Read-only access to session files in ~/.claude/projects/.
 * This module is extracted from AgentSessionStore to separate concerns:
 * - SessionReader: Read raw session JSONL files
 * - ExecutionStore: Track tier-agent execution history
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

// Re-export types from agent-session-store for backward compatibility
// These will eventually be moved here
export {
  ClaudeSessionMessageType,
  ClaudeSystemSubtype,
  ClaudeSessionMessage,
  ClaudeSystemInit,
  ClaudeAssistantMessage,
  ClaudeResultMessage,
  ClaudeToolUse,
  FileChange,
  DbOperation,
  GitOperation,
  GitOperationType,
  SubagentType,
  SubagentStatus,
  SubagentInvocation,
  SubagentProgressUpdate,
  SubagentSessionData,
  ClaudeUserPrompt,
  CompactMessageSummary,
  ClaudeCompactMessage,
  parseCompactMessageSummary,
  ClaudeSessionData,
  ToolDetailLevel,
  ConversationToolCall,
  ConversationMessage,
  GetConversationOptions,
  ConversationResult,
} from './agent-session-store';

// ============================================================================
// Types
// ============================================================================

/**
 * Summary info about a session (for listing)
 */
export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  projectKey: string;
  lastModified: Date;
  sizeBytes: number;
}

/**
 * Detailed info about a session
 */
export interface SessionInfo extends SessionSummary {
  model?: string;
  numTurns?: number;
  totalCostUsd?: number;
  status?: 'active' | 'completed' | 'error';
  result?: string;
  durationMs?: number;
}

/**
 * Project info (from raw session files)
 */
export interface ProjectInfo {
  key: string;
  path: string;
  sessionCount: number;
  lastActivity: Date;
}

/**
 * Subagent file metadata
 */
export interface SubagentFileInfo {
  agentId: string;
  sessionId: string;
  filePath: string;
  lastModified: Date;
  sizeBytes: number;
}

/**
 * Configuration for SessionReader
 */
export interface SessionReaderConfig {
  /** Override config directory (default: ~/.claude) */
  configDir?: string;
  /** Default working directory for project resolution */
  defaultCwd?: string;
}

// Backward compatibility aliases
export type ClaudeSessionSummary = SessionSummary;
export type ClaudeSessionInfo = SessionInfo;
export type ClaudeProjectInfo = ProjectInfo;
export type ClaudeSessionReaderConfig = SessionReaderConfig;

// ============================================================================
// SessionReader Implementation
// ============================================================================

/**
 * Read-only access to session files.
 *
 * Sessions are stored in ~/.claude/projects/{projectKey}/ as JSONL files.
 * This class provides methods to:
 * - List sessions and projects
 * - Read session data (messages, tool uses, etc.)
 * - Access conversation history
 * - Read subagent session files
 */
export class SessionReader {
  private configDir: string;
  private defaultCwd?: string;

  constructor(config?: SessionReaderConfig) {
    this.configDir = config?.configDir || path.join(os.homedir(), '.claude');
    this.defaultCwd = config?.defaultCwd;
  }

  // --------------------------------------------------------------------------
  // Project Resolution
  // --------------------------------------------------------------------------

  /**
   * Get the projects directory path
   */
  getProjectsDir(): string {
    return path.join(this.configDir, 'projects');
  }

  /**
   * Convert a working directory to a project key
   */
  cwdToProjectKey(cwd: string): string {
    // Path with slashes replaced by hyphens
    // e.g., /home/ubuntu/tier-agent -> -home-ubuntu-tier-agent
    return cwd.replace(/\//g, '-');
  }

  /**
   * Get the project directory for a working directory
   */
  getProjectDir(cwd?: string): string {
    const workingDir = cwd || this.defaultCwd || process.cwd();
    const projectKey = this.cwdToProjectKey(workingDir);
    return path.join(this.getProjectsDir(), projectKey);
  }

  /**
   * Get the session file path
   */
  getSessionFilePath(sessionId: string, cwd?: string): string {
    return path.join(this.getProjectDir(cwd), `${sessionId}.jsonl`);
  }

  // --------------------------------------------------------------------------
  // Session Listing
  // --------------------------------------------------------------------------

  /**
   * List all sessions in a project
   */
  listSessions(cwd?: string): SessionSummary[] {
    const projectDir = this.getProjectDir(cwd);
    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const sessions: SessionSummary[] = [];
    const files = fs.readdirSync(projectDir);

    for (const file of files) {
      // Skip subagent files (agent-*.jsonl)
      if (!file.endsWith('.jsonl') || file.startsWith('agent-')) {
        continue;
      }

      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);
      const stats = fs.statSync(filePath);

      sessions.push({
        sessionId,
        projectPath: cwd || this.defaultCwd || process.cwd(),
        projectKey: this.cwdToProjectKey(cwd || this.defaultCwd || process.cwd()),
        lastModified: stats.mtime,
        sizeBytes: stats.size,
      });
    }

    // Sort by last modified desc
    sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return sessions;
  }

  /**
   * List sessions with additional details (reads first and last lines of each file)
   */
  listSessionsWithDetails(cwd?: string): SessionInfo[] {
    const summaries = this.listSessions(cwd);
    const detailed: SessionInfo[] = [];

    for (const summary of summaries) {
      const info: SessionInfo = { ...summary };

      try {
        const filePath = this.getSessionFilePath(summary.sessionId, cwd);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        if (lines.length > 0) {
          // Parse first line for init info
          try {
            const firstLine = JSON.parse(lines[0]);
            if (firstLine.type === 'system' && firstLine.subtype === 'init') {
              info.model = firstLine.model;
            }
          } catch {
            // Ignore parse errors
          }

          // Parse last line for result info
          try {
            const lastLine = JSON.parse(lines[lines.length - 1]);
            if (lastLine.type === 'result') {
              info.numTurns = lastLine.num_turns;
              info.totalCostUsd = lastLine.total_cost_usd;
              info.durationMs = lastLine.duration_ms;
              info.status = lastLine.is_error ? 'error' : 'completed';
              info.result = lastLine.result;
            } else {
              // Session might still be active
              info.status = 'active';
            }
          } catch {
            // Ignore parse errors
          }
        }
      } catch {
        // Ignore read errors
      }

      detailed.push(info);
    }

    return detailed;
  }

  /**
   * List all projects
   */
  listProjects(): ProjectInfo[] {
    const projectsDir = this.getProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const projects: ProjectInfo[] = [];
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = path.join(projectsDir, entry.name);
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      if (files.length === 0) continue;

      // Get latest activity
      let lastActivity = new Date(0);
      for (const file of files) {
        const stats = fs.statSync(path.join(projectDir, file));
        if (stats.mtime > lastActivity) {
          lastActivity = stats.mtime;
        }
      }

      projects.push({
        key: entry.name,
        path: '/' + entry.name.replace(/-/g, '/'),
        sessionCount: files.length,
        lastActivity,
      });
    }

    // Sort by last activity desc
    projects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

    return projects;
  }

  // --------------------------------------------------------------------------
  // Session Existence Check
  // --------------------------------------------------------------------------

  /**
   * Check if a session file exists
   */
  sessionExists(sessionId: string, cwd?: string): boolean {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    return fs.existsSync(filePath);
  }

  // --------------------------------------------------------------------------
  // Subagent Files
  // --------------------------------------------------------------------------

  /**
   * List subagent files in a project
   * Checks both top-level agent files and session-specific subagents directories
   */
  listSubagentFiles(sessionId?: string, cwd?: string): SubagentFileInfo[] {
    const projectDir = this.getProjectDir(cwd);
    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const files: SubagentFileInfo[] = [];
    const addAgentFile = (filePath: string, parentSessionId: string) => {
      const fileName = path.basename(filePath);
      const match = fileName.match(/^agent-(.+)\.jsonl$/);
      if (!match) return;

      const agentId = match[1];
      try {
        const stats = fs.statSync(filePath);
        files.push({
          agentId,
          sessionId: parentSessionId,
          filePath,
          lastModified: stats.mtime,
          sizeBytes: stats.size,
        });
      } catch {
        // Ignore files we can't stat
      }
    };

    // Check top-level agent files
    const entries = fs.readdirSync(projectDir);
    for (const file of entries) {
      if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
        addAgentFile(path.join(projectDir, file), sessionId || 'unknown');
      }
    }

    // Check session-specific subagents directories
    for (const entry of entries) {
      const entryPath = path.join(projectDir, entry);
      const subagentsDir = path.join(entryPath, 'subagents');

      // If sessionId filter is provided, only check that session's subagents dir
      if (sessionId && entry !== sessionId) continue;

      if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
        const subagentFiles = fs.readdirSync(subagentsDir);
        for (const file of subagentFiles) {
          if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
            addAgentFile(path.join(subagentsDir, file), entry);
          }
        }
      }
    }

    // Sort by last modified desc
    files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return files;
  }

  // --------------------------------------------------------------------------
  // Low-Level File Reading
  // --------------------------------------------------------------------------

  /**
   * Read all lines from a session file
   */
  async readSessionLines(sessionId: string, cwd?: string): Promise<string[]> {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const lines: string[] = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        lines.push(line);
      }
    }

    return lines;
  }

  /**
   * Read session lines from a specific position (useful for incremental reading)
   */
  async readSessionLinesFrom(
    sessionId: string,
    fromLineIndex: number,
    cwd?: string,
    limit?: number
  ): Promise<{ lines: string[]; totalLines: number }> {
    const allLines = await this.readSessionLines(sessionId, cwd);
    const totalLines = allLines.length;

    let lines = allLines.slice(fromLineIndex);
    if (limit && limit > 0) {
      lines = lines.slice(0, limit);
    }

    return { lines, totalLines };
  }

  /**
   * Parse a JSONL line safely
   */
  parseJsonlLine<T = unknown>(line: string): T | null {
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let defaultReader: SessionReader | null = null;

/**
 * Create a new SessionReader instance
 */
export function createSessionReader(config?: SessionReaderConfig): SessionReader {
  return new SessionReader(config);
}

/**
 * Get the default SessionReader instance (singleton)
 */
export function getSessionReader(): SessionReader {
  if (!defaultReader) {
    defaultReader = new SessionReader();
  }
  return defaultReader;
}

/**
 * Reset the default reader (for testing)
 */
export function resetSessionReader(): void {
  defaultReader = null;
}

// Backward compatibility aliases
export const ClaudeSessionReader = SessionReader;
export const createClaudeSessionReader = createSessionReader;
export const getClaudeSessionReader = getSessionReader;
export const resetClaudeSessionReader = resetSessionReader;
