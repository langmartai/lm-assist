/**
 * `list_nodes` — worker-side fallback.
 *
 * Multi-node selection is resolved at the langmart hub: the hub holds the live
 * registry of every lm-assist worker a user has connected, so it answers
 * `list_nodes` with the full set and routes node-targeted calls to the right
 * worker (see LangMartDesign assist-api `/internal/mcp-relay`).
 *
 * This handler is the fallback for the cases where the call actually reaches a
 * worker's own MCP server:
 *   - stdio transport (Claude Code talking to one local worker), or
 *   - the hub forwarded `list_nodes` instead of answering it (older hub).
 *
 * In those cases the only node this process can speak for is itself, so it
 * returns a single-entry list describing this worker. It self-identifies from
 * the hub config (gatewayId = the node's hostId, plus hostname/platform).
 */

import { ok, type McpToolResult } from './_passthrough';
import { getHubConfig } from '../../hub-client/hub-config';

export function handleListNodes(): McpToolResult {
  const cfg = getHubConfig();
  // gatewayId is the stable hostId the hub routes by; fall back to machineId
  // when this worker has never completed a hub registration (pure stdio use).
  const hostId = cfg.gatewayId || cfg.machineId;
  const node = {
    hostId,
    hostname: cfg.hostname,
    platform: cfg.platform,
    online: true,
    self: true,
  };
  const text = [
    'lm-assist nodes (1):',
    '',
    `- hostId: ${node.hostId}`,
    `  hostname: ${node.hostname}`,
    `  platform: ${node.platform}`,
    `  status: online (this node)`,
    '',
    'Note: this worker can only report itself. When connected through the ' +
      'lm-assist MCP connector, the hub returns every node IN THIS FLEET (this ' +
      "connector's hub) and routes per-tool `node` selectors to the right host. " +
      'Other lm-assist connectors are other fleets — see guide("connectors").',
  ].join('\n');
  return ok(text);
}
