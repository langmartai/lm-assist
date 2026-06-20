/**
 * claude.ai "via-chrome" snippet generator
 *
 * Produces JavaScript snippets meant to be passed verbatim to
 * `mcp__claude-in-chrome__javascript_tool` inside an authenticated
 * `https://claude.ai/*` tab. The snippet runs in the page context, so
 * the browser auto-attaches every cookie (including HttpOnly ones the
 * page JS itself cannot read). Result returned out of the tool is the
 * parsed JSON body plus status — no cookie ever leaves Chrome.
 *
 * This is the "live / interactive" path that pairs with the cookie-file
 * based `/claude-ai/conversations` routes:
 *  - Pure HTTP callers (cron, dashboards) use the cookie-file path.
 *  - Claude Code sessions with Chrome MCP loaded use this snippet path —
 *    no setup, always-fresh cf_clearance.
 */

const UUID_RE_STR = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const UUID_RE = new RegExp(`^${UUID_RE_STR}$`, 'i');

// claude.ai's web app installs a fetch interceptor that adds these
// application-level headers to every /api/* call. Bare `fetch()` in our
// snippet bypasses that interceptor, so we have to re-inject them.
// Values match the observed wire fingerprint (lm-proxy 2026-05-10..14).
const CLAUDEAI_HEADER_SNIPPET = `
  // Build the same header set claude.ai's web app sends on every call.
  // Cookies supply per-session identity (anthropic-device-id, anonymous-id,
  // x-activity-session-id); the rest are pinned to observed values.
  const cookies = Object.fromEntries(document.cookie.split(';').map(p => {
    const i = p.indexOf('='); if (i < 0) return [p.trim(), ''];
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const baseHeaders = {
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha': '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
  };
  if (cookies['anthropic-device-id']) baseHeaders['anthropic-device-id'] = cookies['anthropic-device-id'];
  if (cookies['ajs_anonymous_id']) baseHeaders['anthropic-anonymous-id'] = cookies['ajs_anonymous_id'];
  if (cookies['activitySessionId']) baseHeaders['x-activity-session-id'] = cookies['activitySessionId'];
`;

export interface ViaChromeSnippet {
  /** JS code suitable for mcp__claude-in-chrome__javascript_tool. */
  snippet: string;
  /** Human-readable description of what the snippet does. */
  description: string;
  /** Expected URL pattern the snippet hits (with {org} placeholder). */
  url: string;
  /**
   * The HTTP method the snippet actually performs (GET or POST). The
   * snippet itself dispatches via `fetch()`, so this is informational
   * only — useful for logging and UI display.
   */
  method: 'GET' | 'POST';
  /** Instructions for the caller. */
  instructions: string;
}

const INSTRUCTIONS =
  "Pass `snippet` verbatim as the `text` field to mcp__claude-in-chrome__javascript_tool " +
  "with action='javascript_exec', targeting an authenticated https://claude.ai/* tab. " +
  "The tool returns `{ status, statusText, body }`. If you don't have a claude.ai tab open, " +
  "use mcp__claude-in-chrome__tabs_create_mcp + navigate to https://claude.ai/ first.";

/**
 * Serialize a query object to a URL-safe query string. Supports the
 * mixed-case `tree=True` that the web app uses (booleans are stringified).
 */
function buildQuery(query: Record<string, string | number | boolean> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Generate a JS snippet that fetches an arbitrary `/api/...` path from
 * the current claude.ai tab. The `{org}` placeholder in `path` is
 * replaced at runtime by the JS using the `lastActiveOrg` cookie.
 */
export function buildViaChromeSnippet(opts: {
  path: string;
  query?: Record<string, string | number | boolean>;
  description?: string;
}): ViaChromeSnippet {
  const path = opts.path.replace(/^\/+/, '/');
  if (!path.startsWith('/')) throw new Error('path must start with /');
  // Hard whitelist: only /api/, /edge-api/, /v1/ — matches the prefixes
  // observed in real claude.ai web traffic. Prevents a confused caller
  // from being tricked into navigating away or hitting arbitrary URLs.
  if (!/^\/(api|edge-api|v1)\//.test(path)) {
    throw new Error(`path must start with /api/, /edge-api/ or /v1/ — got ${path}`);
  }
  const qs = buildQuery(opts.query);
  const fullPath = `${path}${qs}`;

  // Snippet runs inside an authenticated claude.ai tab. The browser
  // attaches cookies + per-page headers (User-Agent, Accept-Encoding,
  // sec-ch-ua-*, Sec-Fetch-*, Origin, Referer) automatically; we add
  // back the application-level anthropic-client-* headers that
  // claude.ai's own fetch interceptor would have added.
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch && ${JSON.stringify(fullPath).includes('{org}') ? 'true' : 'false'}) {
    return { error: 'no_org', message: 'lastActiveOrg cookie not present; are you logged in to claude.ai?' };
  }
  const org = orgMatch ? orgMatch[1] : '';
  const url = ${JSON.stringify(fullPath)}.replace('{org}', org);
  try {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { ...baseHeaders, 'Accept': '*/*' },
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;

  return {
    snippet,
    description: opts.description || `Fetch ${fullPath}`,
    url: `https://claude.ai${fullPath}`,
    method: 'GET',
    instructions: INSTRUCTIONS,
  };
}

/**
 * Snippet for listing conversations (chat_conversations_v2). org_uuid
 * is auto-derived from cookies at runtime.
 */
export function snippetListConversations(opts: {
  limit?: number;
  starred?: boolean;
  consistency?: 'eventual' | 'strong';
  projectUuid?: string;
} = {}): ViaChromeSnippet {
  const query: Record<string, string | number | boolean> = {
    limit: opts.limit ?? 30,
    starred: opts.starred ?? false,
    consistency: opts.consistency ?? 'eventual',
  };
  if (opts.projectUuid) {
    if (!UUID_RE.test(opts.projectUuid)) throw new Error(`Invalid projectUuid: ${opts.projectUuid}`);
    query.project_uuid = opts.projectUuid;
  }
  return buildViaChromeSnippet({
    path: '/api/organizations/{org}/chat_conversations_v2',
    query,
    description: 'List claude.ai conversations',
  });
}

/**
 * Snippet for reading a single conversation with full message tree.
 */
export function snippetReadConversation(convUuid: string, opts: {
  tree?: boolean;
  renderingMode?: string;
  renderAllTools?: boolean;
} = {}): ViaChromeSnippet {
  if (!UUID_RE.test(convUuid)) throw new Error(`Invalid conversation UUID: ${convUuid}`);
  return buildViaChromeSnippet({
    path: `/api/organizations/{org}/chat_conversations/${convUuid}`,
    query: {
      // Web app sends literal "True" with capital T — mirror that.
      tree: opts.tree === false ? 'False' : 'True',
      rendering_mode: opts.renderingMode ?? 'messages',
      render_all_tools: opts.renderAllTools === false ? 'false' : 'true',
    },
    description: `Read claude.ai conversation ${convUuid}`,
  });
}

/** Snippet for listing projects. */
export function snippetListProjects(opts: {
  limit?: number;
  includeHarmonyProjects?: boolean;
  creatorFilter?: 'is_creator' | 'is_not_creator';
} = {}): ViaChromeSnippet {
  const query: Record<string, string | number | boolean> = {
    include_harmony_projects: opts.includeHarmonyProjects ?? true,
    limit: opts.limit ?? 200,
  };
  if (opts.creatorFilter) query.creator_filter = opts.creatorFilter;
  return buildViaChromeSnippet({
    path: '/api/organizations/{org}/projects',
    query,
    description: 'List claude.ai projects',
  });
}

/** Snippet for reading Claude's persistent memory for the org. */
export function snippetGetMemory(): ViaChromeSnippet {
  return buildViaChromeSnippet({
    path: '/api/organizations/{org}/memory',
    description: "Read Claude's persistent memory for this org",
  });
}

/**
 * Snippet for /edge-api/bootstrap/{org_uuid}/app_start — single call returning
 * account info, feature flags, recent conversation summaries, and the current
 * user's permissions. Verified against the live endpoint: the path UUID is the
 * org_uuid (lastActiveOrg cookie), NOT the user uuid — the user-uuid path
 * returns 404.
 */
export function snippetBootstrapAppStart(): ViaChromeSnippet {
  return buildViaChromeSnippet({
    path: '/edge-api/bootstrap/{org}/app_start',
    description: 'Read /edge-api/bootstrap/{org}/app_start (high-leverage page-load endpoint)',
  });
}

/**
 * Snippet that checks whether everything is in place to operate the
 * via-chrome path:
 *   - the current tab is on https://claude.ai/*
 *   - identity cookies (lastActiveOrg, anthropic-device-id) are present
 *   - GET /api/account_profile returns 200 with `account` populated
 *
 * Designed to be the FIRST call an agent makes before driving any other
 * via-chrome operation. Returns a structured verdict the agent can
 * branch on, plus a `hint` for what to do if anything's wrong.
 */
export function snippetHealthCheck(): ViaChromeSnippet {
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const onClaudeAi = location.hostname === 'claude.ai';
  if (!onClaudeAi) {
    return {
      ok: false,
      reason: 'wrong_tab',
      pageUrl: location.href,
      hint: 'Open https://claude.ai/ in this tab (use mcp__claude-in-chrome__navigate) before calling via-chrome endpoints.',
    };
  }
  const orgUuid = cookies['lastActiveOrg'];
  const deviceId = cookies['anthropic-device-id'];
  if (!orgUuid) {
    return {
      ok: false,
      reason: 'not_logged_in',
      pageUrl: location.href,
      hint: 'lastActiveOrg cookie not present — log in to claude.ai in this browser first.',
    };
  }
  // Active probe — same call /claude-ai/session-status?probe=true does
  let r;
  try {
    r = await fetch('/api/account_profile', {
      credentials: 'include',
      headers: { ...baseHeaders, 'Accept': '*/*' },
    });
  } catch (e) {
    return { ok: false, reason: 'network_error', pageUrl: location.href, hint: 'Network error reaching claude.ai: ' + (e && e.message || String(e)) };
  }
  if (r.status === 401) return { ok: false, reason: 'session_expired', status: 401, pageUrl: location.href, hint: 'Session expired — sign back in to claude.ai in this browser.' };
  if (r.status === 403 || r.status === 503) return { ok: false, reason: 'cloudflare_blocked', status: r.status, pageUrl: location.href, hint: 'Cloudflare blocked the request. Reload claude.ai/ in this tab to refresh cf_clearance / __cf_bm.' };
  if (!r.ok) return { ok: false, reason: 'upstream_error', status: r.status, pageUrl: location.href, hint: 'claude.ai responded ' + r.status };
  const j = await r.json();
  return {
    ok: true,
    reason: 'ok',
    pageUrl: location.href,
    identity: {
      orgUuid,
      deviceId: deviceId || null,
      anonymousId: cookies['ajs_anonymous_id'] || null,
      activitySessionId: cookies['activitySessionId'] || null,
    },
    account: {
      // Surface non-sensitive bits only — UUID + org name; suppress email/name
      uuid: j && j.account && j.account.uuid,
      hasMax: !!(j && j.account && j.account.has_claude_max),
      hasPro: !!(j && j.account && j.account.has_claude_pro),
      organizationName: j && j.organization && j.organization.name,
      organizationType: j && j.organization && j.organization.organization_type,
      rateLimitTier: j && j.organization && j.organization.rate_limit_tier,
    },
    hint: 'claude.ai accessible and logged in; via-chrome routes are ready to use.',
  };
})()`;
  return {
    snippet,
    description: 'Health check: verify the active tab is on claude.ai, the user is logged in, and the session can talk to /api/account_profile.',
    url: 'https://claude.ai/api/account_profile',
    method: 'GET',
    instructions:
      INSTRUCTIONS +
      ' Call this BEFORE any other via-chrome route to confirm the integration is healthy. Branch on `ok`; if false, `reason` and `hint` describe what to do.',
  };
}

/** Snippet for reading an artifact's version history. */
export function snippetArtifactVersions(artifactUuid: string): ViaChromeSnippet {
  if (!UUID_RE.test(artifactUuid)) throw new Error(`Invalid artifact UUID: ${artifactUuid}`);
  return buildViaChromeSnippet({
    path: `/api/organizations/{org}/artifacts/${artifactUuid}/versions`,
    description: `Read versions of artifact ${artifactUuid}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Snippet generators for the additional claude.ai reads. Fingerprints
// verified against lm-proxy captures 2026-05-10..14.
// ─────────────────────────────────────────────────────────────────────────

export const snippetAccountProfile = () =>
  buildViaChromeSnippet({ path: '/api/account_profile', description: 'Read account profile' });

export const snippetOrgInfo = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}', description: 'Read org metadata' });

export const snippetSubscriptionDetails = (opts: { cached?: boolean } = {}) =>
  buildViaChromeSnippet({
    path: '/api/organizations/{org}/subscription_details',
    query: opts.cached === false ? undefined : { cached: 'true' },
    description: 'Read subscription details',
  });

export const snippetOrgUsage = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/usage', description: 'Read claude.ai org usage' });

export const snippetListOrgSkills = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/skills/list-skills', description: 'List installed skills' });

export const snippetListOrgStyles = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/list_styles', description: 'List chat styles' });

export const snippetModelConfig = (modelId: string) => {
  if (!/^[a-z0-9-]+$/i.test(modelId)) throw new Error(`Invalid modelId: ${modelId}`);
  return buildViaChromeSnippet({
    path: `/api/organizations/{org}/model_configs/${modelId}`,
    description: `Read model config for ${modelId}`,
  });
};

export const snippetMemorySettings = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/memory/settings', description: 'Read memory settings' });

export const snippetCoworkSettings = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/cowork_settings', description: 'Read cowork settings' });

export const snippetSyncSettings = () =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/sync/settings', description: 'Read sync settings' });

export const snippetGdriveProgress = () =>
  buildViaChromeSnippet({
    path: '/api/organizations/{org}/sync/ingestion/gdrive/progress',
    description: 'Read Google Drive ingestion progress',
  });

export const snippetNotificationPreferences = () =>
  buildViaChromeSnippet({
    path: '/api/organizations/{org}/notification/preferences',
    description: 'Read notification preferences',
  });

export const snippetCurrentUserAccess = () =>
  buildViaChromeSnippet({
    path: '/api/bootstrap/{org}/current_user_access',
    description: 'Read per-user permissions / roles',
  });

export const snippetListInvites = (): ViaChromeSnippet => {
  // account_uuid placeholder replaced from ajs_user_id cookie at runtime
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const userMatch = document.cookie.match(/ajs_user_id=(${UUID_RE_STR})/i);
  if (!userMatch) return { error: 'no_account', message: 'ajs_user_id cookie not present' };
  const account = userMatch[1];
  const url = '/api/accounts/' + account + '/invites';
  try {
    const r = await fetch(url, { credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' } });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  return { snippet, description: 'List pending org invites for current account', url: 'https://claude.ai/api/accounts/{account_uuid}/invites', method: 'GET', instructions: INSTRUCTIONS };
};

export const snippetListActiveSessions = (opts: { page?: number; perPage?: number; applicationSlug?: string } = {}) =>
  buildViaChromeSnippet({
    path: '/api/auth/sessions/list-active',
    query: {
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 10,
      application_slug: opts.applicationSlug ?? 'claude-ai',
    },
    description: 'List active sessions across devices',
  });

/**
 * Snippet for /api/organizations/{org}/mcp/v2/bootstrap. Server emits SSE
 * (text/event-stream), so the snippet drains the stream in-page and
 * returns the parsed events array.
 */
export const snippetMcpBootstrap = (): ViaChromeSnippet => {
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const url = '/api/organizations/' + orgMatch[1] + '/mcp/v2/bootstrap';
  let res;
  try {
    res = await fetch(url, { credentials: 'include', headers: { ...baseHeaders, 'Accept': 'text/event-stream' } });
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
  if (!res.ok || !res.body) {
    const text = await res.text();
    return { status: res.status, statusText: res.statusText, url, body: text };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  const SEP = /\\r\\n\\r\\n|\\n\\n/;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = SEP.exec(buf)) !== null) {
      const chunk = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const evM = chunk.match(/^event:\\s*(.+?)\\r?$/m);
      const dM = chunk.match(/^data:\\s*([\\s\\S]+?)\\r?$/m);
      if (!evM || !dM) continue;
      let parsed = dM[1].trim();
      try { parsed = JSON.parse(parsed); } catch {}
      events.push({ type: evM[1].trim(), data: parsed });
    }
  }
  return { status: res.status, statusText: res.statusText, url, body: { events, eventCount: events.length, eventTypes: [...new Set(events.map(e => e.type))] } };
})()`;
  return { snippet, description: 'Read MCP bootstrap (SSE response)', url: 'https://claude.ai/api/organizations/{org}/mcp/v2/bootstrap', method: 'GET', instructions: INSTRUCTIONS };
};

/**
 * POST snippet — rename / auto-title a conversation. If `title` is null,
 * server generates one from conversation content. Returns the new title.
 */
export const snippetSetConversationTitle = (convUuid: string, opts: { title?: string } = {}): ViaChromeSnippet => {
  if (!UUID_RE.test(convUuid)) throw new Error(`Invalid conversation UUID: ${convUuid}`);
  const body = opts.title !== undefined ? { title: opts.title } : {};
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const url = '/api/organizations/' + orgMatch[1] + '/chat_conversations/${convUuid}/title';
  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...baseHeaders, 'content-type': 'application/json', 'Accept': '*/*' },
      body: ${JSON.stringify(JSON.stringify(body))},
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  return {
    snippet,
    description: `Set / regenerate title for conversation ${convUuid}`,
    url: `https://claude.ai/api/organizations/{org}/chat_conversations/${convUuid}/title`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE — changes the conversation title visible in the sidebar.',
  };
};

/**
 * POST snippet — create a new, empty conversation. The conversation UUID
 * is generated in-page (UUIDv4 via crypto.randomUUID) and sent in the
 * body, mirroring the web app; the snippet returns it as `uuid` so the
 * caller can immediately read or delete it without parsing the body.
 *
 * WRITE — adds a real (empty) conversation to the user's claude.ai account.
 */
export const snippetCreateConversation = (opts: { name?: string } = {}): ViaChromeSnippet => {
  const name = opts.name ?? '';
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const convUuid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (() => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  })();
  const url = '/api/organizations/' + orgMatch[1] + '/chat_conversations';
  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...baseHeaders, 'content-type': 'application/json', 'Accept': '*/*' },
      body: JSON.stringify({ uuid: convUuid, name: ${JSON.stringify(name)} }),
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, uuid: convUuid, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  return {
    snippet,
    description: 'Create a new empty claude.ai conversation',
    url: 'https://claude.ai/api/organizations/{org}/chat_conversations',
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE — creates a real (empty) conversation in the user\'s claude.ai account. The new conversation UUID is returned as `uuid`.',
  };
};

/**
 * DELETE snippet — permanently delete a single conversation by UUID.
 * The UUID is validated host-side (must be a real UUIDv4) so a
 * malformed/empty value can't widen the request path.
 *
 * WRITE (destructive) — removes the conversation from the user's account.
 */
export const snippetDeleteConversation = (convUuid: string): ViaChromeSnippet => {
  if (!UUID_RE.test(convUuid)) throw new Error(`Invalid conversation UUID: ${convUuid}`);
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const url = '/api/organizations/' + orgMatch[1] + '/chat_conversations/${convUuid}';
  try {
    const r = await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      headers: { ...baseHeaders, 'Accept': '*/*' },
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  return {
    snippet,
    description: `Delete claude.ai conversation ${convUuid}`,
    url: `https://claude.ai/api/organizations/{org}/chat_conversations/${convUuid}`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE (DESTRUCTIVE) — permanently deletes this conversation. Verify the UUID is the intended one before running.',
  };
};

/**
 * Snippet that sends a new message to an existing conversation and
 * consumes the SSE stream in-page. Two-step inside the snippet:
 *   1. GET conversation → read current_leaf_message_uuid
 *   2. POST /completion → drain SSE
 *
 * Returns `{ status, events, text, humanMessageUuid, assistantMessageUuid }`.
 *
 * SAFETY: this is a real WRITE that creates message history in the user's
 * claude.ai account, costs tokens, and may trigger any attached tools.
 */
export function snippetSendMessage(convUuid: string, prompt: string, opts: {
  model?: string;
  timezone?: string;
  locale?: string;
  parentMessageUuid?: string;
  /**
   * Text-channel attachments — full
   * `{file_name, file_type, file_size, extracted_content, origin, kind}`
   * objects with the markdown/source text inline. The assistant sees it
   * directly in context. Use this for any text content. JSON-embedded
   * into the snippet, so large payloads grow the snippet size accordingly.
   */
  attachments?: any[];
  /**
   * file_uuid strings from `POST /api/{org}/upload`. Files land in the
   * assistant's sandbox at `/mnt/user-data/uploads/`. Text extraction
   * from blob uploads is unreliable; prefer `attachments` for text.
   */
  files?: string[];
  /** sync_source uuids (URL ingestion sources). */
  syncSources?: string[];
  /**
   * MCP tool definitions to expose to the model on this turn. Pass the
   * SPA-shaped array (each entry `{name, description, integration_name,
   * mcp_server_uuid, mcp_server_url, input_schema, ...}`). Without these
   * the model cannot see any connector's tools and `autoApproveTools`
   * has nothing to approve.
   */
  tools?: any[];
  /**
   * When true, the generated snippet auto-resolves MCP tool-approval gates
   * inline in the browser: it tracks `tool_use` content_blocks as the SSE
   * streams, fires `POST /tool_approval` on each `content_block_stop`
   * (using the same three-tier approval_key fallback the server-side
   * `sendMessage` path uses), then polls the conversation for the
   * post-approval continuation and merges the model's final text into
   * the returned result. Default false.
   */
  autoApproveTools?: boolean;
  /**
   * When true, the generated snippet injects a status banner at the top of
   * the page explaining what lm-assist is doing, updates the banner as the
   * flow progresses (sending prompt → tool calls → approval → polling →
   * done), installs a `beforeunload` guard to warn before navigation away,
   * and intercepts in-page link clicks to non-claude.ai URLs. The banner
   * auto-clears once the snippet returns. Default true when the spawned
   * browser is in non-headless mode (caller passes `showOverlay: true`);
   * set false to disable when the snippet runs against a headless or
   * server-side browser where there's no user to inform.
   */
  showOverlay?: boolean;
} = {}): ViaChromeSnippet {
  if (!UUID_RE.test(convUuid)) throw new Error(`Invalid conversation UUID: ${convUuid}`);
  const model = opts.model ?? 'claude-opus-4-7';
  const timezone = opts.timezone ?? 'UTC';
  const locale = opts.locale ?? 'en-US';
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const files = Array.isArray(opts.files) ? opts.files : [];
  const syncSources = Array.isArray(opts.syncSources) ? opts.syncSources : [];
  const tools = Array.isArray(opts.tools) ? opts.tools : [];
  const autoApprove = !!opts.autoApproveTools;
  const showOverlay = !!opts.showOverlay;

  // Overlay setup block — only emitted when showOverlay is true. Installs a
  // top-of-page banner explaining what lm-assist is doing, a navigation
  // guard (`beforeunload` + intercept of non-claude.ai link clicks), and a
  // `setStatus(text)` helper that the surrounding snippet calls as the
  // flow progresses. DOM is built node-by-node (no innerHTML) — content is
  // entirely lm-assist-controlled, but createElement + textContent keeps
  // the static-analysis layers happy and is XSS-safe by construction.
  // Re-installs on SPA route changes via MutationObserver.
  const overlaySetup = showOverlay ? `
  // === overlay + nav guard install ===
  // Idempotent: if a persistent banner is already installed (via
  // /claude-ai/browser/install-idle-banner, etc.), reuse it. Track who
  // created it so only the creator tears it down — preserves the user's
  // persistent "this browser is managed by lm-assist" banner across runs.
  var __lmaPreExistingOverlay = !!(window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus);
  (function installOverlay() {
    if (__lmaPreExistingOverlay) {
      window.__lmAssistViaOverlay.setStatus('Sending prompt…');
      return;
    }
    var prev = document.getElementById('__lm-assist-via-overlay');
    if (prev) prev.remove();
    var el = document.createElement('div');
    el.id = '__lm-assist-via-overlay';
    var styleEl = document.createElement('style');
    styleEl.textContent = ''
      + '#__lm-assist-via-overlay { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;'
      + ' background: #1a1d29; color: #f8f9fb; padding: 10px 44px 10px 18px;'
      + ' font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 13px;'
      + ' line-height: 1.5; border-bottom: 2px solid #d97757; box-shadow: 0 4px 14px rgba(0,0,0,.35); }'
      + '#__lm-assist-via-overlay strong { color: #d97757; font-size: 14px; }'
      + '#__lm-assist-via-overlay p { margin: 2px 0; }'
      + '#__lm-assist-via-overlay .lm-small { color: #b8bcc7; font-size: 11.5px; }'
      + '#__lm-assist-via-overlay .lm-close { position: absolute; top: 6px; right: 12px;'
      + ' background: none; border: none; color: #f8f9fb; cursor: pointer; font-size: 18px; opacity: .7; }'
      + '#__lm-assist-via-overlay .lm-close:hover { opacity: 1; }'
      + '#__lm-assist-via-overlay .lm-ok { color: #4ade80; }'
      + '#__lm-assist-via-overlay .lm-err { color: #f87171; }';
    el.appendChild(styleEl);

    var btnClose = document.createElement('button');
    btnClose.className = 'lm-close';
    btnClose.textContent = '\\u00d7';
    btnClose.title = 'Dismiss banner (does NOT cancel the in-progress request)';
    btnClose.addEventListener('click', function() { if (window.__lmAssistViaOverlay) window.__lmAssistViaOverlay.tearDown(); });
    el.appendChild(btnClose);

    var title = document.createElement('strong');
    title.textContent = 'lm-assist · running completion in this tab';
    el.appendChild(title);

    var statusP = document.createElement('p');
    statusP.id = '__lm-assist-via-status';
    statusP.textContent = 'Sending prompt…';
    el.appendChild(statusP);

    var noteP = document.createElement('p');
    noteP.className = 'lm-small';
    noteP.textContent = "A request is in progress on your claude.ai conversation. Please don't navigate away or close this tab until it finishes — the result will be lost. Links to non-claude.ai sites are blocked while this runs.";
    el.appendChild(noteP);

    (document.body || document.documentElement).appendChild(el);

    function setStatus(text, kind) {
      var p = document.getElementById('__lm-assist-via-status');
      if (!p) return;
      p.textContent = text;
      p.className = kind === 'ok' ? 'lm-ok' : (kind === 'err' ? 'lm-err' : '');
    }
    function beforeUnloadHandler(e) {
      e.preventDefault();
      e.returnValue = 'lm-assist is still running a request in this tab. Leaving will discard the result.';
      return e.returnValue;
    }
    function clickGuard(e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      try {
        var u = new URL(a.href, location.href);
        if (u.host !== location.host && !/(^|\\.)claude\\.ai$/i.test(u.host)) {
          e.preventDefault();
          e.stopPropagation();
          setStatus('Blocked navigation to ' + u.host + ' — lm-assist run in progress.', 'err');
        }
      } catch (_e) {}
    }
    window.addEventListener('beforeunload', beforeUnloadHandler);
    document.addEventListener('click', clickGuard, true);

    function tearDown() {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      document.removeEventListener('click', clickGuard, true);
      try { mo.disconnect(); } catch (_e) {}
      var n = document.getElementById('__lm-assist-via-overlay');
      if (n) n.remove();
      delete window.__lmAssistViaOverlay;
    }

    // Re-install if claude.ai's SPA wipes our node during a route change.
    var mo = new MutationObserver(function() {
      if (!document.getElementById('__lm-assist-via-overlay')) {
        try { mo.disconnect(); } catch (_e) {}
        installOverlay();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.__lmAssistViaOverlay = { setStatus: setStatus, tearDown: tearDown };
  })();` : '';
  const overlayStatus = (text: string, kind?: 'ok' | 'err') =>
    showOverlay
      ? `try { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus(${JSON.stringify(text)}${kind ? ', ' + JSON.stringify(kind) : ''}); } catch (_e) {}`
      : '';
  const overlayTearDown = showOverlay
    ? `try { if (!__lmaPreExistingOverlay) { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.tearDown(); } else { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus('Idle. Waiting for next lm-assist request.', 'ok'); } } catch (_e) {}`
    : '';
  // Auto-approve setup block (built once, injected into the snippet only
  // when opts.autoApproveTools is true). Mirrors the cookie-file path's
  // discoverApprovalKeys + approveToolUse + post-SSE poll mechanism — but
  // executed in the tab via fetch with credentials:include, so claude.ai
  // sees a real-browser TLS handshake and same-session cookies. All
  // values reach back into the outer snippet via `org`, `conv`,
  // `baseHeaders`, `text`, `events` declared above.
  const autoApproveSetup = autoApprove ? `
  // === auto-approve setup ===
  let approvalLookup = { hashKeys: {}, bareKeys: {} };
  try {
    const sr = await fetch('/api/organizations/' + org + '/chat_conversations/' + conv + '?tree=True&rendering_mode=messages&render_all_tools=true', {
      credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' },
    });
    if (sr.ok) {
      const sj = await sr.json();
      const emt = (sj.settings && sj.settings.enabled_mcp_tools) || {};
      const HASH_RE = /^([0-9a-f-]{36}):([a-zA-Z0-9_]+)-([0-9a-f]{32})$/;
      const BARE_RE = /^([0-9a-f-]{36}):([a-zA-Z0-9_]+)$/;
      for (const k of Object.keys(emt)) {
        const mh = k.match(HASH_RE);
        if (mh) { approvalLookup.hashKeys[mh[2]] = k; continue; }
        const mb = k.match(BARE_RE);
        if (mb) approvalLookup.bareKeys[mb[2]] = k;
      }
    }
  } catch (_e) {}
  const toolUseBlocks = [];
  const approvalPromises = [];
  const firedToolUses = new Set();
  const approvals = [];
  const stripPrefix = (n) => n.includes(':') ? n.split(':').pop() : n;` : '';

  const autoApproveInLoop = autoApprove ? `
        // === auto-approve: detect tool_use blocks + fire /tool_approval ===
        if (parsed && typeof parsed === 'object') {
          if (parsed.type === 'content_block_start' && parsed.content_block && parsed.content_block.type === 'tool_use') {
            const id = String(parsed.content_block.id || '');
            const name = String(parsed.content_block.name || '');
            const idx = typeof parsed.index === 'number' ? parsed.index : toolUseBlocks.length;
            if (id && name) toolUseBlocks.push({ id, name, index: idx });
          }
          if (parsed.type === 'content_block_stop') {
            const stoppedIdx = typeof parsed.index === 'number' ? parsed.index : -1;
            const tu = toolUseBlocks.find(t => t.index === stoppedIdx);
            if (tu && !firedToolUses.has(tu.id)) {
              firedToolUses.add(tu.id);
              const fullName = tu.name;
              const strippedName = stripPrefix(fullName);
              const key = approvalLookup.hashKeys[fullName] || approvalLookup.hashKeys[strippedName] ||
                          approvalLookup.bareKeys[fullName] || approvalLookup.bareKeys[strippedName];
              if (key) {
                const p = fetch('/api/organizations/' + org + '/chat_conversations/' + conv + '/tool_approval', {
                  method: 'POST', credentials: 'include',
                  headers: { ...baseHeaders, 'content-type': 'application/json', 'Accept': '*/*' },
                  body: JSON.stringify({ tool_use_id: tu.id, is_approved: true, approval_key: key, approval_option: 'once' }),
                }).then(r => { approvals.push({ toolUseId: tu.id, toolName: tu.name, status: r.status, ok: r.status < 400 }); return r; },
                         e => { approvals.push({ toolUseId: tu.id, toolName: tu.name, status: 0, ok: false, error: String(e && e.message || e) }); });
                approvalPromises.push(p);
              } else {
                // Tool isn't gated (e.g. SPA-internal tool_search) — synthetic 204.
                approvals.push({ toolUseId: tu.id, toolName: tu.name, status: 204, ok: true });
              }
            }
          }
        }` : '';

  const autoApprovePostSse = autoApprove ? `
  // === auto-approve continuation poll ===
  if (approvalPromises.length > 0) {
    await Promise.all(approvalPromises);
    const pollStart = Date.now();
    let lastLen = 0, stable = 0;
    while (Date.now() - pollStart < 60000) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const cr2 = await fetch('/api/organizations/' + org + '/chat_conversations/' + conv + '?tree=True&rendering_mode=messages&render_all_tools=true', {
          credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' },
        });
        if (!cr2.ok) break;
        const cj2 = await cr2.json();
        const msgs = cj2.chat_messages || [];
        const last = msgs[msgs.length - 1];
        if (!last || last.sender !== 'assistant') continue;
        const blocks = last.content || [];
        const hasToolResult = blocks.some(b => b && b.type === 'tool_result');
        const finalText = blocks.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('');
        const stopReason = String(last.stop_reason || '');
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
        } else { stable = 0; lastLen = finalText.length; }
      } catch (_e) { break; }
    }
  }` : '';

  const autoApproveReturnField = autoApprove ? ', approvals' : '';

  // Stringify all caller-controlled values via JSON.stringify so they're
  // safely embedded in the snippet (handles quotes, newlines, unicode).
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const org = orgMatch[1];
  const conv = ${JSON.stringify(convUuid)};

  // 1. Resolve parent_message_uuid (or use the caller-supplied one)
  let parent = ${opts.parentMessageUuid ? JSON.stringify(opts.parentMessageUuid) : 'null'};
  if (!parent) {
    const cr = await fetch('/api/organizations/' + org + '/chat_conversations/' + conv + '?tree=True&rendering_mode=messages&render_all_tools=true', {
      credentials: 'include',
      headers: { ...baseHeaders, 'Accept': '*/*' },
    });
    if (!cr.ok) return { error: 'read_conv_failed', status: cr.status };
    const cj = await cr.json();
    // Empty conversation → claude.ai's first-message convention is the all-zero "root" parent,
    // so create_conversation → completion works on the first turn (no dead-end on empty thread).
    parent = cj.current_leaf_message_uuid || '00000000-0000-4000-8000-000000000000';
  }

  // 2. Generate UUIDs for this turn (UUIDv4)
  const newUuid = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  };
  const humanMessageUuid = newUuid();
  const assistantMessageUuid = newUuid();

  const body = {
    prompt: ${JSON.stringify(prompt)},
    timezone: ${JSON.stringify(timezone)},
    personalized_styles: [{ type: 'default', key: 'Default', name: 'Normal', nameKey: 'normal_style_name', prompt: 'Normal\\n', summary: 'Default responses from Claude', summaryKey: 'normal_style_summary', isDefault: true }],
    locale: ${JSON.stringify(locale)},
    model: ${JSON.stringify(model)},
    tools: ${JSON.stringify(tools)},
    turn_message_uuids: { human_message_uuid: humanMessageUuid, assistant_message_uuid: assistantMessageUuid },
    attachments: ${JSON.stringify(attachments)},
    files: ${JSON.stringify(files)},
    sync_sources: ${JSON.stringify(syncSources)},
    rendering_mode: 'messages',
    parent_message_uuid: parent,
  };

${overlaySetup}
${autoApproveSetup}
  ${overlayStatus('Calling claude.ai /completion (streaming)…')}
  // 3. POST /completion and drain the SSE stream
  const url = '/api/organizations/' + org + '/chat_conversations/' + conv + '/completion';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...baseHeaders, 'accept': 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    ${overlayStatus('Fetch failed.', 'err')}
    ${overlayTearDown}
    return { error: 'fetch_failed', message: String(e && e.message || e) };
  }
  if (!res.ok || !res.body) {
    const text = await res.text();
    ${overlayStatus('HTTP error from claude.ai.', 'err')}
    ${overlayTearDown}
    return { error: 'http_error', status: res.status, statusText: res.statusText, body: text };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let text = '';
  let buf = '';
  // claude.ai sends event separators as CRLF (\\r\\n\\r\\n). Accept LF too.
  const SEP = /\\r\\n\\r\\n|\\n\\n/;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = SEP.exec(buf)) !== null) {
      const chunk = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const evM = chunk.match(/^event:\\s*(.+?)\\r?$/m);
      const dM = chunk.match(/^data:\\s*([\\s\\S]+?)\\r?$/m);
      if (!evM || !dM) continue;
      let parsed = dM[1].trim();
      try { parsed = JSON.parse(parsed); } catch {}
      events.push({ type: evM[1].trim(), data: parsed });
      if (parsed && typeof parsed === 'object') {
        if (parsed.delta && typeof parsed.delta.text === 'string') text += parsed.delta.text;
        else if (typeof parsed.completion === 'string') text += parsed.completion;
      }${autoApproveInLoop}
    }
  }${autoApprovePostSse}
  ${overlayStatus('Done.', 'ok')}
  // If THIS snippet installed the banner, auto-clear after a brief moment so
  // the user sees the "Done" state. If a persistent banner pre-existed
  // (installed via /claude-ai/browser/install-idle-banner), leave it up and
  // just reset its status to "Idle" — caller manages its lifecycle.
  ${showOverlay ? "setTimeout(() => { try { if (!__lmaPreExistingOverlay) { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.tearDown(); } else { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus('Idle. Waiting for next lm-assist request.', 'ok'); } } catch (_e) {} }, 2500);" : ''}
  return { status: res.status, statusText: res.statusText, eventCount: events.length, eventTypes: [...new Set(events.map(e => e.type))], text, humanMessageUuid, assistantMessageUuid${autoApproveReturnField} };
})()`;
  return {
    snippet,
    description: `Send message to claude.ai conversation ${convUuid} (WRITE; real account history)`,
    url: `https://claude.ai/api/organizations/{org}/chat_conversations/${convUuid}/completion`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' This snippet is a WRITE — it creates real message history in the user\'s claude.ai account and consumes tokens. Verify intent before running.',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Personal Agent Skills (skills CRUD) — via-chrome snippets
//
// Mirror of the cookie-file skills helpers in claudeai-session.ts. All hit
// /api/organizations/{org}/skills/* in the authenticated tab. Mutating ones
// carry the WRITE warning in `instructions`.
// ─────────────────────────────────────────────────────────────────────────

/** claude.ai's hard ceiling for an uploaded skill bundle (30 MiB). Must be `< this`. */
const MAX_SKILL_BUNDLE_BYTES = 31457280;

/**
 * Internal: build a JSON-POST snippet against a `/skills/<suffix>` endpoint.
 * Mirrors the body-embedding of snippetSetConversationTitle / snippetCreateConversation.
 */
function buildSkillsPostSnippet(opts: {
  suffix: string;
  query?: Record<string, string | number | boolean>;
  body: Record<string, unknown>;
  description: string;
  write?: boolean;
  destructive?: boolean;
}): ViaChromeSnippet {
  const qs = buildQuery(opts.query);
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const url = '/api/organizations/' + orgMatch[1] + '/skills/${opts.suffix}${qs}';
  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...baseHeaders, 'content-type': 'application/json', 'Accept': '*/*' },
      body: ${JSON.stringify(JSON.stringify(opts.body))},
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  let instructions = INSTRUCTIONS;
  if (opts.destructive) instructions += ' WRITE (DESTRUCTIVE) — permanently changes the user\'s claude.ai skills. Verify intent before running.';
  else if (opts.write) instructions += ' WRITE — modifies the user\'s claude.ai skills.';
  return {
    snippet,
    description: opts.description,
    url: `https://claude.ai/api/organizations/{org}/skills/${opts.suffix}${qs}`,
    method: 'POST',
    instructions,
  };
}

/** Snippet for listing the account's personal skills. */
export const snippetListSkills = (): ViaChromeSnippet =>
  buildViaChromeSnippet({ path: '/api/organizations/{org}/skills/list-skills', description: 'List personal claude.ai skills' });

/** Snippet for listing the file paths inside a skill (custom skills only; built-ins return []). */
export const snippetListSkillFiles = (skillId: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  return buildViaChromeSnippet({
    path: '/api/organizations/{org}/skills/list-skill-files',
    query: { skill_id: skillId },
    description: `List files in skill ${skillId}`,
  });
};

/**
 * Snippet that downloads a skill's `.skill` (zip) bundle and returns it as
 * base64.
 *
 * CRITICAL GOTCHA: Chrome MCP's content filter frequently blocks long base64
 * payloads, so the snippet's result may be dropped at the `javascript_tool`
 * boundary. For binary downloads prefer the cookie-file route
 * `GET /claude-ai/skills/:id/download`, which streams `application/zip`.
 */
export const snippetDownloadSkillBundle = (skillId: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  const qs = buildQuery({ skill_id: skillId });
  const fallbackName = JSON.stringify(`${skillId}.skill`);
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const url = '/api/organizations/' + orgMatch[1] + '/skills/download-dot-skill-file${qs}';
  try {
    const r = await fetch(url, { credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' } });
    if (!r.ok) {
      const text = await r.text();
      return { status: r.status, statusText: r.statusText, url, body: text };
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    // base64-encode in-page. WARNING: long base64 strings are often blocked by
    // Chrome MCP's content filter — prefer the cookie-file download route.
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const base64 = btoa(bin);
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\\*?=(?:UTF-8''|")?([^";]+)/i);
    let filename = ${fallbackName};
    if (m && m[1]) { try { filename = decodeURIComponent(m[1].replace(/"$/, '')); } catch (_e) { filename = m[1].replace(/"$/, ''); } }
    return { status: r.status, statusText: r.statusText, url, filename, contentType: r.headers.get('content-type') || 'application/zip', size: buf.length, base64 };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  return {
    snippet,
    description: `Download .skill bundle for ${skillId} (base64)`,
    url: `https://claude.ai/api/organizations/{org}/skills/download-dot-skill-file${qs}`,
    method: 'GET',
    instructions: INSTRUCTIONS + ' Returns the .skill (zip) as base64. CRITICAL GOTCHA: Chrome MCP\'s content filter frequently blocks long base64 payloads, so this snippet\'s result may be dropped at the tool boundary — for binary downloads prefer the cookie-file route GET /claude-ai/skills/:id/download (streams application/zip).',
  };
};

/** WRITE snippet — create a simple (single SKILL.md) skill. */
export const snippetCreateSkill = (opts: { name: string; description?: string; instructions?: string }): ViaChromeSnippet => {
  if (!opts.name) throw new Error('name required');
  return buildSkillsPostSnippet({
    suffix: 'create-simple-skill',
    body: { name: opts.name, description: opts.description ?? '', instructions: opts.instructions ?? '' },
    description: `Create skill "${opts.name}"`,
    write: true,
  });
};

/** WRITE snippet — edit a simple skill (VERSIONED: response carries a NEW id; name not editable). */
export const snippetEditSkill = (skillId: string, opts: { description?: string; instructions?: string } = {}): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  return buildSkillsPostSnippet({
    suffix: 'edit-simple-skill',
    body: { skill_id: skillId, description: opts.description ?? '', instructions: opts.instructions ?? '' },
    description: `Edit skill ${skillId} (versioned — returns a new id)`,
    write: true,
  });
};

/** WRITE snippet — enable a skill (id preserved). */
export const snippetEnableSkill = (skillId: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  return buildSkillsPostSnippet({ suffix: 'enable-skill', body: { skill_id: skillId }, description: `Enable skill ${skillId}`, write: true });
};

/** WRITE snippet — disable a skill (id preserved). */
export const snippetDisableSkill = (skillId: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  return buildSkillsPostSnippet({ suffix: 'disable-skill', body: { skill_id: skillId }, description: `Disable skill ${skillId}`, write: true });
};

/** WRITE (destructive) snippet — delete a skill. */
export const snippetDeleteSkill = (skillId: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  return buildSkillsPostSnippet({ suffix: 'delete-skill', body: { skill_id: skillId }, description: `Delete skill ${skillId}`, write: true, destructive: true });
};

/**
 * WRITE snippet — upload a skill bundle. Decodes the embedded base64 bundle
 * in-page, wraps it in a Blob, and POSTs it as multipart/form-data (part key
 * "file"). The bundle is embedded as base64, so large bundles produce a large
 * snippet; claude.ai hard-limits the zip to < 30 MiB.
 */
export const snippetUploadSkill = (opts: {
  filename: string;
  contentBase64: string;
  overwrite?: boolean;
  checkSkillName?: string;
  contentType?: string;
}): ViaChromeSnippet => {
  if (!opts.filename) throw new Error('filename required');
  if (!opts.contentBase64) throw new Error('contentBase64 required');
  const approxBytes = Math.floor((opts.contentBase64.length * 3) / 4);
  if (approxBytes >= MAX_SKILL_BUNDLE_BYTES) {
    throw new Error(`Skill bundle is ~${approxBytes} bytes; claude.ai's hard limit is < ${MAX_SKILL_BUNDLE_BYTES} bytes (30 MiB).`);
  }
  const query: Record<string, string | number | boolean> = { overwrite: opts.overwrite ?? false };
  if (opts.checkSkillName) query.check_skill_name = opts.checkSkillName;
  const qs = buildQuery(query);
  const contentType = opts.contentType
    || (/\.(zip|skill)$/i.test(opts.filename) ? 'application/zip' : /\.md$/i.test(opts.filename) ? 'text/markdown' : 'application/octet-stream');
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const url = '/api/organizations/' + orgMatch[1] + '/skills/upload-skill${qs}';
  // Decode the embedded base64 bundle into bytes and post as multipart "file".
  const bin = atob(${JSON.stringify(opts.contentBase64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: ${JSON.stringify(contentType)} }), ${JSON.stringify(opts.filename)});
  try {
    // No 'content-type' header — the browser sets multipart/form-data + boundary.
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' }, body: form });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e && e.message || e), url };
  }
})()`;
  return {
    snippet,
    description: `Upload skill bundle ${opts.filename}`,
    url: `https://claude.ai/api/organizations/{org}/skills/upload-skill${qs}`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE — uploads a skill bundle to the user\'s claude.ai account. The bundle is embedded as base64, so large bundles make a large snippet (claude.ai hard-limits the zip to < 30 MiB).',
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Native skill passthroughs — rename / duplicate / delete-org (via-chrome)
//
// Body shapes confirmed from the web SPA bundle:
//   rename-skill     {skill_id, new_name}
//   duplicate-skill  {skill_id, new_name}
//   delete-org-skill {skill_id}
// ─────────────────────────────────────────────────────────────────────────

/** WRITE snippet — rename a skill (in place; id preserved). */
export const snippetRenameSkill = (skillId: string, newName: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  if (!newName) throw new Error('newName required');
  return buildSkillsPostSnippet({
    suffix: 'rename-skill',
    body: { skill_id: skillId, new_name: newName },
    description: `Rename skill ${skillId} to "${newName}"`,
    write: true,
  });
};

/** WRITE snippet — duplicate a skill. `new_name` is sent only when provided (the SPA always sends it). */
export const snippetDuplicateSkill = (skillId: string, newName?: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  const body: Record<string, unknown> = { skill_id: skillId };
  if (newName) body.new_name = newName;
  return buildSkillsPostSnippet({
    suffix: 'duplicate-skill',
    body,
    description: `Duplicate skill ${skillId}${newName ? ` as "${newName}"` : ''}`,
    write: true,
  });
};

/** WRITE (destructive) snippet — delete an ORG-shared skill (distinct from the personal delete-skill). */
export const snippetDeleteOrgSkill = (skillId: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  return buildSkillsPostSnippet({
    suffix: 'delete-org-skill',
    body: { skill_id: skillId },
    description: `Delete ORG skill ${skillId}`,
    write: true,
    destructive: true,
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Per-file skill CRUD (via-chrome) — synthesized read-modify-write in-page
//
// claude.ai has NO native per-file write endpoint, so these snippets do the
// whole read-modify-write inside the tab: download the `.skill` bundle, unzip
// it, add/replace/remove one entry, rezip, and re-upload with overwrite. ZIP
// codec uses the browser-native DecompressionStream / CompressionStream
// ('deflate-raw') plus a small CRC-32 — the same scheme as the cookie-file
// helpers in claudeai-session.ts. Identity is preserved (top folder, SKILL.md
// name, disabled state), so overwrite replaces the SAME skill.
//
// NOTE: the READ snippet returns the file as base64 (Chrome MCP's content
// filter frequently blocks long base64 payloads — prefer the cookie-file
// GET /claude-ai/skills/:id/file for reads).
// ─────────────────────────────────────────────────────────────────────────

// In-page ZIP codec + bundle helpers, shared by the read/put/delete snippets.
// Defined as plain functions so they don't capture outer scope; the upload
// helper takes `org` + `baseHeaders` as parameters.
const SKILL_FILE_CODEC_JS = `
  const lmCrcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function lmCrc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = (lmCrcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8)) >>> 0; return (c ^ 0xFFFFFFFF) >>> 0; }
  async function lmInflateRaw(u8) { if (!u8.length) return new Uint8Array(0); const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function lmDeflateRaw(u8) { if (!u8.length) return new Uint8Array(0); const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  function lmConcat(arrs) { let len = 0; for (const a of arrs) len += a.length; const out = new Uint8Array(len); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }
  async function lmUnzip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
    let eocd = -1; const minStart = Math.max(0, bytes.length - 22 - 0xffff);
    for (let i = bytes.length - 22; i >= minStart; i--) { if (u32(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('EOCD not found');
    const cdCount = u16(eocd + 10), cdOffset = u32(eocd + 16);
    const entries = []; let p = cdOffset; const dec = new TextDecoder();
    for (let i = 0; i < cdCount; i++) {
      if (u32(p) !== 0x02014b50) throw new Error('bad central header @' + p);
      const method = u16(p + 10), compSize = u32(p + 20), nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32), localOff = u32(p + 42);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (u32(localOff) !== 0x04034b50) throw new Error('bad local header for ' + name);
      const dataStart = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      let data; if (method === 0) data = comp.slice(); else if (method === 8) data = await lmInflateRaw(comp); else throw new Error('unsupported method ' + method + ' for ' + name);
      entries.push({ name: name, data: data, isDirectory: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }
  async function lmZip(entries) {
    const enc = new TextEncoder(); const locals = [], centrals = []; let offset = 0;
    for (const e of entries) {
      const nameBuf = enc.encode(e.name); const flags = 0x0800;
      let method, stored, crc, uncomp;
      if (e.isDirectory) { method = 0; stored = new Uint8Array(0); crc = 0; uncomp = 0; }
      else { uncomp = e.data.length; crc = lmCrc32(e.data); const def = await lmDeflateRaw(e.data); if (def.length < e.data.length) { method = 8; stored = def; } else { method = 0; stored = e.data; } }
      const lfh = new Uint8Array(30); const ld = new DataView(lfh.buffer);
      ld.setUint32(0, 0x04034b50, true); ld.setUint16(4, 20, true); ld.setUint16(6, flags, true); ld.setUint16(8, method, true); ld.setUint16(10, 0, true); ld.setUint16(12, 0x21, true); ld.setUint32(14, crc, true); ld.setUint32(18, stored.length, true); ld.setUint32(22, uncomp, true); ld.setUint16(26, nameBuf.length, true); ld.setUint16(28, 0, true);
      locals.push(lfh, nameBuf, stored);
      const cdh = new Uint8Array(46); const cd = new DataView(cdh.buffer);
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, flags, true); cd.setUint16(10, method, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true); cd.setUint32(20, stored.length, true); cd.setUint32(24, uncomp, true); cd.setUint16(28, nameBuf.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, e.isDirectory ? 0x10 : 0, true); cd.setUint32(42, offset, true);
      centrals.push(cdh, nameBuf); offset += lfh.length + nameBuf.length + stored.length;
    }
    const localBuf = lmConcat(locals), centralBuf = lmConcat(centrals);
    const eocd = new Uint8Array(22); const ed = new DataView(eocd.buffer);
    ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, entries.length, true); ed.setUint16(10, entries.length, true); ed.setUint32(12, centralBuf.length, true); ed.setUint32(16, localBuf.length, true); ed.setUint16(20, 0, true);
    return lmConcat([localBuf, centralBuf, eocd]);
  }
  function lmTopFolder(entries) {
    const sm = entries.find((e) => !e.isDirectory && e.name.split('/').pop() === 'SKILL.md');
    if (sm) { const i = sm.name.lastIndexOf('/'); return i >= 0 ? sm.name.slice(0, i) : ''; }
    const firsts = new Set(entries.filter((e) => e.name.includes('/')).map((e) => e.name.split('/')[0]));
    return firsts.size === 1 ? Array.from(firsts)[0] : '';
  }
  function lmNormPath(p) { return String(p || '').replace(/^[.][/]/, '').replace(/^[/]+/, ''); }
  function lmResolve(entries, wantPath) {
    const norm = lmNormPath(wantPath), top = lmTopFolder(entries);
    if (entries.some((e) => e.name === norm)) return { full: norm, top: top };
    if (top && (norm === top || norm.indexOf(top + '/') === 0)) return { full: norm, top: top };
    return { full: top ? (top + '/' + norm) : norm, top: top };
  }
  function lmSkillMdName(md) {
    const lines = md.split('\\n').map((l) => l.replace(/\\r$/, ''));
    if (lines[0] !== '---') return null;
    for (let i = 1; i < lines.length; i++) { if (lines[i] === '---') break; const m = lines[i].match(/^name:\\s*(.*)$/); if (m) { let v = m[1].trim(); if (v.length >= 2 && ((v[0] === '"' && v[v.length-1] === '"') || (v[0] === "'" && v[v.length-1] === "'"))) v = v.slice(1, -1); return v; } }
    return null;
  }
  function lmSetSkillMdName(md, name) {
    const lines = md.split('\\n'); if (lines[0].replace(/\\r$/, '') !== '---') return md;
    const q = JSON.stringify(name); let replaced = false;
    for (let i = 1; i < lines.length; i++) { const bare = lines[i].replace(/\\r$/, ''); if (bare === '---') break; if (/^name:/.test(bare)) { lines[i] = 'name: ' + q; replaced = true; break; } }
    if (!replaced) lines.splice(1, 0, 'name: ' + q);
    return lines.join('\\n');
  }
  async function lmRebuildUpload(org, baseHeaders, entries, skillName, oldSkillId) {
    const rebuilt = await lmZip(entries);
    if (rebuilt.length >= 31457280) return { error: 'bundle_too_large', size: rebuilt.length };
    let wasDisabled = false;
    try { const lr = await fetch('/api/organizations/' + org + '/skills/list-skills', { credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' } }); if (lr.ok) { const lj = await lr.json(); const arr = Array.isArray(lj) ? lj : ((lj && lj.skills) || []); const rec = arr.find((s) => (s.id || s.skill_id || s.skillId) === oldSkillId); wasDisabled = !!(rec && rec.enabled === false); } } catch (e) {}
    const q = new URLSearchParams({ overwrite: 'true' }); if (skillName) q.append('check_skill_name', skillName);
    const upUrl = '/api/organizations/' + org + '/skills/upload-skill?' + q;
    const form = new FormData(); form.append('file', new Blob([rebuilt], { type: 'application/zip' }), (skillName || 'skill') + '.zip');
    const ur = await fetch(upUrl, { method: 'POST', credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' }, body: form });
    const ut = await ur.text(); let ub; try { ub = ut ? JSON.parse(ut) : null; } catch (e) { ub = ut; }
    let newSkillId = null; if (ub && ub.skill) newSkillId = ub.skill.id || ub.skill.skill_id || ub.skill.skillId || null; if (!newSkillId && ub) newSkillId = ub.id || ub.skill_id || ub.skillId || null;
    let reDisabled = false;
    if (ur.ok && wasDisabled && newSkillId) { try { const dr = await fetch('/api/organizations/' + org + '/skills/disable-skill', { method: 'POST', credentials: 'include', headers: { ...baseHeaders, 'content-type': 'application/json', 'Accept': '*/*' }, body: JSON.stringify({ skill_id: newSkillId }) }); reDisabled = dr.ok; } catch (e) {} }
    return { status: ur.status, statusText: ur.statusText, url: upUrl, newSkillId: newSkillId, skillName: skillName, entryCount: entries.length, bundleBytes: rebuilt.length, reDisabled: reDisabled, body: ub };
  }
`;

/**
 * READ snippet — extract one file from a skill bundle (in-page download +
 * unzip), returning it as base64. CRITICAL GOTCHA: Chrome MCP's content filter
 * frequently blocks long base64 payloads, so the result may be dropped at the
 * `javascript_tool` boundary — prefer the cookie-file GET /claude-ai/skills/:id/file.
 */
export const snippetReadSkillFile = (skillId: string, filePath: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  if (!filePath) throw new Error('path required');
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}${SKILL_FILE_CODEC_JS}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const org = orgMatch[1];
  const skillId = ${JSON.stringify(skillId)};
  const wantPath = ${JSON.stringify(filePath)};
  const dlUrl = '/api/organizations/' + org + '/skills/download-dot-skill-file?skill_id=' + encodeURIComponent(skillId);
  let r; try { r = await fetch(dlUrl, { credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' } }); } catch (e) { return { error: 'fetch_failed', message: String(e && e.message || e), url: dlUrl }; }
  if (!r.ok) { const t = await r.text(); return { status: r.status, statusText: r.statusText, url: dlUrl, body: t }; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  let entries; try { entries = await lmUnzip(bytes); } catch (e) { return { error: 'unzip_failed', message: String(e && e.message || e) }; }
  const res = lmResolve(entries, wantPath);
  const entry = entries.find((e) => e.name === res.full && !e.isDirectory);
  if (!entry) return { found: false, resolvedPath: res.full, files: entries.filter((e) => !e.isDirectory).map((e) => e.name) };
  let bin = ''; for (let i = 0; i < entry.data.length; i++) bin += String.fromCharCode(entry.data[i]);
  return { found: true, resolvedPath: res.full, size: entry.data.length, base64: btoa(bin) };
})()`;
  return {
    snippet,
    description: `Read file "${filePath}" from skill ${skillId} (base64)`,
    url: `https://claude.ai/api/organizations/{org}/skills/download-dot-skill-file?skill_id=${encodeURIComponent(skillId)}`,
    method: 'GET',
    instructions: INSTRUCTIONS + ' Returns the file as base64. CRITICAL GOTCHA: Chrome MCP\'s content filter frequently blocks long base64 — for file reads prefer the cookie-file route GET /claude-ai/skills/:id/file (streams the bytes with a detected content-type).',
  };
};

/**
 * WRITE snippet — add/replace one file in a skill bundle via in-page
 * read-modify-write (download → unzip → set entry → rezip → upload overwrite).
 * `contentBase64` carries the new file bytes. Mints a NEW skill id; preserves
 * the top folder, SKILL.md name (pinned on a SKILL.md write), and disabled state.
 */
export const snippetPutSkillFile = (skillId: string, filePath: string, contentBase64: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  if (!filePath) throw new Error('path required');
  if (typeof contentBase64 !== 'string') throw new Error('contentBase64 required');
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}${SKILL_FILE_CODEC_JS}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const org = orgMatch[1];
  const skillId = ${JSON.stringify(skillId)};
  const wantPath = ${JSON.stringify(filePath)};
  const cbin = atob(${JSON.stringify(contentBase64)}); const content = new Uint8Array(cbin.length); for (let i = 0; i < cbin.length; i++) content[i] = cbin.charCodeAt(i);
  const dlUrl = '/api/organizations/' + org + '/skills/download-dot-skill-file?skill_id=' + encodeURIComponent(skillId);
  let r; try { r = await fetch(dlUrl, { credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' } }); } catch (e) { return { error: 'fetch_failed', message: String(e && e.message || e), url: dlUrl }; }
  if (!r.ok) { const t = await r.text(); return { error: 'download_failed', status: r.status, statusText: r.statusText, url: dlUrl, body: t }; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  let entries; try { entries = await lmUnzip(bytes); } catch (e) { return { error: 'unzip_failed', message: String(e && e.message || e) }; }
  const res = lmResolve(entries, wantPath);
  const smEntry = entries.find((e) => !e.isDirectory && e.name.split('/').pop() === 'SKILL.md');
  const skillName = smEntry ? lmSkillMdName(new TextDecoder().decode(smEntry.data)) : null;
  let newData = content;
  if (res.full.split('/').pop() === 'SKILL.md' && skillName) newData = new TextEncoder().encode(lmSetSkillMdName(new TextDecoder().decode(content), skillName));
  const idx = entries.findIndex((e) => e.name === res.full);
  if (idx >= 0) entries[idx] = { name: res.full, data: newData, isDirectory: false }; else entries.push({ name: res.full, data: newData, isDirectory: false });
  const out = await lmRebuildUpload(org, baseHeaders, entries, skillName, skillId);
  return { ...out, resolvedPath: res.full };
})()`;
  return {
    snippet,
    description: `Put file "${filePath}" into skill ${skillId} (read-modify-write)`,
    url: `https://claude.ai/api/organizations/{org}/skills/upload-skill?overwrite=true`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE — read-modify-write of the whole skill bundle (download → unzip → set file → rezip → upload overwrite). Mints a NEW skill id (returned as `newSkillId`); the content is embedded as base64 so a large file makes a large snippet (the rebuilt zip must stay < 30 MiB).',
  };
};

/**
 * WRITE (destructive) snippet — remove one file from a skill bundle via in-page
 * read-modify-write. Errors if the path is absent; refuses to delete SKILL.md.
 * Mints a NEW skill id; preserves the top folder, SKILL.md name, and disabled state.
 */
export const snippetDeleteSkillFile = (skillId: string, filePath: string): ViaChromeSnippet => {
  if (!skillId) throw new Error('skillId required');
  if (!filePath) throw new Error('path required');
  const snippet = `(async () => {${CLAUDEAI_HEADER_SNIPPET}${SKILL_FILE_CODEC_JS}
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch) return { error: 'no_org' };
  const org = orgMatch[1];
  const skillId = ${JSON.stringify(skillId)};
  const wantPath = ${JSON.stringify(filePath)};
  const dlUrl = '/api/organizations/' + org + '/skills/download-dot-skill-file?skill_id=' + encodeURIComponent(skillId);
  let r; try { r = await fetch(dlUrl, { credentials: 'include', headers: { ...baseHeaders, 'Accept': '*/*' } }); } catch (e) { return { error: 'fetch_failed', message: String(e && e.message || e), url: dlUrl }; }
  if (!r.ok) { const t = await r.text(); return { error: 'download_failed', status: r.status, statusText: r.statusText, url: dlUrl, body: t }; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  let entries; try { entries = await lmUnzip(bytes); } catch (e) { return { error: 'unzip_failed', message: String(e && e.message || e) }; }
  const res = lmResolve(entries, wantPath);
  const idx = entries.findIndex((e) => e.name === res.full && !e.isDirectory);
  if (idx < 0) return { error: 'file_not_found', resolvedPath: res.full, files: entries.filter((e) => !e.isDirectory).map((e) => e.name) };
  if (res.full.split('/').pop() === 'SKILL.md') return { error: 'refusing_to_delete_skill_md', resolvedPath: res.full };
  const smEntry = entries.find((e) => !e.isDirectory && e.name.split('/').pop() === 'SKILL.md');
  const skillName = smEntry ? lmSkillMdName(new TextDecoder().decode(smEntry.data)) : null;
  entries.splice(idx, 1);
  const out = await lmRebuildUpload(org, baseHeaders, entries, skillName, skillId);
  return { ...out, resolvedPath: res.full };
})()`;
  return {
    snippet,
    description: `Delete file "${filePath}" from skill ${skillId} (read-modify-write)`,
    url: `https://claude.ai/api/organizations/{org}/skills/upload-skill?overwrite=true`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE (DESTRUCTIVE) — read-modify-write removing one file from the bundle, then upload overwrite. Mints a NEW skill id (returned as `newSkillId`). Refuses to delete SKILL.md.',
  };
};
