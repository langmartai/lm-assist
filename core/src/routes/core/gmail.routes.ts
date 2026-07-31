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
 *   POST /gmail/archive               { threadId } — remove the Inbox label
 *   POST /gmail/trash                 { threadId } — move to Trash (30-day recovery)
 *   POST /gmail/mark-read             { threadId, read } — read flag; `read` REQUIRED
 *   POST /gmail/star                  { threadId, starred } — `starred` REQUIRED
 *   POST /gmail/spam                  { threadId, spam } — `spam` REQUIRED
 *   POST /gmail/label/apply           { threadId, label } — add an EXISTING label
 *   POST /gmail/label/remove          { threadId, label } — take a label off a thread
 *   POST /gmail/label/create          { name, parent? } — create a label
 *   POST /gmail/move-to               { threadId, label } — apply label + archive
 *   POST /gmail/login                 launch/drive a login browser
 *   GET  /gmail/login/status?port=    poll the login browser
 *   POST /gmail/keepalive             force one keep-alive tick
 *
 * 🔴 TRIAGE + LABEL WRITES CARRY `verified`. gmail/actions.ts and gmail/labels.ts
 * return `{ ok, verified, note }` and deliberately separate "did it and CONFIRMED
 * it" (`verified:true`) from "drove the control but could not observe the change"
 * (`verified:false`). These routes pass that through UNTOUCHED and never collapse
 * it into the `success` flag: `success:true, verified:false` is a real and common
 * outcome, and anything above that renders it as a plain success is lying about a
 * mutation to someone's mailbox. `note` carries the strategy trace that says why.
 *
 * DELIBERATELY NOT ROUTED: permanent delete, snooze, mute, importance and the
 * bulk verb. See gmail/actions.ts — they compile, but exposing them is a separate
 * scope decision, not an oversight.
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
  // Triage + label verbs. These are the SESSION-OWNING wrappers: each one takes
  // the CDP connection through op(), normalises the thrown error via toGmError
  // and validates threadId, so a route never touches a raw `cdp` and never has
  // to import ./actions or ./labels directly.
  archiveThread,
  trashThread,
  markRead,
  starThread,
  markSpam,
  applyLabel,
  removeLabel,
  createLabel,
  moveToLabel,
  GmError,
} from '../../gmail/cdp-client';
import { searchLocal, syncStatus } from '../../gmail/store';
import { gmailLogin, gmailLoginStatus } from '../../gmail/login';
import { runSelfCheck } from '../../gmail/selfcheck';
import { startGmailKeepAlive } from '../../gmail/keepalive';
import { gmailSummary, gmailSummaryCached, syncJob } from '../../gmail/cdp-client';
import { resolveWindow } from '../../gmail/summary';
import { countInWindow } from '../../gmail/store';

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

// ─── required arguments for the triage + label verbs ─────────────────────────

/**
 * A REQUIRED, non-empty thread id. A number is accepted because a connector-
 * relayed argument does not always keep its JSON type and Gmail's legacy ids are
 * all-hex (so an id like `1980000000000000` arrives as a number).
 */
function reqThreadId(v: unknown): { id: string } | { error: string } {
  const id = (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '').trim();
  if (!id) return { error: 'Body must include a non-empty { threadId } (from /gmail/threads or /gmail/search)' };
  return { id };
}

/**
 * A REQUIRED boolean. Absent or unparseable is an ERROR, never a default.
 *
 * 🔴 This is the whole point of the helper: `bool()` above takes a fallback, and
 * a `mark-read` that fell back to `true` would silently mark someone's mail read
 * on a malformed call — a state change nobody asked for, with no undo from the
 * caller's side. Same for `starred` and `spam`. Refuse loudly instead, echoing
 * what was actually sent so the caller can see the coercion that failed.
 */
function reqBool(v: unknown, name: string): { value: boolean } | { error: string } {
  if (typeof v === 'boolean') return { value: v };
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return { value: true };
    if (s === 'false' || s === '0' || s === 'no') return { value: false };
  }
  if (v === undefined || v === null || v === '') {
    return { error: `Body must include { ${name}: true | false } — there is no default for this flag.` };
  }
  return { error: `\`${name}\` must be a boolean (true | false); got ${JSON.stringify(v)}` };
}

/** A REQUIRED, non-empty string argument (label names). */
function reqStr(v: unknown, name: string, hint: string): { value: string } | { error: string } {
  const s = str(v).trim();
  if (!s) return { error: `Body must include a non-empty { ${name} } — ${hint}` };
  return { value: s };
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
    // GET /gmail/selfcheck?deep= — the drift canary.
    //
    // A FAILING MATRIX IS STILL success:true. The call succeeded; the CONNECTOR
    // failed, and the answer is the matrix. Collapsing it into success:false makes
    // _passthrough's unwrapEnvelope() THROW, and the caller gets one error string
    // instead of the row that says WHICH invariant broke.
    {
      method: 'GET',
      pattern: /^\/gmail\/selfcheck$/,
      handler: async (req: ParsedRequest) => {
        try {
          return { success: true, data: await runSelfCheck({ deep: String(req.query?.deep ?? '') === 'true' }) };
        } catch (e) {
          return fail(e);
        }
      },
    },

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
          // MEASURED 2026-07-30, first ever run of this path: the response used to
          // carry only the four counters below, so a run that stored 44 threads and
          // then stopped early was indistinguishable from a complete one. syncWindow
          // produces `complete`, `stopReason`, `threadsSkipped` and a human `note`
          // precisely so a caller can tell those apart - dropping them turned an
          // honest partial result into a clean-looking success, and left
          // `lastSyncAt: null` (only written when the run ends 'done') with no
          // visible explanation.
          return {
            success: true,
            data: {
              // The job identity, so a caller can TRACK this walk instead of
              // guessing. syncWindow has always returned these; the route dropped
              // them, which is why its own note told callers to poll an endpoint
              // that describes the CACHE and knew nothing about the running job.
              jobId: r.jobId,
              state: r.state,
              // True when a walk was already in flight and this call JOINED it.
              // That is what makes retrying safe: re-issuing never starts a
              // second walk, it attaches to the one already running.
              already: r.already ?? false,
              threadsSynced: r.threadsSynced ?? 0,
              messagesSynced: r.messagesSynced ?? 0,
              threadsSkipped: r.threadsSkipped ?? 0,
              pagesFetched: r.pagesFetched ?? 0,
              windowDays: r.windowDays ?? days,
              label,
              complete: r.complete ?? false,
              stopReason: r.stopReason ?? null,
              error: r.error ?? null,
              note: r.note ?? null,
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
      // GET /gmail/summary?refresh= — account + mailbox counts + newest arrival.
      // Defaults to the CACHED read: this is the tool a caller reaches for
      // repeatedly, and driving the live page every time would make a cheap
      // question expensive. `refresh=true` forces a live observation. Either way
      // the response carries checkedAt/ageMs/cached, so a caller can never
      // mistake an old number for a current one.
      pattern: /^\/gmail\/summary$/,
      handler: async (req: ParsedRequest) => {
        const refresh = bool(req.query?.refresh, false);
        const windowSpec = str(req.query?.window).trim();
        try {
          // A time frame is answered from the local CACHE, not the browser: the
          // sync already holds these threads, so counting them costs nothing and
          // needs no page drive. 🔴 The cache only holds what a sync fetched, so
          // `covered` travels with the number — a "last 30d" count off a 2-day
          // sync is a floor, and saying so is the difference between a useful
          // answer and a confident wrong one.
          if (windowSpec) {
            const w = resolveWindow(windowSpec);
            if (!w) {
              return {
                success: false,
                error: `unrecognised window "${windowSpec}" — use today, yesterday, or <N>d (e.g. 7d, 30d)`,
              };
            }
            // MEASURED 2026-07-31: cached threads carry labels: [] — list rows have
            // no label chips to read, so a `label: 'inbox'` filter matched NOTHING
            // and every count came back 0 with covered:false (no matches also meant
            // no oldest date to compare). The cache's scope is already whatever
            // gmail_sync fetched, so filtering again was both wrong and redundant.
            const c = countInWindow(w.from, w.to);
            return {
              success: true,
              data: {
                window: w.label,
                from: w.from,
                to: w.to,
                threads: c.threads,
                unread: c.unread,
                undated: c.undated,
                covered: c.covered,
                source: 'local-cache',
                scope: 'whatever gmail_sync last fetched (see sync-status label/windowDays)',
                lastSyncAt: c.lastSyncAt,
                oldestCachedMs: c.oldestMs,
                note: c.covered
                  ? null
                  : 'FLOOR, not a total — the cache does not reach back past this window. Run gmail_sync with a larger days= to cover it.',
              },
            };
          }
          if (refresh) return { success: true, data: await gmailSummary() };
          const cached = gmailSummaryCached();
          if (cached) return { success: true, data: cached };
          // Never observed on this node — fall through to a live read rather than
          // return an empty shape the caller would have to special-case.
          return { success: true, data: await gmailSummary() };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/gmail\/sync-status$/,
      handler: async () => {
        try {
          // The RUNNING job rides along with the cache state. These answer two
          // different questions — "what do we hold?" and "is a walk in flight,
          // how far along, did it fail?" — and a caller polling for progress
          // needs the second. Null when this node has never synced.
          const job = syncJob();
          return {
            success: true,
            data: {
              ...(await syncStatus()),
              job: job
                ? {
                    jobId: job.jobId,
                    state: job.state,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt,
                    pagesFetched: job.pagesFetched,
                    threadsSeen: job.threadsSeen,
                    threadsUpserted: job.threadsUpserted,
                    messagesUpserted: job.messagesUpserted,
                    threadsSkipped: job.threadsSkipped,
                    currentQuery: job.currentQuery,
                    error: job.error,
                  }
                : null,
            },
          };
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

    // ─── triage ──────────────────────────────────────────────────────────────
    //
    // Five thread-scoped verbs, all delegated to gmail/actions.ts via the
    // session-owning wrappers in cdp-client. Every one returns
    // `{ ok, threadId, action, verified, note? }` and the route returns that
    // VERBATIM — see the 🔴 note in the header: `verified:false` means the
    // control was driven but the change was never observed, and collapsing it
    // into `success` would misreport a real mutation.

    // POST /gmail/archive { threadId } — removes the Inbox label. Reversible.
    {
      method: 'POST',
      pattern: /^\/gmail\/archive$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        try {
          return { success: true, data: await archiveThread(t.id) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/trash { threadId } — Trash, not permanent deletion. Google
    // keeps it ~30 days; there is deliberately no delete-forever route here.
    {
      method: 'POST',
      pattern: /^\/gmail\/trash$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        try {
          return { success: true, data: await trashThread(t.id) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/mark-read { threadId, read } — `read` is REQUIRED (reqBool).
    {
      method: 'POST',
      pattern: /^\/gmail\/mark-read$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        const r = reqBool(b.read, 'read');
        if ('error' in r) return { success: false, error: r.error };
        try {
          return { success: true, data: await markRead(t.id, r.value) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/star { threadId, starred } — `starred` is REQUIRED.
    {
      method: 'POST',
      pattern: /^\/gmail\/star$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        const s = reqBool(b.starred, 'starred');
        if ('error' in s) return { success: false, error: s.error };
        try {
          return { success: true, data: await starThread(t.id, s.value) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/spam { threadId, spam } — `spam` is REQUIRED. Reporting spam
    // trains Google's filter for the whole ACCOUNT, not just this thread.
    {
      method: 'POST',
      pattern: /^\/gmail\/spam$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        const s = reqBool(b.spam, 'spam');
        if ('error' in s) return { success: false, error: s.error };
        try {
          return { success: true, data: await markSpam(t.id, s.value) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // ─── labels ──────────────────────────────────────────────────────────────
    //
    // Delegated to gmail/labels.ts. An unknown label is a LOUD LABEL_NOT_FOUND
    // carrying near-matches — never a silent create — and `fail()` preserves
    // that code so the caller can act on it.

    // POST /gmail/label/apply { threadId, label } — the label must already exist.
    {
      method: 'POST',
      pattern: /^\/gmail\/label\/apply$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        const l = reqStr(b.label, 'label', 'an EXISTING label name (see GET /gmail/labels)');
        if ('error' in l) return { success: false, error: l.error };
        try {
          // `applied` is the label as GMAIL knows it, which may differ in case or
          // nesting from what was asked for — hence threadId is added rather than
          // the request being echoed back over the result.
          return { success: true, data: { threadId: t.id, requested: l.value, ...(await applyLabel(t.id, l.value)) } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/label/remove { threadId, label } — the label itself survives.
    {
      method: 'POST',
      pattern: /^\/gmail\/label\/remove$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        const l = reqStr(b.label, 'label', 'the label to take off this thread (see GET /gmail/labels)');
        if ('error' in l) return { success: false, error: l.error };
        try {
          return { success: true, data: { threadId: t.id, requested: l.value, ...(await removeLabel(t.id, l.value)) } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/label/create { name, parent? } — existing name is a no-op
    // success. Gmail reads `/` inside `name` as NESTING and there is no escape,
    // so a label whose name literally contains a slash cannot be created here.
    {
      method: 'POST',
      pattern: /^\/gmail\/label\/create$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const n = reqStr(b.name, 'name', 'the label to create');
        if ('error' in n) return { success: false, error: n.error };
        const parent = str(b.parent).trim();
        try {
          return { success: true, data: await createLabel(n.value, parent ? { parent } : undefined) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /gmail/move-to { threadId, label } — apply the label AND archive out
    // of the Inbox. Unlike Gmail's native "Move to", other user labels on the
    // thread are LEFT in place; `verified` is true only if BOTH halves were
    // observed, and `note` carries the per-step trace.
    {
      method: 'POST',
      pattern: /^\/gmail\/move-to$/,
      handler: async (req: ParsedRequest) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const t = reqThreadId(b.threadId);
        if ('error' in t) return { success: false, error: t.error };
        const l = reqStr(b.label, 'label', 'the destination label (see GET /gmail/labels)');
        if ('error' in l) return { success: false, error: l.error };
        try {
          // MoveResult carries neither the thread nor the label, so both are
          // added here — a bare `{ ok, verified }` is not attributable.
          return { success: true, data: { threadId: t.id, label: l.value, ...(await moveToLabel(t.id, l.value)) } };
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
