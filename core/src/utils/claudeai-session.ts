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
import { randomUUID } from 'crypto';

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

export interface ClaudeAIProbeResult {
  /** Probe verdict — true when account_profile returned 200. */
  ok: boolean;
  /** HTTP status from the probe call (0 if the fetch itself errored). */
  status: number;
  /** Coarse reason code. */
  reason:
    | 'ok'
    | 'session_not_configured'
    | 'session_expired'         // 401
    | 'cloudflare_blocked'      // 403 (usually) or 503
    | 'network_error'           // fetch threw
    | 'upstream_error'          // 4xx/5xx other
    | 'unknown';
  /** Human-readable hint about what to do next. */
  hint: string;
  /** Lower-cased account/org metadata from the probe (if ok). */
  accountUuid?: string;
  organizationName?: string;
  emailHash?: string;
}

/**
 * Actively probe whether the configured cookie still authenticates by
 * hitting /api/account_profile. Cheap (returns a small JSON) and uses
 * the same fingerprint as every other request.
 *
 * Distinct from getClaudeAISessionStatus() which only inspects the
 * config file — this one actually talks to claude.ai.
 */
export async function probeClaudeAISession(timeoutMs = 8000): Promise<ClaudeAIProbeResult> {
  const cfg = readClaudeAISession();
  if (!cfg) {
    return {
      ok: false,
      status: 0,
      reason: 'session_not_configured',
      hint: `Create ${SESSION_PATH} with at minimum {"cookie": "<paste browser Cookie header>"}. See docs/claude-ai-routes.md.`,
    };
  }
  let resp;
  try {
    resp = await claudeaiGet('/api/account_profile', { timeoutMs, referer: 'https://claude.ai/' });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: 'network_error',
      hint: `Could not reach claude.ai: ${(err as Error).message}`,
    };
  }
  if (resp.status === 200) {
    const b: any = resp.body || {};
    // Lightly hash the email so we don't return raw PII.
    const email: string | undefined = b.account?.email;
    let emailHash: string | undefined;
    if (email) {
      // Cheap djb2-style hash, just for display correlation
      let h = 5381;
      for (let i = 0; i < email.length; i++) h = (h * 33 + email.charCodeAt(i)) >>> 0;
      emailHash = h.toString(16);
    }
    return {
      ok: true,
      status: 200,
      reason: 'ok',
      hint: 'claude.ai session is valid.',
      accountUuid: b.account?.uuid,
      organizationName: b.organization?.name,
      emailHash,
    };
  }
  if (resp.status === 401) {
    return {
      ok: false,
      status: 401,
      reason: 'session_expired',
      hint:
        'sessionKey is expired or invalid. Capture a fresh Cookie header from a logged-in claude.ai tab (DevTools → Network → Copy as cURL → paste the Cookie value).',
    };
  }
  if (resp.status === 403 || resp.status === 503) {
    return {
      ok: false,
      status: resp.status,
      reason: 'cloudflare_blocked',
      hint:
        'Cloudflare blocked the request. Likely causes: cf_clearance / __cf_bm expired, source IP changed since cookies were captured, or rate-limited. Refresh from the browser on the same machine.',
    };
  }
  return {
    ok: false,
    status: resp.status,
    reason: 'upstream_error',
    hint: `claude.ai responded ${resp.status} ${resp.statusText}.`,
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

/** GET /api/organizations/{org_uuid}/memory — Claude's persistent memory. */
export async function getMemory(opts: { orgUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  return claudeaiGet(`/api/organizations/${orgUuid}/memory`, {
    referer: 'https://claude.ai/',
  });
}

/**
 * GET /edge-api/bootstrap/{org_uuid}/app_start — single call that returns
 * account info, feature flags, recent conversations, and capability flags.
 * By far the highest-frequency endpoint in real traffic; useful for warming
 * a UI state in one shot.
 *
 * Note: the path UUID is the **org_uuid**, NOT the user uuid. Verified
 * against the live endpoint — the user-uuid path returns 404.
 */
export async function getBootstrapAppStart(opts: { orgUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid (ensure lastActiveOrg cookie is present)');
  return claudeaiGet(`/edge-api/bootstrap/${orgUuid}/app_start`, {
    referer: 'https://claude.ai/',
  });
}

/**
 * POST /api/organizations/{org_uuid}/chat_conversations/{conv_uuid}/completion
 *
 * Send a new message to an existing conversation and consume the streamed
 * SSE response. Auto-fetches `current_leaf_message_uuid` from the
 * conversation if `parentMessageUuid` is not supplied.
 *
 * Returns `{ status, events, text, humanMessageUuid, assistantMessageUuid }`:
 *  - events: every parsed SSE event in order
 *  - text:   concatenated text-delta content from the assistant's reply
 *  - humanMessageUuid / assistantMessageUuid: client-generated UUIDs the
 *    server now treats as the canonical IDs for this turn
 *
 * SAFETY: this is a real write to the user's claude.ai account — it
 * creates real message history, costs real tokens, and may trigger any
 * tools attached to the conversation. Use with care.
 */
export async function sendMessage(convUuid: string, prompt: string, opts: {
  orgUuid?: string;
  parentMessageUuid?: string;
  model?: string;
  timezone?: string;
  locale?: string;
  /** Personalized style override. Defaults to the "Normal" style. */
  style?: any;
  /** Pass-through tools array. Defaults to []. */
  tools?: any[];
  /**
   * Text-channel attachments — sent inline with the prompt as
   * `{file_name, file_type, file_size, extracted_content, origin, kind}`
   * objects. This is the right channel for markdown / source code / any
   * text content you want the assistant to see directly. NOT for binaries.
   */
  attachments?: any[];
  /**
   * File-channel attachments — array of `file_uuid` strings returned from
   * `POST /api/{org}/upload` (lm-assist does not currently expose that
   * upload route — call claude.ai directly with the cookie for the upload,
   * then pass the resulting uuids here). Files land in the assistant's
   * sandbox at `/mnt/user-data/uploads/`. Text content via this channel
   * is unreliable (often not auto-extracted); prefer `attachments` for text.
   */
  files?: string[];
  /** Pass-through sync_sources array (URL ingestion sources). Defaults to []. */
  syncSources?: string[];
  /** Max time to wait for the stream to complete. Default 120s. */
  timeoutMs?: number;
} = {}): Promise<{
  status: number;
  statusText: string;
  events: Array<{ type: string; data: any }>;
  text: string;
  humanMessageUuid: string;
  assistantMessageUuid: string;
}> {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(convUuid)) {
    throw new Error(`Invalid conversation UUID: ${convUuid}`);
  }

  // Resolve parent_message_uuid by fetching the conversation if needed.
  let parent = opts.parentMessageUuid;
  if (!parent) {
    const conv = await readConversation(convUuid, { orgUuid });
    if (conv.status >= 400) {
      throw new Error(`Failed to read conversation for current_leaf_message_uuid: ${conv.status}`);
    }
    parent = (conv.body as any)?.current_leaf_message_uuid;
    if (!parent) throw new Error('Conversation has no current_leaf_message_uuid (empty thread?)');
  }

  // Generate client-side UUIDs for this turn. Real Chrome uses UUIDv7
  // (time-ordered) — we use UUIDv4 which the server accepts.
  const newUuid = () => {
    const b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && (crypto as any).getRandomValues) {
      (crypto as any).getRandomValues(b);
    } else {
      for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const humanMessageUuid = newUuid();
  const assistantMessageUuid = newUuid();

  const body = {
    prompt,
    timezone: opts.timezone ?? 'UTC',
    personalized_styles: [opts.style ?? {
      type: 'default',
      key: 'Default',
      name: 'Normal',
      nameKey: 'normal_style_name',
      prompt: 'Normal\n',
      summary: 'Default responses from Claude',
      summaryKey: 'normal_style_summary',
      isDefault: true,
    }],
    locale: opts.locale ?? 'en-US',
    model: opts.model ?? 'claude-opus-4-7',
    tools: opts.tools ?? [],
    turn_message_uuids: { human_message_uuid: humanMessageUuid, assistant_message_uuid: assistantMessageUuid },
    attachments: opts.attachments ?? [],
    files: opts.files ?? [],
    sync_sources: opts.syncSources ?? [],
    rendering_mode: 'messages',
    parent_message_uuid: parent,
  };

  const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations/${convUuid}/completion`;
  const id = deriveIdentity(cfg);
  const referer = `https://claude.ai/chat/${convUuid}`;

  const headers: Record<string, string> = {
    Host: 'claude.ai',
    Connection: 'keep-alive',
    accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
    'User-Agent': cfg.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Origin: 'https://claude.ai',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: referer,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cfg.cookie,
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`POST /completion failed: ${(err as Error).message}`);
  }

  // Drain SSE stream. Each event is "event: TYPE\ndata: JSON\n\n".
  const events: Array<{ type: string; data: any }> = [];
  let text = '';
  if (!res.body) {
    clearTimeout(timer);
    return { status: res.status, statusText: res.statusText, events, text, humanMessageUuid, assistantMessageUuid };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // claude.ai uses CRLF event separators (\r\n\r\n) — observed live
      // 2026-05-14. SSE spec allows either CRLF or LF, so accept both.
      const SEP = /\r\n\r\n|\n\n/;
      let m: RegExpExecArray | null;
      while ((m = SEP.exec(buf)) !== null) {
        const chunk = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const evMatch = chunk.match(/^event:\s*(.+?)\r?$/m);
        const dataMatch = chunk.match(/^data:\s*([\s\S]+?)\r?$/m);
        if (!evMatch || !dataMatch) continue;
        let parsed: any = dataMatch[1].trim();
        try { parsed = JSON.parse(parsed); } catch {}
        events.push({ type: evMatch[1].trim(), data: parsed });
        // Aggregate any text delta we can find.
        if (parsed && typeof parsed === 'object') {
          // Anthropic-style content_block_delta — { delta: { text: "..." } }
          if (parsed.delta?.text) text += parsed.delta.text;
          // claude.ai sometimes uses `completion` events with a string
          else if (typeof parsed.completion === 'string') text += parsed.completion;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { status: res.status, statusText: res.statusText, events, text, humanMessageUuid, assistantMessageUuid };
}

// ─────────────────────────────────────────────────────────────────────────
// Additional read helpers — fingerprints verified against lm-proxy captures
// 2026-05-10..14 on yi@10.0.1.123. All claude.ai web reads share the
// baseHeaders set claudeaiGet() emits; only the path, query, and Referer
// vary per endpoint.
// ─────────────────────────────────────────────────────────────────────────

/** GET /api/account_profile — standalone account profile read. */
export async function getAccountProfile() {
  return claudeaiGet('/api/account_profile', { referer: 'https://claude.ai/' });
}

function _org(opts: { orgUuid?: string } = {}): string {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  return orgUuid;
}

/** GET /api/organizations/{org} — org metadata. */
export async function getOrgInfo(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/subscription_details[?cached=true]. */
export async function getSubscriptionDetails(opts: { orgUuid?: string; cached?: boolean } = {}) {
  const qs = opts.cached === false ? '' : '?cached=true';
  return claudeaiGet(`/api/organizations/${_org(opts)}/subscription_details${qs}`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/usage — claude.ai-side usage view. */
export async function getOrgUsage(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/usage`, { referer: 'https://claude.ai/settings/usage' });
}

/** GET /api/organizations/{org}/skills/list-skills. */
export async function listOrgSkills(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/skills/list-skills`, { referer: 'https://claude.ai/' });
}

/**
 * GET /api/organizations/{org}/mcp/v2/bootstrap — connected MCP servers.
 * NOTE: response is `text/event-stream` not JSON; helper buffers the
 * stream and returns the parsed events array under `body.events`.
 */
export async function getOrgMcpBootstrap(opts: { orgUuid?: string } = {}): Promise<ClaudeAIResponse<any>> {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = _org(opts);
  const id = deriveIdentity(cfg);

  // Custom request — Accept: text/event-stream
  const url = `https://claude.ai/api/organizations/${orgUuid}/mcp/v2/bootstrap`;
  const headers: Record<string, string> = {
    Host: 'claude.ai',
    Connection: 'keep-alive',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
    'User-Agent': cfg.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Accept: 'text/event-stream',
    Referer: 'https://claude.ai/new',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cfg.cookie,
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    if (!res.body) {
      return { status: res.status, statusText: res.statusText, headers: respHeaders, body: { events: [] } as any };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const events: Array<{ type: string; data: any }> = [];
    let buf = '';
    const SEP = /\r\n\r\n|\n\n/;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = SEP.exec(buf)) !== null) {
        const chunk = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const evMatch = chunk.match(/^event:\s*(.+?)\r?$/m);
        const dataMatch = chunk.match(/^data:\s*([\s\S]+?)\r?$/m);
        if (!evMatch || !dataMatch) continue;
        let parsed: any = dataMatch[1].trim();
        try { parsed = JSON.parse(parsed); } catch {}
        events.push({ type: evMatch[1].trim(), data: parsed });
      }
    }
    return { status: res.status, statusText: res.statusText, headers: respHeaders, body: { events } as any };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/organizations/{org}/list_styles — chat styles. */
export async function listOrgStyles(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/list_styles`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/model_configs/{model} — per-model capabilities. */
export async function getModelConfig(modelId: string, opts: { orgUuid?: string } = {}) {
  if (!/^[a-z0-9-]+$/i.test(modelId)) throw new Error(`Invalid modelId: ${modelId}`);
  return claudeaiGet(`/api/organizations/${_org(opts)}/model_configs/${modelId}`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/memory/settings. */
export async function getMemorySettings(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/memory/settings`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/cowork_settings. */
export async function getCoworkSettings(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/cowork_settings`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/sync/settings. */
export async function getSyncSettings(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/sync/settings`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/sync/ingestion/gdrive/progress. */
export async function getGdriveProgress(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/sync/ingestion/gdrive/progress`, { referer: 'https://claude.ai/' });
}

/** GET /api/organizations/{org}/notification/preferences. */
export async function getNotificationPreferences(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/organizations/${_org(opts)}/notification/preferences`, { referer: 'https://claude.ai/' });
}

/** GET /api/accounts/{account_uuid}/invites. */
export async function listInvites(opts: { accountUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const accountUuid = opts.accountUuid || deriveIdentity(cfg).userId;
  if (!accountUuid) throw new Error('No account uuid (ensure ajs_user_id cookie is present)');
  return claudeaiGet(`/api/accounts/${accountUuid}/invites`, { referer: 'https://claude.ai/' });
}

/** GET /api/bootstrap/{org_uuid}/current_user_access — per-user permissions. */
export async function getCurrentUserAccess(opts: { orgUuid?: string } = {}) {
  return claudeaiGet(`/api/bootstrap/${_org(opts)}/current_user_access`, { referer: 'https://claude.ai/' });
}

/**
 * GET /api/auth/sessions/list-active — live sessions across devices.
 * Useful for surfacing "where am I signed in?" in a UI.
 */
export async function listActiveSessions(opts: { page?: number; perPage?: number; applicationSlug?: string } = {}) {
  const params = new URLSearchParams();
  params.set('page', String(opts.page ?? 1));
  params.set('per_page', String(opts.perPage ?? 10));
  params.set('application_slug', opts.applicationSlug ?? 'claude-ai');
  return claudeaiGet(`/api/auth/sessions/list-active?${params}`, { referer: 'https://claude.ai/settings/account' });
}

/**
 * POST /api/organizations/{org}/chat_conversations/{conv}/title — WRITE.
 * If `title` is omitted, claude.ai auto-generates one from the conversation
 * content. Pass an explicit `title` to rename.
 */
export async function setConversationTitle(convUuid: string, opts: { title?: string; orgUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(convUuid)) {
    throw new Error(`Invalid conversation UUID: ${convUuid}`);
  }
  const orgUuid = _org(opts);
  const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations/${convUuid}/title`;
  const id = deriveIdentity(cfg);
  const body = opts.title !== undefined ? { title: opts.title } : {};
  const headers: Record<string, string> = {
    Host: 'claude.ai',
    Connection: 'keep-alive',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
    'content-type': 'application/json',
    Accept: '*/*',
    'User-Agent': cfg.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Origin: 'https://claude.ai',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: `https://claude.ai/chat/${convUuid}`,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cfg.cookie,
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, statusText: res.statusText, headers: respHeaders, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/organizations/{org_uuid}/chat_conversations — create a new,
 * empty conversation.
 *
 * WRITE. The web app generates the conversation UUID client-side and sends
 * it in the body; the server echoes it back. We mirror that: a UUIDv4 is
 * generated here (or taken from `opts.uuid`) so the caller knows the id
 * without having to parse the response. `name` defaults to "" (claude.ai
 * shows "New chat" and auto-titles after the first message).
 *
 * Returns the usual { status, statusText, headers, body }; on success
 * (HTTP 201) `body.uuid` equals the uuid we sent.
 */
export async function createConversation(opts: { name?: string; uuid?: string; orgUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const convUuid = opts.uuid ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(convUuid)) {
    throw new Error(`Invalid conversation UUID: ${convUuid}`);
  }
  const orgUuid = _org(opts);
  const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations`;
  const id = deriveIdentity(cfg);
  const body = { uuid: convUuid, name: opts.name ?? '' };
  const headers: Record<string, string> = {
    Host: 'claude.ai',
    Connection: 'keep-alive',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
    'content-type': 'application/json',
    Accept: '*/*',
    'User-Agent': cfg.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Origin: 'https://claude.ai',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://claude.ai/new',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cfg.cookie,
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, statusText: res.statusText, headers: respHeaders, body: parsed, uuid: convUuid };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DELETE /api/organizations/{org_uuid}/chat_conversations/{conv_uuid} —
 * permanently delete a single conversation.
 *
 * WRITE (destructive). The UUID is validated to be a real UUIDv4 so a
 * malformed/empty value can't widen the path. Returns the usual shape;
 * claude.ai responds 204 (no body) on success.
 */
export async function deleteConversation(convUuid: string, opts: { orgUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(convUuid)) {
    throw new Error(`Invalid conversation UUID: ${convUuid}`);
  }
  const orgUuid = _org(opts);
  const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations/${convUuid}`;
  const id = deriveIdentity(cfg);
  const headers: Record<string, string> = {
    Host: 'claude.ai',
    Connection: 'keep-alive',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
    'content-type': 'application/json',
    Accept: '*/*',
    'User-Agent': cfg.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Origin: 'https://claude.ai',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://claude.ai/recents',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cfg.cookie,
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { method: 'DELETE', headers, signal: ctrl.signal });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, statusText: res.statusText, headers: respHeaders, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/organizations/{org_uuid}/artifacts/{artifact_uuid}/versions */
export async function getArtifactVersions(artifactUuid: string, opts: { orgUuid?: string } = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(artifactUuid)) {
    throw new Error(`Invalid artifact UUID: ${artifactUuid}`);
  }
  return claudeaiGet(
    `/api/organizations/${orgUuid}/artifacts/${artifactUuid}/versions`,
    { referer: 'https://claude.ai/' },
  );
}
