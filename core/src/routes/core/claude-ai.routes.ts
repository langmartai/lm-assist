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

import * as os from 'node:os';
import * as path from 'node:path';
import { createClaudeAiCache, type ClaudeAiCache } from '../../claudeai-cache';

const CACHE_DIR = process.env.LM_ASSIST_CLAUDEAI_CACHE_DIR
  || path.join(os.homedir(), '.lm-assist', 'claudeai-cache');
const CACHE_TTL_SEC = Number(process.env.LM_ASSIST_CLAUDEAI_CACHE_TTL_SEC || 60);
const CACHE_EVICT_DAYS = Number(process.env.LM_ASSIST_CLAUDEAI_CACHE_EVICT_DAYS || 30);

const claudeAiCache: ClaudeAiCache = createClaudeAiCache({
  cacheDir: CACHE_DIR,
  ttlSec: CACHE_TTL_SEC,
  evictAfterDays: CACHE_EVICT_DAYS,
});

// Daily eviction sweep — best-effort, does not block server startup.
setInterval(() => { claudeAiCache.sweep().catch(() => {}); }, 24 * 60 * 60 * 1000).unref();

// Short-TTL in-memory cache for the personal skills list (mirrors the
// conversations-list cache behavior). Writes invalidate it; `?refresh=true`
// bypasses it. Kept in-memory (not on the conversation disk cache) since the
// shape is different and the list is small.
const SKILLS_LIST_TTL_MS = CACHE_TTL_SEC * 1000;
let skillsListCache: { data: unknown; expiresAt: number } | null = null;
function invalidateSkillsListCache(): void { skillsListCache = null; }

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
  createMcpRemoteServer,
  deleteMcpRemoteServer,
  clearMcpServerCache,
  setMcpToolsAccess,
  setMcpToolsAutoApprove,
  listMcpRemoteServers,
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
  cleanupTestConversations,
  setConversationAutoDelete,
  listSkills,
  listSkillFiles,
  downloadSkillBundle,
  createSimpleSkill,
  editSimpleSkill,
  uploadSkill,
  deleteSkill,
  enableSkill,
  disableSkill,
  readSkillFile,
  putSkillFile,
  deleteSkillFile,
  renameSkill,
  duplicateSkill,
  deleteOrgSkill,
  SkillFileNotFoundError,
  listMarketplaces,
  createAccountMarketplace,
  deleteAccountMarketplace,
  listAccountMarketplacePlugins,
  listPlugins,
  setPluginEnabled,
  deleteMarketplacePlugin,
  type MarketplaceScope,
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
  snippetListSkills,
  snippetListSkillFiles,
  snippetDownloadSkillBundle,
  snippetCreateSkill,
  snippetEditSkill,
  snippetEnableSkill,
  snippetDisableSkill,
  snippetDeleteSkill,
  snippetUploadSkill,
  snippetReadSkillFile,
  snippetPutSkillFile,
  snippetDeleteSkillFile,
  snippetRenameSkill,
  snippetDuplicateSkill,
  snippetDeleteOrgSkill,
} from '../../utils/claudeai-via-chrome';
import {
  listChromeProfiles,
  resolveProfile,
} from '../../utils/claudeai-browser-profile';
import {
  captureSession,
  launchAndCapture,
  type BrowserKind,
} from '../../utils/claudeai-browser-launch';
import { installBanner } from '../../utils/claudeai-banner';
import { LM_ASSIST_TOOL_DEFS } from '../../mcp-server/configure';
import { buildConnectorToolsArray, pickLmAssistConnector } from '../../mcp-server/connector-tools-array';
import { getPluginAggregator } from '../../mcp-server/plugins/aggregator';
import { parseChatMessages } from '../../claude-ai/chat-read';

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

/**
 * Resolve the SPA tools array + auto-approve for a driven completion. A caller
 * may pass an explicit SPA `tools` array, OR ask lm-assist to BUILD it for the
 * langmart connector via `enableConnectorTools` (true = all the connector's
 * tools, or string[] of tool names) so a driver doesn't have to hand-craft the
 * SPA shape. Auto-approve defaults ON when we build the tools (the intent is
 * to DRIVE tool calls, so the gates should be released). Shared by the
 * blocking /completion route and the streaming /completion/stream handler.
 */
async function resolveDrivenTools(body: Record<string, unknown>): Promise<{ toolsArr?: unknown[]; autoApprove?: boolean }> {
  let toolsArr: unknown[] | undefined = Array.isArray(body.tools) ? body.tools : undefined;
  let autoApprove: boolean | undefined = typeof body.autoApproveTools === 'boolean'
    ? body.autoApproveTools
    : (typeof body.auto_approve_tools === 'boolean' ? body.auto_approve_tools : undefined);
  const enableConn = body.enableConnectorTools ?? body.enable_connector_tools;
  if (!toolsArr && enableConn) {
    try {
      const names = Array.isArray(enableConn) ? enableConn.map(String) : undefined;
      const roster = await listMcpRemoteServers();
      const conn = pickLmAssistConnector((roster.body?.servers as unknown[] as never) || []);
      if (conn) {
        // Live defs = compiled-in built-ins + dynamically-registered third-party
        // plugin tools (ext__…). LM_ASSIST_TOOL_DEFS alone is baked at build time,
        // so plugin tools could NEVER be injected on a driven turn even when
        // claude.ai's connector already lists them (root-caused 2026-07-21:
        // driven e2e kept answering TOOLS-MISSING for ext__chart-context__*).
        let defs = LM_ASSIST_TOOL_DEFS as unknown as import('../../mcp-server/connector-tools-array').ToolDef[];
        try {
          const ext = await getPluginAggregator().listToolDefs();
          if (ext.length) defs = [...defs, ...ext];
        } catch { /* plugin subsystem disabled → built-ins only */ }
        toolsArr = buildConnectorToolsArray(conn, defs as never, names);
        if (autoApprove === undefined) autoApprove = true;
      }
    } catch { /* connector discovery failed → proceed with no tools (text-only) */ }
  }
  return { toolsArr, autoApprove };
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
            sessionKeyExpiresAt: status.sessionKeyExpiresAt,
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
    //   Cache: served from index on hit (fast list). Bypass with ?refresh=true.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/conversations$/,
      handler: async (req) => {
        try {
          const q = req.query || {};
          const forceRefresh = q.refresh === 'true';
          if (!forceRefresh) {
            const indexEntries = await claudeAiCache.listIndex();
            if (indexEntries.length > 0) {
              return { success: true, data: indexEntries, _cached: true };
            }
          }
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
    //   Body: { name?, uuid?, model?, enabledMcpTools?, toolSearchMode? }
    //
    //   WRITE — creates a new, empty conversation. Method differs from the
    //   GET list route above (same pattern), so the router's method check
    //   keeps them distinct. Returns { ...upstream, uuid } so the caller
    //   knows the new conversation id even on a 204/empty body.
    //
    //   `enabledMcpTools` (object) REPLACES the conv's inherited
    //   `settings.enabled_mcp_tools`. Pass only the bare `<srv>:<tool>` key
    //   (no hash-suffixed alwaysApprovedKey) to FORCE the per-call approval
    //   gate to fire for that tool — handy for testing autoApproveTools
    //   without account-level changes. Example:
    //   `{"<srv_uuid>:list_recent_sessions": true}`.
    //
    //   `toolSearchMode` is `'on' | 'off'`. Pass `'off'` to suppress the
    //   SPA's `tool_search` meta-tool (the in-page tool-catalog search the
    //   model runs first before invoking real connector tools).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/conversations$/,
      handler: async (req) => {
        try {
          const b = req.body || {};
          const enabledMcpTools = (b.enabledMcpTools && typeof b.enabledMcpTools === 'object' && !Array.isArray(b.enabledMcpTools))
            ? b.enabledMcpTools as Record<string, boolean>
            : undefined;
          const r = await createConversation({
            name: typeof b.name === 'string' ? b.name : undefined,
            uuid: typeof b.uuid === 'string' ? b.uuid : undefined,
            model: typeof b.model === 'string' ? b.model : undefined,
            enabledMcpTools,
            toolSearchMode: typeof b.toolSearchMode === 'string' ? b.toolSearchMode : undefined,
            autoDeleteHours: typeof b.autoDeleteHours === 'number' ? b.autoDeleteHours
              : (typeof b.auto_delete_hours === 'number' ? b.auto_delete_hours : undefined),
          });
          const wrapped = upstreamWrap(r);
          if (wrapped.success) (wrapped as { data: unknown }).data = { ...r.body, uuid: r.uuid };
          return wrapped;
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/conversations/:uuid/messages
    //   Parsed-read: same upstream call as the raw read below, but returns
    //   display-ready ChatMsg[] (via parseChatMessages) instead of the raw
    //   chat_conversations tree. Registered BEFORE the generic /:uuid read
    //   so the literal "messages" suffix isn't swallowed as a uuid.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/conversations\/(?<uuid>[^/?]+)\/messages$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return {
            success: false,
            error: { code: 'INVALID_UUID', message: `Conversation UUID must be a UUIDv4: got ${uuid}` },
          };
        }
        try {
          const r = await readConversation(uuid, { tree: true, renderingMode: 'messages', renderAllTools: true });
          const wrapped = upstreamWrap(r);
          if (!wrapped.success) return wrapped;
          const body: any = r.body || {};
          return { success: true, data: { uuid: body.uuid || uuid, name: body.name, messages: parseChatMessages(body) } };
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/conversations/:uuid
    //   Cache: served from disk on hit. Bypass with ?refresh=true.
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
          const forceRefresh = q.refresh === 'true';
          if (!forceRefresh) {
            const cached = await claudeAiCache.get(uuid);
            if (cached) {
              return { success: true, data: cached, _cached: true };
            }
          }
          const r = await readConversation(uuid, {
            tree: q.tree === 'false' ? false : true,
            renderAllTools: q.render_all_tools === 'false' ? false : true,
            renderingMode: typeof q.rendering_mode === 'string' ? q.rendering_mode : undefined,
          });
          if (r.status < 400 && r.body != null) {
            await claudeAiCache.set(uuid, r.body as Record<string, unknown> & { uuid: string }).catch(() => {});
          }
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

    // POST /claude-ai/conversations/cleanup-test
    //
    //   Sweep throwaway/test conversations (lm-assist's own `lm-assist-approval-probe` by default).
    //   SAFE BY DEFAULT: `dryRun` defaults TRUE — it only REPORTS matches; nothing is deleted unless
    //   the caller passes `dryRun:false`. Body: { dryRun?, ids?:[], patterns?:[name-regex], olderThanHours?, limit? }.
    //   `ids` delete unconditionally; `patterns` match by name (+ optional age guard). Read-modify is
    //   bounded. Intended for a scheduled maintenance job (caller arms it with dryRun:false).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/conversations\/cleanup-test$/,
      handler: async (req) => {
        const b = req.body || {};
        try {
          const r = await cleanupTestConversations({
            dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : undefined, // lib defaults to true
            ids: Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === 'string') : undefined,
            patterns: Array.isArray(b.patterns) ? b.patterns.filter((x: unknown) => typeof x === 'string') : undefined,
            olderThanHours: typeof b.olderThanHours === 'number' ? b.olderThanHours : undefined,
            limit: typeof b.limit === 'number' ? b.limit : undefined,
          });
          return { success: true, data: r };
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/conversations/:uuid/auto-delete
    //
    //   Set / update / CLEAR the auto-delete TTL on an EXISTING conversation (rewrites its `[lm-autodel:…]`
    //   name marker). Body: { autoDeleteHours?: number }. `autoDeleteHours > 0` (re)arms the TTL; 0 / null /
    //   omitted CLEARS it → the conversation will never be auto-deleted. WRITE (renames the conversation).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/conversations\/(?<uuid>[^/?]+)\/auto-delete$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return { success: false, error: { code: 'INVALID_UUID', message: `Conversation UUID must be a UUIDv4: got ${uuid}` } };
        }
        const b = req.body || {};
        const hours = typeof b.autoDeleteHours === 'number' ? b.autoDeleteHours
          : (typeof b.auto_delete_hours === 'number' ? b.auto_delete_hours : null); // absent → clear
        try {
          return { success: true, data: await setConversationAutoDelete(uuid, hours) };
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

    // ─── MCP remote-connector lifecycle (register / delete / list+status) ───

    // GET /claude-ai/mcp/servers — list registered MCP connectors with status
    //   (uuid, name, url, connected, authStatus, customOauthClientId, tools).
    //   Distilled from mcp/v2/bootstrap. Read-only.
    { method: 'GET', pattern: /^\/claude-ai\/mcp\/servers$/,
      handler: async () => { try { return upstreamWrap(await listMcpRemoteServers()); } catch (err) { return catchOAuth(err); } } },

    // POST /claude-ai/mcp/servers — register an MCP connector.
    //   Body: { url, name, customOauthClientId?, customOauthClientSecret? }.
    //   Pass the custom OAuth client pair to pre-bind (no DCR/browser SSO); omit
    //   for a plain connector claude.ai will DCR + OAuth on Connect.
    { method: 'POST', pattern: /^\/claude-ai\/mcp\/servers$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.url !== 'string' || !b.url) {
          return { success: false, error: { code: 'MISSING_URL', message: 'body.url is required' } };
        }
        if (typeof b.name !== 'string' || !b.name) {
          return { success: false, error: { code: 'MISSING_NAME', message: 'body.name is required' } };
        }
        try {
          return upstreamWrap(await createMcpRemoteServer({
            url: b.url,
            name: b.name,
            customOauthClientId: typeof b.customOauthClientId === 'string' ? b.customOauthClientId : undefined,
            customOauthClientSecret: typeof b.customOauthClientSecret === 'string' ? b.customOauthClientSecret : undefined,
          }));
        } catch (err) {
          return catchOAuth(err);
        }
      } },

    // DELETE /claude-ai/mcp/servers/:uuid — remove a connector by its server UUID.
    { method: 'DELETE', pattern: /^\/claude-ai\/mcp\/servers\/(?<uuid>[^/?]+)$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return { success: false, error: { code: 'INVALID_UUID', message: `MCP server UUID must be a UUIDv4: got ${uuid}` } };
        }
        try {
          return upstreamWrap(await deleteMcpRemoteServer(uuid));
        } catch (err) {
          return catchOAuth(err);
        }
      } },

    // POST /claude-ai/mcp/servers/:uuid/clear-cache — clear claude.ai's cached
    //   tool list for a connector, forcing a fresh tools/list re-fetch on the
    //   next bootstrap (surfaces newly-added worker tools). Exactly what the web
    //   UI "refresh tools" button calls. Empty body; returns the upstream 200.
    { method: 'POST', pattern: /^\/claude-ai\/mcp\/servers\/(?<uuid>[^/?]+)\/clear-cache$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return { success: false, error: { code: 'INVALID_UUID', message: `MCP server UUID must be a UUIDv4: got ${uuid}` } };
        }
        try {
          return upstreamWrap(await clearMcpServerCache(uuid));
        } catch (err) {
          return catchOAuth(err);
        }
      } },

    // POST /claude-ai/mcp/servers/:uuid/tool-access — enable/block a connector's
    //   MCP tools (the web "tool access" control). Body: { enable?: string[],
    //   block?: string[] } (tool names). Read-modify-write on enabled_mcp_tools
    //   so other tools' settings are preserved. Returns the keys changed.
    { method: 'POST', pattern: /^\/claude-ai\/mcp\/servers\/(?<uuid>[^/?]+)\/tool-access$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return { success: false, error: { code: 'INVALID_UUID', message: `MCP server UUID must be a UUIDv4: got ${uuid}` } };
        }
        const b = req.body || {};
        const enable = Array.isArray(b.enable) ? b.enable.filter((t: unknown) => typeof t === 'string') : [];
        const block = Array.isArray(b.block) ? b.block.filter((t: unknown) => typeof t === 'string') : [];
        if (enable.length === 0 && block.length === 0) {
          return { success: false, error: { code: 'NO_CHANGES', message: 'provide enable[] and/or block[] tool names' } };
        }
        const changes: Record<string, boolean> = {};
        for (const t of block) changes[t] = false;
        for (const t of enable) changes[t] = true; // enable wins if a name is in both
        try {
          return upstreamWrap(await setMcpToolsAccess(uuid, changes));
        } catch (err) {
          return catchOAuth(err);
        }
      } },

    // POST /claude-ai/mcp/servers/:uuid/auto-approve — turn ON/off "always approve" auto-approval
    //   for a connector's tools so driven tool calls don't hit the per-call approval gate. Body:
    //   { enable?: bool (default true), tools?: string[] (default ALL the connector's tools) }.
    //   Read-modify-write on enabled_mcp_tools using the live bootstrap's always_approved_key.
    { method: 'POST', pattern: /^\/claude-ai\/mcp\/servers\/(?<uuid>[^/?]+)\/auto-approve$/,
      handler: async (req) => {
        const uuid = req.params.uuid;
        if (!UUID_RE.test(uuid)) {
          return { success: false, error: { code: 'INVALID_UUID', message: `MCP server UUID must be a UUIDv4: got ${uuid}` } };
        }
        const b = req.body || {};
        const enable = typeof b.enable === 'boolean' ? b.enable : true;
        const tools = Array.isArray(b.tools) ? b.tools.filter((t: unknown): t is string => typeof t === 'string') : undefined;
        try {
          return upstreamWrap(await setMcpToolsAutoApprove(uuid, enable, tools));
        } catch (err) {
          return catchOAuth(err);
        }
      } },

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

    // ─── Personal Agent Skills (cookie-file path) ───
    //
    //   CRUD for the user's claude.ai personal skills. Distinct from the
    //   org-scoped GET /claude-ai/org/skills above (same upstream list-skills
    //   endpoint, separate family). Mutating routes (POST/DELETE) are WRITES
    //   against the real account and invalidate the skills-list cache.
    //
    //   ROUTE ORDER (first-match-wins): POST /skills/upload MUST precede
    //   POST /skills/:id, or the literal "upload" is captured as :id by that
    //   route's [^/?]+ group. enable/disable/files/download have distinct
    //   suffixes so they never collide with the bare :id route.

    // GET /claude-ai/skills — list personal skills (short-TTL cache; ?refresh=true bypasses).
    {
      method: 'GET',
      pattern: /^\/claude-ai\/skills$/,
      handler: async (req) => {
        try {
          const forceRefresh = (req.query || {}).refresh === 'true';
          if (!forceRefresh && skillsListCache && skillsListCache.expiresAt > Date.now()) {
            return { success: true, data: skillsListCache.data, _cached: true };
          }
          const r = await listSkills();
          const wrapped = upstreamWrap(r);
          if (wrapped.success) {
            skillsListCache = { data: (wrapped as { data: unknown }).data, expiresAt: Date.now() + SKILLS_LIST_TTL_MS };
          }
          return wrapped;
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/skills/:id/files — file paths inside a (custom) skill.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/files$/,
      handler: async (req) => {
        try {
          return upstreamWrap(await listSkillFiles(req.params.id));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/skills/:id/download — the .skill (zip) bundle.
    //   Default: streams application/zip (repo binary convention).
    //   ?format=base64 → JSON { filename, contentType, size, base64 } for
    //   JSON-only transports (e.g. a caller that can't accept a binary body).
    {
      method: 'GET',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/download$/,
      handler: async (req) => {
        try {
          const dl = await downloadSkillBundle(req.params.id);
          if (dl.status >= 400) {
            // Error body is text/JSON, not a zip — surface it as a normal error.
            let body: unknown = dl.buffer.toString('utf8');
            try { body = JSON.parse(body as string); } catch { /* leave as text */ }
            return {
              success: false,
              error: { code: `UPSTREAM_${dl.status}`, message: `claude.ai responded ${dl.status} ${dl.statusText}` },
              data: body,
            };
          }
          if ((req.query || {}).format === 'base64') {
            return {
              success: true,
              data: {
                filename: dl.filename,
                contentType: dl.contentType,
                size: dl.buffer.length,
                base64: dl.buffer.toString('base64'),
              },
            };
          }
          // Stream the bytes (rest-server serves result.binary + Buffer as-is;
          // the hub relay base64-encodes application/zip by content-type).
          return {
            success: true,
            binary: true,
            data: dl.buffer,
            headers: {
              'Content-Type': dl.contentType || 'application/zip',
              'Content-Disposition': `attachment; filename="${dl.filename.replace(/"/g, '')}"`,
              'Content-Length': String(dl.buffer.length),
            },
          };
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills — create a simple (single SKILL.md) skill.
    //   Body: { name, description?, instructions? }
    //   WRITE.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.name !== 'string' || !b.name) {
          return { success: false, error: { code: 'MISSING_NAME', message: 'body.name is required' } };
        }
        try {
          const r = await createSimpleSkill({
            name: b.name,
            description: typeof b.description === 'string' ? b.description : '',
            instructions: typeof b.instructions === 'string' ? b.instructions : '',
          });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/upload — upload a skill bundle (.zip/.skill/.md).
    //   Body: { filename, contentBase64, overwrite?, checkSkillName?, contentType? }
    //   WRITE. MUST stay registered BEFORE POST /claude-ai/skills/:id below —
    //   the router is first-match-wins and the literal "upload" would otherwise
    //   be captured as a :id. Enforces claude.ai's 30 MiB ceiling.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/upload$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.filename !== 'string' || !b.filename) {
          return { success: false, error: { code: 'MISSING_FILENAME', message: 'body.filename is required' } };
        }
        if (typeof b.contentBase64 !== 'string' || !b.contentBase64) {
          return { success: false, error: { code: 'MISSING_CONTENT', message: 'body.contentBase64 is required (base64-encoded bundle bytes)' } };
        }
        const bytes = Buffer.from(b.contentBase64, 'base64');
        if (bytes.length === 0) {
          return { success: false, error: { code: 'EMPTY_CONTENT', message: 'Decoded bundle is empty (invalid base64?)' } };
        }
        if (bytes.length >= 31457280) {
          return { success: false, error: { code: 'BUNDLE_TOO_LARGE', message: `Bundle is ${bytes.length} bytes; claude.ai's hard limit is < 31457280 bytes (30 MiB).` } };
        }
        try {
          const r = await uploadSkill({
            filename: b.filename,
            content: bytes,
            overwrite: b.overwrite === true || b.overwrite === 'true',
            checkSkillName: typeof b.checkSkillName === 'string' ? b.checkSkillName : undefined,
            contentType: typeof b.contentType === 'string' ? b.contentType : undefined,
          });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/:id/enable — enable a skill (id preserved). WRITE.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/enable$/,
      handler: async (req) => {
        try {
          const r = await enableSkill({ skillId: req.params.id });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/:id/disable — disable a skill (id preserved). WRITE.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/disable$/,
      handler: async (req) => {
        try {
          const r = await disableSkill({ skillId: req.params.id });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // ─── Per-file skill CRUD (synthesized read-modify-write over the bundle) ───
    //
    //   claude.ai has NO native per-file write endpoint, so these synthesize a
    //   single-file read/update/delete as a read-modify-write of the entire
    //   `.skill` bundle (download → unzip → mutate → rezip → upload overwrite).
    //   Non-atomic and VERSIONED: each write mints a NEW skill id (returned as
    //   `newSkillId`) — chain further writes against that. Writes are serialized
    //   per skill id (so concurrent file writes can't clobber) and invalidate
    //   the skills-list cache. The 30 MiB ceiling is enforced on the rebuilt
    //   bundle. These `:id/file` patterns carry a `/file` suffix so they never
    //   collide with the bare `:id` edit/delete routes below; they are
    //   nonetheless kept ahead of those (matching the upload-before-:id order).

    // GET /claude-ai/skills/:id/file?path=ENC[&format=base64]
    //   Read one file out of the bundle. Default: streams the bytes with a
    //   content-type detected from the extension. ?format=base64 → JSON
    //   { path, contentType, size, base64 } for JSON-only transports.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/file$/,
      handler: async (req) => {
        const q = req.query || {};
        const filePath = typeof q.path === 'string' ? q.path : '';
        if (!filePath) {
          return { success: false, error: { code: 'MISSING_PATH', message: 'query ?path= is required (the file path inside the bundle)' } };
        }
        try {
          const r = await readSkillFile(req.params.id, filePath);
          if (r.upstreamError !== undefined || r.status >= 400) {
            return {
              success: false,
              error: { code: `UPSTREAM_${r.status}`, message: `claude.ai responded ${r.status} ${r.statusText}` },
              data: r.upstreamError,
            };
          }
          if (!r.found || !r.buffer) {
            return { success: false, error: { code: 'SKILL_FILE_NOT_FOUND', message: `File not found in skill bundle: ${r.resolvedPath}` } };
          }
          if (q.format === 'base64') {
            return {
              success: true,
              data: { path: r.resolvedPath, contentType: r.contentType, size: r.buffer.length, base64: r.buffer.toString('base64') },
            };
          }
          const base = r.resolvedPath.split('/').pop() || 'file';
          return {
            success: true,
            binary: true,
            data: r.buffer,
            headers: {
              'Content-Type': r.contentType || 'application/octet-stream',
              'Content-Length': String(r.buffer.length),
              'Content-Disposition': `inline; filename="${base.replace(/"/g, '')}"`,
            },
          };
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // PUT /claude-ai/skills/:id/file — add or replace one file in the bundle.
    //   Body: { path, content? | contentBase64? }  (content = utf-8 text;
    //   contentBase64 = base64 bytes for binaries). WRITE. Returns the NEW
    //   skill id + record. Preserves the top folder, SKILL.md name, and the
    //   disabled state.
    {
      method: 'PUT',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/file$/,
      handler: async (req) => {
        const b = req.body || {};
        const filePath = typeof b.path === 'string' ? b.path : '';
        if (!filePath) {
          return { success: false, error: { code: 'MISSING_PATH', message: 'body.path is required (the file path inside the bundle)' } };
        }
        let bytes: Buffer;
        if (typeof b.contentBase64 === 'string') bytes = Buffer.from(b.contentBase64, 'base64');
        else if (typeof b.content === 'string') bytes = Buffer.from(b.content, 'utf8');
        else return { success: false, error: { code: 'MISSING_CONTENT', message: 'body.content (utf-8 string) or body.contentBase64 (base64 bytes) is required' } };
        try {
          const r = await putSkillFile(req.params.id, filePath, bytes);
          invalidateSkillsListCache();
          if (r.upload.status >= 400) {
            return {
              success: false,
              error: { code: `UPSTREAM_${r.upload.status}`, message: `claude.ai responded ${r.upload.status} ${r.upload.statusText}` },
              data: r.upload.body,
            };
          }
          return {
            success: true,
            data: {
              path: r.resolvedPath,
              skillName: r.skillName,
              newSkillId: r.newSkillId,
              entryCount: r.entryCount,
              bundleBytes: r.bundleBytes,
              reDisabled: r.reDisabled,
              skill: r.upload.body,
            },
          };
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // DELETE /claude-ai/skills/:id/file?path=ENC — remove one file from the
    //   bundle. WRITE (destructive). Path comes from ?path= (or body.path).
    //   404s if the path is absent; refuses to delete SKILL.md.
    {
      method: 'DELETE',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/file$/,
      handler: async (req) => {
        const q = req.query || {};
        const b = req.body || {};
        const filePath = (typeof q.path === 'string' && q.path) ? q.path : (typeof b.path === 'string' ? b.path : '');
        if (!filePath) {
          return { success: false, error: { code: 'MISSING_PATH', message: 'query ?path= (or body.path) is required (the file path inside the bundle)' } };
        }
        try {
          const r = await deleteSkillFile(req.params.id, filePath);
          invalidateSkillsListCache();
          if (r.upload.status >= 400) {
            return {
              success: false,
              error: { code: `UPSTREAM_${r.upload.status}`, message: `claude.ai responded ${r.upload.status} ${r.upload.statusText}` },
              data: r.upload.body,
            };
          }
          return {
            success: true,
            data: {
              path: r.resolvedPath,
              skillName: r.skillName,
              newSkillId: r.newSkillId,
              entryCount: r.entryCount,
              bundleBytes: r.bundleBytes,
              reDisabled: r.reDisabled,
              skill: r.upload.body,
            },
          };
        } catch (err) {
          if (err instanceof SkillFileNotFoundError) {
            return { success: false, error: { code: 'SKILL_FILE_NOT_FOUND', message: err.message } };
          }
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/:id/rename — rename a skill in place. WRITE.
    //   Body: { name } (alias: newName). Confirmed body: { skill_id, new_name }.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/rename$/,
      handler: async (req) => {
        const b = req.body || {};
        const newName = typeof b.newName === 'string' ? b.newName : (typeof b.name === 'string' ? b.name : '');
        if (!newName) {
          return { success: false, error: { code: 'MISSING_NAME', message: 'body.name (or body.newName) is required' } };
        }
        try {
          const r = await renameSkill({ skillId: req.params.id, newName });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/:id/duplicate — duplicate a skill. WRITE.
    //   Body: { name? } (alias: newName). Confirmed body: { skill_id, new_name }
    //   (the web app always sends new_name; sent here only when provided).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/duplicate$/,
      handler: async (req) => {
        const b = req.body || {};
        const newName = typeof b.newName === 'string' ? b.newName : (typeof b.name === 'string' ? b.name : undefined);
        try {
          const r = await duplicateSkill({ skillId: req.params.id, newName });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/:id/delete-org — delete an ORG-shared skill. WRITE
    //   (destructive). Distinct from the personal DELETE /claude-ai/skills/:id.
    //   Confirmed body: { skill_id }.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)\/delete-org$/,
      handler: async (req) => {
        try {
          const r = await deleteOrgSkill({ skillId: req.params.id });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/skills/:id — edit a simple skill.
    //   Body: { description?, instructions? }
    //   WRITE. VERSIONED — claude.ai returns a NEW skill id on every edit
    //   (the old id is superseded). `name` is not editable.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const b = req.body || {};
        try {
          const r = await editSimpleSkill({
            skillId: req.params.id,
            description: typeof b.description === 'string' ? b.description : '',
            instructions: typeof b.instructions === 'string' ? b.instructions : '',
          });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // DELETE /claude-ai/skills/:id — delete a skill. WRITE (destructive).
    {
      method: 'DELETE',
      pattern: /^\/claude-ai\/skills\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        try {
          const r = await deleteSkill({ skillId: req.params.id });
          invalidateSkillsListCache();
          return upstreamWrap(r);
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // ─── Marketplaces + plugins (cookie-file path) ───
    //
    //   Manage the account's claude.ai plugin marketplaces (each a git repo
    //   with a .claude-plugin/marketplace.json at its root) and the plugins
    //   within them. Mirrors the web UI's marketplace screen. Mutating routes
    //   (POST/PUT/DELETE) are WRITES against the real account.
    //
    //   ROUTE ORDER (first-match-wins): the /:id/plugins/:pid and /:id/plugins
    //   routes MUST precede the bare DELETE /:id, or "plugins" would be captured
    //   as the :id group.

    // GET /claude-ai/marketplaces[?scope=account|default|org] — list marketplaces.
    //   Maps to marketplaces/list-{account,default,org}-marketplaces (default account).
    {
      method: 'GET',
      pattern: /^\/claude-ai\/marketplaces$/,
      handler: async (req) => {
        try {
          const raw = (req.query || {}).scope;
          const scope = (raw === 'default' || raw === 'org' ? raw : 'account') as MarketplaceScope;
          return upstreamWrap(await listMarketplaces({ scope }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // POST /claude-ai/marketplaces — create an account marketplace. WRITE.
    //   Body: { name, source_url, source?='github' }. source_url accepts
    //   "owner/repo" or a full github.com URL; normalized to
    //   https://github.com/owner/repo. claude.ai clones the repo's DEFAULT
    //   branch and requires .claude-plugin/marketplace.json at its root.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/marketplaces$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.name !== 'string' || !b.name) {
          return { success: false, error: { code: 'MISSING_NAME', message: 'body.name is required' } };
        }
        if (typeof b.source_url !== 'string' || !b.source_url) {
          return { success: false, error: { code: 'MISSING_SOURCE_URL', message: 'body.source_url is required ("owner/repo" or a github.com URL)' } };
        }
        try {
          return upstreamWrap(await createAccountMarketplace({
            name: b.name,
            sourceUrl: b.source_url,
            source: typeof b.source === 'string' ? b.source : undefined,
          }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/marketplaces/:id/plugins — plugins in an account marketplace.
    //   Maps to marketplaces/{id}/plugins/account-list-plugins?limit=100.
    {
      method: 'GET',
      pattern: /^\/claude-ai\/marketplaces\/(?<id>[^/?]+)\/plugins$/,
      handler: async (req) => {
        try {
          const limit = Number((req.query || {}).limit) || 100;
          return upstreamWrap(await listAccountMarketplacePlugins({ marketplaceId: req.params.id, limit }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // DELETE /claude-ai/marketplaces/:id/plugins/:pid — remove a plugin from a
    //   marketplace. WRITE. (Registered before the bare DELETE /:id.)
    {
      method: 'DELETE',
      pattern: /^\/claude-ai\/marketplaces\/(?<id>[^/?]+)\/plugins\/(?<pid>[^/?]+)$/,
      handler: async (req) => {
        try {
          return upstreamWrap(await deleteMarketplacePlugin({ marketplaceId: req.params.id, pluginId: req.params.pid }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // DELETE /claude-ai/marketplaces/:id — remove an account marketplace. WRITE.
    //   Maps to marketplaces/{id}/account-delete. Verify by re-listing.
    {
      method: 'DELETE',
      pattern: /^\/claude-ai\/marketplaces\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        try {
          return upstreamWrap(await deleteAccountMarketplace({ marketplaceId: req.params.id }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // GET /claude-ai/plugins[?enabled_only=true] — DEFAULT-marketplace plugins.
    //   (Account-marketplace plugins are under /marketplaces/:id/plugins.)
    {
      method: 'GET',
      pattern: /^\/claude-ai\/plugins$/,
      handler: async (req) => {
        try {
          const enabledOnly = (req.query || {}).enabled_only === 'true';
          return upstreamWrap(await listPlugins({ enabledOnly }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

    // PUT /claude-ai/plugins/:id/enabled — enable/disable a plugin. WRITE.
    //   Body: { enabled: boolean }.
    {
      method: 'PUT',
      pattern: /^\/claude-ai\/plugins\/(?<id>[^/?]+)\/enabled$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.enabled !== 'boolean') {
          return { success: false, error: { code: 'MISSING_ENABLED', message: 'body.enabled (boolean) is required' } };
        }
        try {
          return upstreamWrap(await setPluginEnabled({ pluginId: req.params.id, enabled: b.enabled }));
        } catch (err) {
          return catchOAuth(err);
        }
      },
    },

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
    //   Body: { prompt: string, model?, timezone?, locale?, parentMessageUuid?,
    //           attachments?, files?, syncSources?, tools?,
    //           autoApproveTools?, enableConnectorTools? }
    //
    //   WRITE OPERATION — creates real message history in the user's
    //   claude.ai account and consumes tokens. Auto-resolves
    //   current_leaf_message_uuid by pre-reading the conversation.
    //   Returns aggregated SSE result: { events, text, ...uuids, approvals? }.
    //
    //   `autoApproveTools` (default false): when true, lm-assist watches
    //   the SSE stream and POSTs /tool_approval for every MCP tool the
    //   model invokes whose approval gate is set on this conv. It then
    //   polls the conversation until the model's post-tool continuation
    //   text appears, and returns that merged into `text`. Per-call
    //   approval log returned as `approvals: [{toolUseId, toolName,
    //   status, ok}, ...]`. See discoverApprovalKeys / approveToolUse for
    //   the underlying mechanism. Stale hash (tool description edited
    //   after cache populated) → cache auto-invalidates on 4xx.
    //
    //   `attachments` is the text channel — pass full
    //   `{file_name, file_type, file_size, extracted_content, origin:"user_upload", kind:"file"}`
    //   objects with the markdown/source text inline. The assistant sees
    //   it directly in context. Use this for any text content.
    //
    //   `files` is the file-uuid channel — pass uuids returned by
    //   `POST /api/{org}/upload` on claude.ai (no lm-assist upload route
    //   yet). Files land in the assistant's sandbox at
    //   `/mnt/user-data/uploads/`; text extraction from blob uploads is
    //   unreliable, so prefer `attachments` for text.
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
        const { toolsArr, autoApprove } = await resolveDrivenTools(body);
        try {
          const r = await sendMessage(uuid, body.prompt, {
            model: typeof body.model === 'string' ? body.model : undefined,
            timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
            locale: typeof body.locale === 'string' ? body.locale : undefined,
            parentMessageUuid: typeof body.parentMessageUuid === 'string' ? body.parentMessageUuid : undefined,
            tools: toolsArr,
            attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
            files: Array.isArray(body.files) ? body.files : undefined,
            syncSources: Array.isArray(body.syncSources) ? body.syncSources
              : Array.isArray(body.sync_sources) ? body.sync_sources : undefined,
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            autoApproveTools: autoApprove,
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
              approvals: r.approvals,
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
    //   Body: { prompt, model?, timezone?, locale?, parentMessageUuid?,
    //           attachments?, files?, syncSources?, tools?, autoApproveTools? }
    //   Returns a snippet that, when run in an authenticated claude.ai
    //   tab, (1) reads current_leaf_message_uuid, (2) POSTs /completion
    //   with proper turn UUIDs, (3) drains the SSE stream, (4) returns
    //   the aggregated assistant text + event metadata.
    //
    //   `tools` is the SPA-shaped MCP tool definitions array — without it
    //   the model can't invoke any connector's tools.
    //
    //   `autoApproveTools: true` extends the generated snippet with the
    //   same auto-approval mechanism the cookie-file `/completion` route
    //   uses: track tool_use blocks during SSE drain, POST /tool_approval
    //   on each content_block_stop, then poll the conv for the
    //   post-approval continuation. The returned envelope includes an
    //   `approvals: [{toolUseId, toolName, status, ok}, ...]` field.
    //
    //   `attachments` / `files` / `syncSources` / `tools` are embedded
    //   into the snippet via JSON.stringify. Large payloads make the
    //   snippet correspondingly large; CDP can handle multi-MB scripts
    //   but expect proportional transfer time.
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
            attachments: Array.isArray(b.attachments) ? b.attachments : undefined,
            files: Array.isArray(b.files) ? b.files : undefined,
            syncSources: Array.isArray(b.syncSources) ? b.syncSources
              : Array.isArray(b.sync_sources) ? b.sync_sources : undefined,
            tools: Array.isArray(b.tools) ? b.tools : undefined,
            autoApproveTools: typeof b.autoApproveTools === 'boolean'
              ? b.autoApproveTools
              : (typeof b.auto_approve_tools === 'boolean' ? b.auto_approve_tools : undefined),
            showOverlay: typeof b.showOverlay === 'boolean'
              ? b.showOverlay
              : (typeof b.show_overlay === 'boolean' ? b.show_overlay : undefined),
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

    // ─── Personal Agent Skills (via-chrome path) ───
    //
    //   Snippet mirrors of the cookie-file skills routes. Mutating snippets
    //   carry the WRITE warning in their `instructions`. No bare
    //   via-chrome/skills/:id route exists, and create/upload are literals,
    //   so none of these patterns collide regardless of registration order.

    // POST /claude-ai/via-chrome/skills — list personal skills.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills$/,
      handler: async () => ({ success: true, data: snippetListSkills() }),
    },

    // POST /claude-ai/via-chrome/skills/create — WRITE snippet (create-simple-skill).
    //   Body: { name, description?, instructions? }
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/create$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.name !== 'string' || !b.name) {
          return { success: false, error: { code: 'MISSING_NAME', message: 'body.name is required' } };
        }
        try {
          return { success: true, data: snippetCreateSkill({
            name: b.name,
            description: typeof b.description === 'string' ? b.description : undefined,
            instructions: typeof b.instructions === 'string' ? b.instructions : undefined,
          }) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/upload — WRITE snippet (upload-skill, multipart).
    //   Body: { filename, contentBase64, overwrite?, checkSkillName?, contentType? }
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/upload$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.filename !== 'string' || !b.filename) {
          return { success: false, error: { code: 'MISSING_FILENAME', message: 'body.filename is required' } };
        }
        if (typeof b.contentBase64 !== 'string' || !b.contentBase64) {
          return { success: false, error: { code: 'MISSING_CONTENT', message: 'body.contentBase64 is required (base64-encoded bundle bytes)' } };
        }
        try {
          return { success: true, data: snippetUploadSkill({
            filename: b.filename,
            contentBase64: b.contentBase64,
            overwrite: b.overwrite === true || b.overwrite === 'true',
            checkSkillName: typeof b.checkSkillName === 'string' ? b.checkSkillName : undefined,
            contentType: typeof b.contentType === 'string' ? b.contentType : undefined,
          }) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/files — list files in a (custom) skill.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/files$/,
      handler: async (req) => {
        try {
          return { success: true, data: snippetListSkillFiles(req.params.id) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/download — snippet returns the
    //   .skill (zip) as base64. NOTE: Chrome MCP's content filter often blocks
    //   base64 — prefer the cookie-file GET /claude-ai/skills/:id/download.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/download$/,
      handler: async (req) => {
        try {
          return { success: true, data: snippetDownloadSkillBundle(req.params.id) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/edit — WRITE snippet (edit-simple-skill).
    //   Body: { description?, instructions? }. Versioned — returns a new id.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/edit$/,
      handler: async (req) => {
        const b = req.body || {};
        try {
          return { success: true, data: snippetEditSkill(req.params.id, {
            description: typeof b.description === 'string' ? b.description : undefined,
            instructions: typeof b.instructions === 'string' ? b.instructions : undefined,
          }) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/enable — WRITE snippet (enable-skill).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/enable$/,
      handler: async (req) => {
        try {
          return { success: true, data: snippetEnableSkill(req.params.id) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/disable — WRITE snippet (disable-skill).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/disable$/,
      handler: async (req) => {
        try {
          return { success: true, data: snippetDisableSkill(req.params.id) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/delete — WRITE (destructive) snippet (delete-skill).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/delete$/,
      handler: async (req) => {
        try {
          return { success: true, data: snippetDeleteSkill(req.params.id) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // ─── Per-file skill CRUD + native passthroughs (via-chrome mirrors) ───
    //
    //   File read/put/delete generate snippets that do the whole read-modify-
    //   write in-page (download → unzip → mutate → rezip → upload overwrite)
    //   using the browser-native DecompressionStream / CompressionStream. The
    //   `/file/*` and `/rename|/duplicate|/delete-org` suffixes never collide
    //   with the other via-chrome skills patterns, so order isn't significant.

    // POST /claude-ai/via-chrome/skills/:id/file/read — Body: { path }.
    //   Snippet returns the file as base64. CRITICAL GOTCHA: Chrome MCP's
    //   content filter frequently blocks long base64 — prefer the cookie-file
    //   GET /claude-ai/skills/:id/file for reads.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/file\/read$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.path !== 'string' || !b.path) {
          return { success: false, error: { code: 'MISSING_PATH', message: 'body.path is required' } };
        }
        try {
          return { success: true, data: snippetReadSkillFile(req.params.id, b.path) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/file/put — WRITE snippet (in-page RMW).
    //   Body: { path, content? | contentBase64? } (content = utf-8 text).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/file\/put$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.path !== 'string' || !b.path) {
          return { success: false, error: { code: 'MISSING_PATH', message: 'body.path is required' } };
        }
        let contentBase64: string;
        if (typeof b.contentBase64 === 'string') contentBase64 = b.contentBase64;
        else if (typeof b.content === 'string') contentBase64 = Buffer.from(b.content, 'utf8').toString('base64');
        else return { success: false, error: { code: 'MISSING_CONTENT', message: 'body.content (utf-8 string) or body.contentBase64 (base64 bytes) is required' } };
        try {
          return { success: true, data: snippetPutSkillFile(req.params.id, b.path, contentBase64) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/file/delete — WRITE (destructive)
    //   snippet (in-page RMW). Body: { path }.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/file\/delete$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.path !== 'string' || !b.path) {
          return { success: false, error: { code: 'MISSING_PATH', message: 'body.path is required' } };
        }
        try {
          return { success: true, data: snippetDeleteSkillFile(req.params.id, b.path) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/rename — WRITE snippet (rename-skill).
    //   Body: { name } (alias: newName).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/rename$/,
      handler: async (req) => {
        const b = req.body || {};
        const newName = typeof b.newName === 'string' ? b.newName : (typeof b.name === 'string' ? b.name : '');
        if (!newName) {
          return { success: false, error: { code: 'MISSING_NAME', message: 'body.name (or body.newName) is required' } };
        }
        try {
          return { success: true, data: snippetRenameSkill(req.params.id, newName) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/duplicate — WRITE snippet (duplicate-skill).
    //   Body: { name? } (alias: newName).
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/duplicate$/,
      handler: async (req) => {
        const b = req.body || {};
        const newName = typeof b.newName === 'string' ? b.newName : (typeof b.name === 'string' ? b.name : undefined);
        try {
          return { success: true, data: snippetDuplicateSkill(req.params.id, newName) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },

    // POST /claude-ai/via-chrome/skills/:id/delete-org — WRITE (destructive)
    //   snippet (delete-org-skill). ORG-scoped; distinct from .../delete.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/via-chrome\/skills\/(?<id>[^/?]+)\/delete-org$/,
      handler: async (req) => {
        try {
          return { success: true, data: snippetDeleteOrgSkill(req.params.id) };
        } catch (err) {
          return { success: false, error: { code: 'INVALID_REQUEST', message: (err as Error).message } };
        }
      },
    },


    // POST /claude-ai/browser/via-chrome/identify
    //   Returns a snippet that fetches /api/organizations from the running
    //   claude.ai tab. The snippet's response leaks the logged-in email via
    //   the org name ("<email>'s Organization"). The route also returns the
    //   profile list so the caller can match email → profile id.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/browser\/via-chrome\/identify$/,
      handler: async () => {
        try {
          const snippet = buildViaChromeSnippet({
            path: '/api/organizations',
            description: 'Identify which Chrome profile the MCP tab is using (via logged-in email)',
          });
          return {
            success: true,
            data: {
              snippet,
              profiles: listChromeProfiles().profiles,
              note: "Run the snippet via mcp__claude-in-chrome__javascript_tool. The first org's name typically contains the logged-in email (\"<email>'s Organization\"); match that email against profiles[].userName.",
            },
          };
        } catch (err) {
          return {
            success: false,
            error: { code: 'INVALID_REQUEST', message: (err as Error).message },
          };
        }
      },
    },

    
    
    
    // POST /claude-ai/browser/install-idle-banner
    //   Body: { port?: number, baseText?: string, noteText?: string }
    //   Attaches via CDP to every page target on the spawned browser and
    //   installs the lm-assist banner with an "Idle" status. The banner
    //   persists across navigations (registered as a doc-init script) and
    //   is re-used by subsequent via-chrome /completion snippets that pass
    //   `showOverlay: true` — those will update the banner's status during
    //   the request, then reset it to "Idle" instead of removing the
    //   banner. Call once after `launch` when you want the user to always
    //   see what the browser is for.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/browser\/install-idle-banner$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; baseText?: string; noteText?: string };
        const port = typeof b.port === 'number' && b.port > 0 ? b.port : 9222;
        const baseText = typeof b.baseText === 'string' && b.baseText.length > 0
          ? b.baseText : 'lm-assist · managed browser';
        const noteText = typeof b.noteText === 'string' && b.noteText.length > 0
          ? b.noteText
          : "This browser was opened by lm-assist for claude.ai API access. Don't navigate away or close — incoming lm-assist requests run inside this tab and the result is reported back to whoever asked.";
        // Thin wrapper around installBanner() with the lm-assist-idle preset:
        //   - id 'lm-assist-idle' (compatibility with via-chrome snippet's
        //     showOverlay reuse path is preserved by also setting a
        //     `window.__lmAssistViaOverlay` shim inside the script — but
        //     the new banner system already exposes
        //     `window.__lmAssistBanners[id]` for the same purpose, and the
        //     via-chrome snippet was updated to recognize either form below).
        //   - host match: claude.ai + subdomains + anthropic.com + Google
        //     SSO; mismatch → redirect to https://claude.ai/.
        try {
          const result = await installBanner(port, {
            id: 'lm-assist-idle',
            title: baseText,
            status: 'Idle. Waiting for next lm-assist request.',
            statusKind: 'ok',
            note: noteText,
            theme: 'dark',
            match: { include: ['claude.ai', '*.claude.ai', '*.anthropic.com', 'accounts.google.com'] },
            onMismatch: { action: 'redirect', redirectTo: 'https://claude.ai/', redirectAfterMs: 1800 },
          });
          return { success: true, data: { ...result, banner: { baseText, noteText } } };
        } catch (e) {
          return { success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } };
        }
      },
    },

    
    
    

    // POST /claude-ai/browser/capture-session
    //   Body: { port?: number, profile?: <profile-id>, setCanonical?: boolean }
    //   Attaches to the debug-port Chrome via CDP, dumps cookies for
    //   claude.ai, writes ~/.claude/claudeai-session.<profile>.json and
    //   (default true) ~/.claude/claudeai-session.json. Returns metadata
    //   only — never the cookie value itself.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/browser\/capture-session$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; profile?: string; setCanonical?: boolean };
        // If a named profile is given, validate it exists so the caller gets
        // a clear error before any CDP work. 'isolated' is always allowed.
        if (b.profile && b.profile !== 'isolated') {
          const p = resolveProfile(b.profile);
          if (!p) {
            return {
              success: false,
              error: {
                code: 'PROFILE_NOT_FOUND',
                message: `No Chrome profile matches '${b.profile}'. See GET /browser/profiles.`,
              },
            };
          }
        }
        const result = await captureSession({
          port: typeof b.port === 'number' ? b.port : undefined,
          profileId: typeof b.profile === 'string' ? b.profile : undefined,
          setCanonical: typeof b.setCanonical === 'boolean' ? b.setCanonical : undefined,
        });
        if (!result.ok) {
          return {
            success: false,
            error: { code: result.code.toUpperCase(), message: result.message, hint: result.hint },
          };
        }
        return { success: true, data: result };
      },
    },

    // POST /claude-ai/browser/launch-and-capture
    //   Body: { profile?, port?, headless?, loginTimeoutMs?, setCanonical? }
    //
    //   One-shot composite: launches Chrome (default isolated), injects a
    //   user-facing overlay explaining what to do, polls Chrome's cookie
    //   store until `sessionKey` appears, then captures + writes session
    //   files. Long-running — caller should set request timeout to at
    //   least loginTimeoutMs (default 180_000).
    //
    //   If the spawned profile dir already has a valid session (returning
    //   user), the login wait is skipped and capture happens immediately.
    {
      method: 'POST',
      pattern: /^\/claude-ai\/browser\/launch-and-capture$/,
      handler: async (req) => {
        const b = (req.body || {}) as {
          profile?: string;
          port?: number;
          headless?: boolean;
          browser?: BrowserKind | 'any-chromium';
          loginTimeoutMs?: number;
          pollIntervalMs?: number;
          setCanonical?: boolean;
        };
        const result = await launchAndCapture({
          profile: typeof b.profile === 'string' ? b.profile : undefined,
          port: typeof b.port === 'number' ? b.port : undefined,
          headless: typeof b.headless === 'boolean' ? b.headless : undefined,
          browser: typeof b.browser === 'string' ? b.browser : undefined,
          loginTimeoutMs: typeof b.loginTimeoutMs === 'number' ? b.loginTimeoutMs : undefined,
          pollIntervalMs: typeof b.pollIntervalMs === 'number' ? b.pollIntervalMs : undefined,
          setCanonical: typeof b.setCanonical === 'boolean' ? b.setCanonical : undefined,
        });
        if (!result.ok) {
          const errCode = 'code' in result ? result.code : 'launch_failed';
          const message = 'message' in result ? result.message : 'Unknown launch error';
          const hint = 'hint' in result ? result.hint : undefined;
          // Surface partial state so caller can call /close on the pid if launch succeeded but a later step failed.
          const partial = 'launch' in result ? { launch: (result as { launch?: unknown }).launch } : undefined;
          return {
            success: false,
            error: { code: errCode.toUpperCase(), message, hint },
            data: partial,
          };
        }
        return { success: true, data: result };
      },
    },

      ];
}

// ---------------------------------------------------------------------------
// POST /claude-ai/conversations/:uuid/completion/stream — streaming variant of
// the blocking /completion route, for embedded browser chat clients.
//
// Emits Server-Sent Events over the raw response socket (special-cased in
// rest-server.ts because the buffered ApiResponse can't stream). Event frames:
//   - every upstream claude.ai SSE event, verbatim under its original type
//     (message_start, content_block_start, content_block_delta, …) — the
//     client renders text deltas + tool_use starts live;
//   - synthetic lm_* progress events from the auto-approve phase
//     (lm_approval_fired, lm_approvals, lm_continuation_text);
//   - one final `lm_result` with the blocking route's compact result shape
//     (status, text, uuids, approvals, eventCount) — the client treats this
//     as end-of-turn; then the stream closes.
//   - on failure: `lm_error` { message } and the stream closes.
//
// Body: same as the blocking route ({ prompt, model?, enableConnectorTools?,
// autoApproveTools?, timeoutMs?, attachments?, … }). Auth (full or scoped
// token) has already run in rest-server before this is called.
//
// Client disconnect does NOT abort the upstream turn — the completion keeps
// running server-side so the turn still lands in the conversation, and the
// client picks it up from GET /:uuid/messages on reconnect.
// ---------------------------------------------------------------------------
export async function handleCompletionStream(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  uuid: string,
): Promise<void> {
  const sendJsonErr = (status: number, code: string, message: string): void => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code, message } }));
  };

  // Read + parse the body ourselves (special-cased before parseRequest).
  let body: Record<string, unknown>;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 2 * 1024 * 1024) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (err) {
    return sendJsonErr(400, 'BAD_BODY', (err as Error).message);
  }
  if (typeof body.prompt !== 'string' || !body.prompt) {
    return sendJsonErr(400, 'MISSING_PROMPT', 'body.prompt is required (non-empty string)');
  }

  let closed = false;
  req.on('close', () => { closed = true; });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (type: string, data: unknown): void => {
    if (closed) return;
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { closed = true; }
  };
  // Keep intermediaries from idling the socket out during long tool phases.
  const hb = setInterval(() => { if (!closed) { try { res.write(':hb\n\n'); } catch { closed = true; } } }, 15_000);
  hb.unref?.();

  try {
    const { toolsArr, autoApprove } = await resolveDrivenTools(body);
    const r = await sendMessage(uuid, body.prompt, {
      model: typeof body.model === 'string' ? body.model : undefined,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      locale: typeof body.locale === 'string' ? body.locale : undefined,
      parentMessageUuid: typeof body.parentMessageUuid === 'string' ? body.parentMessageUuid : undefined,
      tools: toolsArr,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
      files: Array.isArray(body.files) ? (body.files as string[]) : undefined,
      syncSources: Array.isArray(body.syncSources) ? (body.syncSources as string[])
        : Array.isArray(body.sync_sources) ? (body.sync_sources as string[]) : undefined,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      autoApproveTools: autoApprove,
      onEvent: emit,
    });
    emit('lm_result', {
      status: r.status,
      text: r.text,
      humanMessageUuid: r.humanMessageUuid,
      assistantMessageUuid: r.assistantMessageUuid,
      eventCount: r.events.length,
      approvals: r.approvals,
    });
  } catch (err) {
    emit('lm_error', { message: (err as Error).message });
  } finally {
    clearInterval(hb);
    try { res.end(); } catch { /* already gone */ }
  }
}
