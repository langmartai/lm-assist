/**
 * Route Infrastructure (lm-assist)
 *
 * Provides types and aggregation for modular route files.
 */

import type { TierControlApiImpl } from '../control-api';
import type { TierManager } from '../tier-manager';
import type { ProjectManager } from '../project-manager';

// ============================================================================
// Route Types
// ============================================================================

/**
 * Parsed HTTP request with extracted parameters
 */
export interface ParsedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  raw?: {
    req: any;
    res: any;
  };
}

/**
 * Route handler definition
 */
export interface RouteHandler {
  method: string;
  pattern: RegExp;
  handler: (req: ParsedRequest, api: TierControlApiImpl) => Promise<any>;
  /** Optional: marks route as streaming (SSE) */
  streaming?: boolean;
  /** Optional: marks route as binary response */
  binary?: boolean;
}

/**
 * Context provided to route factory functions
 */
export interface RouteContext {
  api: TierControlApiImpl;
  tierManager: TierManager;
  projectPath: string;

  // Lazy-loaded service getters (kept subset)
  getProjectManager(): ProjectManager;
  getSessionStore(): import('../agent-session-store').AgentSessionStore;
  getEventStore(): import('../event-store').EventStore;
}

/**
 * Route factory function signature
 */
export type RouteFactory = (ctx: RouteContext) => RouteHandler[];

// ============================================================================
// Route Aggregation
// ============================================================================

import { createCoreRoutes } from './core';

/**
 * Create all routes with the given context
 */
export function createAllRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    ...createCoreRoutes(ctx),
  ];
}

/**
 * Create route context from server options
 */
export function createRouteContext(
  api: TierControlApiImpl,
  tierManager: TierManager,
  projectPath: string
): RouteContext {
  // Lazy-loaded service instances
  let projectManager: ProjectManager | null = null;
  let sessionStore: import('../agent-session-store').AgentSessionStore | null = null;
  let eventStore: import('../event-store').EventStore | null = null;

  return {
    api,
    tierManager,
    projectPath,

    getProjectManager() {
      if (!projectManager) {
        const { createProjectManager } = require('../project-manager');
        projectManager = createProjectManager();
      }
      return projectManager!;
    },

    getSessionStore() {
      if (!sessionStore) {
        const { createAgentSessionStore } = require('../agent-session-store');
        sessionStore = createAgentSessionStore({ projectPath });
      }
      return sessionStore!;
    },

    getEventStore() {
      if (!eventStore) {
        const { createEventStore } = require('../event-store');
        eventStore = createEventStore({ projectPath });
      }
      return eventStore!;
    },
  };
}

// Re-export types
export type { TierControlApiImpl } from '../control-api';
export type { TierManager } from '../tier-manager';
