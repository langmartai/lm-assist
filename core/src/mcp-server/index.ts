/**
 * Session Context MCP Server
 *
 * Provides Claude Code sessions with semantic search over past work.
 *
 * Transport: stdio (spawned by Claude Code as an MCP server)
 *
 * 3 Tools:
 *   search  — Unified search across knowledge and file history
 *   detail  — Progressive disclosure for any item by ID
 *   feedback — Context quality feedback on any source
 *
 * This is a thin client that forwards tool calls to the core API via HTTP.
 * All data stores (LMDB, LanceDB, embedder, etc.) live in the core API process.
 */

// ─── Stdout Protection ──────────────────────────────────────────────────
// MCP uses stdio (JSON-RPC over stdout). Any console.log from dependencies
// corrupts the protocol. Redirect console.log/warn/info to stderr.
console.log = console.error.bind(console);
console.warn = console.error.bind(console);
console.info = console.error.bind(console);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { configureMcpServer, type McpToolDispatcher } from './configure';
import {
  ensureCoreApi,
  mcpSearch,
  mcpDetail,
  mcpFeedback,
  mcpListRecentSessions,
  mcpListProjects,
  mcpSearchMemory,
  mcpListClaudeaiConversations,
  mcpReadConversation,
  mcpGenericCall,
} from './api-client';
import { EXPANDED_HANDLERS } from './tools/expanded';

// ─── Server Setup ──────────────────────────────────────────────────

const server = new Server(
  { name: 'lm-assist', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// Dispatcher for stdio mode — forwards each tool call to the running core
// API over HTTP. The actual data stores (LMDB, LanceDB, embedder) live in
// the core API process; this module is a thin client.
const dispatch: McpToolDispatcher = async (name, args) => {
  switch (name) {
    case 'search':                       return mcpSearch(args);
    case 'detail':                       return mcpDetail(args);
    case 'feedback':                     return mcpFeedback(args);
    case 'list_recent_sessions':         return mcpListRecentSessions(args);
    case 'list_projects':                return mcpListProjects(args);
    case 'search_memory':                return mcpSearchMemory(args);
    case 'list_claudeai_conversations':  return mcpListClaudeaiConversations(args);
    case 'read_conversation':            return mcpReadConversation(args);
    default:
      if (name in EXPANDED_HANDLERS) return mcpGenericCall(name, args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
};

configureMcpServer(server, dispatch);

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Ensure core API is running (auto-starts if needed)
  ensureCoreApi().catch(err => {
    console.error('[MCP] Failed to ensure core API:', err);
  });

  console.error('[MCP] lm-assist server started (v2 — HTTP client mode)');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
