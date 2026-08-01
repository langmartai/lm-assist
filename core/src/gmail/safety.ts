/**
 * Gmail connector — send guardrails.
 *
 * This connector sends REAL mail from the operator's REAL account, driven by an
 * LLM that retries on failure, through a UI with no transactional confirmation.
 * Four hazards are concrete and MEASURED in this project, and each has one
 * countermeasure here:
 *
 *  1. DOUBLE-SEND ON RETRY. `sendMail()` can end in `SEND_UNCONFIRMED`
 *     ("clicked Send but saw no confirmation") when the message may in fact have
 *     gone. An agent reads that as failure and retries. Countermeasure:
 *     `sendFingerprint()` + `guardSend()` — a content fingerprint recorded before
 *     the click, so the retry is recognisable as a repeat of the same mail.
 *  2. UNVERIFIED SUCCESS. Confirmation today is "the compose dialog closed" or a
 *     toast — both are UI state, not delivery. The authoritative surface is the
 *     message appearing in SENT, which is how a human verifies it.
 *     Countermeasure: `verifyInSent()`.
 *  3. UNDO WAS BEING THROWN AWAY. MEASURED: after a send Gmail renders a toast
 *     reading "Message sent  Undo  View message", live for the account's
 *     Undo-Send window (5–30s). For an agent that otherwise cannot take mail
 *     back, that is the only real retraction that exists. Countermeasure:
 *     `undoLastSend()` / `undoWindowOpen()`.
 *  4. NO THROTTLING. Neither this connector nor the sibling LinkedIn one paced
 *     itself. Google is materially more aggressive about automation than
 *     LinkedIn — the SPA's own traffic includes
 *     `waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa/Create`
 *     (Web App Attestation, Google's anti-abuse channel), a detection surface
 *     LinkedIn never had. Countermeasure: `checkRate()` / `recordAction()`.
 *
 * ── The intended call sequence (the whole module in one place) ───────────────
 *
 *     const fp = sendFingerprint({ to, cc, subject, body });
 *     const rec = checkRecipients(to);          if (!rec.allowed) refuse(rec.reason);
 *     const rate = checkRate('send');           if (!rate.allowed) refuse(rate.reason);
 *     const g = guardSend(fp);
 *       // g.proceed === false → 'duplicate'   : refuse, tell the operator how to override
 *       // g.proceed === false → 'unconfirmed' : verifyInSent() FIRST, never resend blind
 *     recordSend(fp, { threadId: null, at: Date.now() });   // BEFORE the click
 *     recordAction('send');
 *     …click Send…
 *     const v = await verifyInSent(cdp, subject, to[0]);
 *     if (v.found) recordSend(fp, { threadId: v.threadId, at: <the same `at`> });
 *
 * The record is written BEFORE the click on purpose: a crash between click and
 * confirmation must leave evidence that a send was attempted. An unconfirmed
 * record (threadId === null) is what makes `guardSend` say "verify, do not
 * resend" instead of "go ahead" — the exact case that produces duplicate mail.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 * It never blocks anything by itself. Every function returns a VERDICT; the
 * connector decides. A guardrail that silently swallows mail is its own
 * incident — a refusal must be visible to the operator, with the reason and a
 * way to override (see `forgetSend`).
 *
 * ── Storage ─────────────────────────────────────────────────────────────────
 * Under GM_DATA_DIR, same append-only + in-memory-mirror shape as ./store:
 *   - `sent-log.jsonl`  — one `{__kind:'send', fp, threadId, at}` line per write,
 *                         last-write-wins per fingerprint. NOTE: it stores the
 *                         HASH only — never a subject, recipient or body. The
 *                         dedupe log is not a copy of the operator's mail.
 *   - `rate-state.json` — the action timestamps, rewritten (tmp + rename) per
 *                         action. If it is missing or corrupt the SEND bucket is
 *                         re-seeded from `sent-log.jsonl`, so losing the rate
 *                         file cannot forget sends that actually happened.
 * A torn trailing line costs that line, never the file.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GM_DATA_DIR } from './config';
// GmError is the connector's single error taxonomy and is reused deliberately.
// ./cdp-client will import THIS module for its send path, so the require cycle
// is real but benign: the reference is resolved at call time (`GmError` is only
// ever constructed inside a function), never at module-init.
import { GmError } from './cdp-client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const sentLogFile = () => path.join(GM_DATA_DIR, 'sent-log.jsonl');
const rateStateFile = () => path.join(GM_DATA_DIR, 'rate-state.json');

// ─── environment ─────────────────────────────────────────────────────────────

/**
 * Read a positive-integer env var. Like `syncWindowDays()` in ./store this is
 * read on EVERY call rather than frozen at module load, so a limit can be
 * changed without a restart and tests can set it per case.
 *
 * A missing/unparseable/negative value falls back to the default — a typo must
 * never silently mean "unlimited". An explicit `0` is honoured and means
 * DISABLED (blocks everything of that kind): that is a legitimate kill switch,
 * and it fails in the safe direction, loudly, via the verdict's `reason`.
 */
function envInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * How long an identical message is remembered for duplicate detection.
 * Default 5 minutes: long enough to cover an agent's retry loop plus a
 * `SEND_UNCONFIRMED` timeout (20s) and a `verifyInSent` poll, short enough that
 * a deliberate "send it again, they missed it" a few minutes later is not
 * suppressed. `0` disables duplicate detection entirely.
 */
export function dupWindowMs(): number {
  return envInt('GMAIL_DUP_WINDOW_MS', 300_000, 7 * DAY_MS);
}

// ─── idempotency ─────────────────────────────────────────────────────────────

/** One line of `sent-log.jsonl`. */
interface SendRecord {
  __kind: 'send';
  /** The fingerprint from `sendFingerprint()`. The identity of the record. */
  fp: string;
  /** Gmail's thread id once the send was CONFIRMED in Sent; null while unverified. */
  threadId: string | null;
  /** Epoch ms of the send attempt (not of the write). */
  at: number;
  /** A tombstone written by `forgetSend()`. */
  forgotten?: boolean;
}

let sendsLoaded = false;
let sends = new Map<string, { at: number; threadId: string | null }>();

/**
 * Rebuild the send mirror from disk, once per process. A corrupt or
 * half-written line is SKIPPED, never fatal: refusing to start over one torn
 * record would trade a cheap loss of dedupe history for a total outage of the
 * send path — and the send path is exactly where refusing to run is not safe,
 * because the operator will fall back to sending by hand.
 *
 * Last-write-wins per fingerprint, by `at`, ties resolved by file order (the
 * later line wins). That tie rule is what lets a caller UPGRADE an unconfirmed
 * record in place: re-record the same fingerprint with the SAME `at` and a
 * threadId once `verifyInSent` confirms it.
 */
function ensureSendsLoaded(): void {
  if (sendsLoaded) return;
  sendsLoaded = true;
  for (const rec of readJsonl<SendRecord>(sentLogFile())) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.__kind && rec.__kind !== 'send') continue; // mis-filed record
    const fp = typeof rec.fp === 'string' ? rec.fp.trim() : '';
    if (!fp) continue; // no identity — unusable
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0;
    if (rec.forgotten === true) {
      sends.delete(fp);
      continue;
    }
    const prev = sends.get(fp);
    if (prev && prev.at > at) continue; // strictly older line loses; a tie overwrites
    sends.set(fp, { at, threadId: typeof rec.threadId === 'string' && rec.threadId ? rec.threadId : null });
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
 * Append one record, repairing a missing trailing newline first — if a previous
 * process died mid-append the file can end without one, and appending straight
 * onto it would glue two records into a single unparseable line and lose BOTH.
 */
function appendLine(file: string, record: unknown): void {
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
  fs.appendFileSync(file, prefix + JSON.stringify(record) + '\n');
}

/**
 * Normalise text for fingerprinting.
 *
 * Deliberately aggressive about FORMAT and conservative about CONTENT: the
 * same message re-serialised by a different code path (an extra trailing
 * newline, CRLF from a Windows caller, a soft-wrap re-flow, a non-breaking
 * space pasted out of a browser) must produce the same hash, while a real edit
 * must not. Case is PRESERVED — a change of case is an edit, and a fingerprint
 * that is too loose suppresses legitimate mail, which is worse than a duplicate.
 */
/** Non-ASCII spaces that render as a space: NBSP, ogham, the en/em quad family, NNBSP, ideographic. */
const EXOTIC_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
/** Zero-width space / non-joiner / joiner and the BOM — invisible, and pasted in constantly. */
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

function normalizeText(v: unknown): string {
  return String(v ?? '')
    .normalize('NFC') // "é" as one codepoint vs e + combining accent is the same mail
    .replace(/\r\n?/g, '\n') // CRLF / CR line endings
    .replace(EXOTIC_SPACE, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ') // ALL run-of-whitespace, including line structure
    .trim();
}

/** Pull the bare address out of `Name <a@b.c>` / `<a@b.c>` / `a@b.c`, lowercased. */
function extractAddress(v: unknown): string {
  const s = String(v ?? '')
    .replace(ZERO_WIDTH, '')
    .trim();
  if (!s) return '';
  const angled = s.match(/<([^<>]*)>/);
  const bare = (angled ? angled[1] : s).trim().replace(/^["']|["']$/g, '').trim();
  return bare.toLowerCase();
}

/** Normalise a recipient list: bare addresses, lowercased, de-duplicated, sorted. */
function normalizeAddresses(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : list == null ? [] : [list];
  const seen = new Set<string>();
  for (const item of arr) {
    // One string may itself carry several comma-separated recipients.
    for (const part of String(item ?? '').split(',')) {
      const a = extractAddress(part);
      if (a) seen.add(a);
    }
  }
  return [...seen].sort();
}

/**
 * A stable content fingerprint for one outgoing message.
 *
 * ── What it IGNORES (two sends differing only in these hash the SAME) ───────
 *   • line breaks, indentation, tabs, repeated spaces, leading/trailing
 *     whitespace — i.e. ALL body and subject line structure;
 *   • non-breaking / exotic spaces and zero-width characters;
 *   • Unicode composition differences (NFC);
 *   • recipient ORDER and duplicate recipients;
 *   • recipient CASE and display names — `Yi Huang <A@B.io>` === `a@b.io`;
 *   • everything that is not one of the four inputs: ATTACHMENTS, BCC, HTML
 *     styling, the sending account, and any thread/In-Reply-To context.
 *
 * ── What it DISTINGUISHES ───────────────────────────────────────────────────
 *   • any change of wording, punctuation or CASE in the subject or body;
 *   • adding or removing any recipient;
 *   • moving a recipient between To and Cc (different mail, different headers).
 *
 * ── The false-suppression risk — read this before widening it ───────────────
 * A fingerprint that is too LOOSE suppresses a legitimate second email, which
 * is worse than the duplicate it was meant to prevent: the duplicate is visible
 * and apologisable, the suppression is silent. The known loose spots are the
 * ignored-but-real distinctions above — most sharply, the SAME covering note
 * with a DIFFERENT attachment fingerprints identically, and so does the same
 * one-liner ("ok, thanks") legitimately sent twice inside the window. Three
 * things bound the damage, and none of them may be removed casually:
 *   1. the match is WINDOWED (`GMAIL_DUP_WINDOW_MS`, default 5 min), not
 *      permanent — after the window the same mail sends normally;
 *   2. `guardSend()` returns a verdict; it never drops mail on its own;
 *   3. `forgetSend()` is the documented override for a deliberate repeat.
 *
 * The canonical string is JSON, not a delimiter-joined string: a subject
 * containing the delimiter must not be able to impersonate a body boundary.
 * The `gsf1_` prefix versions the normalisation — if the rules above ever
 * change, old records cannot collide with new ones.
 */
export function sendFingerprint(input: { to: string[]; cc?: string[]; subject: string; body: string }): string {
  const canonical = JSON.stringify({
    v: 1,
    to: normalizeAddresses(input?.to),
    cc: normalizeAddresses(input?.cc),
    subject: normalizeText(input?.subject),
    body: normalizeText(input?.body),
  });
  return 'gsf1_' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

/**
 * Record a send attempt. Call it BEFORE clicking Send with `threadId: null`,
 * then again after `verifyInSent()` succeeds with the same `at` and the real
 * thread id — the tie rule in `ensureSendsLoaded()` upgrades the record in place.
 */
export function recordSend(fp: string, meta: { threadId?: string | null; at: number }): void {
  const id = String(fp || '').trim();
  if (!id) throw new GmError('INVALID_FINGERPRINT', 'fp is required');
  ensureSendsLoaded();
  const at = typeof meta?.at === 'number' && Number.isFinite(meta.at) ? meta.at : Date.now();
  const threadId = typeof meta?.threadId === 'string' && meta.threadId.trim() ? meta.threadId.trim() : null;
  const rec: SendRecord = { __kind: 'send', fp: id, threadId, at };
  appendLine(sentLogFile(), rec);
  const prev = sends.get(id);
  if (!prev || prev.at <= at) sends.set(id, { at, threadId });
}

/**
 * The most recent send of this exact message inside `withinMs`, or null.
 * Defaults to `GMAIL_DUP_WINDOW_MS`.
 */
export function recentSend(fp: string, withinMs?: number): { at: number; threadId: string | null } | null {
  const id = String(fp || '').trim();
  if (!id) return null;
  ensureSendsLoaded();
  const rec = sends.get(id);
  if (!rec) return null;
  const window = typeof withinMs === 'number' && Number.isFinite(withinMs) ? withinMs : dupWindowMs();
  if (window <= 0) return null; // duplicate detection disabled
  if (Date.now() - rec.at > window) return null;
  return { at: rec.at, threadId: rec.threadId };
}

/**
 * Drop the dedupe record for a fingerprint — the documented override.
 *
 * Two real needs: (a) `undoLastSend()` succeeded, so the message did NOT go and
 * a corrected resend must not be blocked by its own retraction; (b) the operator
 * genuinely means to send the same mail twice inside the window. Written as a
 * tombstone LINE so the log stays append-only and the reason is auditable.
 */
export function forgetSend(fp: string): void {
  const id = String(fp || '').trim();
  if (!id) return;
  ensureSendsLoaded();
  appendLine(sentLogFile(), { __kind: 'send', fp: id, threadId: null, at: Date.now(), forgotten: true } as SendRecord);
  sends.delete(id);
}

/** Stable leading token of `guardSend().reason`, for callers that branch on it. */
export type GuardCode = 'no-prior-send' | 'duplicate' | 'unconfirmed';

/**
 * Decide whether a send should proceed, be skipped as a duplicate, or be
 * confirmed against Sent first.
 *
 * `reason` always starts with one of `GuardCode`, followed by ` — ` and a
 * sentence meant to be shown to the operator verbatim:
 *
 *   proceed:true  'no-prior-send — …'  nothing identical inside the window.
 *   proceed:false 'duplicate — …'      an identical message was CONFIRMED in
 *                                      Sent; sending again delivers it twice.
 *   proceed:false 'unconfirmed — …'    an identical message was clicked-Send but
 *                                      never confirmed. This is the dangerous
 *                                      case that produces the duplicates: it may
 *                                      have gone. Call `verifyInSent()`, then
 *                                      either record the thread id (→ duplicate)
 *                                      or `forgetSend()` (→ safe to resend).
 */
export function guardSend(fp: string, opts: { windowMs?: number } = {}): { proceed: boolean; reason: string; priorAt?: number } {
  const window = typeof opts?.windowMs === 'number' && Number.isFinite(opts.windowMs) ? opts.windowMs : dupWindowMs();
  if (window <= 0) {
    return { proceed: true, reason: 'no-prior-send — duplicate detection is disabled (GMAIL_DUP_WINDOW_MS=0)' };
  }
  const prior = recentSend(fp, window);
  if (!prior) {
    return { proceed: true, reason: `no-prior-send — no identical message recorded in the last ${Math.round(window / 1000)}s` };
  }
  const agoS = Math.max(0, Math.round((Date.now() - prior.at) / 1000));
  if (prior.threadId) {
    return {
      proceed: false,
      priorAt: prior.at,
      reason:
        `duplicate — an identical message was sent ${agoS}s ago and confirmed in Sent (thread ${prior.threadId}). ` +
        'Sending again would deliver it twice. If the repeat is intentional, call forgetSend() for this fingerprint.',
    };
  }
  return {
    proceed: false,
    priorAt: prior.at,
    reason:
      `unconfirmed — an identical message was submitted ${agoS}s ago but never confirmed in Sent, so it MAY already have gone. ` +
      'Do not resend blind: run verifyInSent() first — if found, record the thread id; if not found, call forgetSend() and retry.',
  };
}

// ─── authoritative verification ──────────────────────────────────────────────

/**
 * The slice of ./cdp-client's private `Cdp` this module needs. Structural, so a
 * real `Cdp` satisfies it without ./cdp-client having to export its internals —
 * and a test can hand in a fake page.
 */
export interface SafetyCdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  navigate?(url: string): Promise<void>;
}

const MAIL_BASE = 'https://mail.google.com/mail/u/0/';

/**
 * Page-side visibility filter for LIST rows. Kept in sync with ./cdp-client's
 * `JS_VISIBLE`; both encode the same MEASURED fact (2026-07-29): Gmail RETAINS
 * previous view containers in the DOM — 3 list tables x 50 rows after
 * inbox → sent → search, only one of them visible. A global `tr.zA` query
 * therefore returns STALE rows from an earlier view, ordered FIRST, which would
 * let this function "confirm" a message that never sent. That is the single
 * worst failure available to a verifier, so every selection goes through here.
 */
const JS_VISIBLE = `
  const __vis = (sel) => [...document.querySelectorAll(sel)]
    .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
`;

/**
 * Page-side visibility filter for FLOATING chrome (toasts, dialogs).
 * `offsetParent` is null for `position:fixed` elements even when they are fully
 * visible, so the list filter above would hide every toast. Rect-only, matching
 * ./cdp-client's `JS_LIVE_DIALOG`.
 */
const JS_RECT_VISIBLE = `
  const __rectVis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
`;

/** True when the driver page is on mail.google.com at all. */
const JS_ON_MAIL = `try { return /(^|\\.)mail\\.google\\.com$/.test(location.hostname); } catch (e) { return false; }`;

/**
 * Route the SPA to a search. Gmail IGNORES a hash write that does not change the
 * value, so re-entering the same view has to blank the hash first — otherwise a
 * repeat verification silently reads the previous render.
 */
function jsGotoSearch(hash: string): string {
  const h = JSON.stringify(hash);
  return `try {
    if (location.hash === ${h}) { location.hash = '#__gm_verify'; await new Promise(r => setTimeout(r, 150)); }
    location.hash = ${h};
    return true;
  } catch (e) { return false; }`;
}

interface SentProbe {
  ok: boolean;
  /** Gmail rendered its own "no messages matched" — an authoritative empty. */
  noResults: boolean;
  /** A list container exists, i.e. we are looking at a real view. */
  listPresent: boolean;
  rows: Array<{ threadId: string | null; subject: string }>;
  err?: string;
}

/**
 * Read the VISIBLE result rows. Never throws inside the page: a page-side
 * exception would surface as a CDP eval error and be indistinguishable from
 * "the page is gone", so failures are returned as data.
 */
const JS_SENT_ROWS = `try {
  ${JS_VISIBLE}
  const rows = __vis('tr.zA').map(tr => {
    const idEl = tr.querySelector('[data-legacy-thread-id]');
    const subj = tr.querySelector('.y6 span');
    return {
      threadId: idEl ? idEl.getAttribute('data-legacy-thread-id') : null,
      subject: subj ? (subj.textContent || '') : ''
    };
  });
  const main = document.querySelector('div[role="main"]');
  const text = main ? (main.textContent || '') : '';
  return {
    ok: true,
    noResults: /no messages matched|no conversations matched/i.test(text),
    listPresent: !!main,
    rows: rows
  };
} catch (e) {
  return { ok: false, noResults: false, listPresent: false, rows: [], err: String((e && e.message) || e) };
}`;

/** Strip what would break out of a `subject:"…"` term, and cap it. */
function sanitizeSearchTerm(s: string): string {
  return normalizeText(s)
    .replace(/["\\]/g, ' ')
    .replace(/[(){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Compare two subjects the way a human would: whitespace- and case-insensitive. */
function subjectMatches(rowSubject: string, wanted: string): boolean {
  const a = normalizeText(rowSubject).toLowerCase();
  const b = normalizeText(wanted).toLowerCase();
  if (!b) return !a || a === '(no subject)';
  if (!a) return false;
  if (a === b) return true;
  // Gmail truncates long subjects in the list with an ellipsis.
  const trimmed = a.replace(/[\u2026.]+$/, '').trim();
  return trimmed.length >= 12 && b.startsWith(trimmed);
}

/**
 * Confirm a message really left, by locating it in SENT.
 *
 * This is the authoritative check — the compose dialog closing and the toast are
 * both UI state that can appear without delivery, and `SEND_UNCONFIRMED` means
 * neither was observed at all. Returns the thread id when found, so the caller
 * can upgrade its `recordSend()` record from unconfirmed to confirmed.
 *
 * The query is bounded with `newer_than:1d` so an IDENTICAL message sent last
 * month cannot masquerade as confirmation of this one.
 *
 * Throws (rather than returning `found:false`) when the Sent view never renders:
 * "I looked and it is not there" and "I could not look" are different answers,
 * and reporting the second as the first is precisely how an agent is talked into
 * resending mail that already went.
 */
export async function verifyInSent(
  cdp: SafetyCdp,
  subject: string,
  to: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ found: boolean; threadId: string | null; searched: string }> {
  const addr = extractAddress(to);
  const subjTerm = sanitizeSearchTerm(subject);
  if (!addr && !subjTerm) {
    // `in:sent` alone would match the most recent sent mail and "confirm"
    // anything at all. Refuse loudly instead.
    throw new GmError('VERIFY_UNDERSPECIFIED', 'verifyInSent needs a recipient or a subject — "in:sent" alone would confirm any message');
  }
  const searched = ['in:sent', 'newer_than:1d', addr ? `to:${addr}` : '', subjTerm ? `subject:"${subjTerm}"` : '']
    .filter(Boolean)
    .join(' ');
  const timeoutMs = Math.max(2000, Math.min(opts?.timeoutMs ?? 20_000, 120_000));

  const onMail = await cdp.evaluate<boolean>(JS_ON_MAIL);
  const hash = `#search/${encodeURIComponent(searched)}`;
  if (!onMail) {
    if (!cdp.navigate) {
      throw new GmError('SENT_VIEW_UNAVAILABLE', 'the driver page is not on mail.google.com and cannot be navigated — cannot verify the send');
    }
    await cdp.navigate(MAIL_BASE + hash);
    await sleep(2500);
  } else {
    await cdp.evaluate<boolean>(jsGotoSearch(hash));
    await sleep(1200);
  }

  const deadline = Date.now() + timeoutMs;
  let sawView = false;
  for (;;) {
    let probe: SentProbe | undefined;
    try {
      probe = await cdp.evaluate<SentProbe>(JS_SENT_ROWS);
    } catch {
      /* transient: a navigation can destroy the execution context mid-poll */
    }
    // `rows` is defended rather than trusted: this function's `false` is read as
    // "it did not send", so a malformed page result must degrade to a THROW at
    // the deadline, never to a confident negative.
    const rows = probe && probe.ok && Array.isArray(probe.rows) ? probe.rows : null;
    if (probe && probe.ok && rows) {
      if (rows.length || probe.noResults || probe.listPresent) sawView = true;
      for (const row of rows) {
        if (subjectMatches(row.subject, subject)) {
          return { found: true, threadId: row.threadId || null, searched };
        }
      }
      // Gmail said nothing matched. That is an authoritative empty, not a timeout.
      if (probe.noResults) return { found: false, threadId: null, searched };
    }
    if (Date.now() >= deadline) break;
    await sleep(800);
  }
  if (!sawView) {
    throw new GmError(
      'SENT_VIEW_UNAVAILABLE',
      `the Sent search did not render within ${timeoutMs}ms (${searched}) — the send is UNVERIFIED, do not resend blind`,
    );
  }
  return { found: false, threadId: null, searched };
}

// ─── undo ────────────────────────────────────────────────────────────────────

interface ToastProbe {
  ok: boolean;
  /** A visible toast whose text is about SENDING (not archiving/deleting). */
  sendToast: boolean;
  /** That toast offers an Undo control. */
  hasUndo: boolean;
  /** Some other toast is up — clicking its Undo would retract the wrong thing. */
  otherToast: boolean;
  text: string;
  err?: string;
}

/**
 * Locate the post-send toast. MEASURED text: "Message sent  Undo  View message".
 *
 * The `sendToast` gate exists because Gmail uses the SAME toast + Undo widget for
 * archive, delete, label and mute. Clicking "Undo" on an archive toast un-archives
 * a conversation and retracts NOTHING — and this module would then report a
 * retraction that never happened, which is the exact dishonesty it is here to
 * prevent. So the toast must say it is about sending before anything is clicked.
 */
const JS_FIND_TOAST = `try {
  ${JS_RECT_VISIBLE}
  const toasts = [...document.querySelectorAll('.bAq, .vh, .b8, [role="alert"], [role="status"]')].filter(__rectVis);
  let sendToast = null, otherToast = false;
  for (const t of toasts) {
    const txt = (t.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!txt) continue;
    if (/message sent|your message has been sent|sending\\b/i.test(txt)) { if (!sendToast) sendToast = t; }
    else if (/\\bundo\\b/i.test(txt)) otherToast = true;
  }
  if (!sendToast) return { ok: true, sendToast: false, hasUndo: false, otherToast: otherToast, text: '' };
  const undo = [...sendToast.querySelectorAll('#link_undo, span[role="link"], div[role="button"], button, a')]
    .filter(__rectVis)
    .find(e => /^undo$/i.test((e.textContent || '').replace(/\\s+/g, ' ').trim()));
  return {
    ok: true,
    sendToast: true,
    hasUndo: !!undo,
    otherToast: otherToast,
    text: (sendToast.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
  };
} catch (e) {
  return { ok: false, sendToast: false, hasUndo: false, otherToast: false, text: '', err: String((e && e.message) || e) };
}`;

/** Click the Undo control inside the send toast. Returns whether it was clicked. */
const JS_CLICK_UNDO = `try {
  ${JS_RECT_VISIBLE}
  const toasts = [...document.querySelectorAll('.bAq, .vh, .b8, [role="alert"], [role="status"]')].filter(__rectVis);
  const t = toasts.find(x => /message sent|your message has been sent|sending\\b/i.test((x.textContent || '')));
  if (!t) return { ok: true, clicked: false, text: '' };
  const undo = [...t.querySelectorAll('#link_undo, span[role="link"], div[role="button"], button, a')]
    .filter(__rectVis)
    .find(e => /^undo$/i.test((e.textContent || '').replace(/\\s+/g, ' ').trim()));
  if (!undo) return { ok: true, clicked: false, text: (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) };
  undo.click();
  return { ok: true, clicked: true, text: (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) };
} catch (e) {
  return { ok: false, clicked: false, text: '', err: String((e && e.message) || e) };
}`;

/**
 * Did the retraction actually land? Gmail replaces the toast with "Sending has
 * been undone." and reopens the compose dialog. Either is acceptable evidence.
 */
const JS_UNDO_CONFIRMED = `try {
  ${JS_RECT_VISIBLE}
  const nodes = [...document.querySelectorAll('.bAq, .vh, .b8, [role="alert"], [role="status"]')].filter(__rectVis);
  const undone = nodes.some(n => /sending has been undone|message discarded|undone\\.?$/i.test((n.textContent || '').replace(/\\s+/g, ' ').trim()));
  const composeBack = [...document.querySelectorAll('div[role="dialog"]')].filter(__rectVis)
    .some(d => !!d.querySelector('div[aria-label="Message Body"], div[g_editable="true"][role="textbox"]'));
  return { ok: true, undone: undone, composeBack: composeBack };
} catch (e) {
  return { ok: false, undone: false, composeBack: false, err: String((e && e.message) || e) };
}`;

/**
 * Is Gmail's own retraction window still open?
 *
 * Transport errors are NOT swallowed — a `false` here means "I looked and there
 * is no undo", never "I could not look".
 */
export async function undoWindowOpen(cdp: SafetyCdp): Promise<boolean> {
  const probe = await cdp.evaluate<ToastProbe>(JS_FIND_TOAST);
  return !!(probe && probe.ok && probe.sendToast && probe.hasUndo);
}

/**
 * Click Gmail's own "Undo" in the post-send toast, if it is still there.
 *
 * Honest by construction: `undone:true` is returned ONLY when the retraction was
 * observed to land. Every other path returns `undone:false` with a note that says
 * plainly that the message stands as SENT — a guardrail that overstates a
 * retraction is worse than no guardrail, because the operator stops looking.
 *
 * After a `undone:true`, call `forgetSend(fp)` so the dedupe guard does not block
 * the corrected resend.
 */
export async function undoLastSend(cdp: SafetyCdp): Promise<{ undone: boolean; note: string }> {
  const probe = await cdp.evaluate<ToastProbe>(JS_FIND_TOAST);
  if (!probe || !probe.ok) {
    return { undone: false, note: `could not read the page to find the undo toast (${probe?.err || 'no result'}) — the message stands as SENT` };
  }
  if (!probe.sendToast) {
    const extra = probe.otherToast ? ' (a different toast IS showing an Undo — that one belongs to another action and was deliberately not clicked)' : '';
    return {
      undone: false,
      note: `no post-send toast is present${extra} — Gmail's undo window (5–30s, per the account's Undo Send setting) has closed or this send was not made from this page; the message stands as SENT`,
    };
  }
  if (!probe.hasUndo) {
    return { undone: false, note: `the send toast is showing ("${probe.text}") but carries no Undo control — the message stands as SENT` };
  }

  const click = await cdp.evaluate<{ ok: boolean; clicked: boolean; text: string; err?: string }>(JS_CLICK_UNDO);
  if (!click || !click.ok || !click.clicked) {
    return { undone: false, note: `the Undo control disappeared before it could be clicked (window closed) — the message stands as SENT` };
  }

  // Clicking is not evidence. Wait for Gmail to say it undid the send.
  const deadline = Date.now() + 8000;
  for (;;) {
    let conf: { ok: boolean; undone: boolean; composeBack: boolean } | undefined;
    try {
      conf = await cdp.evaluate<{ ok: boolean; undone: boolean; composeBack: boolean }>(JS_UNDO_CONFIRMED);
    } catch {
      /* transient — the undo reopens a compose dialog and can churn the DOM */
    }
    if (conf && conf.ok && (conf.undone || conf.composeBack)) {
      return {
        undone: true,
        note: conf.undone
          ? 'Gmail confirmed "Sending has been undone" — the message was retracted and is back as a draft'
          : 'the compose dialog reopened after Undo — the message was retracted and is back as a draft',
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  }
  return {
    undone: false,
    note: 'clicked Undo but Gmail never confirmed the retraction — treat the message as SENT and verify with verifyInSent()',
  };
}

// ─── rate limiting ───────────────────────────────────────────────────────────

export type ActionKind = 'send' | 'mutate' | 'read';

export interface RateVerdict {
  allowed: boolean;
  retryAfterMs: number;
  reason: string;
  counts: { lastMinute: number; lastHour: number; lastDay: number };
}

interface Limits {
  perMin: number;
  perHour: number;
  perDay: number;
}

/**
 * Defaults, and why these numbers.
 *
 * `send` 3/min · 20/hour · 100/day — a human at a keyboard does not send four
 * messages in a minute, and Google's own consumer sending cap is ~500/day, so
 * 100 leaves the account far away from the edge while still allowing a real
 * day's correspondence. The per-MINUTE cap is the one that matters: a runaway
 * agent loop is a burst, not a drift, and 3/min turns "sent it 40 times" into
 * "sent it 3 times and then said why it stopped".
 *
 * `mutate` (label / archive / delete / draft) 10/min · 120/hour · 600/day — more
 * headroom because nothing leaves the account, but still bounded: a bulk-label
 * loop is exactly the automation shape Google's Web App Attestation channel
 * exists to notice.
 *
 * `read` 20/min · 300/hour · 2000/day — each read drives a real browser and
 * costs seconds, so 20/min is close to unreachable in practice. That is the
 * point: the read cap is a runaway-loop stop, not a shaping policy.
 *
 * Every number is overridable per window via
 * `GMAIL_<SEND|MUTATE|READ>_MAX_PER_MIN | _PER_HOUR | _PER_DAY`.
 */
const LIMIT_DEFAULTS: Record<ActionKind, Limits> = {
  send: { perMin: 3, perHour: 20, perDay: 100 },
  mutate: { perMin: 10, perHour: 120, perDay: 600 },
  read: { perMin: 20, perHour: 300, perDay: 2000 },
};

/** Effective limits for a kind, re-read from the environment on every call. */
export function rateLimits(kind: ActionKind): Limits {
  const d = LIMIT_DEFAULTS[kind] || LIMIT_DEFAULTS.send;
  const K = kind.toUpperCase();
  return {
    perMin: envInt(`GMAIL_${K}_MAX_PER_MIN`, d.perMin, 100_000),
    perHour: envInt(`GMAIL_${K}_MAX_PER_HOUR`, d.perHour, 1_000_000),
    perDay: envInt(`GMAIL_${K}_MAX_PER_DAY`, d.perDay, 10_000_000),
  };
}

interface RateState {
  version: 1;
  actions: Record<ActionKind, number[]>;
}

const KINDS: ActionKind[] = ['send', 'mutate', 'read'];
/** Hard cap per bucket so a huge configured limit cannot grow the file forever. */
const MAX_BUCKET = 20_000;

let rateLoaded = false;
let rateState: RateState = { version: 1, actions: { send: [], mutate: [], read: [] } };

function emptyRateState(): RateState {
  return { version: 1, actions: { send: [], mutate: [], read: [] } };
}

/**
 * Load the rate state, once per process.
 *
 * A missing or corrupt `rate-state.json` re-seeds the SEND bucket from
 * `sent-log.jsonl` rather than starting empty. Without that, deleting or
 * truncating one JSON file would silently forget an hour of real sends and the
 * limiter would fail OPEN exactly when something has already gone wrong — and
 * sends are the one action whose history is independently recorded, so there is
 * no reason to lose it. Reads and mutations are not recoverable that way and do
 * start empty; that is an accepted, documented gap.
 */
function ensureRateLoaded(): void {
  if (rateLoaded) return;
  rateLoaded = true;
  const now = Date.now();
  try {
    const parsed = JSON.parse(fs.readFileSync(rateStateFile(), 'utf-8')) as Partial<RateState>;
    const st = emptyRateState();
    for (const k of KINDS) {
      const list = parsed?.actions?.[k];
      if (Array.isArray(list)) {
        st.actions[k] = list.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= now + MINUTE_MS);
      }
    }
    rateState = st;
  } catch {
    rateState = emptyRateState();
    ensureSendsLoaded();
    for (const rec of sends.values()) {
      if (rec.at > 0 && now - rec.at <= DAY_MS) rateState.actions.send.push(rec.at);
    }
  }
  for (const k of KINDS) prune(rateState.actions[k], now);
}

/** Drop everything older than the widest window, newest-last, bounded. */
function prune(list: number[], now: number): number[] {
  const cutoff = now - DAY_MS;
  let i = 0;
  while (i < list.length && list[i] < cutoff) i++;
  if (i > 0) list.splice(0, i);
  if (list.length > MAX_BUCKET) list.splice(0, list.length - MAX_BUCKET);
  return list;
}

function persistRateState(): void {
  try {
    fs.mkdirSync(GM_DATA_DIR, { recursive: true });
    const file = rateStateFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rateState));
    fs.renameSync(tmp, file);
  } catch {
    // A write failure must not break the caller's action: the in-memory mirror
    // still paces this process, and the next successful write re-persists it.
  }
}

function countsSince(list: number[], now: number): { lastMinute: number; lastHour: number; lastDay: number } {
  let lastMinute = 0;
  let lastHour = 0;
  let lastDay = 0;
  for (const ts of list) {
    const age = now - ts;
    if (age < 0) continue;
    if (age <= DAY_MS) lastDay++;
    if (age <= HOUR_MS) lastHour++;
    if (age <= MINUTE_MS) lastMinute++;
  }
  return { lastMinute, lastHour, lastDay };
}

/**
 * How long until this window is under its limit again: the moment the oldest
 * offending action falls out of it. `list` is chronological.
 */
function windowWaitMs(list: number[], now: number, windowMs: number, limit: number): number {
  if (limit <= 0) return windowMs; // disabled — no retry inside this window will succeed
  const inWindow = list.filter((ts) => now - ts <= windowMs && ts <= now);
  if (inWindow.length < limit) return 0;
  // The (inWindow.length - limit + 1)-th oldest must expire before a slot opens.
  const idx = inWindow.length - limit;
  return Math.max(0, inWindow[idx] + windowMs - now);
}

/**
 * May this action run right now? Pure — it records nothing. The caller records
 * with `recordAction()` only once the action is actually attempted, so a refusal
 * elsewhere in the chain never consumes quota.
 */
export function checkRate(kind: ActionKind): RateVerdict {
  ensureRateLoaded();
  const k: ActionKind = KINDS.includes(kind) ? kind : 'send';
  const now = Date.now();
  const list = prune(rateState.actions[k], now);
  const counts = countsSince(list, now);
  const lim = rateLimits(k);

  const breaches: Array<{ label: string; used: number; limit: number; wait: number }> = [];
  if (counts.lastMinute >= lim.perMin) {
    breaches.push({ label: 'minute', used: counts.lastMinute, limit: lim.perMin, wait: windowWaitMs(list, now, MINUTE_MS, lim.perMin) });
  }
  if (counts.lastHour >= lim.perHour) {
    breaches.push({ label: 'hour', used: counts.lastHour, limit: lim.perHour, wait: windowWaitMs(list, now, HOUR_MS, lim.perHour) });
  }
  if (counts.lastDay >= lim.perDay) {
    breaches.push({ label: 'day', used: counts.lastDay, limit: lim.perDay, wait: windowWaitMs(list, now, DAY_MS, lim.perDay) });
  }

  if (!breaches.length) {
    return {
      allowed: true,
      retryAfterMs: 0,
      reason: `within limits — ${k}: ${counts.lastMinute}/${lim.perMin} per min, ${counts.lastHour}/${lim.perHour} per hour, ${counts.lastDay}/${lim.perDay} per day`,
      counts,
    };
  }
  // Wait until EVERY breached window has cleared, not just the tightest.
  const retryAfterMs = Math.max(...breaches.map((b) => b.wait));
  const disabled = breaches.find((b) => b.limit === 0);
  const detail = breaches.map((b) => `${b.used} in the last ${b.label} (max ${b.limit})`).join('; ');
  const reason = disabled
    ? `${k} is DISABLED by GMAIL_${k.toUpperCase()}_MAX_PER_${disabled.label.toUpperCase()}=0 — no retry will succeed until it is raised`
    : `${k} rate limit — ${detail}; retry in ${Math.ceil(retryAfterMs / 1000)}s`;
  return { allowed: false, retryAfterMs, reason, counts };
}

/**
 * Count one action against the limiter. Call it when the action is ATTEMPTED,
 * not when it succeeds: a failed send still consumed Google's attention, and a
 * retry loop that only counted successes would not be paced at all.
 */
export function recordAction(kind: ActionKind): void {
  ensureRateLoaded();
  const k: ActionKind = KINDS.includes(kind) ? kind : 'send';
  const now = Date.now();
  rateState.actions[k].push(now);
  prune(rateState.actions[k], now);
  persistRateState();
}

// ─── recipient policy ────────────────────────────────────────────────────────

/**
 * Is this a usable email address?
 *
 * Pragmatic, not RFC-complete: quoted local parts and IP-literal domains are
 * rejected because an agent producing one is very much more likely to have
 * hallucinated than to have meant it. Accepts a bare address or one wrapped in
 * angle brackets; `Name <addr>` is handled by the callers that need it.
 */
export function isValidAddress(a: string): boolean {
  const s = String(a ?? '').trim().replace(/^<|>$/g, '').trim();
  if (!s || s.length > 254) return false;
  if (/[\s,;<>"'\\()[\]]/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).toLowerCase();
  if (!local || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9!#$%&*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (!domain || domain.length > 253 || domain.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) {
    if (!l || l.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(l)) return false;
    if (l.startsWith('-') || l.endsWith('-')) return false;
  }
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,}$/.test(tld);
}

/** Parse `GMAIL_RECIPIENT_ALLOWLIST` / `_DENYLIST`: comma-separated, lowercased. */
function policyList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Does `address` match one policy entry? An entry is either a FULL address
 * (`a@b.io` — exact match) or a DOMAIN (`b.io` or `@b.io`), which matches that
 * domain AND its subdomains (`a@mail.b.io`). Subdomains are included on purpose:
 * an allowlist of `example.com` that missed `notifications.example.com` would be
 * papered over by the operator adding a second, looser entry.
 */
function matchesPolicy(address: string, entries: string[]): string | null {
  const addr = address.toLowerCase();
  const domain = addr.slice(addr.indexOf('@') + 1);
  for (const e of entries) {
    if (e.includes('@')) {
      if (addr === e) return e;
      continue;
    }
    if (domain === e || domain.endsWith('.' + e)) return e;
  }
  return null;
}

/**
 * Optional allow/deny lists, so an agent cannot mail arbitrary strangers.
 *
 *   GMAIL_RECIPIENT_ALLOWLIST — comma-separated addresses/domains. EMPTY (the
 *     default) means allow all: this is opt-in, because a connector that refused
 *     everything until configured would just be turned off.
 *   GMAIL_RECIPIENT_DENYLIST  — checked FIRST and wins over the allowlist, so a
 *     single blocked address inside an allowed domain is expressible.
 *
 * An address that is not a valid address is also blocked, and named as such: a
 * hallucinated recipient must never reach the To field, where Gmail's own
 * behaviour (chip or no chip) becomes the only check.
 *
 * The reason ECHOES what was blocked and which rule blocked it — a refusal the
 * operator cannot act on is a refusal they will route around.
 */
export function checkRecipients(to: string[]): { allowed: boolean; blocked: string[]; reason: string } {
  const raw = Array.isArray(to) ? to : to == null ? [] : [to];
  const parsed = raw
    .flatMap((item) => String(item ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parsed.length) {
    return { allowed: false, blocked: [], reason: 'no recipients — refusing to open a compose dialog with an empty To field' };
  }

  const allow = policyList('GMAIL_RECIPIENT_ALLOWLIST');
  const deny = policyList('GMAIL_RECIPIENT_DENYLIST');
  const blocked: string[] = [];
  const notes: string[] = [];

  for (const entry of parsed) {
    const addr = extractAddress(entry);
    if (!addr || !isValidAddress(addr)) {
      blocked.push(entry);
      notes.push(`"${entry}" is not a valid email address`);
      continue;
    }
    const hitDeny = matchesPolicy(addr, deny);
    if (hitDeny) {
      blocked.push(entry);
      notes.push(`"${addr}" matches GMAIL_RECIPIENT_DENYLIST entry "${hitDeny}"`);
      continue;
    }
    if (allow.length && !matchesPolicy(addr, allow)) {
      blocked.push(entry);
      notes.push(`"${addr}" is not covered by GMAIL_RECIPIENT_ALLOWLIST (${allow.join(', ')})`);
    }
  }

  if (blocked.length) {
    return { allowed: false, blocked, reason: `recipient policy blocked ${blocked.length} of ${parsed.length}: ${notes.join('; ')}` };
  }
  const scope = allow.length ? `allowlist: ${allow.join(', ')}` : 'no allowlist configured (all recipients permitted)';
  return { allowed: true, blocked: [], reason: `all ${parsed.length} recipient(s) permitted — ${scope}` };
}

// ─── test hooks ──────────────────────────────────────────────────────────────

/** Test-only: drop both in-memory mirrors so the next call re-reads from disk. */
export function _resetForTest(): void {
  sendsLoaded = false;
  sends = new Map();
  rateLoaded = false;
  rateState = emptyRateState();
}
