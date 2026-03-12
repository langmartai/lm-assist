/**
 * Agent API Routes (lm-assist)
 *
 * Exposes the Claude Agent SDK for internal LLM calls (Phase 2 enrichment,
 * knowledge review, architecture delta updates).
 *
 * Endpoints:
 *   POST /agent/execute            Execute a prompt via Claude Agent SDK
 *   GET  /agent/executions         List all background executions
 *   GET  /agent/execution/:id      Poll single execution status
 *   GET  /agent/execution/:id/result  Get result (with optional wait)
 *   POST /agent/execution/:id/abort   Abort running execution
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

    // GET /agent/executions — list all background executions
    {
      method: 'GET',
      pattern: /^\/agent\/executions$/,
      handler: async (_req, api) => {
        const executions = await api.agent.listExecutions();
        return { success: true, data: executions };
      },
    },

    // GET /agent/execution/:id — poll single execution status
    {
      method: 'GET',
      pattern: /^\/agent\/execution\/(?<id>[^/]+)$/,
      handler: async (req, api) => {
        const id = req.params.id;
        const execution = await api.agent.getExecution(id);
        if (!execution) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Execution ${id} not found` },
          };
        }
        return { success: true, data: execution };
      },
    },

    // GET /agent/execution/:id/result — get result (with optional wait)
    {
      method: 'GET',
      pattern: /^\/agent\/execution\/(?<id>[^/]+)\/result$/,
      handler: async (req, api) => {
        const id = req.params.id;
        const wait = req.query.wait !== 'false';
        const timeout = req.query.timeout ? parseInt(req.query.timeout, 10) : undefined;
        const result = await api.agent.getExecutionResult(id, wait, timeout);
        return { success: true, data: result };
      },
    },

    // POST /agent/execution/:id/abort — abort running execution
    {
      method: 'POST',
      pattern: /^\/agent\/execution\/(?<id>[^/]+)\/abort$/,
      handler: async (req, api) => {
        const id = req.params.id;
        const result = await api.agent.abort(id);
        if (!result.success) {
          return {
            success: false,
            error: { code: 'ABORT_FAILED', message: `Could not abort execution ${id}` },
          };
        }
        return { success: true, data: result };
      },
    },
  ];
}
