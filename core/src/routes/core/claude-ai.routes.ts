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
  probeClaudeAISession,
  listConversations,
  readConversation,
  listProjects,
  getMemory,
  getBootstrapAppStart,
  getArtifactVersions,
  sendMessage,
  getAccountProfile,
  getOrgInfo,
  getSubscriptionDetails,
  getOrgUsage,
  listOrgSkills,
  getOrgMcpBootstrap,
  listOrgStyles,
  getModelConfig,
  getMemorySettings,
  getCoworkSettings,
  getSyncSettings,
  getGdriveProgress,
  getNotificationPreferences,
  listInvites,
  getCurrentUserAccess,
  listActiveSessions,
  setConversationTitle,
  createConversation,
  deleteConversation,
} from '../../utils/claudeai-session';
import {
  buildViaChromeSnippet,
  snippetListConversations,
  snippetReadConversation,
  snippetListProjects,
  snippetGetMemory,
  snippetBootstrapAppStart,
  snippetArtifactVersions,
  snippetSendMessage,
  snippetHealthCheck,
  snippetAccountProfile,
  snippetOrgInfo,
  snippetSubscriptionDetails,
  snippetOrgUsage,
  snippetListOrgSkills,
  snippetListOrgStyles,
  snippetModelConfig,
  snippetMemorySettings,
  snippetCoworkSettings,
  snippetSyncSettings,
  snippetGdriveProgress,
  snippetNotificationPreferences,
  snippetCurrentUserAccess,
  snippetListInvites,
  snippetListActiveSessions,
  snippetMcpBootstrap,
  snippetSetConversationTitle,
  snippetCreateConversation,
  snippetDeleteConversation,
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
  const msg = (err as Error).message || String(err);
  // Differentiate "no session file" from other failures so the UI can
  // route the right action (paste cookies vs. refresh cookies vs. fix
  // the network).
  if (/No claude\.ai session/.test(msg)) {
    return {
      success: false,
      error: {
        code: 'CLAUDEAI_SESSION_NOT_CONFIGURED',
        message: msg,
        hint: 'Call GET /claude-ai/session-status?probe=true (or /claude-ai/healthz) for a structured diagnosis, then create ~/.claude/claudeai-session.json per docs/claude-ai-routes.md.',
      },
    };
  }
  return {
    success: false,
    error: { code: 'CLAUDEAI_SESSION_UNAVAILABLE', message: msg },
  };
}

export function createClaudeAIRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /claude-ai/session-status[?probe=true]
    //
    //   Without ?probe: file-based check only (presence of config, cookie
    //   shape, identity values).
    //   With ?probe=true: actively call /api/account_profile and report
    //   whether the session is live. Distinguishes session_expired,
    //   cloudflare_blocked, network_error, upstream_error.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/session-status$/,
      handler: async (req) => {
        const status = getClaudeAISessionStatus();
        const wantProbe = (req.query || {}).probe === 'true';
        if (!wantProbe) return { success: true, data: status };
        const probe = await probeClaudeAISession();
        return { success: true, data: { ...status, probe } };
      },
    },

    // GET /claude-ai/healthz
    //   Convenience shortcut for the cookie-file health check.
    //   Equivalent to GET /claude-ai/session-status?probe=true with the
    //   probe verdict hoisted to the top level for a one-glance check.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/healthz$/,
      handler: async () => {
        const status = getClaudeAISessionStatus();
        const probe = await probeClaudeAISession();
        return {
          success: true,
          data: {
            ok: probe.ok,
            reason: probe.reason,
            hint: probe.hint,
            sessionConfigured: status.present,
            sessionPath: status.sessionPath,
            identity: status.identity,
            cookieFreshness: {
              hasSessionKey: status.hasSessionKey,
              hasCfClearance: status.hasCfClearance,
              hasCfBm: status.hasCfBm,
            },
            probe,
          },
        };
      },
    },

    // POST /claude-ai/via-chrome/health-check
    //   Returns a snippet the agent runs in any tab. The snippet checks
    //   that the tab is on claude.ai, the user is logged in, and
    //   /api/account_profile returns 200. Designed to be the first call
    //   before driving any other via-chrome route.
    //
    //   (Cannot be checked directly from lm-assist because Chrome MCP is
    //   only reachable from the agent side.)
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/health-check$/,
      handler: async () => ({ success: true, data: snippetHealthCheck() }),
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

    // POST /claude-ai/conversations
    //   Body: { name?, uuid? }
    //
    //   WRITE — creates a new, empty conversation. Method differs from the
    //   GET list route above (same pattern), so the router's method check
    //   keeps them distinct. Returns { ...upstream, uuid } so the caller
    //   knows the new conversation id even on a 204/empty body.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/conversations$/,
      handler: async (req) => {
        try {
          const b = req.body || {};
          const r = await createConversation({
            name: typeof b.name === 'string' ? b.name : undefined,
            uuid: typeof b.uuid === 'string' ? b.uuid : undefined,
          });
          const wrapped = upstreamWrap(r);
          if (wrapped.success) (wrapped as { data: unknown }).data = { ...r.body, uuid: r.uuid };
          return wrapped;
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

    // DELETE /claude-ai/conversations/:uuid
    //
    //   WRITE (destructive) — permanently deletes one conversation. Same
    //   pattern as the GET read route; the DELETE method disambiguates.
    //   UUID is validated so a malformed value can't widen the path.
    {
      method: 'DELETE',
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
          return upstreamWrap(await deleteConversation(uuid));
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

    // ─── Additional read routes (cookie-file path) ───
    // Fingerprints verified against lm-proxy captures 2026-05-10..14.

    { method: 'GET', pattern: /^\/claude-ai\/account-profile$/,
      handler: async () => { try { return upstreamWrap(await getAccountProfile()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org$/,
      handler: async () => { try { return upstreamWrap(await getOrgInfo()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/subscription$/,
      handler: async (req) => { try {
        const cached = (req.query || {}).cached !== 'false';
        return upstreamWrap(await getSubscriptionDetails({ cached }));
      } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/usage$/,
      handler: async () => { try { return upstreamWrap(await getOrgUsage()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/skills$/,
      handler: async () => { try { return upstreamWrap(await listOrgSkills()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/mcp-bootstrap$/,
      handler: async () => { try { return upstreamWrap(await getOrgMcpBootstrap()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/styles$/,
      handler: async () => { try { return upstreamWrap(await listOrgStyles()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/model-config\/(?<model>[^/?]+)$/,
      handler: async (req) => { try { return upstreamWrap(await getModelConfig(req.params.model)); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/memory-settings$/,
      handler: async () => { try { return upstreamWrap(await getMemorySettings()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/cowork-settings$/,
      handler: async () => { try { return upstreamWrap(await getCoworkSettings()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/sync-settings$/,
      handler: async () => { try { return upstreamWrap(await getSyncSettings()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/sync\/gdrive-progress$/,
      handler: async () => { try { return upstreamWrap(await getGdriveProgress()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/org\/notifications$/,
      handler: async () => { try { return upstreamWrap(await getNotificationPreferences()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/account\/invites$/,
      handler: async () => { try { return upstreamWrap(await listInvites()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/user-access$/,
      handler: async () => { try { return upstreamWrap(await getCurrentUserAccess()); } catch (err) { return catchOAuth(err); } } },

    { method: 'GET', pattern: /^\/claude-ai\/sessions-active$/,
      handler: async (req) => { try {
        const q = req.query || {};
        return upstreamWrap(await listActiveSessions({
          page: typeof q.page === 'string' ? parseInt(q.page, 10) : undefined,
          perPage: typeof q.per_page === 'string' ? parseInt(q.per_page, 10) : undefined,
          applicationSlug: typeof q.application_slug === 'string' ? q.application_slug : undefined,
        }));
      } catch (err) { return catchOAuth(err); } } },

    // WRITE — rename / auto-title a conversation
    { method: 'POST', pattern: /^\/claude-ai\/conversations\/(?<uuid>[^/?]+)\/title$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) return { success: false, error: { code: 'INVALID_UUID', message: `got ${uuid}` } };
        try {
          const b = req.body || {};
          const title = typeof b.title === 'string' ? b.title : undefined;
          return upstreamWrap(await setConversationTitle(uuid, { title }));
        } catch (err) { return catchOAuth(err); }
      } },

    // ─── Additional via-chrome snippet routes ───

    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/account-profile$/,
      handler: async () => ({ success: true, data: snippetAccountProfile() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org$/,
      handler: async () => ({ success: true, data: snippetOrgInfo() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/subscription$/,
      handler: async (req) => ({ success: true, data: snippetSubscriptionDetails({ cached: (req.body || {}).cached }) }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/usage$/,
      handler: async () => ({ success: true, data: snippetOrgUsage() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/skills$/,
      handler: async () => ({ success: true, data: snippetListOrgSkills() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/mcp-bootstrap$/,
      handler: async () => ({ success: true, data: snippetMcpBootstrap() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/styles$/,
      handler: async () => ({ success: true, data: snippetListOrgStyles() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/model-config\/(?<model>[^/?]+)$/,
      handler: async (req) => {
        try { return { success: true, data: snippetModelConfig(req.params.model) }; }
        catch (err) { return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } }; }
      } },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/memory-settings$/,
      handler: async () => ({ success: true, data: snippetMemorySettings() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/cowork-settings$/,
      handler: async () => ({ success: true, data: snippetCoworkSettings() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/sync-settings$/,
      handler: async () => ({ success: true, data: snippetSyncSettings() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/sync\/gdrive-progress$/,
      handler: async () => ({ success: true, data: snippetGdriveProgress() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/org\/notifications$/,
      handler: async () => ({ success: true, data: snippetNotificationPreferences() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/account\/invites$/,
      handler: async () => ({ success: true, data: snippetListInvites() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/user-access$/,
      handler: async () => ({ success: true, data: snippetCurrentUserAccess() }) },
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/sessions-active$/,
      handler: async (req) => {
        const b = req.body || {};
        return { success: true, data: snippetListActiveSessions({
          page: typeof b.page === 'number' ? b.page : undefined,
          perPage: typeof b.perPage === 'number' ? b.perPage : undefined,
          applicationSlug: typeof b.applicationSlug === 'string' ? b.applicationSlug : undefined,
        }) };
      } },
    // WRITE
    { method: 'POST', pattern: /^\/claude-ai\/via-chrome\/conversations\/(?<uuid>[^/?]+)\/title$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) return { success: false, error: { code: 'INVALID_UUID', message: `got ${uuid}` } };
        try {
          const b = req.body || {};
          const title = typeof b.title === 'string' ? b.title : undefined;
          return { success: true, data: snippetSetConversationTitle(uuid, { title }) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      } },

    // POST /claude-ai/conversations/:uuid/completion
    //   Body: { prompt: string, model?, timezone?, locale?, parentMessageUuid? }
    //
    //   WRITE OPERATION — creates real message history in the user's
    //   claude.ai account and consumes tokens. Auto-resolves
    //   current_leaf_message_uuid by pre-reading the conversation.
    //   Returns aggregated SSE result: { events, text, ...uuids }.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/conversations\/(?<uuid>[^/?]+)\/completion$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Conversation UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        const body = req.body || {};
        if (typeof body.prompt !== 'string' || !body.prompt) {
          return {
            success: false,
            error: { code: 'MISSING_PROMPT', message: 'body.prompt is required (non-empty string)' },
          };
        }
        try {
          const r = await sendMessage(uuid, body.prompt, {
            model: typeof body.model === 'string' ? body.model : undefined,
            timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
            locale: typeof body.locale === 'string' ? body.locale : undefined,
            parentMessageUuid: typeof body.parentMessageUuid === 'string' ? body.parentMessageUuid : undefined,
            tools: Array.isArray(body.tools) ? body.tools : undefined,
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
          });
          if (r.status >= 400) {
            return {
              success: false,
              error: { code: `UPSTREAM_${r.status}`, message: `claude.ai responded ${r.status} ${r.statusText}` },
              data: r,
            };
          }
          // Compact response: don't dump every SSE event by default; caller
          // can ask for events via ?events=full if they need them.
          const eventTypes = Array.from(new Set(r.events.map((e) => e.type))).sort();
          const compact = (req.query || {}).events !== 'full';
          return {
            success: true,
            data: {
              status: r.status,
              text: r.text,
              humanMessageUuid: r.humanMessageUuid,
              assistantMessageUuid: r.assistantMessageUuid,
              eventCount: r.events.length,
              eventTypes,
              events: compact ? undefined : r.events,
            },
          };
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

    // POST /claude-ai/via-chrome/conversations/create
    //   Body: { name? }
    //
    //   WRITE snippet — creates a new empty conversation; the snippet
    //   returns the new `uuid`. MUST stay registered BEFORE the
    //   `/conversations/:uuid` read route below: the router is
    //   first-match-wins and the literal "create" would otherwise be
    //   captured as a :uuid by that route's `[^/?]+` group.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/conversations\/create$/,
      handler: async (req) => {
        const b = req.body || {};
        try {
          return {
            success: true,
            data: snippetCreateConversation({
              name: typeof b.name === 'string' ? b.name : undefined,
            }),
          };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/conversations/:uuid/delete
    //
    //   WRITE (destructive) snippet — permanently deletes the conversation.
    //   The `/delete` suffix means this never collides with the read route
    //   (which ends right after :uuid), so order is not significant here —
    //   it is grouped with create only for readability.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/conversations\/(?<uuid>[^/?]+)\/delete$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Conversation UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        try {
          return { success: true, data: snippetDeleteConversation(uuid) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
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

    // POST /claude-ai/via-chrome/conversations/:uuid/completion
    //   Body: { prompt, model?, timezone?, locale?, parentMessageUuid? }
    //   Returns a snippet that, when run in an authenticated claude.ai
    //   tab, (1) reads current_leaf_message_uuid, (2) POSTs /completion
    //   with proper turn UUIDs, (3) drains the SSE stream, (4) returns
    //   the aggregated assistant text + event metadata.
    //
    //   WRITE — running the snippet creates real message history.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/conversations\/(?<uuid>[^/?]+)\/completion$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Conversation UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        const b = req.body || {};
        if (typeof b.prompt !== 'string' || !b.prompt) {
          return {
            success: false,
            error: { code: 'MISSING_PROMPT', message: 'body.prompt is required (non-empty string)' },
          };
        }
        try {
          const out = snippetSendMessage(uuid, b.prompt, {
            model: typeof b.model === 'string' ? b.model : undefined,
            timezone: typeof b.timezone === 'string' ? b.timezone : undefined,
            locale: typeof b.locale === 'string' ? b.locale : undefined,
            parentMessageUuid: typeof b.parentMessageUuid === 'string' ? b.parentMessageUuid : undefined,
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
  ];
}
