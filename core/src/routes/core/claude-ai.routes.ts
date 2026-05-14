/**
 * claude.ai Web Session Routes
 *
 * Two parallel families:
 *
 * (1) Cookie-file path — for headless callers (cron, dashboards). Reads
 *     ~/.claude/claudeai-session.json and makes the call from Node.
 *
 *   GET  /claude-ai/session-status        Presence/identity (no secrets)
 *   GET  /claude-ai/conversations         List conversations (chat_conversations_v2)
 *   GET  /claude-ai/conversations/:uuid   Read one conversation (full tree)
 *   GET  /claude-ai/projects              List projects
 *
 * (2) Via-Chrome path — for interactive callers that already have Chrome
 *     MCP loaded. Returns a JS snippet to paste into
 *     mcp__claude-in-chrome__javascript_tool inside an authenticated
 *     claude.ai tab. No cookie file needed.
 *
 *   POST /claude-ai/via-chrome                   Generic snippet for any /api/ path
 *   POST /claude-ai/via-chrome/conversations     Snippet to list conversations
 *   POST /claude-ai/via-chrome/conversations/:uuid  Snippet to read one conversation
 *   POST /claude-ai/via-chrome/projects          Snippet to list projects
 *
 * Header fingerprint of family (1) matches a real claude.ai web request
 * observed via lm-proxy. Family (2) reuses the real browser's outbound
 * fingerprint because the request is made by the page itself.
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  getClaudeAISessionStatus,
  listConversations,
  readConversation,
  listProjects,
  getMemory,
  getBootstrapAppStart,
  getArtifactVersions,
} from '../../utils/claudeai-session';
import {
  buildViaChromeSnippet,
  snippetListConversations,
  snippetReadConversation,
  snippetListProjects,
  snippetGetMemory,
  snippetBootstrapAppStart,
  snippetArtifactVersions,
} from '../../utils/claudeai-via-chrome';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function upstreamWrap<T>(r: { status: number; statusText: string; body: T }) {
  if (r.status >= 400) {
    return {
      success: false,
      error: {
        code: `UPSTREAM_${r.status}`,
        message: `claude.ai responded ${r.status} ${r.statusText}`,
      },
      data: r.body,
    };
  }
  return { success: true, data: r.body };
}

function catchOAuth(err: unknown) {
  return {
    success: false,
    error: { code: 'CLAUDEAI_SESSION_UNAVAILABLE', message: (err as Error).message },
  };
}

export function createClaudeAIRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /claude-ai/session-status
    {
      method: 'GET',
      pattern: /^\/claude-ai\/session-status$/,
      handler: async () => ({ success: true, data: getClaudeAISessionStatus() }),
    },

    // GET /claude-ai/conversations?limit=30&starred=false&project_uuid=...
    {
      method: 'GET',
      pattern: /^\/claude-ai\/conversations$/,
      handler: async (req) => {
        try {
          const q = req.query || {};
          const extraQuery: Record<string, string> = {};
          if (typeof q.project_uuid === 'string') extraQuery.project_uuid = q.project_uuid;
          const r = await listConversations({
            limit: typeof q.limit === 'string' ? parseInt(q.limit, 10) || undefined : undefined,
            starred: q.starred === 'true' ? true : q.starred === 'false' ? false : undefined,
            consistency: q.consistency === 'strong' ? 'strong' : undefined,
            extraQuery: Object.keys(extraQuery).length ? extraQuery : undefined,
          });
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/conversations/:uuid
    {
      method: 'GET',
      pattern: /^\/claude-ai\/conversations\/(?<uuid>[^/?]+)$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Conversation UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        try {
          const q = req.query || {};
          const r = await readConversation(uuid, {
            tree: q.tree === 'false' ? false : true,
            renderAllTools: q.render_all_tools === 'false' ? false : true,
            renderingMode: typeof q.rendering_mode === 'string' ? q.rendering_mode : undefined,
          });
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/projects
    {
      method: 'GET',
      pattern: /^\/claude-ai\/projects$/,
      handler: async (req) => {
        try {
          const q = req.query || {};
          const cf = q.creator_filter === 'is_creator' || q.creator_filter === 'is_not_creator'
            ? q.creator_filter
            : undefined;
          const r = await listProjects({
            limit: typeof q.limit === 'string' ? parseInt(q.limit, 10) || undefined : undefined,
            includeHarmonyProjects: q.include_harmony_projects === 'false' ? false : true,
            creatorFilter: cf,
          });
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/memory
    {
      method: 'GET',
      pattern: /^\/claude-ai\/memory$/,
      handler: async () => {
        try {
          return upstreamWrap(await getMemory());
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/bootstrap
    {
      method: 'GET',
      pattern: /^\/claude-ai\/bootstrap$/,
      handler: async () => {
        try {
          return upstreamWrap(await getBootstrapAppStart());
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/artifacts/:uuid/versions
    {
      method: 'GET',
      pattern: /^\/claude-ai\/artifacts\/(?<uuid>[^/?]+)\/versions$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Artifact UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        try {
          return upstreamWrap(await getArtifactVersions(uuid));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // ---- Via-Chrome path (returns JS snippets for javascript_tool) ----
    //
    // These don't actually call claude.ai. They emit a JS snippet meant to
    // be passed verbatim to mcp__claude-in-chrome__javascript_tool inside
    // an authenticated claude.ai tab. The browser does the call; the page
    // returns the JSON result via the tool's return value.

    // POST /claude-ai/via-chrome
    //   Body: { path: "/api/organizations/{org}/...", query?: {...} }
    //   The literal {org} placeholder in `path` is replaced at runtime by
    //   the snippet's JS using the lastActiveOrg cookie.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome$/,
      handler: async (req) => {
        const body = req.body || {};
        if (typeof body.path !== 'string' || !body.path) {
          return {
            success: false,
            error: { code: 'MISSING_PATH', message: 'body.path is required' },
          };
        }
        try {
          const out = buildViaChromeSnippet({
            path: body.path,
            query: typeof body.query === 'object' && body.query ? body.query : undefined,
            description: typeof body.description === 'string' ? body.description : undefined,
          });
          return { success: true, data: out };
        } catch (err) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: (err as Error).message },
          };
        }
      },
    },

    // POST /claude-ai/via-chrome/conversations
    //   Body: { limit?, starred?, consistency?, projectUuid? }
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/conversations$/,
      handler: async (req) => {
        const b = req.body || {};
        try {
          const out = snippetListConversations({
            limit: typeof b.limit === 'number' ? b.limit : undefined,
            starred: typeof b.starred === 'boolean' ? b.starred : undefined,
            consistency: b.consistency === 'strong' || b.consistency === 'eventual' ? b.consistency : undefined,
            projectUuid: typeof b.projectUuid === 'string' ? b.projectUuid : undefined,
          });
          return { success: true, data: out };
        } catch (err) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: (err as Error).message },
          };
        }
      },
    },

    // POST /claude-ai/via-chrome/conversations/:uuid
    //   Body: { tree?, renderingMode?, renderAllTools? }
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/conversations\/(?<uuid>[^/?]+)$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        const b = req.body || {};
        try {
          const out = snippetReadConversation(uuid, {
            tree: typeof b.tree === 'boolean' ? b.tree : undefined,
            renderingMode: typeof b.renderingMode === 'string' ? b.renderingMode : undefined,
            renderAllTools: typeof b.renderAllTools === 'boolean' ? b.renderAllTools : undefined,
          });
          return { success: true, data: out };
        } catch (err) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: (err as Error).message },
          };
        }
      },
    },

    // POST /claude-ai/via-chrome/projects
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/projects$/,
      handler: async (req) => {
        const b = req.body || {};
        try {
          const cf = b.creatorFilter === 'is_creator' || b.creatorFilter === 'is_not_creator'
            ? b.creatorFilter
            : undefined;
          const out = snippetListProjects({
            limit: typeof b.limit === 'number' ? b.limit : undefined,
            includeHarmonyProjects: typeof b.includeHarmonyProjects === 'boolean' ? b.includeHarmonyProjects : undefined,
            creatorFilter: cf,
          });
          return { success: true, data: out };
        } catch (err) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: (err as Error).message },
          };
        }
      },
    },

    // POST /claude-ai/via-chrome/memory
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/memory$/,
      handler: async () => ({ success: true, data: snippetGetMemory() }),
    },

    // POST /claude-ai/via-chrome/bootstrap
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/bootstrap$/,
      handler: async () => ({ success: true, data: snippetBootstrapAppStart() }),
    },

    // POST /claude-ai/via-chrome/artifacts/:uuid/versions
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/artifacts\/(?<uuid>[^/?]+)\/versions$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Artifact UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        try {
          return { success: true, data: snippetArtifactVersions(uuid) };
        } catch (err) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: (err as Error).message },
          };
        }
      },
    },
  ];
}
