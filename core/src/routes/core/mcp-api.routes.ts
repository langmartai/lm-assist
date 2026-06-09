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
import type { ToolScope } from '../../mcp-server/configure';
import { handleSearch } from '../../mcp-server/tools/search';
import { handleDetail } from '../../mcp-server/tools/detail';
import { handleFeedback } from '../../mcp-server/tools/feedback';
import { handleListRecentSessions } from '../../mcp-server/tools/list-recent-sessions';
import { handleListProjects } from '../../mcp-server/tools/list-projects';
import { handleSearchMemory } from '../../mcp-server/tools/search-memory';
import { handleListClaudeaiConversations } from '../../mcp-server/tools/list-claudeai-conversations';
import { handleReadConversation } from '../../mcp-server/tools/read-conversation';
import { EXPANDED_HANDLERS } from '../../mcp-server/tools/expanded';
import { TOOL_SCOPES } from '../../mcp-server/configure';
import {
  toolCatalog,
  setToolGate,
} from '../../mcp-server/access-control';
import { listPending, takePending } from '../../mcp-server/mcp-pending';
import { listConnectors, deleteConnector, setConnectorEnabled } from '../../mcp-server/connectors';

function nowIso(): string {
  return new Date().toISOString();
}

function asScopes(v: unknown): ToolScope[] {
  return Array.isArray(v)
    ? (v.filter((x) => x === 'read' || x === 'write' || x === 'admin') as ToolScope[])
    : [];
}
import { dispatch } from './mcp.routes';

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

    // POST /mcp/read_conversation
    {
      method: 'POST',
      pattern: /^\/mcp\/read_conversation$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          return wrapResponse(await handleReadConversation(req.body || {}), start);
        } catch (err) {
          return wrapError('MCP_READ_CONV_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

    // GET /mcp/tool-scopes — canonical tool→scope map (read|write|admin).
    // The upstream langmart gateway fetches + caches this to decide which
    // Bearer keys may invoke which tool (403 before forwarding). Keeping it
    // served from the worker means one source of truth, no map drift.
    {
      method: 'GET',
      pattern: /^\/mcp\/tool-scopes$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse({ scopes: TOOL_SCOPES }, start);
      },
    },

    // ── MCP admin gate (per-user, lm-assist-owned) ───────────────────────

    // ── MCP connectors (settings UI): list/disable/delete the node's
    //    OAuth connectors on the gateway + their claude.ai registration status.

    // GET /mcp/connectors — the node's connectors + claude.ai status.
    {
      method: 'GET',
      pattern: /^\/mcp\/connectors$/,
      handler: async () => {
        const start = Date.now();
        try {
          return wrapResponse(await listConnectors(), start);
        } catch (err) {
          return wrapError('MCP_CONNECTORS_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

    // DELETE /mcp/connectors/:clientId — remove a connector.
    {
      method: 'DELETE',
      pattern: /^\/mcp\/connectors\/(?<clientId>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        const ok = await deleteConnector(req.params.clientId);
        return ok
          ? wrapResponse({ removed: req.params.clientId }, start)
          : wrapError('MCP_CONNECTORS_DELETE_FAILED', 'gateway rejected delete', start);
      },
    },

    // PATCH /mcp/connectors/:clientId — enable/disable. Body: { enabled }.
    {
      method: 'PATCH',
      pattern: /^\/mcp\/connectors\/(?<clientId>[^/]+)$/,
      handler: async (req) => {
        const start = Date.now();
        const enabled = (req.body as { enabled?: boolean })?.enabled !== false;
        const ok = await setConnectorEnabled(req.params.clientId, enabled);
        return ok
          ? wrapResponse({ clientId: req.params.clientId, enabled }, start)
          : wrapError('MCP_CONNECTORS_PATCH_FAILED', 'gateway rejected update', start);
      },
    },

    // GET /mcp/access — full config for the settings UI: defaults, grants,
    // and the tool→scope catalog.
    // GET /mcp/access — the tool catalog for the settings UI. Each entry is
    // { tool, scope (sensitivity hint), adminGate (extra confirm on/off) }.
    {
      method: 'GET',
      pattern: /^\/mcp\/access$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse({ tools: toolCatalog() }, start);
      },
    },

    // PUT /mcp/access/tool-gate — turn the extra admin-confirm gate on/off for a
    // single tool. Body: { tool: string, enabled: boolean }. Gated tools park as
    // pending; ungated tools (the default) run normally.
    {
      method: 'PUT',
      pattern: /^\/mcp\/access\/tool-gate$/,
      handler: async (req) => {
        const start = Date.now();
        const b = (req.body || {}) as Record<string, unknown>;
        const tool = typeof b.tool === 'string' ? b.tool : '';
        const enabled = b.enabled;
        if (!tool || !(tool in TOOL_SCOPES)) {
          return wrapError('MCP_ACCESS_BAD', `unknown tool "${tool}"`, start);
        }
        if (typeof enabled !== 'boolean') {
          return wrapError('MCP_ACCESS_BAD', 'enabled must be a boolean', start);
        }
        setToolGate(tool, enabled);
        return wrapResponse({ tools: toolCatalog() }, start);
      },
    },

    // GET /mcp/pending — list parked admin actions (for the confirm UI).
    {
      method: 'GET',
      pattern: /^\/mcp\/pending$/,
      handler: async () => {
        const start = Date.now();
        const items = listPending().map((p) => ({
          id: p.id,
          tool: p.tool,
          summary: p.summary,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
        }));
        return wrapResponse({ pending: items }, start);
      },
    },

    // POST /mcp/pending/:id/confirm — execute a parked admin action now.
    // This is the ONLY path that runs an admin tool, reached out-of-band.
    {
      method: 'POST',
      pattern: /^\/mcp\/pending\/(?<id>[^/]+)\/confirm$/,
      handler: async (req) => {
        const start = Date.now();
        const p = takePending(req.params.id);
        if (!p) return wrapError('MCP_PENDING_NOT_FOUND', 'pending not found or expired', start);
        try {
          // Full dispatcher (base + expanded tools) — any gated tool can be released.
          const result = await dispatch(p.tool, p.args);
          return wrapResponse({ status: 'executed', tool: p.tool, result }, start);
        } catch (err) {
          return wrapError('MCP_EXEC_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

    // POST /mcp/pending/:id/deny — drop a parked admin action without running it.
    {
      method: 'POST',
      pattern: /^\/mcp\/pending\/(?<id>[^/]+)\/deny$/,
      handler: async (req) => {
        const start = Date.now();
        const p = takePending(req.params.id);
        return p
          ? wrapResponse({ status: 'denied', id: p.id, tool: p.tool }, start)
          : wrapError('MCP_PENDING_NOT_FOUND', 'pending not found or expired', start);
      },
    },

    // POST /mcp-call — generic shim for expanded-catalog tools (stdio transport).
    // Body: { tool, args }. Dispatches via EXPANDED_HANDLERS so new read/write
    // tools need no per-tool route. The StreamableHTTP transport reaches the
    // same handlers in-process and does not use this route.
    {
      method: 'POST',
      pattern: /^\/mcp-call$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const body = (req.body || {}) as { tool?: string; args?: Record<string, unknown> };
          const tool = String(body.tool || '');
          const handler = EXPANDED_HANDLERS[tool];
          if (!handler) {
            return wrapError('MCP_UNKNOWN_TOOL', `Unknown expanded tool: ${tool}`, start);
          }
          return wrapResponse(await handler(body.args || {}), start);
        } catch (err) {
          return wrapError('MCP_CALL_ERROR', err instanceof Error ? err.message : String(err), start);
        }
      },
    },

  ];
}
