/**
 * Session Manager
 * Manages Claude Code session files and history
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Session, SessionMessage, SessionFilter, TokenUsage } from './types';
import {
  getProjectsDir,
  getSessionFilePath,
  getProjectStorageDir,
  decodePath,
  getClaudeConfigDir,
} from './utils/path-utils';
import {
  readJsonlFile,
  streamJsonlFile,
  parseSessionRecord,
  countSessionTokens,
  extractTextContent,
  RawSessionRecord,
} from './utils/jsonl-parser';
import { CostCalculator } from './cost-calculator';

/**
 * Session Manager class
 */
export class SessionManager {
  private configDir: string;
  private projectsDir: string;
  private costCalculator: CostCalculator;

  constructor(configDir?: string) {
    this.configDir = configDir || getClaudeConfigDir();
    this.projectsDir = getProjectsDir(this.configDir);
    this.costCalculator = new CostCalculator();
  }

  /**
   * List all sessions across all projects
   */
  async listAllSessions(filter?: SessionFilter): Promise<Session[]> {
    const sessions: Session[] = [];

    if (!fs.existsSync(this.projectsDir)) {
      return sessions;
    }

    const projectDirs = fs.readdirSync(this.projectsDir);

    for (const encodedProject of projectDirs) {
      const projectPath = decodePath(encodedProject);
      const projectDir = path.join(this.projectsDir, encodedProject);

      if (!fs.statSync(projectDir).isDirectory()) {
        continue;
      }

      // Apply project filter
      if (filter?.projectPath && projectPath !== filter.projectPath) {
        continue;
      }

      const projectSessions = await this.listProjectSessions(projectPath, filter);
      sessions.push(...projectSessions);
    }

    // Sort by updated date descending
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    return sessions;
  }

  /**
   * List sessions for a specific project
   */
  async listProjectSessions(projectPath: string, filter?: SessionFilter): Promise<Session[]> {
    const sessions: Session[] = [];
    const projectDir = getProjectStorageDir(projectPath, this.configDir);

    if (!fs.existsSync(projectDir)) {
      return sessions;
    }

    const files = fs.readdirSync(projectDir);
    const sessionFiles = files.filter(
      (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
    );

    for (const sessionFile of sessionFiles) {
      const sessionId = sessionFile.replace('.jsonl', '');
      const filePath = path.join(projectDir, sessionFile);
      const session = await this.getSessionInfo(projectPath, sessionId);

      if (!session) continue;

      // Apply filters
      if (filter?.fromDate && session.createdAt < filter.fromDate) continue;
      if (filter?.toDate && session.updatedAt > filter.toDate) continue;
      if (filter?.minMessages && session.messageCount < filter.minMessages) continue;
      if (filter?.searchTerm && session.summary) {
        if (!session.summary.toLowerCase().includes(filter.searchTerm.toLowerCase())) {
          continue;
        }
      }

      sessions.push(session);
    }

    return sessions;
  }

  /**
   * Get detailed session information
   */
  async getSessionInfo(projectPath: string, sessionId: string): Promise<Session | null> {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    const { tokens, messageCount } = await countSessionTokens(filePath);

    // Get summary from session file
    let summary: string | undefined;
    let name: string | undefined;
    let firstTimestamp: Date | undefined;
    let lastTimestamp: Date | undefined;

    await streamJsonlFile<RawSessionRecord>(filePath, (record) => {
      // Track timestamps
      if (record.timestamp) {
        const ts = new Date(record.timestamp);
        if (!firstTimestamp || ts < firstTimestamp) {
          firstTimestamp = ts;
        }
        if (!lastTimestamp || ts > lastTimestamp) {
          lastTimestamp = ts;
        }
      }

      // Get summary
      if (record.type === 'summary' && record.summary) {
        summary = record.summary;
      }
    });

    const cost = this.costCalculator.calculateCost(tokens);

    return {
      id: sessionId,
      projectPath,
      filePath,
      name,
      createdAt: firstTimestamp || stats.birthtime,
      updatedAt: lastTimestamp || stats.mtime,
      messageCount,
      totalTokens:
        tokens.inputTokens +
        tokens.outputTokens +
        tokens.cacheCreationInputTokens +
        tokens.cacheReadInputTokens,
      estimatedCost: cost.totalCost,
      summary,
    };
  }

  /**
   * Get all messages from a session
   */
  async getSessionMessages(projectPath: string, sessionId: string): Promise<SessionMessage[]> {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);
    const records = await readJsonlFile<RawSessionRecord>(filePath);

    const messages: SessionMessage[] = [];
    for (const record of records) {
      const message = parseSessionRecord(record);
      if (message) {
        messages.push(message);
      }
    }

    return messages;
  }

  /**
   * Get conversation thread (messages linked by parentUuid)
   */
  async getConversationThread(
    projectPath: string,
    sessionId: string
  ): Promise<SessionMessage[][]> {
    const messages = await this.getSessionMessages(projectPath, sessionId);

    // Build parent-child map
    const childrenMap = new Map<string, SessionMessage[]>();
    const rootMessages: SessionMessage[] = [];

    for (const msg of messages) {
      if (!msg.parentUuid) {
        rootMessages.push(msg);
      } else {
        const children = childrenMap.get(msg.parentUuid) || [];
        children.push(msg);
        childrenMap.set(msg.parentUuid, children);
      }
    }

    // Build threads
    const threads: SessionMessage[][] = [];

    function buildThread(msg: SessionMessage, currentThread: SessionMessage[]): void {
      currentThread.push(msg);
      const children = childrenMap.get(msg.uuid) || [];

      if (children.length === 0) {
        threads.push([...currentThread]);
      } else if (children.length === 1) {
        buildThread(children[0], currentThread);
      } else {
        // Fork: multiple children
        for (const child of children) {
          buildThread(child, [...currentThread]);
        }
      }
    }

    for (const root of rootMessages) {
      buildThread(root, []);
    }

    return threads;
  }

  /**
   * Get session token usage summary
   */
  async getSessionUsage(
    projectPath: string,
    sessionId: string
  ): Promise<{ tokens: TokenUsage; cost: number; messageCount: number }> {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);
    const { tokens, messageCount } = await countSessionTokens(filePath);
    const cost = this.costCalculator.calculateCost(tokens);

    return {
      tokens,
      cost: cost.totalCost,
      messageCount,
    };
  }

  /**
   * Search sessions by content
   */
  async searchSessions(
    searchTerm: string,
    options?: { projectPath?: string; limit?: number }
  ): Promise<Array<{ session: Session; matches: string[] }>> {
    const results: Array<{ session: Session; matches: string[] }> = [];
    const sessions = await this.listAllSessions({
      projectPath: options?.projectPath,
    });

    const searchLower = searchTerm.toLowerCase();
    const limit = options?.limit || 50;

    for (const session of sessions) {
      if (results.length >= limit) break;

      const messages = await this.getSessionMessages(session.projectPath, session.id);
      const matches: string[] = [];

      for (const msg of messages) {
        const text = extractTextContent(msg.content);
        if (text.toLowerCase().includes(searchLower)) {
          // Extract context around match
          const idx = text.toLowerCase().indexOf(searchLower);
          const start = Math.max(0, idx - 50);
          const end = Math.min(text.length, idx + searchTerm.length + 50);
          matches.push('...' + text.slice(start, end) + '...');
        }
      }

      if (matches.length > 0) {
        results.push({ session, matches: matches.slice(0, 5) }); // Limit matches per session
      }
    }

    return results;
  }

  /**
   * Delete a session
   */
  deleteSession(projectPath: string, sessionId: string): boolean {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }

    return false;
  }

  /**
   * Export session to a file
   */
  async exportSession(
    projectPath: string,
    sessionId: string,
    outputPath: string,
    format: 'jsonl' | 'json' | 'markdown' = 'jsonl'
  ): Promise<void> {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (format === 'jsonl') {
      fs.copyFileSync(filePath, outputPath);
      return;
    }

    const messages = await this.getSessionMessages(projectPath, sessionId);

    if (format === 'json') {
      fs.writeFileSync(outputPath, JSON.stringify(messages, null, 2));
      return;
    }

    // Markdown format
    const session = await this.getSessionInfo(projectPath, sessionId);
    let markdown = `# Session: ${sessionId}\n\n`;
    markdown += `**Project:** ${projectPath}\n`;
    markdown += `**Created:** ${session?.createdAt.toISOString()}\n`;
    markdown += `**Messages:** ${session?.messageCount}\n`;
    markdown += `**Estimated Cost:** $${session?.estimatedCost.toFixed(4)}\n\n`;
    markdown += '---\n\n';

    for (const msg of messages) {
      const role = msg.type === 'user' ? '**User:**' : '**Assistant:**';
      const content = extractTextContent(msg.content);
      markdown += `${role}\n\n${content}\n\n---\n\n`;
    }

    fs.writeFileSync(outputPath, markdown);
  }

  /**
   * Get recent sessions
   */
  async getRecentSessions(limit: number = 10): Promise<Session[]> {
    const sessions = await this.listAllSessions();
    return sessions.slice(0, limit);
  }

  /**
   * Get session file path
   */
  getSessionPath(projectPath: string, sessionId: string): string {
    return getSessionFilePath(projectPath, sessionId, this.configDir);
  }

  /**
   * Check if session exists
   */
  sessionExists(projectPath: string, sessionId: string): boolean {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);
    return fs.existsSync(filePath);
  }

  /**
   * Read raw session file content
   */
  async readRawSession(projectPath: string, sessionId: string): Promise<string> {
    const filePath = getSessionFilePath(projectPath, sessionId, this.configDir);
    return fs.readFileSync(filePath, 'utf-8');
  }
}

/**
 * Create a new session manager instance
 */
export function createSessionManager(configDir?: string): SessionManager {
  return new SessionManager(configDir);
}
