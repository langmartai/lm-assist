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

import { configureMcpServer, type McpToolDispatcher, getLmAssistInstructions } from './configure';
import { getHubConfig } from '../hub-client/hub-config';
import { hubHostOf, envLabelOf } from './fleet-identity';
import { PROFILE_PIN_ENV, resolveEffectiveProfile, type EffectiveProfile } from './registry/profiles';
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
import { isPluginToolName } from './plugins/model';
import { createHttpExtToolProvider, callPluginViaCore } from './plugins/ext-http';
import { createHttpOverlayProvider } from './registry/overlay-http';
import { startToolsChangeWatcher } from './tools-change-watcher';

// ─── Profile pin ──────────────────────────────────────────────────
// A stdio server is one process per client entry, so its pin is the entry's own
// (`claude mcp add lm-assist-basic -e LM_MCP_PROFILE=basic -- node …/index.js`). Read
// ONCE. No pin ⇒ PINNED is undefined: tools/list re-reads the node default on every
// request and no MCP context is installed, exactly as before pins.
const PROFILE_PIN = (process.env[PROFILE_PIN_ENV] || '').trim() || undefined;
const PINNED: EffectiveProfile | undefined = PROFILE_PIN ? resolveEffectiveProfile(PROFILE_PIN) : undefined;
if (PINNED) {
  console.error(
    PINNED.unknownPin
      ? `[MCP] ${PROFILE_PIN_ENV}="${PINNED.pin}" names no profile — serving the node default (${PINNED.name}) instead`
      : `[MCP] profile pinned by ${PROFILE_PIN_ENV}: ${PINNED.name}`,
  );
}

// ─── Server Setup ──────────────────────────────────────────────────

const server = new Server(
  { name: mcpServerName(), version: '2.0.0' },
  // tools.listChanged is a PROMISE: it is declared only because
  // startToolsChangeWatcher() below actually sends the notification. Advertising
  // a capability we do not honour would leave clients trusting a stale list.
  // Instructions are fixed at spawn, so they are built for this process's profile: its
  // pin, else the node default in force NOW. Unpinned under the shipped default `admin`
  // that is the pre-pin text byte for byte; under a narrowed node default the client is
  // told which profile it is on, as an HTTP client is (spec §3). A later
  // `mcp_profile set` reaches tools/list at once and the banner at the next spawn.
  { capabilities: { tools: { listChanged: true } }, instructions: getLmAssistInstructions(PINNED ?? resolveEffectiveProfile(undefined)) }
);

/** Distinct server name per environment so the two connectors read apart. */
function mcpServerName(): string {
  try {
    const cfg = getHubConfig();
    return envLabelOf(hubHostOf(cfg.hubUrl), cfg.hostname) === 'DEVELOPMENT' ? 'lm-assist-dev' : 'lm-assist';
  } catch {
    return 'lm-assist';
  }
}

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
      // Third-party plugin tools execute in Core's aggregator, never in this process.
      if (isPluginToolName(name)) return callPluginViaCore(name, args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
};

// Tool-registry overlay (spec §4.4): fetched from the core API per list/call with a
// short TTL — registry edits apply live; core unreachable ⇒ fail-open defaults (the
// core-side shim guards still reject disabled calls).
// The pin (if any) narrows tools/list here and — forwarded as a header by api-client —
// reaches the Core-side handlers on every /mcp-call.
configureMcpServer(
  server, dispatch, createHttpOverlayProvider(), createHttpExtToolProvider(),
  PINNED ? { profile: PINNED } : undefined,
);

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Ensure core API is running (auto-starts if needed)
  ensureCoreApi().catch(err => {
    console.error('[MCP] Failed to ensure core API:', err);
  });

  // Core mutates the tool set (registry overlay, plugin sync) in ANOTHER process
  // and cannot reach this client. Poll its rev stamp and forward the change.
  startToolsChangeWatcher(() => server.sendToolListChanged());

  console.error('[MCP] lm-assist server started (v2 — HTTP client mode)');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
