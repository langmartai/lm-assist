/**
 * Cowork Routes
 *
 * Headless "create + send" for Claude cowork sessions (cloud or local
 * bridge). See `core/src/cowork/cowork-tasks.ts` for the implementation and
 * `docs/superpowers/specs/2026-07-11-cowork-task-creation-design.md` for the
 * design.
 *
 * Endpoints:
 *   POST /cowork/tasks   Create a cowork session and send the initial prompt
 */

import type { RouteContext, RouteHandler } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { createCoworkTask, CoworkTaskError } from '../../cowork/cowork-tasks';

export function createCoworkRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/cowork\/tasks$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const b = req.body || {};
          const result = await createCoworkTask({
            prompt: b.prompt,
            target: b.target,
            environmentId: b.environmentId,
            model: b.model,
            effort: b.effort,
            title: b.title,
          });
          return wrapResponse(result, start);
        } catch (e) {
          if (e instanceof CoworkTaskError) return wrapError(e.code, e.message, start);
          return wrapError('COWORK_ERROR', (e as Error).message, start);
        }
      },
    },
  ];
}
