/**
 * Register the LangMart hub MCP server into a Claude Code config so an enrolled
 * node's Claude Code sessions get the worker-role / orchestration tools
 * (set_role, report_status, worker_status, decide_gate, list_workers, bootstrap,
 * guide, ...) at session startup.
 *
 * Why this works (the "keystone"): the public hub MCP endpoint
 * `https://mcp.<domain>/mcp` accepts the node's long-term `sk-langassist`
 * enrollment key as a plain `Authorization: Bearer` token (verified), and it is
 * always-up — so unlike `http://localhost:3100/mcp` (the node's own Core, which
 * only comes up mid-first-turn), there is NO startup-ordering problem. A Claude
 * Code session configured with this http MCP server loads the full tool surface
 * immediately.
 *
 * These helpers are pure (no fs / no I/O) so the CLI can read-modify-write
 * `~/.claude.json` around them and they stay unit-testable.
 */

export const HUB_MCP_SERVER_NAME = 'lm-assist-hub';

export interface HubHttpMcpServer {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

/**
 * Derive the public MCP HTTP endpoint from the hub's WebSocket URL.
 *   wss://assist-api.langmart.ai      -> https://mcp.langmart.ai/mcp
 *   wss://assist-api.xeenhub.com      -> https://mcp.xeenhub.com/mcp
 *   wss://assist-api.langmart.ai/ws   -> https://mcp.langmart.ai/mcp  (host only)
 * Returns null when `hubUrl` is missing/garbage or is not an `assist-api.<domain>`
 * host (e.g. already an `mcp.` host, or an unrelated origin).
 */
export function deriveHubMcpUrl(hubUrl: string | undefined | null): string | null {
  if (!hubUrl || typeof hubUrl !== 'string') return null;
  let host: string;
  try {
    host = new URL(hubUrl).hostname;
  } catch {
    return null;
  }
  const m = host.match(/^assist-api\.(.+)$/);
  if (!m) return null;
  return `https://mcp.${m[1]}/mcp`;
}

/**
 * Return a NEW Claude Code config object with the hub MCP server upserted under
 * the top-level `mcpServers` (user scope). All other config and any other MCP
 * servers are preserved; the input is not mutated. Re-running replaces only our
 * named entry (idempotent — safe to call on every `lm-assist login`).
 */
export function upsertHubMcpServer(
  config: Record<string, unknown> | null | undefined,
  opts: { url: string; key: string; name?: string },
): Record<string, unknown> {
  const name = opts.name || HUB_MCP_SERVER_NAME;
  const base: Record<string, unknown> =
    config && typeof config === 'object' ? config : {};
  const existingServers: Record<string, unknown> =
    base.mcpServers && typeof base.mcpServers === 'object'
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  const entry: HubHttpMcpServer = {
    type: 'http',
    url: opts.url,
    headers: { Authorization: `Bearer ${opts.key}` },
  };
  return {
    ...base,
    mcpServers: { ...existingServers, [name]: entry },
  };
}
