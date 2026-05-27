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
  /**
   * Auto-approve MCP tool calls during the streamed response.
   *
   * When the model invokes a connector tool that's gated by claude.ai's
   * per-conv approval gate (i.e. `enabled_mcp_tools` for the conv has only
   * the bare `<srv>:<tool>` enabledKey but not the hash-suffixed
   * `alwaysApprovedKey`), the upstream SSE stream ends with
   * `message_delta { stop_reason: "tool_use" }` and the model pauses
   * server-side waiting for human approval.
   *
   * With `autoApproveTools: true`, lm-assist discovers each invoked tool's
   * current content-hash via a one-time probe conversation (cached 5 min
   * per orgUuid), POSTs `/tool_approval` upstream for every gated
   * tool_use_id, then waits for the assistant message to extend with the
   * tool_result + continuation, and merges that into the returned `text`.
   *
   * Tools without a discoverable approval_key (e.g. SPA-internal
   * `tool_search`) are skipped silently — those don't gate through this
   * mechanism. Default false to preserve old behavior; callers that want
   * the new flow must opt in.
   */
  autoApproveTools?: boolean;
} = {}): Promise<{
  status: number;
  statusText: string;
  events: Array<{ type: string; data: any }>;
  text: string;
  humanMessageUuid: string;
  assistantMessageUuid: string;
  /** When autoApproveTools fired, what was approved (one entry per call). */
  approvals?: Array<{ toolUseId: string; toolName: string; status: number; ok: boolean; error?: string }>;
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
  // Track tool_use content_blocks as they stream. Each tool_use block
  // arrives as: content_block_start (with id+name) → content_block_delta
  // (input_json_delta partial JSON) → content_block_stop. The id and name
  // are on the START event — capture them so we can POST /tool_approval
  // when the model pauses at the gate.
  const toolUseBlocks: Array<{ id: string; name: string; index: number }> = [];
  const approvalPromises: Array<Promise<{ toolUseId: string; toolName: string; status: number; ok: boolean; error?: string }>> = [];
  const fired = new Set<string>();
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
        if (parsed && typeof parsed === 'object') {
          if (parsed.delta?.text) text += parsed.delta.text;
          else if (typeof parsed.completion === 'string') text += parsed.completion;
          // Track tool_use block creation. We have to capture id+name from
          // content_block_start because the stop event only carries `index`.
          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            const id = String(parsed.content_block.id || '');
            const name = String(parsed.content_block.name || '');
            const index = typeof parsed.index === 'number' ? parsed.index : toolUseBlocks.length;
            if (id && name) toolUseBlocks.push({ id, name, index });
          }
          // Fire approval the MOMENT a tool_use content_block ends — DON'T
          // wait for message_delta. claude.ai's backend holds the /completion
          // SSE open after the gated tool_use block is emitted, waiting for
          // /tool_approval. If we wait for message_delta { stop_reason }, we
          // deadlock — that event never arrives until after approval lands.
          if (opts.autoApproveTools && parsed.type === 'content_block_stop') {
            const stoppedIndex = typeof parsed.index === 'number' ? parsed.index : -1;
            const tu = toolUseBlocks.find((t) => t.index === stoppedIndex);
            if (tu && !fired.has(tu.id)) {
              fired.add(tu.id);
              const tApproveStart = Date.now();
              debugAA(`tool_use block ended: ${tu.name} (${tu.id.slice(0,16)}...) — firing approval`);
              approvalPromises.push(
                approveToolUse({
                  orgUuid,
                  convUuid,
                  toolUseId: tu.id,
                  toolName: tu.name,
                  approvalOption: 'once',
                }).then(
                  (r) => {
                    debugAA(`approval ${tu.name} → HTTP ${r.status} (${Date.now() - tApproveStart}ms)`);
                    return { toolUseId: tu.id, toolName: tu.name, status: r.status, ok: r.status < 400 };
                  },
                  (err: Error) => {
                    debugAA(`approval ${tu.name} → ERROR (${Date.now() - tApproveStart}ms): ${err.message}`);
                    return { toolUseId: tu.id, toolName: tu.name, status: 0, ok: false, error: err.message };
                  },
                ),
              );
            }
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // If auto-approve fired, wait for all approvals to complete, then poll
  // the conversation until the assistant message has been extended with
  // the tool_result + post-tool continuation text (claude.ai's backend
  // appends to the SAME assistant message; the original SSE closed at
  // message_stop with stop_reason=tool_use and the continuation does NOT
  // arrive on a new SSE — it arrives via conversation state).
  let approvals: Array<{ toolUseId: string; toolName: string; status: number; ok: boolean; error?: string }> | undefined;
  debugAA(`SSE drained: ${events.length} events, ${approvalPromises.length} approvals queued`);
  if (approvalPromises.length > 0) {
    approvals = await Promise.all(approvalPromises);
    debugAA(`approvals done: ${approvals.map(a => `${a.toolName}=${a.status}`).join(', ')}`);
    const POLL_INTERVAL = 1500;
    const POLL_MAX_MS = Math.min(opts.timeoutMs ?? 120_000, 60_000);
    const pollStart = Date.now();
    let lastLen = 0;
    let stable = 0;
    let pollIter = 0;
    while (Date.now() - pollStart < POLL_MAX_MS) {
      pollIter++;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      try {
        const conv = await readConversation(convUuid, { orgUuid, tree: true, renderingMode: 'messages', renderAllTools: true });
        if (conv.status >= 400) break;
        const msgs = ((conv.body as any)?.chat_messages || []) as Array<any>;
        const last = msgs[msgs.length - 1];
        if (last?.sender !== 'assistant') continue;
        const blocks = (last.content || []) as Array<any>;
        const hasToolResult = blocks.some((b) => b?.type === 'tool_result');
        const finalText = blocks
          .filter((b) => b?.type === 'text')
          .map((b) => String(b.text || ''))
          .join('');
        const stopReason = String(last.stop_reason || '');
        debugAA(`poll iter=${pollIter} stop_reason=${stopReason} blocks=${blocks.length} hasToolResult=${hasToolResult} textLen=${finalText.length}`);
        if (hasToolResult && finalText.length > 0 && stopReason && stopReason !== 'tool_use') {
          if (finalText.length > text.length) text = finalText;
          break;
        }
        if (finalText.length === lastLen) {
          stable++;
          if (stable >= 2 && finalText.length > 0) {
            if (finalText.length > text.length) text = finalText;
            break;
          }
        } else {
          stable = 0;
          lastLen = finalText.length;
        }
      } catch (e) {
        debugAA(`poll error: ${(e as Error).message}`);
        break;
      }
    }
    debugAA(`poll exit after ${pollIter} iter`);
  }

  return { status: res.status, statusText: res.statusText, events, text, humanMessageUuid, assistantMessageUuid, approvals };
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
export async function createConversation(opts: {
  name?: string;
  uuid?: string;
  orgUuid?: string;
  /** Optional model override; defaults to whatever claude.ai picks (currently claude-opus-4-7). */
  model?: string;
  /**
   * Optional explicit `settings.enabled_mcp_tools` map. When passed, REPLACES
   * the conversation's inherited account-level settings — useful for forcing
   * the per-call approval gate to fire on a known tool by passing only the
   * bare `<srv>:<tool>` key (no hash-suffixed alwaysApprovedKey).
   * Format: `{ "<srv_uuid>:<tool_name>": true, ... }`.
   */
  enabledMcpTools?: Record<string, boolean>;
  /** Optional `settings.tool_search_mode` override. Pass 'off' to suppress the SPA's tool_search meta-tool. */
  toolSearchMode?: 'on' | 'off' | string;
} = {}) {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const convUuid = opts.uuid ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(convUuid)) {
    throw new Error(`Invalid conversation UUID: ${convUuid}`);
  }
  const orgUuid = _org(opts);
  const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations`;
  const id = deriveIdentity(cfg);
  const body: Record<string, unknown> = { uuid: convUuid, name: opts.name ?? '' };
  if (opts.model) body.model = opts.model;
  if (opts.enabledMcpTools || opts.toolSearchMode) {
    const settings: Record<string, unknown> = {};
    if (opts.enabledMcpTools) settings.enabled_mcp_tools = opts.enabledMcpTools;
    if (opts.toolSearchMode) settings.tool_search_mode = opts.toolSearchMode;
    body.settings = settings;
  }
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

// ─────────────────────────────────────────────────────────────────────────
// Tool approval support (auto-approval inside sendMessage)
// ─────────────────────────────────────────────────────────────────────────
//
// claude.ai gates MCP connector tools via per-conv `enabled_mcp_tools`:
//   - bare `<srv>:<tool>` = enabled (tool is callable)
//   - `<srv>:<tool>-<contentHash>` = always-approved (no per-call gate)
//
// When only the bare enabledKey is set, the model invokes the tool and the
// /completion SSE pauses with `message_delta { stop_reason: "tool_use" }`.
// The browser SPA then POSTs `/tool_approval` with the constructed
// `approval_key` (`<srv>:<tool>-<contentHash>`) to release the gate, and
// the backend appends the tool_result + the model's continuation onto the
// SAME assistant message in the conversation.
//
// `discoverApprovalKeys()` finds the current `approval_key` for every
// installed MCP tool by creating a one-off probe conversation (which
// inherits `account.settings.enabled_mcp_tools` including hash suffixes)
// and reading its settings back. The result is cached for 5 minutes per
// orgUuid. The hash changes when the connector's tool descriptions change;
// a stale cache yields a 4xx from `/tool_approval` and the caller can
// invalidate via `clearApprovalKeyCache(orgUuid)`.

const APPROVAL_KEY_TTL_MS = 5 * 60 * 1000;

// Enable the per-event auto-approval debug log by exporting
// LM_ASSIST_DEBUG_AUTOAPPROVE=1 (or =true) in lm-assist's process env. Off
// by default so production logs stay clean; flip on while investigating
// gated-tool flows that aren't completing as expected.
const DEBUG_AUTOAPPROVE =
  process.env.LM_ASSIST_DEBUG_AUTOAPPROVE === '1' ||
  process.env.LM_ASSIST_DEBUG_AUTOAPPROVE === 'true';
function debugAA(msg: string): void {
  if (DEBUG_AUTOAPPROVE) console.error(`[autoApprove] ${msg}`);
}

interface ApprovalKeyCacheEntry {
  /** tool_name -> hash-suffixed approval_key (only for tools with alwaysApprovedKey set on account). */
  hashKeys: Record<string, string>;
  /** tool_name -> bare `<srv>:<tool>` key (present for every MCP tool the connector exposes). */
  bareKeys: Record<string, string>;
  expiresAt: number;
}
const approvalKeyCache = new Map<string, ApprovalKeyCacheEntry>();

export function clearApprovalKeyCache(orgUuid?: string): void {
  if (orgUuid) approvalKeyCache.delete(orgUuid);
  else approvalKeyCache.clear();
}

/**
 * Discover the per-tool approval_keys claude.ai expects on `/tool_approval`.
 *
 * Returns both flavors of keys:
 *   - `hashKeys[tool_name]` — the full hash-suffixed key (`<srv>:<tool>-<hash>`),
 *     only present for tools that have already been approved with
 *     `approval_option: 'always'` (the hash is on `account.settings`).
 *   - `bareKeys[tool_name]` — the bare prefix (`<srv>:<tool>`), present for every
 *     MCP tool the connector currently exposes. Useful as a fallback when
 *     `hashKeys` doesn't have the tool (first-time approval).
 *
 * Cached per `orgUuid` for {@link APPROVAL_KEY_TTL_MS}. Stale on 4xx from a
 * follow-up `/tool_approval` POST → call {@link clearApprovalKeyCache} to
 * force a re-probe (the connector tools may have been re-registered with
 * different hashes after a description edit).
 */
export async function discoverApprovalKeys(orgUuidArg?: string): Promise<ApprovalKeyCacheEntry> {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = orgUuidArg || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  const cached = approvalKeyCache.get(orgUuid);
  if (cached && cached.expiresAt > Date.now()) return cached;

  // Create probe conv WITHOUT explicit settings so it inherits
  // account.settings.enabled_mcp_tools (bare keys for every installed tool
  // plus hash keys for tools previously always-approved).
  const probe = await createConversation({ orgUuid, name: 'lm-assist-approval-probe' });
  if (probe.status >= 400) {
    throw new Error(`probe conversation create failed: ${probe.status} ${probe.statusText}`);
  }
  const settings = (probe.body as any)?.settings?.enabled_mcp_tools || {};
  const hashKeys: Record<string, string> = {};
  const bareKeys: Record<string, string> = {};
  const HASH_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-zA-Z0-9_]+)-([0-9a-f]{32})$/;
  const BARE_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-zA-Z0-9_]+)$/;
  for (const k of Object.keys(settings)) {
    const mh = k.match(HASH_KEY_RE);
    if (mh) {
      hashKeys[mh[2]] = k;
      continue;
    }
    const mb = k.match(BARE_KEY_RE);
    if (mb) bareKeys[mb[2]] = k;
  }
  // Cleanup probe conv (best-effort — failure here doesn't affect caller)
  if (probe.uuid) {
    deleteConversation(probe.uuid, { orgUuid }).catch(() => { /* ignore */ });
  }
  const entry: ApprovalKeyCacheEntry = { hashKeys, bareKeys, expiresAt: Date.now() + APPROVAL_KEY_TTL_MS };
  approvalKeyCache.set(orgUuid, entry);
  return entry;
}

export async function approveToolUse(opts: {
  orgUuid?: string;
  convUuid: string;
  toolUseId: string;
  toolName: string;
  /** 'once' = approve this call only; 'always' = add hash key to account.settings. Default 'once'. */
  approvalOption?: 'once' | 'always';
  /** Override the approval_key lookup (e.g. if you already know the hash). */
  approvalKey?: string;
  timeoutMs?: number;
}): Promise<{ status: number; statusText: string; body: any }> {
  const cfg = readClaudeAISession();
  if (!cfg) throw new Error('No claude.ai session configured');
  const orgUuid = opts.orgUuid || deriveIdentity(cfg).orgUuid;
  if (!orgUuid) throw new Error('No org_uuid');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(opts.convUuid)) {
    throw new Error(`Invalid conversation UUID: ${opts.convUuid}`);
  }
  if (!opts.toolUseId || typeof opts.toolUseId !== 'string') {
    throw new Error('toolUseId is required');
  }
  let approvalKey = opts.approvalKey;
  // Lookup order:
  //   1) explicit caller-provided approval_key (highest priority)
  //   2) hash-suffixed key learned from probe-conv (only present for tools
  //      previously approved with approval_option:'always')
  //   3) bare `<srv>:<tool>` key — present for every MCP tool the connector
  //      exposes; usable for first-time approval where claude.ai will
  //      compute/return the correct hash on its own.
  //   4) tool not exposed via this connector at all → synthetic 204
  //      (e.g. SPA-internal `tool_search`).
  if (!approvalKey) {
    const entry = await discoverApprovalKeys(orgUuid);
    // claude.ai's SSE delivers MCP tool names as `<integration>:<tool>`
    // (e.g. `lm-assist:search_memory`). The probe conv's
    // enabled_mcp_tools indexes by bare `<tool>` only. Try both shapes.
    const fullName = opts.toolName;
    const strippedName = fullName.includes(':') ? fullName.split(':').pop() || fullName : fullName;
    approvalKey = entry.hashKeys[fullName] || entry.hashKeys[strippedName] ||
                  entry.bareKeys[fullName] || entry.bareKeys[strippedName];
    if (!approvalKey) {
      return { status: 204, statusText: 'No Content (tool not exposed by any connector)', body: null };
    }
  }
  const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations/${opts.convUuid}/tool_approval`;
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
    Referer: `https://claude.ai/chat/${opts.convUuid}`,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cfg.cookie,
  };
  if (id.anonymousId) headers['anthropic-anonymous-id'] = id.anonymousId;
  if (id.activitySessionId) headers['x-activity-session-id'] = id.activitySessionId;
  if (id.deviceId) headers['anthropic-device-id'] = id.deviceId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tool_use_id: opts.toolUseId,
        is_approved: true,
        approval_key: approvalKey,
        approval_option: opts.approvalOption ?? 'once',
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    // If a 4xx came back, the cached hash may be stale (tool description changed)
    // — invalidate so the next call re-probes.
    if (res.status >= 400 && res.status < 500) {
      approvalKeyCache.delete(orgUuid);
    }
    return { status: res.status, statusText: res.statusText, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}
