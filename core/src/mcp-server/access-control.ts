/**
 * MCP admin-approval gate — owned by lm-assist, per-user, this node.
 *
 * This MCP connection IS the user's own — there is no other principal, so there
 * is nothing to authorize between accounts (no grants, no "everyone", no deny).
 * The ONLY control here is an OPTIONAL extra confirmation gate the user can turn
 * on PER TOOL:
 *
 *   - ungated tool (the default for every tool) → runs normally; whatever
 *     per-tool approval claude.ai applies is outside our control.
 *   - gated tool → the call does NOT execute. It parks a pending action and the
 *     user releases it out-of-band (the MCP settings tab / POST
 *     /mcp/pending/:id/confirm). The model can park a pending but cannot reach
 *     the confirm endpoint, so it can never release its own gated action.
 *
 * Source of truth: `~/.lm-assist/mcp-access.json`. Default = no tool gated.
 *
 * NOTE: the tool→scope map (`TOOL_SCOPES` in configure.ts, served at
 * /mcp/tool-scopes) is a SEPARATE concern — the upstream langmart gateway uses
 * it for Bearer-key gating. It is unrelated to this per-user gate, kept here
 * only as a sensitivity hint for the settings UI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TOOL_SCOPES, LM_ASSIST_TOOL_DEFS, type ToolScope } from './configure';

export interface McpAccessConfig {
  version: number;
  /**
   * Tool names that require the extra out-of-band admin confirm. Every tool not
   * in this list runs normally. Default is empty (no tool gated).
   */
  adminGatedTools: string[];
}

// Dev/prod separation: the dev-repo instance (no LM_ASSIST_PROD) keeps its own
// config so dev settings never leak into prod and vice-versa — mirrors the
// `-dev` suffix the hub config uses (hub-dev.json, machine-id-dev).
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const ACCESS_DIR = path.join(os.homedir(), '.lm-assist');
const ACCESS_FILE = path.join(ACCESS_DIR, `mcp-access${DEV_SUFFIX}.json`);

const DEFAULT_CONFIG: McpAccessConfig = {
  version: 2,
  adminGatedTools: [],
};

// ─── load / save ────────────────────────────────────────────────

let cache: { cfg: McpAccessConfig; mtimeMs: number } | null = null;

/** Read the config, creating the default file on first use. */
export function loadAccessConfig(): McpAccessConfig {
  try {
    const stat = fs.statSync(ACCESS_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.cfg;
    const raw = fs.readFileSync(ACCESS_FILE, 'utf-8');
    const cfg = normalize(JSON.parse(raw));
    cache = { cfg, mtimeMs: stat.mtimeMs };
    return cfg;
  } catch {
    // Missing or unreadable — write + return the default.
    saveAccessConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

/** Persist the config atomically and refresh the cache. */
export function saveAccessConfig(cfg: McpAccessConfig): void {
  const normalized = normalize(cfg);
  fs.mkdirSync(ACCESS_DIR, { recursive: true });
  const tmp = `${ACCESS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf-8');
  fs.renameSync(tmp, ACCESS_FILE);
  try {
    cache = { cfg: normalized, mtimeMs: fs.statSync(ACCESS_FILE).mtimeMs };
  } catch {
    cache = null;
  }
}

/**
 * Coerce any prior/partial config into the current shape. Migrates legacy files
 * (which carried grants / defaultScopes / autoApproveAdmin) by simply dropping
 * those fields — only `adminGatedTools` survives, filtered to known tools.
 */
function normalize(cfg: Partial<McpAccessConfig> | null | undefined): McpAccessConfig {
  const c = (cfg || {}) as Record<string, unknown>;
  const known = new Set(Object.keys(TOOL_SCOPES));
  const gated = Array.isArray(c.adminGatedTools)
    ? [...new Set(c.adminGatedTools.filter((t): t is string => typeof t === 'string' && known.has(t)))]
    : [];
  return {
    version: typeof c.version === 'number' ? c.version : 2,
    adminGatedTools: gated,
  };
}

// ─── evaluate ───────────────────────────────────────────────────

export type AccessDecision = 'allow' | 'pending';

export interface AccessResult {
  decision: AccessDecision;
}

/** True if the tool currently has the extra admin-confirm gate switched on. */
export function isToolGated(tool: string): boolean {
  return loadAccessConfig().adminGatedTools.includes(tool);
}

/**
 * Decide whether `tool` runs now or parks for confirm. Gated → pending;
 * everything else → allow. There is no deny — this MCP is the user's own.
 */
export function evaluateAccess(tool: string): AccessResult {
  return { decision: isToolGated(tool) ? 'pending' : 'allow' };
}

// ─── gate management (used by the API + UI) ─────────────────────

/** Turn the extra admin-confirm gate on/off for a single tool. Unknown tools are ignored. */
export function setToolGate(tool: string, enabled: boolean): McpAccessConfig {
  const cfg = loadAccessConfig();
  if (!(tool in TOOL_SCOPES)) return cfg;
  const set = new Set(cfg.adminGatedTools);
  if (enabled) set.add(tool);
  else set.delete(tool);
  cfg.adminGatedTools = [...set];
  saveAccessConfig(cfg);
  return cfg;
}

/**
 * The full tool catalog for the settings UI: every tool, its sensitivity scope
 * (hint), and whether the extra admin gate is currently on.
 */
export function toolCatalog(): Array<{ tool: string; scope: ToolScope; adminGate: boolean; description: string }> {
  const gated = new Set(loadAccessConfig().adminGatedTools);
  // Join the actual MCP tool description (what ListTools advertises) so the
  // settings UI can show it on hover.
  const desc = new Map(LM_ASSIST_TOOL_DEFS.map((t) => [t.name, String(t.description || '')] as const));
  return Object.entries(TOOL_SCOPES).map(([tool, scope]) => ({ tool, scope, adminGate: gated.has(tool), description: desc.get(tool) || '' }));
}

export { ACCESS_FILE };
