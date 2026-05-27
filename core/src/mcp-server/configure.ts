/**
 * Shared MCP server configuration for both transports.
 *
 * lm-assist's MCP server is exposed via two transports:
 *
 *   1. stdio        — spawned by Claude Code / Claude Desktop as a subprocess
 *                     (entry: `core/src/mcp-server/index.ts`). Dispatches tool
 *                     calls over HTTP to the running core API.
 *   2. StreamableHTTP — `POST /mcp` on the core API itself
 *                     (entry: `core/src/routes/core/mcp.routes.ts`). Dispatches
 *                     in-process directly to the tool handlers.
 *
 * Both transports register the SAME tool list with the SAME definitions and
 * surface the SAME `{content, isError?}` response shape. Only the dispatch
 * function differs (HTTP-to-self vs in-process). This module centralizes
 * everything that's identical between the two — the tool def array, the
 * ListTools/CallTool registration, the try/catch + logToolCall plumbing —
 * so adding or modifying a tool means editing one place, not two.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  searchToolDef,
  detailToolDef,
  feedbackToolDef,
  listRecentSessionsToolDef,
  listProjectsToolDef,
  searchMemoryToolDef,
  listClaudeaiConversationsToolDef,
  readConversationToolDef,
} from './tools/definitions';
import { logToolCall } from './mcp-logger';

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * A function the transport supplies that knows how to actually run a tool.
 * Receives the tool name and the raw arguments object; returns the MCP
 * tool result. Errors thrown will be caught by `configureMcpServer` and
 * converted to `{content: [...Error...], isError: true}` — but you can
 * also return that shape directly for control over the wording.
 */
export type McpToolDispatcher = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

/**
 * The canonical tool list. Both transports advertise these in response to
 * `tools/list`. Order is preserved; clients may rely on it for stable UX.
 */
export const LM_ASSIST_TOOL_DEFS = [
  searchToolDef,
  detailToolDef,
  feedbackToolDef,
  listRecentSessionsToolDef,
  listProjectsToolDef,
  searchMemoryToolDef,
  listClaudeaiConversationsToolDef,
  readConversationToolDef,
] as const;

/** Names of every tool advertised by lm-assist's MCP server. */
export const LM_ASSIST_TOOL_NAMES: ReadonlyArray<string> = LM_ASSIST_TOOL_DEFS.map((t) => t.name);

/**
 * Wire the ListTools + CallTool request handlers on the given Server using
 * the caller-supplied dispatcher for actual tool execution.
 *
 * Adds:
 *   - ListToolsRequestSchema  → returns LM_ASSIST_TOOL_DEFS verbatim
 *   - CallToolRequestSchema   → invokes `dispatch(name, args)`, catches
 *                                exceptions, calls `logToolCall(...)`
 *
 * The dispatcher's signature is intentionally simple — name + args — so
 * each transport can switch on the name and route to either an HTTP shim
 * (stdio mode forwarding to the core API) or a direct in-process handler
 * (HTTP/StreamableHTTP mode). Neither transport touches the MCP protocol
 * plumbing itself.
 */
export function configureMcpServer(server: Server, dispatch: McpToolDispatcher): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...LM_ASSIST_TOOL_DEFS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs || {}) as Record<string, unknown>;
    const t0 = Date.now();

    let result: McpToolResult;
    try {
      result = await dispatch(name, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
    logToolCall(name, args, Date.now() - t0, result);
    // The SDK's CallToolResult type includes optional fields (task tracking,
    // structured content, etc.) that our handlers never produce; widen the
    // narrower `McpToolResult` to satisfy the typechecker without a
    // structural change at runtime.
    return result as CallToolResult;
  });
}
