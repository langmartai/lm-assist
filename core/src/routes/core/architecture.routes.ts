/**
 * Architecture Routes
 *
 * Endpoints:
 *   GET  /architecture?project=<path>              — Get project architecture data (activity map)
 *   GET  /architecture/model?project=<path>        — Get cached LLM architecture model
 *   POST /architecture/generate?project=<path>     — Generate LLM architecture model
 *   GET  /architecture/source-scan?project=<path>  — Run source code scan (endpoints, tables)
 */

import type { RouteHandler, RouteContext } from '../index';
import { getProjectArchitectureData } from '../../mcp-server/tools/project-architecture';
import {
  getArchitectureModelAsync,
  generateArchitectureModel,
} from '../../architecture-llm';
import { scanProjectSource } from '../../source-scanner';

export function createArchitectureRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /architecture — Get project architecture data (activity map)
    {
      method: 'GET',
      pattern: /^\/architecture$/,
      handler: async (req) => {
        const project = req.query.project || undefined;

        const data = await getProjectArchitectureData(project);
        if (!data) {
          return {
            success: false,
            error: project
              ? `No architecture data for project: ${project}`
              : 'No project detected. Pass ?project=<path>',
          };
        }

        return { success: true, data };
      },
    },

    // GET /architecture/model — Get cached LLM architecture model
    {
      method: 'GET',
      pattern: /^\/architecture\/model$/,
      handler: async (req) => {
        const project = req.query.project || undefined;
        if (!project) {
          return { success: false, error: 'Missing ?project=<path> parameter' };
        }

        const result = await getArchitectureModelAsync(project);
        if (!result) {
          return { success: true, data: null };
        }

        return {
          success: true,
          data: {
            model: result.model,
            stale: result.stale,
            generatedAt: result.generatedAt,
            lastCheckedAt: result.lastCheckedAt,
            sessionId: result.sessionId,
          },
        };
      },
    },

    // GET /architecture/source-scan — Run source code scan for endpoints and tables
    {
      method: 'GET',
      pattern: /^\/architecture\/source-scan$/,
      handler: async (req) => {
        const project = req.query.project || undefined;
        if (!project) {
          return { success: false, error: 'Missing ?project=<path> parameter' };
        }

        try {
          const result = await scanProjectSource(project);
          return { success: true, data: result };
        } catch (err: any) {
          return { success: false, error: `Source scan failed: ${err.message || err}` };
        }
      },
    },

    // POST /architecture/generate — Generate LLM architecture model
    {
      method: 'POST',
      pattern: /^\/architecture\/generate$/,
      handler: async (req) => {
        const project = req.query.project || req.body?.project || undefined;
        if (!project) {
          return { success: false, error: 'Missing project parameter (query or body)' };
        }

        const model = req.body?.model as string | undefined;
        const reason = req.body?.reason as string | undefined;
        const force = req.body?.force === true;
        const mode = req.body?.mode as 'auto' | 'delta' | 'full' | undefined;
        const validModels = ['haiku', 'sonnet', 'opus'];
        const validModes = ['auto', 'delta', 'full'];
        const llmModel = model && validModels.includes(model) ? model as any : undefined;
        const resolvedMode = mode && validModes.includes(mode) ? mode : 'auto';

        if (reason) {
          console.log(`[Architecture] Generating model for ${project} — reason: ${reason}, mode: ${resolvedMode}`);
        }

        const result = await generateArchitectureModel(project, llmModel, {
          force: force || resolvedMode === 'full',
          mode: resolvedMode,
        });
        if (!result) {
          return { success: false, error: 'Architecture generation failed. Check server logs.' };
        }

        return {
          success: true,
          data: {
            model: result.model,
            generatedAt: result.generatedAt,
            sessionId: result.sessionId,
            skipped: result.skipped || false,
            reason: result.reason,
            deltaUpdate: result.deltaUpdate || false,
            milestonesApplied: result.milestonesApplied,
          },
        };
      },
    },
  ];
}
