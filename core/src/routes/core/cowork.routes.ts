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
          // wrapError() doesn't carry an HTTP status (ApiResponse has none);
          // attach `httpStatus` at the envelope's top level — the field
          // rest-server.ts's dispatch loop honors ahead of the flat
          // success?200:400 default (see rest-server.ts ~line 566-572).
          if (e instanceof CoworkTaskError) {
            return { ...wrapError(e.code, e.message, start), httpStatus: e.httpStatus };
          }
          return { ...wrapError('COWORK_ERROR', (e as Error).message, start), httpStatus: 500 };
        }
      },
    },
  ];
}
