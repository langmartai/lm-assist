/**
 * Shared helper for MCP tools that wrap an existing lm-assist HTTP route.
 *
 * Several of the expanded MCP tools (agent executions, memory cross-host,
 * terminal capture, etc.) simply surface data that an internal lm-assist
 * REST route already computes + formats. Rather than duplicate that logic
 * in-process, these tools fetch the route on loopback. The hop is
 * same-host, same-process-tree, localhost-only — cheap and keeps a single
 * source of truth for each route's behavior.
 *
 * `worker-fetch` resolves the same port the stdio api-client uses (honoring
 * dev mode), so it works whether the core API runs on 3100 (prod) or 3200
 * (dev).
 */

import * as fs from 'fs';
import { lmAuthHeaders } from '../../auth/api-token';
import * as os from 'os';
import * as path from 'path';

function resolveApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  try {
    const cfgPath = path.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.devModeEnabled) return '3200';
  } catch {
    /* default below */
  }
  return '3100';
}

const BASE_URL = `http://127.0.0.1:${resolveApiPort()}`;

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Unwrap the `{success, data, error}` envelope from a loopback route response.
 * On a non-2xx (or `success:false`) it throws, preferring a structured
 * `error.message` (with `error.hint` appended when present), then a plain
 * STRING `error` (the transport/port-forward routes return that), and otherwise
 * INCLUDING the raw response body — so an opaque `<route> returned 400` becomes
 * diagnosable. Returns `data` on success.
 */
export async function unwrapEnvelope<T = unknown>(
  res: { ok: boolean; status: number; text(): Promise<string> },
  routePath: string,
): Promise<T> {
  const text = await res.text();
  let json:
    | { success?: boolean; data?: T; error?: { message?: string; hint?: string } | string }
    | null = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
  if (!res.ok || json?.success === false) {
    const e = json?.error;
    // Structured error object — keep the message and ride the actionable hint along.
    if (e && typeof e === 'object' && e.message) {
      throw new Error(e.hint ? `${e.message} — ${e.hint}` : e.message);
    }
    // Plain string error (transport.routes / port-forward.routes use this shape).
    if (typeof e === 'string' && e) throw new Error(e);
    const body = text ? `: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}` : '';
    throw new Error(`${routePath} returned ${res.status}${body}`);
  }
  return (json?.data ?? (json as unknown)) as T;
}

/** Wrap arbitrary text as a successful tool result. */
export function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wrap an error message as a failed tool result. */
export function err(message: string): McpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * GET an lm-assist route on loopback and return its parsed `data` (the
 * standard `{success, data, error}` envelope is unwrapped). Throws on
 * transport failure or `success:false` so callers can `try/catch` into
 * `err(...)`.
 */
export async function workerGet<T = unknown>(routePath: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    headers: { ...lmAuthHeaders() },
    signal: AbortSignal.timeout(15000),
  });
  return unwrapEnvelope<T>(res, routePath);
}

/** GET with a caller-set timeout (long-poll reads exceed workerGet's 15s default). */
export async function workerGetLong<T = unknown>(routePath: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    headers: { ...lmAuthHeaders() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return unwrapEnvelope<T>(res, routePath);
}

/** POST an lm-assist route on loopback. Same envelope handling as workerGet. */
export async function workerPost<T = unknown>(
  routePath: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return unwrapEnvelope<T>(res, routePath);
}

/**
 * POST an lm-assist route on loopback and return the FULL response body
 * verbatim (no `{success,data,error}` unwrapping, no throw on `success:false`).
 * Used by tools (e.g. github_*) that need the structured envelope — backend
 * served, typed error code — rather than just the unwrapped `data`. Longer
 * timeout covers git clone/push. Still throws on transport failure.
 */
export async function workerPostRaw(
  routePath: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** PUT an lm-assist route on loopback. Same envelope handling as workerGet. */
export async function workerPut<T = unknown>(
  routePath: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return unwrapEnvelope<T>(res, routePath);
}

/** DELETE an lm-assist route on loopback. Same envelope handling as workerGet. */
export async function workerDelete<T = unknown>(
  routePath: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  return unwrapEnvelope<T>(res, routePath);
}

/**
 * cwd allowlist for agent_execute / terminal_open_tab (defense-in-depth layer 6 — the
 * gateway's pending-confirm is the primary gate; this is a second wall at the worker).
 * Re-exported from the shared single-source util so the github git backend's
 * directory-targeted ops use the exact same gate. Per operator decision: any
 * directory under /home/ubuntu is permitted.
 */
export { isCwdAllowed } from '../../utils/cwd-allowlist';
