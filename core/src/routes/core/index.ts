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
import { createClaudeAIRoutes } from './claude-ai.routes';
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
import { createGithubRoutes } from './github.routes';
import { createMcpApiRoutes } from './mcp-api.routes';
import { createDevModeRoutes } from './dev-mode.routes';
import { createProjectSettingsRoutes } from './project-settings.routes';
import { createSkillRoutes } from './skills.routes';
import { createTerminalRoutes } from './terminal.routes';
import { createAnnotationRoutes } from './annotation.routes';
import { createMemoryRoutes } from './memory.routes';
import { createMemoryMapRoutes } from './memory-map.routes';
import { createMemoryAutoSyncRoutes } from './memory-autosync.routes';
import { createMemoryHarvestRoutes } from './memory-harvest.routes';
import { createMemoryProposalsRoutes } from './memory-proposals.routes';
import { createMemoryReconcileRoutes } from './memory-reconcile.routes';
import { createMemoryValidateRoutes } from './memory-validate.routes';
import { createMemorySyncRoutes } from './memory-sync.routes';
import { createMemoryFilesRoutes } from './memory-files.routes';
import { createRuleMapRoutes } from './rule-map.routes';
import { createRuleSyncRoutes } from './rule-sync.routes';
import { createRuleFilesRoutes } from './rule-files.routes';
import { createBrowserRoutes } from './browser.routes';
import { createCcrRoutes } from './ccr.routes';
import { createTerminalStdRoutes } from './terminal-std.routes';
import { createPortForwardRoutes } from './port-forward.routes';
import { createSessionMessagingRoutes } from './session-messaging.routes';
import { createTransportRoutes } from './transport.routes';
import { createRemoteControlRoutes } from './remote-control.routes';
import { createDataRoutes } from './data.routes';
import { createSchedulerRoutes } from './scheduler.routes';
import { createWorkerRoutes } from './worker.routes';
import { createMissionRoutes } from './mission.routes';
import { createMonitorStallsRoutes } from './monitor-stalls.routes';
import { createNodeRoutes } from './node.routes';
import { createClusterRoutes } from './cluster.routes';
import { createFabricRoutes } from './fabric.routes';
import { createBusRoutes } from './bus.routes';
import { createFleetRoutes } from './fleet.routes';
import { createLifecycleRoutes } from './lifecycle.routes';
import { createWhatsappRoutes } from './whatsapp.routes';
import { createElevatedRoutes } from './elevated.routes';

/**
 * Create all core routes
 */
export function createCoreRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    ...createAgentRoutes(ctx),
    ...createGithubRoutes(ctx),
    ...createHealthRoutes(ctx),
    ...createSessionsRoutes(ctx),
    ...createSessionProjectsRoutes(ctx),
    ...createTasksRoutes(ctx),
    ...createTaskStoreRoutes(ctx),
    ...createTtydRoutes(ctx),
    ...createHubRoutes(ctx),
    ...createTmuxRoutes(ctx),
    ...createClaudeCodeRoutes(ctx),
    ...createClaudeAIRoutes(ctx),
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
    ...createSkillRoutes(ctx),
    ...createTerminalRoutes(ctx),
    ...createAnnotationRoutes(ctx),
    ...createMemoryRoutes(ctx),
    ...createMemoryMapRoutes(ctx),
    ...createMemoryAutoSyncRoutes(ctx),
    ...createMemoryHarvestRoutes(ctx),
    ...createMemoryProposalsRoutes(ctx),
    ...createMemoryReconcileRoutes(ctx),
    ...createMemoryValidateRoutes(ctx),
    ...createMemorySyncRoutes(ctx),
    ...createMemoryFilesRoutes(ctx),
    ...createRuleFilesRoutes(ctx),
    ...createRuleMapRoutes(ctx),
    ...createRuleSyncRoutes(ctx),
    ...createBrowserRoutes(ctx),
    ...createCcrRoutes(ctx),
    ...createTerminalStdRoutes(ctx),
    ...createPortForwardRoutes(ctx),
    ...createSessionMessagingRoutes(ctx),
    ...createTransportRoutes(ctx),
    ...createRemoteControlRoutes(ctx),
    ...createDataRoutes(ctx),
    ...createSchedulerRoutes(ctx),
    ...createWorkerRoutes(ctx),
    ...createMissionRoutes(ctx),
    ...createMonitorStallsRoutes(ctx),
    ...createNodeRoutes(ctx),
    ...createClusterRoutes(ctx),
    ...createFabricRoutes(ctx),
    ...createBusRoutes(ctx),
    ...createFleetRoutes(ctx),
    ...createLifecycleRoutes(ctx),
    ...createWhatsappRoutes(ctx),
    ...createElevatedRoutes(ctx),
  ];
}
