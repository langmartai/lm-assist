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

/** Snippet for reading an artifact's version history. */
export function snippetArtifactVersions(artifactUuid: string): ViaChromeSnippet {
  if (!UUID_RE.test(artifactUuid)) throw new Error(`Invalid artifact UUID: ${artifactUuid}`);
  return buildViaChromeSnippet({
    path: `/api/organizations/{org}/artifacts/${artifactUuid}/versions`,
    description: `Read versions of artifact ${artifactUuid}`,
  });
}

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
} = {}): ViaChromeSnippet {
  if (!UUID_RE.test(convUuid)) throw new Error(`Invalid conversation UUID: ${convUuid}`);
  const model = opts.model ?? 'claude-opus-4-7';
  const timezone = opts.timezone ?? 'UTC';
  const locale = opts.locale ?? 'en-US';
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
    tools: [],
    turn_message_uuids: { human_message_uuid: humanMessageUuid, assistant_message_uuid: assistantMessageUuid },
    attachments: [],
    files: [],
    sync_sources: [],
    rendering_mode: 'messages',
    parent_message_uuid: parent,
  };

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
    return { error: 'fetch_failed', message: String(e && e.message || e) };
  }
  if (!res.ok || !res.body) {
    const text = await res.text();
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
      }
    }
  }
  return { status: res.status, statusText: res.statusText, eventCount: events.length, eventTypes: [...new Set(events.map(e => e.type))], text, humanMessageUuid, assistantMessageUuid };
})()`;
  return {
    snippet,
    description: `Send message to claude.ai conversation ${convUuid} (WRITE; real account history)`,
    url: `https://claude.ai/api/organizations/{org}/chat_conversations/${convUuid}/completion`,
    method: 'POST',
    instructions: INSTRUCTIONS + ' This snippet is a WRITE — it creates real message history in the user\'s claude.ai account and consumes tokens. Verify intent before running.',
  };
}
