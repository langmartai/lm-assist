/**
 * claude.ai web-session access
 *
 * Reads a user-supplied claude.ai session config (`~/.claude/claudeai-session.json`)
 * and uses it to make read-only requests against the claude.ai web backend
 * (`/api/organizations/{org_uuid}/...`) — the API the browser uses for the
 * chat sidebar, conversation view, and projects.
 *
 * Why a config file rather than auto-extracting from Chrome / Claude Desktop:
 *   - Chrome stores cookies in an encrypted SQLite DB (DPAPI on Windows,
 *     libsecret on Linux, Keychain on macOS) — decryption is fragile and
 *     platform-specific.
 *   - cf_clearance / __cf_bm rotate every ~30 min and are tied to the source
 *     IP — auto-extraction wouldn't keep them fresh anyway.
 *   - The user already has to paste cookies somewhere when they first set this
 *     up; a config file makes that explicit and inspectable.
 *
 * Header fingerprint matches a real claude.ai web request observed via
 * lm-proxy: same cookie set, same Chrome UA, same anthropic-client-* values,
 * same Sec-Fetch-* triplet, Referer set per operation. x-datadog-* and
 * traceparent are intentionally omitted — they're random per-request and
 * easier to forge wrongly than to skip.
 *
 * TLS-fingerprint caveat: Node's fetch (undici) has a different JA3/JA4 from
 * Chrome. Cloudflare can detect this. For low-frequency reads on a fresh
 * cf_clearance, the request goes through; for tight polling or after
 * cf_clearance expires, expect 403 / interstitial responses.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SESSION_PATH = path.join(os.homedir(), '.claude', 'claudeai-session.json');

// Observed in real claude.ai web traffic on 2026-05-14 (lm-proxy capture).
// Update periodically if claude.ai bumps these.
const DEFAULTS = {
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  anthropicClientPlatform: 'web_claude_ai',
  anthropicClientVersion: '1.0.0',
  anthropicClientSha: '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
  secChUa:
    '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  secChUaMobile: '?0',
  secChUaPlatform: '"Linux"',
};

export interface ClaudeAISessionConfig {
  /** Full Cookie: header value as sent by the browser. Required. */
  cookie: string;
  /** Override Chrome UA. Defaults to observed Linux Chrome 146. */
  userAgent?: string;
  /** Pinned org_uuid. If absent, derived from `lastActiveOrg` cookie. */
  orgUuid?: string;
  /** Override anthropic-client-* values. */
  anthropicClientPlatform?: string;
  anthropicClientVersion?: string;
  anthropicClientSha?: string;
  /** Override Sec-Ch-Ua triplet (for Mac / Windows / mobile fingerprints). */
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
}

export interface ClaudeAIIdentity {
  orgUuid?: string;
  deviceId?: string;
  anonymousId?: string;
  activitySessionId?: string;
  userId?: string;
}

export function readClaudeAISession(): ClaudeAISessionConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(SESSION_PATH, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.cookie !== 'string' || !parsed.cookie) return null;
    return parsed as ClaudeAISessionConfig;
  } catch {
    return null;
  }
}

/** Parse the Cookie header into a name → value map. */
export function parseCookieString(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of cookie.split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Pull out identity values the browser sends as headers. claude.ai stores
 * these as cookies too, so we can mirror the browser without extra config.
 */
export function deriveIdentity(cfg: ClaudeAISessionConfig): ClaudeAIIdentity {
  const cookies = parseCookieString(cfg.cookie);
  return {
    orgUuid: cfg.orgUuid || cookies['lastActiveOrg'],
    deviceId: cookies['anthropic-device-id'],
    anonymousId: cookies['ajs_anonymous_id'],
    activitySessionId: cookies['activitySessionId'],
    userId: cookies['ajs_user_id'],
  };
}

export interface ClaudeAISessionStatus {
  present: boolean;
  sessionPath: string;
  /** Whether a sessionKey cookie is actually present in the cookie string. */
  hasSessionKey?: boolean;
  /** Whether a fresh-looking cf_clearance is present. */
  hasCfClearance?: boolean;
  /** Whether __cf_bm (~30 min lifetime) is present. */
  hasCfBm?: boolean;
  identity?: ClaudeAIIdentity;
  cookieNames?: string[];
}

export function getClaudeAISessionStatus(): ClaudeAISessionStatus {
  const cfg = readClaudeAISession();
  if (!cfg) return { present: false, sessionPath: SESSION_PATH };
  const cookies = parseCookieString(cfg.cookie);
  return {
    present: true,
    sessionPath: SESSION_PATH,
    hasSessionKey: typeof cookies['sessionKey'] === 'string' && cookies['sessionKey'].startsWith('sk-ant-sid'),
    hasCfClearance: typeof cookies['cf_clearance'] === 'string' && cookies['cf_clearance'].length > 0,
    hasCfBm: typeof cookies['__cf_bm'] === 'string' && cookies['__cf_bm'].length > 0,
    identity: deriveIdentity(cfg),
    cookieNames: Object.keys(cookies).sort(),
  };
}

export interface ClaudeAIGetOpts {
  /** Override Referer (e.g. https://claude.ai/chat/{conv_uuid}). Default https://claude.ai/. */
  referer?: string;
  /** Override timeout. Default 15s. */
  timeoutMs?: number;
  /** Sec-Fetch-Dest. Defaults to 'empty' (XHR/fetch). */
  secFetchDest?: 'empty' | 'document';
}

export interface ClaudeAIResponse<T = any> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
}

/**
 * Make a GET request to claude.ai using the configured session. Sends the
 * full header set a real Chrome session would send. Throws if no session
 * config is present.
 */
export async function claudeaiGet<T = any>(
  pathname: string,
  opts: ClaudeAIGetOpts = {},
): Promise<ClaudeAIResponse<T>> {
  const cfg = readClaudeAISession();
  if (!cfg) {
    throw new Error(
      `No claude.ai session at ${SESSION_PATH}. Create the file with at minimum {"cookie": "<paste browser Cookie header>"}.`,
    );
  }

  const url = `https://claude.ai${pathname}`;
  const id = deriveIdentity(cfg);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const referer = opts.referer ?? 'https://claude.ai/';
  const secFetchDest = opts.secFetchDest ?? 'empty';

  // Header order/values mirror the captured browser fingerprint. We only
  // include identity headers when we actually have the value — sending
  // empty strings would itself be a tell.
  const headers: Record<string, string> = {
    Host: 'claude.ai',
    Connection: 'keep-alive',
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  headers['sec-ch-ua-platform'] = cfg.secChUaPlatform || DEFAULTS.secChUaPlatform;
  headers['sec-ch-ua'] = cfg.secChUa || DEFAULTS.secChUa;
  headers['sec-ch-ua-mobile'] = cfg.secChUaMobile || DEFAULTS.secChUaMobile;
  headers['anthropic-client-sha'] = cfg.anthropicClientSha || DEFAULTS.anthropicClientSha;
  headers['content-type'] = 'application/json';
  headers['anthropic-client-platform'] = cfg.anthropicClientPlatform || DEFAULTS.anthropicClientPlatform;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;
  headers['anthropic-client-version'] = cfg.anthropicClientVersion || DEFAULTS.anthropicClientVersion;
  headers['User-Agent'] = cfg.userAgent || DEFAULTS.userAgent;
  headers['Accept'] = '*/*';
  headers['Sec-Fetch-Site'] = 'same-origin';
  headers['Sec-Fetch-Mode'] = 'cors';
  headers['Sec-Fetch-Dest'] = secFetchDest;
  headers['Referer'] = referer;
  // Real Chrome 146 sends "gzip, deflate, br, zstd" — but Node's fetch can't
  // decode zstd responses. Drop it (the resulting value still matches older
  // Chrome / Edge fingerprints, and is server-side a non-load-bearing hint).
  headers['Accept-Encoding'] = 'gzip, deflate, br';
  headers['Accept-Language'] = 'en-US,en;q=0.9';
  headers['Cookie'] = cfg.cookie;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, statusText: res.statusText, headers: respHeaders, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/organizations/{org_uuid}/chat_conversations_v2 — list conversations.
 *
 * Defaults match the web app's first call (limit=30, starred=false,
 * consistency=eventual). Caller can override individual params or add others
 * (e.g. project_uuid) via `extraQuery`.
 */
export async function listConversations(opts: {
  orgUuid?: string;
  limit?: number;
  starred?: boolean;
  consistency?: 'eventual' | 'strong';
  extraQuery?: Record<string, string | number | boolean>;
} = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid (set "orgUuid" in config or ensure lastActiveOrg cookie is present)');

  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 30));
  params.set('starred', String(opts.starred ?? false));
  params.set('consistency', opts.consistency ?? 'eventual');
  if (opts.extraQuery) {
    for (const [k, v] of Object.entries(opts.extraQuery)) params.set(k, String(v));
  }
  return claudeaiGet(
    `/api/organizations/${orgUuid}/chat_conversations_v2?${params}`,
    { referer: 'https://claude.ai/' },
  );
}

/**
 * GET /api/organizations/{org_uuid}/chat_conversations/{conv_uuid} — read a
 * single conversation with full message tree. Defaults match the web app's
 * call when opening a chat.
 */
export async function readConversation(convUuid: string, opts: {
  orgUuid?: string;
  tree?: boolean;
  renderingMode?: 'messages' | string;
  renderAllTools?: boolean;
} = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(convUuid)) {
    throw new Error(`Invalid conversation UUID: ${convUuid}`);
  }

  const params = new URLSearchParams();
  // Web app sends capital-T 'True' — we mirror that.
  params.set('tree', opts.tree === false ? 'False' : 'True');
  params.set('rendering_mode', opts.renderingMode ?? 'messages');
  params.set('render_all_tools', String(opts.renderAllTools ?? true));
  return claudeaiGet(
    `/api/organizations/${orgUuid}/chat_conversations/${convUuid}?${params}`,
    { referer: `https://claude.ai/chat/${convUuid}` },
  );
}

/** GET /api/organizations/{org_uuid}/projects — list projects. */
export async function listProjects(opts: {
  orgUuid?: string;
  includeHarmonyProjects?: boolean;
  limit?: number;
  creatorFilter?: 'is_creator' | 'is_not_creator';
} = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');

  const params = new URLSearchParams();
  params.set('include_harmony_projects', String(opts.includeHarmonyProjects ?? true));
  params.set('limit', String(opts.limit ?? 200));
  if (opts.creatorFilter) params.set('creator_filter', opts.creatorFilter);
  return claudeaiGet(
    `/api/organizations/${orgUuid}/projects?${params}`,
    { referer: 'https://claude.ai/new' },
  );
}
