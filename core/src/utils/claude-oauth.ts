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

/**
 * Make an authenticated GET to api.anthropic.com using the Claude Code
 * OAuth token. Adds Bearer + anthropic-beta + Claude Code user-agent.
 * Handles the single-retry-on-401 pattern (force refresh, retry once).
 */
export async function anthropicOAuthGet(
  pathname: string,
  opts: { timeoutMs?: number; userAgent?: string } = {},
): Promise<{ status: number; statusText: string; body: any; headers: Record<string, string> }> {
  const url = `https://api.anthropic.com${pathname}`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ua = opts.userAgent ?? 'lm-assist/0.1 (claude-code-oauth-proxy)';

  async function call(token: string) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
          'User-Agent': ua,
          Accept: 'application/json, text/plain, */*',
        },
        signal: ctrl.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const text = await res.text();
      let body: any;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, statusText: res.statusText, headers, body };
    } finally {
      clearTimeout(timer);
    }
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
