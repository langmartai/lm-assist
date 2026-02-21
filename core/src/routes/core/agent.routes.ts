/**
 * Agent API Routes (lm-assist)
 *
 * Exposes the Claude Agent SDK for programmatic session execution,
 * background execution polling, session management, and blocking event handling.
 *
 * Endpoints:
 *   POST /agent/execute                        Execute a prompt via Claude Agent SDK
 *   POST /agent/resume                         Resume an existing session
 *   GET  /agent/execution/:id                  Get execution status (poll)
 *   GET  /agent/execution/:id/result           Get execution result (optionally wait)
 *   GET  /agent/executions                     List all executions
 *   GET  /agent/sessions                       List active agent sessions
 *   GET  /agent/session/:id                    Get session info
 *   POST /agent/session/:id/abort              Abort a running session
 *   POST /agent/session/:id/permission         Respond to a permission request
 *   POST /agent/session/:id/answer             Answer a user question
 */

import type { RouteHandler, RouteContext } from '../index';
import type {
  AgentExecuteRequest,
  AgentResumeRequest,
  AgentPermissionRequestBody,
  AgentAnswerRequestBody,
} from '../../types/agent-api';

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

    // POST /agent/resume
    {
      method: 'POST',
      pattern: /^\/agent\/resume$/,
      handler: async (req, api) => {
        const body = req.body as AgentResumeRequest;

        if (!body.sessionId) {
          return {
            success: false,
            error: { code: 'MISSING_SESSION_ID', message: 'sessionId is required' },
          };
        }
        if (!body.prompt) {
          return {
            success: false,
            error: { code: 'MISSING_PROMPT', message: 'prompt is required' },
          };
        }

        const result = await api.agent.resume(body);
        return { success: true, data: result };
      },
    },

    // GET /agent/execution/:executionId
    {
      method: 'GET',
      pattern: /^\/agent\/execution\/(?<id>[^/]+)$/,
      handler: async (req, api) => {
        const id = req.params?.id;
        if (!id) {
          return {
            success: false,
            error: { code: 'MISSING_ID', message: 'execution ID is required' },
          };
        }

        const status = await api.agent.getExecution(id);
        if (!status) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Execution ${id} not found` },
          };
        }

        return { success: true, data: status };
      },
    },

    // GET /agent/execution/:executionId/result
    {
      method: 'GET',
      pattern: /^\/agent\/execution\/(?<id>[^/]+)\/result$/,
      handler: async (req, api) => {
        const id = req.params?.id;
        if (!id) {
          return {
            success: false,
            error: { code: 'MISSING_ID', message: 'execution ID is required' },
          };
        }

        const wait = req.query?.wait !== 'false';
        const timeoutMs = req.query?.timeout ? parseInt(req.query.timeout, 10) : undefined;
        const result = await api.agent.getExecutionResult(id, wait, timeoutMs);
        return { success: true, data: result };
      },
    },

    // GET /agent/executions
    {
      method: 'GET',
      pattern: /^\/agent\/executions$/,
      handler: async (_req, api) => {
        const executions = await api.agent.listExecutions();
        return { success: true, data: executions };
      },
    },

    // GET /agent/sessions
    {
      method: 'GET',
      pattern: /^\/agent\/sessions$/,
      handler: async (req, api) => {
        const tier = req.query?.tier as any;
        const statusParam = req.query?.status;
        const status = statusParam ? statusParam.split(',') as any[] : undefined;
        const sessions = await api.agent.listSessions({ tier, status });
        return { success: true, data: sessions };
      },
    },

    // GET /agent/session/:sessionId
    {
      method: 'GET',
      pattern: /^\/agent\/session\/(?<id>[^/]+)$/,
      handler: async (req, api) => {
        const id = req.params?.id;
        if (!id) {
          return {
            success: false,
            error: { code: 'MISSING_ID', message: 'session ID is required' },
          };
        }

        const session = await api.agent.getSession(id);
        if (!session) {
          return {
            success: false,
            error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
          };
        }

        return { success: true, data: session };
      },
    },

    // POST /agent/session/:sessionId/abort
    {
      method: 'POST',
      pattern: /^\/agent\/session\/(?<id>[^/]+)\/abort$/,
      handler: async (req, api) => {
        const id = req.params?.id;
        if (!id) {
          return {
            success: false,
            error: { code: 'MISSING_ID', message: 'session ID is required' },
          };
        }

        const result = await api.agent.abort(id);
        return { success: true, data: result };
      },
    },

    // POST /agent/session/:sessionId/permission
    {
      method: 'POST',
      pattern: /^\/agent\/session\/(?<id>[^/]+)\/permission$/,
      handler: async (req, api) => {
        const id = req.params?.id;
        if (!id) {
          return {
            success: false,
            error: { code: 'MISSING_ID', message: 'session ID is required' },
          };
        }

        const body = req.body as AgentPermissionRequestBody;
        if (!body.requestId || !body.behavior) {
          return {
            success: false,
            error: { code: 'INVALID_BODY', message: 'requestId and behavior are required' },
          };
        }

        const result = await api.agent.respondToPermission(id, {
          requestId: body.requestId,
          behavior: body.behavior,
          updatedInput: body.updatedInput,
          message: body.message,
        });
        return { success: true, data: result };
      },
    },

    // POST /agent/session/:sessionId/answer
    {
      method: 'POST',
      pattern: /^\/agent\/session\/(?<id>[^/]+)\/answer$/,
      handler: async (req, api) => {
        const id = req.params?.id;
        if (!id) {
          return {
            success: false,
            error: { code: 'MISSING_ID', message: 'session ID is required' },
          };
        }

        const body = req.body as AgentAnswerRequestBody;
        if (!body.requestId || !body.answers) {
          return {
            success: false,
            error: { code: 'INVALID_BODY', message: 'requestId and answers are required' },
          };
        }

        const result = await api.agent.answerQuestion(id, body.requestId, body.answers);
        return { success: true, data: result };
      },
    },
  ];
}
