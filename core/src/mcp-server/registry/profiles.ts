/**
 * MCP tool loading PROFILES — how many tools this node advertises.
 *
 * WHY: `tools/list` is a fixed tax every conversation pays before calling anything.
 * This node advertises 288 built-in tools ≈ 307 KB ≈ 77 K tokens, and a coding session
 * never touches most of it. A profile names a subset, so a session can pay for what it
 * will actually use. `basic` is ~42 tools ≈ 47 KB ≈ 12 K tokens — about 65 K tokens back.
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
 *
 * That file is the NODE DEFAULT. A request may also carry a PIN — `/mcp?profile=basic`
 * over HTTP, `LM_MCP_PROFILE` for a stdio server — so several connectors can each hold
 * their own profile against one node (spec: docs/superpowers/specs/
 * 2026-09-23-mcp-profile-connectors-design.md). resolveEffectiveProfile() turns a pin into
 * the profile actually applied. A pin is request-scoped: it is NEVER written to the file
 * or to the cache below — one connector's pin must not leak into another's surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, isDevRepo } from '../../utils/path-utils';
import { PROTECTED_TOOLS } from './model';
import { categoryOf, CATEGORY_ORDER } from './categories';

/** A selector names a group of tools. Three forms, checked in this order:
 *   - an exact tool name            → that one tool          (`list_nodes`)
 *   - `ext__<plugin>`               → every tool of a plugin (`ext__langmart`), including
 *                                     the names it shipped under before (PLUGIN_SUPERSEDES)
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
 * The shipped profiles. A CODE CONSTANT: nothing loads definitions from data, so adding
 * or editing one is a code change and a release (operator-editable profiles are out of
 * scope — spec 2026-09-23 §13). The NAMES are a contract — connector URLs
 * (`/mcp/<profile>`) and stdio entries carry them — so a renamed profile keeps its old
 * name as an alias in PROFILE_ALIASES instead of breaking a URL someone already holds.
 */
export const PROFILE_DEFINITIONS: Record<string, ProfileDefinition> = {
  basic: {
    description:
      'Orientation and the node\'s own data: search, sessions, memory, backlog. ~42 tools. ' +
      'The smallest surface that can still find things and tell you where they live.',
    // `list_nodes` is pulled in BY NAME even though its category (fleet) is not here.
    // Every tool carries a `node` selector whose description tells the caller to "check
    // list_nodes before concluding absent" — advertising that advice while hiding the
    // tool it names would make it unfollowable.
    selectors: ['core', 'session', 'memory', 'backlog', 'list_nodes'],
  },
  // Was `langmart` until 2026-09-23. Renamed because the connector is ALREADY named
  // after the hub ("lm-assist langmart"), so a profile connector would have read
  // "lm-assist langmart langmart". The old name still resolves (PROFILE_ALIASES).
  platform: {
    description:
      'basic + the LangMart platform plugin (models, providers, usage, quotas, billing). ' +
      'For working on the platform itself rather than on this fleet.',
    selectors: ['core', 'session', 'memory', 'backlog', 'list_nodes', 'ext__langmart'],
  },
  extended: {
    description:
      'basic + the working surface: missions, agents, terminals, CCR, data, fleet, ' +
      'transfer, clusters, auth, GitHub. ~168 tools. Everything except the connectors.',
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

/** Old name → current name. Honoured everywhere a profile NAME is accepted — a pin, the
 *  node-default file, `mcp_profile set`, `POST /mcp-tools/profile` — and never reported
 *  back: what a client is told is always the canonical name. */
export const PROFILE_ALIASES: Record<string, string> = { langmart: 'platform' };

// ── resolution (pure) ──────────────────────────────────────────────────────────

const EXT_PREFIX = 'ext__';

/**
 * Bundled-plugin renames: a plugin → the names it has SHIPPED under before. An
 * `ext__<plugin>` selector also takes the tools of every name listed here.
 *
 * WHY: the predecessor does not always go away. Since 985e53b it is retired only once the
 * successor's saved state is enabled, so a node whose grants cannot be derived, or whose
 * tree was installed by hand, keeps `langmart-design` on indefinitely. Peers still on
 * 0.2.4 also keep advertising `ext__langmart-design__*` into this node's tools/list
 * through the fleet fan-out. Matching only the new name would leave `platform` — and its
 * per-profile connector — with none of the LangMart tools on such a node or fleet.
 *
 * Kept in step with SUPERSEDES in core/scripts/gen-bundled-plugins.js and the
 * `supersedes` field it writes into core/data/mcp-plugins/bundled.json. Entries are
 * permanent, like theirs: a peer on an old release can still be advertising the old name.
 */
const PLUGIN_SUPERSEDES: Record<string, string[]> = {
  langmart: ['langmart-design'],
};

/** True when `name` is advertised under `selector`. */
function matches(selector: Selector, name: string): boolean {
  if (selector === name) return true;
  if (selector.startsWith(EXT_PREFIX)) {
    // Exact plugin SEGMENT, never a bare prefix: `ext__langmart` must not take
    // `ext__langmart-admin__*`.
    const plugin = selector.slice(EXT_PREFIX.length);
    const aliases = Object.hasOwn(PLUGIN_SUPERSEDES, plugin) ? PLUGIN_SUPERSEDES[plugin] : [];
    return [plugin, ...aliases].some((p) => name.startsWith(`${EXT_PREFIX}${p}__`));
  }
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

/** The canonical name for `name` — itself, or what its alias points at — or undefined
 *  when it names no profile. Own-key lookups on BOTH maps: a bare
 *  `PROFILE_DEFINITIONS[name]` accepted "constructor" / "__proto__" / "toString"
 *  (Object.prototype keys are truthy), and because that value has no `selectors`, the
 *  tools/list filter then threw — a persistent, node-wide outage of the whole MCP
 *  surface from one POST. Found in review. */
export function canonicalProfileName(name: string): string | undefined {
  if (typeof name !== 'string') return undefined;
  const target = Object.hasOwn(PROFILE_ALIASES, name) ? PROFILE_ALIASES[name] : name;
  return Object.hasOwn(PROFILE_DEFINITIONS, target) ? target : undefined;
}

/** The definition for a profile name or alias; undefined for anything else. */
export function getProfile(name: string): ProfileDefinition | undefined {
  const canonical = canonicalProfileName(name);
  return canonical ? PROFILE_DEFINITIONS[canonical] : undefined;
}

/** Filter advertised defs down to the profile. Unknown profile ⇒ unfiltered (fail open:
 *  a bad name must never blank the tool surface). */
export function applyProfileToToolDefs<T extends { name: string }>(defs: T[], profileName: string): T[] {
  const profile = getProfile(profileName);
  // Fail OPEN on anything malformed: this runs inside tools/list, and a throw here
  // blanks the tool surface for every client of the node.
  if (!profile || profile.selectors === 'all' || !Array.isArray(profile.selectors)) return defs;
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
    // Canonicalised: a file written before a rename (`"langmart"`) still selects its
    // profile, and callers comparing names (`name === active`) see the current one.
    const canonical = raw && typeof raw.profile === 'string' ? canonicalProfileName(raw.profile) : undefined;
    if (canonical) value = canonical;
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
  const canonical = canonicalProfileName(name);
  if (!canonical) {
    throw new Error(
      `unknown profile "${name}". Known profiles: ${Object.keys(PROFILE_DEFINITIONS).join(', ')}.`
    );
  }
  // An alias is stored as the name it points at, so the file never holds a retired name.
  const state: ProfileState = { profile: canonical, setAt: Date.now(), setBy };
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cached = { at: Date.now(), value: canonical };
  return state;
}

/** Drop the memoised read — for tests and for an immediate post-write re-read. */
export function _resetProfileCacheForTests(): void {
  cached = null;
}

// ── pins (request-scoped) ──────────────────────────────────────────────────────

/** Header a stdio MCP server uses to forward its pin to Core on `/mcp-call`. */
export const PROFILE_PIN_HEADER = 'x-lm-mcp-profile';
/** Env var that pins a stdio server (`claude mcp add … -e LM_MCP_PROFILE=basic`). */
export const PROFILE_PIN_ENV = 'LM_MCP_PROFILE';

/** The profile a request is actually served, and why. */
export interface EffectiveProfile {
  /** Canonical name of the profile applied. Never an alias. */
  name: string;
  /** 'pin' only when a pin was present AND known; everything else is the node default. */
  source: 'pin' | 'node-default';
  /** The pin as received (trimmed) — present even when unknown, so it can be named back.
   *  Bounded to printable ASCII, ≤64 chars: it is echoed into instructions, footers, logs. */
  pin?: string;
  /** A pin was present but names no profile — the node default was served instead. */
  unknownPin?: boolean;
}

const PIN_SYNTAX = /^[a-z][a-z0-9-]{0,31}$/;
/** Names a pin can never take: the hub serves `/mcp/connectors` under the same router. */
const RESERVED_PINS = new Set(['connectors']);

/** Grammar only — says nothing about whether the profile exists. */
export function isValidPinSyntax(s: string): boolean {
  return typeof s === 'string' && PIN_SYNTAX.test(s) && !RESERVED_PINS.has(s);
}

function boundedPinEcho(pin: string): string {
  return pin.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
}

/**
 * The profile a request with this pin is served. Pure apart from activeProfileName()'s
 * cached read, so it is safe on the tools/list and initialize hot paths.
 *
 *   - known pin (or an alias)   ⇒ that profile, source 'pin'
 *   - unknown / malformed pin   ⇒ FAIL OPEN to the node default, flagged `unknownPin` so
 *                                 every surface can say so: a typo, or a newer profile
 *                                 name reaching an older node, must never blank the tool
 *                                 surface and must never look like it worked
 *   - no pin                    ⇒ the node default — exactly the behaviour before pins
 */
export function resolveEffectiveProfile(pin: string | undefined | null): EffectiveProfile {
  const raw = typeof pin === 'string' ? pin.trim() : '';
  if (!raw) return { name: activeProfileName(), source: 'node-default' };
  const canonical = isValidPinSyntax(raw) ? canonicalProfileName(raw) : undefined;
  if (canonical) return { name: canonical, source: 'pin', pin: raw };
  return { name: activeProfileName(), source: 'node-default', pin: boundedPinEcho(raw), unknownPin: true };
}

/**
 * A resolution made earlier, brought up to date. A PIN is fixed for the life of its
 * connector; a node-default resolution must follow `mcp_profile set` — a stdio server
 * resolves once at spawn and then lives for hours. Absent ⇒ a fresh resolution.
 */
export function liveEffectiveProfile(p: EffectiveProfile | undefined | null): EffectiveProfile {
  if (!p) return resolveEffectiveProfile(undefined);
  return p.source === 'pin' ? p : { ...p, name: activeProfileName() };
}

/** True when the profile advertises LESS than everything. False for `all` and for names
 *  that resolve to nothing (those serve the full surface — fail open). */
export function isNarrowedProfile(name: string): boolean {
  const p = getProfile(name);
  return !!p && Array.isArray(p.selectors);
}

/** Can this profile advertise any `ext__` plugin tool? When not, tools/list skips the
 *  fleet plugin fan-out (up to 5 s) whose every result would be filtered out anyway.
 *  Unknown ⇒ true: fail open, like the filter itself. */
export function profileNeedsExtTools(name: string): boolean {
  const p = getProfile(name);
  if (!p || !Array.isArray(p.selectors)) return true;
  return p.selectors.some((s) => s.startsWith(EXT_PREFIX));
}
