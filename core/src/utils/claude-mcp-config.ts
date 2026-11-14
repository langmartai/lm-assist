/**
 * Register the LangMart hub MCP server into a Claude Code config so an enrolled
 * node's Claude Code sessions get the worker-role / orchestration tools
 * (set_role, report_status, worker_status, decide_gate, list_workers, bootstrap,
 * guide, ...) at session startup.
 *
 * Why this works (the "keystone"): the public hub MCP endpoint
 * `https://mcp.<domain>/mcp` accepts the node's long-term `sk-langassist`
 * enrollment key as a plain `Authorization: Bearer` token (verified), and it is
 * always-up — so unlike `http://localhost:3100/mcp` (the node's own Core, which
 * only comes up mid-first-turn), there is NO startup-ordering problem. A Claude
 * Code session configured with this http MCP server loads the full tool surface
 * immediately.
 *
 * These helpers are pure (no fs / no I/O) so the CLI can read-modify-write
 * `~/.claude.json` around them and they stay unit-testable.
 */

import {
  PROFILE_ALIASES,
  PROFILE_DEFINITIONS,
  PROFILE_PIN_ENV,
  canonicalProfileName,
  isValidPinSyntax,
} from '../mcp-server/registry/profiles';

export const HUB_MCP_SERVER_NAME = 'lm-assist-hub';

export interface HubHttpMcpServer {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

/**
 * Derive the public MCP HTTP endpoint from the hub's WebSocket URL.
 *   wss://assist-api.langmart.ai      -> https://mcp.langmart.ai/mcp
 *   wss://assist-api.xeenhub.com      -> https://mcp.xeenhub.com/mcp
 *   wss://assist-api.langmart.ai/ws   -> https://mcp.langmart.ai/mcp  (host only)
 * Returns null when `hubUrl` is missing/garbage or is not an `assist-api.<domain>`
 * host (e.g. already an `mcp.` host, or an unrelated origin).
 */
export function deriveHubMcpUrl(hubUrl: string | undefined | null): string | null {
  if (!hubUrl || typeof hubUrl !== 'string') return null;
  let host: string;
  try {
    host = new URL(hubUrl).hostname;
  } catch {
    return null;
  }
  const m = host.match(/^assist-api\.(.+)$/);
  if (!m) return null;
  return `https://mcp.${m[1]}/mcp`;
}

/**
 * Return a NEW Claude Code config object with the hub MCP server upserted under
 * the top-level `mcpServers` (user scope). All other config and any other MCP
 * servers are preserved; the input is not mutated. Re-running replaces only our
 * named entry (idempotent — safe to call on every `lm-assist login`).
 */
export function upsertHubMcpServer(
  config: Record<string, unknown> | null | undefined,
  opts: { url: string; key: string; name?: string },
): Record<string, unknown> {
  const name = opts.name || HUB_MCP_SERVER_NAME;
  const base: Record<string, unknown> =
    config && typeof config === 'object' ? config : {};
  const existingServers: Record<string, unknown> =
    base.mcpServers && typeof base.mcpServers === 'object'
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  const entry: HubHttpMcpServer = {
    type: 'http',
    url: opts.url,
    headers: { Authorization: `Bearer ${opts.key}` },
  };
  return {
    ...base,
    mcpServers: { ...existingServers, [name]: entry },
  };
}

// ── per-profile entries (`lm-assist mcp add --profile <p>`) ─────────────────────
//
// One Claude Code entry per tool loading profile, named `lm-assist-<profile>`:
//   HTTP  → https://mcp.<domain>/mcp/<profile> with the SAME node Bearer key the hub entry uses;
//   stdio → the SAME `node <core/dist/mcp-server/index.js>` the Settings install writes, plus
//           env LM_MCP_PROFILE=<profile>.
// 🔴 `lm-assist-hub` is never written, renamed or re-pinned here: the mission controller and its
// playbooks call mcp__lm-assist-hub__* and need the full surface (mission + worker categories).
// Every enabled entry loads its own tool list, so a pinned entry NEXT TO the hub entry costs more
// context than either alone — the CLI says so on every add.

export { PROFILE_PIN_ENV };

export const PROFILE_MCP_SERVER_PREFIX = 'lm-assist-';

/** Names a profile entry may never take. `lm-assist-context` is the stdio install's legacy
 *  name, which the Settings install deletes on sight — a profile entry there would vanish. */
const RESERVED_ENTRY_NAMES: ReadonlySet<string> = new Set([HUB_MCP_SERVER_NAME, 'lm-assist-context']);

export interface StdioMcpServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type ProfileMcpServerEntry = HubHttpMcpServer | StdioMcpServer;

export type ProfileEntryTarget =
  | { transport: 'http'; hubMcpUrl: string; key: string }
  | { transport: 'stdio'; command: string; args: string[] };

export interface ProfileEntryResult {
  config: Record<string, unknown>;
  name: string;
  /** Canonical (alias-resolved) profile name. */
  profile: string;
  entry: ProfileMcpServerEntry;
}

export function knownProfilesHint(): string {
  const aliases = Object.entries(PROFILE_ALIASES).map(([alias, canonical]) => `${alias} → ${canonical}`);
  return `known profiles: ${Object.keys(PROFILE_DEFINITIONS).join(', ')}`
    + (aliases.length ? ` (alias: ${aliases.join(', ')})` : '');
}

/** What `lm-assist mcp add` says with no --profile: the unpinned entries already exist. */
export function profileRequiredMessage(): string {
  return '--profile <name> is required — ' + knownProfilesHint() + '. The UNPINNED entries already exist and are '
    + "not managed by this command: '" + HUB_MCP_SERVER_NAME + "' (HTTP, written by lm-assist login) and "
    + "'lm-assist' (stdio, Settings → Claude Code → MCP Server).";
}

/** The canonical profile for an entry, or an error naming the known ones. Case-insensitive on
 *  input because it comes from a command line; the result is always the canonical name. */
export function resolveEntryProfile(raw: string | undefined | null): { profile: string } | { error: string } {
  const typed = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!typed) return { error: `a profile name is required — ${knownProfilesHint()}` };
  const profile = canonicalProfileName(typed);
  if (!profile) return { error: `unknown profile "${String(raw).trim()}" — ${knownProfilesHint()}` };
  return { profile };
}

export function profileMcpServerName(profile: string): string {
  return `${PROFILE_MCP_SERVER_PREFIX}${profile}`;
}

/** `https://mcp.<domain>/mcp` (what deriveHubMcpUrl returns) + profile → `…/mcp/<profile>`.
 *  Core mints the same URL with connectorUrlFor (profile-connectors.ts); the test pins the two
 *  together. Kept here so the CLI's require stays free of connectors.ts / auth. */
export function profileMcpUrl(hubMcpUrl: string, profile: string): string {
  return `${hubMcpUrl.replace(/\/+$/, '')}/${profile}`;
}

function serversOf(config: Record<string, unknown> | null | undefined): {
  base: Record<string, unknown>;
  servers: Record<string, unknown>;
} {
  const base: Record<string, unknown> = config && typeof config === 'object' ? config : {};
  const servers: Record<string, unknown> =
    base.mcpServers && typeof base.mcpServers === 'object' ? (base.mcpServers as Record<string, unknown>) : {};
  return { base, servers };
}

/** Return a NEW config with `lm-assist-<profile>` upserted under top-level `mcpServers`. Throws
 *  on an unknown profile or a missing transport input — nothing is half-written. */
export function upsertProfileMcpServer(
  config: Record<string, unknown> | null | undefined,
  opts: { profile: string } & ProfileEntryTarget,
): ProfileEntryResult {
  const resolved = resolveEntryProfile(opts.profile);
  if ('error' in resolved) throw new Error(resolved.error);
  const { profile } = resolved;
  const name = profileMcpServerName(profile);
  if (RESERVED_ENTRY_NAMES.has(name)) throw new Error(`refusing to write "${name}" — that name is not a profile entry`);
  let entry: ProfileMcpServerEntry;
  if (opts.transport === 'http') {
    if (!opts.hubMcpUrl) throw new Error('no hub MCP URL — this node is not enrolled with a hub');
    if (!opts.key) throw new Error('no node key — this node is not enrolled with a hub');
    entry = {
      type: 'http',
      url: profileMcpUrl(opts.hubMcpUrl, profile),
      headers: { Authorization: `Bearer ${opts.key}` },
    };
  } else {
    if (!opts.command) throw new Error('no command for the stdio MCP server');
    entry = { type: 'stdio', command: opts.command, args: [...opts.args], env: { [PROFILE_PIN_ENV]: profile } };
  }
  const { base, servers } = serversOf(config);
  return { config: { ...base, mcpServers: { ...servers, [name]: entry } }, name, profile, entry };
}

/** Return a config without `lm-assist-<profile>`. A known name resolves through the alias table;
 *  a well-formed unknown one is still removable (a later build may drop a profile). Never
 *  removes lm-assist-hub or the legacy stdio name. Does not mutate the input. */
export function removeProfileMcpServer(
  config: Record<string, unknown> | null | undefined,
  profileArg: string,
): { config: Record<string, unknown>; name: string; removed: boolean } {
  const typed = typeof profileArg === 'string' ? profileArg.trim().toLowerCase() : '';
  const profile = canonicalProfileName(typed) ?? (isValidPinSyntax(typed) ? typed : undefined);
  if (!profile) throw new Error(`not a profile name: "${profileArg}" — ${knownProfilesHint()}`);
  const name = profileMcpServerName(profile);
  if (RESERVED_ENTRY_NAMES.has(name)) {
    throw new Error(`refusing to remove "${name}" — it is not a profile entry (lm-assist login owns ${HUB_MCP_SERVER_NAME})`);
  }
  const { base, servers } = serversOf(config);
  if (!Object.hasOwn(servers, name)) return { config: base, name, removed: false };
  const rest: Record<string, unknown> = { ...servers };
  delete rest[name];
  return { config: { ...base, mcpServers: rest }, name, removed: true };
}

// ── CLI argument parsing (pure, so the bin stays thin and this stays testable) ──

export type McpCliArgs = { action: 'add' | 'remove'; profile: string | undefined; stdio: boolean };

const MCP_USAGE = 'usage: lm-assist mcp add --profile <name> [--stdio]  |  lm-assist mcp remove --profile <name>';

export function parseMcpCliArgs(argv: string[]): McpCliArgs | { error: string } {
  const [action, ...rest] = argv;
  if (action !== 'add' && action !== 'remove') return { error: MCP_USAGE };
  let profile: string | undefined;
  let stdio = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--stdio') { stdio = true; continue; }
    if (a === '--profile' || a.startsWith('--profile=')) {
      const v = a === '--profile' ? rest[++i] : a.slice('--profile='.length);
      if (!v || v.startsWith('--')) return { error: `--profile needs a name. ${MCP_USAGE}` };
      profile = v;
      continue;
    }
    return { error: `unknown option "${a}". ${MCP_USAGE}` };
  }
  if (action === 'remove' && stdio) {
    return { error: '--stdio means nothing to remove: the entry is lm-assist-<profile> whichever transport wrote it.' };
  }
  return { action, profile, stdio };
}

/** `--flag value` or `--flag=value`. `present` without `value` = the flag was given bare. */
export function readFlagValue(argv: string[], flag: string): { present: boolean; value?: string } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const v = argv[i + 1];
      return v && !v.startsWith('--') ? { present: true, value: v } : { present: true };
    }
    if (a.startsWith(`${flag}=`)) {
      const v = a.slice(flag.length + 1);
      return v ? { present: true, value: v } : { present: true };
    }
  }
  return { present: false };
}
