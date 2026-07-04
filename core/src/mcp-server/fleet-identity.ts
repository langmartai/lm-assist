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

export type ConnectorEnv = 'PRODUCTION' | 'DEVELOPMENT' | 'LOCAL';

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

/**
 * PROD vs DEV of a connector, from its hub host + whether this is a dev repo.
 * langmart hub = production fleet; xeenhub hub = development fleet. The `(dev)`
 * hostname suffix (set by getHubConfig when running from a git checkout) is the
 * fallback signal, and no hub at all = LOCAL.
 */
export function envLabelOf(hubHost: string | null, hostname?: string): ConnectorEnv {
  if (/xeenhub/i.test(hubHost || '')) return 'DEVELOPMENT';
  if (/langmart/i.test(hubHost || '')) return 'PRODUCTION';
  if (/\(dev\)/i.test(hostname || '')) return 'DEVELOPMENT';
  if (!hubHost) return 'LOCAL';
  return 'PRODUCTION';
}

/** PURE — build the fleet-identity instruction block from resolved parts. */
export function formatFleetIdentity(p: FleetIdentityParts): string {
  const hub = p.hubHost ?? '(no hub configured — local-only)';
  const gw = p.gatewayId ? `${p.gatewayId.slice(0, 12)}…` : '?';
  const env = envLabelOf(p.hubHost, p.hostname);
  return [
    `FLEET / CONNECTOR IDENTITY — this lm-assist MCP connector is the ${env} connector (serves ONE fleet):`,
    `  environment: ${env}   ·   hub: ${hub}   ·   this node: ${p.hostname} (${gw}) · cluster: ${p.cluster}`,
    "  Reachable nodes = THIS connector's `list_nodes` only.",
    '  You may have BOTH a PRODUCTION connector (hub *.langmart.ai) and a DEVELOPMENT connector (hub *.xeenhub.com)',
    '  attached at once. They expose the SAME tool names but are INDEPENDENT instances over DIFFERENT fleets —',
    '  they do NOT share nodes or state, and hostnames can COLLIDE across them. Choose by intent: PRODUCTION for the',
    "  user's real hosts/data/actions; DEVELOPMENT only to test lm-assist itself. Because they're independent, if one",
    '  connector is unavailable or a tool ERRORS on it, the OTHER still works — fall back to it rather than giving up.',
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
