// core/src/mcp-server/connector-tools-array.ts
// Build the claude.ai SPA-shaped `tools[]` array that POST /completion needs in order to expose a
// connector's tools to the model on a turn (each entry: {name, description, integration_name,
// mcp_server_uuid, mcp_server_url, input_schema}). Without it the model sees NO connector tools
// (the bare `claudeai_completion` sends `tools:[]`). We build it from the worker's OWN tool defs
// (authoritative for name/description/schema) + the discovered connector identity. Pure → testable.

export interface ConnectorRef { uuid: string; url: string; name: string; connected?: boolean; tools?: string[] }
export interface ToolDef { name: string; description?: string; inputSchema?: unknown }
export interface SpaTool {
  name: string; description: string; integration_name: string;
  mcp_server_uuid: string; mcp_server_url: string; input_schema: unknown;
}

/** Map worker tool defs → claude.ai SPA tool entries for one connector. `names` (if given) restricts
 *  the set; otherwise the connector's own advertised tool list is used; otherwise all defs. */
export function buildConnectorToolsArray(connector: ConnectorRef, toolDefs: ToolDef[], names?: string[]): SpaTool[] {
  const allow = names && names.length ? new Set(names)
    : (connector.tools && connector.tools.length ? new Set(connector.tools) : null);
  return toolDefs
    .filter((t) => !allow || allow.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      integration_name: connector.name || 'lm-assist',
      mcp_server_uuid: connector.uuid,
      mcp_server_url: connector.url,
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
}

/** Pick the connected lm-assist/langmart connector from a server roster (prefer a langmart-looking
 *  url/name; else the sole connected server). Returns undefined if it can't disambiguate. */
export function pickLmAssistConnector(servers: ConnectorRef[]): ConnectorRef | undefined {
  const connected = servers.filter((s) => s.connected);
  const byName = connected.find((s) => /langmart|lm-assist/i.test(`${s.url} ${s.name}`));
  if (byName) return byName;
  return connected.length === 1 ? connected[0] : undefined;
}
