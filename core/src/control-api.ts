/**
 * Control API Implementation (Simplified)
 *
 * Provides monitoring and control interface for the lm-assist project.
 * Stripped-down version that keeps:
 *   - wrapResponse / wrapError helpers
 *   - TierControlApiImpl class with constructor, getters, event system, monitor sub-API
 *   - createControlApi factory function
 *
 * Removed: control, config, queue, deploy, protocol, job, preflight,
 *          vibeCoder, visualEditor, executionIntegrator, checkpoint, sessionBackup
 */

import { v4 as uuidv4 } from 'uuid';
import { TierManager } from './tier-manager';
import {
  EventStore,
  createEventStore,
} from './event-store';
import {
  AgentSessionStore,
  createAgentSessionStore,
} from './agent-session-store';
import {
  AgentSessionMonitor,
  createAgentSessionMonitor,
} from './agent-session-monitor';
import { ClaudeSdkRunner } from './sdk-runner';
import { createSessionsApiImpl } from './api/sessions-api';
import { createAgentApiImpl } from './api/agent-api';
import { createTasksApiImpl } from './api/tasks-api';
import { getStartupProfiler } from './startup-profiler';
import type {
  ApiResponse,
  TierEvent,
  SessionsApi,
  TasksApi,
} from './types/control-api';
import type { AgentApi } from './types/agent-api';

// ============================================================================
// Helper Functions
// ============================================================================

export function wrapResponse<T>(data: T, startTime: number): ApiResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date(),
      requestId: uuidv4(),
      durationMs: Date.now() - startTime,
    },
  };
}

export function wrapError(code: string, message: string, startTime: number): ApiResponse<never> {
  return {
    success: false,
    error: { code, message },
    meta: {
      timestamp: new Date(),
      requestId: uuidv4(),
      durationMs: Date.now() - startTime,
    },
  };
}

// ============================================================================
// Simplified Monitor API interface
// ============================================================================

export interface SimpleMonitorApi {
  /** Get basic status (uptime, projectPath) */
  getStatus(): Promise<ApiResponse<{ uptime: number; projectPath: string }>>;
  /** Get health check info */
  getHealth(): Promise<ApiResponse<{
    status: string;
    uptime: number;
    projectPath: string;
    version: string;
  }>>;
}

// ============================================================================
// Control API Implementation
// ============================================================================

export class TierControlApiImpl {
  private tierManager: TierManager;
  private projectPath: string;
  private startTime: Date;
  private eventListeners: Set<(event: TierEvent) => void> = new Set();
  private eventStore: EventStore;
  private sessionStore: AgentSessionStore;
  private sessionMonitor: AgentSessionMonitor;
  private sdkRunner: ClaudeSdkRunner;

  public monitor: SimpleMonitorApi;
  public sessions: SessionsApi;
  public agent: AgentApi;
  public claudeTasks: TasksApi;

  constructor(projectPath: string, tierManager?: TierManager) {
    const profiler = getStartupProfiler();

    this.projectPath = projectPath;
    this.startTime = new Date();
    this.tierManager = tierManager || new TierManager({ projectPath });

    // Initialize event store with persistence
    profiler.start('eventStore', 'EventStore', 'ControlApi');
    this.eventStore = createEventStore({
      projectPath,
      persist: true,
      maxEvents: 10000,
      maxExecutions: 1000,
    });
    profiler.end('eventStore');

    // Initialize SDK runner for session monitoring
    profiler.start('sdkRunner', 'SdkRunner', 'ControlApi');
    this.sdkRunner = new ClaudeSdkRunner({
      loadClaudeMd: true,
      permissionMode: 'default',
    });
    profiler.end('sdkRunner');

    // Initialize session store
    profiler.start('sessionStore', 'SessionStore', 'ControlApi');
    this.sessionStore = createAgentSessionStore({
      projectPath,
      persist: true,
      maxSessions: 1000,
      cleanupAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    profiler.end('sessionStore');

    // Initialize session monitor
    profiler.start('sessionMonitor', 'SessionMonitor', 'ControlApi');
    this.sessionMonitor = createAgentSessionMonitor({
      sessionStore: this.sessionStore,
      sdkRunner: this.sdkRunner,
      emitDetailedProgress: true,
      progressIntervalMs: 5000,
    });
    profiler.end('sessionMonitor');

    // Forward session events to main event system
    this.sessionStore.on('session_update', (event) => {
      this.emit({
        type: 'session_update',
        timestamp: new Date(),
        tier: event.session.tier,
        data: {
          type: event.type,
          session: {
            sessionId: event.session.sessionId,
            executionId: event.session.executionId,
            tier: event.session.tier,
            status: event.session.status,
          },
          previousStatus: event.previousStatus,
        },
      });
    });

    // Initialize sub-APIs
    profiler.start('subApis', 'Sub-APIs', 'ControlApi');
    this.monitor = this.createMonitorApi();
    this.sessions = createSessionsApiImpl({
      sessionStore: this.sessionStore,
      sessionMonitor: this.sessionMonitor,
    });
    profiler.end('subApis');

    // Initialize Agent API (direct SDK access with full options)
    profiler.start('agentApi', 'AgentApi', 'ControlApi');
    this.agent = createAgentApiImpl({
      sdkRunner: this.sdkRunner,
      sessionStore: this.sessionStore,
      projectPath,
    });
    profiler.end('agentApi');

    // Initialize Claude Code Tasks API
    this.claudeTasks = createTasksApiImpl();
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  /**
   * Get the project path
   */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Get the tier manager
   */
  getTierManager(): TierManager {
    return this.tierManager;
  }

  /**
   * Get the event store instance
   */
  getEventStore(): EventStore {
    return this.eventStore;
  }

  /**
   * Get the session store instance
   */
  getSessionStore(): AgentSessionStore {
    return this.sessionStore;
  }

  /**
   * Get the session monitor instance
   */
  getSessionMonitor(): AgentSessionMonitor {
    return this.sessionMonitor;
  }

  /**
   * Get the SDK runner instance
   */
  getSdkRunner(): ClaudeSdkRunner {
    return this.sdkRunner;
  }

  // --------------------------------------------------------------------------
  // Event System
  // --------------------------------------------------------------------------

  /**
   * Subscribe to events
   */
  subscribe(callback: (event: TierEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  private emit(event: TierEvent): void {
    // Record event in store (persisted)
    this.eventStore.recordEvent(event);

    // Notify listeners (SSE, SDK callbacks)
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Monitor API
  // --------------------------------------------------------------------------

  private createMonitorApi(): SimpleMonitorApi {
    return {
      getStatus: async () => {
        const start = Date.now();
        return wrapResponse({
          uptime: Date.now() - this.startTime.getTime(),
          projectPath: this.projectPath,
        }, start);
      },

      getHealth: async () => {
        const start = Date.now();
        return wrapResponse({
          status: 'healthy',
          uptime: Date.now() - this.startTime.getTime(),
          projectPath: this.projectPath,
          version: '0.1.0',
        }, start);
      },
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createControlApi(projectPath: string, tierManager?: TierManager): TierControlApiImpl {
  return new TierControlApiImpl(projectPath, tierManager);
}
