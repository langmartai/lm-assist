// core/src/mcp-server/principal-context.ts
// Carries the MCP caller's resolved principal across the MCP SDK dispatch, which
// otherwise strips all HTTP request context. Set at each MCP entry point; read by
// principal-gated tool handlers (data_*).
import { AsyncLocalStorage } from 'async_hooks';
import type { Principal } from '../data/types';

export interface McpCallContext {
  principal: Principal;
  /**
   * The calling conversation's tool_use block id (`toolu_…`), lifted from the request's
   * `_meta["claudecode/toolUseId"]`. Present when the MCP client (Claude Code) tags the call;
   * lets the session resolver pin the EXACT caller session instead of guessing by recency.
   */
  toolUseId?: string;
}

const storage = new AsyncLocalStorage<McpCallContext>();

export function runWithMcpContext<T>(ctx: McpCallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentMcpContext(): McpCallContext | undefined {
  return storage.getStore();
}
