/**
 * MCP Access Control (authorization) — owned by lm-assist, not the gateway.
 *
 * The gateway/hub authenticates the caller and ROUTES the MCP request to this
 * node. THIS module decides what that caller is allowed to do. Source of truth
 * is a local JSON config at `~/.lm-assist/mcp-access.json`, editable via the
 * REST API (`/mcp/access*`) and the "MCP" settings tab.
 *
 * A caller is identified by a `subject` carried on the relayed request (the
 * connector's clientId, the langmart user email, or an issued MCP token id —
 * whichever the gateway forwards). Each subject is granted a set of scopes
 * (`read` | `write` | `admin`); unknown subjects get `defaultScopes`.
 *
 * Tool → required-scope comes from the canonical `TOOL_SCOPES` map in
 * configure.ts, so there is one source of truth for that.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TOOL_SCOPES, requiredScope, type ToolScope } from './configure';

export interface McpGrant {
  /** Stable id for this grant row (for edit/delete from the UI). */
  id: string;
  /** Match by connector clientId (preferred — stable per connector). */
  clientId?: string;
  /** Or match by langmart user email. */
  email?: string;
  /** Or match by langmart userId. */
  userId?: string;
  /** Granted scopes. */
  scopes: ToolScope[];
  /** Free-text note shown in the UI. */
  note?: string;
  /** ISO timestamp of last change. */
  updatedAt: string;
}

export interface McpAccessConfig {
  version: number;
  /** Scopes for any caller with no matching grant. New connectors are read-only. */
  defaultScopes: ToolScope[];
  grants: McpGrant[];
}

/** The subject of an incoming MCP request, as forwarded by the gateway. */
export interface McpSubject {
  clientId?: string;
  email?: string;
  userId?: string;
}

// Dev/prod separation: the dev-repo instance (no LM_ASSIST_PROD) keeps its own
// access config so dev grants never leak into prod and vice-versa — mirrors the
// `-dev` suffix the hub config uses (hub-dev.json, machine-id-dev).
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const ACCESS_DIR = path.join(os.homedir(), '.lm-assist');
const ACCESS_FILE = path.join(ACCESS_DIR, `mcp-access${DEV_SUFFIX}.json`);

const DEFAULT_CONFIG: McpAccessConfig = {
  version: 1,
  defaultScopes: ['read'],
  grants: [],
};

// ─── load / save ────────────────────────────────────────────────

let cache: { cfg: McpAccessConfig; mtimeMs: number } | null = null;

/** Read the access config, creating the default file on first use. */
export function loadAccessConfig(): McpAccessConfig {
  try {
    const stat = fs.statSync(ACCESS_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.cfg;
    const raw = fs.readFileSync(ACCESS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as McpAccessConfig;
    const cfg = normalize(parsed);
    cache = { cfg, mtimeMs: stat.mtimeMs };
    return cfg;
  } catch {
    // Missing or unreadable — write + return the default.
    saveAccessConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

/** Persist the access config atomically and refresh the cache. */
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

function normalize(cfg: Partial<McpAccessConfig> | null | undefined): McpAccessConfig {
  const c = cfg || {};
  const validScopes = (s: unknown): ToolScope[] =>
    Array.isArray(s) ? (s.filter((x) => x === 'read' || x === 'write' || x === 'admin') as ToolScope[]) : [];
  return {
    version: typeof c.version === 'number' ? c.version : 1,
    defaultScopes: validScopes(c.defaultScopes).length ? validScopes(c.defaultScopes) : ['read'],
    grants: Array.isArray(c.grants)
      ? c.grants.map((g) => ({
          id: String(g.id || ''),
          clientId: g.clientId ? String(g.clientId) : undefined,
          email: g.email ? String(g.email) : undefined,
          userId: g.userId ? String(g.userId) : undefined,
          scopes: validScopes(g.scopes),
          note: g.note ? String(g.note) : undefined,
          updatedAt: String(g.updatedAt || ''),
        }))
      : [],
  };
}

// ─── resolve + evaluate ─────────────────────────────────────────

/** True if grant `g` matches subject `s` (clientId first, then email, then userId). */
function grantMatches(g: McpGrant, s: McpSubject): boolean {
  if (g.clientId && s.clientId && g.clientId === s.clientId) return true;
  if (g.email && s.email && g.email.toLowerCase() === s.email.toLowerCase()) return true;
  if (g.userId && s.userId && g.userId === s.userId) return true;
  return false;
}

/** The scopes granted to a subject — the union of all matching grants, else defaultScopes. */
export function resolveScopes(subject: McpSubject): ToolScope[] {
  const cfg = loadAccessConfig();
  const matched = cfg.grants.filter((g) => grantMatches(g, subject));
  if (matched.length === 0) return [...cfg.defaultScopes];
  const set = new Set<ToolScope>();
  for (const g of matched) for (const sc of g.scopes) set.add(sc);
  return [...set];
}

export type AccessDecision = 'allow' | 'deny' | 'pending';

export interface AccessResult {
  decision: AccessDecision;
  required: ToolScope;
  granted: ToolScope[];
}

/**
 * Decide whether `subject` may call `tool`. read/write that the subject holds
 * → allow. admin that the subject holds → pending (out-of-band confirm). Not
 * held → deny.
 */
export function evaluateAccess(subject: McpSubject, tool: string): AccessResult {
  const required = requiredScope(tool);
  const granted = resolveScopes(subject);
  if (!granted.includes(required)) return { decision: 'deny', required, granted };
  if (required === 'admin') return { decision: 'pending', required, granted };
  return { decision: 'allow', required, granted };
}

// ─── grant management (used by the API + UI) ────────────────────

function genId(): string {
  // Time-free, collision-resistant enough for a small hand-managed list.
  return 'g_' + Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(safeRandom() * 36)]).join('');
}

// Math.random is unavailable in workflow scripts but fine here (server runtime).
function safeRandom(): number {
  return Math.random();
}

/** Add or update a grant (matched by id, or by the same clientId/email/userId). Returns the saved grant. */
export function upsertGrant(input: Omit<McpGrant, 'id' | 'updatedAt'> & { id?: string }, nowIso: string): McpGrant {
  const cfg = loadAccessConfig();
  const subjectKey = (g: { clientId?: string; email?: string; userId?: string }) =>
    `${g.clientId || ''}|${(g.email || '').toLowerCase()}|${g.userId || ''}`;
  let row = input.id ? cfg.grants.find((g) => g.id === input.id) : undefined;
  if (!row) row = cfg.grants.find((g) => subjectKey(g) === subjectKey(input) && subjectKey(input) !== '||');
  if (row) {
    row.clientId = input.clientId;
    row.email = input.email;
    row.userId = input.userId;
    row.scopes = input.scopes;
    row.note = input.note;
    row.updatedAt = nowIso;
  } else {
    row = {
      id: input.id || genId(),
      clientId: input.clientId,
      email: input.email,
      userId: input.userId,
      scopes: input.scopes,
      note: input.note,
      updatedAt: nowIso,
    };
    cfg.grants.push(row);
  }
  saveAccessConfig(cfg);
  return row;
}

/** Remove a grant by id. Returns true if one was removed. */
export function removeGrant(id: string): boolean {
  const cfg = loadAccessConfig();
  const before = cfg.grants.length;
  cfg.grants = cfg.grants.filter((g) => g.id !== id);
  if (cfg.grants.length === before) return false;
  saveAccessConfig(cfg);
  return true;
}

/** Replace defaultScopes. */
export function setDefaultScopes(scopes: ToolScope[], _nowIso: string): McpAccessConfig {
  const cfg = loadAccessConfig();
  cfg.defaultScopes = scopes;
  saveAccessConfig(cfg);
  return cfg;
}

/** The tool→scope catalog, for the UI to render. */
export function toolCatalog(): Array<{ tool: string; scope: ToolScope }> {
  return Object.entries(TOOL_SCOPES).map(([tool, scope]) => ({ tool, scope }));
}

export { ACCESS_FILE };
