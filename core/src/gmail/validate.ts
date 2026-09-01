/**
 * Gmail connector — EXTRACTION INVARIANTS. Deploy to `core/src/gmail/validate.ts`.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Every Gmail extraction bug found on 2026-07-29 was SILENT. Not one of them
 * threw. Each returned a plausible, well-shaped, confidently-wrong answer:
 *
 *   - `#sent` returned INBOX rows          (Gmail retains previous view containers)
 *   - `listSendAs()` returned 0 identities (textContent glues: "make defaultedit")
 *   - an attachment was named
 *     "attachment X.docxPreview attachment X.docxX.docx256 KB"  (same gluing)
 *   - `readThread(B)` handed back thread A (Gmail's URL id space ≠ the legacy
 *     hex id space, so `#all/<hex>` no-ops WHILE STILL setting location.hash to
 *     the id you asked for — the hash certifies the wrong thread)
 *   - compose could not find its own To field (`__scope()` resolved too narrow)
 *
 * A silent wrong answer is worse than an exception: the caller acts on it. So
 * every function here FAILS CLOSED — it throws `GmDriftError` and returns
 * nothing usable. There is deliberately NO `warnOnly` / `strict:false` switch:
 * a validator that logs and hands the data back reproduces the exact bug it was
 * written to stop, and the flag would be set to `false` the first time a check
 * was inconvenient.
 *
 * ── Error messages are the product ───────────────────────────────────────────
 * These fire in production, on someone else's mailbox, where nobody can re-run
 * the probe. So every message names (a) the INVARIANT that was violated, (b)
 * what was ACTUALLY SEEN, truncated, and (c) where the real-world cause was last
 * measured. `saw` carries a structured sample for a caller that wants to log it.
 *
 * ── Two structural rules, both load-bearing ──────────────────────────────────
 * 1. ZERO imports. cdp-client.ts already had to lazy-`require('./safety')` to
 *    dodge a require cycle (safety imports GmError from cdp-client). A pure
 *    module cannot ever close such a cycle, and it means these invariants can be
 *    unit-tested against fixture shapes with no browser and no CDP.
 * 2. `GmDriftError` carries `.code`. cdp-client's `toGmError()` normalises any
 *    thrown object with a string `.code` into a `GmError` PRESERVING that code,
 *    and gmail.routes.ts's `fail()` surfaces `e.code` in the envelope. So a
 *    drift code travels intact from the DOM all the way to the MCP caller
 *    WITHOUT this file importing anything from cdp-client. Do not "tidy" that
 *    into `extends GmError`; that is the import cycle again.
 */

// ─── the error ───────────────────────────────────────────────────────────────

/**
 * A violated extraction invariant.
 *
 * `code` is the machine-readable tag (survives to the caller via toGmError →
 * fail()); `invariant` is the one-line rule in plain English; `saw` is the
 * structured sample, already truncated for the message but kept whole here.
 */
export class GmDriftError extends Error {
  code: string;
  invariant: string;
  saw: unknown;
  constructor(code: string, invariant: string, message: string, saw: unknown) {
    super(message);
    this.name = 'GmDriftError';
    this.code = code;
    this.invariant = invariant;
    this.saw = saw;
  }
}

// ─── small shared helpers ────────────────────────────────────────────────────

/** How much of the offending value goes into the message. Enough to diagnose, not enough to flood a log. */
const SAMPLE_MAX = 220;

/** A truncated, log-safe rendering of anything. Never throws. */
function sample(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
    if (s === undefined) s = String(v);
  }
  return s.length > SAMPLE_MAX ? `${s.slice(0, SAMPLE_MAX)}… (+${s.length - SAMPLE_MAX} chars)` : s;
}

/** Trimmed string, or '' — numbers included, because a relayed argument does not always keep its JSON type. */
function strOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** The thread id off a row-shaped object, tolerant of transport typing. */
function idOf(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  return strOf((row as { threadId?: unknown }).threadId);
}

// ─── thread ids ──────────────────────────────────────────────────────────────

/**
 * Is this a well-formed Gmail legacy thread/message id?
 *
 * MEASURED: `data-legacy-thread-id` / `data-legacy-message-id` are 16 lowercase
 * hex digits. This is deliberately STRICT and deliberately NOT used as a hard
 * per-row gate — `assertThreadRows` only fails when at least HALF a listing
 * fails it, so one odd id never breaks a read while a drifted selector (which
 * fails all of them) does.
 *
 * 🔴 Never confuse this id space with the one in Gmail's URL. A permalink id
 * (`FMfcgzQ…`) is a DIFFERENT id space; passing one here correctly returns false.
 */
export function looksLikeThreadId(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
}

// ─── view context ────────────────────────────────────────────────────────────

/**
 * Views that CANNOT legitimately be empty on a live account. Everything else —
 * an arbitrary user label, a search — may honestly return nothing, and calling
 * that "broken" is how a validator trains people to ignore it.
 */
const NEVER_EMPTY_VIEWS = new Set(['inbox', 'all', 'anywhere', 'sent', 'in:inbox', 'in:sent', 'in:anywhere']);

/** Normalise `#label/Sent`, `#search/in:sent`, `Sent`, `inbox` → a comparable key. */
function viewKey(view: string): string {
  return String(view ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/^(?:label|search)\//, '')
    .replace(/%3a/g, ':')
    .trim();
}

function mustBeNonEmpty(view: string): boolean {
  return NEVER_EMPTY_VIEWS.has(viewKey(view));
}

// ─── listing invariants ──────────────────────────────────────────────────────

/**
 * Classify a listing WITHOUT throwing — the shared judgement behind
 * `assertThreadRows`, exported so a caller can branch (e.g. a UI that wants to
 * render "empty label" differently from "the extractor broke") without a
 * try/catch.
 *
 *   'empty'  — 0 rows in a view that may honestly be empty.
 *   'broken' — not an array; OR 0 rows in a view that cannot be empty; OR rows
 *              were FOUND but ≥50% carry no well-formed 16-hex id.
 *   'ok'     — rows, mostly well-identified.
 *
 * The 50% rule is the whole point: rows present in the DOM but without ids is
 * SELECTOR DRIFT (`tr.zA` still matches, `[data-legacy-thread-id]` no longer
 * does), which is a completely different failure from an empty mailbox and must
 * never be reported as one.
 */
export function isEmptyVsBroken(rows: unknown, view: string): 'empty' | 'broken' | 'ok' {
  if (!Array.isArray(rows)) return 'broken';
  if (rows.length === 0) return mustBeNonEmpty(view) ? 'broken' : 'empty';
  const bad = rows.filter((r) => !looksLikeThreadId(idOf(r))).length;
  return bad * 2 >= rows.length ? 'broken' : 'ok';
}

/**
 * A thread listing is an array of rows that mostly carry real Gmail ids.
 *
 * `ctx.view` is required because emptiness is only meaningful relative to the
 * view: 0 rows is fine for a label nobody has used and catastrophic for
 * `#inbox`. `ctx.expectNonEmpty` overrides the built-in judgement when the
 * caller knows better (e.g. a search that was seeded to match).
 *
 * Catches: `#sent` returning nothing because the container never rendered, and
 * the `[data-legacy-thread-id]` selector drifting out from under `tr.zA`.
 */
export function assertThreadRows(rows: unknown, ctx: { view: string; expectNonEmpty?: boolean }): void {
  const view = String(ctx?.view ?? '(unknown view)');

  if (!Array.isArray(rows)) {
    throw new GmDriftError(
      'DRIFT_ROWS_SHAPE',
      'a thread listing is an array of rows',
      `listing "${view}" did not return an array — the extractor's return shape changed, so nothing downstream can be trusted. Saw: ${sample(rows)}`,
      rows,
    );
  }

  const expectNonEmpty = ctx?.expectNonEmpty === undefined ? mustBeNonEmpty(view) : ctx.expectNonEmpty === true;

  if (rows.length === 0) {
    if (!expectNonEmpty) return; // a label with no mail is a real, honest answer
    throw new GmDriftError(
      'DRIFT_ROWS_EMPTY',
      `the "${view}" view always has at least one row`,
      `listing "${view}" returned 0 rows. That view cannot be empty on a live account, so this is a view that never rendered or drift on the row selector (tr.zA) — NOT an empty mailbox. Do not report it as one.`,
      { view, length: 0 },
    );
  }

  const ids = rows.map(idOf);
  const bad = ids.filter((v) => !looksLikeThreadId(v));
  if (bad.length * 2 >= rows.length) {
    throw new GmDriftError(
      'DRIFT_ROWS_MALFORMED',
      'at least half of a listing carries a 16-hex data-legacy-thread-id',
      `listing "${view}" returned ${rows.length} row(s) but ${bad.length} carry no well-formed 16-hex thread id. Rows were FOUND in the DOM, so this is SELECTOR DRIFT on [data-legacy-thread-id], not an empty mailbox. Saw ids: ${sample(ids.slice(0, 6))}`,
      { view, count: rows.length, malformed: bad.length, ids: ids.slice(0, 12) },
    );
  }
}

/**
 * Two DIFFERENT views must not hand back the same top rows.
 *
 * 🔴 THE stale-container canary, and the reason it exists: Gmail RETAINS
 * previous view containers in the DOM. After inbox → sent → search there were
 * THREE 50-row list tables live at once, only ONE visible (height 5000; the
 * others height 0). A global `querySelectorAll('tr.zA')` returns the STALE rows
 * FIRST, so `#sent` answered with the inbox — successfully, with a full
 * well-formed payload, and no error anywhere.
 *
 * Compares the top `depth` ids AS A SEQUENCE. One shared top row is possible in
 * real life (mail you sent to yourself); three identical rows in identical order
 * across two views is not. If either side is empty there is nothing to compare
 * and this is a no-op — emptiness is `assertThreadRows`'s job, not this one's.
 */
export function assertDistinctViews(
  a: unknown,
  b: unknown,
  ctx: { viewA: string; viewB: string; depth?: number },
): void {
  const viewA = String(ctx?.viewA ?? 'view A');
  const viewB = String(ctx?.viewB ?? 'view B');
  if (viewKey(viewA) === viewKey(viewB)) return; // same view — identical rows are correct
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return;

  const depth = Math.max(1, Math.min(ctx?.depth ?? 3, a.length, b.length));
  const topA = a.slice(0, depth).map(idOf);
  const topB = b.slice(0, depth).map(idOf);
  if (topA.some((v) => !v) || topB.some((v) => !v)) return; // no ids to compare on

  if (topA.join('|') === topB.join('|')) {
    throw new GmDriftError(
      'DRIFT_VIEW_STALE',
      'two different views must not return identical top rows',
      `"${viewA}" and "${viewB}" both returned the same top ${depth} thread id(s): ${sample(topA)}. Gmail keeps PREVIOUS view containers in the DOM (measured: 3 list tables x 50 rows, only one visible), and an unscoped read returns the STALE ones first — so one of these two listings is almost certainly the other view's mail. Refusing to answer with it.`,
      { viewA, viewB, topA, topB },
    );
  }
}

// ─── thread identity ─────────────────────────────────────────────────────────

/** The parts of a thread read this file needs. Structural, so no import from cdp-client. */
export interface ThreadDetailLike {
  /** 🔴 ECHOED from the request by readThreadDom — NEVER evidence. See below. */
  threadId?: unknown;
  /** `[{ messageId }]` — messageId comes from `data-legacy-message-id`. THE evidence. */
  messages?: unknown;
  /** Optional: `data-legacy-thread-id` values observed in the OPEN thread. Also evidence. */
  observedThreadIds?: unknown;
}

/**
 * The rendered thread must CONTAIN the id that was asked for.
 *
 * 🔴 MEASURED, and the single most dangerous Gmail behaviour found: navigating
 * `#all/<legacy-hex>` does NOT open that thread. Gmail's URL uses a permalink id
 * space (`FMfcgzQ…`) that is not the `data-legacy-thread-id` hex space, so the
 * route silently no-ops and leaves whatever was already on screen — WHILE STILL
 * UPDATING location.hash TO THE ID YOU REQUESTED. `gmail_read_thread(B)` came
 * back with thread A's mail and `success: true`.
 *
 * 🔴 So there are exactly TWO things that must never be used as proof:
 *   - `location.hash`  — it is set to the request, not to what rendered.
 *   - `detail.threadId` — `readThreadDom()` builds it as `threadId: id`, i.e. it
 *     ECHOES the argument. Asserting `detail.threadId === requested` passes 100%
 *     of the time, including on the bug. It is checked here only to make the
 *     error message say so out loud.
 *
 * The only evidence is `data-legacy-message-id` (and any `data-legacy-thread-id`
 * read out of the OPEN conversation), because those are attributes Gmail wrote
 * onto what it actually painted.
 */
export function assertThreadMatches(requested: string, detail: ThreadDetailLike): void {
  const want = strOf(requested);
  if (!want) {
    throw new GmDriftError(
      'DRIFT_THREAD_ARG',
      'a thread identity check needs an id to check against',
      `assertThreadMatches was called with an empty requested id (${sample(requested)}) — a check with nothing to compare is a check that always passes.`,
      requested,
    );
  }

  const msgs = Array.isArray(detail?.messages) ? detail.messages : [];
  const msgIds = msgs.map((m) => strOf((m as { messageId?: unknown } | null)?.messageId)).filter((v) => v !== '');
  const extra = Array.isArray(detail?.observedThreadIds)
    ? detail.observedThreadIds.map(strOf).filter((v) => v !== '')
    : [];
  const evidence = msgIds.concat(extra);

  if (evidence.length === 0) {
    throw new GmDriftError(
      'DRIFT_THREAD_NO_IDS',
      'a rendered thread carries at least one data-legacy-message-id',
      `thread ${want} rendered ${msgs.length} message(s), not one of which carries a data-legacy-message-id — so there is NO evidence about which conversation is on screen. detail.threadId (${sample(detail?.threadId)}) is the id that was REQUESTED, echoed straight back by readThreadDom; it is exactly as trustworthy as location.hash, which is to say not at all.`,
      { requested: want, messages: msgs.length, threadIdEcho: detail?.threadId },
    );
  }

  if (!evidence.includes(want)) {
    throw new GmDriftError(
      'DRIFT_THREAD_MISMATCH',
      'the rendered thread contains the id that was requested',
      `asked for thread ${want}, but the rendered conversation carries ${sample(evidence.slice(0, 6))}. Gmail's URL thread id is a DIFFERENT id space from data-legacy-thread-id, so #all/<hex> silently no-ops and leaves the previous thread on screen while still setting location.hash to the requested id. Refusing to hand back another thread's mail.`,
      { requested: want, rendered: evidence.slice(0, 8) },
    );
  }
}

// ─── attachment names ────────────────────────────────────────────────────────

/**
 * A filename: at least one character, a dot, a short extension, no path or
 * shell-hostile characters. Deliberately permissive about SPACES — "attachment
 * X.docx" is a perfectly real filename.
 */
const FILENAME_RE = /^[^\\/:*?"<>|\r\n\t]{1,240}\.[A-Za-z0-9]{1,10}$/;

/**
 * A human size label glued onto the end: "256 KB", "1.2 MB", "128K", "12 bytes".
 * Only ever applied to a string that has ALREADY failed the clean test, and it
 * can only match at end-of-string — a well-formed name ends in `.ext`, never in
 * a unit letter, so this cannot eat a real filename.
 */
const SIZE_TAIL = /\s*\(?\d+(?:[.,]\d+)?\s*(?:bytes?|[KMGT]iB|[KMGT]B|[KMGT]|B)\)?\s*$/i;

/** A filename-shaped suffix with a real stem (≥1 non-dot, non-space char before the extension dot). */
const UNIT_RE = /^[^.\s\\/:*?"<>|]+\.[A-Za-z0-9]{1,10}$/;

/** Count non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * The longest filename-shaped SUFFIX of `s` that occurs at least twice in `s`.
 *
 * This is the repair AND the detector, because the glue pattern is a repetition:
 * `<name><a11y label containing name><name><size>`. The unit that repeats IS the
 * filename. Requiring a non-dot stem is what keeps `foo.pdf.pdf` (a real, if
 * silly, filename) from looking doubled because ".pdf" appears twice.
 */
function repeatedUnit(s: string): string | null {
  for (let i = 0; i < s.length - 1; i++) {
    const suffix = s.slice(i);
    if (!UNIT_RE.test(suffix)) continue;
    if (occurrences(s, suffix) >= 2) return suffix;
  }
  return null;
}

/** Well-formed AND not self-repeating. */
function isCleanName(s: string): boolean {
  return FILENAME_RE.test(s) && repeatedUnit(s) === null;
}

/**
 * Validate — and where possible REPAIR — an attachment filename. The one
 * repair-or-fail case in this file.
 *
 * 🔴 MEASURED: `textContent` concatenates adjacent elements with NO separator.
 * The extractor assumed a comma-separated a11y string and produced
 *   "attachment X.docxPreview attachment X.docxX.docx256 KB"
 * — the download link's a11y label, the preview button's a11y label, the visible
 * chip text and the size label, run together. Nothing threw; the row was
 * returned with that as its `name`.
 *
 * The two invariants, from that measurement:
 *   1. a filename matches `*.<ext>`;
 *   2. it does not contain the same basename twice.
 *
 * Repair is conservative and ordered: strip a trailing size label, then take the
 * longest filename-shaped suffix that REPEATS (the repeating unit is the
 * filename). Anything that cannot be reduced to a clean name THROWS — a
 * best-effort mangled name is how "X.docxX.docx" ends up in a download path.
 *
 * `null`/`undefined` in → `null` out: "no name was extracted" is an honest,
 * checkable answer. An EMPTY or whitespace-only string is not — that is a row
 * that claimed a name and produced nothing, which is drift.
 */
export function assertAttachmentName(name: string | null): string | null {
  if (name === null || name === undefined) return null;

  if (typeof name !== 'string') {
    throw new GmDriftError(
      'DRIFT_ATTACHMENT_NAME',
      'an attachment name is a string or null',
      `attachment name was ${typeof name}, not a string: ${sample(name)}`,
      name,
    );
  }

  const s = name.replace(/[​‌‍‎‏﻿]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) {
    throw new GmDriftError(
      'DRIFT_ATTACHMENT_NAME',
      'an attachment row that carries a name carries a non-empty one',
      `attachment name was empty after trimming (raw: ${sample(name)}) — the name node was found but yielded nothing, which is extraction drift, not a nameless attachment.`,
      name,
    );
  }

  if (isCleanName(s)) return s;

  const noSize = s.replace(SIZE_TAIL, '').trim();
  if (noSize && isCleanName(noSize)) return noSize;

  const unit = repeatedUnit(noSize || s);
  if (unit && isCleanName(unit)) return unit;

  throw new GmDriftError(
    'DRIFT_ATTACHMENT_NAME',
    'a filename matches *.<ext> and does not contain the same basename twice',
    `attachment name ${sample(name)} is not a filename and could not be repaired into one. This is the textContent-gluing signature: adjacent nodes concatenate with NO separator, so a11y labels, the visible chip and the size label run together (measured: "attachment X.docxPreview attachment X.docxX.docx256 KB"). Fix the extractor to read ONE node, not a subtree's textContent.`,
    { raw: name, afterSizeStrip: noSize, repeatedUnit: unit },
  );
}

// ─── send-as identities ──────────────────────────────────────────────────────

/**
 * Every "Send mail as" row Gmail shows. Structural on purpose — this is the same
 * shape as config.SendAsIdentity, without importing it.
 */
export interface SendAsLike {
  email?: unknown;
  isDefault?: unknown;
}

/**
 * The send-as table.
 *
 * 🔴 ZERO IS BROKEN, NOT EMPTY. Every Gmail account carries at least its own
 * primary address in "Send mail as" — an account with no identities does not
 * exist. MEASURED: the reference account has 11 and the extractor returned 0,
 * because `textContent` glued the row's controls into "make defaultedit", so
 * `/\bmake default\b/` never matched and every row was discarded. The call
 * succeeded and reported an empty table.
 *
 * Exactly one row must be marked default, because that identity decides who
 * every outgoing message is FROM. MEASURED on the reference account: the compose
 * opened as `support@langmart.ai`, not as the signed-in primary
 * — so "who is this from" is never inferable and a wrong default is a wrong
 * sender on real mail. Zero defaults is the `make default` parse failing; two is
 * the same gluing matching too much.
 */
export function assertSendAs(identities: unknown): void {
  if (!Array.isArray(identities)) {
    throw new GmDriftError(
      'DRIFT_SENDAS_SHAPE',
      'the send-as table is an array',
      `the send-as read did not return an array, so the identity that decides who mail is FROM is unknown. Saw: ${sample(identities)}`,
      identities,
    );
  }

  if (identities.length === 0) {
    throw new GmDriftError(
      'DRIFT_SENDAS_EMPTY',
      'an account always has at least one send-as identity',
      'the send-as table came back with 0 identities. That is impossible on a real account — every Gmail account lists at least its own primary address — so this is extraction drift, not an account without aliases. MEASURED cause: textContent concatenates adjacent controls with no separator ("make defaultedit"), so the /\\bmake default\\b/ row test never matches and every row is dropped. Read the control nodes individually.',
      { length: 0 },
    );
  }

  const rows = identities as SendAsLike[];
  const badAddr = rows.filter((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strOf(r?.email)));
  if (badAddr.length) {
    throw new GmDriftError(
      'DRIFT_SENDAS_ADDRESS',
      'every send-as row carries a parseable email address',
      `${badAddr.length} of ${rows.length} send-as row(s) carry no usable address: ${sample(badAddr.slice(0, 4).map((r) => r?.email))}. A row whose address is a glued label will send mail from nowhere.`,
      badAddr.slice(0, 6),
    );
  }

  const defaults = rows.filter((r) => r?.isDefault === true);
  if (defaults.length !== 1) {
    throw new GmDriftError(
      'DRIFT_SENDAS_DEFAULT',
      'exactly one send-as identity is the default',
      `${rows.length} send-as identity(ies) but ${defaults.length} marked default${defaults.length ? ` (${sample(defaults.map((r) => r?.email))})` : ''}. The default decides who every outgoing message is FROM — and it is NOT the signed-in address on this account (measured: compose opened as an alias). ${defaults.length === 0 ? 'Zero defaults is the "make default" row test failing to match, the same textContent-gluing bug that emptied this table.' : 'More than one is that same glued text matching too broadly.'}`,
      rows.map((r) => ({ email: r?.email, isDefault: r?.isDefault })).slice(0, 12),
    );
  }
}

// ─── compose readiness ───────────────────────────────────────────────────────

/**
 * Whether each compose control resolved. A field may be reported as a boolean, a
 * match COUNT, or the selector string that matched — all three are accepted so a
 * caller can pass a probe result straight through.
 */
export interface ComposeFieldsLike {
  to: unknown;
  subject: unknown;
  body: unknown;
  send: unknown;
}

function resolved(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  if (typeof v === 'string') return v.trim() !== '';
  return false;
}

/**
 * A live compose exposes To, Subject, Body and Send TOGETHER.
 *
 * 🔴 MEASURED: `__scope()` used to walk up ≤12 ancestors from the last visible
 * body looking for a visible Send button, and fall back to
 * `body.parentElement`. That resolved a container too NARROW to hold the To
 * field, so every send died with RECIPIENT_FIELD_UNAVAILABLE with the dialog
 * plainly open on screen. The four controls are checked together precisely
 * because the failure was a scope that held three of them.
 *
 * Also the readiness gate for opening a compose: waiting only for the To field
 * resolves an empty scope, because the resolver walks up from the BODY.
 */
export function assertComposeReady(fields: ComposeFieldsLike): void {
  const want = ['to', 'subject', 'body', 'send'] as const;
  const missing = want.filter((k) => !resolved(fields?.[k]));
  if (missing.length) {
    throw new GmDriftError(
      'DRIFT_COMPOSE_INCOMPLETE',
      'a live compose exposes To, Subject, Body and Send together',
      `the compose scope resolved ${want.length - missing.length}/4 controls — missing: ${missing.join(', ')}. Saw ${sample(fields)}. A scope holding some but not all four is the __scope() resolution bug: it walked up from the body and stopped at a container too narrow to hold the recipient field, so sends failed with RECIPIENT_FIELD_UNAVAILABLE while the dialog was open. Do not type into a partially-resolved compose.`,
      fields,
    );
  }
}

// ─── left-nav labels ─────────────────────────────────────────────────────────

/**
 * 🔴 VERIFIED HAZARD: on a LIST view the unscoped `.at` selector — the one that
 * yields real label chips on an OPEN thread — returns TOOLBAR CONTROLS instead.
 * These are the exact strings it produced. A label list containing any of them
 * is reading the toolbar, and every one of those "labels" is a lie.
 */
export const TOOLBAR_JUNK_LABELS: readonly string[] = [
  'select',
  'archive',
  'mark as read',
  'mark as unread',
  'snooze',
  'delete',
  'report spam',
  'move to',
  'labels',
  'more',
];

/** A parsed nav label. Structural — same shape as labels.LabelInfo. */
export interface NavLabelLike {
  name?: unknown;
}

/**
 * Labels are labels, not toolbar buttons.
 *
 * Note what this does NOT assert: that there is at least one label. An account
 * with no user labels is real, so "0 labels" is ambiguous and belongs in a
 * self-check's WARN column, not in a fail-closed assertion. Junk strings are not
 * ambiguous — they are proof the selector is reading the wrong subtree.
 */
export function assertNavLabels(labels: unknown): void {
  if (!Array.isArray(labels)) {
    throw new GmDriftError(
      'DRIFT_LABELS_SHAPE',
      'the label list is an array',
      `the label read did not return an array, so nothing can be said about which labels exist on this account. Saw: ${sample(labels)}`,
      labels,
    );
  }
  const junk = (labels as NavLabelLike[]).filter((l) => TOOLBAR_JUNK_LABELS.includes(strOf(l?.name).toLowerCase()));
  if (junk.length) {
    throw new GmDriftError(
      'DRIFT_LABEL_JUNK',
      'a parsed label is never a toolbar control',
      `${junk.length} of ${labels.length} "labels" are toolbar controls: ${sample(junk.map((l) => l?.name))}. VERIFIED HAZARD: the unscoped .at selector returns Select / Archive / Mark as read / Snooze on a LIST view — it only yields real label chips once h2.hP proves a thread is open. The label read has escaped its scope.`,
      junk.slice(0, 8),
    );
  }
}
