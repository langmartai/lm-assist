/**
 * MCP API Routes
 *
 * REST endpoints that wrap the MCP tool handlers (search, detail, feedback).
 * These allow the MCP server to call the core API via HTTP instead of
 * directly opening LMDB, LanceDB, embedding model, and other stores.
 *
 * Endpoints:
 *   POST /mcp/search    — unified search across knowledge, milestones, architecture, file history
 *   POST /mcp/detail    — progressive disclosure for any item by ID
 *   POST /mcp/feedback  — context quality feedback
 *   GET  /mcp/settings  — returns milestone settings (for tool description selection)
 */

import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { handleSearch } from '../../mcp-server/tools/search';
import { handleDetail } from '../../mcp-server/tools/detail';
import { handleFeedback } from '../../mcp-server/tools/feedback';
import { getMilestoneSettings } from '../../milestone/settings';

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

    // GET /mcp/settings
    {
      method: 'GET',
      pattern: /^\/mcp\/settings$/,
      handler: async () => {
        const start = Date.now();
        const settings = getMilestoneSettings();
        return wrapResponse({ milestoneEnabled: settings.enabled }, start);
      },
    },
  ];
}
