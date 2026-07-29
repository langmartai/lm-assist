/**
 * Gmail thread/message cache.
 *
 * Gmail owns the truth; this is a local mirror with an explicit sync window.
 * Its whole purpose is to NOT re-drive the browser for data already seen — the
 * connector reads Gmail by scraping a rendered mail.google.com in a real Chrome
 * (see ./cdp-client), which costs seconds per call, holds a shared browser, and
 * is the only surface that exists (the JSON/HTML endpoints are retired — see
 * ./config). So every read that can be served from disk is a read that does not
 * take the browser.
 *
 * Unlike LinkedIn, Gmail hands out REAL server ids as DOM attributes
 * (`data-legacy-thread-id`, `data-legacy-message-id`), so records key on those
 * rather than on synthesized display-name keys. Ids are stable across reads,
 * which is what makes upserts idempotent instead of duplicate-generating.
 *
 * Storage is append-only JSONL under GM_DATA_DIR, mirrored in memory and keyed
 * by id, rebuilt on load with LAST-WRITE-WINS per id:
 *   - `threads.jsonl`    — `__kind:'thread'`  records (one line per write)
 *   - `messages.jsonl`   — `__kind:'message'` records
 *   - `sync-state.json`  — last successful sync time
 *
 * Append-only is chosen for the same reason as the LinkedIn store: a torn write
 * costs one trailing line, never the file. `pruneOlderThan()` is the one
 * operation that rewrites (a tombstone would still be replayed forever, so
 * dropping data honestly means compacting the log).
 *
 * The SYNC WINDOW (default 10 days, `GMAIL_SYNC_DAYS`) is a RETENTION policy
 * with exactly two enforcement points:
 *   1. admission — `upsertThreads()` refuses list rows already outside it
 *      (an explicit `upsertThreadDetail()` is exempt; see its comment), and
 *   2. `pruneOlderThan()` — the only thing that DELETES.
 * It is deliberately NOT applied to reads: whatever survived prune is fair game,
 * so a caller never sees rows vanish for a reason `syncStatus()` cannot explain.
 * Nothing here prunes on a timer — the connector decides when, so a sync and a
 * delete never race for the same log.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GM_DATA_DIR } from './config';

// ─── types ───────────────────────────────────────────────────────────────────

/**
 * A cached thread-list row.
 *
 * A superset of cdp-client's `GmailThread`: the scraper reads the list table,
 * which does not expose `labels` / `hasAttachments` / `messageCount`. Those come
 * from the caller's context (which view it navigated to) or from a later
 * `upsertThreadDetail`, and default safely when unknown — an absent label is
 * never invented here.
 */
export interface CachedThread {
  /** Gmail's own `data-legacy-thread-id`. The identity of this record. */
  threadId: string;
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  snippet: string | null;
  /** The raw label Gmail rendered, kept verbatim so a bad parse is auditable. */
  date: string | null;
  /** `date` parsed to epoch ms, or null when it could not be parsed HONESTLY. */
  dateMs: number | null;
  unread: boolean;
  /** Labels this thread has been observed under. Unioned across reads. */
  labels: string[];
  hasAttachments: boolean;
  /** Messages in the conversation; 0 until a detail read tells us better. */
  messageCount: number;
  /** When THIS node last wrote the row — not when Gmail received the mail. */
  syncedAt: number;
}

/** A cached message body. Superset of cdp-client's `GmailMessage`. */
export interface CachedMessage {
  /** Gmail's `data-legacy-message-id`, or a deterministic `syn:` id (see below). */
  messageId: string;
  threadId: string;
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  date: string | null;
  dateMs: number | null;
  body: string;
  attachments: Array<{ name: string; sizeLabel: string }>;
  syncedAt: number;
}

/**
 * What callers may hand in. Widened from `CachedThread` on purpose: the scraped
 * row has genuine gaps, and forcing every call site to fill them is how wrong
 * values (`labels: []` meaning "none" rather than "unknown") get written.
 * A full `CachedThread` is still assignable.
 */
export type ThreadInput = Partial<CachedThread> & { threadId: string };
export type MessageInput = Partial<CachedMessage>;

interface ThreadRecord extends CachedThread {
  __kind: 'thread';
}
interface MessageRecord extends CachedMessage {
  __kind: 'message';
}

export interface SyncStatus {
  threads: number;
  messages: number;
  /** Oldest/newest KNOWN dateMs in the cache; null when nothing is dated. */
  oldestMs: number | null;
  newestMs: number | null;
  lastSyncAt: number | null;
  windowDays: number;
  dataDir: string;
}

const DAY_MS = 86_400_000;
/** Retention default when GMAIL_SYNC_DAYS is unset or unusable. */
const DEFAULT_SYNC_DAYS = 10;
/** Anything parsing before this is a mis-parse, not old mail. See parseGmailDate. */
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);

const threadsFile = () => path.join(GM_DATA_DIR, 'threads.jsonl');
const messagesFile = () => path.join(GM_DATA_DIR, 'messages.jsonl');
const syncStateFile = () => path.join(GM_DATA_DIR, 'sync-state.json');

let loaded = false;
let threads = new Map<string, CachedThread>();
let messages = new Map<string, CachedMessage>();
/** threadId -> its cached messages. Derived; rebuilt on load and after prune. */
let byThread = new Map<string, CachedMessage[]>();
let lastSyncAt: number | null = null;

// ─── sync window ─────────────────────────────────────────────────────────────

/**
 * How many days of mail this node keeps. Read from the environment on EVERY
 * call (like gmailProvider()/resolveCdpBase() in ./config) rather than frozen at
 * module load, so a restart is not required to change retention and tests can
 * set it per-case. Unparseable/absurd values fall back to the default rather
 * than disabling retention — a typo must not silently mean "keep forever".
 */
export function syncWindowDays(): number {
  const raw = process.env.GMAIL_SYNC_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_SYNC_DAYS;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SYNC_DAYS;
  // Clamp: 10 years of scraped mail is not a cache, it is a mail client.
  return Math.min(Math.floor(n), 3650);
}

// ─── date parsing ────────────────────────────────────────────────────────────

/**
 * Parse a Gmail date label to epoch ms, best-effort. Returns null instead of
 * throwing on anything it cannot read honestly — an unknown date is a fact
 * worth storing, a wrong one is not.
 *
 * Gmail renders the `title` attribute as `"Wed, Jul 29, 2026, 2:21 PM"` or
 * `"Jul 29, 2026, 7:43 AM"`; both parse natively. The guards below exist
 * because of what MEASURED on Node 20 (2026-07-29):
 *
 *   - `new Date(null)` is **0**, not NaN — a null date would be cached as 1970
 *     and immediately pruned. Non-strings are rejected before Date sees them.
 *   - `new Date("Jul 29")` (Gmail's this-year short form) returns a finite
 *     timestamp in **2001**. It is not NaN, so no NaN check catches it. Hence
 *     the explicit "must carry a 4-digit year" rule: no year, no timestamp.
 *   - `"… at 2:21 PM"` is NaN while `"…, 2:21 PM"` parses, so ` at ` is
 *     normalized to a comma.
 *   - A time-only label (`"2:21 PM"`) is NaN; Gmail only ever uses that form
 *     for TODAY, so it resolves against `now` rather than being discarded.
 *
 * Interpretation is LOCAL time — correct only while this process shares a
 * timezone with the Chrome that rendered the label (normally true: same host).
 */
export function parseGmailDate(raw: unknown, now: number = Date.now()): number | null {
  if (typeof raw !== 'string') return null;
  let s = raw
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  // "(2 days ago)" and friends are decoration Gmail appends after the real date.
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  s = s.replace(/\s+at\s+/i, ', ');
  if (!s) return null;

  // Time-only => today, in local time. Gmail uses this form only for today.
  const timeOnly = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (timeOnly) {
    let hour = Number(timeOnly[1]);
    const min = Number(timeOnly[2]);
    const sec = timeOnly[3] ? Number(timeOnly[3]) : 0;
    const mer = timeOnly[4] ? timeOnly[4].toLowerCase() : null;
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    if (hour > 23 || min > 59 || sec > 59) return null;
    const d = new Date(now);
    d.setHours(hour, min, sec, 0);
    return d.getTime();
  }

  // Require an explicit year — see the "Jul 29" -> 2001 trap above.
  const hasYear = /\b\d{4}\b/.test(s) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(s);
  if (!hasYear) return null;

  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  // Second net: a parse that lands before 1990 or far in the future is a
  // misread format, not mail. Scheduled sends are allowed a year of headroom.
  if (ms < MIN_PLAUSIBLE_MS || ms > now + 365 * DAY_MS) return null;
  return ms;
}

// ─── load / persist ──────────────────────────────────────────────────────────

/**
 * Rebuild the in-memory mirror from disk, once per process. A corrupt or
 * half-written line is SKIPPED, never fatal: the cache is reconstructible from
 * Gmail, so refusing to start over one torn record would trade a cheap loss for
 * a total outage of the connector's read path.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;

  for (const rec of readJsonl<ThreadRecord>(threadsFile())) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.__kind && rec.__kind !== 'thread') continue; // mis-filed record
    const t = coerceThread(rec);
    if (t) threads.set(t.threadId, t);
  }
  for (const rec of readJsonl<MessageRecord>(messagesFile())) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.__kind && rec.__kind !== 'message') continue;
    const m = coerceMessage(rec);
    if (m) messages.set(m.messageId, m);
  }
  reindexMessages();

  try {
    const st = JSON.parse(fs.readFileSync(syncStateFile(), 'utf-8')) as { lastSyncAt?: number };
    lastSyncAt = typeof st.lastSyncAt === 'number' ? st.lastSyncAt : null;
  } catch {
    lastSyncAt = null;
  }
}

/** Read a JSONL file into records, dropping unparseable lines (incl. a torn tail). */
function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return []; // no log yet
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      continue; // partial trailing write, or a line mangled by a concurrent append
    }
  }
  return out;
}

/**
 * Coerce a stored line into a whole record, or reject it.
 *
 * A line can be well-formed JSON and still be the WRONG SHAPE — written by an
 * older version of this file, or edited by hand while debugging. Trusting the
 * cast would push the failure to the first `t.labels.some(...)` in a read path,
 * i.e. a crash in `listThreads()` far from the bad line that caused it. Every
 * field is therefore defaulted here, and only a missing ID is fatal to the row.
 */
function coerceThread(rec: Partial<ThreadRecord>): CachedThread | null {
  const threadId = asString(rec.threadId);
  if (!threadId) return null;
  return {
    threadId,
    subject: asString(rec.subject),
    fromEmail: asString(rec.fromEmail),
    fromName: asString(rec.fromName),
    snippet: asString(rec.snippet),
    date: asString(rec.date),
    dateMs: typeof rec.dateMs === 'number' && Number.isFinite(rec.dateMs) ? rec.dateMs : null,
    unread: rec.unread === true,
    labels: asStringArray(rec.labels),
    hasAttachments: rec.hasAttachments === true,
    messageCount: typeof rec.messageCount === 'number' && rec.messageCount > 0 ? rec.messageCount : 0,
    syncedAt: typeof rec.syncedAt === 'number' && rec.syncedAt > 0 ? rec.syncedAt : 0,
  };
}

function coerceMessage(rec: Partial<MessageRecord>): CachedMessage | null {
  const messageId = asString(rec.messageId);
  const threadId = asString(rec.threadId);
  // A message with no thread is unreachable by every read path — drop it.
  if (!messageId || !threadId) return null;
  return {
    messageId,
    threadId,
    fromEmail: asString(rec.fromEmail),
    fromName: asString(rec.fromName),
    to: asStringArray(rec.to),
    date: asString(rec.date),
    dateMs: typeof rec.dateMs === 'number' && Number.isFinite(rec.dateMs) ? rec.dateMs : null,
    body: typeof rec.body === 'string' ? rec.body : '',
    attachments: normalizeAttachments(rec.attachments) ?? [],
    syncedAt: typeof rec.syncedAt === 'number' && rec.syncedAt > 0 ? rec.syncedAt : 0,
  };
}

/** Rebuild the whole threadId -> messages index. Load and prune only. */
function reindexMessages(): void {
  byThread = new Map<string, CachedMessage[]>();
  for (const m of messages.values()) {
    const list = byThread.get(m.threadId);
    if (list) list.push(m);
    else byThread.set(m.threadId, [m]);
  }
  for (const list of byThread.values()) sortChronological(list);
}

/** Place one message in the index, replacing any earlier copy of the same id. */
function indexMessage(m: CachedMessage): void {
  let list = byThread.get(m.threadId);
  if (!list) {
    list = [];
    byThread.set(m.threadId, list);
  }
  const i = list.findIndex((x) => x.messageId === m.messageId);
  if (i >= 0) list[i] = m;
  else list.push(m);
}

/** Oldest first — how a conversation reads. Undated messages keep their arrival order. */
function sortChronological(list: CachedMessage[]): void {
  list.sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
}

/**
 * Append records to a JSONL file.
 *
 * If a previous process died mid-append the file can end WITHOUT a newline;
 * appending straight onto it would glue two records into one unparseable line
 * and lose both. So the tail is repaired first. Writes are batched into one
 * syscall — a 100-thread sync should not be 100 appends.
 */
function appendLines(file: string, records: unknown[]): void {
  if (!records.length) return;
  fs.mkdirSync(GM_DATA_DIR, { recursive: true });
  let prefix = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    /* file does not exist yet — nothing to repair */
  }
  fs.appendFileSync(file, prefix + records.map((r) => JSON.stringify(r) + '\n').join(''));
}

/** Replace a JSONL file wholesale (prune only). tmp + rename so a crash cannot truncate it. */
function rewriteJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(GM_DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r) + '\n').join(''));
  fs.renameSync(tmp, file);
}

function persistSyncState(): void {
  fs.mkdirSync(GM_DATA_DIR, { recursive: true });
  fs.writeFileSync(syncStateFile(), JSON.stringify({ version: 1, lastSyncAt }, null, 2));
}

// ─── normalization ───────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asString(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Union labels case-insensitively, keeping the first spelling seen. */
function unionLabels(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  const seen = new Set(out.map((l) => l.toLowerCase()));
  for (const l of incoming) {
    if (seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    out.push(l);
  }
  return out;
}

/**
 * Deterministic fallback id for a message Gmail did not tag.
 *
 * The scraper returns `messageId: null` when the `data-legacy-message-id`
 * holder is missing. Keying such a message on its array index would create a
 * fresh duplicate on every re-read, so the id is derived from content that does
 * not move: thread + date + sender + body head. Same message in, same id out.
 */
function synthMessageId(threadId: string, date: string | null, from: string | null, body: string): string {
  const basis = `${threadId}|${date ?? ''}|${from ?? ''}|${body.slice(0, 256)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `syn:${threadId}:${h.toString(36)}`;
}

// ─── writes ──────────────────────────────────────────────────────────────────

/**
 * Insert or refresh thread-list rows. Idempotent on `threadId`.
 *
 * Out-of-window threads are NOT admitted — the window is the point of the cache,
 * and admitting a 6-month-old row just to have prune drop it is wasted IO. But
 * that only applies to threads whose date we actually KNOW: a row whose label
 * did not parse is admitted, because silently discarding everything we failed to
 * parse is the failure mode nobody would ever notice.
 *
 * Returns `skipped` alongside the requested `{inserted, updated}` so a caller
 * can see the difference between "wrote 3 of 3" and "wrote 3 of 50" instead of
 * reading a partial write as a complete one.
 */
export function upsertThreads(input: ThreadInput[]): { inserted: number; updated: number; skipped: number } {
  return upsertThreadRows(input, true);
}

/**
 * The merge itself. `enforceWindow` is false only for the row that backs an
 * explicit detail read — see upsertThreadDetail.
 */
function upsertThreadRows(
  input: ThreadInput[],
  enforceWindow: boolean,
): { inserted: number; updated: number; skipped: number } {
  ensureLoaded();
  const now = Date.now();
  const cutoff = enforceWindow ? now - syncWindowDays() * DAY_MS : -Infinity;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const pending: ThreadRecord[] = [];

  for (const raw of input || []) {
    const threadId = asString(raw?.threadId);
    if (!threadId) {
      skipped++; // no server id => nothing to be idempotent ON
      continue;
    }
    const date = asString(raw.date);
    // Trust a caller-supplied dateMs, else derive it from the raw label.
    const dateMs =
      typeof raw.dateMs === 'number' && Number.isFinite(raw.dateMs) && raw.dateMs > 0
        ? raw.dateMs
        : parseGmailDate(date, now);
    if (dateMs !== null && dateMs < cutoff) {
      skipped++;
      continue;
    }

    const existing = threads.get(threadId);
    const merged: CachedThread = {
      threadId,
      subject: asString(raw.subject) ?? existing?.subject ?? null,
      fromEmail: asString(raw.fromEmail) ?? existing?.fromEmail ?? null,
      fromName: asString(raw.fromName) ?? existing?.fromName ?? null,
      snippet: asString(raw.snippet) ?? existing?.snippet ?? null,
      date: date ?? existing?.date ?? null,
      dateMs: dateMs ?? existing?.dateMs ?? null,
      // `unread` flips both ways, so the newest observation always wins.
      unread: typeof raw.unread === 'boolean' ? raw.unread : (existing?.unread ?? false),
      // Labels accumulate: a thread seen under #inbox and later under #label/Work
      // is in both, and the second read must not erase the first.
      labels: unionLabels(existing?.labels ?? [], asStringArray(raw.labels)),
      hasAttachments:
        typeof raw.hasAttachments === 'boolean' ? raw.hasAttachments : (existing?.hasAttachments ?? false),
      messageCount:
        typeof raw.messageCount === 'number' && raw.messageCount > 0
          ? raw.messageCount
          : (existing?.messageCount ?? 0),
      syncedAt: typeof raw.syncedAt === 'number' && raw.syncedAt > 0 ? raw.syncedAt : now,
    };

    threads.set(threadId, merged);
    pending.push({ __kind: 'thread', ...merged });
    if (existing) updated++;
    else inserted++;
  }

  appendLines(threadsFile(), pending);
  return { inserted, updated, skipped };
}

/**
 * Store a full conversation: the bodies behind one thread id.
 *
 * This is the expensive read to avoid repeating — opening a thread means a
 * navigation, an "Expand all" click and a settle wait. Messages are keyed by
 * Gmail's message id (or a deterministic synthetic one), so re-reading a thread
 * that has grown by one reply costs one new record, not a duplicate set.
 *
 * A thread row is created if the id was never listed (a detail read can be
 * driven by id alone), so `listThreads()` still sees anything we hold bodies for.
 *
 * That row BYPASSES the window admission check, unlike upsertThreads(). Opening
 * a thread is an explicit, expensive, caller-chosen act, and refusing to record
 * what was just paid for defeats the point of the cache. It also avoids the only
 * genuinely broken state available here — bodies on disk with no row to reach
 * them by, which `getThread()` would then report as a MISS. Old mail pulled this
 * way still leaves on the next `pruneOlderThan()`, which stays the single
 * authority on what ages out.
 */
export function upsertThreadDetail(threadId: string, subject: string | null, input: MessageInput[]): void {
  ensureLoaded();
  const id = asString(threadId);
  if (!id) return;
  const now = Date.now();
  const pending: MessageRecord[] = [];
  let newestMs: number | null = null;
  let newestLabel: string | null = null;

  for (const raw of input || []) {
    const body = typeof raw?.body === 'string' ? raw.body : '';
    const date = asString(raw?.date);
    const fromEmail = asString(raw?.fromEmail);
    const fromName = asString(raw?.fromName);
    const dateMs =
      typeof raw?.dateMs === 'number' && Number.isFinite(raw.dateMs) && raw.dateMs > 0
        ? raw.dateMs
        : parseGmailDate(date, now);
    const messageId = asString(raw?.messageId) ?? synthMessageId(id, date, fromEmail ?? fromName, body);

    const existing = messages.get(messageId);
    const merged: CachedMessage = {
      messageId,
      threadId: id,
      fromEmail: fromEmail ?? existing?.fromEmail ?? null,
      fromName: fromName ?? existing?.fromName ?? null,
      to: asStringArray(raw?.to).length ? asStringArray(raw?.to) : (existing?.to ?? []),
      date: date ?? existing?.date ?? null,
      dateMs: dateMs ?? existing?.dateMs ?? null,
      // A later read that collapsed the message yields '' — never overwrite a
      // body we already have with an empty one.
      body: body || existing?.body || '',
      attachments: normalizeAttachments(raw?.attachments) ?? existing?.attachments ?? [],
      syncedAt: now,
    };
    messages.set(messageId, merged);
    indexMessage(merged);
    pending.push({ __kind: 'message', ...merged });
    if (merged.dateMs !== null && (newestMs === null || merged.dateMs > newestMs)) {
      newestMs = merged.dateMs;
      newestLabel = merged.date;
    }
  }

  // Only this conversation moved — no full-index rebuild on the hot detail path.
  const list = byThread.get(id);
  if (list) sortChronological(list);
  appendLines(messagesFile(), pending);

  // Keep the parent row consistent with what we now know about the conversation.
  const existingThread = threads.get(id);
  const count = (byThread.get(id) || []).length;
  const patch: ThreadInput = {
    threadId: id,
    subject: asString(subject) ?? existingThread?.subject ?? null,
    messageCount: count,
  };
  if (!existingThread) {
    // Stub row from the newest message, so a detail-only thread is still listable.
    const newest = (byThread.get(id) || [])[count - 1];
    patch.fromEmail = newest?.fromEmail ?? null;
    patch.fromName = newest?.fromName ?? null;
    patch.snippet = (newest?.body || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    patch.hasAttachments = (byThread.get(id) || []).some((m) => m.attachments.length > 0);
  }
  if (newestMs !== null) {
    patch.date = newestLabel;
    patch.dateMs = newestMs;
  }
  upsertThreadRows([patch], false);
}

function normalizeAttachments(v: unknown): Array<{ name: string; sizeLabel: string }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ name: string; sizeLabel: string }> = [];
  for (const a of v) {
    if (!a || typeof a !== 'object') continue;
    const name = asString((a as { name?: unknown }).name);
    if (!name) continue;
    out.push({ name, sizeLabel: asString((a as { sizeLabel?: unknown }).sizeLabel) ?? '' });
  }
  return out;
}

/** Record that a sync completed, so `syncStatus()` can report staleness. */
export function markSynced(at?: number): void {
  ensureLoaded();
  lastSyncAt = typeof at === 'number' && at > 0 ? at : Date.now();
  persistSyncState();
}

/** Epoch ms of the last completed sync, or null if this node has never synced. */
export function lastSync(): number | null {
  ensureLoaded();
  return lastSyncAt;
}

// ─── reads ───────────────────────────────────────────────────────────────────

/**
 * The cache-hit path for a full conversation.
 *
 * Returns null when the thread is unknown OR when only its list row is cached.
 * A row without bodies is a MISS for this call — handing back `messages: []`
 * would read as "an empty conversation" and the caller would skip the browser
 * read it actually needs. Use `listThreads()` when the row alone will do.
 */
export function getThread(threadId: string): { thread: CachedThread; messages: CachedMessage[] } | null {
  ensureLoaded();
  const id = asString(threadId);
  if (!id) return null;
  const thread = threads.get(id);
  if (!thread) return null;
  const msgs = byThread.get(id) || [];
  if (!msgs.length) return null;
  return { thread, messages: [...msgs] };
}

/**
 * Cached thread rows, newest first.
 *
 * Undated rows sort LAST rather than first: an unparsed date must not float
 * junk to the top of an inbox view. The window is not applied here — this
 * returns what is cached, and prune is what removes things.
 */
export function listThreads(opts: { limit?: number; label?: string; unreadOnly?: boolean } = {}): CachedThread[] {
  ensureLoaded();
  const limit = clampLimit(opts.limit, 25);
  const label = asString(opts.label)?.toLowerCase() ?? null;
  const out: CachedThread[] = [];
  for (const t of threads.values()) {
    if (opts.unreadOnly && !t.unread) continue;
    if (label && !t.labels.some((l) => l.toLowerCase() === label)) continue;
    out.push(t);
  }
  out.sort(compareRecency);
  return out.slice(0, limit);
}

/** Newest first; undated last; stable tie-break so paging cannot shuffle. */
function compareRecency(a: CachedThread, b: CachedThread): number {
  const am = a.dateMs;
  const bm = b.dateMs;
  if (am !== null && bm !== null && am !== bm) return bm - am;
  if (am === null && bm !== null) return 1;
  if (bm === null && am !== null) return -1;
  if (a.syncedAt !== b.syncedAt) return b.syncedAt - a.syncedAt;
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return fallback;
  // Bounded even though this is a local read: an unbounded result is how one
  // call ends up larger than the caller's whole context window.
  return Math.min(Math.floor(limit), 500);
}

// ─── local search ────────────────────────────────────────────────────────────

interface Term {
  field: 'any' | 'from' | 'subject' | 'label';
  value: string;
}
interface ParsedQuery {
  terms: Term[];
  unread: boolean | null;
  hasAttachment: boolean | null;
  /** True when the query had content but every token was a filter we understood. */
  usable: boolean;
}

/**
 * Split a query into field-scoped terms and boolean filters.
 *
 * Deliberately tiny and dependency-free: this runs over a 10-day window (low
 * thousands of rows at most), so a real index would cost more to maintain than
 * the scan it saves. Supported: `from:`, `subject:`, `label:<name>`,
 * `has:attachment`, `is:unread`/`is:read`, and bare terms. Everything ANDs.
 */
function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { terms: [], unread: null, hasAttachment: null, usable: false };
  // Keep quoted phrases together, INCLUDING behind a field prefix — the naive
  // /"[^"]*"|\S+/ splits `subject:"budget approval"` at the space, because the
  // quote is not at the token start, and then neither half matches anything.
  const tokens = String(query || '').match(/(?:[A-Za-z]+:)?"[^"]*"|\S+/g) || [];
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    parsed.usable = true;
    const m = token.match(/^(from|subject|label|has|is):(.*)$/i);
    if (!m) {
      parsed.terms.push({ field: 'any', value: unquote(token).toLowerCase() });
      continue;
    }
    const key = m[1].toLowerCase();
    const value = unquote(m[2]).toLowerCase();
    if (key === 'has') {
      if (value.startsWith('attachment')) parsed.hasAttachment = true;
      continue; // has:<anything else> is a filter we do not model — ignore, do not guess
    }
    if (key === 'is') {
      if (value === 'unread') parsed.unread = true;
      else if (value === 'read') parsed.unread = false;
      continue;
    }
    if (!value) continue; // a bare "from:" filters nothing
    parsed.terms.push({ field: key as Term['field'], value });
  }
  // A query of only empty tokens matched nothing meaningful.
  if (!parsed.terms.length && parsed.unread === null && parsed.hasAttachment === null) parsed.usable = false;
  return parsed;
}

/** Strip surrounding quotes. Liberal on purpose: an UNBALANCED quote from a
 *  hand-typed query should degrade to a plain term, not to a term that can
 *  never match because it still carries a `"`. */
function unquote(s: string): string {
  return s.replace(/^"+/, '').replace(/"+$/, '').trim();
}

/**
 * Search the LOCAL cache — never the browser.
 *
 * This is the read that makes the cache worth keeping: `gmail_search` over
 * Gmail costs a navigation and a scrape, while most follow-up questions ("what
 * did X say about Y") are answerable from mail already pulled. It is NOT a
 * substitute for Gmail's own search — it can only see the sync window, so a
 * caller that needs older mail must still go to Gmail.
 *
 * Scoring is field-weighted (subject/sender beat body) then recency, because a
 * term in the subject line is evidence about the thread while the same term
 * buried in a quoted reply chain usually is not.
 */
export function searchLocal(query: string, limit = 25): CachedThread[] {
  ensureLoaded();
  const q = parseQuery(query);
  if (!q.usable) return []; // an empty query is not "match everything"
  const max = clampLimit(limit, 25);

  const W_SUBJECT = 5;
  const W_FROM = 4;
  /** A sender found INSIDE the conversation — real, but weaker than the row's own. */
  const W_MSG_FROM = 3;
  const W_SNIPPET = 2;
  const W_LABEL = 2;
  const W_BODY = 1;

  const scored: Array<{ thread: CachedThread; score: number }> = [];
  for (const t of threads.values()) {
    if (q.unread !== null && t.unread !== q.unread) continue;
    if (q.hasAttachment === true && !t.hasAttachments) {
      // The list row may not know; a cached message that carries files still counts.
      const fromBodies = (byThread.get(t.threadId) || []).some((m) => m.attachments.length > 0);
      if (!fromBodies) continue;
    }

    const subject = (t.subject || '').toLowerCase();
    const from = `${t.fromEmail || ''} ${t.fromName || ''}`.toLowerCase();
    const snippet = (t.snippet || '').toLowerCase();
    const labels = t.labels.map((l) => l.toLowerCase());
    // Bodies are joined lazily — only threads that survived the filters pay for it.
    let bodies: string | null = null;
    const bodyText = (): string => {
      if (bodies === null) {
        bodies = (byThread.get(t.threadId) || [])
          .map((m) => `${m.body} ${m.fromEmail || ''} ${m.fromName || ''} ${m.to.join(' ')}`)
          .join('\n')
          .toLowerCase();
      }
      return bodies;
    };
    // Senders of the cached MESSAGES, kept separate from bodyText: the list row
    // names only the thread's summary participant, so `from:bob` on a thread
    // Gmail labels "Ana" would otherwise be a false negative — and a false
    // negative here sends the caller back to the browser for mail we already
    // hold. Excludes `to`, or a `from:` query would match its own recipients.
    let senders: string | null = null;
    const senderText = (): string => {
      if (senders === null) {
        senders = (byThread.get(t.threadId) || [])
          .map((m) => `${m.fromEmail || ''} ${m.fromName || ''}`)
          .join('\n')
          .toLowerCase();
      }
      return senders;
    };

    let score = 0;
    let matchedAll = true;
    for (const term of q.terms) {
      let best = 0;
      if (term.field === 'subject') {
        if (subject.includes(term.value)) best = W_SUBJECT;
      } else if (term.field === 'from') {
        if (from.includes(term.value)) best = W_FROM;
        else if (senderText().includes(term.value)) best = W_MSG_FROM;
      } else if (term.field === 'label') {
        if (labels.some((l) => l === term.value || l.includes(term.value))) best = W_LABEL;
      } else {
        if (subject.includes(term.value)) best = Math.max(best, W_SUBJECT);
        if (from.includes(term.value)) best = Math.max(best, W_FROM);
        if (snippet.includes(term.value)) best = Math.max(best, W_SNIPPET);
        if (labels.some((l) => l.includes(term.value))) best = Math.max(best, W_LABEL);
        if (!best && bodyText().includes(term.value)) best = W_BODY;
      }
      if (!best) {
        matchedAll = false; // AND semantics: one miss disqualifies the thread
        break;
      }
      score += best;
    }
    if (!matchedAll) continue;
    scored.push({ thread: t, score });
  }

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : compareRecency(a.thread, b.thread)));
  return scored.slice(0, max).map((s) => s.thread);
}

// ─── retention ───────────────────────────────────────────────────────────────

/**
 * Drop everything older than `days` and COMPACT the logs.
 *
 * The rewrite is the point: an append-only log that only forgets in memory
 * re-hydrates every pruned row on the next boot, so "pruned" would be a lie
 * that survives exactly until a restart.
 *
 * Age is taken from `dateMs` when known and from `syncedAt` otherwise — a row
 * whose date never parsed still ages out, on the one timestamp we can trust
 * (when WE saw it), rather than living forever because Gmail phrased its date
 * unusually. Returns the TOTAL number of records removed (threads + messages).
 */
export function pruneOlderThan(days: number): number {
  ensureLoaded();
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = Date.now() - d * DAY_MS;

  const dropThreads = new Set<string>();
  for (const t of threads.values()) {
    const age = t.dateMs ?? t.syncedAt;
    if (age < cutoff) dropThreads.add(t.threadId);
  }
  const dropMessages = new Set<string>();
  for (const m of messages.values()) {
    // A message goes when its thread goes, when it is itself old, or when it is
    // an orphan whose thread row is gone (dead weight nothing can reach).
    const age = m.dateMs ?? m.syncedAt;
    if (dropThreads.has(m.threadId) || age < cutoff || !threads.has(m.threadId)) dropMessages.add(m.messageId);
  }
  const removed = dropThreads.size + dropMessages.size;
  if (!removed) return 0;

  for (const id of dropThreads) threads.delete(id);
  for (const id of dropMessages) messages.delete(id);
  reindexMessages();

  rewriteJsonl(
    threadsFile(),
    [...threads.values()].map((t) => ({ __kind: 'thread', ...t })),
  );
  rewriteJsonl(
    messagesFile(),
    [...messages.values()].map((m) => ({ __kind: 'message', ...m })),
  );
  return removed;
}

/**
 * What this node actually holds — the backing read for a `gmail_sync_status`
 * tool. Reports the window and the real oldest/newest so a caller can tell
 * "nothing matched" from "we never synced that far back"; `oldestMs` newer than
 * `now - windowDays` means the cache simply has not been filled yet.
 */
export function syncStatus(): SyncStatus {
  ensureLoaded();
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  for (const t of threads.values()) {
    if (t.dateMs === null) continue;
    if (oldestMs === null || t.dateMs < oldestMs) oldestMs = t.dateMs;
    if (newestMs === null || t.dateMs > newestMs) newestMs = t.dateMs;
  }
  return {
    threads: threads.size,
    messages: messages.size,
    oldestMs,
    newestMs,
    lastSyncAt,
    windowDays: syncWindowDays(),
    dataDir: GM_DATA_DIR,
  };
}

/** Test-only: drop the in-memory mirror so the next call re-reads from disk. */
export function _resetForTest(): void {
  loaded = false;
  threads = new Map();
  messages = new Map();
  byThread = new Map();
  lastSyncAt = null;
}
