/** stdio-side plugin providers.
 *
 *  The stdio MCP server is a separate process (the plugin cache binary) that talks to
 *  Core over HTTP, so it cannot reach the aggregator in-process: it learns the plugin
 *  tool list and executes plugin calls through Core, exactly like the registry overlay
 *  does. Core remains the single place where plugins are spawned — the stdio binary
 *  never runs third-party code itself. */
import { coreBaseUrl } from '../api-client';
import { lmAuthHeaders } from '../../auth/api-token';
import type { ExtToolDef, ExtToolDefsProvider, McpToolResult } from '../configure';

/** Short TTL: an enable/disable at the console should show up in the next tools/list
 *  without restarting the client. Fail-open — Core unreachable ⇒ no plugin tools. */
export function createHttpExtToolProvider(opts?: { ttlMs?: number; baseUrl?: string }): ExtToolDefsProvider {
  const ttl = opts?.ttlMs ?? 5000;
  let cached: { at: number; defs: ExtToolDef[] } | null = null;
  return {
    async list(): Promise<ExtToolDef[]> {
      const now = Date.now();
      if (cached && ttl > 0 && now - cached.at < ttl) return cached.defs;
      let defs: ExtToolDef[] = [];
      try {
        const res = await fetch(`${opts?.baseUrl ?? coreBaseUrl()}/mcp-plugins/tool-defs`, {
          headers: { ...lmAuthHeaders() },
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const body = (await res.json()) as { data?: { tools?: ExtToolDef[] } };
          if (Array.isArray(body?.data?.tools)) defs = body.data!.tools!;
        }
      } catch {
        defs = [];
      }
      cached = { at: now, defs };
      return defs;
    },
  };
}

/** Execute a plugin tool by asking Core to do it (Core owns every subprocess). */
export async function callPluginViaCore(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const res = await fetch(`${coreBaseUrl()}/mcp-plugins/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
      body: JSON.stringify({ tool: name, args }),
    });
    const body = (await res.json()) as { data?: McpToolResult; error?: { message?: string } };
    if (body?.data?.content) return body.data;
    return {
      content: [{ type: 'text', text: `Plugin call failed: ${body?.error?.message ?? `HTTP ${res.status}`}` }],
      isError: true,
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Plugin call failed (is the lm-assist Core running?): ${(e as Error).message}` }],
      isError: true,
    };
  }
}
