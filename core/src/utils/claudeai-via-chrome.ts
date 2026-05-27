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
    parent = cj.current_leaf_message_uuid;
    if (!parent) return { error: 'no_leaf_message_uuid' };
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
