/**
 * Claude Code OAuth credential access
 *
 * Reads Claude Code's OAuth credentials from `~/.claude/.credentials.json`
 * (the same file Claude Code writes), refreshes the access token when
 * needed, and persists new tokens back via an atomic rename.
 *
 * Refresh logic mirrors Claude Code's own `refreshOAuthToken()` in
 * `services/oauth/client.ts` — POST to `platform.claude.com/v1/oauth/token`
 * with `grant_type=refresh_token` and the same client id and scope set.
 *
 * macOS is not supported in this initial version: Claude Code stores
 * credentials in the Keychain rather than a plain file on Darwin, and
 * reaching into Keychain from a long-running service has different
 * trust/permission characteristics. Linux and Windows use the file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

// Fallback Claude Code version if local detection fails. Update periodically.
// Observed in the wild on 2026-05-09 / 2026-05-14: claude-code/2.1.137.
const FALLBACK_CLAUDE_CODE_VERSION = '2.1.137';

let cachedClaudeCodeVersion: string | null | undefined;

/**
 * Locate the installed `@anthropic-ai/claude-code` package and return its
 * version. Tries the common Windows (nvm4w, %APPDATA%\npm) and Unix
 * (`/usr/lib/node_modules`, `~/.nvm/...`) locations. Result is memoized.
 */
export function detectClaudeCodeVersion(): string {
  if (typeof cachedClaudeCodeVersion === 'string') {
    return cachedClaudeCodeVersion;
  }
  const home = os.homedir();
  const nodeDir = path.dirname(process.execPath);
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(nodeDir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
      process.env.APPDATA
        ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json')
        : '',
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    );
  } else {
    candidates.push(
      '/usr/lib/node_modules/@anthropic-ai/claude-code/package.json',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json',
      path.join(home, '.nvm', 'versions', 'node', '*', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
      path.join(home, '.local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    );
  }
  for (const c of candidates.filter(Boolean)) {
    if (c.includes('*')) continue; // skip glob entries (would need a sync glob; not worth it for one tier)
    try {
      const pkg = JSON.parse(fs.readFileSync(c, 'utf-8'));
      if (typeof pkg.version === 'string' && pkg.version) {
        cachedClaudeCodeVersion = pkg.version;
        return pkg.version;
      }
    } catch { /* not present */ }
  }
  cachedClaudeCodeVersion = FALLBACK_CLAUDE_CODE_VERSION;
  return cachedClaudeCodeVersion;
}

/** Build the exact User-Agent Claude Code sends. */
export function getClaudeCodeUserAgent(): string {
  return `claude-code/${detectClaudeCodeVersion()}`;
}

const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

export interface ClaudeOAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export function isPlatformSupported(): boolean {
  return process.platform !== 'darwin';
}

export function readClaudeOAuth(): ClaudeOAuthCreds | null {
  if (!isPlatformSupported()) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(CREDS_PATH, 'utf-8');
  } catch {
    return null;
  }
  let parsed: CredsFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const c = parsed.claudeAiOauth;
  if (!c || !c.accessToken || !c.refreshToken) return null;
  return {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt ?? 0,
    scopes: c.scopes ?? [],
    subscriptionType: c.subscriptionType,
    rateLimitTier: c.rateLimitTier,
  };
}

export function isTokenExpired(creds: ClaudeOAuthCreds, bufferMs = REFRESH_BUFFER_MS): boolean {
  return Date.now() >= creds.expiresAt - bufferMs;
}

interface TokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  subscription_type?: string;
  rate_limit_tier?: string;
}

async function postTokenRefresh(refreshToken: string): Promise<TokenExchangeResponse> {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: CLAUDE_AI_OAUTH_SCOPES.join(' '),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`token refresh failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as TokenExchangeResponse;
  } finally {
    clearTimeout(timer);
  }
}

function writeCredsAtomic(next: ClaudeOAuthCreds): void {
  let existing: any = {};
  try {
    existing = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
  } catch {
    existing = {};
  }
  existing.claudeAiOauth = {
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
    scopes: next.scopes,
    subscriptionType: next.subscriptionType,
    rateLimitTier: next.rateLimitTier,
  };
  const tmp = `${CREDS_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDS_PATH);
}

export async function getValidAccessToken(): Promise<ClaudeOAuthCreds> {
  if (!isPlatformSupported()) {
    throw new Error('Claude OAuth credentials are stored in Keychain on macOS; not supported.');
  }
  const creds = readClaudeOAuth();
  if (!creds) {
    throw new Error(`No Claude Code OAuth credentials at ${CREDS_PATH}. Run 'claude /login' first.`);
  }
  if (!isTokenExpired(creds)) return creds;

  const data = await postTokenRefresh(creds.refreshToken);
  const refreshed: ClaudeOAuthCreds = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : creds.scopes,
    subscriptionType: data.subscription_type ?? creds.subscriptionType,
    rateLimitTier: data.rate_limit_tier ?? creds.rateLimitTier,
  };
  try {
    writeCredsAtomic(refreshed);
  } catch (err) {
    // Refresh succeeded but persistence failed — return the in-memory creds
    // anyway; next caller will refresh again. Log to stderr so the failure
    // is visible without breaking the request.
    process.stderr.write(`[claude-oauth] persist failed: ${(err as Error).message}\n`);
  }
  return refreshed;
}

export interface OAuthStatus {
  present: boolean;
  platform: NodeJS.Platform;
  storage: 'file' | 'keychain' | 'none';
  credsPath: string | null;
  expired?: boolean;
  expiresAt?: number;
  msUntilExpiry?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export function getOAuthStatus(): OAuthStatus {
  if (!isPlatformSupported()) {
    return { present: false, platform: process.platform, storage: 'keychain', credsPath: null };
  }
  const creds = readClaudeOAuth();
  if (!creds) {
    return { present: false, platform: process.platform, storage: 'file', credsPath: CREDS_PATH };
  }
  return {
    present: true,
    platform: process.platform,
    storage: 'file',
    credsPath: CREDS_PATH,
    expired: isTokenExpired(creds, 0),
    expiresAt: creds.expiresAt,
    msUntilExpiry: creds.expiresAt - Date.now(),
    scopes: creds.scopes,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };
}

/** Shared option bag for the OAuth request helpers. */
export interface AnthropicOAuthRequestOpts {
  timeoutMs?: number;
  userAgent?: string;
  betaHeader?: string | null;
  /** Extra headers to include (e.g. anthropic-version, x-organization-uuid). */
  extraHeaders?: Record<string, string>;
  /** Override query string (already URL-encoded). */
  query?: string;
  /** Skip auth — for public endpoints like /mcp-registry/v0/servers. */
  skipAuth?: boolean;
}

/**
 * Make an authenticated request to api.anthropic.com using the Claude Code
 * OAuth token. Adds Bearer + anthropic-beta + Claude Code user-agent, sends
 * an optional JSON body (POST/PUT), and handles the single-retry-on-401
 * pattern (force refresh, retry once).
 *
 * Header fingerprint matches what Claude Code itself sends on these
 * OAuth endpoints (observed via lm-proxy): same 8 headers, same values,
 * impersonated User-Agent (`claude-code/<detected-version>`). Avoids
 * extra `anthropic-client-*` / `anthropic-version` headers — those
 * appear on other endpoints and adding them here would itself be a tell.
 *
 * Callers should NOT poll these endpoints rapidly. Real Claude Code
 * hits /api/oauth/usage only on the user's /usage command (observed
 * cadence: ~1 call every several days). Recommended minimum polling
 * interval from automated callers: 5 minutes.
 *
 * Retrying a 401/403 after a forced refresh is safe for writes too: an
 * auth-rejected request never reached the upstream mutation, so re-issuing
 * it with a fresh token cannot double-apply the change.
 */
export async function anthropicOAuthRequest(
  method: string,
  pathname: string,
  opts: AnthropicOAuthRequestOpts & {
    /** JSON request body (POST/PUT). Omitted from the wire when undefined. */
    body?: any;
  } = {},
): Promise<{ status: number; statusText: string; body: any; headers: Record<string, string> }> {
  const url = `https://api.anthropic.com${pathname}${opts.query ? (pathname.includes('?') ? '&' : '?') + opts.query : ''}`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ua = opts.userAgent ?? getClaudeCodeUserAgent();
  const betaHeader = opts.betaHeader === null ? null : (opts.betaHeader ?? 'oauth-2025-04-20');
  const hasBody = opts.body !== undefined;

  async function call(token: string) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Header order/values mirror real Claude Code traffic for OAuth
      // endpoints. fetch will set `Host` itself.
      const reqHeaders: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, compress, deflate, br',
        'Content-Type': 'application/json',
        'User-Agent': ua,
        Connection: 'keep-alive',
      };
      if (!opts.skipAuth) reqHeaders.Authorization = `Bearer ${token}`;
      if (betaHeader) reqHeaders['anthropic-beta'] = betaHeader;
      if (opts.extraHeaders) Object.assign(reqHeaders, opts.extraHeaders);
      const res = await fetch(url, {
        method,
        headers: reqHeaders,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        signal: ctrl.signal,
      });
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
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

  // Public endpoints (skipAuth) don't need a token; call with empty.
  if (opts.skipAuth) {
    return await call('');
  }
  const creds = await getValidAccessToken();
  let result = await call(creds.accessToken);
  if (result.status === 401 || result.status === 403) {
    // Force-refresh once: bypass the expiry buffer by reading the original
    // refresh token and calling postTokenRefresh directly, then retry.
    const raw = readClaudeOAuth();
    if (raw) {
      try {
        const data = await postTokenRefresh(raw.refreshToken);
        const refreshed: ClaudeOAuthCreds = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? raw.refreshToken,
          expiresAt: Date.now() + data.expires_in * 1000,
          scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : raw.scopes,
          subscriptionType: data.subscription_type ?? raw.subscriptionType,
          rateLimitTier: data.rate_limit_tier ?? raw.rateLimitTier,
        };
        try {
          writeCredsAtomic(refreshed);
        } catch {}
        result = await call(refreshed.accessToken);
      } catch {
        // Keep the original 401/403
      }
    }
  }
  return result;
}

/** Authenticated GET. Thin wrapper over {@link anthropicOAuthRequest}. */
export async function anthropicOAuthGet(pathname: string, opts: AnthropicOAuthRequestOpts = {}) {
  return anthropicOAuthRequest('GET', pathname, opts);
}

/**
 * Authenticated POST with an optional JSON body. Thin wrapper over
 * {@link anthropicOAuthRequest}. Pass `body: undefined` for body-less POSTs
 * (e.g. trigger `/run`) — no body bytes are sent in that case.
 */
export async function anthropicOAuthPost(pathname: string, body?: any, opts: AnthropicOAuthRequestOpts = {}) {
  return anthropicOAuthRequest('POST', pathname, { ...opts, body });
}

/** Authenticated DELETE. Thin wrapper over {@link anthropicOAuthRequest}. */
export async function anthropicOAuthDelete(pathname: string, opts: AnthropicOAuthRequestOpts = {}) {
  return anthropicOAuthRequest('DELETE', pathname, opts);
}

// ─────────────────────────────────────────────────────────────────────────
// Claude Code endpoint helpers — fingerprints sourced from
// claude-code-leak/claude-code-2.1.88/source/src/ (Anthropic's own call
// sites). All use the OAuth bearer + `anthropic-beta: oauth-2025-04-20`
// pattern via `auth.headers`, except where noted.
// ─────────────────────────────────────────────────────────────────────────

/**
 * GET /api/oauth/claude_cli/roles — role data for the current OAuth user.
 * Source: services/oauth/client.ts:279 (`fetchAndStoreUserRoles`).
 * NOTE: this endpoint is called with `Authorization` ONLY — no
 * `anthropic-beta` header. Sending one would be a fingerprint deviation.
 */
export function getOauthCliRoles() {
  return anthropicOAuthGet('/api/oauth/claude_cli/roles', { betaHeader: null });
}

/** GET /api/oauth/account/settings. Source: observed live + sources/services. */
export function getOauthAccountSettings() {
  return anthropicOAuthGet('/api/oauth/account/settings');
}

/** GET /api/claude_cli/bootstrap?entrypoint=&model= */
export function getClaudeCliBootstrap(opts: { entrypoint?: string; model?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.entrypoint) params.set('entrypoint', opts.entrypoint);
  if (opts.model) params.set('model', opts.model);
  const qs = params.toString();
  return anthropicOAuthGet(`/api/claude_cli/bootstrap${qs ? '?' + qs : ''}`);
}

/** GET /api/claude_code_grove — extended-thinking grove config. */
export function getClaudeCodeGrove() {
  return anthropicOAuthGet('/api/claude_code_grove');
}

/** GET /api/claude_code_penguin_mode — fast-mode config. */
export function getClaudeCodePenguinMode() {
  return anthropicOAuthGet('/api/claude_code_penguin_mode');
}

/**
 * GET /api/claude_code/policy_limits.
 * Source: services/policyLimits/index.ts (Bearer + oauth-2025-04-20).
 */
export function getClaudeCodePolicyLimits() {
  return anthropicOAuthGet('/api/claude_code/policy_limits');
}

/**
 * GET /api/claude_code/settings — server-managed Claude Code settings.
 * Source: services/remoteManagedSettings/index.ts.
 */
export function getClaudeCodeSettings() {
  return anthropicOAuthGet('/api/claude_code/settings');
}

/**
 * GET /api/claude_code/user_settings — user-level settings (PUT supported
 * for updates in source, not yet exposed here).
 * Source: services/settingsSync/index.ts.
 */
export function getClaudeCodeUserSettings() {
  return anthropicOAuthGet('/api/claude_code/user_settings');
}

/**
 * GET /api/claude_code/team_memory?repo=<owner/repo>[&view=hashes]
 * Source: services/teamMemorySync/index.ts. Returns either the full
 * memory data or just the entry checksums when `view=hashes`.
 */
export function getClaudeCodeTeamMemory(repo: string, opts: { view?: 'hashes' } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repo slug: expected owner/repo, got ${repo}`);
  }
  const params = new URLSearchParams();
  params.set('repo', repo);
  if (opts.view === 'hashes') params.set('view', 'hashes');
  return anthropicOAuthGet(`/api/claude_code/team_memory?${params}`);
}

/**
 * GET /v1/mcp_servers — Anthropic-managed MCP servers.
 * Fingerprint differs from the OAuth-beta family: uses
 * `anthropic-beta: mcp-servers-2025-12-04` + `anthropic-version: 2023-06-01`.
 */
export function getV1McpServers(opts: { limit?: number } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 1000));
  return anthropicOAuthGet(`/v1/mcp_servers?${params}`, {
    betaHeader: 'mcp-servers-2025-12-04',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  });
}

/**
 * GET /mcp-registry/v0/servers — public MCP marketplace catalog.
 * Public endpoint (no Authorization header).
 */
export function getMcpRegistry(opts: { limit?: number; version?: string; visibility?: string; cursor?: string } = {}) {
  const params = new URLSearchParams();
  params.set('version', opts.version ?? 'latest');
  params.set('limit', String(opts.limit ?? 100));
  if (opts.visibility) params.set('visibility', opts.visibility);
  if (opts.cursor) params.set('cursor', opts.cursor);
  return anthropicOAuthGet(`/mcp-registry/v0/servers?${params}`, {
    skipAuth: true,
    betaHeader: null,
  });
}

let cachedOrganizationUuid: string | null | undefined;

/**
 * Resolve the organization UUID for the current OAuth identity.
 *
 * Sourced from GET /api/oauth/profile → `organization.uuid` (the same payload
 * `/claude-code/profile` surfaces). Memoized for the process lifetime — the
 * org binding is stable per credentials file — mirroring `detectClaudeCodeVersion`.
 * Throws if the profile can't be read or carries no org uuid; callers in the
 * route layer turn that into the standard `OAUTH_UNAVAILABLE` error shape.
 */
export async function getOrganizationUuid(): Promise<string> {
  if (typeof cachedOrganizationUuid === 'string' && cachedOrganizationUuid) {
    return cachedOrganizationUuid;
  }
  const r = await anthropicOAuthGet('/api/oauth/profile');
  if (r.status >= 400) {
    throw new Error(`organization uuid lookup failed: /api/oauth/profile responded ${r.status} ${r.statusText}`);
  }
  const uuid = r.body?.organization?.uuid;
  if (typeof uuid !== 'string' || !uuid) {
    throw new Error('organization uuid missing from /api/oauth/profile response');
  }
  cachedOrganizationUuid = uuid;
  return uuid;
}

/**
 * GET /v1/code/routines/run-budget — the organization's per-rolling-24h
 * routine RUN quota (plan tiers: Pro 5 / Max 15 / Team-Enterprise 25; overage
 * via Extra Usage when `unified_billing_enabled`).
 *
 * Fingerprint differs from the OAuth-beta family: OAuth bearer +
 * `anthropic-version: 2023-06-01` + `anthropic-beta: ccr-triggers-2026-01-30`
 * (REQUIRED — the endpoint 404s without it) + `x-organization-uuid`. Upstream
 * returns `{ limit, used, unified_billing_enabled }` where `limit`/`used` are
 * STRINGS.
 */
export async function getClaudeCodeRoutineRunBudget() {
  const orgUuid = await getOrganizationUuid();
  return anthropicOAuthGet('/v1/code/routines/run-budget', {
    betaHeader: 'ccr-triggers-2026-01-30',
    extraHeaders: {
      'anthropic-version': '2023-06-01',
      'x-organization-uuid': orgUuid,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Claude Code Routines / Triggers (CCR) CRUD — the `/v1/code/triggers`
// surface (plus `/v1/environment_providers` for building create bodies).
//
// Every call carries the same fingerprint as getClaudeCodeRoutineRunBudget
// above: OAuth bearer + `anthropic-version: 2023-06-01` + `anthropic-beta:
// ccr-triggers-2026-01-30` (REQUIRED — the surface 404s without it) +
// `x-organization-uuid` (resolved from /api/oauth/profile, memoized per
// process). Validated live against api.anthropic.com on 2026-06-03.
// ─────────────────────────────────────────────────────────────────────────

/** Build the shared CCR-triggers request opts (beta header + version + org uuid). */
async function claudeCodeTriggerOpts(): Promise<AnthropicOAuthRequestOpts> {
  const orgUuid = await getOrganizationUuid();
  return {
    betaHeader: 'ccr-triggers-2026-01-30',
    extraHeaders: {
      'anthropic-version': '2023-06-01',
      'x-organization-uuid': orgUuid,
    },
  };
}

/** GET /v1/code/triggers — list routines/triggers. Returns `{ data: [...], has_more }`. */
export async function listRoutines() {
  return anthropicOAuthGet('/v1/code/triggers', await claudeCodeTriggerOpts());
}

/** GET /v1/code/triggers/{id} — read a single routine/trigger. */
export async function getRoutine(id: string) {
  return anthropicOAuthGet(`/v1/code/triggers/${encodeURIComponent(id)}`, await claudeCodeTriggerOpts());
}

/** POST /v1/code/triggers — create a routine/trigger (body passthrough). */
export async function createRoutine(body: any) {
  return anthropicOAuthPost('/v1/code/triggers', body, await claudeCodeTriggerOpts());
}

/** POST /v1/code/triggers/{id} — partial update of a routine/trigger. */
export async function updateRoutine(id: string, body: any) {
  return anthropicOAuthPost(`/v1/code/triggers/${encodeURIComponent(id)}`, body, await claudeCodeTriggerOpts());
}

/** POST /v1/code/triggers/{id}/run — fire a routine/trigger now (a CCR cloud session). Body-less. */
export async function runRoutine(id: string) {
  return anthropicOAuthPost(`/v1/code/triggers/${encodeURIComponent(id)}/run`, undefined, await claudeCodeTriggerOpts());
}

/** DELETE /v1/code/triggers/{id} — delete a routine/trigger. Returns `{ deleted_session_count }`. */
export async function deleteRoutine(id: string) {
  return anthropicOAuthDelete(`/v1/code/triggers/${encodeURIComponent(id)}`, await claudeCodeTriggerOpts());
}

/** GET /v1/environment_providers — environments available for routine `job_config.ccr.environment_id`. */
export async function listRoutineEnvironments() {
  return anthropicOAuthGet('/v1/environment_providers', await claudeCodeTriggerOpts());
}
