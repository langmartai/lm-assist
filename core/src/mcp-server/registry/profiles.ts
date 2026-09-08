/**
 * MCP tool loading PROFILES — how many tools this node advertises.
 *
 * WHY: `tools/list` is a fixed tax every conversation pays before calling anything.
 * This node advertises 286 built-in tools ≈ 300 KB ≈ 75 K tokens, and a coding session
 * never touches most of it. A profile names a subset, so a session can pay for what it
 * will actually use. `basic` is ~41 tools ≈ 12 K tokens — about 63 K tokens back.
 *
 * It is also an ACCURACY feature, not only a cost one: tool-choice degrades once a
 * model is carrying more than roughly 30–50 tools, so a narrower surface picks better.
 *
 * 🔴 ADVERTISE-ONLY. A profile changes what `tools/list` RETURNS. It does NOT reject
 * calls, and a hidden tool stays callable. That is deliberate on two counts: this is a
 * context-budget feature, not a security boundary (TOOL_SCOPES and the admin gate are,
 * and they are untouched), and leaving hidden tools callable is what lets a client that
 * already knows a name keep working across a profile change. Same stance the overlay
 * takes: "a management layer, not a security boundary".
 *
 * PRECEDENCE: the overlay wins. A tool an operator switched off stays off in every
 * profile — the profile can only narrow further, never re-enable.
 *
 * STATE IS NODE-LOCAL, deliberately. The tool-registry overlay is a fleet-synced,
 * ORIGIN-anchored dataset whose writes proxy to the origin node and fail CLOSED when it
 * is unreachable. That is right for a shared management decision and wrong for this: a
 * node must always be able to change its own context budget, including when it is the
 * only thing up. So the active profile lives in a plain file beside the node's other
 * local config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, isDevRepo } from '../../utils/path-utils';
import { PROTECTED_TOOLS } from './model';
import { categoryOf, CATEGORY_ORDER } from './categories';

/** A selector names a group of tools. Three forms, checked in this order:
 *   - an exact tool name            → that one tool          (`list_nodes`)
 *   - `ext__<plugin>`               → every tool of a plugin (`ext__langmart`)
 *   - a category from CATEGORY_ORDER → every tool in it      (`memory`)
 */
export type Selector = string;

export interface ProfileDefinition {
  /** One line, shown by `mcp_profile` and the status route. */
  description: string;
  /** Selectors this profile advertises. Empty means "everything" (see `admin`). */
  selectors: Selector[] | 'all';
}

/**
 * The shipped profiles. DATA, not behaviour — an operator can add or edit one without
 * touching code, and the names are stable so a client can ask for one by name.
 */
export const PROFILE_DEFINITIONS: Record<string, ProfileDefinition> = {
  basic: {
    description:
      'Orientation and the node\'s own data: search, sessions, memory, backlog. ~41 tools. ' +
      'The smallest surface that can still find things and tell you where they live.',
    // `list_nodes` is pulled in BY NAME even though its category (fleet) is not here.
    // Every tool carries a `node` selector whose description tells the caller to "check
    // list_nodes before concluding absent" — advertising that advice while hiding the
    // tool it names would make it unfollowable.
    selectors: ['core', 'session', 'memory', 'backlog', 'list_nodes'],
  },
  langmart: {
    description:
      'basic + the LangMart platform plugin (models, providers, usage, quotas, billing). ' +
      'For working on the platform itself rather than on this fleet.',
    selectors: ['core', 'session', 'memory', 'backlog', 'list_nodes', 'ext__langmart'],
  },
  extended: {
    description:
      'basic + the working surface: missions, agents, terminals, CCR, data, fleet, ' +
      'transfer, clusters, auth, GitHub. ~167 tools. Everything except the connectors.',
    selectors: [
      'core', 'session', 'memory', 'backlog', 'list_nodes',
      'mission', 'agent', 'worker', 'terminal', 'data', 'fleet', 'cluster',
      'ccr', 'transfer', 'auth', 'github', 'machine-access',
    ],
  },
  admin: {
    description: 'Everything this node can do, including every connector and plugin. The default.',
    selectors: 'all',
  },
};

/** What a node advertises when nothing has been chosen — today\'s behaviour, unchanged. */
export const DEFAULT_PROFILE = 'admin';

// ── resolution (pure) ──────────────────────────────────────────────────────────

const EXT_PREFIX = 'ext__';

/** True when `name` is advertised under `selector`. */
function matches(selector: Selector, name: string): boolean {
  if (selector === name) return true;
  if (selector.startsWith(EXT_PREFIX)) return name.startsWith(`${selector}__`);
  return categoryOf(name) === selector;
}

/**
 * The tool names a profile advertises, out of the ones on offer.
 *
 * PROTECTED_TOOLS are always included. They are the door back: without `bootstrap`,
 * `guide` and the profile tool itself, a session that switched to `basic` would have no
 * way to discover what it lost or to switch out again.
 */
export function resolveProfileTools(profile: ProfileDefinition, available: string[]): Set<string> {
  if (profile.selectors === 'all') return new Set(available);
  const out = new Set<string>();
  for (const name of available) {
    if (PROTECTED_TOOLS.has(name)) { out.add(name); continue; }
    if (profile.selectors.some((s) => matches(s, name))) out.add(name);
  }
  return out;
}

/** Filter advertised defs down to the profile. Unknown profile ⇒ unfiltered (fail open:
 *  a bad name must never blank the tool surface). */
export function applyProfileToToolDefs<T extends { name: string }>(defs: T[], profileName: string): T[] {
  const profile = PROFILE_DEFINITIONS[profileName];
  if (!profile || profile.selectors === 'all') return defs;
  const keep = resolveProfileTools(profile, defs.map((d) => d.name));
  return defs.filter((d) => keep.has(d.name));
}

/** Selectors that name nothing on this node — a typo, or a plugin that is not installed. */
export function unmatchedSelectors(profile: ProfileDefinition, available: string[]): Selector[] {
  if (profile.selectors === 'all') return [];
  return profile.selectors.filter((s) => !available.some((n) => matches(s, n)));
}

/** Every legal selector on this node, for error messages and the management UI. */
export function knownSelectors(available: string[]): { categories: string[]; plugins: string[] } {
  const plugins = new Set<string>();
  for (const n of available) {
    if (!n.startsWith(EXT_PREFIX)) continue;
    const seg = n.slice(EXT_PREFIX.length).split('__')[0];
    if (seg) plugins.add(`${EXT_PREFIX}${seg}`);
  }
  return { categories: [...CATEGORY_ORDER], plugins: [...plugins].sort() };
}

// ── active profile (node-local state) ──────────────────────────────────────────

interface ProfileState { profile: string; setAt?: number; setBy?: string }

function stateFile(): string {
  return path.join(getDataDir(), `mcp-profile${isDevRepo() ? '-dev' : ''}.json`);
}

/** Cached so the tools/list hot path never touches the disk per request.
 *  docs/mcp-surfaces.md forbids adding cost to this path — a resolver regression there
 *  measured 9,359 ms warm. Same 1.5 s TTL the overlay's live provider uses. */
let cached: { at: number; value: string } | null = null;
const TTL_MS = 1500;

export function activeProfileName(): string {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value = DEFAULT_PROFILE;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) as ProfileState;
    if (raw && typeof raw.profile === 'string' && PROFILE_DEFINITIONS[raw.profile]) value = raw.profile;
  } catch {
    // absent or unreadable ⇒ the default. Never throw on the tools/list path.
  }
  cached = { at: now, value };
  return value;
}

export function readProfileState(): ProfileState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) as ProfileState;
  } catch {
    return { profile: DEFAULT_PROFILE };
  }
}

/** Set the active profile. Returns the state written. Throws on an unknown name —
 *  silently keeping the old profile would look like the call had worked. */
export function setActiveProfile(name: string, setBy?: string): ProfileState {
  if (!PROFILE_DEFINITIONS[name]) {
    throw new Error(
      `unknown profile "${name}". Known profiles: ${Object.keys(PROFILE_DEFINITIONS).join(', ')}.`
    );
  }
  const state: ProfileState = { profile: name, setAt: Date.now(), setBy };
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cached = { at: Date.now(), value: name };
  return state;
}

/** Drop the memoised read — for tests and for an immediate post-write re-read. */
export function _resetProfileCacheForTests(): void {
  cached = null;
}
