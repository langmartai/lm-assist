/**
 * Session Context MCP Server
 *
 * Provides Claude Code sessions with semantic search over past work
 * and milestone-based navigation.
 *
 * Transport: stdio (spawned by Claude Code as an MCP server)
 *
 * 3 Tools:
 *   search  — Unified search across knowledge, milestones, architecture, file history
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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  searchToolDef, searchToolDefExperiment,
  detailToolDef, detailToolDefExperiment,
  feedbackToolDef,
} from './tools/definitions';
import { logToolCall } from './mcp-logger';
import { ensureCoreApi, mcpSearch, mcpDetail, mcpFeedback, getMcpSettings } from './api-client';

// ─── Server Setup ──────────────────────────────────────────────────

const server = new Server(
  {
    name: 'lm-assist',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Settings Cache ──────────────────────────────────────────────────

let cachedMilestoneEnabled: boolean | null = null;

async function isMilestoneEnabled(): Promise<boolean> {
  if (cachedMilestoneEnabled !== null) return cachedMilestoneEnabled;
  try {
    const settings = await getMcpSettings();
    cachedMilestoneEnabled = settings.milestoneEnabled;
    return cachedMilestoneEnabled;
  } catch {
    // Default to false if API unreachable
    return false;
  }
}

// ─── Tool Registration ──────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const experimentEnabled = await isMilestoneEnabled();
  return {
    tools: [
      experimentEnabled ? searchToolDefExperiment : searchToolDef,
      experimentEnabled ? detailToolDefExperiment : detailToolDef,
      feedbackToolDef,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const t0 = Date.now();

  try {
    let result: { content: Array<{ type: string; text: string }>; isError?: boolean };

    switch (name) {
      case 'search':
        result = await mcpSearch(args || {});
        break;
      case 'detail':
        result = await mcpDetail(args || {});
        break;
      case 'feedback':
        result = await mcpFeedback(args || {});
        break;
      default:
        result = {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    logToolCall(name, (args || {}) as Record<string, unknown>, Date.now() - t0, result);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const errResult = {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true as const,
    };
    logToolCall(name, (args || {}) as Record<string, unknown>, Date.now() - t0, errResult);
    return errResult;
  }
});

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
