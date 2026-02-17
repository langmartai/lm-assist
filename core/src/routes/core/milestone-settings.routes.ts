/**
 * Milestone Settings Routes
 *
 * Endpoints for managing milestone pipeline configuration stored at ~/.milestone/settings.json.
 *
 * GET  /milestone-settings               — Get current settings
 * PUT  /milestone-settings               — Update settings (partial merge)
 * POST /milestone-settings/auto-exclude  — Auto-exclude non-git projects
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler, RouteContext } from '../index';
import { getMilestoneSettings, saveMilestoneSettings } from '../../milestone/settings';
import { createProjectsService } from '../../projects-service';

export function createMilestoneSettingsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /milestone-settings — Get current milestone settings
    {
      method: 'GET',
      pattern: /^\/milestone-settings$/,
      handler: async () => {
        const settings = getMilestoneSettings();
        return { success: true, data: settings };
      },
    },

    // PUT /milestone-settings — Update milestone settings (partial merge)
    {
      method: 'PUT',
      pattern: /^\/milestone-settings$/,
      handler: async (req) => {
        const body = req.body || {};

        const updated = saveMilestoneSettings({
          enabled: body.enabled,
          autoKnowledge: body.autoKnowledge,
          scanRangeDays: body.scanRangeDays,
          phase2Model: body.phase2Model,
          architectureModel: body.architectureModel,
          excludedPaths: body.excludedPaths,
        });

        return { success: true, data: updated };
      },
    },

    // POST /milestone-settings/auto-exclude — Auto-exclude non-git projects
    {
      method: 'POST',
      pattern: /^\/milestone-settings\/auto-exclude$/,
      handler: async () => {
        const service = createProjectsService();
        const projects = service.listProjects({ includeSize: false });
        const settings = getMilestoneSettings();
        const existing = new Set(settings.excludedPaths);

        const added: string[] = [];
        for (const project of projects) {
          const projectPath = (project as any).path as string;
          if (!projectPath || existing.has(projectPath)) continue;

          const gitDir = path.join(projectPath, '.git');
          const isGitRepo = fs.existsSync(gitDir);
          if (!isGitRepo) {
            existing.add(projectPath);
            added.push(projectPath);
          }
        }

        if (added.length > 0) {
          const updated = saveMilestoneSettings({ excludedPaths: Array.from(existing) });
          return { success: true, data: updated, added };
        }

        return { success: true, data: settings, added: [] };
      },
    },
  ];
}
