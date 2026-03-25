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
        const updated = saveProjectSettings({
          excludedPaths: body.excludedPaths,
          knowledgeEnabled: body.knowledgeEnabled,
        });

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
