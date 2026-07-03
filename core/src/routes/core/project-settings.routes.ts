/**
 * Project Settings Routes
 *
 * Endpoints for managing project-level settings (e.g., excluded projects, knowledge kill switch).
 *
 * GET  /project-settings  — Get current settings
 * PUT  /project-settings  — Update settings (partial merge)
 */

import type { RouteHandler, RouteContext } from '../index';
import { getProjectSettings, saveProjectSettings } from '../../project-settings';

export function createProjectSettingsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /project-settings — Get current project settings
    {
      method: 'GET',
      pattern: /^\/project-settings$/,
      handler: async () => {
        const settings = getProjectSettings();
        return { success: true, data: settings };
      },
    },

    // PUT /project-settings — Update project settings (partial merge)
    {
      method: 'PUT',
      pattern: /^\/project-settings$/,
      handler: async (req) => {
        const body = req.body || {};
        const prevSettings = getProjectSettings();
        // missionSessionIdleCloseMin — minutes a resumed native mission session stays alive while
        // idle before the reaper auto-closes it. Validate + clamp to a sane range (1–1440 min).
        let missionSessionIdleCloseMin: number | undefined;
        if (body.missionSessionIdleCloseMin !== undefined) {
          const n = Number(body.missionSessionIdleCloseMin);
          if (Number.isFinite(n)) missionSessionIdleCloseMin = Math.max(1, Math.min(1440, Math.round(n)));
        }
        let authMonitorIntervalMin: number | undefined;
        if (body.authMonitorIntervalMin !== undefined) {
          const n = Number(body.authMonitorIntervalMin);
          if (Number.isFinite(n)) authMonitorIntervalMin = Math.max(1, Math.min(1440, Math.round(n)));
        }
        const updated = saveProjectSettings({
          excludedPaths: body.excludedPaths,
          knowledgeEnabled: body.knowledgeEnabled,
          memorySyncEnabled: body.memorySyncEnabled,
          crossProjectSignpostEnabled: body.crossProjectSignpostEnabled,
          missionSessionIdleCloseMin,
          authMonitorEnabled: body.authMonitorEnabled,
          authMonitorIntervalMin,
          ruleSyncEnabled: body.ruleSyncEnabled,
          busEnabled: body.busEnabled,
          dataSyncViaFabric: body.dataSyncViaFabric,
        });

        // Live-apply the memory-sync toggle: re-resolve the autosync daemon mode (no restart).
        if (prevSettings.memorySyncEnabled !== updated.memorySyncEnabled) {
          try {
            const mode = require('../../memory/autosync').getAutoSyncDaemon().refreshMode();
            console.log(`[ProjectSettings] memorySyncEnabled=${updated.memorySyncEnabled} → autosync mode=${mode}`);
          } catch (err: any) {
            console.error('[ProjectSettings] memory-sync toggle error:', err?.message);
          }
        }

        // Live-apply the cross-project signpost toggle: start the sweep+watcher, or stop the watcher.
        if (prevSettings.crossProjectSignpostEnabled !== updated.crossProjectSignpostEnabled) {
          try {
            const sp = require('../../memory/cross-project-signpost');
            if (updated.crossProjectSignpostEnabled) sp.startCrossProjectSignpost();
            else sp.stopCrossProjectSignpost();
            console.log(`[ProjectSettings] crossProjectSignpostEnabled=${updated.crossProjectSignpostEnabled}`);
          } catch (err: any) {
            console.error('[ProjectSettings] signpost toggle error:', err?.message);
          }
        }

        // Live-apply the rule-sync toggle: re-resolve the rule-autosync daemon mode (no restart).
        if (prevSettings.ruleSyncEnabled !== updated.ruleSyncEnabled) {
          try {
            const mode = require('../../rules/autosync').getRuleAutoSyncDaemon().refreshMode();
            console.log(`[ProjectSettings] ruleSyncEnabled=${updated.ruleSyncEnabled} → rule-autosync mode=${mode}`);
          } catch (err: any) {
            console.error('[ProjectSettings] rule-sync toggle error:', err?.message);
          }
        }

        // Runtime load/unload knowledge system on toggle
        if (prevSettings.knowledgeEnabled !== updated.knowledgeEnabled) {
          try {
            if (updated.knowledgeEnabled) {
              // Re-enable: start scheduler, pre-warm embedder + vector store
              console.log('[ProjectSettings] Knowledge enabled — starting scheduler and pre-warming');
              const { getKnowledgeScheduler } = require('../../knowledge/scheduler');
              getKnowledgeScheduler().start();
              const { getEmbedder } = require('../../vector/embedder');
              const { getVectorStore } = require('../../vector/vector-store');
              getEmbedder().load().catch(() => {});
              getVectorStore().init().catch(() => {});
            } else {
              // Disable: stop scheduler, destroy embedder + vector store to free memory
              console.log('[ProjectSettings] Knowledge disabled — stopping scheduler and unloading');
              const { getKnowledgeScheduler } = require('../../knowledge/scheduler');
              getKnowledgeScheduler().stop();
              const { destroyEmbedder } = require('../../vector/embedder');
              destroyEmbedder();
              const { destroyVectorStore } = require('../../vector/vector-store');
              destroyVectorStore();
            }
          } catch (err: any) {
            console.error('[ProjectSettings] Knowledge toggle error:', err.message);
          }
        }

        return { success: true, data: updated };
      },
    },
  ];
}
