// core/src/mcp-server/principal-context.ts
// Carries the MCP caller's resolved principal across the MCP SDK dispatch, which
// otherwise strips all HTTP request context. Set at each MCP entry point; read by
// principal-gated tool handlers (data_*), the session resolver, the result footer —
// and, since profile pins, anything that must know which profile the caller is served.
import { AsyncLocalStorage } from 'async_hooks';
import type { Principal } from '../data/types';
import type { EffectiveProfile } from './registry/profiles';

export interface McpCallContext {
  principal: Principal;
  /**
   * The calling conversation's tool_use block id (`toolu_…`), lifted from the request's
   * `_meta["claudecode/toolUseId"]`. Present when the MCP client (Claude Code) tags the call;
   * lets the session resolver pin the EXACT caller session instead of guessing by recency.
   */
  toolUseId?: string;
  /**
   * The profile this request is served under — a connector's pin, or the node default —
   * resolved ONCE at the entry point (HTTP handleMcpRequest; Core's /mcp-call for a stdio
   * server's forwarded calls; configureMcpServer's CallTool inside a pinned stdio
   * process). Absent on entry points that predate pins: readers fall back to the node
   * default (liveEffectiveProfile(undefined)).
   */
  profile?: EffectiveProfile;
}

const storage = new AsyncLocalStorage<McpCallContext>();

export function runWithMcpContext<T>(ctx: McpCallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentMcpContext(): McpCallContext | undefined {
  return storage.getStore();
}

/** The effective profile of the MCP request in flight, if its entry point set one. */
export function currentEffectiveProfile(): EffectiveProfile | undefined {
  return storage.getStore()?.profile;
}
