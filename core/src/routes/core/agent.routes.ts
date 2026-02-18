/**
 * Agent API Routes (lm-assist)
 *
 * Exposes the Claude Agent SDK for internal LLM calls (Phase 2 enrichment,
 * knowledge review, architecture delta updates).
 *
 * Endpoints:
 *   POST /agent/execute   Execute a prompt via Claude Agent SDK
 */

import type { RouteHandler, RouteContext } from '../index';
import type { AgentExecuteRequest } from '../../types/agent-api';

export function createAgentRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /agent/execute
    {
      method: 'POST',
      pattern: /^\/agent\/execute$/,
      handler: async (req, api) => {
        const body = req.body as AgentExecuteRequest;

        if (!body.prompt) {
          return {
            success: false,
            error: { code: 'MISSING_PROMPT', message: 'prompt is required' },
          };
        }

        const result = await api.agent.execute(body);
        return { success: true, data: result };
      },
    },
  ];
}
