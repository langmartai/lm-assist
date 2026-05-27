/**
 * MCP Protocol Endpoint (StreamableHTTP transport)
 *
 * Exposes lm-assist tools at `POST /mcp` via the Model Context Protocol
 * 2025-11-25 spec, using the SDK's StreamableHTTPServerTransport.
 *
 * This is the surface claude.ai (and other remote MCP clients) connect to.
 * The stdio MCP server at `core/src/mcp-server/index.ts` is unchanged and
 * still ships for Claude Code CLI use.
 *
 * The endpoint has NO local authentication — auth happens at the langmart
 * hub upstream (BearerToken → user_id → worker → /mcp). When called
 * directly from localhost (no hub in front), there is no auth gate. Treat
 * as trusted-LAN-only when used standalone.
 *
 * The route is dispatched from rest-server.ts directly (before modular
 * route parsing) because StreamableHTTPServerTransport needs raw req/res
 * control to drive both single-response and SSE flows.
 *
 * Separate from the REST shims at `/mcp/search`, `/mcp/detail`,
 * `/mcp/feedback` in `mcp-api.routes.ts` — those exist for the stdio MCP
 * server's HTTP client. This file matches the exact path `/mcp` only.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { configureMcpServer, type McpToolDispatcher } from '../../mcp-server/configure';
import { handleSearch } from '../../mcp-server/tools/search';
import { handleDetail } from '../../mcp-server/tools/detail';
import { handleFeedback } from '../../mcp-server/tools/feedback';
import { handleListRecentSessions } from '../../mcp-server/tools/list-recent-sessions';
import { handleListProjects } from '../../mcp-server/tools/list-projects';
import { handleSearchMemory } from '../../mcp-server/tools/search-memory';
import { handleListClaudeaiConversations } from '../../mcp-server/tools/list-claudeai-conversations';
import { handleReadConversation } from '../../mcp-server/tools/read-conversation';

// Dispatcher for StreamableHTTP mode — runs each tool in-process against
// the data stores that already live in this core API process. No HTTP
// hop, no client. Mirror of the stdio dispatcher's shape; only the
// per-tool implementation differs.
const dispatch: McpToolDispatcher = async (name, args) => {
  switch (name) {
    case 'search':                       return handleSearch(args);
    case 'detail':                       return handleDetail(args);
    case 'feedback':                     return handleFeedback(args);
    case 'list_recent_sessions':         return handleListRecentSessions(args);
    case 'list_projects':                return handleListProjects(args);
    case 'search_memory':                return handleSearchMemory(args);
    case 'list_claudeai_conversations':  return handleListClaudeaiConversations(args);
    case 'read_conversation':            return handleReadConversation(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
};

// Fresh Server per request (stateless mode). The SDK errors with
// "Already connected to a transport" if a Server is `.connect()`'d more
// than once — caching breaks the second call. A new Server is cheap;
// all expensive work (vector store, session cache, etc.) lives in
// module-level singletons that the handlers reach through.
function buildServer(): Server {
  const server = new Server(
    { name: 'lm-assist', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );
  configureMcpServer(server, dispatch);
  return server;
}

/**
 * Read the request body as a JSON object. Returns undefined for empty
 * bodies (the SDK transport tolerates `body=undefined` and parses fresh
 * from the request stream in that case).
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Handle `POST /mcp` (JSON-RPC request), `GET /mcp` (SSE long-poll for
 * server-to-client messages), and `DELETE /mcp` (session terminate).
 *
 * Stateless mode — `sessionIdGenerator: undefined` — each request stands
 * alone. SSE GET still works because StreamableHTTPServerTransport opens
 * the SSE stream on the response and writes any pending messages from
 * the in-process Server.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown | undefined;
  try {
    if (req.method === 'POST') {
      body = await readJsonBody(req);
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: ' + (e instanceof Error ? e.message : String(e)) },
      id: null,
    }));
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error: ' + msg },
        id: null,
      }));
    } else {
      try { res.end(); } catch { /* swallow */ }
    }
  }
}
