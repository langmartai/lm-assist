/**
 * Knowledge Settings Routes
 *
 * Endpoints for managing knowledge configuration stored at ~/.lm-assist/knowledge/settings.json.
 *
 * GET  /knowledge-settings  — Get current settings
 * PUT  /knowledge-settings  — Update settings (partial merge)
 */

import type { RouteHandler, RouteContext } from '../index';
import { getKnowledgeSettings, saveKnowledgeSettings } from '../../knowledge/settings';
import { getKnowledgeScheduler } from '../../knowledge/scheduler';

export function createKnowledgeSettingsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /knowledge-settings — Get current knowledge settings
    {
      method: 'GET',
      pattern: /^\/knowledge-settings$/,
      handler: async () => {
        const settings = getKnowledgeSettings();
        return { success: true, data: settings };
      },
    },

    // PUT /knowledge-settings — Update knowledge settings (partial merge)
    {
      method: 'PUT',
      pattern: /^\/knowledge-settings$/,
      handler: async (req) => {
        const body = req.body || {};

        const updated = saveKnowledgeSettings({
          remoteSyncEnabled: body.remoteSyncEnabled,
          syncIntervalMinutes: body.syncIntervalMinutes,
          lastSyncTimestamps: body.lastSyncTimestamps,
          reviewModel: body.reviewModel,
          autoReview: body.autoReview,
          autoExploreGeneration: body.autoExploreGeneration,
          autoGenericDiscovery: body.autoGenericDiscovery,
          genericValidationModel: body.genericValidationModel,
          discoveryIntervalMinutes: body.discoveryIntervalMinutes,
          discoveryBatchSize: body.discoveryBatchSize,
        });

        return { success: true, data: updated };
      },
    },

    // GET /knowledge/scheduler/status — Get scheduler status
    {
      method: 'GET',
      pattern: /^\/knowledge\/scheduler\/status$/,
      handler: async () => {
        const status = getKnowledgeScheduler().getStatus();
        return { success: true, data: status };
      },
    },
  ];
}
