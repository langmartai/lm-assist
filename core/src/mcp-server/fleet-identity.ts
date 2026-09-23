// Dynamic "which fleet does THIS connector serve" identity, surfaced to the LLM
// so multi-connector accounts don't cross-route node-targeted calls. No hardcoded names —
// the hub URL is derived at runtime from getHubConfig().
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster } from '../cluster/cluster-config';
import { isNarrowedProfile, isValidPinSyntax, type EffectiveProfile } from './registry/profiles';

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

// ── the connector's PROFILE (spec 2026-09-23 §3, §6) ─────────────────────────────
//
// One place decides WHETHER a text names the profile and HOW, so the instructions banner,
// session_status's identity block and profile field, and the result footer can never disagree.

/**
 * Does this connector's identity text name its profile? Yes for a pin (known or unknown) and
 * for a narrowed node default. NO for the shipped case — no pin, node default `admin` — whose
 * text must stay byte-identical to the pre-profile text (the compatibility contract).
 */
export function shouldNameProfile(p?: EffectiveProfile | null): p is EffectiveProfile {
  return !!p && (p.source === 'pin' || p.unknownPin === true || isNarrowedProfile(p.name));
}

const NOT_A_PROFILE_NAME = '(not a legal profile name)';

/** A pin as DATA. It arrives from a URL query or an env var, so anything that is not a legal
 *  profile name is REPLACED — never echoed into text a model reads. */
export function safePin(pin: string | undefined | null): string | null {
  if (pin == null) return null;
  return isValidPinSyntax(pin) ? pin : NOT_A_PROFILE_NAME;
}

/** A pin for PROSE: quoted when legal, the fixed replacement otherwise. */
export function quotePin(pin: string | undefined | null): string {
  return pin != null && isValidPinSyntax(pin) ? `"${pin}"` : NOT_A_PROFILE_NAME;
}

/** PURE — how a profile is named in prose:
 *    pin           → `profile basic`
 *    node default  → `profile basic [node default]`
 *    unknown pin   → `profile admin [unknown pin "basci" → node default]` */
export function profilePhrase(p: EffectiveProfile): string {
  if (p.unknownPin) return `profile ${p.name} [unknown pin ${quotePin(p.pin)} → node default]`;
  if (p.source === 'pin') return `profile ${p.name}`;
  return `profile ${p.name} [node default]`;
}

/** Said only when the profile is named: two connectors on ONE hub are ONE fleet, so the
 *  hub-axis "fall back to the other" advice must not be read as covering them. */
const PROFILE_AXIS_LINES = [
  '  PROFILE ≠ FLEET: another lm-assist connector on the SAME hub with a different profile (URL …/mcp/<profile>, or',
  '  the unpinned …/mcp) reaches the SAME nodes and state with a different tool list. It is NOT a failover — an error',
  "  here recurs there; switch to it only for a tool this profile does not list (mcp_profile lists each profile's URL).",
];

/** PURE — build the fleet-identity instruction block from resolved parts. `profile` is the
 *  EFFECTIVE profile of the call; omitted, or no pin + node default `admin` ⇒ the block is
 *  byte-identical to the pre-profile one (snapshotted in mcp-profile-identity-text.test.ts). */
export function formatFleetIdentity(p: FleetIdentityParts, profile?: EffectiveProfile | null): string {
  const hub = p.hubHost ?? '(no hub configured — local-only)';
  const gw = p.gatewayId ? `${p.gatewayId.slice(0, 12)}…` : '?';
  const env = envLabelOf(p.hubHost, p.hostname);
  const named = shouldNameProfile(profile) ? ` · ${profilePhrase(profile)}` : '';
  return [
    `FLEET / CONNECTOR IDENTITY — this lm-assist MCP connector is the ${env} connector${named} (serves ONE fleet):`,
    `  environment: ${env}   ·   hub: ${hub}   ·   this node: ${p.hostname} (${gw}) · cluster: ${p.cluster}`,
    "  Reachable nodes = THIS connector's `list_nodes` only.",
    '  You may have BOTH a PRODUCTION connector (hub *.langmart.ai) and a DEVELOPMENT connector (hub *.xeenhub.com)',
    '  attached at once. They expose the SAME tool names but are INDEPENDENT instances over DIFFERENT fleets —',
    '  they do NOT share nodes or state, and hostnames can COLLIDE across them. Choose by intent: PRODUCTION for the',
    "  user's real hosts/data/actions; DEVELOPMENT only to test lm-assist itself. Because they're independent, if one",
    '  connector is unavailable or a tool ERRORS on it, the OTHER still works — fall back to it rather than giving up.',
    ...(named ? PROFILE_AXIS_LINES : []),
    '  A node-targeted call routes to THIS fleet. Before a node-scoped WRITE, confirm the target appears',
    "  in this `list_nodes`; a BAD_NODE error = the node isn't in this fleet → you're on the wrong connector for it.",
  ].join('\n');
}

/** Resolve the fleet identity from lm-assist's own runtime config. NEVER throws.
 *  `profile` is passed EXPLICITLY and never read from the request context here:
 *   - session_status passes its effective profile;
 *   - bootstrap's identity block (guide.ts) deliberately passes none — it stays profile-unaware
 *     (spec §6; the closing "hidden by this profile" line carries the profile there);
 *   - the mission controller's system prompt (mission-controller.ts) is not MCP text at all, and
 *     a caller's pin must not leak into it. */
export function fleetIdentity(profile?: EffectiveProfile | null): string {
  let parts: FleetIdentityParts = { hubHost: null, hostname: 'this node', gatewayId: null, cluster: 'default' };
  try {
    const cfg = getHubConfig();
    parts = { hubHost: hubHostOf(cfg.hubUrl), hostname: cfg.hostname || 'this node', gatewayId: cfg.gatewayId, cluster: 'default' };
  } catch { /* config unavailable — minimal block */ }
  try { parts.cluster = getMyCluster(); } catch { /* default */ }
  return formatFleetIdentity(parts, profile);
}
