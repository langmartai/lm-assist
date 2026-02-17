/**
 * Milestones Routes
 *
 * Endpoints: GET /milestones/:sessionId
 */

import type { RouteHandler, RouteContext } from '../index';
import { getMilestoneStore } from '../../milestone/store';

export function createMilestonesRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /milestones/:sessionId — Get milestones for a session
    {
      method: 'GET',
      pattern: /^\/milestones\/(?<sessionId>[^/]+)$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        if (!sessionId) {
          return { success: false, error: 'Missing sessionId' };
        }

        const store = getMilestoneStore();
        const milestones = store.getMilestones(sessionId);
        const phase = store.getSessionPhase(sessionId);

        return {
          success: true,
          data: {
            milestones,
            phase,
          },
        };
      },
    },
  ];
}
