/**
 * LinkedIn Connector Routes (local / CDP deployment).
 *
 * Drives a logged-in linkedin.com session over CDP (cdp-client.ts) and mirrors
 * messaging into the shared store (linkedin/store.ts). Reads come from what this
 * node has INGESTED over time (LinkedIn virtualizes its lists — only rendered
 * rows exist); feed + notifications are live scrapes.
 *
 *   GET  /linkedin/status              provider + logged-in state + ingested counts
 *   GET  /linkedin/conversations?limit= list conversations (syncs the rendered list first)
 *   GET  /linkedin/messages?chat=      read a conversation (opens + ingests it first)
 *   GET  /linkedin/search?q=           substring search over ingested messages
 *   POST /linkedin/send                { to, text } — open the conversation + send
 *   GET  /linkedin/feed?limit=         live-scrape recent feed posts
 *   GET  /linkedin/notifications?limit= live-scrape recent notifications
 *   POST /linkedin/post                { text } — publish a feed post
 *   POST /linkedin/article             { title, body } — publish a long-form Article
 *   POST /linkedin/login               launch/drive a login browser
 *   GET  /linkedin/login/status?port=  poll the login browser
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import * as os from 'os';
import { linkedinProvider } from '../../linkedin/config';
import * as store from '../../linkedin/store';
import {
  cdpStatus,
  syncConversations,
  syncThread,
  sendMessage,
  readFeed,
  readNotifications,
  createPost,
  publishArticle,
  searchPeople,
  followProfile,
  connectProfile,
  messageProfile,
  commentOnPost,
  deletePost,
  keepSessionWarm,
  canonicalChatId,
  LiError,
} from '../../linkedin/cdp-client';
import { linkedinLogin, linkedinLoginStatus } from '../../linkedin/login';
import { startLinkedinKeepAlive } from '../../linkedin/keepalive';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Map a thrown error to the structured { success:false, error } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof LiError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

export function createLinkedinRoutes(_ctx: RouteContext): RouteHandler[] {
  // Start the session keep-alive once at Core boot (idempotent; quiet unless the
  // session drops). Keeps the logged-in LinkedIn session from idle-expiring.
  startLinkedinKeepAlive();
  return [
    // GET /linkedin/status — provider + logged-in state + ingested counts.
    {
      method: 'GET',
      pattern: /^\/linkedin\/status$/,
      handler: async () => {
        let loggedIn = false;
        let self: string | null = null;
        try {
          const s = await cdpStatus();
          loggedIn = s.loggedIn;
          self = s.self;
        } catch {
          /* CDP unreachable — report loggedIn:false but still return store stats */
        }
        return {
          success: true,
          data: {
            provider: linkedinProvider(),
            location: 'local',
            host: os.hostname(),
            backend: 'cdp-browser',
            self,
            loggedIn,
            ...store.stats(),
          },
        };
      },
    },

    // GET /linkedin/conversations?limit= — sync the rendered list, then return.
    {
      method: 'GET',
      pattern: /^\/linkedin\/conversations$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 30, 1, 200);
        try {
          await syncConversations();
        } catch (e) {
          return fail(e);
        }
        return { success: true, data: { chats: store.listChats(limit) } };
      },
    },

    // GET /linkedin/messages?chat=&limit=&markRead= — open + ingest, then read.
    {
      method: 'GET',
      pattern: /^\/linkedin\/messages$/,
      handler: async (req: ParsedRequest) => {
        const rawChat = String(req.query?.chat || '').trim();
        if (!rawChat) return { success: false, error: '`chat` query param (thread id or participant name) is required' };
        const chatId = canonicalChatId(rawChat);
        const limit = clampInt(req.query?.limit, 30, 1, 500);
        try {
          await syncThread(rawChat);
        } catch (e) {
          return fail(e);
        }
        const messages = store.getMessages(chatId, limit);
        if (req.query?.markRead === 'true') store.markChatRead(chatId);
        return { success: true, data: { chatId, messages } };
      },
    },

    // GET /linkedin/search?q=&limit= — over ingested/cached messages.
    {
      method: 'GET',
      pattern: /^\/linkedin\/search$/,
      handler: async (req: ParsedRequest) => {
        const q = String(req.query?.q || '').trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 20, 1, 100);
        return { success: true, data: { query: q, results: store.search(q, limit) } };
      },
    },

    // POST /linkedin/send — { to, text }.
    {
      method: 'POST',
      pattern: /^\/linkedin\/send$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const to = String(body.to || '').trim();
        if (!to) return { success: false, error: '`to` (thread id or participant name) is required' };
        const text = body.text !== undefined ? String(body.text) : '';
        if (!text) return { success: false, error: '`text` is required' };
        try {
          const { messageId, chatId, contactName } = await sendMessage(to, text);
          const ts = Math.floor(Date.now() / 1000);
          store.addOutbound({
            id: messageId,
            chatId,
            direction: 'out',
            from: 'me',
            to: chatId,
            type: 'text',
            text,
            timestamp: ts,
            status: 'sent',
            contactName: contactName || undefined,
          });
          return { success: true, data: { messageId, to: chatId } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /linkedin/feed?limit= — live-scrape recent feed posts.
    {
      method: 'GET',
      pattern: /^\/linkedin\/feed$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 15, 1, 50);
        try {
          const posts = await readFeed(limit);
          return { success: true, data: { posts } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /linkedin/notifications?limit= — live-scrape recent notifications.
    {
      method: 'GET',
      pattern: /^\/linkedin\/notifications$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 20, 1, 50);
        try {
          const notifications = await readNotifications(limit);
          return { success: true, data: { notifications } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/post — { text }. Publish a feed post.
    {
      method: 'POST',
      pattern: /^\/linkedin\/post$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const text = body.text !== undefined ? String(body.text) : '';
        if (!text.trim()) return { success: false, error: '`text` is required' };
        try {
          await createPost(text);
          return { success: true, data: { posted: true } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/article — { title, body }. Publish a long-form Article.
    {
      method: 'POST',
      pattern: /^\/linkedin\/article$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const title = body.title !== undefined ? String(body.title) : '';
        const content = body.body !== undefined ? String(body.body) : '';
        if (!title.trim()) return { success: false, error: '`title` is required' };
        if (!content.trim()) return { success: false, error: '`body` is required' };
        try {
          await publishArticle(title, content);
          return { success: true, data: { published: true } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/login — launch a controlled Chrome at linkedin.com. Body:
    //   { port?, headless?, profile? }. The browser stays alive so the user can
    //   log in; close it later via POST /browser/close {pid}.
    {
      method: 'POST',
      pattern: /^\/linkedin\/login$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const port = typeof body.port === 'number' ? body.port : undefined;
        const headless = typeof body.headless === 'boolean' ? body.headless : undefined;
        const profile = typeof body.profile === 'string' ? body.profile : undefined;
        const res = await linkedinLogin({ port, headless, profile });
        if (!res.ok) {
          return { success: false, error: res.message, code: res.code, hint: res.hint, installedBrowsers: res.installedBrowsers };
        }
        return { success: true, data: res };
      },
    },

    // GET /linkedin/people?q=&limit= — search people by name/keywords.
    {
      method: 'GET',
      pattern: /^\/linkedin\/people$/,
      handler: async (req: ParsedRequest) => {
        const q = String(req.query?.q || '').trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 8, 1, 20);
        try {
          return { success: true, data: { query: q, results: await searchPeople(q, limit) } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/follow — { profile }. Follow a person.
    {
      method: 'POST',
      pattern: /^\/linkedin\/follow$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const profile = String(body.profile || '').trim();
        if (!profile) return { success: false, error: '`profile` (handle, /in/ URL, or name) is required' };
        try {
          return { success: true, data: await followProfile(profile) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/connect — { profile, note? }. Send a connection request.
    {
      method: 'POST',
      pattern: /^\/linkedin\/connect$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const profile = String(body.profile || '').trim();
        if (!profile) return { success: false, error: '`profile` (handle, /in/ URL, or name) is required' };
        const note = body.note !== undefined ? String(body.note) : undefined;
        try {
          return { success: true, data: await connectProfile(profile, note) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/message-profile — { profile, text }. Message a person by profile.
    {
      method: 'POST',
      pattern: /^\/linkedin\/message-profile$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const profile = String(body.profile || '').trim();
        const text = body.text !== undefined ? String(body.text) : '';
        if (!profile) return { success: false, error: '`profile` is required' };
        if (!text.trim()) return { success: false, error: '`text` is required' };
        try {
          return { success: true, data: await messageProfile(profile, text) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/comment — { text, match? }. Comment on a feed post.
    {
      method: 'POST',
      pattern: /^\/linkedin\/comment$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const text = body.text !== undefined ? String(body.text) : '';
        const match = body.match !== undefined ? String(body.match) : '';
        if (!text.trim()) return { success: false, error: '`text` is required' };
        try {
          return { success: true, data: await commentOnPost(text, match) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/delete-post — { match? }. Delete one of your own posts.
    {
      method: 'POST',
      pattern: /^\/linkedin\/delete-post$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const match = body.match !== undefined ? String(body.match) : '';
        try {
          return { success: true, data: await deletePost(match) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /linkedin/keepalive — issue one authenticated warm-up request to keep
    //   the session from idle-expiring; also runs automatically on a timer.
    {
      method: 'POST',
      pattern: /^\/linkedin\/keepalive$/,
      handler: async () => {
        try {
          return { success: true, data: await keepSessionWarm() };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /linkedin/login/status?port= — poll the login browser.
    {
      method: 'GET',
      pattern: /^\/linkedin\/login\/status$/,
      handler: async (req: ParsedRequest) => {
        const port = req.query?.port ? clampInt(req.query.port, 9223, 1, 65535) : undefined;
        const res = await linkedinLoginStatus({ port });
        if ('ok' in res && res.ok === false) {
          return { success: false, error: res.message, code: res.code, hint: res.hint };
        }
        return { success: true, data: res };
      },
    },
  ];
}
