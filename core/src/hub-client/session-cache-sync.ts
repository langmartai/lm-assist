/**
 * Session Cache Sync
 *
 * Periodically syncs session summaries to the Hub for offline viewing.
 * This allows users to see session info even when the worker is disconnected.
 */

import { EventEmitter } from 'events';
import { lmAuthHeaders } from '../auth/api-token';

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
    this.localApiPort = options.localApiPort || (__dirname.includes('node_modules') ? 3100 : 3200);
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
        { headers: lmAuthHeaders(), signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      // `GET /sessions` is wrapResponse-enveloped ({success,data:{sessions},meta}); older
      // shapes returned the array bare. Accept both — reading only the bare key is what
      // kept this sync at zero deliveries from its first release until 2026-08-19.
      const body = await response.json() as {
        sessions?: Array<Record<string, unknown>>;
        data?: { sessions?: Array<Record<string, unknown>> };
      };
      const rows = body.data?.sessions ?? body.sessions;

      if (!rows || !Array.isArray(rows)) {
        return [];
      }

      // Transform to SessionSummary format. The OUTGOING names are the hub's contract —
      // assist-api upserts them straight into tier_agent_session_cache columns — so the
      // source keys are what bend to the /sessions row shape, never the other way.
      return rows.map(s => {
        const usage = (s.usage ?? {}) as Record<string, unknown>;
        const lastActivity = s.lastModified as string | undefined;
        return {
          sessionId: s.sessionId as string,
          projectPath: s.projectPath as string | undefined,
          summary: s.sessionSummary as string | undefined,
          model: s.model as string | undefined,
          messageCount: s.numTurns as number | undefined,
          costUsd: s.totalCostUsd as number | undefined,
          inputTokens: usage.inputTokens as number | undefined,
          outputTokens: usage.outputTokens as number | undefined,
          createdAt: s.createdAt as string | undefined,
          updatedAt: lastActivity,
          lastActivityAt: lastActivity,
        };
      });
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
