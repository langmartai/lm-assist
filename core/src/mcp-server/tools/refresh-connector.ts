/**
 * refresh_connector_tools MCP tool — clear claude.ai's cached tool list for an
 * MCP connector so it RE-FETCHES tools/list on the next bootstrap. This is the
 * programmatic equivalent of the web UI's "refresh tools" button (which calls
 * POST /mcp/remote_servers/{uuid}/clear_cache — captured via lm-proxy
 * 2026-06-20). Use it after deploying NEW worker tools so they surface without
 * a manual click.
 *
 * Runs on the node that holds the claude.ai cookie (target it with `node`).
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), scoped
 * write in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export const refreshConnectorToolsToolDef = {
  name: 'refresh_connector_tools',
  description:
    'Force claude.ai to re-fetch a connector\'s tool list — clears its cached ' +
    'tools/list so newly-added/changed MCP tools appear (the API equivalent of the ' +
    'web "refresh tools" button). Trigger words: "refresh tools", "reload the connector", ' +
    '"my new tools aren\'t showing", "re-sync tools", "update the tool menu". With no ' +
    'argument it auto-targets the lm-assist langmart connector (or the only one); pass ' +
    '`server_uuid` to pick a specific connector (from claudeai mcp servers). After it ' +
    'runs, the new tools surface on the next tool-menu reload / fresh session. WRITE — ' +
    'changes claude.ai connector state. Runs where the claude.ai cookie lives (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      server_uuid: {
        type: 'string',
        description: 'Connector UUID to refresh. Omit to auto-pick the langmart connector (or the only one).',
      },
    },
  },
};

export const setConnectorToolAccessToolDef = {
  name: 'set_connector_tool_access',
  description:
    'Enable or BLOCK specific MCP tools on a claude.ai connector — the web "tool ' +
    'access" control. Trigger words: "block that tool", "disable agent_execute", "turn ' +
    'off browser_task", "re-enable detail", "stop showing X", "allow tool Y". Pass ' +
    '`block` (tool names to disable — they stop showing/running) and/or `enable` (tool ' +
    'names to turn back on). With no `server_uuid` it auto-targets the langmart connector. ' +
    'Read-modify-write: only the named tools change; everything else is preserved. (This ' +
    'sets enabled-vs-blocked; the per-version "always allow" auto-approval is separate.) ' +
    'WRITE — changes claude.ai connector state. Runs where the claude.ai cookie lives ' +
    '(use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      block: { type: 'array', items: { type: 'string' }, description: 'Tool names to BLOCK (disable).' },
      enable: { type: 'array', items: { type: 'string' }, description: 'Tool names to ENABLE (un-block).' },
      server_uuid: { type: 'string', description: 'Connector UUID. Omit to auto-pick the langmart connector.' },
    },
  },
};

export const REFRESH_CONNECTOR_TOOL_DEFS = [refreshConnectorToolsToolDef, setConnectorToolAccessToolDef] as const;

interface ConnectorEntry { uuid: string; name?: string; url?: string }

/** Resolve the target connector: an explicit uuid, else auto-pick langmart / the only one. */
async function resolveConnector(serverUuid: string): Promise<{ uuid: string; label: string } | { error: string }> {
  const uuid = serverUuid.trim();
  if (uuid) return { uuid, label: uuid };
  let servers: ConnectorEntry[];
  try {
    const list = (await workerGet('/claude-ai/mcp/servers')) as { servers?: ConnectorEntry[] };
    servers = list.servers || [];
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (servers.length === 0) return { error: 'No claude.ai MCP connectors found (is the cookie configured? check auth_status).' };
  const pick =
    servers.find((s) => /langmart/i.test(s.url || '') || /langmart/i.test(s.name || '')) ||
    (servers.length === 1 ? servers[0] : undefined);
  if (!pick) {
    return { error: 'Multiple connectors found — pass server_uuid. Options: ' + servers.map((s) => `${s.name || '?'} (${s.uuid})`).join('; ') };
  }
  return { uuid: pick.uuid, label: pick.name || pick.uuid };
}

async function handleRefreshConnectorTools(args: Record<string, unknown>): Promise<McpToolResult> {
  const r = await resolveConnector(String(args.server_uuid || ''));
  if ('error' in r) return err(r.error);
  try {
    await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(r.uuid)}/clear-cache`, {});
    return ok(
      `Cleared claude.ai's tool cache for connector "${r.label}" (${r.uuid}). ` +
        'claude.ai will re-fetch tools/list on the next bootstrap — newly-added tools ' +
        'surface on the next tool-menu reload / fresh session.',
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSetConnectorToolAccess(args: Record<string, unknown>): Promise<McpToolResult> {
  const block = Array.isArray(args.block) ? (args.block as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  const enable = Array.isArray(args.enable) ? (args.enable as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (block.length === 0 && enable.length === 0) return err('Provide block[] and/or enable[] tool names.');
  const r = await resolveConnector(String(args.server_uuid || ''));
  if ('error' in r) return err(r.error);
  try {
    const res = (await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(r.uuid)}/tool-access`, { enable, block })) as {
      changed?: Record<string, boolean>;
      totalTools?: number;
    };
    const n = res.changed ? Object.keys(res.changed).length : 0;
    return ok(
      `Updated tool access on connector "${r.label}" (${r.uuid}): ` +
        `${block.length ? `blocked [${block.join(', ')}]` : ''}${block.length && enable.length ? '; ' : ''}` +
        `${enable.length ? `enabled [${enable.join(', ')}]` : ''}. ` +
        `${n} key(s) changed. Reload the tool menu to see it take effect.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const REFRESH_CONNECTOR_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  refresh_connector_tools: handleRefreshConnectorTools,
  set_connector_tool_access: handleSetConnectorToolAccess,
};
