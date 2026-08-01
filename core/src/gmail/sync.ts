/**
 * Gmail background sync + pagination.
 *
 * ── Why this is fire-and-poll, not a blocking call ───────────────────────────
 * A sync is a WALK of the rendered mail app: navigate, wait for the list to
 * settle, scrape, repeat. One page costs several seconds; a multi-day sync costs
 * minutes. The MCP passthrough helper aborts POSTs at 120 s, and when it fires
 * the ROUTE KEEPS RUNNING while the tool reports failure — the same false
 * negative shape as the send_session_message incident (a message that HAD been
 * delivered, reported as a failure). So `startSync()` never blocks: it stamps a
 * job, returns in microseconds, and the caller polls `syncProgress()`.
 *
 * ── Pagination (MEASURED live 2026-07-29, against a real mailbox) ────────────
 * Reaching older mail was tested four ways:
 *   - `#inbox/p2`, `#inbox/p3`                       WORK (p1 Jul29→Jul16,
 *                                                    p2 Jul16→Jul1, p3 →Jun19)
 *   - `#search/after:… before:…`                     WORKS
 *   - `#search/older_than:6m`                        WORKS
 *   - `#search/<query>/p<N>`                         WORKS (combined)
 *   - the "Older" TOOLBAR BUTTON                     DOES NOT WORK — clicked,
 *                                                    list unchanged. Never used.
 * So paging is a URL concern, not a UI-choreography concern, exactly like search.
 *
 * 🔴 TWO measured traps drive most of the code below:
 *
 * 1. **The "1–50 of 5,235" counter DOES NOT CHANGE between pages.** It cannot be
 *    used for progress or for termination. Every stop condition here is derived
 *    from the ROWS instead: an empty page, ids repeating the previous page, no
 *    NEW ids at all, dates leaving the requested range, a page cap, a row cap,
 *    cancel, or the deadline. `stopReason` is ALWAYS set — a walk that stopped
 *    for an unrecorded reason is indistinguishable from a complete one, which is
 *    precisely how a partial sync gets read as "that is all the mail there is".
 *
 * 2. **Gmail RETAINS previous view containers** — measured 3 list tables x 50
 *    rows with only ONE visible. A global `querySelectorAll('tr.zA')` therefore
 *    returns the PREVIOUS page's rows first, so an unscoped pager silently
 *    re-reads page 1 forever while reporting progress. Every row read here is
 *    visible-scoped AND container-scoped, and the repeat detector is the second
 *    net under that.
 *
 * ── Dependencies ─────────────────────────────────────────────────────────────
 * Deliberately does NOT import ./cdp-client: that module pulls in `ws` and a live
 * browser, and sync.ts must stay drivable by any object with `evaluate`/`navigate`
 * (which is what makes it testable at all). The CDP surface it needs is declared
 * locally; the caller passes a FACTORY so the background job opens its OWN
 * session rather than holding the requesting call's.
 *
 * Caching is ./store's job — this file never writes a second cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GM_DATA_DIR } from './config';
import {
  getThread,
  markSynced,
  parseGmailDate,
  pruneOlderThan,
  syncStatus,
  syncWindowDays,
  upsertThreadDetail,
  upsertThreads,
} from './store';

// ─── errors ──────────────────────────────────────────────────────────────────

/**
 * Same `{code, message}` shape as cdp-client's `GmError`, so a route or tool can
 * report `err.code` uniformly across the connector. It is a SEPARATE class only
 * because sync.ts must not depend on the browser layer (see the header). If a
 * shared `gmail/errors.ts` is ever introduced, make both extend it — do not make
 * this one `instanceof` the other by accident.
 */
export class GmSyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GmSyncError';
  }
}

// ─── the CDP surface this file needs ─────────────────────────────────────────

/** The two page primitives a sync needs. Structurally satisfied by cdp-client's `Cdp`. */
export interface SyncCdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  navigate(url: string): Promise<void>;
}

/** An owned session: the job closes it when the walk ends, however it ends. */
export interface SyncCdpSession {
  cdp: SyncCdp;
  close(): void;
}

/**
 * Opens a session for the BACKGROUND job. A factory rather than a live `cdp`
 * because the caller's connection belongs to the caller's request — which has
 * already returned by the time the first page is fetched.
 */
export type CdpFactory = () => Promise<SyncCdpSession>;

// ─── public types ────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Rolling window, in days -> `newer_than:Nd`. Mutually exclusive with after/before. */
  days?: number;
  /** `YYYY/MM/DD` or `YYYY-MM-DD`. */
  after?: string;
  before?: string;
  /** Restrict to one Gmail label. */
  label?: string;
  /** Hard page cap for this run (default 20, absolute ceiling 200). */
  maxPages?: number;
  /** Also open each new thread and cache its message bodies (expensive; budgeted). */
  includeBodies?: boolean;
}

export interface SyncProgress {
  jobId: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt: number | null;
  pagesFetched: number;
  /** UNIQUE thread ids observed on the walked pages (not row count). */
  threadsSeen: number;
  /** Rows the store actually accepted (inserted + updated). */
  threadsUpserted: number;
  messagesUpserted: number;
  /**
   * BEYOND the minimum shape, and load-bearing: rows the store REFUSED — no
   * thread id, or older than the local retention window (`GMAIL_SYNC_DAYS`).
   * Without it a 90-day sync against a 10-day window reports 4,500 seen / 180
   * cached and looks like a bug in the scraper instead of a retention setting.
   */
  threadsSkipped: number;
  oldestSeenMs: number | null;
  currentQuery: string;
  error: string | null;
  /** Never null once the job leaves `running`. See the header, trap 1. */
  stopReason: string | null;
  /** Human-readable caveat for a run that "succeeded" but did not keep everything. */
  note: string | null;
}

/** One scraped list row. Matches cdp-client's `GmailThread`. */
export interface PageRow {
  threadId: string | null;
  unread: boolean;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
}

export interface PageResult {
  rows: PageRow[];
  /** No rows rendered — the end of the result set (see header: the counter cannot tell us). */
  exhausted: boolean;
  /** `location.hash` AFTER routing. Diagnostic: proves `/pN` was accepted. */
  hash: string;
  /** How many retained list containers held visible rows. >1 means Gmail kept an old view. */
  containers: number;
}

export interface PaginateOptions {
  maxPages?: number;
  onPage?: (rows: PageRow[], page: number) => void;
  /** Rows per page to force-render (default 50 — Gmail's own page size). */
  limit?: number;
  /** Overrides GMAIL_SYNC_PAGE_DELAY_MS for this walk. */
  delayMs?: number;
  /** Stop once a whole page predates this. Null/undefined disables the check. */
  fromMs?: number | null;
  /** Caller stop probe: return a stopReason to end the walk, or null to continue. */
  shouldStop?: () => string | null;
  /** Accumulated-row ceiling (default 5000). */
  maxRows?: number;
}

export interface PaginateResult {
  pages: number;
  rows: PageRow[];
  /** Always set. One of the STOP_* reasons below. */
  stopReason: string;
  /** Set only when the walk ended on a page/callback failure. */
  error: string | null;
}

// ─── tunables ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** MEASURED: Gmail renders 50 rows per page. */
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
/** Absolute ceiling regardless of what the caller asks for. */
const HARD_PAGE_CAP = 200;
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_PAGE_DELAY_MS = 1500;
/**
 * How long to let a routed view SETTLE before believing what it renders. Gmail
 * swaps the list asynchronously after the hash changes, so reading too early is
 * how you scrape the outgoing view (header, trap 2). Tunable because a slow host
 * needs longer — and because a test with a fake page needs none.
 */
const DEFAULT_SETTLE_MS = 1200;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
/**
 * Deliberately low enough that the deadline path is EXERCISABLE — a bound that
 * can only be tested by waiting a minute is a bound nobody ever tests.
 */
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 6 * 3_600_000;
const DEFAULT_MAX_BODIES = 100;
const EVAL_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 15_000;
const CDP_OPEN_TIMEOUT_MS = 20_000;
const LIST_READY_TIMEOUT_MS = 15_000;
const THREAD_READY_TIMEOUT_MS = 15_000;
/** Grace after a cancel before the slot is reclaimed regardless of the runner. */
const CANCEL_GRACE_MS = 5_000;
/**
 * Slack on the date-range stop test. Gmail's `newer_than:` boundary is evaluated
 * in the ACCOUNT's timezone while `parseGmailDate` reads LOCAL time, so a page
 * sitting on the boundary must not end the walk one page early.
 */
const RANGE_GRACE_MS = 36 * 3_600_000;
const MAX_HISTORY = 10;
const JOBS_VERSION = 1;

/** Every stop reason this file can produce. Kept together so none is invented inline. */
const STOP = {
  EMPTY_PAGE: 'empty_page',
  REPEAT_PAGE: 'repeat_page',
  NO_NEW_IDS: 'no_new_ids',
  PAGE_NOT_ROUTED: 'page_not_routed',
  MAX_PAGES: 'max_pages',
  ROW_CAP: 'row_cap',
  OUT_OF_RANGE: 'out_of_range',
  PAGE_ERROR: 'page_error',
  ONPAGE_ERROR: 'onpage_error',
  CANCELLED: 'cancelled',
  DEADLINE: 'deadline',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
} as const;

const ORIGIN = 'https://mail.google.com';
const MAIL_BASE = `${ORIGIN}/mail/u/0/`;

/** Selectors, verified live 2026-07-29. Same values as cdp-client — fix in BOTH. */
const SEL = {
  threadRow: 'tr.zA',
  listReady: 'div[role="main"] table, tr.zA, .Cp',
  threadReady: 'h2.hP',
  threadSubject: 'h2.hP',
  msgItem: '.adn.ads',
  msgSender: '.gD, span[email]',
  msgDate: '.g3',
  msgBody: '.a3s.aiL, .a3s',
  expandAll: '[aria-label="Expand all"], [data-tooltip="Expand all"]',
} as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read on EVERY call rather than frozen at module load (same rule as
 * store.syncWindowDays / config.resolveCdpBase): a restart must not be required
 * to slow the pager down, and tests set it per case.
 */
function pageDelayMs(): number {
  return envInt('GMAIL_SYNC_PAGE_DELAY_MS', DEFAULT_PAGE_DELAY_MS, 0, 60_000);
}

function deadlineMs(): number {
  return envInt('GMAIL_SYNC_DEADLINE_MS', DEFAULT_DEADLINE_MS, MIN_DEADLINE_MS, MAX_DEADLINE_MS);
}

function maxBodies(): number {
  return envInt('GMAIL_SYNC_MAX_BODIES', DEFAULT_MAX_BODIES, 0, 2000);
}

function settleMs(): number {
  return envInt('GMAIL_SYNC_SETTLE_MS', DEFAULT_SETTLE_MS, 0, 10_000);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  // A typo must fall back, never disable the bound it configures.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.floor(v), min), max);
}

/**
 * Bound a WAIT. The underlying promise keeps running — this cannot abort a hung
 * websocket call, it can only stop us from waiting on it forever. That is why
 * the job ALSO carries a cancel flag and why the single-flight slot is reclaimed
 * by wall clock rather than by the run's promise settling.
 */
function withTimeout<T>(p: Promise<T>, ms: number, code: string, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new GmSyncError(code, `${what} did not complete within ${ms}ms`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

// ─── query building ──────────────────────────────────────────────────────────

/**
 * Build the Gmail search query for a sync.
 *
 *   days           -> `newer_than:Nd`
 *   after/before   -> `after:YYYY/MM/DD before:YYYY/MM/DD`
 *   label          -> `label:<name>` (quoted when the name has whitespace)
 *
 * Returns '' when nothing was requested, which routes to `#inbox` rather than to
 * a search (see `pageHash`).
 *
 * Throws — loudly, synchronously, at the CALLER — on anything malformed. A bad
 * date must fail the `gmail_sync` call, not a background job two milliseconds
 * later where the operator has to go looking for it.
 */
export function buildQuery(opts: SyncOptions = {}): string {
  const o = opts || {};
  const hasDays = o.days !== undefined && o.days !== null;
  const hasAfter = isNonEmptyString(o.after);
  const hasBefore = isNonEmptyString(o.before);

  // `newer_than:30d after:2026/01/01` is two lower bounds arguing with each
  // other. Refuse rather than silently honouring one of them.
  if (hasDays && (hasAfter || hasBefore)) {
    throw new GmSyncError(
      'INVALID_RANGE',
      'specify EITHER days OR after/before, not both — they are two different lower bounds',
    );
  }
  if (o.after !== undefined && o.after !== null && !hasAfter) {
    throw new GmSyncError('INVALID_DATE', 'after was given but empty');
  }
  if (o.before !== undefined && o.before !== null && !hasBefore) {
    throw new GmSyncError('INVALID_DATE', 'before was given but empty');
  }

  const parts: string[] = [];
  if (hasDays) parts.push(`newer_than:${validDays(o.days)}d`);

  let afterMs: number | null = null;
  let beforeMs: number | null = null;
  if (hasAfter) {
    const d = parseDateArg(String(o.after), 'after');
    afterMs = d.ms;
    parts.push(`after:${d.text}`);
  }
  if (hasBefore) {
    const d = parseDateArg(String(o.before), 'before');
    beforeMs = d.ms;
    parts.push(`before:${d.text}`);
  }
  // An inverted range silently returns nothing, which reads as "no such mail".
  if (afterMs !== null && beforeMs !== null && afterMs > beforeMs) {
    throw new GmSyncError('INVALID_RANGE', `after (${o.after}) is later than before (${o.before}) — that range is empty`);
  }

  if (o.label !== undefined && o.label !== null) {
    if (!isNonEmptyString(o.label)) throw new GmSyncError('INVALID_LABEL', 'label was given but empty');
    parts.push(labelTerm(String(o.label).trim()));
  }

  return parts.join(' ');
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

function validDays(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GmSyncError('INVALID_DAYS', `days must be a positive number, got ${JSON.stringify(v)}`);
  }
  // 10 years of scraped mail is not a sync, it is a migration.
  return Math.min(Math.floor(n) || 1, 3650);
}

/**
 * `label:Work` / `label:"My Label"`. A name carrying a double quote cannot be
 * quoted safely and would corrupt the whole query, so it is refused rather than
 * mangled into a query that matches something ELSE.
 */
function labelTerm(name: string): string {
  if (name.includes('"')) {
    throw new GmSyncError('INVALID_LABEL', `label must not contain a double quote: ${JSON.stringify(name)}`);
  }
  return /\s/.test(name) ? `label:"${name}"` : `label:${name}`;
}

/**
 * Accept `YYYY/MM/DD` or `YYYY-MM-DD`, emit Gmail's `YYYY/MM/DD`.
 *
 * The round-trip check is not decoration: `new Date(Date.UTC(2026, 1, 30))`
 * happily yields March 2nd, so "2026/02/30" would become a query for the wrong
 * fortnight instead of an error.
 */
function parseDateArg(raw: string, field: string): { text: string; ms: number } {
  const s = raw.trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) {
    throw new GmSyncError(
      'INVALID_DATE',
      `${field} must be YYYY/MM/DD or YYYY-MM-DD, got ${JSON.stringify(raw)}`,
    );
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2100) {
    throw new GmSyncError('INVALID_DATE', `${field} year out of range (1970-2100): ${JSON.stringify(raw)}`);
  }
  if (mo < 1 || mo > 12) {
    throw new GmSyncError('INVALID_DATE', `${field} month out of range: ${JSON.stringify(raw)}`);
  }
  if (d < 1 || d > 31) {
    throw new GmSyncError('INVALID_DATE', `${field} day out of range: ${JSON.stringify(raw)}`);
  }
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new GmSyncError('INVALID_DATE', `${field} is not a real calendar date: ${JSON.stringify(raw)}`);
  }
  return { text: `${y}/${pad2(mo)}/${pad2(d)}`, ms };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The oldest instant a set of options ASKS for, or null when it is open-ended
 * (an inbox walk, or `before:` with no floor). Used for the retention warning
 * and to decide whether pruning after this run would delete what it just fetched.
 */
function requestedOldestMs(opts: SyncOptions, now: number): number | null {
  if (opts.days !== undefined && opts.days !== null) return now - validDays(opts.days) * DAY_MS;
  if (isNonEmptyString(opts.after)) return parseDateArg(String(opts.after), 'after').ms;
  return null;
}

// ─── routing ─────────────────────────────────────────────────────────────────

/**
 * The hash for page N of `query`.
 *
 * MEASURED: `#inbox/p2`, `#search/<q>/p2` both work; the "Older" toolbar button
 * does not. An empty query routes to `#inbox` (Gmail's default view) rather than
 * to an empty search, which renders nothing.
 *
 * The query is `encodeURIComponent`-encoded, which is not merely hygiene: it
 * turns the `/` inside `after:2026/06/01` into `%2F`, so the ONLY literal slash
 * left in the hash is the one separating the query from `/pN`. An unencoded
 * query would make `#search/after:2026/06/01/p2` structurally ambiguous.
 */
function pageHash(query: string, page: number): string {
  const q = String(query || '').trim();
  const base = q ? `#search/${encodeURIComponent(q)}` : '#inbox';
  return page > 1 ? `${base}/p${page}` : base;
}

async function ev<T>(cdp: SyncCdp, expr: string, ms = EVAL_TIMEOUT_MS): Promise<T> {
  return withTimeout(cdp.evaluate<T>(expr), ms, 'CDP_EVAL_TIMEOUT', 'a page evaluation');
}

/** Poll a boolean page expression until true or the deadline. Never throws. */
async function waitFor(cdp: SyncCdp, boolExpr: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await ev<boolean>(cdp, `return !!(${boolExpr});`, 5000)) return true;
    } catch {
      /* transient during navigation — keep polling until the deadline */
    }
    await sleep(400);
  }
  return false;
}

/**
 * Route the SPA by hash and wait for `readySel`.
 *
 * Gmail IGNORES a hash write that does not change the value, so re-entering the
 * same view (a retry) must blank the hash first — otherwise the call returns the
 * PREVIOUS render and the pager reads a stale page as a fresh one.
 */
async function gotoHash(cdp: SyncCdp, hash: string, readySel: string, timeoutMs: number): Promise<void> {
  const h = JSON.stringify(hash);
  const sel = JSON.stringify(readySel);
  let onMail = false;
  try {
    onMail = !!(await ev<boolean>(cdp, `return /mail\\.google\\.com$/.test(location.hostname);`));
  } catch {
    onMail = false;
  }
  if (!onMail) {
    await withTimeout(cdp.navigate(MAIL_BASE + hash), NAV_TIMEOUT_MS, 'CDP_NAV_TIMEOUT', 'a page navigation');
    // A cold load is the SPA booting, not just a view swap — give it double.
    await sleep(settleMs() * 2);
  } else {
    await ev(
      cdp,
      `try {
         if (location.hash === ${h}) { location.hash = '#__reroute'; await new Promise(r=>setTimeout(r,150)); }
         location.hash = ${h};
       } catch (e) {}
       return true;`,
    );
    await sleep(settleMs());
  }
  const ready = await waitFor(cdp, `document.querySelector(${sel})`, timeoutMs);
  if (!ready) throw new GmSyncError('PAGE_NOT_READY', `timed out waiting for ${hash} to render (${readySel})`);
  // The ready selector matches the moment the container EXISTS; its rows land a
  // beat later. Reading here is what makes `containers > 1` a rarity rather than
  // the norm.
  await sleep(Math.round(settleMs() / 2));
}

/** Scroll until `want` rows have rendered, or the count stops growing. Bounded. */
async function ensureRows(cdp: SyncCdp, want: number): Promise<void> {
  let last = -1;
  for (let i = 0; i < 5; i++) {
    let n = 0;
    try {
      n = await ev<number>(
        cdp,
        `try {
           return [...document.querySelectorAll(${JSON.stringify(SEL.threadRow)})]
             .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0).length;
         } catch (e) { return 0; }`,
      );
    } catch {
      return; // the extract below will report what it can see
    }
    if (n >= want || n === last) return;
    last = n;
    try {
      await ev(
        cdp,
        `try {
           const sc = document.querySelector('div[role="main"]') || document.scrollingElement;
           if (sc) sc.scrollBy(0, sc.clientHeight * 1.5);
         } catch (e) {}
         return true;`,
      );
    } catch {
      return;
    }
    await sleep(900);
  }
}

// ─── page-side extraction ────────────────────────────────────────────────────

/**
 * Read the CURRENT page's rows.
 *
 * 🔴 Container-scoped on purpose (header, trap 2). Visible-filtering alone was
 * enough in the measured case (3 tables, one visible), but "one visible" is an
 * observation, not a guarantee — during a view transition two containers can be
 * laid out at once. So: keep only visible rows, group them by their owning
 * table, and read the LARGEST group (ties resolve to the LAST, i.e. the most
 * recently appended container). `containers` is returned so a caller can see
 * when this actually mattered.
 *
 * Never throws in the page: a single unreadable row must not lose the page, and
 * a page-side exception surfaces as a CDP_EVAL error that looks like transport
 * failure. Every access is guarded and the result is a plain object.
 */
function jsPageRows(limit: number): string {
  return `
  const out = { rows: [], containers: 0, hash: '', total: 0, error: null };
  try {
    try { out.hash = String(location.hash || ''); } catch (e) {}
    const vis = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.height > 0 && r.width > 0;
      } catch (e) { return false; }
    };
    const all = [];
    try {
      for (const el of document.querySelectorAll(${JSON.stringify(SEL.threadRow)})) { if (vis(el)) all.push(el); }
    } catch (e) {}
    const groups = new Map();
    for (const tr of all) {
      let key = null;
      try { key = tr.closest('table') || tr.parentElement; } catch (e) { key = tr.parentElement; }
      let list = groups.get(key);
      if (!list) { list = []; groups.set(key, list); }
      list.push(tr);
    }
    out.containers = groups.size;
    let chosen = all;
    if (groups.size > 1) {
      let best = null;
      for (const list of groups.values()) { if (!best || list.length >= best.length) best = list; }
      chosen = best || all;
    }
    out.total = chosen.length;
    for (const tr of chosen.slice(0, ${limit})) {
      try {
        const idEl = tr.querySelector('[data-legacy-thread-id]');
        const s = tr.querySelector('.yX span[email], span[email]');
        const subj = tr.querySelector('.y6 span');
        const snip = tr.querySelector('.y2');
        const when = tr.querySelector('td.xW span[title], span[title]');
        out.rows.push({
          threadId: idEl ? idEl.getAttribute('data-legacy-thread-id') : null,
          unread: tr.classList.contains('zE'),
          fromEmail: s ? s.getAttribute('email') : null,
          fromName: s ? (s.getAttribute('name') || (s.textContent||'').trim() || null) : null,
          subject: subj ? (subj.textContent||'').trim() : null,
          snippet: snip ? (snip.textContent||'').replace(/^\\s*[-\\u2010-\\u2015]\\s*/, '').trim().slice(0, 200) : null,
          date: when ? when.getAttribute('title') : null
        });
      } catch (e) { /* one unreadable row must not cost the page */ }
    }
  } catch (e) {
    try { out.error = String((e && e.message) || e); } catch (e2) { out.error = 'page error'; }
  }
  return out;`;
}

const JS_THREAD_DETAIL = `
  const out = { subject: null, messages: [], error: null };
  try {
    const h = document.querySelector(${JSON.stringify(SEL.threadSubject)});
    out.subject = h ? (h.textContent||'').trim() : null;
    const vis = (el) => {
      try { const r = el.getBoundingClientRect(); return el.offsetParent !== null && r.height > 0; }
      catch (e) { return false; }
    };
    const items = [];
    try {
      for (const el of document.querySelectorAll(${JSON.stringify(SEL.msgItem)})) { if (vis(el)) items.push(el); }
    } catch (e) {}
    for (const m of items) {
      try {
        const s = m.querySelector(${JSON.stringify(SEL.msgSender)});
        const b = m.querySelector(${JSON.stringify(SEL.msgBody)});
        const d = m.querySelector(${JSON.stringify(SEL.msgDate)});
        const holder = m.closest('[data-legacy-message-id]') || m.querySelector('[data-legacy-message-id]');
        out.messages.push({
          messageId: holder ? holder.getAttribute('data-legacy-message-id') : null,
          fromName: s ? s.getAttribute('name') : null,
          fromEmail: s ? s.getAttribute('email') : null,
          date: d ? d.getAttribute('title') : null,
          body: b ? (b.innerText||'').trim().slice(0, 20000) : ''
        });
      } catch (e) { /* skip this message, keep the thread */ }
    }
  } catch (e) {
    try { out.error = String((e && e.message) || e); } catch (e2) { out.error = 'page error'; }
  }
  return out;`;

// ─── one page ────────────────────────────────────────────────────────────────

interface RawPage {
  rows?: unknown;
  containers?: unknown;
  hash?: unknown;
  total?: unknown;
  error?: unknown;
}

/**
 * Fetch ONE page of the thread list for `query`.
 *
 * `exhausted` is true when nothing rendered — which is the only honest
 * end-of-results signal available, because the "1–50 of 5,235" counter does not
 * change between pages (measured). Do not add a counter-based check later.
 */
export async function fetchPage(
  cdp: SyncCdp,
  query: string,
  page: number,
  limit: number = PAGE_SIZE,
): Promise<PageResult> {
  const n = clampInt(limit, 1, MAX_PAGE_SIZE, PAGE_SIZE);
  const p = clampInt(page, 1, HARD_PAGE_CAP, 1);
  await gotoHash(cdp, pageHash(query, p), SEL.listReady, LIST_READY_TIMEOUT_MS);
  await ensureRows(cdp, n);
  const raw = await ev<RawPage>(cdp, jsPageRows(n));
  const rows = coerceRows(raw && raw.rows);
  return {
    rows,
    exhausted: rows.length === 0,
    hash: typeof raw?.hash === 'string' ? raw.hash : '',
    containers: typeof raw?.containers === 'number' ? raw.containers : 0,
  };
}

/** A page that came back the wrong shape is an empty page, never a crash. */
function coerceRows(v: unknown): PageRow[] {
  if (!Array.isArray(v)) return [];
  const out: PageRow[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    out.push({
      threadId: typeof o.threadId === 'string' && o.threadId.trim() ? o.threadId.trim() : null,
      unread: o.unread === true,
      fromEmail: str(o.fromEmail),
      fromName: str(o.fromName),
      subject: str(o.subject),
      snippet: str(o.snippet),
      date: str(o.date),
    });
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

// ─── the walk ────────────────────────────────────────────────────────────────

/**
 * Walk pages of `query` until one of the stop conditions fires.
 *
 * Termination, in evaluation order per page — every one of these is derived from
 * the ROWS, because the result counter is useless (header, trap 1):
 *   1. `shouldStop()`      -> the caller's reason (cancel / deadline)
 *   2. empty page          -> `empty_page`
 *   3. ids == previous page-> `repeat_page`, or `page_not_routed` when the hash
 *                             also failed to carry `/pN` (a precise diagnosis of
 *                             "Gmail refused the page suffix and re-rendered p1")
 *   4. zero NEW ids        -> `no_new_ids` (a reshuffled stale container still
 *                             counts as no progress)
 *   5. row cap             -> `row_cap`
 *   6. whole page older    -> `out_of_range`
 *   7. loop exhausted      -> `max_pages`
 * Plus `page_error` (a page failed twice) and `onpage_error` (the caller's sink
 * threw — continuing would silently discard everything the walk fetches).
 *
 * A repeated page's rows are NOT emitted: they are already in the result, and
 * re-emitting them would double-count `threadsSeen` for a page that never
 * existed.
 */
export async function paginate(cdp: SyncCdp, query: string, opts: PaginateOptions = {}): Promise<PaginateResult> {
  const o = opts || {};
  const maxPages = clampInt(o.maxPages, 1, HARD_PAGE_CAP, DEFAULT_MAX_PAGES);
  const maxRows = clampInt(o.maxRows, 1, 100_000, DEFAULT_MAX_ROWS);
  const limit = clampInt(o.limit, 1, MAX_PAGE_SIZE, PAGE_SIZE);
  const delay = typeof o.delayMs === 'number' ? clampInt(o.delayMs, 0, 60_000, pageDelayMs()) : pageDelayMs();
  const fromMs = typeof o.fromMs === 'number' && Number.isFinite(o.fromMs) ? o.fromMs : null;

  const rows: PageRow[] = [];
  const seen = new Set<string>();
  let prevSig = '';
  let pages = 0;
  let error: string | null = null;
  // 'unset' can never leak: the post-loop guard converts it to max_pages.
  let stopReason = 'unset';

  for (let page = 1; page <= maxPages; page++) {
    const stop = o.shouldStop ? o.shouldStop() : null;
    if (stop) {
      stopReason = stop;
      break;
    }
    // Pace between pages, never before the first — Google is aggressive about
    // automation and a burst of navigations is the shape it looks for.
    if (page > 1 && delay > 0) await sleep(delay);

    let res: PageResult | null = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await fetchPage(cdp, query, page, limit);
      } catch (e) {
        error = errMessage(e);
        // One retry: a navigation that lost its execution context is transient,
        // and losing a whole multi-minute walk to it would be silly.
        if (attempt === 0) await sleep(Math.max(delay, 1000));
      }
    }
    if (!res) {
      stopReason = STOP.PAGE_ERROR;
      break;
    }
    error = null;
    pages++;

    if (res.exhausted) {
      stopReason = STOP.EMPTY_PAGE;
      break;
    }

    const ids: string[] = [];
    for (const r of res.rows) if (r.threadId) ids.push(r.threadId);
    const sig = ids.join(',');

    if (page > 1 && sig !== '' && sig === prevSig) {
      const routed = res.hash.includes(`/p${page}`);
      stopReason = routed ? STOP.REPEAT_PAGE : STOP.PAGE_NOT_ROUTED;
      break;
    }
    let fresh = 0;
    for (const id of ids) if (!seen.has(id)) fresh++;
    if (page > 1 && ids.length > 0 && fresh === 0) {
      stopReason = STOP.NO_NEW_IDS;
      break;
    }

    for (const id of ids) seen.add(id);
    prevSig = sig;
    for (const r of res.rows) rows.push(r);

    if (o.onPage) {
      try {
        o.onPage(res.rows, page);
      } catch (e) {
        error = errMessage(e);
        stopReason = STOP.ONPAGE_ERROR;
        break;
      }
    }

    if (rows.length >= maxRows) {
      stopReason = STOP.ROW_CAP;
      break;
    }
    if (fromMs !== null && pageEntirelyOlderThan(res.rows, fromMs)) {
      stopReason = STOP.OUT_OF_RANGE;
      break;
    }
  }

  if (stopReason === 'unset') stopReason = STOP.MAX_PAGES;
  return { pages, rows, stopReason, error };
}

/**
 * True when the page carries dated rows and EVERY one of them predates `fromMs`.
 * Undated rows do not vote — an unparsed label is a gap in our knowledge, not
 * evidence of age, and treating it as old would truncate the walk on one weird
 * date format.
 */
function pageEntirelyOlderThan(rows: PageRow[], fromMs: number): boolean {
  const floor = fromMs - RANGE_GRACE_MS;
  let dated = 0;
  for (const r of rows) {
    const ms = parseGmailDate(r.date);
    if (ms === null) continue;
    dated++;
    if (ms >= floor) return false;
  }
  return dated > 0;
}

// ─── job state ───────────────────────────────────────────────────────────────

interface JobSlot {
  progress: SyncProgress;
  opts: SyncOptions;
  query: string;
  /** Set by cancelSync() and by the watchdog. Read at every loop checkpoint. */
  cancelled: boolean;
  /** Wall-clock instant after which this slot is FORFEIT. See reapCurrent(). */
  deadlineAt: number;
  /** What the deadline means once it fires — a cancel tightens it. */
  expireState: 'failed' | 'cancelled';
  expireReason: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Threads queued for a body read (includeBodies). Bounded by maxBodies(). */
  bodyQueue: string[];
  bodySubjects: Map<string, string | null>;
}

/**
 * THE single-flight slot. One sync at a time — the job drives a shared browser,
 * and two walks interleaving navigations would each read the other's pages.
 */
let current: JobSlot | null = null;
/** Recent jobs (this process + whatever survived on disk), newest-first on read. */
let history = new Map<string, SyncProgress>();
let jobsLoaded = false;

/**
 * Identity of THIS process, so a persisted `running` job can be told from a live
 * one. pid alone is not enough — pids are reused — so the process start instant
 * is carried alongside it.
 */
const MY_PID = process.pid;
const MY_BOOT_MS = Math.round(Date.now() - process.uptime() * 1000);

interface StoredJob {
  progress: SyncProgress;
  pid: number;
  bootMs: number;
  updatedAt: number;
}

function jobsFile(): string {
  return path.join(GM_DATA_DIR, 'sync-jobs.json');
}

/**
 * Rehydrate job history, once per process.
 *
 * 🔴 A persisted `running` job written by a process that is GONE is a LIE, and
 * the most useful moment for that lie to bite is exactly when someone polls
 * after a restart to see whether their sync finished. Any `running` record that
 * did not come from THIS process is rewritten as `failed` / `interrupted` with
 * its last known progress intact — that is the truthful answer ("it got 6 pages
 * in and the process died"), and it also stops a dead record from holding the
 * single-flight slot hostage forever.
 */
function ensureJobsLoaded(): void {
  if (jobsLoaded) return;
  jobsLoaded = true;
  let parsed: { jobs?: unknown } | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(jobsFile(), 'utf-8')) as { jobs?: unknown };
  } catch {
    return; // no file yet, or a torn write — history simply starts empty
  }
  const list = Array.isArray(parsed?.jobs) ? (parsed!.jobs as unknown[]) : [];
  let repaired = false;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Partial<StoredJob>;
    const p = coerceProgress(rec.progress);
    if (!p) continue;
    const mine = rec.pid === MY_PID && Math.abs(Number(rec.bootMs) - MY_BOOT_MS) <= 2000;
    if (p.state === 'running' && !mine) {
      p.state = 'failed';
      p.stopReason = STOP.INTERRUPTED;
      p.error = 'the process running this sync exited before it finished (Core restart?)';
      p.finishedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : p.startedAt;
      repaired = true;
    }
    history.set(p.jobId, p);
  }
  if (repaired) persistJobs();
}

/** A stored record can be any shape at all (hand-edited, older version). Default every field. */
function coerceProgress(v: unknown): SyncProgress | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const jobId = typeof o.jobId === 'string' && o.jobId.trim() ? o.jobId.trim() : null;
  if (!jobId) return null;
  const state = o.state === 'done' || o.state === 'failed' || o.state === 'cancelled' ? o.state : 'running';
  return {
    jobId,
    state,
    startedAt: num(o.startedAt, 0),
    finishedAt: typeof o.finishedAt === 'number' && Number.isFinite(o.finishedAt) ? o.finishedAt : null,
    pagesFetched: num(o.pagesFetched, 0),
    threadsSeen: num(o.threadsSeen, 0),
    threadsUpserted: num(o.threadsUpserted, 0),
    messagesUpserted: num(o.messagesUpserted, 0),
    threadsSkipped: num(o.threadsSkipped, 0),
    oldestSeenMs: typeof o.oldestSeenMs === 'number' && Number.isFinite(o.oldestSeenMs) ? o.oldestSeenMs : null,
    currentQuery: typeof o.currentQuery === 'string' ? o.currentQuery : '',
    error: typeof o.error === 'string' ? o.error : null,
    stopReason: typeof o.stopReason === 'string' ? o.stopReason : null,
    note: typeof o.note === 'string' ? o.note : null,
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Persist history. tmp + rename so a crash mid-write cannot truncate the file
 * into the "no such job" answer this whole mechanism exists to avoid.
 */
function persistJobs(): void {
  const now = Date.now();
  const jobs = [...history.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_HISTORY)
    .map<StoredJob>((p) => ({ progress: p, pid: MY_PID, bootMs: MY_BOOT_MS, updatedAt: now }));
  try {
    fs.mkdirSync(GM_DATA_DIR, { recursive: true });
    const file = jobsFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: JOBS_VERSION, jobs }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Progress reporting must never take the sync down with it: an unwritable
    // data dir costs us restart-survival, not the mail.
  }
}

/**
 * Release a slot whose job has ended — or whose DEADLINE has passed.
 *
 * 🔴 This is what makes the single-flight slot BOUNDED. The slot is never
 * released by "the run's promise settled", because a promise pinned on a hung
 * CDP call never settles and would wedge sync permanently (the singleflight
 * incident in this repo). It is released on WALL CLOCK, by whoever looks next —
 * startSync, syncProgress or cancelSync — and independently by the watchdog
 * timer, so neither a starved event loop nor a stuck runner can hold it.
 */
function reapCurrent(): void {
  if (!current) return;
  if (current.progress.state !== 'running') {
    current = null;
    return;
  }
  if (Date.now() >= current.deadlineAt) {
    current.cancelled = true;
    finish(current, current.expireState, current.expireReason, expireError(current));
  }
}

function expireError(slot: JobSlot): string | null {
  return slot.expireState === 'failed'
    ? `the sync passed its hard deadline (${deadlineMs()}ms) without finishing`
    : null;
}

/**
 * End a job exactly once.
 *
 * The guard is not defensive padding: the watchdog and the runner RACE by
 * design, and without it a runner that unsticks after the deadline would
 * overwrite the deadline verdict with `done` and — worse — null out a slot that
 * by then belongs to a NEWER job.
 */
function finish(slot: JobSlot, state: SyncProgress['state'], stopReason: string, error: string | null): void {
  if (slot.progress.state !== 'running') return;
  slot.progress.state = state;
  slot.progress.stopReason = stopReason;
  slot.progress.error = error;
  slot.progress.finishedAt = Date.now();
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  if (current === slot) current = null;
  persistJobs();
}

function armWatchdog(slot: JobSlot): void {
  if (slot.timer) clearTimeout(slot.timer);
  const delay = Math.max(0, slot.deadlineAt - Date.now()) + 250;
  slot.timer = setTimeout(() => {
    slot.cancelled = true;
    finish(slot, slot.expireState, slot.expireReason, expireError(slot));
  }, delay);
  // unref: a background sync must never be the reason the process stays alive.
  if (typeof slot.timer.unref === 'function') slot.timer.unref();
}

// ─── public job API ──────────────────────────────────────────────────────────

/**
 * Start a background sync. NEVER blocks — it validates, stamps a job, kicks the
 * walk onto the event loop and returns.
 *
 * `already: true` means a sync was already running and THAT job's id is
 * returned; the caller polls it rather than getting a second walk (see the slot
 * comment above for why "already" cannot become permanent).
 *
 * Validation happens HERE, synchronously, so a malformed date fails the caller's
 * call instead of a background job the operator has to go hunting for.
 */
export function startSync(cdpFactory: CdpFactory, opts: SyncOptions = {}): { jobId: string; already: boolean } {
  if (typeof cdpFactory !== 'function') {
    throw new GmSyncError('INVALID_FACTORY', 'startSync needs a cdpFactory: () => Promise<{cdp, close}>');
  }
  ensureJobsLoaded();
  reapCurrent();
  if (current && current.progress.state === 'running') {
    return { jobId: current.progress.jobId, already: true };
  }

  const o = opts || {};
  const query = buildQuery(o); // throws loudly on bad input
  const now = Date.now();
  const progress: SyncProgress = {
    jobId: `gmsync_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    state: 'running',
    startedAt: now,
    finishedAt: null,
    pagesFetched: 0,
    threadsSeen: 0,
    threadsUpserted: 0,
    messagesUpserted: 0,
    threadsSkipped: 0,
    oldestSeenMs: null,
    currentQuery: query,
    error: null,
    stopReason: null,
    note: null,
  };
  const slot: JobSlot = {
    progress,
    opts: o,
    query,
    cancelled: false,
    deadlineAt: now + deadlineMs(),
    expireState: 'failed',
    expireReason: STOP.DEADLINE,
    timer: null,
    bodyQueue: [],
    bodySubjects: new Map(),
  };
  current = slot;
  history.set(progress.jobId, progress);
  persistJobs();
  armWatchdog(slot);

  // Fire and forget. runJob never rejects (it converts everything to a finish),
  // but the catch is kept so a future edit cannot turn this into an unhandled
  // rejection that takes Core down.
  void runJob(slot, cdpFactory).catch((e: unknown) => {
    finish(slot, 'failed', STOP.ERROR, errMessage(e));
  });
  return { jobId: progress.jobId, already: false };
}

/**
 * Poll a job. Omit `jobId` for the most recent one. Returns a COPY, so a caller
 * cannot mutate live job state, and null only when the id is genuinely unknown.
 */
export function syncProgress(jobId?: string): SyncProgress | null {
  ensureJobsLoaded();
  // A poll must never report `running` for a job that blew its deadline.
  reapCurrent();
  const id = typeof jobId === 'string' ? jobId.trim() : '';
  if (id) {
    const p = history.get(id);
    return p ? { ...p } : null;
  }
  let latest: SyncProgress | null = null;
  for (const p of history.values()) {
    if (!latest || p.startedAt > latest.startedAt) latest = p;
  }
  return latest ? { ...latest } : null;
}

/**
 * Ask the running job to stop. True when a running job was signalled.
 *
 * The job is not marked `cancelled` immediately: the runner does that when it
 * observes the flag, which keeps the browser session owned by exactly one walk.
 * But a runner that is wedged would leave the caller staring at `running`
 * forever, so the cancel also TIGHTENS the deadline to a few seconds — after
 * which the slot is reclaimed as `cancelled` whether the runner cooperated or
 * not. Cancellation is therefore bounded, not best-effort.
 */
export function cancelSync(jobId?: string): boolean {
  ensureJobsLoaded();
  reapCurrent();
  if (!current || current.progress.state !== 'running') return false;
  const id = typeof jobId === 'string' ? jobId.trim() : '';
  if (id && current.progress.jobId !== id) return false;
  current.cancelled = true;
  current.expireState = 'cancelled';
  current.expireReason = STOP.CANCELLED;
  current.deadlineAt = Math.min(current.deadlineAt, Date.now() + CANCEL_GRACE_MS);
  armWatchdog(current);
  return true;
}

/** Test-only: drop in-process job state so the next call re-reads from disk. */
export function _resetForTest(): void {
  if (current?.timer) clearTimeout(current.timer);
  current = null;
  history = new Map();
  jobsLoaded = false;
}

// ─── the job ─────────────────────────────────────────────────────────────────

/**
 * The background walk. Owns its own CDP session for its whole life and closes it
 * on every exit path — a leaked session is a browser tab nobody will ever close.
 */
async function runJob(slot: JobSlot, cdpFactory: CdpFactory): Promise<void> {
  const p = slot.progress;
  let session: SyncCdpSession | null = null;
  try {
    session = await withTimeout(
      Promise.resolve().then(() => cdpFactory()),
      CDP_OPEN_TIMEOUT_MS,
      'CDP_OPEN_TIMEOUT',
      'opening a CDP session for the sync',
    );
    if (!session || typeof session.close !== 'function' || !session.cdp) {
      throw new GmSyncError('INVALID_FACTORY', 'cdpFactory did not return { cdp, close }');
    }

    const now = Date.now();
    const oldestWanted = requestedOldestMs(slot.opts, now);
    const walk = await paginate(session.cdp, slot.query, {
      maxPages: slot.opts.maxPages,
      fromMs: oldestWanted,
      shouldStop: () => stopProbe(slot),
      onPage: (rows, page) => absorbPage(slot, rows, page),
    });
    p.pagesFetched = walk.pages;

    let stopReason = walk.stopReason;
    if (walk.error && !p.error) p.error = walk.error;

    // Phase 2 — bodies. Deliberately AFTER the walk, not interleaved: opening a
    // thread replaces the list view, and a pager that has to re-enter its own
    // page between every detail read is exactly the stale-container trap.
    if (slot.opts.includeBodies && !isTerminal(stopReason)) {
      const bodyStop = await fetchBodies(slot, session.cdp);
      if (bodyStop) stopReason = bodyStop;
    }

    finalize(slot, stopReason, oldestWanted, walk.pages);
  } catch (e) {
    finish(slot, 'failed', STOP.ERROR, errMessage(e));
  } finally {
    try {
      session?.close();
    } catch {
      /* closing a session that already died is not an error worth reporting */
    }
  }
}

/** Reasons that mean "stop the whole job", not just "stop walking pages". */
function isTerminal(reason: string): boolean {
  return reason === STOP.CANCELLED || reason === STOP.DEADLINE || reason === STOP.PAGE_ERROR || reason === STOP.ONPAGE_ERROR;
}

/** The loop checkpoint: cancel and deadline, checked before every page and body. */
function stopProbe(slot: JobSlot): string | null {
  if (slot.progress.state !== 'running') return slot.progress.stopReason || STOP.CANCELLED;
  if (slot.cancelled) return slot.expireReason;
  if (Date.now() >= slot.deadlineAt) return STOP.DEADLINE;
  return null;
}

/**
 * Fold one page into the cache and the progress counters.
 *
 * `threadsSeen` counts UNIQUE ids, `threadsUpserted` counts what the store
 * actually accepted, and `threadsSkipped` counts what it refused. Reporting only
 * the first would make a run that cached nothing look identical to one that
 * cached everything.
 */
function absorbPage(slot: JobSlot, rows: PageRow[], page: number): void {
  const p = slot.progress;
  p.pagesFetched = page;
  const label = isNonEmptyString(slot.opts.label) ? String(slot.opts.label).trim() : null;
  const input: Array<PageRow & { labels?: string[] }> = [];
  for (const r of rows) {
    const ms = parseGmailDate(r.date);
    if (ms !== null && (p.oldestSeenMs === null || ms < p.oldestSeenMs)) p.oldestSeenMs = ms;
    if (!r.threadId) {
      p.threadsSkipped++; // no server id => nothing to be idempotent on
      continue;
    }
    if (!seenIds(slot).has(r.threadId)) {
      seenIds(slot).add(r.threadId);
      p.threadsSeen++;
      if (slot.opts.includeBodies && slot.bodyQueue.length < maxBodies()) {
        slot.bodyQueue.push(r.threadId);
        slot.bodySubjects.set(r.threadId, r.subject);
      }
    }
    // The label a thread was FOUND under is real evidence; the store unions it.
    input.push(label ? { ...r, labels: [label] } : r);
  }
  if (input.length) {
    const res = upsertThreads(
      input.map((r) => ({
        threadId: r.threadId as string,
        subject: r.subject,
        fromEmail: r.fromEmail,
        fromName: r.fromName,
        snippet: r.snippet,
        date: r.date,
        unread: r.unread,
        labels: r.labels,
      })),
    );
    p.threadsUpserted += res.inserted + res.updated;
    p.threadsSkipped += res.skipped;
  }
  persistJobs();
}

/** Per-slot dedupe set, lazily attached so JobSlot stays serializable-ish. */
const seenIdsBySlot = new WeakMap<JobSlot, Set<string>>();
function seenIds(slot: JobSlot): Set<string> {
  let s = seenIdsBySlot.get(slot);
  if (!s) {
    s = new Set<string>();
    seenIdsBySlot.set(slot, s);
  }
  return s;
}

/**
 * Open each queued thread and cache its bodies. Returns a stop reason when the
 * job was cancelled or ran out of deadline mid-phase, else null.
 *
 * Bounded three ways: the queue is capped at `maxBodies()` when it is BUILT, the
 * per-thread read has its own timeouts, and the cancel/deadline probe runs
 * before every thread. Threads whose bodies are already cached are skipped —
 * that is the entire point of the store.
 */
async function fetchBodies(slot: JobSlot, cdp: SyncCdp): Promise<string | null> {
  const p = slot.progress;
  const delay = pageDelayMs();
  let done = 0;
  for (const threadId of slot.bodyQueue) {
    const stop = stopProbe(slot);
    if (stop) return stop;
    if (getThread(threadId)) continue; // already have the conversation
    if (done > 0 && delay > 0) await sleep(delay);
    done++;
    try {
      await gotoHash(cdp, `#all/${encodeURIComponent(threadId)}`, SEL.threadReady, THREAD_READY_TIMEOUT_MS);
      // Long threads render collapsed; expand so the bodies are in the DOM.
      await ev(
        cdp,
        `try {
           const b = document.querySelector(${JSON.stringify(SEL.expandAll)});
           if (b) { b.click(); await new Promise(r=>setTimeout(r,900)); }
         } catch (e) {}
         return true;`,
      ).catch(() => undefined);
      const d = await ev<{ subject?: unknown; messages?: unknown }>(cdp, JS_THREAD_DETAIL);
      const messages = Array.isArray(d?.messages) ? (d.messages as Array<Record<string, unknown>>) : [];
      if (!messages.length) continue;
      const subject =
        typeof d?.subject === 'string' && d.subject.trim()
          ? d.subject.trim()
          : (slot.bodySubjects.get(threadId) ?? null);
      upsertThreadDetail(
        threadId,
        subject,
        messages.map((m) => ({
          messageId: str(m.messageId) ?? undefined,
          fromName: str(m.fromName),
          fromEmail: str(m.fromEmail),
          date: str(m.date),
          body: typeof m.body === 'string' ? m.body : '',
        })),
      );
      p.messagesUpserted += messages.length;
      persistJobs();
    } catch {
      // One unreadable thread must not end the phase — the list rows are already
      // cached, and the next poll will show messagesUpserted lagging threadsSeen.
      continue;
    }
  }
  return null;
}

/**
 * Close the job out: map the walk's stop reason to a state, prune when it is
 * SAFE to, and write the caveat that stops a partial run reading as a full one.
 */
function finalize(slot: JobSlot, stopReason: string, oldestWanted: number | null, pages: number): void {
  const p = slot.progress;
  // The watchdog may have called it already (it races the runner by design).
  // `finish` is idempotent, but the SIDE EFFECTS below are not — a job declared
  // dead on its deadline must not go on to mark a successful sync and prune.
  if (p.state !== 'running') return;
  const state: SyncProgress['state'] =
    stopReason === STOP.CANCELLED ? 'cancelled'
    : stopReason === STOP.DEADLINE || stopReason === STOP.PAGE_ERROR || stopReason === STOP.ONPAGE_ERROR ? 'failed'
    : 'done';

  const notes: string[] = [];
  const windowDays = syncWindowDays();
  const cutoff = Date.now() - windowDays * DAY_MS;
  const insideWindow = oldestWanted !== null && oldestWanted >= cutoff;

  if (oldestWanted !== null && !insideWindow) {
    notes.push(
      `this sync reaches back past the local retention window (GMAIL_SYNC_DAYS=${windowDays}): the store REFUSES list rows older than that, so those rows are counted in threadsSkipped and are NOT cached. Raise GMAIL_SYNC_DAYS to keep them.`,
    );
  } else if (p.threadsSkipped > 0) {
    notes.push(
      `${p.threadsSkipped} row(s) were not cached — outside the ${windowDays}-day retention window, or missing a thread id.`,
    );
  }
  if (slot.opts.includeBodies && slot.bodyQueue.length >= maxBodies()) {
    notes.push(`body fetching stopped at the GMAIL_SYNC_MAX_BODIES budget (${maxBodies()}).`);
  }
  if (stopReason === STOP.MAX_PAGES || stopReason === STOP.ROW_CAP) {
    notes.push(`stopped at a cap after ${pages} page(s) — there is very likely MORE mail; re-run with a larger maxPages.`);
  }
  if (stopReason === STOP.PAGE_NOT_ROUTED) {
    notes.push('Gmail did not accept the /pN page suffix and re-rendered the previous page — paging may have changed.');
  }

  // `windowDays` here is the RETENTION window (syncWindowDays(), i.e.
  // GMAIL_SYNC_DAYS) - NOT what this run was asked to cover. Record the REQUESTED
  // window so sync-status can answer "is this gap outside what we synced?",
  // falling back to retention when the caller named no window.
  const syncedDays = typeof slot.opts.days === 'number' && slot.opts.days > 0 ? slot.opts.days : windowDays;

  // MEASURED 2026-07-31: a 30-day run stored 297 threads reaching back to 1 July
  // and recorded NOTHING, because it had not reached state 'done' when this ran.
  // sync-status therefore still reported windowDays=2 from an earlier run, and
  // every `window=30d` query judged coverage against the wrong number. A run that
  // fetched fresh mail HAS synced, whether or not it also finished, so record it
  // if it stored anything at all. `complete` is reported separately and stays the
  // flag for "did it finish" - the two were being conflated in one condition.
  if (p.threadsUpserted > 0) markSynced(undefined, syncedDays);

  if (state === 'done') {
    // 🔴 Prune ONLY when this run stayed inside the retention window. A deep
    // historical sync followed by a prune would delete precisely what it just
    // spent minutes fetching. An open-ended run (no floor) counts as outside.
    if (insideWindow) {
      const removed = pruneOlderThan(windowDays);
      if (removed > 0) notes.push(`pruned ${removed} record(s) older than ${windowDays} days.`);
    } else {
      notes.push('skipped the retention prune — this run fetched mail older than the window and pruning would delete it.');
    }
    const st = syncStatus();
    notes.push(`cache now holds ${st.threads} thread(s) / ${st.messages} message(s).`);
  }

  p.note = notes.length ? notes.join(' ') : null;
  finish(slot, state, stopReason, p.error);
}
