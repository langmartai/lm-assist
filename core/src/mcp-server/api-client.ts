/**
 * MCP API Client
 *
 * Thin HTTP client for the MCP server to call core API endpoints.
 * Uses Node.js built-in fetch. On startup, ensures the core API and web
 * are running (auto-starts via service-manager if needed).
 */

import { startCore, startWeb } from '../service-manager';

// ─── Configuration ──────────────────────────────────────────────────

const API_PORT = process.env.API_PORT || '3100';
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

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

async function post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(`${BASE_URL}${endpoint}`);

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

export async function getMcpSettings(): Promise<{ milestoneEnabled: boolean }> {
  return get<{ milestoneEnabled: boolean }>('/mcp/settings');
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
