/**
 * Core Routes (lm-assist)
 *
 * Routes for the assistant-relevant backend features only.
 */

import type { RouteHandler, RouteContext } from '../index';

// Import route factories (20 routes)
import { createHealthRoutes } from './health.routes';
import { createSessionsRoutes } from './sessions.routes';
import { createSessionProjectsRoutes } from './session-projects.routes';
import { createTasksRoutes } from './tasks.routes';
import { createTaskStoreRoutes } from './task-store.routes';
import { createTtydRoutes } from './ttyd.routes';
import { createHubRoutes } from './hub.routes';
import { createTmuxRoutes } from './tmux.routes';
import { createClaudeCodeRoutes } from './claude-code.routes';
import { createKnowledgeRoutes } from './knowledge.routes';
import { createKnowledgeSettingsRoutes } from './knowledge-settings.routes';
import { createSessionSearchRoutes } from './session-search.routes';
import { createAssistResourcesRoutes } from './assist-resources.routes';
import { createShellConfigRoutes } from './shell-config.routes';
import { createPlansRoutes } from './plans.routes';
import { createSessionDagRoutes } from './session-dag.routes';
import { createContextRoutes } from './context.routes';
import { createVectorRoutes } from './vector.routes';
import { createAgentRoutes } from './agent.routes';
import { createMcpApiRoutes } from './mcp-api.routes';
import { createDevModeRoutes } from './dev-mode.routes';
import { createProjectSettingsRoutes } from './project-settings.routes';

/**
 * Create all core routes
 */
export function createCoreRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    ...createAgentRoutes(ctx),
    ...createHealthRoutes(ctx),
    ...createSessionsRoutes(ctx),
    ...createSessionProjectsRoutes(ctx),
    ...createTasksRoutes(ctx),
    ...createTaskStoreRoutes(ctx),
    ...createTtydRoutes(ctx),
    ...createHubRoutes(ctx),
    ...createTmuxRoutes(ctx),
    ...createClaudeCodeRoutes(ctx),
    ...createKnowledgeRoutes(ctx),
    ...createKnowledgeSettingsRoutes(ctx),
    ...createSessionSearchRoutes(ctx),
    ...createAssistResourcesRoutes(ctx),
    ...createShellConfigRoutes(ctx),
    ...createPlansRoutes(ctx),
    ...createSessionDagRoutes(ctx),
    ...createContextRoutes(ctx),
    ...createVectorRoutes(ctx),
    ...createMcpApiRoutes(ctx),
    ...createDevModeRoutes(ctx),
    ...createProjectSettingsRoutes(ctx),
  ];
}
