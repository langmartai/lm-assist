/**
 * Gmail Connector Routes (local / CDP deployment).
 *
 * Drives a logged-in mail.google.com session over CDP (gmail/cdp-client.ts).
 * Every read is a LIVE read of the rendered mail app — unlike the LinkedIn
 * connector there is no local message store, because Gmail can backfill its own
 * history and owns read-state server-side, so mirroring it locally would be
 * duplicated state that goes stale.
 *
 *   GET  /gmail/status                provider + logged-in state + account
 *   GET  /gmail/threads?limit=&label= list threads in a mailbox view
 *   GET  /gmail/thread?id=            open one thread, return its messages
 *   GET  /gmail/search?q=&limit=      Gmail query syntax (from:, is:unread, …)
 *   GET  /gmail/unread?limit=         shorthand for is:unread
 *   GET  /gmail/labels                labels from the left nav
 *   POST /gmail/send                  { to, subject, body }
 *   POST /gmail/reply                 { threadId, body }
 *   POST /gmail/draft                 { to, subject, body } — save, do not send
 *   POST /gmail/login                 launch/drive a login browser
 *   GET  /gmail/login/status?port=    poll the login browser
 *   POST /gmail/keepalive             force one keep-alive tick
 *
 * NOTE on the envelope: these handlers hand-roll `{ success, data }` / `fail(e)`
 * rather than using wrapResponse/wrapError, matching the linkedin + whatsapp
 * connector routes (neither uses wrapResponse). `fail()` preserves the thrown
 * GmError's `code`, which the MCP layer surfaces to callers.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import * as os from 'os';
import { gmailProvider, readGmailConfig, writeGmailConfig } from '../../gmail/config';
import {
  cdpStatus,
  listThreads,
  readThread,
  searchThreads,
  unreadThreads,
  listLabels,
  sendMail,
  draftMail,
  replyToThread,
  keepSessionWarm,
  GmError,
} from '../../gmail/cdp-client';
import { gmailLogin, gmailLoginStatus } from '../../gmail/login';
import { startGmailKeepAlive } from '../../gmail/keepalive';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Map a thrown error to the structured { success:false, error } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof GmError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createGmailRoutes(_ctx: RouteContext): RouteHandler[] {
  // Start the session keep-alive once at Core boot (idempotent; quiet unless the
  // session drops). Keeps the logged-in Google session from idle-expiring.
  startGmailKeepAlive();
  return [
    // GET /gmail/status — provider + logged-in state + account.
    {
      method: 'GET',
      pattern: /^\/gmail\/status$/,
      handler: async () => {
        let loggedIn = false;
        let self: string | null = null;
        try {
          const s = await cdpStatus();
          loggedIn = s.loggedIn;
          self = s.self;
          if (self) writeGmailConfig({ selfEmail: self });
        } catch {
          /* CDP unreachable — report loggedIn:false rather than failing the call */
        }
        return {
          success: true,
          data: {
            provider: gmailProvider(),
            location: 'local',
            host: os.hostname(),
            backend: 'cdp-browser',
            self: self ?? readGmailConfig().selfEmail ?? null,
            loggedIn,
          },
        };
      },
    },

    // GET /gmail/threads?limit=&label=
    {
      method: 'GET',
      pattern: /^\/gmail\/threads$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 25, 1, 100);
        const label = str(req.query?.label).trim() || 'inbox';
        try {
          const threads = await listThreads({ limit, label });
          return { success: true, data: { label, count: threads.length, limit, threads } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/thread?id=
    {
      method: 'GET',
      pattern: /^\/gmail\/thread$/,
      handler: async (req: ParsedRequest) => {
        const id = str(req.query?.id).trim();
        if (!id) return { success: false, error: '`id` query param (thread id) is required' };
        try {
          return { success: true, data: await readThread(id) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/search?q=&limit=
    {
      method: 'GET',
      pattern: /^\/gmail\/search$/,
      handler: async (req: ParsedRequest) => {
        const q = str(req.query?.q).trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 25, 1, 100);
        try {
          const threads = await searchThreads(q, limit);
          return { success: true, data: { query: q, count: threads.length, limit, threads } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/unread?limit=
    {
      method: 'GET',
      pattern: /^\/gmail\/unread$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 25, 1, 100);
        try {
          const threads = await unreadThreads(limit);
          return { success: true, data: { count: threads.length, limit, threads } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/labels
    {
      method: 'GET',
      pattern: /^\/gmail\/labels$/,
      handler: async () => {
        try {
          return { success: true, data: { labels: await listLabels() } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/send { to, subject, body }
    {
      method: 'POST',
      pattern: /^\/gmail\/send$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { to?: string; subject?: string; body?: string };
        const to = str(b.to).trim();
        if (!to) return { success: false, error: 'Body must include { to }' };
        try {
          return { success: true, data: await sendMail(to, str(b.subject), str(b.body)) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/reply { threadId, body }
    {
      method: 'POST',
      pattern: /^\/gmail\/reply$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { threadId?: string; body?: string };
        const threadId = str(b.threadId).trim();
        const body = str(b.body);
        if (!threadId) return { success: false, error: 'Body must include { threadId }' };
        if (!body.trim()) return { success: false, error: 'Body must include { body }' };
        try {
          return { success: true, data: await replyToThread(threadId, body) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/draft { to, subject, body }
    {
      method: 'POST',
      pattern: /^\/gmail\/draft$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { to?: string; subject?: string; body?: string };
        try {
          return { success: true, data: await draftMail(str(b.to), str(b.subject), str(b.body)) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/login { port?, headless?, profile? }
    {
      method: 'POST',
      pattern: /^\/gmail\/login$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { port?: number; headless?: boolean; profile?: string };
        const r = await gmailLogin({
          port: typeof b.port === 'number' ? b.port : undefined,
          headless: typeof b.headless === 'boolean' ? b.headless : undefined,
          profile: typeof b.profile === 'string' ? b.profile : undefined,
        });
        if (!r.ok) {
          return { success: false, error: r.message, code: r.code, hint: r.hint, installedBrowsers: r.installedBrowsers };
        }
        return { success: true, data: r };
      },
    },

    // GET /gmail/login/status?port=
    {
      method: 'GET',
      pattern: /^\/gmail\/login\/status$/,
      handler: async (req: ParsedRequest) => {
        const port = req.query?.port ? clampInt(req.query.port, 9224, 1, 65535) : undefined;
        const r = await gmailLoginStatus(port ? { port } : {});
        if ('ok' in r && r.ok === false) {
          return { success: false, error: r.message, code: r.code };
        }
        return { success: true, data: r };
      },
    },

    // POST /gmail/keepalive — force one keep-alive tick.
    {
      method: 'POST',
      pattern: /^\/gmail\/keepalive$/,
      handler: async () => {
        try {
          return { success: true, data: await keepSessionWarm() };
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}
