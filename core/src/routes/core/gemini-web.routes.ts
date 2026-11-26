/**
 * Gemini Web (`https://gemini.google.com/`) Via-Chrome JS Bridge Routes
 *
 * Mirrors the `/claude-ai/via-chrome/*` family in `claude-ai.routes.ts`:
 * returns self-contained JavaScript snippets to run inside an authenticated
 * `https://gemini.google.com/*` Chrome tab via
 * `mcp__claude-in-chrome__javascript_tool` or `POST /browser/tabs/:id/eval`.
 *
 * Unary operations use same-origin `POST /_/BardChatUi/data/batchexecute`
 * with session tokens from `window.WIZ_global_data`. Chat generation drives
 * the Gemini SPA UI so Chrome handles `SAPISIDHASH`, `X-Server-Token`, and
 * WAA attestation (`waa-pa.clients6.google.com`) natively, then reads back the
 * completed turn via `hNvQHb`.
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  buildGeminiBatchExecuteSnippet,
  snippetHealthCheck,
  snippetListModels,
  snippetListConversations,
  snippetReadConversation,
  snippetRenameConversation,
  snippetDeleteConversation,
  snippetGetUsage,
  snippetUserProfile,
  snippetListGems,
  snippetSavedInfo,
  snippetScheduledTasks,
  snippetExtensions,
  snippetNotebooks,
  snippetSubscriptionBanner,
  snippetTurnMetadata,
  snippetIdentify,
  snippetSendMessage,
  snippetCreateConversation,
  snippetSwitchModel,
  snippetSelectTool,
  snippetUploadAttachment,
  snippetProcessFile,
  snippetListAttachments,
  snippetDownloadAttachment,
  type GeminiViaChromeSnippet,
} from '../../utils/gemini-web-via-chrome';
import {
  geminiWebCdpDeleteConversation,
  geminiWebCdpOverview,
  geminiWebCdpSend,
} from '../../utils/gemini-web-cdp';
import { listChromeProfiles } from '../../utils/claudeai-browser-profile';
import { installBanner } from '../../utils/claudeai-banner';
import type { BrowserKind } from '../../utils/claudeai-browser-launch';
import {
  DEFAULT_GEMINI_CDP_PORT,
  geminiWebLogin,
  geminiWebLoginStatus,
} from '../../utils/gemini-web-login';

function wrapSnippet(fn: () => GeminiViaChromeSnippet) {
  try {
    return { success: true, data: fn() };
  } catch (err) {
    return {
      success: false,
      error: { code: 'INVALID_REQUEST', message: (err as Error).message },
    };
  }
}

export function createGeminiWebRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /gemini-web/via-chrome/health-check
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/health-check$/,
      handler: async () => ({ success: true, data: snippetHealthCheck() }),
    },

    // POST /gemini-web/via-chrome
    //   Body: { rpcId, args?, sourcePath?, hl?, description?, write?, destructive? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.rpcId !== 'string' || !b.rpcId.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_RPC_ID', message: 'body.rpcId is required' },
          };
        }
        if (b.args !== undefined && !Array.isArray(b.args)) {
          return {
            success: false,
            error: { code: 'INVALID_ARGS', message: 'body.args must be an array when provided' },
          };
        }
        return wrapSnippet(() =>
          buildGeminiBatchExecuteSnippet({
            rpcId: b.rpcId as string,
            args: Array.isArray(b.args) ? b.args : [],
            sourcePath: typeof b.sourcePath === 'string' ? b.sourcePath : undefined,
            hl: typeof b.hl === 'string' ? b.hl : undefined,
            description: typeof b.description === 'string' ? b.description : undefined,
            write: typeof b.write === 'boolean' ? b.write : undefined,
            destructive: typeof b.destructive === 'boolean' ? b.destructive : undefined,
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/models
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/models$/,
      handler: async () => ({ success: true, data: snippetListModels() }),
    },

    // POST /gemini-web/via-chrome/models/switch
    //   Body: { model, thinkingLevel? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/models\/switch$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.model !== 'string' || !b.model.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_MODEL', message: 'body.model is required (non-empty string)' },
          };
        }
        const tl = b.thinkingLevel ?? b.thinking_level;
        return wrapSnippet(() =>
          snippetSwitchModel(b.model as string, {
            thinkingLevel: typeof tl === 'string' || typeof tl === 'number' ? tl : undefined,
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/tools/select
    //   Body: { tool }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/tools\/select$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.tool !== 'string' || !b.tool.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_TOOL', message: 'body.tool is required (non-empty string)' },
          };
        }
        return wrapSnippet(() => snippetSelectTool(b.tool as string));
      },
    },

    // POST /gemini-web/via-chrome/conversations
    //   Body: { limit?, cursor? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        return wrapSnippet(() =>
          snippetListConversations({
            limit: typeof b.limit === 'number' ? b.limit : undefined,
            cursor: typeof b.cursor === 'string' ? b.cursor : b.cursor === null ? null : undefined,
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/conversations/create
    //   Body: { prompt?, model?, thinkingLevel?, tool?, timeoutMs?, showOverlay? }
    //   MUST be registered BEFORE /conversations/:id (first-match-wins router).
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/create$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const tl = b.thinkingLevel ?? b.thinking_level;
        return wrapSnippet(() =>
          snippetCreateConversation({
            prompt: typeof b.prompt === 'string' ? b.prompt : undefined,
            model: typeof b.model === 'string' ? b.model : undefined,
            thinkingLevel: typeof tl === 'string' || typeof tl === 'number' ? tl : undefined,
            tool: typeof b.tool === 'string' ? b.tool : undefined,
            timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
            showOverlay: typeof b.showOverlay === 'boolean'
              ? b.showOverlay
              : (typeof b.show_overlay === 'boolean' ? b.show_overlay : undefined),
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/conversations/send
    //   Body: { prompt, convId?, tool?, timeoutMs?, showOverlay? }
    //   MUST be registered BEFORE /conversations/:id (first-match-wins router).
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/send$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.prompt !== 'string' || !b.prompt.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_PROMPT', message: 'body.prompt is required (non-empty string)' },
          };
        }
        return wrapSnippet(() =>
          snippetSendMessage(b.prompt as string, {
            convId: typeof b.convId === 'string' ? b.convId : undefined,
            tool: typeof b.tool === 'string' ? b.tool : undefined,
            timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
            showOverlay: typeof b.showOverlay === 'boolean'
              ? b.showOverlay
              : (typeof b.show_overlay === 'boolean' ? b.show_overlay : undefined),
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/conversations/:id/rename
    //   Body: { title } (or { name })
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/(?<id>[^/?]+)\/rename$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const title = typeof b.title === 'string' ? b.title : (typeof b.name === 'string' ? b.name : '');
        if (!title.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_TITLE', message: 'body.title (or body.name) is required' },
          };
        }
        return wrapSnippet(() => snippetRenameConversation(req.params.id, title));
      },
    },

    // POST /gemini-web/via-chrome/conversations/:id/delete
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/(?<id>[^/?]+)\/delete$/,
      handler: async (req) => wrapSnippet(() => snippetDeleteConversation(req.params.id)),
    },

    // POST /gemini-web/via-chrome/conversations/:id/send
    //   Body: { prompt, tool?, timeoutMs?, showOverlay? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/(?<id>[^/?]+)\/send$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.prompt !== 'string' || !b.prompt.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_PROMPT', message: 'body.prompt is required (non-empty string)' },
          };
        }
        return wrapSnippet(() =>
          snippetSendMessage(b.prompt as string, {
            convId: req.params.id,
            tool: typeof b.tool === 'string' ? b.tool : undefined,
            timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
            showOverlay: typeof b.showOverlay === 'boolean'
              ? b.showOverlay
              : (typeof b.show_overlay === 'boolean' ? b.show_overlay : undefined),
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/conversations/:id/attachments
    //   Body: { maxTurns? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/(?<id>[^/?]+)\/attachments$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        return wrapSnippet(() =>
          snippetListAttachments(req.params.id, {
            maxTurns: typeof b.maxTurns === 'number' ? b.maxTurns : undefined,
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/conversations/:id
    //   Body: { maxTurns? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/conversations\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        return wrapSnippet(() =>
          snippetReadConversation(req.params.id, {
            maxTurns: typeof b.maxTurns === 'number' ? b.maxTurns : undefined,
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/attachments/upload
    //   Body: { filename, contentBase64, mimeType? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/attachments\/upload$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.filename !== 'string' || !b.filename.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_FILENAME', message: 'body.filename is required' },
          };
        }
        const b64 = typeof b.contentBase64 === 'string'
          ? b.contentBase64
          : (typeof b.content_base64 === 'string' ? b.content_base64 : '');
        if (!b64.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_CONTENT', message: 'body.contentBase64 is required' },
          };
        }
        return wrapSnippet(() =>
          snippetUploadAttachment({
            filename: b.filename as string,
            contentBase64: b64,
            mimeType: typeof b.mimeType === 'string'
              ? b.mimeType
              : (typeof b.mime_type === 'string' ? b.mime_type : undefined),
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/attachments/process-file
    //   Body: { blobPath, filename, mimeType }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/attachments\/process-file$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.blobPath !== 'string' || !b.blobPath.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_BLOB_PATH', message: 'body.blobPath is required' },
          };
        }
        if (typeof b.filename !== 'string' || !b.filename.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_FILENAME', message: 'body.filename is required' },
          };
        }
        if (typeof b.mimeType !== 'string' || !b.mimeType.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_MIME_TYPE', message: 'body.mimeType is required' },
          };
        }
        return wrapSnippet(() =>
          snippetProcessFile({
            blobPath: b.blobPath as string,
            filename: b.filename as string,
            mimeType: b.mimeType as string,
          }),
        );
      },
    },

    // POST /gemini-web/via-chrome/attachments/download
    //   Body: { url }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/attachments\/download$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        if (typeof b.url !== 'string' || !b.url.trim()) {
          return {
            success: false,
            error: { code: 'MISSING_URL', message: 'body.url is required' },
          };
        }
        return wrapSnippet(() => snippetDownloadAttachment(b.url as string));
      },
    },

    // POST /gemini-web/via-chrome/usage
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/usage$/,
      handler: async () => ({ success: true, data: snippetGetUsage() }),
    },

    // POST /gemini-web/via-chrome/profile
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/profile$/,
      handler: async () => ({ success: true, data: snippetUserProfile() }),
    },

    // POST /gemini-web/via-chrome/gems
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/gems$/,
      handler: async () => ({ success: true, data: snippetListGems() }),
    },

    // POST /gemini-web/via-chrome/saved-info
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/saved-info$/,
      handler: async () => ({ success: true, data: snippetSavedInfo() }),
    },

    // POST /gemini-web/via-chrome/scheduled-tasks
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/scheduled-tasks$/,
      handler: async () => ({ success: true, data: snippetScheduledTasks() }),
    },

    // POST /gemini-web/via-chrome/extensions
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/extensions$/,
      handler: async () => ({ success: true, data: snippetExtensions() }),
    },

    // POST /gemini-web/via-chrome/notebooks
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/notebooks$/,
      handler: async () => ({ success: true, data: snippetNotebooks() }),
    },

    // POST /gemini-web/via-chrome/subscription
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/subscription$/,
      handler: async () => ({ success: true, data: snippetSubscriptionBanner() }),
    },

    // POST /gemini-web/via-chrome/turns/:id
    {
      method: 'POST',
      pattern: /^\/gemini-web\/via-chrome\/turns\/(?<id>[^/?]+)$/,
      handler: async (req) => wrapSnippet(() => snippetTurnMetadata(req.params.id)),
    },

    // POST /gemini-web/browser/via-chrome/identify
    {
      method: 'POST',
      pattern: /^\/gemini-web\/browser\/via-chrome\/identify$/,
      handler: async () => {
        try {
          const snippet = snippetIdentify();
          return {
            success: true,
            data: {
              snippet,
              profiles: listChromeProfiles().profiles,
              note: 'Run the snippet in the active Gemini tab; match returned `email` against profiles[].userName.',
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

    // POST /gemini-web/browser/install-idle-banner
    //   Body: { port?: number, baseText?: string, noteText?: string }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/browser\/install-idle-banner$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number; baseText?: string; noteText?: string };
        const port = typeof b.port === 'number' && b.port > 0 ? b.port : 9222;
        const baseText =
          typeof b.baseText === 'string' && b.baseText.length > 0
            ? b.baseText
            : 'lm-assist · managed Gemini browser';
        const noteText =
          typeof b.noteText === 'string' && b.noteText.length > 0
            ? b.noteText
            : "This browser was opened by lm-assist for Gemini Web access. Don't navigate away or close — incoming lm-assist requests run inside this tab.";
        try {
          const result = await installBanner(port, {
            id: 'lm-assist-gemini-idle',
            title: baseText,
            status: 'Idle. Waiting for next lm-assist request.',
            statusKind: 'ok',
            note: noteText,
            theme: 'dark',
            match: { include: ['gemini.google.com', '*.google.com', 'accounts.google.com'] },
            onMismatch: {
              action: 'redirect',
              redirectTo: 'https://gemini.google.com/app',
              redirectAfterMs: 1800,
            },
          });
          return { success: true, data: { ...result, banner: { baseText, noteText } } };
        } catch (e) {
          return { success: false, error: { code: 'INTERNAL_ERROR', message: (e as Error).message } };
        }
      },
    },

    // POST /gemini-web/browser/login
    //   Body: { profile?, port?, headless?, browser? }
    {
      method: 'POST',
      pattern: /^\/gemini-web\/browser\/login$/,
      handler: async (req) => {
        const b = (req.body || {}) as {
          profile?: string;
          port?: number;
          headless?: boolean;
          browser?: BrowserKind | 'any-chromium';
        };
        const result = await geminiWebLogin({
          profile: typeof b.profile === 'string' ? b.profile : undefined,
          port: typeof b.port === 'number' && b.port > 0 ? b.port : undefined,
          headless: typeof b.headless === 'boolean' ? b.headless : undefined,
          browser: typeof b.browser === 'string' ? b.browser : undefined,
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

    // GET /gemini-web/browser/login/status?port=9225
    {
      method: 'GET',
      pattern: /^\/gemini-web\/browser\/login\/status$/,
      handler: async (req) => {
        const q = req.query || {};
        const parsed = typeof q.port === 'string' ? parseInt(q.port, 10) : NaN;
        const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GEMINI_CDP_PORT;
        const status = await geminiWebLoginStatus(port);
        if (!status.ok) {
          return {
            success: false,
            error: { code: status.reason.toUpperCase(), message: status.hint || status.reason },
            data: status,
          };
        }
        return { success: true, data: status };
      },
    },

    // POST /gemini-web/browser/send
    //   Body: { port?, convId?, createNew?, prompt, model?, thinkingLevel?, tool?, timeoutMs? }
    //   Core-side trusted CDP send (uses Input.dispatchKeyEvent Enter + BardVeMetadataKey + hNvQHb).
    {
      method: 'POST',
      pattern: /^\/gemini-web\/browser\/send$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const tl = b.thinkingLevel ?? b.thinking_level;
        const res = await geminiWebCdpSend({
          port: typeof b.port === 'number' && b.port > 0 ? b.port : undefined,
          convId: typeof b.convId === 'string' ? b.convId : undefined,
          createNew: typeof b.createNew === 'boolean' ? b.createNew : undefined,
          prompt: typeof b.prompt === 'string' ? b.prompt : '',
          model: typeof b.model === 'string' ? b.model : undefined,
          thinkingLevel: typeof tl === 'string' || typeof tl === 'number' ? tl : undefined,
          tool: typeof b.tool === 'string' ? b.tool : undefined,
          timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
        });
        if (!res.ok) {
          return {
            success: false,
            error: { code: res.code, message: res.message },
            ...(res.data !== undefined ? { data: res.data } : {}),
          };
        }
        return { success: true, data: res };
      },
    },

    // GET /gemini-web/browser/overview?port=9225&limit=20
    {
      method: 'GET',
      pattern: /^\/gemini-web\/browser\/overview$/,
      handler: async (req) => {
        const q = req.query || {};
        const parsedPort = typeof q.port === 'string' ? parseInt(q.port, 10) : NaN;
        const parsedLimit = typeof q.limit === 'string' ? parseInt(q.limit, 10) : NaN;
        const data = await geminiWebCdpOverview({
          port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined,
          limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined,
        });
        return { success: true, data };
      },
    },

    // POST /gemini-web/browser/conversations/:id/delete
    {
      method: 'POST',
      pattern: /^\/gemini-web\/browser\/conversations\/(?<id>[^/?]+)\/delete$/,
      handler: async (req) => {
        const b = (req.body || {}) as { port?: number };
        const res = await geminiWebCdpDeleteConversation({
          port: typeof b.port === 'number' && b.port > 0 ? b.port : undefined,
          convId: req.params.id || '',
        });
        if (!res.ok) {
          return {
            success: false,
            error: { code: res.code, message: res.message },
            ...(res.data !== undefined ? { data: res.data } : {}),
          };
        }
        return { success: true, data: res };
      },
    },
  ];
}
