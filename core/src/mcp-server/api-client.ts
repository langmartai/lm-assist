/**
 * MCP API Client
 *
 * Thin HTTP client for the MCP server to call core API endpoints.
 * Uses Node.js built-in fetch. On startup, ensures the core API is running
 * (auto-starts via core.sh if needed).
 */

import { spawn, execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';

// ─── Configuration ──────────────────────────────────────────────────

const API_PORT = process.env.API_PORT || '3100';
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

// Paths relative to repo root. At runtime __dirname is core/dist/mcp-server/, so 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CORE_SH = path.join(REPO_ROOT, 'core.sh').replace(/\\/g, '/');
const CLI_JS = path.join(REPO_ROOT, 'core', 'dist', 'cli.js');

function hasBash(): boolean {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
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

// ─── Core API Auto-Start ──────────────────────────────────────────────────

async function isApiRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startCoreApi(): Promise<void> {
  try {
    if (hasBash()) {
      console.error('[MCP] Core API not running, starting via core.sh...');
      const child = spawn('bash', [CORE_SH, 'start'], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        console.error('[MCP] Failed to spawn core.sh:', err.message);
      });
      child.unref();
    } else {
      // Fallback: start node directly (no bash required)
      console.error('[MCP] Core API not running, starting via node directly...');
      const child = spawn(process.execPath, [CLI_JS, 'serve', '--port', API_PORT, '--project', os.homedir()], {
        detached: true,
        stdio: 'ignore',
        cwd: REPO_ROOT,
      });
      child.on('error', (err) => {
        console.error('[MCP] Failed to spawn node:', err.message);
      });
      child.unref();
    }
  } catch (err) {
    console.error('[MCP] Failed to start core API:', err);
  }

  // Don't wait for the child — it's a long-running server.
  // Let the polling loop in ensureCoreApi() wait for health.
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Ensure the core API is running. If not, attempt to start it and wait.
 * Called once on MCP server startup.
 */
export async function ensureCoreApi(): Promise<void> {
  if (await isApiRunning()) {
    console.error('[MCP] Core API is running');
    return;
  }

  await startCoreApi();

  // Poll for health with timeout
  const maxWaitMs = 30_000;
  const pollIntervalMs = 2000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    if (await isApiRunning()) {
      console.error('[MCP] Core API started successfully');
      return;
    }
  }

  console.error('[MCP] Warning: Core API did not start within timeout. Tools may fail.');
}
