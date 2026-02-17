/**
 * Session Cache Sync
 *
 * Periodically syncs session summaries to the Hub for offline viewing.
 * This allows users to see session info even when the worker is disconnected.
 */

import { EventEmitter } from 'events';

/** Interface for WebSocket-like objects that can send messages */
export interface WebSocketSender {
  send(data: unknown): void;
  isConnected(): boolean;
}

export interface SessionSummary {
  sessionId: string;
  projectPath?: string;
  summary?: string;
  model?: string;
  messageCount?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
}

export interface SessionCacheSyncOptions {
  /** Local API port for fetching sessions */
  localApiPort?: number;
  /** Sync interval in milliseconds (default: 5 minutes) */
  syncIntervalMs?: number;
  /** Maximum sessions to sync per batch */
  maxSessionsPerSync?: number;
}

export class SessionCacheSync extends EventEmitter {
  private ws: WebSocketSender | null = null;
  private localApiPort: number;
  private syncIntervalMs: number;
  private maxSessionsPerSync: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private initialSyncTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: SessionCacheSyncOptions = {}) {
    super();
    this.localApiPort = options.localApiPort || 3100;
    this.syncIntervalMs = options.syncIntervalMs || 5 * 60 * 1000; // 5 minutes
    this.maxSessionsPerSync = options.maxSessionsPerSync || 100;
  }

  /**
   * Set the WebSocket connection
   */
  public setWebSocket(ws: WebSocketSender): void {
    this.ws = ws;
  }

  /**
   * Start periodic sync
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial sync after short delay
    this.initialSyncTimer = setTimeout(() => {
      this.initialSyncTimer = null;
      this.sync();
    }, 5000);

    // Schedule periodic syncs
    this.syncTimer = setInterval(() => this.sync(), this.syncIntervalMs);

    console.log(`[SessionCacheSync] Started with ${this.syncIntervalMs / 1000}s interval`);
  }

  /**
   * Stop periodic sync
   */
  public stop(): void {
    this.isRunning = false;
    if (this.initialSyncTimer) {
      clearTimeout(this.initialSyncTimer);
      this.initialSyncTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    console.log('[SessionCacheSync] Stopped');
  }

  /**
   * Perform a sync now
   */
  public async sync(): Promise<void> {
    if (!this.ws || !this.ws.isConnected()) {
      console.log('[SessionCacheSync] Skipping sync - not connected');
      return;
    }

    try {
      // Fetch sessions from local API
      const sessions = await this.fetchSessions();

      if (sessions.length === 0) {
        console.log('[SessionCacheSync] No sessions to sync');
        return;
      }

      // Send to Hub
      this.ws.send({
        type: 'session_cache_sync',
        sessions,
        timestamp: new Date().toISOString(),
      });

      console.log(`[SessionCacheSync] Synced ${sessions.length} sessions`);
      this.emit('synced', { count: sessions.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[SessionCacheSync] Sync failed:', errorMessage);
      this.emit('error', error);
    }
  }

  /**
   * Fetch sessions from local API
   */
  private async fetchSessions(): Promise<SessionSummary[]> {
    // Use AbortController for fetch timeout (30 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(
        `http://localhost:${this.localApiPort}/sessions?limit=${this.maxSessionsPerSync}`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json() as { sessions?: Array<Record<string, unknown>> };

      if (!data.sessions || !Array.isArray(data.sessions)) {
        return [];
      }

      // Transform to SessionSummary format
      return data.sessions.map(s => ({
        sessionId: s.sessionId as string,
        projectPath: s.projectPath as string | undefined,
        summary: s.summary as string | undefined,
        model: s.model as string | undefined,
        messageCount: s.messageCount as number | undefined,
        costUsd: s.costUsd as number | undefined,
        inputTokens: s.inputTokens as number | undefined,
        outputTokens: s.outputTokens as number | undefined,
        createdAt: s.createdAt as string | undefined,
        updatedAt: s.updatedAt as string | undefined,
        lastActivityAt: s.lastActivityAt as string | undefined,
      }));
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage = error instanceof Error
        ? (error.name === 'AbortError' ? 'Timeout fetching sessions from local API' : error.message)
        : String(error);
      console.error('[SessionCacheSync] Failed to fetch sessions:', errorMessage);
      return [];
    }
  }
}

// Singleton instance
let syncInstance: SessionCacheSync | null = null;

export function getSessionCacheSync(options?: SessionCacheSyncOptions): SessionCacheSync {
  if (!syncInstance) {
    syncInstance = new SessionCacheSync(options);
  }
  return syncInstance;
}
