/**
 * Gmail compose surface (CDP).
 *
 * Supersedes and generalises the send path that grew inside cdp-client.ts
 * (setInputValue / commitRecipients / setEditorText / fillCompose / clickCompose
 * / sendMail): this module owns send, draft, reply, reply-all, forward and the
 * draft lifecycle, with cc/bcc, attachments, send-as aliases and rich bodies.
 *
 * ── What is MEASURED vs what is a CANDIDATE ─────────────────────────────────
 * Every selector below is tagged. VERIFIED = observed live on Gmail 2026-07-29.
 * CANDIDATE = structurally reasonable but never seen; each one is used only as a
 * fallback behind a verified selector or a class-free structural walk, and every
 * one of them fails LOUDLY (a coded error) rather than silently sending.
 *
 * ── Three page-level constraints that shape all of this ─────────────────────
 * 1. TYPING IS BROKEN. MEASURED: `Input.insertText` lands nothing and
 *    per-character `Input.dispatchKeyEvent` lands nothing — `el.focus()` does not
 *    stick on Gmail's peoplekit widgets, and this is NOT the usual headless
 *    unfocused case (`document.hasFocus()` is already true;
 *    Emulation.setFocusEmulationEnabled changes nothing). The only thing that
 *    works is the NATIVE value setter plus an `input` event. So this module never
 *    types; see setNativeValue().
 * 2. TRUSTED TYPES ARE ENFORCED. `innerHTML` THROWS ("This document requires
 *    'TrustedHTML' assignment"). That exact throw once sent a REAL email with an
 *    EMPTY body. Nothing here ever assigns a string to an HTML sink: markdown and
 *    text go through markdown.ts's DOM builder, and `format:'html'` is parsed with
 *    DOMParser (not a Trusted Types sink) and re-built node by node through an
 *    allowlist. No TT policy is created.
 * 3. STALE COMPOSES STAY IN THE DOM. Gmail keeps minimised/closed compose
 *    containers around, and `document.querySelector` returns the FIRST match —
 *    frequently an invisible one, so the text lands nowhere visible and the real
 *    compose sends empty. Everything here resolves through __scope(), which walks
 *    UP from the last VISIBLE body to the container that also holds a visible Send
 *    button. That walk is class-free, so Gmail's hashed class names cannot break it.
 *
 * ── Why URL prefill for recipients ──────────────────────────────────────────
 * `?tf=cm&to=…&cc=…&bcc=…&su=…` produces properly COMMITTED recipient chips with
 * no typing at all, which routes around constraint 1 entirely for the one field
 * where a failure is unrecoverable: Gmail sends only to CHIPPED recipients, so a
 * filled-looking To box with no chip sends to NOBODY. Typing remains implemented
 * (ensureRecipients) because forward has no prefill URL, and it doubles as the
 * top-up path when prefill under-delivers. The BODY never rides in the URL — one
 * body path for all three formats, no URL length ceiling, and a readable
 * character count to verify against.
 *
 * Nothing in this file throws inside the page: every snippet returns
 * `{ok:true,…}` or `{ok:false,code,message}` and evalPage() converts the latter
 * into a GmComposeError carrying that code.
 */

import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import { parseMarkdown, buildDomScript, type MdNode, type MdInline } from './markdown';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export type MailFormat = 'markdown' | 'text' | 'html';

export interface ComposeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  format?: MailFormat;
  /** Absolute local file paths, resolved on the machine running CHROME. */
  attachments?: string[];
  /** Send-as alias, if the account has one. */
  fromAlias?: string;
}

/**
 * The CDP surface this module needs.
 *
 * `evaluate` runs the expression as the BODY of an async function (that is how
 * cdp-client wraps it), so snippets are statements ending in `return`, and
 * `await` is legal. `send` is the raw channel, needed for DOM.setFileInputFiles,
 * which cannot be expressed as page JS.
 */
export interface ComposeCtx {
  evaluate<T>(expr: string): Promise<T>;
  navigate(url: string): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class GmComposeError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'GmComposeError';
    this.code = code;
    if (details) this.details = details;
  }
}

export interface SendResult {
  ok: true;
  to: string[];
  subject: string;
  verified: boolean;
  note?: string;
}

export interface DraftResult {
  ok: true;
  draftId?: string | null;
  verified: boolean;
  note?: string;
}

export interface ReplyResult {
  ok: true;
  threadId: string;
  mode: 'reply' | 'reply_all';
  verified: boolean;
  note?: string;
}

export interface ForwardResult {
  ok: true;
  threadId: string;
  to: string[];
  verified: boolean;
  note?: string;
}

export interface DraftRow {
  draftId: string;
  to: string | null;
  subject: string | null;
  date: string | null;
}

export interface SendDraftResult {
  ok: true;
  draftId: string;
  verified: boolean;
  note?: string;
}

export interface DeleteDraftResult {
  ok: true;
  draftId: string;
  verified: boolean;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const ORIGIN = 'https://mail.google.com';

/**
 * Mail entry point for one account slot.
 *
 * MEASURED 2026-07-29: every `/mail/u/N/` link on the driver profile is `u/0`, so
 * multi-account is not exercisable there. The index stays parameterised anyway —
 * hard-coding `u/0` is how a second-account user gets someone else's mailbox —
 * but it is untested above 0.
 */
function mailBase(accountIndex = 0): string {
  const n = Number.isInteger(accountIndex) && accountIndex >= 0 ? accountIndex : 0;
  return `${ORIGIN}/mail/u/${n}/`;
}

/** Gmail's own per-message ceiling is 25 MB; refuse above it rather than drop. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
/** Sanity ceiling on file count — a runaway glob should not open 300 uploads. */
export const MAX_ATTACHMENT_COUNT = 20;

const T = {
  composeOpen: 20000,
  fieldSettle: 400,
  chipCommit: 800,
  upload: 120000,
  sendConfirm: 25000,
  navSettle: 1500,
};

/**
 * Selectors. VERIFIED unless marked.
 *
 * Fix breakage HERE, never inline.
 */
const S = {
  /**
   * VERIFIED — the compose body, CANONICAL markers only.
   *
   * This doubles as the "is a compose open?" test, so it must not match anything
   * a compose-less page renders. MEASURED 2026-07-30: it used to also include a
   * bare \`div[contenteditable="true"][role="textbox"]\`, which matches Gmail's
   * Gemini "Describe your message" prompt — present on the plain inbox. That made
   * every presence check trivially true (selfcheck skipped its compose check as
   * \`preexisting\`; gotoHash stopped waiting instantly) and, because a comma-list
   * resolves in DOCUMENT order, made "last visible body" the AI prompt.
   */
  body: 'div[aria-label="Message Body"][role="textbox"], div[g_editable="true"][role="textbox"]',
  /** VERIFIED — the primary marker, tried before anything else. */
  bodyPrimary: 'div[aria-label="Message Body"][role="textbox"]',
  /** VERIFIED — Gmail's own editable flag; the fallback when the label changes. */
  bodyEditable: 'div[g_editable="true"][role="textbox"]',
  /**
   * UNVERIFIED, last resort — only if Gmail renames BOTH markers above. This one
   * DOES match the AI prompt box, so callers MUST keep the height guard in
   * __bodyEl. Never use it for a presence test.
   */
  bodyLoose: 'div[contenteditable="true"][role="textbox"]',
  /** VERIFIED — aria-label is "Send ‪(Ctrl-Enter)‬", so anchor on the tooltip prefix. */
  send: 'div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]',
  /**
   * VERIFIED — `input[name="to"]` DOES NOT EXIST; every recipient field is a
   * peoplekit combobox. The per-field aria-labels are, MEASURED:
   *   To  -> "To recipients"
   *   Cc  -> "CC recipients"   (note: "CC", not "Cc" — the toggle is "Cc")
   *   Bcc -> "BCC recipients"  (CANDIDATE: inferred by symmetry, not measured)
   * fieldInput() matches on the label's FIRST WORD, case-insensitively, so the
   * Cc/CC discrepancy and an unmeasured Bcc label both resolve without a guess.
   */
  recipientInput:
    'input[role="combobox"], input[peoplekit-id], input[name="to"], input[name="cc"], input[name="bcc"], textarea[name="to"], textarea[name="cc"], textarea[name="bcc"]',
  /**
   * VERIFIED — the Cc/Bcc toggles are role="link" (NOT role="button"), with the
   * exact text "Cc"/"Bcc". There are TWO matches for each in a live dialog
   * (classes "aB gQ pE"/"aB  gQ pB" and "gO aQY"), so the same stale-compose rule
   * applies: take the LAST VISIBLE one.
   */
  recipientToggle: '[role="link"], span[role="link"], div[role="link"]',
  /** VERIFIED. */
  subject: 'input[name="subjectbox"]',
  /** VERIFIED — exactly one in the dialog, carries `multiple`. */
  fileInput: 'input[type="file"][name="Filedata"], input[type="file"]',
  /** VERIFIED — the compose button; classes are hashable so text is the fallback. */
  composeBtn: 'div[role="button"].T-I.T-I-KE.L3',
  /** CANDIDATE — save-and-close. Failure is loud (SAVE_CLOSE_NOT_FOUND). */
  saveClose: '[aria-label^="Save & close"], [aria-label^="Save and close"], [data-tooltip^="Save & close"]',
  /** CANDIDATE — discard. Failure is loud (DISCARD_NOT_FOUND). */
  discard: '[aria-label^="Discard draft"], [data-tooltip^="Discard draft"]',
  /** VERIFIED — a recipient chip carries the address on one of these attributes. */
  chip: '[data-hovercard-id], [email]',
  /** VERIFIED — list row / list ready / thread ready, from the read path. */
  row: 'tr.zA',
  listReady: 'div[role="main"] table, tr.zA, .Cp',
  threadReady: 'h2.hP',
  /** VERIFIED — Gmail's post-send toast reads "Message sent Undo View message". */
  toast: '.bAq, .vh, [role="alert"], .b8.UC',
} as const;

const RECIPIENT_KINDS = ['to', 'cc', 'bcc'] as const;
type RecipientKind = (typeof RECIPIENT_KINDS)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (v: unknown) => JSON.stringify(v);

/* ------------------------------------------------------------------ *
 * Pure helpers — exported so the unit tests can reach them
 * ------------------------------------------------------------------ */

/**
 * Reduce an address to its comparable form: `Display Name <A@B.com>` -> `a@b.com`.
 * Comparison must be case-insensitive on the whole address (Gmail lower-cases the
 * domain and often the local part when it chips a contact), so a chip round-trip
 * that changes case is NOT treated as a missing recipient.
 */
export function normalizeAddress(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const angled = s.match(/<([^>]+)>\s*$/);
  const addr = (angled ? angled[1] : s).trim().replace(/^mailto:/i, '');
  return addr.toLowerCase();
}

/** Cheap structural check. Deliberately permissive — Gmail is the real authority. */
export function looksLikeAddress(raw: string): boolean {
  const a = normalizeAddress(raw);
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a);
}

export interface RecipientDiff {
  ok: boolean;
  missing: string[];
  extra: string[];
}

/**
 * Compare what was ASKED FOR against the chips Gmail actually created.
 *
 * `missing` is fatal — Gmail sends only to chipped recipients, so a missing chip
 * is a recipient who will not receive the mail. `extra` is reported but not
 * fatal: expanding a contact group into its members is a legitimate way for a
 * chip set to be larger than the request.
 */
export function diffRecipients(requested: string[], chips: string[]): RecipientDiff {
  const want = requested.map(normalizeAddress).filter(Boolean);
  const got = new Set(chips.map(normalizeAddress).filter(Boolean));
  const missing = want.filter((a) => !got.has(a));
  const wantSet = new Set(want);
  const extra = [...got].filter((a) => !wantSet.has(a));
  return { ok: missing.length === 0, missing, extra };
}

export type ReplyControl = 'reply' | 'reply all' | 'forward';

/**
 * Pick the reply/reply-all/forward control DETERMINISTICALLY.
 *
 * The bug this replaces: the old code matched the set {"reply","reply all"} and
 * clicked whichever the DOM yielded FIRST, so `reply` could open reply-all (and
 * mail everyone on the thread) purely by DOM order. Here the caller states which
 * control it wants and only an EXACT normalised label matches — "reply" never
 * matches "reply all", in either DOM order.
 *
 * @returns index into `labels`, or -1 when the wanted control is not present.
 */
export function pickReplyControl(labels: string[], want: ReplyControl): number {
  const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const accept: Record<ReplyControl, string[]> = {
    reply: ['reply'],
    'reply all': ['reply all', 'reply to all'],
    forward: ['forward'],
  };
  const wanted = accept[want];
  for (let i = 0; i < labels.length; i++) {
    if (wanted.includes(norm(labels[i]))) return i;
  }
  return -1;
}

export interface ReplyModeAssessment {
  ok: boolean;
  verified: boolean;
  mode: 'reply' | 'reply_all';
  reason?: string;
}

/**
 * Decide whether the editor that opened is the one that was ASKED for, from the
 * recipients it carries — not from the button we believe we clicked.
 *
 * `others` = thread participants minus self minus the message's sender: exactly
 * the people who receive a reply-all and do not receive a reply. That set is what
 * makes the two modes distinguishable.
 *
 * Two deliberate asymmetries:
 *  - `others` empty  -> the modes are IDENTICAL, so any editor is correct and the
 *    result is verified. (Every 1:1 thread lands here.)
 *  - no chip evidence at all -> unverifiable. Proceeding is refused for `reply`
 *    (the failure mode is mailing people who were not meant to be included — an
 *    unrecoverable disclosure) and allowed-but-unverified for `reply all` (the
 *    failure mode is reaching fewer people, which the user can repeat).
 */
export function assessReplyMode(args: {
  wantAll: boolean;
  sender: string | null;
  participants: string[];
  self: string | null;
  chips: string[];
}): ReplyModeAssessment {
  const mode: 'reply' | 'reply_all' = args.wantAll ? 'reply_all' : 'reply';
  const self = normalizeAddress(args.self || '');
  const sender = normalizeAddress(args.sender || '');
  const participants = args.participants.map(normalizeAddress).filter(Boolean);
  const others = [...new Set(participants)].filter((a) => a && a !== self && a !== sender);

  if (others.length === 0) {
    return { ok: true, verified: true, mode, reason: 'no_divergence' };
  }

  const chips = new Set(args.chips.map(normalizeAddress).filter(Boolean));
  if (chips.size === 0) {
    return args.wantAll
      ? { ok: true, verified: false, mode, reason: 'no_recipient_evidence' }
      : { ok: false, verified: false, mode, reason: 'no_recipient_evidence' };
  }

  const hasOthers = others.some((a) => chips.has(a));
  if (args.wantAll) {
    return hasOthers
      ? { ok: true, verified: true, mode, reason: 'others_present' }
      : { ok: false, verified: true, mode, reason: 'opened_reply_not_reply_all' };
  }
  return hasOthers
    ? { ok: false, verified: true, mode, reason: 'opened_reply_all_not_reply' }
    : { ok: true, verified: true, mode, reason: 'others_absent' };
}

/**
 * Build Gmail's compose-prefill URL.
 *
 * Each address is percent-encoded INDIVIDUALLY and joined with a literal comma,
 * which is what Gmail splits on: encoding the joined string would turn the
 * separator into `%2C` and produce one nonsense recipient. encodeURIComponent
 * escapes `@` -> `%40` and, critically, `+` -> `%2B`, so plus-addressing survives
 * (a raw `+` in a query string decodes as a SPACE and silently corrupts the
 * address).
 *
 * `body` is supported and tested but callers here leave it out: the body is
 * always built as DOM instead, so all three formats share one code path, there is
 * no URL length ceiling, and the character count can be read back for verification.
 */
export function buildComposeUrl(input: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  accountIndex?: number;
}): string {
  const parts: string[] = ['tf=cm'];
  const list = (key: string, vals?: string[]) => {
    const clean = (vals || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (clean.length) parts.push(`${key}=${clean.map(encodeURIComponent).join(',')}`);
  };
  list('to', input.to);
  list('cc', input.cc);
  list('bcc', input.bcc);
  if (input.subject) parts.push(`su=${encodeURIComponent(input.subject)}`);
  if (input.body) parts.push(`body=${encodeURIComponent(input.body)}`);
  return `${mailBase(input.accountIndex)}?${parts.join('&')}`;
}

/** Plain text -> the markdown module's node tree. No parsing: text stays literal. */
export function plainTextToNodes(text: string): MdNode[] {
  const blocks = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: MdNode[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const c: MdInline[] = [];
    lines.forEach((ln, i) => {
      if (i) c.push({ t: 'br' });
      if (ln) c.push({ t: 'text', v: ln });
    });
    out.push({ t: 'p', c });
  }
  return out.length ? out : [{ t: 'p', c: [] }];
}

export interface AttachmentPlan {
  files: Array<{ path: string; name: string; bytes: number }>;
  totalBytes: number;
}

/**
 * Resolve and bound the attachment set BEFORE any browser work.
 *
 * Refuses rather than trims. Dropping a file from a message that then sends is a
 * silent partial send — the caller believes the file went out and it did not — so
 * the cap reports every file, its size and the overage, and sends nothing.
 */
export function planAttachments(paths: string[] | undefined): AttachmentPlan {
  const list = (paths || []).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!list.length) return { files: [], totalBytes: 0 };

  if (list.length > MAX_ATTACHMENT_COUNT) {
    throw new GmComposeError(
      'ATTACHMENT_TOO_MANY',
      `${list.length} attachments requested; the cap is ${MAX_ATTACHMENT_COUNT}. Nothing was sent.`,
      { requested: list.length, cap: MAX_ATTACHMENT_COUNT },
    );
  }

  const files: AttachmentPlan['files'] = [];
  const missing: string[] = [];
  let totalBytes = 0;
  for (const p of list) {
    if (!p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) {
      throw new GmComposeError('ATTACHMENT_PATH_NOT_ABSOLUTE', `attachment path must be absolute: ${p}`, { path: p });
    }
    if (!existsSync(p)) {
      missing.push(p);
      continue;
    }
    const st = statSync(p);
    if (!st.isFile()) {
      throw new GmComposeError('ATTACHMENT_NOT_A_FILE', `attachment is not a regular file: ${p}`, { path: p });
    }
    totalBytes += st.size;
    files.push({ path: p, name: basename(p), bytes: st.size });
  }
  if (missing.length) {
    throw new GmComposeError('ATTACHMENT_NOT_FOUND', `attachment file(s) not found: ${missing.join(', ')}`, { missing });
  }
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new GmComposeError(
      'ATTACHMENT_TOO_LARGE',
      `attachments total ${totalBytes} bytes, over the ${MAX_ATTACHMENT_TOTAL_BYTES}-byte cap by ${
        totalBytes - MAX_ATTACHMENT_TOTAL_BYTES
      }. Nothing was sent. Files: ${files.map((f) => `${f.name}=${f.bytes}B`).join(', ')}`,
      { totalBytes, cap: MAX_ATTACHMENT_TOTAL_BYTES, files },
    );
  }
  return { files, totalBytes };
}


/* ------------------------------------------------------------------ *
 * Page-side helper library
 *
 * One string, prepended to every snippet. It defines the scope resolution that
 * everything else depends on, so there is exactly ONE definition of "the live
 * compose" in this module.
 * ------------------------------------------------------------------ */

/**
 * @internal Exported ONLY so the unit tests can run this exact source against a
 * fake DOM. Testing a copy of the scope/chip resolution would test the copy.
 */
/**
 * @internal Exported ONLY so ./selfcheck can probe the compose with the SAME
 * selectors the sender uses. A canary carrying its own copy would sail straight
 * through the __scope() bug it exists to catch.
 */
export const COMPOSE_SELECTORS = S;

export const JS_LIB = `
  const __vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const __all = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const __visAll = (sel, root) => __all(sel, root).filter(__vis);
  const __last = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const __norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const __label = (el) => __norm(el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.textContent || '');

  /**
   * The live compose container.
   *
   * Gmail keeps closed/minimised composes in the DOM and querySelector returns
   * the FIRST match, so anchoring on document is how text lands in an invisible
   * compose. Start from the LAST VISIBLE body and walk UP to the first ancestor
   * that also contains a VISIBLE Send button: that ancestor is the compose the
   * user is looking at. The walk uses no class names, so Gmail's hashed classes
   * cannot break it, and it works for the popup dialog AND the inline reply
   * editor (which is not a role=dialog at all).
   */
  const __scope = () => {
    // MEASURED: the previous ancestor-walk (last visible body -> up to 12 levels
    // for a visible Send button -> else body.parentElement) resolved a container
    // too narrow to hold the To field, so every send failed with
    // RECIPIENT_FIELD_UNAVAILABLE even with the dialog open.
    //
    // Resolve the way the confirmed end-to-end send did: prefer the LAST VISIBLE
    // dialog that actually contains a compose body, else the dialog ancestor of
    // the last visible body, else the document. "Last visible" is the part that
    // matters — it is what stops text landing in a minimised compose.
    const dlgs = __visAll('div[role="dialog"]');
    for (let i = dlgs.length - 1; i >= 0; i--) {
      if (__all(${q(S.body)}, dlgs[i]).length) return dlgs[i];
    }
    const body = __last(__visAll(${q(S.body)}));
    if (body) return body.closest('div[role="dialog"]') || document;
    return __last(dlgs) || document;
  };

  /*
   * MEASURED 2026-07-30, live: this was \`__last(__visAll(<comma-list>))\`, and a
   * comma-list resolves in DOCUMENT order rather than selector order. Gmail
   * renders a Gemini "Describe your message" prompt (a contenteditable
   * role=textbox, ~28px tall) BELOW the compose, so "last visible" selected the
   * AI prompt: the body was written into it, and readBodyText() — using this very
   * same resolver — read it straight back and pronounced the body good. Messages
   * went out EMPTY with verified: true.
   *
   * So walk the tiers ONE SELECTOR AT A TIME. Scope first, because that is the
   * compose whose Send button will be clicked; an earlier revision resolved the
   * body document-wide and could fill a different compose than the one being
   * sent. Then document-wide, so a drifted scope still cannot leave us empty.
   */
  const __bodyTiers = [${q(S.bodyPrimary)}, ${q(S.bodyEditable)}];
  const __bodyEl = () => {
    const sc = __scope();
    const roots = sc && sc !== document ? [sc, document] : [document];
    for (const root of roots) {
      for (const t of __bodyTiers) {
        const hits = __visAll(t, root);
        if (hits.length) return __last(hits);
      }
      // Reachable only if Gmail renamed BOTH canonical markers. Height-guarded: a
      // compose body is ~360px tall and the AI prompt ~28px, so a short editable
      // box is never the thing we mean.
      const loose = __visAll(${q(S.bodyLoose)}, root).filter((e) => e.getBoundingClientRect().height >= 80);
      if (loose.length) return __last(loose);
    }
    return null;
  };

  /** Recipient input for one field, matched on the FIRST WORD of its label. */
  const __fieldInput = (sc, kind) => {
    if (!sc) return null;
    const ins = __all(${q(S.recipientInput)}, sc);
    for (const el of ins) {
      const nm = String(el.getAttribute('name') || '').toLowerCase();
      const al = __norm(el.getAttribute('aria-label')).toLowerCase();
      const tag = nm || al.split(' ')[0];
      if (tag === kind) return el;
    }
    return null;
  };

  /** Addresses out of any chip subtree. */
  const __chipsIn = (root) => {
    if (!root) return [];
    const out = __all(${q(S.chip)}, root)
      .map((e) => e.getAttribute('data-hovercard-id') || e.getAttribute('email') || '')
      .filter((v) => v && v.indexOf('@') > 0);
    return Array.from(new Set(out));
  };

  /**
   * Chips belonging to ONE field.
   *
   * Walk up from that field's input to the tightest ancestor holding chips,
   * stopping before an ancestor that swallows another field's input — otherwise
   * To's chips would be counted as Bcc's and a missing Bcc chip would read as
   * present. A false "scoped" means the field's input was not found at all,
   * which is a different failure from "the field is empty" — do not conflate them.
   */
  const __fieldChips = (sc, kind) => {
    const input = __fieldInput(sc, kind);
    if (!input) return { scoped: false, chips: [] };
    const others = ${q(RECIPIENT_KINDS)}.filter((k) => k !== kind).map((k) => __fieldInput(sc, k)).filter(Boolean);
    let n = input;
    for (let i = 0; i < 8 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      if (others.some((o) => n.contains(o))) break;
      const chips = __chipsIn(n);
      if (chips.length) return { scoped: true, chips };
    }
    return { scoped: true, chips: [] };
  };

  /** Set an input's value the only way that works on these widgets. */
  const __setValue = (el, v) => {
    const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const __click = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { void e; }
    el.click();
    return true;
  };
`;

/* ------------------------------------------------------------------ *
 * Evaluation plumbing
 * ------------------------------------------------------------------ */

type PageOk<T> = { ok: true } & T;
type PageFail = { ok: false; code: string; message: string };

/**
 * Wrap a snippet body so a page-side throw becomes a STRUCTURED result.
 *
 * Requirement: nothing throws inside the page. A raw page exception surfaces as
 * an opaque transport-shaped error ("PAGE_EVAL_ERROR: TypeError…") that reads
 * like the connector is broken when the real cause is a missing element.
 */
function page(body: string): string {
  return `${JS_LIB}
  try {
    ${body}
  } catch (e) {
    return { ok: false, code: 'PAGE_ERROR', message: String((e && e.message) || e) };
  }`;
}

/** Run a snippet and unwrap it, converting `{ok:false}` into a coded error. */
async function evalPage<T extends object>(ctx: ComposeCtx, body: string): Promise<T> {
  const r = (await ctx.evaluate<PageOk<T> | PageFail | null | undefined>(page(body))) as
    | PageOk<T>
    | PageFail
    | null
    | undefined;
  if (!r) throw new GmComposeError('PAGE_NO_RESULT', 'the page returned nothing (the execution context may have been replaced)');
  if (r.ok === false) throw new GmComposeError(r.code || 'PAGE_ERROR', r.message || 'page error');
  const { ok: _ok, ...rest } = r as PageOk<T> & { ok: true };
  void _ok;
  return rest as unknown as T;
}

/** Poll a snippet that returns `{ok:true, hit:boolean}` until hit or deadline. */
async function waitFor(ctx: ComposeCtx, body: string, timeoutMs: number, intervalMs = 400): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await evalPage<{ hit: boolean }>(ctx, body);
      if (r.hit) return true;
    } catch {
      /* transient: a navigation can replace the context mid-poll */
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * Preconditions
 * ------------------------------------------------------------------ */

/**
 * Cheap desktop-UI precondition.
 *
 * MEASURED: a 390x844 mobile viewport does NOT flip Gmail's UI (it clamps to
 * 980px and the desktop selectors keep working), so this deliberately does not
 * branch on viewport. What it does is refuse EARLY if the page is not the
 * desktop mail app at all — an alternate UI (basic HTML, a sign-in interstitial,
 * a different product) otherwise presents as "no fields found" halfway through a
 * compose, which is indistinguishable from a selector regression.
 */
async function assertDesktopMailUi(ctx: ComposeCtx): Promise<void> {
  const r = await evalPage<{ mail: boolean; app: boolean; signin: boolean; url: string }>(
    ctx,
    `const mail = /(^|\\.)mail\\.google\\.com$/.test(location.hostname);
     const signin = /signin|ServiceLogin|AccountChooser/i.test(location.href);
     const app = !!document.querySelector('div[role="main"], tr.zA, input[name="q"], div[role="dialog"]');
     return { ok: true, mail, app, signin, url: location.href };`,
  );
  if (!r.mail || r.signin) {
    throw new GmComposeError('NOT_LOGGED_IN', `the driver browser is not on a logged-in Gmail page (${r.url})`);
  }
  if (!r.app) {
    throw new GmComposeError(
      'UNEXPECTED_UI',
      `mail.google.com is loaded but none of the desktop mail app landmarks are present (${r.url}) — refusing to compose against an unrecognised UI`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

/**
 * Route the SPA by hash. Gmail ignores a hash write that does not change the
 * value, so re-entering the same view is done via a throwaway hash first —
 * otherwise a repeated call silently returns the PREVIOUS render.
 */
/**
 * Does this hash address ONE record (a thread or draft) rather than a list?
 *
 * MEASURED 2026-07-30: a hash-only navigation does NOT re-route Gmail to another
 * conversation. Both \`location.hash = …\` and a hash-only Page.navigate leave the
 * PREVIOUS thread rendered while the URL reads exactly as asked — so the caller
 * sees the id it requested and the wrong mail on screen, which is why read_thread
 * returned wrong threads instead of failing. Only a real document load routes it.
 * List hashes are unaffected and keep the cheap path.
 *
 * \`search\` is excluded because its segment is a QUERY, not an id, and the length
 * floor keeps short non-record segments (e.g. #settings/accounts) on the fast path.
 */
function isRecordHash(hash: string): boolean {
  const m = /^#([^/]+)\/([^/?#]+)$/.exec(hash);
  return !!m && m[1].toLowerCase() !== 'search' && m[2].length >= 10;
}

/**
 * Does moving to `hash` need a REAL document load?
 *
 * Originally only record hashes did, and list hashes kept the cheap
 * `location.hash =` path for speed. That fast path has now produced silent WRONG
 * DATA twice: `#all/<id>` left the previous conversation rendered, and
 * MEASURED 2026-07-31 `#drafts` left the INBOX rendered, so listDrafts returned
 * inbox threads labelled as drafts — a wrong answer that looks exactly like a
 * right one.
 *
 * The hash always updates, so it is never evidence the view moved. Rather than
 * keep guessing which hashes are safe, any hash CHANGE needs a real load; only
 * re-entering the hash already displayed keeps the cheap path. Costs a reload on
 * view switches, which is not in a hot loop, and buys the property that a
 * navigation either lands or fails loudly.
 */
function needsRealLoad(target: string, current: string): boolean {
  if (isRecordHash(target)) return true;
  return String(current || '').trim() !== String(target || '').trim();
}

async function gotoHash(ctx: ComposeCtx, hash: string, readySel: string, timeoutMs = 15000): Promise<void> {
  const onMail = await evalPage<{ hit: boolean; hash?: string }>(
    ctx,
    `return { ok: true, hit: /(^|\\.)mail\\.google\\.com$/.test(location.hostname), hash: location.hash };`,
  ).catch(() => ({ hit: false, hash: '' }));
  const curHash = String((onMail as { hash?: string }).hash || '');

  if (!onMail.hit) {
    await ctx.navigate(mailBase() + hash);
    await sleep(2500);
  } else if (needsRealLoad(hash, curHash)) {
    // A record hash only routes on a real document load — see isRecordHash.
    await evalPage(ctx, `location.hash = ${q(hash)}; return { ok: true };`).catch(() => undefined);
    await sleep(300);
    await evalPage(ctx, 'location.reload(); return { ok: true };').catch(() => undefined);
    await sleep(3200);
  } else {
    await evalPage(
      ctx,
      `if (location.hash === ${q(hash)}) { location.hash = '#__reroute'; await new Promise((r) => setTimeout(r, 150)); }
       location.hash = ${q(hash)};
       return { ok: true };`,
    );
    await sleep(1200);
  }
  const ready = await waitFor(ctx, `return { ok: true, hit: !!document.querySelector(${q(readySel)}) };`, timeoutMs);
  if (!ready) throw new GmComposeError('PAGE_NOT_READY', `timed out waiting for ${hash} to render (${readySel})`);
  await sleep(600);
}

/** Wait until a live compose surface exists (body + Send button in one scope). */
async function waitForCompose(ctx: ComposeCtx, timeoutMs = T.composeOpen): Promise<void> {
  const ok = await waitFor(
    ctx,
    `const sc = __scope();
     return { ok: true, hit: !!sc && !!__bodyEl() && __all(${q(S.send)}, sc).some(__vis) };`,
    timeoutMs,
  );
  if (!ok) throw new GmComposeError('COMPOSE_NOT_READY', 'the compose editor did not open (no visible body + Send button)');
}

/* ------------------------------------------------------------------ *
 * Recipients
 * ------------------------------------------------------------------ */

/** Read the chips Gmail currently holds for one field. */
async function readFieldChips(ctx: ComposeCtx, kind: RecipientKind): Promise<{ scoped: boolean; chips: string[] }> {
  return evalPage<{ scoped: boolean; chips: string[] }>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     const r = __fieldChips(sc, ${q(kind)});
     return { ok: true, scoped: r.scoped, chips: r.chips };`,
  );
}

/**
 * Reveal Cc/Bcc.
 *
 * MEASURED: the toggles are role="link" with the exact text "Cc"/"Bcc" — NOT
 * role="button", which is why a button-only query found nothing. There are two
 * matches for each inside a live dialog, so take the LAST VISIBLE one, the same
 * rule the stale-compose problem forces everywhere else.
 */
async function openRecipientField(ctx: ComposeCtx, kind: RecipientKind): Promise<boolean> {
  if (kind === 'to') return true;
  const r = await evalPage<{ opened: boolean; clicked: boolean }>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     if (__fieldInput(sc, ${q(kind)})) return { ok: true, opened: true, clicked: false };
     const want = ${q(kind === 'cc' ? 'cc' : 'bcc')};
     const link = __last(__visAll(${q(S.recipientToggle)}, sc).filter((e) => __norm(e.textContent).toLowerCase() === want));
     if (!link) return { ok: true, opened: false, clicked: false };
     __click(link);
     await new Promise((r) => setTimeout(r, 500));
     return { ok: true, opened: !!__fieldInput(sc, ${q(kind)}), clicked: true };`,
  );
  return r.opened;
}

/**
 * Make Gmail hold a CHIP for every requested address on one field.
 *
 * Chips are the whole game: Gmail sends only to chipped recipients, so a filled
 * To box with no chip sends to nobody. Prefill normally produces them, so this
 * runs first as a VERIFIER and only types the addresses prefill did not deliver.
 * The write itself is the native value setter (nothing else lands), then Enter +
 * a real blur() to commit, then a re-read to confirm.
 */
async function ensureRecipients(ctx: ComposeCtx, kind: RecipientKind, addrs: string[]): Promise<string[]> {
  const want = addrs.map((a) => String(a ?? '').trim()).filter(Boolean);
  if (!want.length) return [];

  let state = await readFieldChips(ctx, kind);
  if (!state.scoped) {
    const opened = await openRecipientField(ctx, kind);
    if (!opened) {
      throw new GmComposeError(
        'RECIPIENT_FIELD_UNAVAILABLE',
        `could not reveal the ${kind.toUpperCase()} field (its role="link" toggle was not found in the live compose)`,
        { kind },
      );
    }
    state = await readFieldChips(ctx, kind);
  }

  let diff = diffRecipients(want, state.chips);
  if (!diff.ok) {
    const r = await evalPage<{ typed: boolean; chips: string[] }>(
      ctx,
      `const sc = __scope();
       if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
       const el = __fieldInput(sc, ${q(kind)});
       if (!el) return { ok: false, code: 'RECIPIENT_FIELD_UNAVAILABLE', message: 'no ${kind} input in the live compose' };
       __setValue(el, ${q(diff.missing.join(', '))});
       await new Promise((r) => setTimeout(r, 350));
       for (const type of ['keydown', 'keypress', 'keyup']) {
         el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
       }
       await new Promise((r) => setTimeout(r, ${T.chipCommit}));
       try { el.blur(); } catch (e) { void e; }
       el.dispatchEvent(new Event('blur', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       await new Promise((r) => setTimeout(r, ${T.chipCommit}));
       return { ok: true, typed: true, chips: __fieldChips(sc, ${q(kind)}).chips };`,
    );
    diff = diffRecipients(want, r.chips);
    state = { scoped: true, chips: r.chips };
  }

  if (!diff.ok) {
    throw new GmComposeError(
      'RECIPIENT_NOT_ACCEPTED',
      `Gmail created no ${kind.toUpperCase()} chip for: ${diff.missing.join(', ')} — it will not deliver to an unchipped address, so nothing was sent.`,
      { kind, missing: diff.missing, chips: state.chips },
    );
  }
  return state.chips;
}


/* ------------------------------------------------------------------ *
 * Subject
 * ------------------------------------------------------------------ */

async function setSubject(ctx: ComposeCtx, subject: string): Promise<string> {
  const r = await evalPage<{ value: string }>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     const el = __last(__visAll(${q(S.subject)}, sc)) || __last(__visAll(${q(S.subject)}));
     if (!el) return { ok: false, code: 'SUBJECT_FIELD_NOT_FOUND', message: 'no subject field in the live compose' };
     if (__norm(el.value) !== __norm(${q(subject)})) {
       __setValue(el, ${q(subject)});
       await new Promise((r) => setTimeout(r, 200));
     }
     return { ok: true, value: el.value || '' };`,
  );
  return r.value;
}

/* ------------------------------------------------------------------ *
 * Body
 * ------------------------------------------------------------------ */

export interface BodyStats {
  ok: boolean;
  reason?: string;
  blocks: number;
  links: number;
  lists: number;
  bolds: number;
  chars: number;
}

/**
 * HTML -> DOM, without an HTML sink.
 *
 * `innerHTML` is REJECTED by Gmail's Trusted Types policy and the throw leaves
 * the body EMPTY — the exact path that once sent a real empty email. DOMParser
 * is NOT a Trusted Types sink (it parses inert and runs nothing), so the markup
 * is parsed there and rebuilt node by node through an allowlist. That is both TT-
 * safe and sanitising: script/style/iframe/object/embed and every attribute
 * except a scheme-checked href never reach the compose.
 */
function htmlBodyScript(html: string): string {
  return `const el = __bodyEl();
     if (!el) return { ok: false, code: 'BODY_NOT_FOUND', message: 'no live compose body' };
     const TAGS = ['B','STRONG','I','EM','U','A','UL','OL','LI','BLOCKQUOTE','P','BR','DIV','SPAN','H1','H2','H3','H4','PRE','CODE','HR','TABLE','THEAD','TBODY','TR','TD','TH'];
     const DROP = ['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META','FORM','INPUT','BUTTON','SVG','MATH','NOSCRIPT','TEMPLATE'];
     const OKS = ['http:', 'https:', 'mailto:'];
     const stats = { chars: 0, dropped: 0, links: 0 };
     const safeHref = (h) => {
       const t = String(h == null ? '' : h).trim().replace(/[\\u0000-\\u001f\\u007f]/g, '');
       const ci = t.indexOf(':');
       if (ci < 1) return null;
       return OKS.indexOf(t.slice(0, ci + 1).toLowerCase()) >= 0 ? t : null;
     };
     const conv = (src, dst) => {
       for (const n of Array.prototype.slice.call(src.childNodes)) {
         if (n.nodeType === 3) {
           const v = n.nodeValue || '';
           stats.chars += v.length;
           dst.appendChild(document.createTextNode(v));
           continue;
         }
         if (n.nodeType !== 1) continue;
         const tag = n.tagName.toUpperCase();
         if (DROP.indexOf(tag) >= 0) { stats.dropped++; continue; }
         if (TAGS.indexOf(tag) < 0) { stats.dropped++; conv(n, dst); continue; }
         const e = document.createElement(tag.toLowerCase());
         if (tag === 'A') {
           const href = safeHref(n.getAttribute('href'));
           if (href) { e.setAttribute('href', href); stats.links++; }
         }
         conv(n, e);
         dst.appendChild(e);
       }
     };
     const doc = new DOMParser().parseFromString(${q(html)}, 'text/html');
     const frag = document.createDocumentFragment();
     conv(doc.body, frag);
     try { el.focus(); } catch (e) { void e; }
     el.replaceChildren();
     el.appendChild(frag);
     el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
     return { ok: true, stats: { ok: stats.chars > 0, blocks: 1, links: stats.links, lists: 0, bolds: 0, chars: stats.chars, dropped: stats.dropped } };`;
}

/**
 * Render the body for any format and report what actually landed.
 *
 * markdown and text share markdown.ts's emitter (text is turned into a literal
 * node tree, never parsed), so the vetted Trusted-Types-safe builder is the only
 * thing that writes a body here. Its `targetExpr` is pointed at __bodyEl() rather
 * than its default selector list, because that default is a bare
 * document.querySelector and would happily fill a STALE hidden compose.
 */
async function renderBody(ctx: ComposeCtx, body: string, format: MailFormat): Promise<BodyStats> {
  if (format === 'html') {
    const r = await evalPage<{ stats: BodyStats }>(ctx, htmlBodyScript(body));
    return r.stats;
  }
  const nodes = format === 'markdown' ? parseMarkdown(body) : plainTextToNodes(body);
  const script = buildDomScript(nodes, { targetExpr: '__bodyEl()' });
  const r = await evalPage<{ stats: BodyStats }>(
    ctx,
    `const stats = ${script};
     return { ok: true, stats };`,
  );
  return r.stats;
}

/** Read back what the body actually contains — the only trustworthy check. */
async function readBodyText(ctx: ComposeCtx): Promise<string> {
  const r = await evalPage<{ text: string }>(
    ctx,
    `const el = __bodyEl();
     return { ok: true, text: el ? String(el.innerText || '').trim() : '' };`,
  );
  return r.text;
}

async function applyBody(ctx: ComposeCtx, body: string, format: MailFormat): Promise<BodyStats> {
  const stats = await renderBody(ctx, body, format);
  if (!body.trim()) return stats;
  if (!stats.ok || stats.chars === 0) {
    throw new GmComposeError(
      'BODY_NOT_SET',
      `the ${format} body produced nothing in the compose (${stats.reason || 'no characters written'}) — refusing to send an empty message`,
      { stats },
    );
  }
  await sleep(250);
  const text = await readBodyText(ctx);
  if (!text) {
    throw new GmComposeError('BODY_NOT_SET', 'the body read back EMPTY after rendering — refusing to send an empty message', { stats });
  }
  return stats;
}

/* ------------------------------------------------------------------ *
 * Send-as alias
 * ------------------------------------------------------------------ */

/**
 * Switch the From identity.
 *
 * MEASURED: enumerating the live dialog for a From control returned an EMPTY
 * list on the driver account — either it has no send-as aliases, or the control
 * renders only when aliases exist. So this is best-effort in DISCOVERY and strict
 * in OUTCOME: if no From control can be found, or the alias is not among its
 * options, it refuses. Sending from the wrong identity is the bad outcome, and it
 * is invisible to the caller after the fact.
 */
async function applyFromAlias(ctx: ComposeCtx, alias: string): Promise<void> {
  const want = normalizeAddress(alias);
  const r = await evalPage<{ applied: boolean; how: string; current: string; options: string[] }>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     const want = ${q(want)};
     const hasAddr = (s) => __norm(s).toLowerCase().indexOf(want) >= 0;

     // Shape 1: a real <select> of send-as addresses.
     const sel = __all('select', sc).find((s) => __all('option', s).some((o) => hasAddr(o.textContent) || hasAddr(o.value)));
     if (sel) {
       const opt = __all('option', sel).find((o) => hasAddr(o.textContent) || hasAddr(o.value));
       const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
       set.call(sel, opt.value);
       sel.dispatchEvent(new Event('change', { bubbles: true }));
       await new Promise((r) => setTimeout(r, 400));
       return { ok: true, applied: hasAddr(sel.value) || hasAddr(opt.textContent), how: 'select', current: String(sel.value || ''), options: [] };
     }

     // Shape 2: a From row that opens a menu.
     const rows = __visAll('[role="button"], [role="link"], [role="combobox"]', sc)
       .filter((e) => /@/.test(__norm(e.textContent)) && __norm(e.textContent).length < 200);
     if (!rows.length) return { ok: true, applied: false, how: 'none', current: '', options: [] };
     __click(__last(rows));
     await new Promise((r) => setTimeout(r, 600));
     const items = __visAll('[role="menuitem"], [role="option"]').filter((e) => /@/.test(__norm(e.textContent)));
     const options = items.map((e) => __norm(e.textContent));
     const hit = items.find((e) => hasAddr(e.textContent));
     if (!hit) {
       document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
       return { ok: true, applied: false, how: 'menu', current: __norm(__last(rows).textContent), options };
     }
     __click(hit);
     await new Promise((r) => setTimeout(r, 600));
     const after = __visAll('[role="button"], [role="link"], [role="combobox"]', __scope() || sc)
       .filter((e) => /@/.test(__norm(e.textContent)) && __norm(e.textContent).length < 200);
     const current = after.length ? __norm(__last(after).textContent) : '';
     return { ok: true, applied: hasAddr(current), how: 'menu', current, options };`,
  );

  if (!r.applied) {
    if (r.how === 'none') {
      throw new GmComposeError(
        'ALIAS_CONTROL_UNAVAILABLE',
        `no send-as alias control is available on this account, so "${alias}" cannot be selected — refusing to send from the default address instead.`,
        { alias },
      );
    }
    throw new GmComposeError(
      'ALIAS_NOT_APPLIED',
      `the From identity did not switch to "${alias}" (still "${r.current || 'unknown'}") — refusing to send from the wrong address.`,
      { alias, current: r.current, options: r.options },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/**
 * Hand file paths to the compose's file input.
 *
 * DOM.setFileInputFiles is the only route: the widget is an
 * `input[type=file][name=Filedata][multiple]` (VERIFIED, exactly one per dialog)
 * that no page JS can populate, and clicking "Attach files" would open a native
 * picker no protocol can drive. Blink's handler (InspectorDOMAgent::
 * setFileInputFiles) requires the node to BE a file input and resolves it from a
 * nodeId/backendNodeId/objectId, so the element is fetched as a live objectId
 * rather than by value.
 *
 * The paths are resolved by the BROWSER process. When Chrome runs on another host
 * or in a container, a path that exists here does not exist there — that shows up
 * as an upload that never produces a chip, and waitForAttachments says so.
 */
async function attachFiles(ctx: ComposeCtx, files: AttachmentPlan['files']): Promise<void> {
  await ctx.send('DOM.enable').catch(() => undefined);

  const res = (await ctx.send('Runtime.evaluate', {
    expression: `(function(){${JS_LIB}
      const sc = __scope();
      if (!sc) return null;
      const ins = __all(${q(S.fileInput)}, sc);
      return ins.length ? ins[0] : null;
    })()`,
    returnByValue: false,
  })) as { result?: { objectId?: string; subtype?: string }; exceptionDetails?: unknown };

  if (res.exceptionDetails) {
    throw new GmComposeError('ATTACH_INPUT_LOOKUP_FAILED', 'failed to locate the compose file input in the page');
  }
  const objectId = res.result?.objectId;
  if (!objectId || res.result?.subtype === 'null') {
    throw new GmComposeError(
      'ATTACH_INPUT_NOT_FOUND',
      'no input[type=file] inside the live compose — cannot attach without one',
    );
  }

  try {
    await ctx.send('DOM.setFileInputFiles', { files: files.map((f) => f.path), objectId });
  } catch (e) {
    throw new GmComposeError(
      'ATTACH_SET_FILES_FAILED',
      `DOM.setFileInputFiles rejected the upload: ${e instanceof Error ? e.message : String(e)}. Paths must exist on the machine running CHROME.`,
      { files: files.map((f) => f.path) },
    );
  } finally {
    await ctx.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

export interface AttachmentState {
  seen: string[];
  pending: string[];
  uploading: boolean;
}

/** What the compose visibly holds right now, per requested filename. */
async function readAttachmentState(ctx: ComposeCtx, names: string[]): Promise<AttachmentState> {
  return evalPage<AttachmentState>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     const text = __norm(sc.innerText || '');
     const names = ${q(names)};
     const seen = names.filter((n) => text.indexOf(n) >= 0);
     const pending = names.filter((n) => text.indexOf(n) < 0);
     const bars = __all('[role="progressbar"], progress', sc).filter(__vis).length > 0;
     const words = /uploading|\\b\\d{1,3}\\s?%/i.test(text);
     return { ok: true, seen, pending, uploading: bars || words };`,
  );
}

/**
 * Block until every attachment is really attached.
 *
 * Clicking Send mid-upload DROPS the file — the message goes out without it and
 * nothing reports a problem — so this is a hard gate, not a courtesy wait. Two
 * conditions must hold together, and hold TWICE in a row: every requested
 * filename is rendered in the compose, and no progress indicator remains. The
 * stability re-check exists because the filename chip appears at upload START,
 * so "name present" alone is satisfied while bytes are still moving.
 *
 * If nothing at all appears, the change event may not have reached Gmail; a
 * single synthetic `change` is dispatched once as a fallback. It cannot
 * double-attach, because it only runs when no attachment materialised.
 */
async function waitForAttachments(ctx: ComposeCtx, names: string[], timeoutMs = T.upload): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let nudged = false;
  let last: AttachmentState = { seen: [], pending: names, uploading: false };

  for (;;) {
    try {
      last = await readAttachmentState(ctx, names);
      if (last.pending.length === 0 && !last.uploading) {
        if (++stable >= 2) return;
      } else {
        stable = 0;
      }
      if (!nudged && last.seen.length === 0 && Date.now() - (deadline - timeoutMs) > 8000) {
        nudged = true;
        await evalPage(
          ctx,
          `const sc = __scope();
           const el = sc ? __all(${q(S.fileInput)}, sc)[0] : null;
           if (el && el.files && el.files.length) el.dispatchEvent(new Event('change', { bubbles: true }));
           return { ok: true };`,
        ).catch(() => undefined);
      }
    } catch {
      /* transient */
    }
    if (Date.now() >= deadline) break;
    await sleep(1000);
  }

  throw new GmComposeError(
    'ATTACHMENT_UPLOAD_TIMEOUT',
    `attachment upload did not finish in ${Math.round(timeoutMs / 1000)}s (missing: ${
      last.pending.join(', ') || 'none'
    }${last.uploading ? '; still uploading' : ''}). Nothing was sent. If the paths are correct here, check that they exist on the machine running Chrome.`,
    { pending: last.pending, seen: last.seen, uploading: last.uploading },
  );
}


/* ------------------------------------------------------------------ *
 * The pre-send gate
 * ------------------------------------------------------------------ */

interface PreflightWant {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  body?: string;
  attachments?: string[];
}

/**
 * Re-read the compose from the page and refuse unless it matches the request.
 *
 * Deliberately independent of the fill step: every earlier check reports what a
 * write RETURNED, and this one reports what the compose CONTAINS moments before
 * Send. A field that was chipped and then silently dropped by a re-render, an
 * attachment that vanished, a body cleared by Gmail's own autosave — none of
 * those are visible to the writer that wrote them.
 */
async function preflight(ctx: ComposeCtx, want: PreflightWant): Promise<string[]> {
  const notes: string[] = [];

  for (const kind of RECIPIENT_KINDS) {
    const asked = want[kind] || [];
    if (!asked.length) continue;
    const state = await readFieldChips(ctx, kind);
    if (!state.scoped) {
      throw new GmComposeError(
        'PREFLIGHT_FIELD_MISSING',
        `the ${kind.toUpperCase()} field is gone from the compose at send time — nothing was sent`,
        { kind },
      );
    }
    const diff = diffRecipients(asked, state.chips);
    if (!diff.ok) {
      throw new GmComposeError(
        'PREFLIGHT_RECIPIENT_MISSING',
        `no ${kind.toUpperCase()} chip for ${diff.missing.join(', ')} at send time — Gmail would not deliver to them, so nothing was sent`,
        { kind, missing: diff.missing, chips: state.chips },
      );
    }
    if (diff.extra.length) notes.push(`${kind}: Gmail also chipped ${diff.extra.join(', ')}`);
  }

  if (want.body && want.body.trim()) {
    const text = await readBodyText(ctx);
    if (!text) {
      throw new GmComposeError('PREFLIGHT_BODY_EMPTY', 'the compose body is EMPTY at send time — nothing was sent');
    }
  }

  if (want.attachments && want.attachments.length) {
    const state = await readAttachmentState(ctx, want.attachments);
    if (state.pending.length || state.uploading) {
      throw new GmComposeError(
        'PREFLIGHT_ATTACHMENT_MISSING',
        `attachment(s) not attached at send time: ${state.pending.join(', ') || '(still uploading)'} — nothing was sent`,
        { pending: state.pending, uploading: state.uploading },
      );
    }
  }

  return notes;
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

/** Click Send inside the LIVE compose and confirm Gmail accepted it. */
async function clickSendAndConfirm(ctx: ComposeCtx): Promise<void> {
  await evalPage(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     const btn = __last(__visAll(${q(S.send)}, sc));
     if (!btn) return { ok: false, code: 'SEND_BUTTON_NOT_FOUND', message: 'no visible Send button in the live compose' };
     if (btn.getAttribute('aria-disabled') === 'true') {
       return { ok: false, code: 'SEND_DISABLED', message: 'the Send button is disabled (Gmail is still busy)' };
     }
     __click(btn);
     return { ok: true };`,
  );

  // MEASURED: the post-send toast reads "Message sent Undo View message". Either
  // that toast or the compose disappearing is acceptance; requiring both would
  // fail on the inline reply editor, which can close before the toast paints.
  const confirmed = await waitFor(
    ctx,
    `const gone = !__bodyEl();
     const toast = __visAll(${q(S.toast)}).some((e) => /message sent|sending/i.test(__norm(e.textContent)));
     return { ok: true, hit: gone || toast };`,
    T.sendConfirm,
  );
  if (!confirmed) {
    throw new GmComposeError(
      'SEND_UNCONFIRMED',
      'clicked Send but neither the "Message sent" toast nor the compose closing was observed — the message MAY have been sent; check Sent before retrying',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Thread reading (for reply/forward)
 * ------------------------------------------------------------------ */

interface ThreadParties {
  self: string | null;
  sender: string | null;
  participants: string[];
}

async function readThreadParties(ctx: ComposeCtx): Promise<ThreadParties> {
  return evalPage<ThreadParties>(
    ctx,
    `let self = null;
     try { const g = window.GLOBALS && window.GLOBALS[10]; if (g && /@/.test(String(g))) self = String(g); } catch (e) { void e; }
     const msgs = __visAll('.adn.ads');
     const last = msgs.length ? msgs[msgs.length - 1] : null;
     const senderEl = last ? last.querySelector('.gD[email], span[email]') : null;
     const sender = senderEl ? senderEl.getAttribute('email') : null;
     const seen = [];
     for (const m of msgs) {
       for (const e of __all('[email], [data-hovercard-id]', m)) {
         const v = e.getAttribute('email') || e.getAttribute('data-hovercard-id') || '';
         if (v && v.indexOf('@') > 0 && seen.indexOf(v) < 0) seen.push(v);
       }
     }
     return { ok: true, self, sender, participants: seen };`,
  );
}

const REPLY_LABELS = ['reply', 'reply all', 'reply to all', 'forward'];

/** Enumerate the reply/forward controls the thread currently offers. */
async function readReplyControls(ctx: ComposeCtx): Promise<string[]> {
  const r = await evalPage<{ labels: string[] }>(
    ctx,
    `const want = ${q(REPLY_LABELS)};
     const els = __visAll('[role="button"], [role="link"], button');
     const labels = els.map(__label).map((s) => s.toLowerCase());
     return { ok: true, labels: labels.filter((l) => want.indexOf(l) >= 0) };`,
  );
  return r.labels;
}

/**
 * Click one reply/forward control by INDEX into the same filtered list, and
 * report the label actually clicked.
 *
 * The index is resolved page-side from an identical re-enumeration, and the label
 * comes back so the caller can confirm the DOM did not reshuffle between the read
 * and the click — the selection rule itself lives in pickReplyControl(), in
 * TypeScript, where it is unit-tested.
 */
async function clickReplyControl(ctx: ComposeCtx, index: number): Promise<string> {
  const r = await evalPage<{ clicked: string | null }>(
    ctx,
    `const want = ${q(REPLY_LABELS)};
     const els = __visAll('[role="button"], [role="link"], button').filter((e) => want.indexOf(__label(e).toLowerCase()) >= 0);
     const el = els[${index}];
     if (!el) return { ok: false, code: 'REPLY_CONTROL_GONE', message: 'the reply controls changed between selection and click' };
     const label = __label(el).toLowerCase();
     __click(el);
     return { ok: true, clicked: label };`,
  );
  return r.clicked || '';
}

/** Chips currently in the open reply/forward editor, any field. */
async function readComposeChips(ctx: ComposeCtx): Promise<string[]> {
  const r = await evalPage<{ chips: string[] }>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: true, chips: [] };
     return { ok: true, chips: __chipsIn(sc) };`,
  );
  return r.chips;
}

/**
 * Open the reply/forward editor for the mode the caller asked for.
 *
 * Selection is by exact label — "reply" can never match "reply all" — and the
 * result is then VERIFIED against the recipients the editor carries, because the
 * button that was clicked is not evidence of the editor that opened.
 */
async function openReplyEditor(
  ctx: ComposeCtx,
  which: ReplyControl,
): Promise<{ clicked: string; parties: ThreadParties; degraded: boolean }> {
  const parties = await readThreadParties(ctx);
  const labels = await readReplyControls(ctx);
  let index = pickReplyControl(labels, which);
  let degraded = false;

  if (index < 0 && which === 'reply all') {
    // A thread with a single participant offers no Reply-all control at all.
    index = pickReplyControl(labels, 'reply');
    if (index < 0) {
      throw new GmComposeError('REPLY_CONTROL_NOT_FOUND', `no Reply or Reply-all control on this thread (saw: ${labels.join(', ') || 'none'})`);
    }
    degraded = true;
  }
  if (index < 0) {
    throw new GmComposeError('REPLY_CONTROL_NOT_FOUND', `no "${which}" control on this thread (saw: ${labels.join(', ') || 'none'})`);
  }

  const clicked = await clickReplyControl(ctx, index);
  await waitForCompose(ctx);
  return { clicked, parties, degraded };
}

/* ------------------------------------------------------------------ *
 * Compose entry points
 * ------------------------------------------------------------------ */

/**
 * Open a prefilled compose.
 *
 * URL prefill is the primary path because it produces COMMITTED recipient chips
 * with no typing, and typing is measurably broken on these widgets. If the SPA
 * does not present a compose (an interstitial, a slow cold load), it falls back
 * to clicking Compose and letting ensureRecipients() do the work — the same code
 * forward has to use anyway, since there is no prefill URL for a forward.
 */
/**
 * Make sure the driver is on the Gmail APP view before composing. A previous
 * failed operation can leave the tab on a non-app URL, after which every
 * landmark check fails; re-entering #inbox is what unwedges it.
 */
async function ensureMailView(ctx: ComposeCtx): Promise<void> {
  try {
    const ok = await ctx.evaluate<boolean>(
      `return /(^|\\.)mail\\.google\\.com$/.test(location.hostname) &&
        !!document.querySelector('[gh="mtb"], tr.zA, div[role="button"].T-I.T-I-KE.L3');`,
    );
    if (ok) return;
    await ctx.navigate('https://mail.google.com/mail/u/0/#inbox');
    for (let i = 0; i < 25; i++) {
      const ready = await ctx
        .evaluate<boolean>(`return !!document.querySelector('[gh="mtb"], tr.zA');`)
        .catch(() => false);
      if (ready) return;
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch {
    /* best effort — the caller's own guard reports a still-broken UI */
  }
}

async function openPrefilledCompose(ctx: ComposeCtx, input: ComposeInput): Promise<boolean> {
  // DISABLED 2026-07-29 after measuring the ?tf=cm page: it renders a STANDALONE
  // compose (no div[role="dialog"], no [gh="mtb"]/tr.zA/Compose-button landmarks)
  // and — decisively — `to=` does NOT populate the recipient field, so the path
  // bought nothing while breaking the live-compose scope and stranding the view.
  // Always use the in-app Compose button, which has a confirmed end-to-end send.
  //
  // Returning false makes fillCompose() take the Compose-button branch. We only
  // make sure we are ON the mail app first, so that branch has a button to click.
  await ensureMailView(ctx);
  return await openComposeDialog(ctx);
}

/**
 * Click Gmail's Compose button and wait for the dialog's To field.
 *
 * MEASURED: `[gh="cm"]` does NOT exist on current Gmail; the real control is
 * div[role="button"].T-I.T-I-KE.L3. Classes are hashable, so fall back to
 * matching the button TEXT. Readiness is the peoplekit To combobox appearing —
 * not the click returning, which tells us nothing.
 */
async function openComposeDialog(ctx: ComposeCtx): Promise<boolean> {
  const clicked = await ctx
    .evaluate<boolean>(
      `const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
       let el = [...document.querySelectorAll('div[role="button"].T-I.T-I-KE.L3')].filter(vis).pop();
       if (!el) el = [...document.querySelectorAll('div[role="button"], button')].filter(vis)
         .find((x) => (x.textContent || '').trim().toLowerCase() === 'compose');
       if (!el) return false;
       el.scrollIntoView({ block: 'center' });
       await new Promise((r) => setTimeout(r, 150));
       el.click();
       return true;`,
    )
    .catch(() => false);
  if (!clicked) return false;

  for (let i = 0; i < 25; i++) {
    const ready = await ctx
      .evaluate<boolean>(
        `const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
         // The scope resolver walks UP from the BODY to the Send-button container,
         // so readiness needs the body too — waiting only for the To field resolved
         // an empty scope and reported RECIPIENT_FIELD_UNAVAILABLE.
         const to = [...document.querySelectorAll('input[aria-label="To recipients"], input[peoplekit-id]')].filter(vis);
         const body = [...document.querySelectorAll('div[aria-label="Message Body"][role="textbox"], div[g_editable="true"][role="textbox"]')].filter(vis);
         const send = [...document.querySelectorAll('div[role="button"][data-tooltip^="Send"]')].filter(vis);
         return to.length > 0 && body.length > 0 && send.length > 0;`,
      )
      .catch(() => false);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Fill everything except Send. Shared by send and draft. */
async function fillCompose(ctx: ComposeCtx, input: ComposeInput, prefilled: boolean): Promise<string[]> {
  const notes: string[] = [];
  if (!prefilled) notes.push('the Compose dialog did not open');

  if (input.fromAlias) await applyFromAlias(ctx, input.fromAlias);

  for (const kind of RECIPIENT_KINDS) {
    const addrs = input[kind] || [];
    if (addrs.length) await ensureRecipients(ctx, kind, addrs);
  }

  const subject = await setSubject(ctx, input.subject);
  if (input.subject && !subject) notes.push('the subject field read back empty');

  await applyBody(ctx, input.body, input.format || 'markdown');

  const plan = planAttachments(input.attachments);
  if (plan.files.length) {
    await attachFiles(ctx, plan.files);
    await waitForAttachments(ctx, plan.files.map((f) => f.name));
  }
  return notes;
}

function validateAddresses(kind: string, addrs: string[] | undefined): void {
  for (const a of addrs || []) {
    if (!looksLikeAddress(a)) {
      throw new GmComposeError('INVALID_RECIPIENT', `"${a}" is not a usable ${kind} address`, { kind, address: a });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Compose and SEND a new message. */
export async function composeAndSend(ctx: ComposeCtx, input: ComposeInput): Promise<SendResult> {
  if (!input.to || !input.to.length) throw new GmComposeError('INVALID_RECIPIENT', 'at least one `to` address is required');
  validateAddresses('to', input.to);
  validateAddresses('cc', input.cc);
  validateAddresses('bcc', input.bcc);
  const plan = planAttachments(input.attachments);

  await assertDesktopMailUi(ctx);
  const prefilled = await openPrefilledCompose(ctx, input);
  const notes = await fillCompose(ctx, input, prefilled);

  notes.push(
    ...(await preflight(ctx, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      body: input.body,
      attachments: plan.files.map((f) => f.name),
    })),
  );

  await clickSendAndConfirm(ctx);
  const result: SendResult = { ok: true, to: input.to, subject: input.subject, verified: true };
  if (notes.length) result.note = notes.join('; ');
  return result;
}

/** Compose and SAVE AS DRAFT — nothing is delivered. */
export async function composeDraft(ctx: ComposeCtx, input: ComposeInput): Promise<DraftResult> {
  validateAddresses('to', input.to);
  validateAddresses('cc', input.cc);
  validateAddresses('bcc', input.bcc);

  await assertDesktopMailUi(ctx);
  const prefilled = await openPrefilledCompose(ctx, input);
  const notes = await fillCompose(ctx, input, prefilled);

  const closed = await evalPage<{ closed: boolean }>(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     let el = __last(__visAll(${q(S.saveClose)}, sc)) || __last(__visAll(${q(S.saveClose)}));
     if (!el) el = __last(__visAll('[role="button"]', sc).filter((x) => /save\\s*(&|and)\\s*close/i.test(__label(x))));
     if (!el) return { ok: false, code: 'SAVE_CLOSE_NOT_FOUND', message: 'could not find Save & close in the compose' };
     __click(el);
     return { ok: true, closed: true };`,
  );
  void closed;
  await sleep(2000);

  // Verifying means FINDING the draft, not trusting the click.
  const drafts = await listDrafts(ctx, 25);
  const want = String(input.subject || '').trim();
  const hit = want ? drafts.find((d) => (d.subject || '').trim() === want) : drafts[0];
  const result: DraftResult = {
    ok: true,
    draftId: hit ? hit.draftId : null,
    verified: !!hit,
  };
  if (!hit) notes.push('saved, but no matching row was found in Drafts — the draft id is unknown');
  if (notes.length) result.note = notes.join('; ');
  return result;
}

/** Reply to a thread. `opts.all` chooses reply vs reply-all EXPLICITLY. */
export async function replyToThread(
  ctx: ComposeCtx,
  threadId: string,
  body: string,
  opts: { all?: boolean; format?: MailFormat; attachments?: string[] } = {},
): Promise<ReplyResult> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmComposeError('INVALID_THREAD', 'threadId is required');
  if (!String(body || '').trim()) throw new GmComposeError('INVALID_BODY', 'body is required');
  const wantAll = opts.all === true;
  const plan = planAttachments(opts.attachments);

  await assertDesktopMailUi(ctx);
  await gotoHash(ctx, `#all/${encodeURIComponent(id)}`, S.threadReady);

  const { clicked, parties, degraded } = await openReplyEditor(ctx, wantAll ? 'reply all' : 'reply');
  await sleep(600);

  const chips = await readComposeChips(ctx);
  const verdict = assessReplyMode({ wantAll, sender: parties.sender, participants: parties.participants, self: parties.self, chips });

  // When the thread offers NO Reply-all control, replying to the sender is the
  // only thing Gmail can do — refusing would help nobody. Say so in the note and
  // report the mode that actually happened, rather than the one that was asked for.
  if (degraded && verdict.reason === 'opened_reply_not_reply_all') {
    const note = `this thread offers no Reply-all control; replied to the sender only (${chips.join(', ') || 'no visible recipient'})`;
    await applyBody(ctx, body, opts.format || 'markdown');
    if (plan.files.length) {
      await attachFiles(ctx, plan.files);
      await waitForAttachments(ctx, plan.files.map((f) => f.name));
    }
    const extra = await preflight(ctx, { body, attachments: plan.files.map((f) => f.name) });
    await clickSendAndConfirm(ctx);
    return { ok: true, threadId: id, mode: 'reply', verified: true, note: [note, ...extra].join('; ') };
  }

  if (!verdict.ok) {
    throw new GmComposeError(
      'REPLY_MODE_MISMATCH',
      `asked for ${wantAll ? 'reply-all' : 'reply'} but the editor that opened does not match (${verdict.reason}; clicked "${clicked}"; recipients: ${
        chips.join(', ') || 'none visible'
      }) — nothing was sent`,
      { wantAll, reason: verdict.reason, clicked, chips },
    );
  }

  const notes: string[] = [];
  if (!verdict.verified) notes.push(`recipient set could not be verified (${verdict.reason}; clicked "${clicked}")`);

  await applyBody(ctx, body, opts.format || 'markdown');
  if (plan.files.length) {
    await attachFiles(ctx, plan.files);
    await waitForAttachments(ctx, plan.files.map((f) => f.name));
  }
  notes.push(...(await preflight(ctx, { body, attachments: plan.files.map((f) => f.name) })));
  await clickSendAndConfirm(ctx);

  const result: ReplyResult = { ok: true, threadId: id, mode: verdict.mode, verified: verdict.verified };
  if (notes.length) result.note = notes.join('; ');
  return result;
}

/** Forward a thread to new recipients. */
export async function forwardThread(
  ctx: ComposeCtx,
  threadId: string,
  to: string[],
  opts: { body?: string; format?: MailFormat } = {},
): Promise<ForwardResult> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmComposeError('INVALID_THREAD', 'threadId is required');
  if (!to || !to.length) throw new GmComposeError('INVALID_RECIPIENT', 'at least one `to` address is required');
  validateAddresses('to', to);

  await assertDesktopMailUi(ctx);
  await gotoHash(ctx, `#all/${encodeURIComponent(id)}`, S.threadReady);

  // No prefill URL exists for a forward, so recipients go through the typing +
  // chip-commit path — the one place it cannot be avoided.
  await openReplyEditor(ctx, 'forward');
  await sleep(600);
  await ensureRecipients(ctx, 'to', to);

  const notes: string[] = [];
  if (opts.body && opts.body.trim()) {
    // Gmail pre-fills the forwarded quote; appending would need to preserve it,
    // and a body render REPLACES the editor contents. Say so rather than quietly
    // deleting the quoted thread.
    await applyBody(ctx, opts.body, opts.format || 'markdown');
    notes.push('the added note REPLACED the quoted original in the editor body');
  }

  notes.push(...(await preflight(ctx, { to })));
  await clickSendAndConfirm(ctx);

  const result: ForwardResult = { ok: true, threadId: id, to, verified: true };
  if (notes.length) result.note = notes.join('; ');
  return result;
}

/**
 * List saved drafts.
 *
 * `draftId` is the row's `data-legacy-thread-id` — the id `#all/<id>` and
 * `#drafts/<id>` both resolve. It is NOT a Gmail API draft resource id, and the
 * two are not interchangeable; sendDraft/deleteDraft here consume this one.
 */
export async function listDrafts(ctx: ComposeCtx, limit = 25): Promise<DraftRow[]> {
  const n = Math.max(1, Math.min(limit, 100));
  await assertDesktopMailUi(ctx);
  await gotoHash(ctx, '#drafts', S.listReady);
  const r = await evalPage<{ rows: DraftRow[] }>(
    ctx,
    `const rows = __visAll(${q(S.row)}).slice(0, ${n}).map((tr) => {
       const idEl = tr.querySelector('[data-legacy-thread-id]');
       const who = tr.querySelector('.yW span[email], span[email]');
       const subj = tr.querySelector('.y6 span');
       const when = tr.querySelector('td.xW span[title], span[title]');
       return {
         draftId: idEl ? idEl.getAttribute('data-legacy-thread-id') : null,
         to: who ? (who.getAttribute('email') || __norm(who.textContent) || null) : null,
         subject: subj ? __norm(subj.textContent) : null,
         date: when ? when.getAttribute('title') : null
       };
     }).filter((d) => d.draftId);
     return { ok: true, rows };`,
  );
  // Shape guard: a caller iterating the result must never get `undefined` back
  // because the page returned an unexpected object.
  return Array.isArray(r.rows) ? r.rows : [];
}

/** Open a draft and verify it can be opened + edited. */
async function openDraft(ctx: ComposeCtx, draftId: string): Promise<void> {
  try {
    await gotoHash(ctx, `#drafts/${encodeURIComponent(draftId)}`, S.body, 15000);
  } catch {
    await gotoHash(ctx, `#all/${encodeURIComponent(draftId)}`, S.threadReady, 15000);
  }
  try {
    await waitForCompose(ctx, 12000);
  } catch {
    throw new GmComposeError('DRAFT_NOT_OPENED', `draft ${draftId} did not open into an editable compose`, { draftId });
  }
}

/** SEND an existing draft, as it stands. */
export async function sendDraft(ctx: ComposeCtx, draftId: string): Promise<SendDraftResult> {
  const id = String(draftId || '').trim();
  if (!id) throw new GmComposeError('INVALID_DRAFT', 'draftId is required');

  await assertDesktopMailUi(ctx);
  await openDraft(ctx, id);

  // The caller supplied no content, so the draft's own content IS the contract:
  // verify it has a recipient and a body before sending it on their behalf.
  const chips = await readComposeChips(ctx);
  if (!chips.length) {
    throw new GmComposeError('DRAFT_NO_RECIPIENT', `draft ${id} has no recipient chip — Gmail would deliver it to nobody`, { draftId: id });
  }
  const text = await readBodyText(ctx);
  const notes: string[] = [];
  if (!text) notes.push('the draft body is empty');

  await clickSendAndConfirm(ctx);
  const result: SendDraftResult = { ok: true, draftId: id, verified: true };
  if (notes.length) result.note = notes.join('; ');
  return result;
}

/** DISCARD a draft, and confirm it left the Drafts list. */
export async function deleteDraft(ctx: ComposeCtx, draftId: string): Promise<DeleteDraftResult> {
  const id = String(draftId || '').trim();
  if (!id) throw new GmComposeError('INVALID_DRAFT', 'draftId is required');

  await assertDesktopMailUi(ctx);
  await openDraft(ctx, id);

  await evalPage(
    ctx,
    `const sc = __scope();
     if (!sc) return { ok: false, code: 'COMPOSE_NOT_FOUND', message: 'no live compose' };
     let el = __last(__visAll(${q(S.discard)}, sc)) || __last(__visAll(${q(S.discard)}));
     if (!el) el = __last(__visAll('[role="button"]', sc).filter((x) => /discard/i.test(__label(x))));
     if (!el) return { ok: false, code: 'DISCARD_NOT_FOUND', message: 'could not find the Discard draft control' };
     __click(el);
     return { ok: true };`,
  );
  await sleep(1500);

  const remaining = await listDrafts(ctx, 50);
  const stillThere = remaining.some((d) => d.draftId === id);
  const result: DeleteDraftResult = { ok: true, draftId: id, verified: !stillThere };
  if (stillThere) result.note = 'clicked Discard but the draft is still listed in Drafts';
  return result;
}
