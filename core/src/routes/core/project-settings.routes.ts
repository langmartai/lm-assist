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
import { applyProjectSettingsSideEffects } from '../../project-settings-live';

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
        // bundleRetention — data bundles kept in the bundle store; a positive integer, clamped.
        let bundleRetention: number | undefined;
        if (body.bundleRetention !== undefined) {
          const n = Number(body.bundleRetention);
          if (Number.isFinite(n)) bundleRetention = Math.max(1, Math.min(1000, Math.round(n)));
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
          bundleRetention,
        });

        // Live-apply toggles (autosync, signpost, rule-sync, knowledge) — shared with the
        // data-bundle project-settings import so both writers keep the daemons in step.
        applyProjectSettingsSideEffects(prevSettings, updated);

        return { success: true, data: updated };
      },
    },
  ];
}
