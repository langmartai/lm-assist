// core/src/mcp-server/connector-tools-array.ts
// Build the claude.ai SPA-shaped `tools[]` array that POST /completion needs in order to expose a
// connector's tools to the model on a turn (each entry: {name, description, integration_name,
// mcp_server_uuid, mcp_server_url, input_schema}). Without it the model sees NO connector tools
// (the bare `claudeai_completion` sends `tools:[]`). We build it from the worker's OWN tool defs
// (authoritative for name/description/schema) + the discovered connector identity. Pure → testable.

import { mcpBase, ourConnectors, preferredConnector } from './profile-connectors';
import { canonicalProfileName } from './registry/profiles';

export interface ConnectorRef { uuid: string; url: string; name: string; connected?: boolean; tools?: string[] }
export interface ToolDef { name: string; description?: string; inputSchema?: unknown }
export interface SpaTool {
  name: string; description: string; integration_name: string;
  mcp_server_uuid: string; mcp_server_url: string;
  needs_approval: boolean; backend_execution: boolean; is_mcp_app: boolean;
  input_schema: unknown;
}

/** Map worker tool defs → claude.ai SPA tool entries for one connector. `names` (if given) restricts
 *  the set; otherwise the connector's own advertised tool list is used; otherwise all defs.
 *  CRITICAL: each entry MUST carry `backend_execution: true` + `needs_approval: false` + `is_mcp_app:
 *  false` — without them claude.ai doesn't know to route the call to the connector and the driven
 *  tool's `/tool_approval` 404s ("Tool result could not be submitted"). (Verified 2026-06-21: adding
 *  these flipped data_catalog from 404 → 200 + real result. See the pure-script-mcp-e2e memory.) */
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
      needs_approval: false,
      backend_execution: true,
      is_mcp_app: false,
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
}

/** A pinned profile by its canonical name (an alias → its profile; an unknown pin stays as-is). */
const canonPin = (p: string | null): string | null => (p === null ? null : canonicalProfileName(p) ?? p);

/** Pick the connected lm-assist connector for a driven turn, by URL: THIS node's connectors only
 *  (so a dev Core never drives the production connector), preferring the unpinned one, else
 *  `admin`, else the widest — never bootstrap order. `profile` asks for the connector pinned to
 *  that profile (null = the unpinned one; an alias such as `langmart` means its canonical
 *  profile) and returns undefined when there is none, rather than a silently different surface.
 *  A node with no hub configured has no notion of "ours" and keeps the old name heuristic.
 *  `base` defaults to this node's public MCP base (reads the hub config). */
export function pickLmAssistConnector(
  servers: ConnectorRef[],
  opts: { profile?: string | null; base?: string } = {},
): ConnectorRef | undefined {
  const connected = servers.filter((s) => s.connected);
  const base = opts.base ?? mcpBase();
  if (base) {
    const mine = ourConnectors(connected, base);
    if (opts.profile !== undefined) {
      const want = canonPin(opts.profile);
      return mine.find((c) => canonPin(c.profile) === want);
    }
    return preferredConnector(mine);
  }
  const byName = connected.find((s) => /langmart|lm-assist/i.test(`${s.url} ${s.name}`));
  if (byName) return byName;
  return connected.length === 1 ? connected[0] : undefined;
}
