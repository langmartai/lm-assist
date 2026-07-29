/**
 * Gmail Connector Routes (local / CDP deployment).
 *
 * Drives a logged-in mail.google.com session over CDP (gmail/cdp-client.ts).
 * Reads come from the live mail app; writes drive the real UI.
 *
 * Local cache: unlike the LinkedIn store this is NOT a mirror of the account —
 * it is a bounded WINDOW (default 10 days) that `/gmail/sync` fills so
 * `/gmail/search-local` can answer instantly, offline, without a browser round
 * trip. Gmail still owns history and read-state; anything outside the window was
 * never fetched, which is exactly what `/gmail/sync-status` exists to say.
 *
 * Message bodies default to Gmail's RAW RFC822 source (`readThreadFull`): the
 * rendered view clips long messages ("[Message clipped]") and hides trimmed
 * quotes, so DOM scraping is lossy. `?full=false` opts back into the DOM read.
 *
 *   GET  /gmail/status                provider + logged-in state + account
 *   GET  /gmail/threads?limit=&label= list threads in a mailbox view
 *   GET  /gmail/thread?id=&full=      open one thread (full=1 → raw source, default)
 *   GET  /gmail/search?q=&limit=      Gmail query syntax (from:, is:unread, …)
 *   GET  /gmail/search-local?q=&limit= search the local window cache (no browser)
 *   GET  /gmail/attachments?threadId=&limit=  attachment metadata for a thread
 *   GET  /gmail/unread?limit=         shorthand for is:unread
 *   GET  /gmail/labels                labels from the left nav
 *   POST /gmail/sync                  { days?, label? } — fill the window cache
 *   GET  /gmail/sync-status           what the cache holds + how far back
 *   POST /gmail/send                  { to, subject, body, format? }
 *   POST /gmail/reply                 { threadId, body, format? }
 *   POST /gmail/draft                 { to, subject, body, format? } — save, do not send
 *   POST /gmail/login                 launch/drive a login browser
 *   GET  /gmail/login/status?port=    poll the login browser
 *   POST /gmail/keepalive             force one keep-alive tick
 *
 * `format` (send/reply/draft) is 'markdown' | 'text' | 'html', default
 * 'markdown' — markdown is rendered into real rich mail (bold, italics, links,
 * bulleted/numbered lists, blockquotes). Caller-plausible aliases are coerced;
 * anything else is refused LOUDLY, echoing what was sent, rather than silently
 * downgraded to plain text.
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
  readThreadFull,
  listAttachments,
  syncWindow,
  searchThreads,
  unreadThreads,
  listLabels,
  sendMail,
  draftMail,
  replyToThread,
  keepSessionWarm,
  listSendAs,
  GmError,
} from '../../gmail/cdp-client';
import { searchLocal, syncStatus } from '../../gmail/store';
import { gmailLogin, gmailLoginStatus } from '../../gmail/login';
import { startGmailKeepAlive } from '../../gmail/keepalive';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Query/body flag reader. Absent or unparseable → `def` (never a silent false). */
function bool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return def;
}

/** Map a thrown error to the structured { success:false, error } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof GmError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ─── body format ─────────────────────────────────────────────────────────────

const MAIL_FORMATS = ['markdown', 'text', 'html'] as const;
type MailFormat = (typeof MAIL_FORMATS)[number];

/** Aliases a caller could plausibly send for each format. */
const FORMAT_ALIASES: Record<string, MailFormat> = {
  markdown: 'markdown', md: 'markdown', 'text/markdown': 'markdown', mkd: 'markdown',
  text: 'text', txt: 'text', plain: 'text', plaintext: 'text', 'plain text': 'text', 'text/plain': 'text',
  html: 'html', htm: 'html', rich: 'html', 'text/html': 'html',
};

/**
 * Resolve `format`, defaulting to 'markdown'. Coerce the plausible aliases and
 * refuse everything else LOUDLY, echoing what was sent — a silently ignored
 * format ships the wrong-looking mail with no undo, which is worse than a 400.
 */
function resolveFormat(v: unknown): { format: MailFormat } | { error: string } {
  if (v === undefined || v === null || v === '') return { format: 'markdown' };
  if (typeof v !== 'string') {
    return { error: `\`format\` must be a string (${MAIL_FORMATS.join(' | ')}); got ${typeof v}` };
  }
  const hit = FORMAT_ALIASES[v.trim().toLowerCase()];
  if (hit) return { format: hit };
  return { error: `Unsupported \`format\` "${v}" — use one of: ${MAIL_FORMATS.join(', ')}` };
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
        let defaultSendAs: string | null = null;
        let sendAsCount = 0;
        let sendAsCheckedAt: number | null = null;
        let ui: string = 'unknown';
        try {
          const s = await cdpStatus();
          loggedIn = s.loggedIn;
          self = s.self;
          defaultSendAs = s.defaultSendAs;
          sendAsCount = s.sendAsCount;
          sendAsCheckedAt = s.sendAsCheckedAt;
          ui = s.ui;
          if (self) writeGmailConfig({ selfEmail: self });
        } catch {
          /* CDP unreachable — report loggedIn:false rather than failing the call */
        }
        const cfg = readGmailConfig();
        return {
          success: true,
          data: {
            provider: gmailProvider(),
            location: 'local',
            host: os.hostname(),
            backend: 'cdp-browser',
            self: self ?? cfg.selfEmail ?? null,
            loggedIn,
            // 🔴 MEASURED: the compose's hidden input[name="from"] is an ALIAS on
            // this account, not `self`. Reporting only `self` would misdescribe
            // every message the caller is about to send.
            defaultSendAs: defaultSendAs ?? cfg.defaultSendAs ?? null,
            sendAsCount,
            sendAsCheckedAt,
            ui,
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

    // GET /gmail/thread?id=&full= — full defaults to TRUE (raw RFC822 source).
    {
      method: 'GET',
      pattern: /^\/gmail\/thread$/,
      handler: async (req: ParsedRequest) => {
        const id = str(req.query?.id).trim();
        if (!id) return { success: false, error: '`id` query param (thread id) is required' };
        const full = bool(req.query?.full, true);
        try {
          const data = full ? await readThreadFull(id) : await readThread(id);
          // `source` tells the caller which read path produced these bodies, so a
          // clipped body is attributable instead of looking like the whole message.
          return { success: true, data: { ...data, source: full ? 'raw-source' : 'rendered-dom' } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/search?q=&limit= — Gmail's own server-side search.
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

    // GET /gmail/search-local?q=&limit= — the synced window only; no browser.
    {
      method: 'GET',
      pattern: /^\/gmail\/search-local$/,
      handler: async (req: ParsedRequest) => {
        const q = str(req.query?.q).trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 25, 1, 100);
        try {
          const results = await searchLocal(q, limit);
          // windowDays rides along so a caller reading an empty result can tell
          // "not in the mailbox" from "outside the synced window".
          const { windowDays } = await syncStatus();
          return { success: true, data: { query: q, count: results.length, limit, windowDays, results } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/attachments?threadId=&limit= — metadata only, no download.
    {
      method: 'GET',
      pattern: /^\/gmail\/attachments$/,
      handler: async (req: ParsedRequest) => {
        const threadId = str(req.query?.threadId).trim();
        if (!threadId) return { success: false, error: '`threadId` query param is required' };
        const limit = clampInt(req.query?.limit, 50, 1, 200);
        try {
          const all = await listAttachments(threadId);
          const attachments = all.slice(0, limit);
          return {
            success: true,
            data: {
              threadId,
              count: attachments.length,
              limit,
              total: all.length,
              attachments,
            },
          };
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

    // GET /gmail/aliases?refresh= — the "Send mail as" identities.
    {
      method: 'GET',
      pattern: /^\/gmail\/aliases$/,
      handler: async (req: ParsedRequest) => {
        try {
          const refresh = bool(req.query?.refresh, false);
          // The cached copy is the default answer: reading it live NAVIGATES the
          // driver browser to Settings and back, which is not free for whoever is
          // watching that window.
          const cached = readGmailConfig();
          const identities = refresh || !cached.sendAs?.length ? await listSendAs() : cached.sendAs;
          const def = identities.find((i) => i.isDefault)?.email ?? cached.defaultSendAs ?? null;
          if (refresh) writeGmailConfig({ sendAs: identities, defaultSendAs: def, sendAsCheckedAt: Date.now() });
          return {
            success: true,
            data: {
              count: identities.length,
              defaultSendAs: def,
              checkedAt: refresh ? Date.now() : cached.sendAsCheckedAt ?? null,
              identities,
            },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/sync { days?, label? } — fill the local window cache.
    {
      method: 'POST',
      pattern: /^\/gmail\/sync$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { days?: unknown; label?: unknown };
        const days = clampInt(b.days, 10, 1, 60);
        const label = str(b.label).trim() || 'inbox';
        try {
          const r = await syncWindow({ days, label });
          return {
            success: true,
            data: {
              threadsSynced: r.threadsSynced ?? 0,
              messagesSynced: r.messagesSynced ?? 0,
              windowDays: r.windowDays ?? days,
              label,
            },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /gmail/sync-status — what the local cache holds and how far back.
    {
      method: 'GET',
      pattern: /^\/gmail\/sync-status$/,
      handler: async () => {
        try {
          return { success: true, data: await syncStatus() };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/send { to, subject, body, format? }
    {
      method: 'POST',
      pattern: /^\/gmail\/send$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { to?: string; subject?: string; body?: string; format?: unknown; from?: string; cc?: string; bcc?: string };
        const to = str(b.to).trim();
        if (!to) return { success: false, error: 'Body must include { to }' };
        const f = resolveFormat(b.format);
        if ('error' in f) return { success: false, error: f.error };
        try {
          const sent = await sendMail(to, str(b.subject), str(b.body), f.format, {
            from: str(b.from).trim() || undefined,
            cc: str(b.cc).trim() || undefined,
            bcc: str(b.bcc).trim() || undefined,
          });
          return { success: true, data: { ...sent, format: f.format } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/reply { threadId, body, format? }
    {
      method: 'POST',
      pattern: /^\/gmail\/reply$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { threadId?: string; body?: string; format?: unknown; from?: string; all?: unknown };
        const threadId = str(b.threadId).trim();
        const body = str(b.body);
        if (!threadId) return { success: false, error: 'Body must include { threadId }' };
        if (!body.trim()) return { success: false, error: 'Body must include { body }' };
        const f = resolveFormat(b.format);
        if ('error' in f) return { success: false, error: f.error };
        try {
          const sent = await replyToThread(threadId, body, f.format, {
            from: str(b.from).trim() || undefined,
            all: bool(b.all, false),
          });
          return { success: true, data: { ...sent, format: f.format } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/draft { to, subject, body, format? }
    {
      method: 'POST',
      pattern: /^\/gmail\/draft$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as { to?: string; subject?: string; body?: string; format?: unknown; from?: string; cc?: string; bcc?: string };
        const f = resolveFormat(b.format);
        if ('error' in f) return { success: false, error: f.error };
        try {
          const saved = await draftMail(str(b.to), str(b.subject), str(b.body), f.format, {
            from: str(b.from).trim() || undefined,
            cc: str(b.cc).trim() || undefined,
            bcc: str(b.bcc).trim() || undefined,
          });
          return { success: true, data: { ...saved, format: f.format } };
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
