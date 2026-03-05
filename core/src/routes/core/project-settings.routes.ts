/**
 * Project Settings Routes
 *
 * Endpoints for managing project-level settings (e.g., excluded projects).
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
        const updated = saveProjectSettings({
          excludedPaths: body.excludedPaths,
        });
        return { success: true, data: updated };
      },
    },
  ];
}
