/**
 * claude.ai connector-management MCP tools (for the case of MULTIPLE connectors
 * or custom per-use connectors):
 *   - list_claudeai_connectors   — discover connectors + their uuids/tools
 *   - refresh_connector_tools    — clear a connector's cached tools/list
 *   - set_connector_tool_access  — enable/block a connector's tools
 *
 * The two write tools target a connector by `server_uuid`, by `connector`
 * (name/url substring), or — with neither — auto-pick the langmart connector
 * (or the only one). Endpoints captured via lm-proxy 2026-06-20; see the
 * claude.ai routes. Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS.
 */
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export const listClaudeaiConnectorsToolDef = {
  name: 'list_claudeai_connectors',
  description:
    'List the MCP connectors registered on the user\'s claude.ai account — each with ' +
    'name, uuid, url, connected/auth status, and tool count. Trigger words: "my ' +
    'connectors", "list mcp connectors", "what connectors do I have", "connector uuid", ' +
    '"which connectors are connected". Use this to get the `server_uuid` for ' +
    '`refresh_connector_tools` / `set_connector_tool_access` when you have MULTIPLE ' +
    'connectors. Pass `include_tools` to also list each connector\'s tool names. ' +
    'Read-only. (Distinct from `list_nodes` = physical hosts, and ' +
    '`list_claudeai_conversations` = chats.)',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      include_tools: { type: 'boolean', description: 'Also list each connector\'s tool names (default false).' },
    },
  },
};

export const refreshConnectorToolsToolDef = {
  name: 'refresh_connector_tools',
  description:
    'Force claude.ai to re-fetch a connector\'s tool list — clears its cached ' +
    'tools/list so newly-added/changed MCP tools appear (the API equivalent of the ' +
    'web "refresh tools" button). Trigger words: "refresh tools", "reload the connector", ' +
    '"my new tools aren\'t showing", "re-sync tools", "update the tool menu". Target the ' +
    'connector with `server_uuid` or `connector` (name/url substring, e.g. "langmart", ' +
    '"drive"); with neither it auto-picks the langmart connector (or the only one). After ' +
    'it runs, the new tools surface on the next tool-menu reload / fresh session. WRITE — ' +
    'changes claude.ai connector state. Runs where the claude.ai cookie lives (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      server_uuid: { type: 'string', description: 'Connector UUID (from list_claudeai_connectors).' },
      connector: { type: 'string', description: 'Connector name/url substring to target (alternative to server_uuid).' },
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
    'names to turn back on). Target the connector with `server_uuid` or `connector` ' +
    '(name/url substring); with neither it auto-picks the langmart connector. ' +
    'Read-modify-write: reads the full enabled-tools map, flips ONLY the named tools, and ' +
    'writes it all back, so other tools/connectors are preserved. (Sets enabled-vs-blocked; ' +
    'the per-version "always allow" auto-approval is separate.) WRITE — changes claude.ai ' +
    'connector state. Runs where the claude.ai cookie lives (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      block: { type: 'array', items: { type: 'string' }, description: 'Tool names to BLOCK (disable).' },
      enable: { type: 'array', items: { type: 'string' }, description: 'Tool names to ENABLE (un-block).' },
      server_uuid: { type: 'string', description: 'Connector UUID (from list_claudeai_connectors).' },
      connector: { type: 'string', description: 'Connector name/url substring to target (alternative to server_uuid).' },
    },
  },
};

export const REFRESH_CONNECTOR_TOOL_DEFS = [
  listClaudeaiConnectorsToolDef,
  refreshConnectorToolsToolDef,
  setConnectorToolAccessToolDef,
] as const;

interface ConnectorEntry {
  uuid: string;
  name?: string;
  url?: string;
  connected?: boolean;
  authStatus?: string | null;
  toolCount?: number;
  tools?: string[];
}

async function listConnectors(): Promise<ConnectorEntry[]> {
  const list = (await workerGet('/claude-ai/mcp/servers')) as { servers?: ConnectorEntry[] };
  return list.servers || [];
}

/**
 * Resolve the target connector: an explicit `serverUuid`, else a `connector`
 * name/url substring (must match exactly one), else auto-pick langmart / the
 * only one.
 */
async function resolveConnector(serverUuid: string, match: string): Promise<{ uuid: string; label: string } | { error: string }> {
  const uuid = serverUuid.trim();
  if (uuid) return { uuid, label: uuid };

  let servers: ConnectorEntry[];
  try {
    servers = await listConnectors();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (servers.length === 0) return { error: 'No claude.ai MCP connectors found (is the cookie configured? check auth_status).' };

  const opts = () => servers.map((s) => `${s.name || '?'} (${s.uuid})`).join('; ');
  const m = match.trim().toLowerCase();
  if (m) {
    const hits = servers.filter((s) => (s.name || '').toLowerCase().includes(m) || (s.url || '').toLowerCase().includes(m));
    if (hits.length === 0) return { error: `No connector matches "${match}". Connectors: ${opts()}` };
    if (hits.length > 1) return { error: `"${match}" matches ${hits.length} connectors — be more specific or pass server_uuid. Matches: ${hits.map((s) => `${s.name} (${s.uuid})`).join('; ')}` };
    return { uuid: hits[0].uuid, label: hits[0].name || hits[0].uuid };
  }

  const pick =
    servers.find((s) => /langmart/i.test(s.url || '') || /langmart/i.test(s.name || '')) ||
    (servers.length === 1 ? servers[0] : undefined);
  if (!pick) return { error: `Multiple connectors — pass server_uuid or connector (name). Options: ${opts()}` };
  return { uuid: pick.uuid, label: pick.name || pick.uuid };
}

async function handleListClaudeaiConnectors(args: Record<string, unknown>): Promise<McpToolResult> {
  let servers: ConnectorEntry[];
  try {
    servers = await listConnectors();
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (servers.length === 0) return ok('No claude.ai MCP connectors registered.');
  const includeTools = args.include_tools === true;
  const lines = [`claude.ai MCP connectors (${servers.length}):`, ''];
  for (const s of servers) {
    const status = [s.connected ? 'connected' : 'disconnected', s.authStatus || undefined].filter(Boolean).join(', ');
    lines.push(`- ${s.name || '(unnamed)'}  [${status}]`);
    lines.push(`  uuid: ${s.uuid}`);
    lines.push(`  url: ${s.url || '?'}`);
    lines.push(`  ${s.toolCount ?? s.tools?.length ?? 0} tools`);
    if (includeTools && s.tools?.length) lines.push(`  tools: ${s.tools.join(', ')}`);
  }
  lines.push('');
  lines.push('→ refresh_connector_tools(server_uuid="…") to re-fetch a connector\'s tools; set_connector_tool_access(server_uuid="…", block=[…]) to enable/block.');
  return ok(lines.join('\n'));
}

async function handleRefreshConnectorTools(args: Record<string, unknown>): Promise<McpToolResult> {
  const r = await resolveConnector(String(args.server_uuid || ''), String(args.connector || ''));
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
  const r = await resolveConnector(String(args.server_uuid || ''), String(args.connector || ''));
  if ('error' in r) return err(r.error);
  try {
    const res = (await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(r.uuid)}/tool-access`, { enable, block })) as {
      changed?: Record<string, boolean>;
      totalKeys?: number;
    };
    const n = res.changed ? Object.keys(res.changed).length : 0;
    return ok(
      `Updated tool access on connector "${r.label}" (${r.uuid}): ` +
        `${block.length ? `blocked [${block.join(', ')}]` : ''}${block.length && enable.length ? '; ' : ''}` +
        `${enable.length ? `enabled [${enable.join(', ')}]` : ''}. ` +
        `${n} tool(s) changed; ${res.totalKeys ?? '?'} total settings preserved. Reload the tool menu to see it take effect.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const REFRESH_CONNECTOR_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  list_claudeai_connectors: handleListClaudeaiConnectors,
  refresh_connector_tools: handleRefreshConnectorTools,
  set_connector_tool_access: handleSetConnectorToolAccess,
};
