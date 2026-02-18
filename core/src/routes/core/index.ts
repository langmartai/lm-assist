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
import { createMilestoneSettingsRoutes } from './milestone-settings.routes';
import { createMilestonePipelineRoutes } from './milestone-pipeline.routes';
import { createMilestonesRoutes } from './milestones.routes';
import { createKnowledgeRoutes } from './knowledge.routes';
import { createArchitectureRoutes } from './architecture.routes';
import { createSessionSearchRoutes } from './session-search.routes';
import { createAssistNaviRoutes } from './assist-navi.routes';
import { createShellConfigRoutes } from './shell-config.routes';
import { createPlansRoutes } from './plans.routes';
import { createSessionDagRoutes } from './session-dag.routes';
import { createContextRoutes } from './context.routes';
import { createVectorRoutes } from './vector.routes';

/**
 * Create all core routes
 */
export function createCoreRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    ...createHealthRoutes(ctx),
    ...createSessionsRoutes(ctx),
    ...createSessionProjectsRoutes(ctx),
    ...createTasksRoutes(ctx),
    ...createTaskStoreRoutes(ctx),
    ...createTtydRoutes(ctx),
    ...createHubRoutes(ctx),
    ...createTmuxRoutes(ctx),
    ...createClaudeCodeRoutes(ctx),
    ...createMilestoneSettingsRoutes(ctx),
    ...createMilestonePipelineRoutes(ctx),
    ...createMilestonesRoutes(ctx),
    ...createKnowledgeRoutes(ctx),
    ...createArchitectureRoutes(ctx),
    ...createSessionSearchRoutes(ctx),
    ...createAssistNaviRoutes(ctx),
    ...createShellConfigRoutes(ctx),
    ...createPlansRoutes(ctx),
    ...createSessionDagRoutes(ctx),
    ...createContextRoutes(ctx),
    ...createVectorRoutes(ctx),
  ];
}
