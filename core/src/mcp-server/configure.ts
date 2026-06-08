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
  listNodesToolDef,
  NODE_PARAM,
} from './tools/definitions';
import { EXPANDED_TOOL_DEFS } from './tools/expanded';
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
const BASE_TOOL_DEFS = [
  searchToolDef,
  detailToolDef,
  feedbackToolDef,
  listRecentSessionsToolDef,
  listProjectsToolDef,
  searchMemoryToolDef,
  listClaudeaiConversationsToolDef,
  readConversationToolDef,
  ...EXPANDED_TOOL_DEFS,
  listNodesToolDef,
] as const;

/**
 * Inject the optional `node` selector into a tool's inputSchema so claude.ai
 * can target a specific host when the user has several lm-assist nodes
 * connected. Applied to every advertised tool EXCEPT `list_nodes` itself
 * (which enumerates nodes and is never node-targeted). Pure — returns a new
 * def, never mutates the source.
 */
function withNodeParam<T extends { name: string; inputSchema: { properties?: Record<string, unknown> } }>(def: T): T {
  if (def.name === 'list_nodes') return def;
  const schema = def.inputSchema || ({ type: 'object', properties: {} } as typeof def.inputSchema);
  return {
    ...def,
    inputSchema: {
      ...schema,
      properties: { ...(schema.properties || {}), node: NODE_PARAM },
    },
  };
}

/**
 * The canonical tool list. Both transports advertise these in response to
 * `tools/list`. Order is preserved; clients may rely on it for stable UX.
 * Every tool carries the optional `node` selector (see withNodeParam) so the
 * connector is multi-node aware end-to-end.
 */
export const LM_ASSIST_TOOL_DEFS = BASE_TOOL_DEFS.map(withNodeParam);

/** Names of every tool advertised by lm-assist's MCP server. */
export const LM_ASSIST_TOOL_NAMES: ReadonlyArray<string> = LM_ASSIST_TOOL_DEFS.map((t) => t.name);

/**
 * Capability scope required to call each tool.
 *
 *   read  — pure data fetch, no state change. Auto-approved.
 *   write — mutates lm-assist / claude.ai state or spends tokens. Must
 *           prompt for approval on every call; never "always allow".
 *   admin — host-control / irreversible (agent execution, terminal drive,
 *           conversation delete). Approval + out-of-band confirm + audit.
 *
 * This is the single source of truth the upstream langmart gateway reads to
 * decide whether a Bearer key may invoke a given tool (403 before forwarding)
 * — see docs/plans `mcp-full-exposure`. Keep every advertised tool mapped;
 * `assertScopesCoverTools()` fails the build/boot if one is missing.
 */
export type ToolScope = 'read' | 'write' | 'admin';

export const TOOL_SCOPES: Readonly<Record<string, ToolScope>> = {
  search: 'read',
  detail: 'read',
  feedback: 'write',
  list_recent_sessions: 'read',
  list_projects: 'read',
  search_memory: 'read',
  list_claudeai_conversations: 'read',
  read_conversation: 'read',
  // expanded read tier
  list_executions: 'read',
  get_execution: 'read',
  memory_projects: 'read',
  memory_cross_host: 'read',
  memory_import_candidates: 'read',
  terminal_list: 'read',
  terminal_capture: 'read',
  // claude.ai marketplaces + plugins (read)
  claudeai_list_marketplaces: 'read',
  claudeai_list_marketplace_plugins: 'read',
  claudeai_list_plugins: 'read',
  // expanded write tier
  claudeai_create_conversation: 'write',
  claudeai_completion: 'write',
  claudeai_add_marketplace: 'write',
  claudeai_remove_marketplace: 'write',
  claudeai_set_plugin_enabled: 'write',
  agent_abort: 'write',
  agent_resume: 'write',
  terminal_prompt: 'write',
  terminal_slash: 'write',
  // expanded admin tier
  agent_execute: 'admin',
  terminal_interrupt: 'admin',
  terminal_open_tab: 'admin',
  delete_conversation: 'admin',
  // multi-node
  list_nodes: 'read',
  // github endpoint (read = query, write = mutate)
  github_query: 'read',
  github_mutate: 'write',
  // memory map + rules map (read — shell out to CLIs)
  memory_map: 'read',
  memory_record: 'read',
  rule_map: 'read',
  // port forward (node-to-node TCP tunnel): open/close mutate, list reads
  open_port_forward: 'admin',
  list_port_forwards: 'read',
  close_port_forward: 'admin',
  transfer_send_file: 'admin',
  transfer_list_remote: 'read',
  transfer_stats: 'read',
  transfer_queue: 'read',
  port_forward_stats: 'read',
  fs_drives: 'read',
  fs_list: 'read',
  fs_stat: 'read',
  // session-to-session messaging
  send_session_message: 'admin',
  list_session_messages: 'read',
  get_message_status: 'read',
};

/** The scope required to call `name`. Unknown tools default to `admin` (deny-by-default). */
export function requiredScope(name: string): ToolScope {
  return TOOL_SCOPES[name] ?? 'admin';
}

/**
 * Guard invoked at boot: every advertised tool must have an explicit scope.
 * A new tool added to LM_ASSIST_TOOL_DEFS without a TOOL_SCOPES entry would
 * otherwise silently inherit the `admin` deny-default and be uncallable —
 * fail loudly instead so the omission is caught immediately.
 */
export function assertScopesCoverTools(): void {
  const missing = LM_ASSIST_TOOL_NAMES.filter((n) => !(n in TOOL_SCOPES));
  if (missing.length > 0) {
    throw new Error(`TOOL_SCOPES missing entries for: ${missing.join(', ')}`);
  }
}

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
  assertScopesCoverTools();

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
