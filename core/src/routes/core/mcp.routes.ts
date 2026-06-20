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
import { runWithMcpContext } from '../../mcp-server/principal-context';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../index';

import { configureMcpServer, type McpToolDispatcher, LM_ASSIST_INSTRUCTIONS } from '../../mcp-server/configure';
import { handleSearch } from '../../mcp-server/tools/search';
import { handleDetail } from '../../mcp-server/tools/detail';
import { handleFeedback } from '../../mcp-server/tools/feedback';
import { handleListRecentSessions } from '../../mcp-server/tools/list-recent-sessions';
import { handleListProjects } from '../../mcp-server/tools/list-projects';
import { handleSearchMemory } from '../../mcp-server/tools/search-memory';
import { handleListClaudeaiConversations } from '../../mcp-server/tools/list-claudeai-conversations';
import { handleReadConversation } from '../../mcp-server/tools/read-conversation';
import { EXPANDED_HANDLERS } from '../../mcp-server/tools/expanded';
import { evaluateAccess } from '../../mcp-server/access-control';
import { createPending } from '../../mcp-server/mcp-pending';

// Dispatcher for StreamableHTTP mode — runs each tool in-process against
// the data stores that already live in this core API process. No HTTP
// hop, no client. Mirror of the stdio dispatcher's shape; only the
// per-tool implementation differs.
export const dispatch: McpToolDispatcher = async (name, args) => {
  switch (name) {
    case 'search':                       return handleSearch(args);
    case 'detail':                       return handleDetail(args);
    case 'feedback':                     return handleFeedback(args);
    case 'list_recent_sessions':         return handleListRecentSessions(args);
    case 'list_projects':                return handleListProjects(args);
    case 'search_memory':                return handleSearchMemory(args);
    case 'list_claudeai_conversations':  return handleListClaudeaiConversations(args);
    case 'read_conversation':            return handleReadConversation(args);
    default: {
      const expanded = EXPANDED_HANDLERS[name];
      if (expanded) return expanded(args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
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
    { capabilities: { tools: {} }, instructions: LM_ASSIST_INSTRUCTIONS },
  );
  configureMcpServer(server, dispatch);
  return server;
}

/**
 * Read the request body as a JSON object. Returns undefined for empty
 * bodies (the SDK transport tolerates `body=undefined` and parses fresh
 * from the request stream in that case).
 */
/**
 * Send one MCP message as the StreamableHTTP transport would — a single SSE
 * `event: message` frame. Used to short-circuit deny/pending decisions before
 * the transport runs, while staying wire-compatible with the MCP client.
 */
function sendMcpMessage(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

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

  // Per-user admin gate (lm-assist-owned): a tool the user has GATED parks for
  // out-of-band confirm instead of executing; every other tool runs normally.
  // This MCP connection is the user's own — there is no cross-account authz and
  // no deny. Other JSON-RPC methods (initialize, tools/list, ping) are never gated.
  if (body && typeof body === 'object' && (body as Record<string, unknown>).method === 'tools/call') {
    const b = body as { id?: unknown; params?: { name?: unknown; arguments?: unknown } };
    const toolName = String(b.params?.name || '');
    const reqId = b.id ?? null;
    if (evaluateAccess(toolName).decision === 'pending') {
      const p = createPending(
        toolName,
        (b.params?.arguments as Record<string, unknown>) || {},
        toolName,
      );
      sendMcpMessage(res, {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          content: [
            {
              type: 'text',
              text:
                `⏸ pending_confirmation\n\nThe tool "${toolName}" is gated for admin approval and was NOT ` +
                `executed — it needs out-of-band confirmation.\n\npendingId: ${p.id}\n\nConfirm or deny it in ` +
                `the lm-assist MCP settings tab, or POST /mcp/pending/${p.id}/confirm . Expires in 10 minutes.`,
            },
          ],
        },
      });
      return;
    }
    // ungated → fall through to normal dispatch
  }

  // The connector tags each tool call with the calling conversation's tool_use id in
  // `_meta["claudecode/toolUseId"]` (a `toolu_…`, verified live). Lift it here so the session
  // resolver can pin the EXACT caller session (bootstrap/session_status) instead of guessing by
  // recency. Read from the raw body — robust whether or not the SDK preserves `_meta` downstream.
  const callerToolUseId = ((): string | undefined => {
    const m = (body as any)?.params?._meta;
    const v = m && (m['claudecode/toolUseId'] ?? m.toolUseId);
    return typeof v === 'string' ? v : undefined;
  })();

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Resolve the caller's principal from the ORIGINATING request (the SDK strips this),
  // so principal-gated tools (data_*) enforce cloud-vs-local correctly.
  const synthReq = {
    method: req.method || 'POST', path: '/mcp', params: {}, query: {}, body: undefined,
    headers: req.headers as ParsedRequest['headers'],
    clientIp: req.socket?.remoteAddress || undefined,
  } as ParsedRequest;
  const principal = getDataService().resolvePrincipal(synthReq);

  try {
    await server.connect(transport);
    await runWithMcpContext({ principal, toolUseId: callerToolUseId }, () => transport.handleRequest(req, res, body));
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
