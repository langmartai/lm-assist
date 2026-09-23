/**
 * One vocabulary for "which profile am I on, and where do the others live" — shared by the
 * `mcp_profile` tool and GET/POST /mcp-tools/profile
 * (docs/superpowers/specs/2026-09-23-mcp-profile-connectors-design.md §6, §7.2).
 *
 * A PIN belongs to the connector (its URL …/mcp/<profile>, or LM_MCP_PROFILE for stdio); the
 * node DEFAULT belongs to the node (a file). Writes only ever touch the default — a pin is never
 * written anywhere. Reads never touch the network: the connector URLs are derived from this
 * node's public MCP base, and whether claude.ai actually holds a connector for each profile is
 * `mcp_connectors {action:"list"}` / GET /mcp/profile-connectors, which make that call.
 * After a write, the refresh of the UNPINNED claude.ai connectors is profile-connectors.ts's
 * onNodeDefaultProfileChanged: fire-and-forget, never throws, never real under node --test.
 */
import {
  PROFILE_DEFINITIONS, activeProfileName, canonicalProfileName, getProfile, readProfileState,
  resolveEffectiveProfile, resolveProfileTools, setActiveProfile, type EffectiveProfile,
} from './profiles';
import { bumpToolsRev } from './tools-rev';
import { connectorUrlFor, mcpBase, onNodeDefaultProfileChanged } from '../profile-connectors';
import { quotePin, safePin } from '../fleet-identity';

/** What `mcp_profile get` says instead of reading claude.ai: a protected, always-listed tool
 *  must not make a ~30 s claude.ai call. Bounded and constant. Served as-is only where the
 *  caller's profile lists `mcp_connectors` — see connectorsHintFor. */
export const CONNECTORS_HINT =
  'For claude.ai connector status per profile, call mcp_connectors {action:"list"}.';

/** The connector-management tool the hint and the pinned note name. It is in category
 *  `claudeai`, which only `admin` lists, and it is deliberately NOT protected (an admin-scoped
 *  write of the user's claude.ai account). */
const CONNECTORS_TOOL = 'mcp_connectors';

/** Does this profile's tools/list carry `name`? Unknown profile ⇒ true (it is served the full
 *  surface — fail open, as the filter does). Pure: the category map is a code constant. */
function profileLists(profileName: string, name: string): boolean {
  const def = getProfile(profileName);
  return !def || resolveProfileTools(def, [name]).has(name);
}

/** Where `mcp_connectors` IS listed, for a caller whose profile does not list it. claude.ai and
 *  Claude Code only let the model call listed tools, so advice naming a hidden tool must say
 *  where to call it (profiles.ts refuses the same pattern for list_nodes). Under a pin, the
 *  unpinned connector follows the node default — so it lists the tool only if that default does;
 *  otherwise only an `admin`-pinned connector does. The REST route needs no connector at all. */
function connectorsToolWhere(caller: EffectiveProfile): string {
  const unpinnedLists = caller.source === 'pin' && profileLists(activeProfileName(), CONNECTORS_TOOL);
  const where = unpinnedLists
    ? 'the unpinned or `admin` lm-assist connector on this hub'
    : 'an `admin`-pinned lm-assist connector on this hub (URL …/mcp/admin)';
  return `${where}, or GET /mcp/profile-connectors on the node (the MCP Tools page)`;
}

/** The hint `mcp_profile` returns. Unchanged where the caller's profile lists `mcp_connectors`
 *  (`admin`, the shipped default); otherwise it says this profile does not list it and where it
 *  is listed. Bounded: one of three fixed sentences. */
export function connectorsHintFor(caller?: EffectiveProfile): string {
  const eff = caller ?? resolveEffectiveProfile(undefined);
  if (profileLists(eff.name, CONNECTORS_TOOL)) return CONNECTORS_HINT;
  return (
    `For claude.ai connector status per profile, call mcp_connectors {action:"list"} — profile ` +
    `"${eff.name}" does not list it, so use ${connectorsToolWhere(eff)}.`
  );
}

export interface ProfileReport {
  /** The profile THIS caller is served. */
  effective: string;
  source: EffectiveProfile['source'];
  /** The pin the request carried — sanitised, since it is request data — or null. */
  pin: string | null;
  /** Present only when a pin was carried but names no profile on this node. */
  unknownPin?: true;
  /** What UNPINNED clients get: the node-default file (default `admin`). */
  nodeDefault: string;
  /** When the node default was last written; null = never (the shipped default). */
  setAt: number | null;
  /** This fleet's public connector URL per profile, plus the unpinned one. Null when this node
   *  has no hub — there is then no public MCP URL to give. */
  connectors: { unpinned: string; byProfile: Record<string, string> } | null;
}

export interface NodeDefaultChange {
  state: ReturnType<typeof setActiveProfile>;
  report: ProfileReport;
  /** The loud part: on a pinned caller it says THIS connector did not change. */
  note: string;
}

function publicBase(): string | null {
  try { return mcpBase() || null; } catch { return null; }
}

/** The caller's view. `caller` is the request's EffectiveProfile (from the MCP context);
 *  absent (REST, or no context) ⇒ the node default. */
export function profileReport(caller?: EffectiveProfile): ProfileReport {
  const eff = caller ?? resolveEffectiveProfile(undefined);
  const base = publicBase();
  return {
    effective: eff.name,
    source: eff.source,
    pin: safePin(eff.pin),
    ...(eff.unknownPin ? { unknownPin: true as const } : {}),
    nodeDefault: activeProfileName(),
    setAt: readProfileState().setAt ?? null,
    connectors: base
      ? {
          unpinned: connectorUrlFor(null, base),
          byProfile: Object.fromEntries(
            Object.keys(PROFILE_DEFINITIONS).map((n) => [n, connectorUrlFor(n, base)]),
          ),
        }
      : null,
  };
}

function pinnedNote(caller: EffectiveProfile, requested: string, r: ProfileReport): string {
  const pinnedTo = caller.name;
  // mcp_connectors is only callable where it is listed: say where when this connector hides it.
  const create = `mcp_connectors {action:"create", profile:"${requested}"}`;
  const how = profileLists(pinnedTo, CONNECTORS_TOOL) ? create : `${create} on ${connectorsToolWhere(caller)}`;
  const where = r.connectors
    ? `use ${r.connectors.byProfile[requested]} (in claude.ai: ${how})`
    : `pin a client to it: …/mcp?profile=${requested} on a Core, or LM_MCP_PROFILE=${requested} for stdio`;
  return (
    `THIS CONNECTOR DID NOT CHANGE — it is pinned to profile "${pinnedTo}" by its URL and keeps advertising it. ` +
    `You changed the NODE DEFAULT to "${requested}", which only UNPINNED clients use. ` +
    `For a connector that advertises "${requested}", ${where}.`
  );
}

function unpinnedNote(requested: string, caller?: EffectiveProfile): string {
  const lead = caller?.unknownPin
    ? `This connector's pin ${quotePin(caller.pin)} is not a profile on this node, so it follows the node default and DOES change. `
    : '';
  return (
    lead +
    `Node default is now "${requested}" — unpinned clients only. Claude Code (stdio) picks it up within ~30s; ` +
    `unpinned claude.ai connectors on this hub are refreshed in the background (this node needs a claude.ai ` +
    `session — otherwise run refresh_connector_tools). Pinned connectors (…/mcp/<profile>) are unaffected.`
  );
}

/**
 * Set the NODE DEFAULT. The one write path for `mcp_profile set` and POST /mcp-tools/profile.
 * Throws on an unknown name (setActiveProfile's own message) — silently keeping the old
 * default would look like the call had worked.
 */
export function setNodeDefaultProfile(requested: string, setBy: string, caller?: EffectiveProfile): NodeDefaultChange {
  // `langmart` → `platform`. An unknown name passes through unchanged so setActiveProfile
  // throws its own message naming the known profiles.
  const name = canonicalProfileName(requested) ?? requested;
  const state = setActiveProfile(name, setBy);
  // Same staleness stamp the overlay uses, so the stdio MCP processes' watcher emits
  // notifications/tools/list_changed. A pinned stdio client gets a harmless re-fetch.
  bumpToolsRev();
  // claude.ai caches tools/list per connector, and the UNPINNED connectors follow the node
  // default: refresh them (spec §7.2). Fire-and-forget and never throws, so a claude.ai failure
  // can neither undo nor delay the write that already happened. Pinned connectors are untouched.
  onNodeDefaultProfileChanged(setBy);
  const pinned = caller?.source === 'pin';
  // An unpinned caller's effective profile IS the node default, which just moved — re-resolve.
  // A pinned caller keeps its pin; that is the whole point of the note.
  const after = pinned && caller ? caller : resolveEffectiveProfile(caller?.pin);
  const report = profileReport(after);
  return {
    state,
    report,
    note: pinned && caller ? pinnedNote(caller, name, report) : unpinnedNote(name, caller),
  };
}
