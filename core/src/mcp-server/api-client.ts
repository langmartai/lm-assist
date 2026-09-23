/**
 * MCP API Client
 *
 * Thin HTTP client for the MCP server to call core API endpoints.
 * Uses Node.js built-in fetch. On startup, ensures the core API and web
 * are running (auto-starts via service-manager if needed).
 */

import * as fs from 'fs';
import { lmAuthHeaders } from '../auth/api-token';
import * as os from 'os';
import * as path from 'path';
import { startCore, startWeb } from '../service-manager';
import { PROFILE_PIN_ENV, PROFILE_PIN_HEADER } from './registry/profiles';

// ─── Configuration ──────────────────────────────────────────────────

function getDefaultApiPort(): string {
  try {
    const cfgPath = path.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.devModeEnabled) return '3200';
  } catch {}
  return '3100';
}

const API_PORT = process.env.API_PORT || getDefaultApiPort();
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

/** The core API base this stdio client targets (dev/prod resolved via config). */
export function coreBaseUrl(): string {
  return BASE_URL;
}

// ─── Types ──────────────────────────────────────────────────

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// ─── HTTP Helpers ──────────────────────────────────────────────────

async function post<T>(
  endpoint: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`API ${endpoint} returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as ApiResponse<T>;
  if (!json.success) {
    throw new Error(json.error?.message || `API ${endpoint} failed`);
  }
  return json.data as T;
}

async function get<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, { headers: lmAuthHeaders() });

  if (!res.ok) {
    throw new Error(`API ${endpoint} returned ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as ApiResponse<T>;
  if (!json.success) {
    throw new Error(json.error?.message || `API ${endpoint} failed`);
  }
  return json.data as T;
}

// ─── MCP Tool Endpoints ──────────────────────────────────────────────────

export async function mcpSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/search', args);
}

export async function mcpDetail(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/detail', args);
}

export async function mcpFeedback(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/feedback', args);
}

export async function mcpListRecentSessions(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/list_recent_sessions', args);
}

export async function mcpListProjects(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/list_projects', args);
}

export async function mcpSearchMemory(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/search_memory', args);
}

export async function mcpListClaudeaiConversations(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/list_claudeai_conversations', args);
}

export async function mcpReadConversation(args: Record<string, unknown>): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp/read_conversation', args);
}

/**
 * The header that forwards THIS stdio server's profile pin (env LM_MCP_PROFILE) to Core,
 * so the Core-side handlers — bootstrap, session_status, mcp_profile — and the result
 * footer see the profile this process advertises. Empty when unpinned: Core then sees
 * exactly the request it saw before pins existed. The raw pin is sent (Core resolves it
 * against its OWN definitions), bounded to printable ASCII — a control character would
 * make fetch throw and fail every forwarded call.
 */
export function profilePinHeaders(): Record<string, string> {
  const pin = (process.env[PROFILE_PIN_ENV] || '').trim();
  return pin ? { [PROFILE_PIN_HEADER]: pin.replace(/[^\x20-\x7e]/g, '?').slice(0, 64) } : {};
}

/**
 * Generic call for expanded-catalog tools — forwards {tool, args} to the
 * single `/mcp-call` shim, which dispatches via EXPANDED_HANDLERS. Lets new
 * read/write tools work over stdio without a per-tool endpoint + method.
 */
export async function mcpGenericCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  return post<McpToolResult>('/mcp-call', { tool, args }, profilePinHeaders());
}

// ─── Core API + Web Auto-Start ──────────────────────────────────────────────────

async function isApiRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the core API and web are running. If not, start them via the
 * cross-platform service-manager (no bash required).
 * Called once on MCP server startup.
 */
export async function ensureCoreApi(): Promise<void> {
  if (await isApiRunning()) {
    console.error('[MCP] Core API is running');
    // Still try to start web (might not be running)
    startWeb().then((r) => {
      console.error(`[MCP] Web: ${r.message}`);
    }).catch((err) => {
      console.error(`[MCP] Web start failed: ${err.message}`);
    });
    return;
  }

  console.error('[MCP] Core API not running, starting via service-manager...');
  const coreResult = await startCore();
  if (coreResult.success) {
    console.error(`[MCP] ${coreResult.message}`);
  } else {
    console.error(`[MCP] Warning: ${coreResult.message}. Tools may fail.`);
  }

  // Start web in background (don't block MCP startup)
  startWeb().then((r) => {
    console.error(`[MCP] Web: ${r.message}`);
  }).catch((err) => {
    console.error(`[MCP] Web start failed: ${err.message}`);
  });
}
