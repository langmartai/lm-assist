/**
 * MCP API Routes
 *
 * REST endpoints that wrap the MCP tool handlers (search, detail, feedback).
 * These allow the MCP server to call the core API via HTTP instead of
 * directly opening LMDB, LanceDB, embedding model, and other stores.
 *
 * Endpoints:
 *   POST /mcp/search    — unified search across knowledge and file history
 *   POST /mcp/detail    — progressive disclosure for any item by ID
 *   POST /mcp/feedback  — context quality feedback
 */

import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { handleSearch } from '../../mcp-server/tools/search';
import { handleDetail } from '../../mcp-server/tools/detail';
import { handleFeedback } from '../../mcp-server/tools/feedback';
import { handleListRecentSessions } from '../../mcp-server/tools/list-recent-sessions';
import { handleListProjects } from '../../mcp-server/tools/list-projects';
import { handleSearchMemory } from '../../mcp-server/tools/search-memory';
import { handleListClaudeaiConversations } from '../../mcp-server/tools/list-claudeai-conversations';

export function createMcpApiRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /mcp/search
    {
      method: 'POST',
      pattern: /^\/mcp\/search$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const args = req.body || {};
          const result = await handleSearch(args);
          return wrapResponse(result, start);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return wrapError('MCP_SEARCH_ERROR', msg, start);
        }
      },
    },

    // POST /mcp/detail
    {
      method: 'POST',
      pattern: /^\/mcp\/detail$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const args = req.body || {};
          const result = await handleDetail(args);
          return wrapResponse(result, start);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return wrapError('MCP_DETAIL_ERROR', msg, start);
        }
      },
    },

    // POST /mcp/feedback
    {
      method: 'POST',
      pattern: /^\/mcp\/feedback$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const args = req.body || {};
          const result = await handleFeedback(args);
          return wrapResponse(result, start);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return wrapError('MCP_FEEDBACK_ERROR', msg, start);
        }
      },
    },

    // POST /mcp/list_recent_sessions
    {
      method: 'POST',
      pattern: /^\/mcp\/list_recent_sessions$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          return wrapResponse(await handleListRecentSessions(req.body || {}), start);
        } catch (err) {
          return wrapError('MCP_LIST_SESSIONS_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

    // POST /mcp/list_projects
    {
      method: 'POST',
      pattern: /^\/mcp\/list_projects$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          return wrapResponse(await handleListProjects(req.body || {}), start);
        } catch (err) {
          return wrapError('MCP_LIST_PROJECTS_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

    // POST /mcp/search_memory
    {
      method: 'POST',
      pattern: /^\/mcp\/search_memory$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          return wrapResponse(await handleSearchMemory(req.body || {}), start);
        } catch (err) {
          return wrapError('MCP_SEARCH_MEMORY_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

    // POST /mcp/list_claudeai_conversations
    {
      method: 'POST',
      pattern: /^\/mcp\/list_claudeai_conversations$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          return wrapResponse(await handleListClaudeaiConversations(req.body || {}), start);
        } catch (err) {
          return wrapError('MCP_LIST_CLAUDEAI_CONV_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

  ];
}
