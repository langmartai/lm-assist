/**
 * claude.ai connector-management MCP tools (for the case of MULTIPLE connectors
 * or custom per-use connectors):
 *   - list_claudeai_connectors   — discover connectors + their uuids/tools
 *   - refresh_connector_tools    — clear a connector's cached tools/list
 *   - set_connector_tool_access  — enable/block a connector's tools
 *   - set_connector_auto_approve — "always approve" a connector's tools
 *
 * The write tools target a connector by `server_uuid`, by `connector` (uuid, name,
 * a profile name, or a name/url substring), or — with neither — EVERY connector whose
 * URL is this node's MCP endpoint (the unpinned `/mcp` and each `/mcp/<profile>`; see
 * profile-connectors.ts). Several targets are written in ONE batched read-modify-write.
 * Endpoints captured via lm-proxy 2026-06-20; see the claude.ai routes. Registered in
 * EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS.
 */
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';
import { mcpBase, ourConnectors } from '../profile-connectors';

export const listClaudeaiConnectorsToolDef = {
  name: 'list_claudeai_connectors',
  description:
    'List the MCP connectors registered on the user\'s claude.ai account — each with ' +
    'name, uuid, url, connected/auth status, and tool count. Trigger words: "my ' +
    'connectors", "list mcp connectors", "what connectors do I have", "connector uuid", ' +
    '"which connectors are connected". Use this to get the `server_uuid` for ' +
    '`refresh_connector_tools` / `set_connector_tool_access` when you have MULTIPLE ' +
    'connectors. Pass `include_tools` to also list each connector\'s tool names. ' +
    'Read-only. This node\'s own connectors are tagged with the profile their URL pins. (Distinct from `list_nodes` = physical hosts, and ' +
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
    'connector with `server_uuid` or `connector` (uuid, name, a profile name like "basic", or a ' +
    'name/url substring like "drive"); with neither it refreshes EVERY connector of this node ' +
    '(unpinned + per-profile). After ' +
    'it runs, the new tools surface on the next tool-menu reload / fresh session. WRITE — ' +
    'changes claude.ai connector state. Runs where the claude.ai cookie lives (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      server_uuid: { type: 'string', description: 'Connector UUID (from list_claudeai_connectors).' },
      connector: { type: 'string', description: 'Connector uuid, name, profile name, or name/url substring (alternative to server_uuid).' },
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
    '(uuid, name, profile name or name/url substring); with neither it applies to EVERY connector of this node. ' +
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
      connector: { type: 'string', description: 'Connector uuid, name, profile name, or name/url substring (alternative to server_uuid).' },
    },
  },
};

export const setConnectorAutoApproveToolDef = {
  name: 'set_connector_auto_approve',
  description:
    'Turn ON (or off) "always approve" auto-approval for a claude.ai connector\'s MCP tools, so the ' +
    'model can CALL them WITHOUT the per-call approval prompt — this is what smooths DRIVEN tool ' +
    'calls (e.g. via `claudeai_completion` with `enable_connector_tools`). lm-assist reads each ' +
    'tool\'s CURRENT per-version always-approved key from the live bootstrap (so it matches claude.ai\'s ' +
    'current tool defs — a stale hash is exactly what makes a driven approval 404) and writes it via ' +
    'read-modify-write, preserving all other settings. Pass `tools` (names) to scope, else applies to ' +
    'ALL the connector\'s tools; `enable:false` removes auto-approval. Target with `server_uuid`/' +
    '`connector` (default: every connector of this node). WRITE — changes claude.ai account settings. Runs where the ' +
    'claude.ai cookie lives (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      enable: { type: 'boolean', description: 'true (default) = auto-approve the tools; false = remove always-approved.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tool names to scope to (default: ALL the connector\'s tools).' },
      server_uuid: { type: 'string', description: 'Connector UUID (from list_claudeai_connectors).' },
      connector: { type: 'string', description: 'Connector uuid, name, profile name, or name/url substring (alternative to server_uuid).' },
    },
  },
};

export const REFRESH_CONNECTOR_TOOL_DEFS = [
  listClaudeaiConnectorsToolDef,
  refreshConnectorToolsToolDef,
  setConnectorToolAccessToolDef,
  setConnectorAutoApproveToolDef,
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

interface Target { uuid: string; label: string }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const describeTargets = (ts: Target[]): string => ts.map((t) => `"${t.label}" (${t.uuid})`).join(', ');

/**
 * Resolve the target connector(s):
 *   - `serverUuid` → exactly that one (no listing);
 *   - `match` → an exact uuid or name (case-insensitive); else a PROFILE name, meaning this node's
 *     connector pinned to it (`basic` → `<base>/mcp/basic`; compared literally, so the retired
 *     alias `langmart` reads as the hub name, below); else a name/url substring — one hit, or
 *     several hits that are ALL this node's connectors (`"langmart"` → every lm-assist connector
 *     on that hub). A substring spanning ours AND others is ambiguous;
 *   - neither → EVERY connector whose URL is this node's MCP endpoint (unpinned + per-profile).
 *     There is no first-match fallback: from a dev Core it acted on the production connector.
 */
async function resolveConnectors(serverUuid: string, match: string): Promise<{ targets: Target[] } | { error: string }> {
  const uuid = serverUuid.trim();
  if (uuid) return { targets: [{ uuid, label: uuid }] };

  let servers: ConnectorEntry[];
  try {
    servers = await listConnectors();
  } catch (e) {
    return { error: errText(e) };
  }
  if (servers.length === 0) return { error: 'No claude.ai MCP connectors found (is the cookie configured? check auth_status).' };

  const base = mcpBase();
  const mine = ourConnectors(servers, base);
  const label = (s: ConnectorEntry) => s.name || s.uuid;
  const opts = () => servers.map((s) => `${s.name || '?'} (${s.uuid})`).join('; ');
  const m = match.trim().toLowerCase();
  if (m) {
    const exact = servers.filter((s) => s.uuid.toLowerCase() === m || (s.name || '').toLowerCase() === m);
    if (exact.length === 1) return { targets: [{ uuid: exact[0].uuid, label: label(exact[0]) }] };
    const byProfile = mine.filter((c) => c.profile === m);
    if (byProfile.length) return { targets: byProfile.map((c) => ({ uuid: c.uuid, label: label(c) })) };
    const hits = servers.filter((s) => (s.name || '').toLowerCase().includes(m) || (s.url || '').toLowerCase().includes(m));
    if (hits.length === 0) return { error: `No connector matches "${match}". Connectors: ${opts()}` };
    if (hits.length === 1) return { targets: [{ uuid: hits[0].uuid, label: label(hits[0]) }] };
    const ours = new Set(mine.map((c) => c.uuid));
    if (hits.every((s) => ours.has(s.uuid))) return { targets: hits.map((s) => ({ uuid: s.uuid, label: label(s) })) };
    return { error: `"${match}" matches ${hits.length} connectors — be more specific or pass server_uuid. Matches: ${hits.map((s) => `${s.name} (${s.uuid})`).join('; ')}` };
  }

  if (mine.length) return { targets: mine.map((c) => ({ uuid: c.uuid, label: label(c) })) };
  return {
    error: base
      ? `No connector points at this node's MCP URL (${base}/mcp or ${base}/mcp/<profile>) — pass server_uuid or connector. Options: ${opts()}`
      : `This node has no hub configured, so none of these connectors is its own — pass server_uuid or connector. Options: ${opts()}`,
  };
}

async function handleListClaudeaiConnectors(args: Record<string, unknown>): Promise<McpToolResult> {
  let servers: ConnectorEntry[];
  try {
    servers = await listConnectors();
  } catch (e) {
    return err(errText(e));
  }
  if (servers.length === 0) return ok('No claude.ai MCP connectors registered.');
  const includeTools = args.include_tools === true;
  const mine = new Map(ourConnectors(servers).map((c) => [c.uuid, c.profile]));
  const lines = [`claude.ai MCP connectors (${servers.length}):`, ''];
  for (const s of servers) {
    const status = [s.connected ? 'connected' : 'disconnected', s.authStatus || undefined].filter(Boolean).join(', ');
    const own = mine.has(s.uuid)
      ? ` · this node's ${mine.get(s.uuid) ? `"${mine.get(s.uuid)}" profile` : 'unpinned'} connector`
      : '';
    lines.push(`- ${s.name || '(unnamed)'}  [${status}]${own}`);
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
  const r = await resolveConnectors(String(args.server_uuid || ''), String(args.connector || ''));
  if ('error' in r) return err(r.error);
  const done: Target[] = [];
  const failed: string[] = [];
  for (const t of r.targets) {
    try {
      await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(t.uuid)}/clear-cache`, {});
      done.push(t);
    } catch (e) {
      failed.push(`"${t.label}" (${t.uuid}): ${errText(e)}`);
    }
  }
  if (done.length === 0) return err(`Could not clear the tool cache — ${failed.join('; ')}`);
  const which = done.length === 1
    ? `connector "${done[0].label}" (${done[0].uuid})`
    : `${done.length} connectors: ${describeTargets(done)}`;
  return ok(
    `Cleared claude.ai's tool cache for ${which}. ` +
      'claude.ai will re-fetch tools/list on the next bootstrap — newly-added tools ' +
      'surface on the next tool-menu reload / fresh session.' +
      (failed.length ? ` FAILED for ${failed.length}: ${failed.join('; ')}` : ''),
  );
}

async function handleSetConnectorToolAccess(args: Record<string, unknown>): Promise<McpToolResult> {
  const block = Array.isArray(args.block) ? (args.block as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  const enable = Array.isArray(args.enable) ? (args.enable as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (block.length === 0 && enable.length === 0) return err('Provide block[] and/or enable[] tool names.');
  const r = await resolveConnectors(String(args.server_uuid || ''), String(args.connector || ''));
  if ('error' in r) return err(r.error);
  const what =
    `${block.length ? `blocked [${block.join(', ')}]` : ''}${block.length && enable.length ? '; ' : ''}` +
    `${enable.length ? `enabled [${enable.join(', ')}]` : ''}`;
  try {
    if (r.targets.length === 1) {
      const t = r.targets[0];
      const res = (await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(t.uuid)}/tool-access`, { enable, block })) as {
        changed?: Record<string, boolean>;
        totalKeys?: number;
      };
      const n = res.changed ? Object.keys(res.changed).length : 0;
      return ok(
        `Updated tool access on connector "${t.label}" (${t.uuid}): ${what}. ` +
          `${n} tool(s) changed; ${res.totalKeys ?? '?'} total settings preserved. Reload the tool menu to see it take effect.`,
      );
    }
    // Several connectors → ONE serialized read-modify-write (the PATCH replaces the whole map).
    const access: Record<string, boolean> = {};
    for (const t of block) access[t] = false;
    for (const t of enable) access[t] = true; // enable wins, as on the per-connector route
    const res = (await workerPost('/claude-ai/mcp/tool-settings/batch', {
      updates: r.targets.map((t) => ({ connectorUuid: t.uuid, access })),
    })) as { totalKeys?: number };
    return ok(
      `Updated tool access on ${r.targets.length} connectors (${describeTargets(r.targets)}) in one write: ${what}. ` +
        `${res.totalKeys ?? '?'} total settings preserved. Reload the tool menu to see it take effect.`,
    );
  } catch (e) {
    return err(errText(e));
  }
}

async function handleSetConnectorAutoApprove(args: Record<string, unknown>): Promise<McpToolResult> {
  const enable = typeof args.enable === 'boolean' ? args.enable : (args.enable === 'false' ? false : true);
  const tools = Array.isArray(args.tools) ? (args.tools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
  const r = await resolveConnectors(String(args.server_uuid || ''), String(args.connector || ''));
  if ('error' in r) return err(r.error);
  const scope = tools ? ` [${tools.join(', ')}]` : ' (all)';
  try {
    if (r.targets.length === 1) {
      const t = r.targets[0];
      const res = (await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(t.uuid)}/auto-approve`, { enable, tools })) as {
        changed?: string[]; skipped?: string[]; totalKeys?: number;
      };
      const n = res.changed?.length || 0;
      return ok(
        `${enable ? 'Enabled' : 'Disabled'} auto-approval on connector "${t.label}" (${t.uuid}) for ${n} tool(s)${scope}. ` +
          `${res.skipped?.length ? `Skipped ${res.skipped.length} (no always-approved key). ` : ''}` +
          `${res.totalKeys ?? '?'} total settings preserved. Driven tool calls should no longer hit the approval ` +
          'gate (use a fresh conversation to see it take effect).',
      );
    }
    const res = (await workerPost('/claude-ai/mcp/tool-settings/batch', {
      updates: r.targets.map((t) => ({ connectorUuid: t.uuid, autoApprove: { enable, ...(tools ? { tools } : {}) } })),
    })) as { results?: Array<{ connectorUuid: string; approved?: string[]; error?: string }>; totalKeys?: number };
    const parts = (res.results || []).map((x) => {
      const label = r.targets.find((t) => t.uuid === x.connectorUuid)?.label || x.connectorUuid;
      return x.error ? `"${label}": ${x.error}` : `"${label}": ${x.approved?.length ?? 0} tool(s)`;
    });
    return ok(
      `${enable ? 'Enabled' : 'Disabled'} auto-approval${scope} on ${r.targets.length} connectors in one write — ${parts.join('; ')}. ` +
        `${res.totalKeys ?? '?'} total settings preserved. Use a fresh conversation to see it take effect.`,
    );
  } catch (e) {
    return err(errText(e));
  }
}

export const REFRESH_CONNECTOR_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  list_claudeai_connectors: handleListClaudeaiConnectors,
  refresh_connector_tools: handleRefreshConnectorTools,
  set_connector_tool_access: handleSetConnectorToolAccess,
  set_connector_auto_approve: handleSetConnectorAutoApprove,
};
