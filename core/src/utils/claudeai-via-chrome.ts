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

export interface ViaChromeSnippet {
  /** JS code suitable for mcp__claude-in-chrome__javascript_tool. */
  snippet: string;
  /** Human-readable description of what the snippet does. */
  description: string;
  /** Expected URL pattern the snippet hits (with {org} placeholder). */
  url: string;
  /** Method (always GET in v1). */
  method: 'GET';
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

  // Snippet returns { status, statusText, body } from the page context.
  // We do not attempt to forge anthropic-client-* headers here — the
  // page is real Chrome, so its outbound fingerprint already matches.
  // Browser auto-includes all cookies because credentials:'include' on
  // a same-origin URL.
  const snippet = `(async () => {
  const orgMatch = document.cookie.match(/lastActiveOrg=(${UUID_RE_STR})/i);
  if (!orgMatch && ${JSON.stringify(fullPath).includes('{org}') ? 'true' : 'false'}) {
    return { error: 'no_org', message: 'lastActiveOrg cookie not present; are you logged in to claude.ai?' };
  }
  const org = orgMatch ? orgMatch[1] : '';
  const url = ${JSON.stringify(fullPath)}.replace('{org}', org);
  try {
    const r = await fetch(url, { credentials: 'include', headers: { 'Accept': '*/*' } });
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
