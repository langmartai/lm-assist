/**
 * claude.ai Web Session Routes
 *
 * Endpoints that proxy the claude.ai web backend (conversation list/read,
 * projects list) using a user-supplied browser session cookie.
 *
 *   GET /claude-ai/session-status         Presence/identity (no secrets)
 *   GET /claude-ai/conversations          List conversations (chat_conversations_v2)
 *   GET /claude-ai/conversations/:uuid    Read one conversation (full tree)
 *   GET /claude-ai/projects               List projects
 *
 * Header fingerprint matches a real claude.ai web request observed via
 * lm-proxy. See utils/claudeai-session.ts for the full discussion.
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  getClaudeAISessionStatus,
  listConversations,
  readConversation,
  listProjects,
} from '../../utils/claudeai-session';

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
  ];
}
