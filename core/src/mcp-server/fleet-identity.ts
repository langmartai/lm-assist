// Dynamic "which fleet does THIS connector serve" identity, surfaced to the LLM
// so multi-connector accounts don't cross-route node-targeted calls. No hardcoded names —
// the hub URL is derived at runtime from getHubConfig().
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster } from '../cluster/cluster-config';

export interface FleetIdentityParts {
  hubHost: string | null;
  hostname: string;
  gatewayId: string | null;
  cluster: string;
}

/** Normalize a hub URL (wss://host/path) to its bare host, or null. */
export function hubHostOf(hubUrl: string | undefined | null): string | null {
  if (!hubUrl) return null;
  try {
    const u = new URL(hubUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
    return u.host || null;
  } catch {
    const bare = hubUrl.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
    return bare || null;
  }
}

/** PURE — build the fleet-identity instruction block from resolved parts. */
export function formatFleetIdentity(p: FleetIdentityParts): string {
  const hub = p.hubHost ?? '(no hub configured — local-only)';
  const gw = p.gatewayId ? `${p.gatewayId.slice(0, 12)}…` : '?';
  return [
    'FLEET / CONNECTOR IDENTITY — this lm-assist MCP connector serves ONE fleet:',
    `  hub: ${hub}   ·   this node: ${p.hostname} (${gw}) · cluster: ${p.cluster}`,
    "  Reachable nodes = THIS connector's `list_nodes` only.",
    '  If you have OTHER lm-assist MCP connectors, EACH serves a DIFFERENT fleet (a different hub):',
    "  their nodes are NOT in this connector's `list_nodes`, and hostnames can COLLIDE across fleets.",
    '  A node-targeted call routes to THIS fleet. Before a node-scoped WRITE, confirm the target appears',
    "  in this `list_nodes`; a BAD_NODE error = the node isn't in this fleet → you're on the wrong connector for it.",
  ].join('\n');
}

/** Resolve the fleet identity from lm-assist's own runtime config. NEVER throws. */
export function fleetIdentity(): string {
  let parts: FleetIdentityParts = { hubHost: null, hostname: 'this node', gatewayId: null, cluster: 'default' };
  try {
    const cfg = getHubConfig();
    parts = { hubHost: hubHostOf(cfg.hubUrl), hostname: cfg.hostname || 'this node', gatewayId: cfg.gatewayId, cluster: 'default' };
  } catch { /* config unavailable — minimal block */ }
  try { parts.cluster = getMyCluster(); } catch { /* default */ }
  return formatFleetIdentity(parts);
}
