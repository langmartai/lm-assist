/**
 * Session Map
 *
 * Bidirectional mapping between chat peer IDs and Claude Code sessions.
 * Persists to disk so session context survives plugin restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionMapping, SessionState } from './types';

const PERSIST_DIR = path.join(os.homedir(), '.lm-assist');
const PERSIST_FILE = path.join(PERSIST_DIR, 'openclaw-sessions.json');

export class SessionMap {
  /** peerId → SessionMapping */
  private map = new Map<string, SessionMapping>();

  constructor() {
    this.load();
  }

  // ============================================================================
  // Lookup
  // ============================================================================

  /**
   * Get session mapping for a peer
   */
  get(peerId: string): SessionMapping | undefined {
    return this.map.get(peerId);
  }

  /**
   * Find peer ID by execution ID
   */
  findByExecutionId(executionId: string): string | undefined {
    for (const [peerId, mapping] of this.map) {
      if (mapping.executionId === executionId) return peerId;
    }
    return undefined;
  }

  /**
   * Find peer ID by session ID
   */
  findBySessionId(sessionId: string): string | undefined {
    for (const [peerId, mapping] of this.map) {
      if (mapping.sessionId === sessionId) return peerId;
    }
    return undefined;
  }

  /**
   * Check if a peer has an active (non-idle) session
   */
  isActive(peerId: string): boolean {
    const m = this.map.get(peerId);
    return m !== undefined && m.state !== 'idle';
  }

  /**
   * Get all active sessions
   */
  getActive(): Array<{ peerId: string; mapping: SessionMapping }> {
    const result: Array<{ peerId: string; mapping: SessionMapping }> = [];
    for (const [peerId, mapping] of this.map) {
      if (mapping.state !== 'idle') {
        result.push({ peerId, mapping });
      }
    }
    return result;
  }

  /**
   * Get all sessions
   */
  getAll(): Array<{ peerId: string; mapping: SessionMapping }> {
    return Array.from(this.map.entries()).map(([peerId, mapping]) => ({
      peerId,
      mapping,
    }));
  }

  // ============================================================================
  // Mutations
  // ============================================================================

  /**
   * Set session mapping for a peer (starts a new execution)
   */
  set(
    peerId: string,
    sessionId: string,
    executionId: string,
    project: string
  ): void {
    const now = new Date().toISOString();
    this.map.set(peerId, {
      sessionId,
      executionId,
      project,
      state: 'executing',
      createdAt: now,
      lastActivityAt: now,
    });
    this.save();
  }

  /**
   * Update session state
   */
  setState(peerId: string, state: SessionState): void {
    const m = this.map.get(peerId);
    if (!m) return;
    m.state = state;
    m.lastActivityAt = new Date().toISOString();
    // Clear pending IDs when returning to executing or idle
    if (state === 'executing' || state === 'idle') {
      m.pendingPermissionRequestId = undefined;
      m.pendingQuestionRequestId = undefined;
    }
    this.save();
  }

  /**
   * Update session ID (available after SDK init completes)
   */
  updateSessionId(peerId: string, sessionId: string): void {
    const m = this.map.get(peerId);
    if (!m) return;
    m.sessionId = sessionId;
    m.lastActivityAt = new Date().toISOString();
    this.save();
  }

  /**
   * Set pending permission request
   */
  setPendingPermission(peerId: string, requestId: string): void {
    const m = this.map.get(peerId);
    if (!m) return;
    m.state = 'waiting_permission';
    m.pendingPermissionRequestId = requestId;
    m.lastActivityAt = new Date().toISOString();
    this.save();
  }

  /**
   * Set pending question
   */
  setPendingQuestion(peerId: string, requestId: string): void {
    const m = this.map.get(peerId);
    if (!m) return;
    m.state = 'waiting_question';
    m.pendingQuestionRequestId = requestId;
    m.lastActivityAt = new Date().toISOString();
    this.save();
  }

  /**
   * Mark session as completed (idle)
   */
  complete(peerId: string): void {
    this.setState(peerId, 'idle');
  }

  /**
   * Remove session mapping for a peer
   */
  remove(peerId: string): void {
    this.map.delete(peerId);
    this.save();
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.map.clear();
    this.save();
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private load(): void {
    try {
      if (fs.existsSync(PERSIST_FILE)) {
        const raw = fs.readFileSync(PERSIST_FILE, 'utf-8');
        const data = JSON.parse(raw) as Record<string, SessionMapping>;
        this.map = new Map(Object.entries(data));
      }
    } catch {
      // Start fresh if file is corrupted
      this.map = new Map();
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(PERSIST_DIR)) {
        fs.mkdirSync(PERSIST_DIR, { recursive: true });
      }
      const data: Record<string, SessionMapping> = {};
      for (const [peerId, mapping] of this.map) {
        data[peerId] = mapping;
      }
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
    } catch {
      // Silently fail on write errors — non-critical
    }
  }
}
